"use strict";

const { EventEmitter } = require("events");
const path = require("path");

const Microphone = require("./audio/Microphone");
const VoiceActivityDetector = require("./audio/VoiceActivityDetector");
const Speaker = require("./audio/Speaker");
const { chime } = require("./audio/wav");
const WhisperCppSTT = require("./stt/WhisperCppSTT");
const { createTTS } = require("./tts");
const EspeakTTS = require("./tts/EspeakTTS");
const Ollama = require("./Ollama");
const Camera = require("./Camera");
const Weather = require("./Weather");
const WebSearch = require("./WebSearch");
const Sports = require("./Sports");
const Widgets = require("./Widgets");
const Screen = require("./Screen");
const Wardrobe = require("./Wardrobe");
const Memory = require("./Memory");
const Skills = require("./Skills");
const Assistant = require("./Assistant");
const { createWakeWordMatcher, isStopCommand } = require("./wakeword");
const { splitSentences } = require("./text");
const log = require("./log");

const HEALTH_RETRY_MS = 30000;
const MAX_QUEUED_UTTERANCES = 2;
const ANNOUNCE_WAIT_MS = 60000;

/**
 * Orchestrates the whole assistant, fully on-device:
 *
 *   arecord → VAD → whisper.cpp → wake word → Assistant (Ollama + skills) → Piper → aplay
 *                                                   ↓
 *                                       Widgets / Screen → mirror UI
 *
 * Events (forwarded to the mirror by node_helper):
 *   "state"         (idle | listening | processing | speaking)
 *   "transcription" (string)    what the user asked
 *   "response"      (string)    what Jarvis answered
 *   "widgets"       (object[])  live cards on the mirror (scores, timers, outfits…)
 *   "screen"        (object)    show/hide command for other modules
 *   "notify"        (object)    { notification, payload } to send to other modules
 *   "error"         (string)    transient error message
 *   "problems"      (string[])  setup problems (empty array = all good)
 */
class Jarvis extends EventEmitter {
  /**
   * @param {object} config Module config (defaults already merged by the front-end).
   * @param {{ moduleDir: string }} paths
   */
  constructor(config, { moduleDir }) {
    super();
    this.config = config;
    this.moduleDir = moduleDir;
    this.dataDir = path.resolve(moduleDir, config.dataDir);

    this.state = "idle";
    this.listenUntil = 0;
    this.listenTimer = null;
    this.requestId = 0;
    this.abortController = null;
    this.queue = [];
    this.transcribing = false;
    this.ready = false;
    this.healthTimer = null;
    this.lastSttErrorAt = 0;
    this.serviceProblems = [];
    this.micProblem = null;
    this.ttsFallbackReason = null;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  start() {
    const c = this.config;
    log.setDebug(c.debug);

    this.wakeWord = createWakeWordMatcher(c.wakeWord, c.wakeWordAliases);
    this.wardrobe = new Wardrobe(this.dataDir);
    this.memory = new Memory(this.dataDir);

    this.stt = new WhisperCppSTT({ url: c.stt.whisperUrl, language: c.language });
    this.tts = createTTS(c.tts);
    this.speaker = new Speaker({ device: c.audio.speakerDevice });
    this.chimeWav = c.audio.chime ? chime(c.audio.chimeVolume) : null;

    this.ollama = new Ollama({
      url: c.llm.ollamaUrl,
      model: c.llm.model,
      visionModel: c.llm.visionModel,
      keepAlive: c.llm.keepAlive,
      temperature: c.llm.temperature,
      maxTokens: c.llm.maxTokens,
      contextSize: c.llm.contextSize,
      think: c.llm.think,
    });

    this.camera = new Camera(c.camera);
    this.weather = new Weather({
      latitude: c.weather.latitude,
      longitude: c.weather.longitude,
      units: c.units,
      locationName: c.weather.locationName,
    });
    this.search = c.search.searxngUrl ? new WebSearch({ url: c.search.searxngUrl, language: c.language }) : null;
    this.sports = c.sports.enabled ? new Sports({ leagues: c.sports.leagues, locale: c.locale }) : null;

    this.widgets = new Widgets({ max: c.display.maxWidgets });
    this.widgets.on("change", (list) => this.emit("widgets", list));
    this.widgets.on("expired", (w) => {
      if (w.type === "timer") this._timerDone(w);
    });

    this.screen = new Screen();
    this.screen.on("command", (cmd) => this.emit("screen", cmd));
    this.screen.on("notify", (n) => this.emit("notify", n));

    this.skills = new Skills({
      ollama: this.ollama,
      wardrobe: this.wardrobe,
      memory: this.memory,
      camera: this.camera,
      weather: this.weather,
      search: this.search,
      sports: this.sports,
      widgets: this.widgets,
      screen: this.screen,
      config: c,
    });
    this.assistant = new Assistant({
      ollama: this.ollama,
      skills: this.skills,
      memory: this.memory,
      wardrobe: this.wardrobe,
      screen: this.screen,
      config: c,
    });

    this._startAudio();
    this._checkHealth();
  }

  stop() {
    clearTimeout(this.healthTimer);
    clearTimeout(this.listenTimer);
    this.abortController?.abort();
    this.speaker?.stop();
    this.mic?.stop();
    this.widgets?.stop();
  }

  // ─── Public controls (mirror notifications) ────────────────────────────

  /**
   * Ask a question directly, bypassing the wake word (e.g. from another module).
   * @param {string} text
   */
  ask(text) {
    const query = String(text ?? "").trim();
    if (!query) return;
    if (this._busy) this.cancel();
    this._handleQuery(query);
  }

  /** Stop speaking / cancel the current request. */
  cancel() {
    this.requestId += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.speaker.stop();
    this._endListening();
    this._setState("idle");
    log.info("Cancelled.");
  }

  /** @param {object} summary Weather summary forwarded from the MagicMirror weather module. */
  updateWeather(summary) {
    this.weather?.updateFromMirror(summary);
  }

  /** @param {object[]} inventory Modules on the mirror, reported by the front-end. */
  updateModules(inventory) {
    this.screen?.setInventory(inventory);
  }

  /** @param {string} id Widget dismissed from the UI. */
  dismissWidget(id) {
    this.widgets?.remove({ id });
  }

  /** Re-send current state to a freshly connected mirror client. */
  replayState() {
    this.emit("state", this.state);
    if (this.widgets) this.emit("widgets", this.widgets.toPublic());
  }

  // ─── Audio input ───────────────────────────────────────────────────────

  _startAudio() {
    const a = this.config.audio;
    this.vad = new VoiceActivityDetector({
      sampleRate: 16000,
      threshold: a.vadThreshold,
      noiseMultiplier: a.noiseMultiplier,
      silenceMs: a.silenceMs,
      preRollMs: a.preRollMs,
      minUtteranceMs: a.minUtteranceMs,
      maxUtteranceMs: a.maxUtteranceMs,
    });
    this.vad.on("utterance", (pcm) => this._onUtterance(pcm));

    if (a.micDevice === "none") {
      log.info('Microphone disabled (audio.micDevice "none"); Jarvis will respond to JARVIS_ASK notifications only.');
      return;
    }

    this.mic = new Microphone({ device: a.micDevice });
    this.mic.on("data", (chunk) => {
      if (this.micProblem) {
        this.micProblem = null;
        this._emitProblems();
      }
      this.vad.write(chunk);
    });
    this.mic.on("error", (err) => {
      // The recorder retries with backoff; report each distinct problem once.
      if (this.micProblem === err.message) return;
      log.error(err.message);
      this.micProblem = err.message;
      this._emitProblems();
    });
    this.mic.start();
    log.info(`Listening for "${this.config.wakeWord}" on ${a.micDevice}.`);
  }

  get _busy() {
    return this.state === "processing" || this.state === "speaking";
  }

  _onUtterance(pcm) {
    if (!this.ready) return;
    if (this._busy && !this.config.audio.allowBargeIn) return;

    this.queue.push(pcm);
    if (this.queue.length > MAX_QUEUED_UTTERANCES) this.queue.shift();
    this._drainQueue();
  }

  async _drainQueue() {
    if (this.transcribing) return;
    this.transcribing = true;
    try {
      while (this.queue.length) {
        const pcm = this.queue.shift();
        const started = Date.now();
        let text = "";
        try {
          text = await this.stt.transcribe(pcm);
        } catch (err) {
          log.error(`Speech recognition failed: ${err.message}`);
          if (Date.now() - this.lastSttErrorAt > 60000) {
            this.lastSttErrorAt = Date.now();
            this.emit("error", "Speech recognition is unavailable.");
          }
          continue;
        }
        log.debug(`STT ${Date.now() - started}ms for ${(pcm.length / 32000).toFixed(1)}s audio: "${text}"`);
        if (text) this._onTranscript(text);
      }
    } finally {
      this.transcribing = false;
    }
  }

  _onTranscript(text) {
    const parsed = this.wakeWord.parse(text);
    const command = parsed.heard ? parsed.query : text;

    if (this._busy) {
      // While busy, only react to "stop" or a fresh wake-word question (barge-in).
      if ((parsed.heard || this.state === "speaking") && isStopCommand(command)) {
        log.info(`Heard stop command: "${text}"`);
        this.cancel();
      } else if (parsed.heard && parsed.query) {
        log.info(`Barge-in: "${text}"`);
        this.cancel();
        this._handleQuery(parsed.query);
      }
      return;
    }

    const inWindow = Date.now() < this.listenUntil;

    if ((parsed.heard || inWindow) && isStopCommand(command)) {
      this._endListening();
      this._setState("idle");
      return;
    }

    if (parsed.heard) {
      log.info(`Heard: "${text}"`);
      if (parsed.query) {
        this._handleQuery(parsed.query);
      } else {
        this._startListening(this.config.conversation.listenTimeout, true);
      }
    } else if (inWindow) {
      log.info(`Heard (follow-up): "${text}"`);
      this._handleQuery(text);
    } else {
      log.debug(`Ignored (no wake word): "${text}"`);
    }
  }

  // ─── Query pipeline ────────────────────────────────────────────────────

  async _handleQuery(query) {
    this._endListening();
    const id = ++this.requestId;
    const controller = new AbortController();
    this.abortController = controller;
    const { signal } = controller;

    this.emit("transcription", query);
    this._setState("processing");

    let succeeded = false;
    try {
      const started = Date.now();
      const reply = await this.assistant.ask(query, { signal });
      if (id !== this.requestId) return;
      log.info(`Reply in ${((Date.now() - started) / 1000).toFixed(1)}s: "${reply}"`);

      this.emit("response", reply);
      this._setState("speaking");
      await this._speak(reply, signal);
      succeeded = true;
    } catch (err) {
      if (id !== this.requestId || err.name === "AbortError" || signal.aborted) return;
      log.error(`Query failed: ${err.stack ?? err.message}`);
      this.emit("error", friendlyError(err));
    } finally {
      if (id === this.requestId) {
        this.abortController = null;
        const followUp = this.config.conversation.followUpWindow;
        if (succeeded && followUp > 0) {
          this._startListening(followUp, false);
        } else {
          this._setState("idle");
        }
      }
    }
  }

  /**
   * Speak sentence by sentence. The first sentence is synthesised on its own
   * so speech starts quickly; later chunks are prepared while earlier ones play.
   */
  async _speak(text, signal) {
    const chunks = splitSentences(text, 220, true);
    if (chunks.length === 0) return;

    if (!this.config.audio.allowBargeIn) this.vad.pause();
    try {
      let next = this._synthesize(chunks[0]);
      for (let i = 0; i < chunks.length; i++) {
        const wav = await next;
        if (signal.aborted) return;
        next = i + 1 < chunks.length ? this._synthesize(chunks[i + 1]) : null;
        const { interrupted } = await this.speaker.play(wav);
        if (interrupted || signal.aborted) return;
      }
    } finally {
      if (!this.config.audio.allowBargeIn) this.vad.resume();
    }
  }

  _synthesize(text) {
    const promise = this.tts.synthesize(text);
    promise.catch(() => {}); // handled when awaited; avoids unhandled rejections on cancel
    return promise;
  }

  /**
   * Speak an unprompted announcement (e.g. a finished timer) once Jarvis is free.
   * @param {string} text
   */
  async _announce(text) {
    const deadline = Date.now() + ANNOUNCE_WAIT_MS;
    while (this._busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    if (this._busy) return;

    const id = ++this.requestId;
    const controller = new AbortController();
    this.abortController = controller;
    this.emit("response", text);
    this._setState("speaking");
    try {
      if (this.chimeWav) {
        await this.speaker.play(this.chimeWav);
        await this.speaker.play(this.chimeWav);
      }
      await this._speak(text, controller.signal);
    } catch (err) {
      log.warn(`Announcement failed: ${err.message}`);
    } finally {
      if (id === this.requestId) {
        this.abortController = null;
        this._setState("idle");
      }
    }
  }

  _timerDone(widget) {
    const label = widget.data.label;
    log.info(`Timer done: ${label || "(unnamed)"}`);
    this.emit("notify", { notification: "JARVIS_TIMER_DONE", payload: { label } });
    this._announce(label ? `Your ${label} timer is done.` : "Your timer is done.");
  }

  // ─── Listening window ──────────────────────────────────────────────────

  _startListening(ms, playChime) {
    this.listenUntil = Date.now() + ms;
    clearTimeout(this.listenTimer);
    this.listenTimer = setTimeout(() => {
      if (this.state === "listening") this._setState("idle");
      this.listenUntil = 0;
    }, ms);
    this._setState("listening");
    if (playChime && this.chimeWav) this.speaker.play(this.chimeWav).catch(() => {});
  }

  _endListening() {
    clearTimeout(this.listenTimer);
    this.listenUntil = 0;
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }

  // ─── Health ────────────────────────────────────────────────────────────

  /**
   * Check every local service. Services started by systemd may come up after
   * MagicMirror, so problems are re-checked until everything is healthy.
   */
  async _checkHealth() {
    clearTimeout(this.healthTimer);
    const problems = [];

    const ollamaProblems = await this.ollama.healthCheck();
    problems.push(...ollamaProblems);
    const ollamaOk = !ollamaProblems.some((p) => /Cannot reach|not installed/.test(p));

    const sttProblem = await this.stt.healthCheck();
    if (sttProblem) problems.push(sttProblem);

    const ttsProblem = await this.tts.healthCheck();
    if (ttsProblem && !(this.tts instanceof EspeakTTS)) {
      this.ttsFallbackReason = `${ttsProblem} Using espeak-ng instead.`;
      this.tts = new EspeakTTS({ voice: this.config.tts.espeakVoice, speed: this.config.tts.espeakSpeed });
    }
    if (this.ttsFallbackReason) problems.push(this.ttsFallbackReason);

    if (this.camera.enabled && !this.camera.available) {
      problems.push("Camera enabled but no capture tool found (rpicam-still, fswebcam or ffmpeg).");
    }

    if (ollamaOk && !this.ready) {
      await this.skills.init();
      this.ready = true;
      log.info(`Ready. STT: ${this.stt.name}. TTS: ${this.tts.name}. LLM: ${this.ollama.model} @ ${this.ollama.url}.`);
      this.ollama.warmUp().catch((err) => log.warn(`Model warm-up failed: ${err.message}`));
    }

    for (const p of problems) log.warn(p);
    this.serviceProblems = problems;
    this._emitProblems();

    if (!ollamaOk || sttProblem) {
      this.healthTimer = setTimeout(() => this._checkHealth(), HEALTH_RETRY_MS);
    }
  }

  _emitProblems() {
    this.emit("problems", [...(this.micProblem ? [this.micProblem] : []), ...this.serviceProblems]);
  }
}

function friendlyError(err) {
  if (err instanceof Skills.UserFacingError) return err.message;
  const msg = String(err.message ?? "");
  if (/fetch failed|ECONNREFUSED|Cannot reach/i.test(msg)) return "I can't reach my language model. Is Ollama running?";
  if (/timed? ?out/i.test(msg)) return "That took too long. Please try again.";
  if (/camera|rpicam|fswebcam|ffmpeg/i.test(msg)) return "I couldn't use the camera.";
  if (/sports feed/i.test(msg)) return "I couldn't reach the scores service.";
  return "Sorry, something went wrong. Please try again.";
}

module.exports = Jarvis;
