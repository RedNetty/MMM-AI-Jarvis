"use strict";

const { EventEmitter } = require("events");
const path = require("path");

const Microphone = require("./audio/Microphone");
const VoiceActivityDetector = require("./audio/VoiceActivityDetector");
const Speaker = require("./audio/Speaker");
const SpeechQueue = require("./audio/SpeechQueue");
const { chime } = require("./audio/wav");
const WhisperCppSTT = require("./stt/WhisperCppSTT");
const { createTTS } = require("./tts");
const EspeakTTS = require("./tts/EspeakTTS");
const ChainTTS = require("./tts/ChainTTS");
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
const Proactive = require("./Proactive");
const { createWakeWordMatcher, isStopCommand } = require("./wakeword");
const { splitSentences, normalize } = require("./text");
const { verbalize } = require("./speech/verbalize");
const log = require("./log");

const HEALTH_RETRY_MS = 30000;
// While only the robotic backup voice works, look for a natural one this often
// (the Kokoro or Piper service may start after MagicMirror, or the Mac wakes up).
const VOICE_RETRY_MS = 120000;
const ROBOTIC_VOICE_NOTE = "Speaking with the robotic backup voice. Run scripts/setup-mac.sh (Kokoro) or setup-pi.sh (Piper) for a natural one.";
const MAX_QUEUED_UTTERANCES = 2;
const ANNOUNCE_WAIT_MS = 60000;
// Speech that starts this soon after the assistant stops talking can still be
// its own voice (room echo, plus the microphone's buffering delay).
const ECHO_TAIL_MS = 250;
// How long the assistant's own sentences are remembered to recognise echoes.
const RECENT_SPEECH_MS = 30000;
// Words a finished sentence doesn't end on ("what's the weather in…").
const TRAILING_WORDS = new Set([
  "the", "a", "an", "to", "of", "for", "and", "or", "but", "my", "your", "is", "are", "what's", "whats", "in", "on",
  "at", "with", "about", "from", "like", "than", "so", "if", "when", "then", "that", "this", "me", "um", "uh", "how", "what",
]);

/**
 * IRIS – Image Recognition & Intelligent Speech. Orchestrates the whole
 * assistant, fully on-device:
 *
 *   mic → VAD → whisper.cpp → wake word → Assistant (Ollama + skills) → Kokoro/Piper → speaker
 *                                                │
 *                                    Widgets / Screen → mirror UI
 *
 * Responsiveness:
 *  - Speculative end-pointing: speech-to-text starts at the first short pause.
 *    "Iris." on its own, or a finished question, is acted on without waiting
 *    out the full end-of-speech silence.
 *  - Echo suppression: anything heard while the assistant itself is talking
 *    needs the wake word (barge-in), and transcripts that repeat what it just
 *    said are dropped, so it never answers itself.
 *
 * Events (forwarded to the mirror by node_helper):
 *   "state"         (idle | listening | processing | speaking)
 *   "transcription" (string)    what the user asked
 *   "response"      (string)    what the assistant answered
 *   "widgets"       (object[])  live cards on the mirror (scores, timers, outfits…)
 *   "screen"        (object)    show/hide command for other modules
 *   "notify"        (object)    { notification, payload } to send to other modules
 *   "error"         (string)    transient error message
 *   "problems"      (string[])  setup problems (empty array = all good)
 */
class Iris extends EventEmitter {
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
    this.speculation = null;
    this.ready = false;
    this.healthTimer = null;
    this.lastSttErrorAt = 0;
    this.serviceProblems = [];
    this.micProblem = null;
    this.ttsFallbackReason = null;
    this.voiceNote = null;
    this.loggedProblems = "";
    /** @type {{ startedAt: number, endedAt: number }[]} recent playback intervals */
    this.playback = [];
    /** @type {{ text: string, at: number }[]} recent sentences the assistant said */
    this.spoken = [];
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
    if (this.tts instanceof ChainTTS) this.tts.onSwitch = () => this._updateVoiceNote();
    this.speaker = new Speaker({ device: c.audio.speakerDevice });
    this.chimeWav = c.audio.chime ? chime(c.audio.chimeVolume) : null;

    this.ollama = new Ollama({
      servers: c.llm.servers,
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

    this.screen = new Screen({ file: path.join(this.dataDir, "layout.json") });
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

    // With several servers configured (e.g. a Mac, then the Pi), keep
    // checking them in the background so requests go to whichever is up.
    // When another server takes over, load the model there right away so
    // the next question doesn't wait for it.
    this.ollama.pool.on("change", () => {
      if (this.ready) this.assistant.warmUp().catch((err) => log.warn(`Model warm-up failed: ${err.message}`));
    });
    this.ollama.start();
    this.stt.start();
    this.tts.start?.();

    // Briefings, rain alerts and team alerts nobody asked for.
    this.proactive = new Proactive({
      config: c,
      skills: this.skills,
      isBusy: () => this._busy || Date.now() < this.listenUntil,
      notify: (text, { speak }) => (speak ? this._announce(text, { chimes: 1 }) : this._showQuietly(text)),
    });
    this.proactive.start();

    this._startAudio();
    this._checkHealth();
  }

  stop() {
    clearTimeout(this.healthTimer);
    clearTimeout(this.listenTimer);
    this.abortController?.abort();
    this.speaker?.stop();
    this.mic?.stop();
    this.proactive?.stop();
    this.widgets?.stop();
    this.ollama?.stop();
    this.stt?.stop();
    this.tts?.stop?.();
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

  /**
   * A presence sensor (MMM-PIR-Sensor, face recognition…) saw someone.
   * @param {boolean} present
   */
  notePresence(present) {
    if (!present) return;
    this.screen?.wake();
    this.proactive?.notePresence("sensor");
  }

  /** Re-send current state to a freshly connected mirror client. */
  replayState() {
    this.screen?.resetSession(); // the reloaded page needs its saved layout again
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
      pauseMs: a.pauseMs,
      preRollMs: a.preRollMs,
      minUtteranceMs: a.minUtteranceMs,
      maxUtteranceMs: a.maxUtteranceMs,
    });
    this.vad.on("utterance", (pcm, meta) => this._onUtterance(pcm, meta));
    // Someone talking near the mirror counts as presence (for the morning briefing).
    this.vad.on("speechstart", () => {
      if (!this._busy) this.proactive?.notePresence("voice");
    });
    this.vad.on("pause", (p) => this._onPause(p));
    this.vad.on("resume", (id) => {
      if (this.speculation?.id === id) this.speculation = null;
    });

    if (a.micDevice === "none") {
      log.info('Microphone disabled (audio.micDevice "none"); answering IRIS_ASK notifications only.');
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

  /**
   * A short pause mid-utterance: start transcribing what was said so far.
   * Skipped while speech-to-text is already busy, so it never competes with
   * real work on a Pi.
   */
  _onPause({ id, pcm }) {
    if (!this.ready || this.transcribing || this.speculation) return;
    if (this._busy && !this.config.audio.allowBargeIn) return;

    const spec = { id, startedAt: this.vad.startedAt, promise: this.stt.transcribe(pcm) };
    spec.promise.catch(() => {}); // a failed guess just means the full utterance is transcribed
    this.speculation = spec;
    spec.promise.then(
      (text) => this._onSpeculation(spec, text),
      () => {
        if (this.speculation === spec) this.speculation = null;
      },
    );
  }

  _onSpeculation(spec, text) {
    // Speech resumed (stale guess) or the full utterance already took it over.
    if (this.speculation !== spec || !this.vad.speaking || this.vad.utteranceId !== spec.id) return;
    if (!text || !this._looksComplete(text)) return; // wait for the end-point; the transcript is reused then
    if (!this.vad.cut(spec.id)) return;
    this.speculation = null;
    log.debug(`Early end-point: "${text}"`);
    this._onTranscript(text, { startedAt: spec.startedAt, endedAt: Date.now() });
  }

  /**
   * Is a speculative transcript a complete request worth acting on now?
   * "Iris." alone is; so is a finished question addressed to the assistant.
   * Half sentences ("what's the weather in") are not.
   * @param {string} text
   */
  _looksComplete(text) {
    const parsed = this.wakeWord.parse(text);
    const inWindow = Date.now() < this.listenUntil;
    if (!parsed.heard && !inWindow && !this._busy) return false; // the wake word may still come at the end
    if (parsed.heard && !parsed.query) return true;
    const q = (parsed.heard ? parsed.query : text).trim();
    if (!/[.?!]$/.test(q) || /(\.\.\.|…)$/.test(q)) return false;
    const last = normalize(q).split(" ").pop();
    return !TRAILING_WORDS.has(last);
  }

  _onUtterance(pcm, meta = {}) {
    if (!this.ready) return;
    if (this._busy && !this.config.audio.allowBargeIn) return;

    // Reuse the speculative transcript when nothing was said after the pause.
    const spec = this.speculation?.id === meta.id ? this.speculation : null;
    if (spec) this.speculation = null;

    this.queue.push({ pcm, meta, text: spec?.promise ?? null });
    if (this.queue.length > MAX_QUEUED_UTTERANCES) this.queue.shift();
    this._drainQueue();
  }

  async _drainQueue() {
    if (this.transcribing) return;
    this.transcribing = true;
    try {
      while (this.queue.length) {
        const { pcm, meta, text: pending } = this.queue.shift();
        const started = Date.now();
        let text = "";
        try {
          text = pending ? await pending : await this.stt.transcribe(pcm);
        } catch (err) {
          log.error(`Speech recognition failed: ${err.message}`);
          if (Date.now() - this.lastSttErrorAt > 60000) {
            this.lastSttErrorAt = Date.now();
            this.emit("error", "Speech recognition is unavailable.");
          }
          continue;
        }
        log.debug(`STT ${Date.now() - started}ms${pending ? " (speculative)" : ""} for ${(pcm.length / 32000).toFixed(1)}s audio: "${text}"`);
        if (text) this._onTranscript(text, meta);
      }
    } finally {
      this.transcribing = false;
    }
  }

  /**
   * @param {string} text
   * @param {{ startedAt?: number, endedAt?: number }} [meta] When the speech was captured.
   */
  _onTranscript(text, meta = {}) {
    const parsed = this.wakeWord.parse(text);
    const command = parsed.heard ? parsed.query : text;
    const duringPlayback = this._overlapsPlayback(meta.startedAt);

    // The assistant hearing itself: its own words coming back, or anything
    // captured while it was talking that isn't addressed to it.
    if (this._isOwnSpeech(text) && (duringPlayback || !parsed.heard)) {
      log.debug(`Ignored echo: "${text}"`);
      return;
    }

    if (this._busy || duringPlayback) {
      // While busy, only react to "stop" or a fresh wake-word question (barge-in).
      if ((parsed.heard || this.state === "speaking") && isStopCommand(command)) {
        log.info(`Heard stop command: "${text}"`);
        this.cancel();
      } else if (parsed.heard && parsed.query) {
        log.info(`Barge-in: "${text}"`);
        if (this._busy) this.cancel();
        this._handleQuery(parsed.query);
      } else if (parsed.heard && !this._busy) {
        this._startListening(this.config.conversation.listenTimeout, true);
      } else {
        log.debug(`Ignored (heard while speaking): "${text}"`);
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
      this.proactive?.notePresence("query");
      // A sleeping screen wakes for its name (unless the request is to keep it off).
      if (!/\b(?:screen|display|mirror)\s+off\b|\bsleep\b/i.test(parsed.query)) this.screen?.wake();
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

  // ─── Echo suppression ──────────────────────────────────────────────────

  /**
   * Did speech that started at `startedAt` begin while the assistant was
   * playing audio (or right after, within the echo tail)?
   * @param {number|undefined} startedAt
   */
  _overlapsPlayback(startedAt) {
    if (!startedAt) return false;
    return this.playback.some((p) => startedAt >= p.startedAt - 100 && startedAt <= (p.endedAt ?? Infinity) + ECHO_TAIL_MS);
  }

  /**
   * Is this transcript (mostly) words the assistant just said?
   * @param {string} text
   */
  _isOwnSpeech(text) {
    const now = Date.now();
    this.spoken = this.spoken.filter((s) => now - s.at < RECENT_SPEECH_MS);
    if (!this.spoken.length) return false;
    const said = new Set(normalize(this.spoken.map((s) => s.text).join(" ")).split(" "));
    const words = normalize(this.wakeWord.strip(text)).split(" ").filter((w) => w.length > 1);
    if (words.length < 2) return false;
    const hits = words.filter((w) => said.has(w)).length;
    return hits / words.length >= 0.75;
  }

  /** Play audio, recording when the speaker was busy (for echo suppression). */
  async _play(wav) {
    const interval = { startedAt: Date.now(), endedAt: null };
    this.playback.push(interval);
    if (this.playback.length > 12) this.playback.shift();
    try {
      return await this.speaker.play(wav);
    } finally {
      interval.endedAt = Date.now();
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

    // Sentences are spoken (and shown) as soon as the assistant produces them,
    // while the language model is still writing the rest of the answer.
    const queue = this._speechQueue(signal, () => {
      if (id === this.requestId) this._setState("speaking");
    });
    let shown = "";
    const onSentence = (sentence) => {
      if (id !== this.requestId) return;
      shown = shown ? `${shown} ${sentence}` : sentence;
      this.emit("response", shown);
      queue.push(sentence);
    };

    let succeeded = false;
    try {
      const started = Date.now();
      const reply = await this.assistant.ask(query, { signal, onSentence });
      if (id !== this.requestId) return;
      log.info(`Reply in ${((Date.now() - started) / 1000).toFixed(1)}s: "${reply}"`);
      await queue.finish();
      succeeded = !signal.aborted;
    } catch (err) {
      if (id !== this.requestId || err.name === "AbortError" || signal.aborted) return;
      log.error(`Query failed: ${err.stack ?? err.message}`);
      this.emit("error", friendlyError(err));
    } finally {
      queue.close();
      this._releaseMic();
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
   * Create a speech queue for one reply. Unless barge-in is allowed, the
   * microphone is ignored from the first spoken word until _releaseMic().
   * @param {AbortSignal} signal
   * @param {() => void} [onStart]
   */
  _speechQueue(signal, onStart) {
    return new SpeechQueue({
      synthesize: (text) => this._synthesize(text),
      play: (wav) => this._play(wav),
      signal,
      mergeChars: this.config.tts?.mergeChars,
      onStart: () => {
        if (!this.config.audio.allowBargeIn) this.vad.pause();
        onStart?.();
      },
    });
  }

  _releaseMic() {
    if (!this.config.audio.allowBargeIn) this.vad.resume();
  }

  /**
   * Speak a complete text (announcements).
   * @param {string} text
   * @param {AbortSignal} signal
   */
  async _speak(text, signal) {
    const queue = this._speechQueue(signal);
    for (const sentence of splitSentences(text, 220, true)) queue.push(sentence);
    try {
      await queue.finish();
    } finally {
      this._releaseMic();
    }
  }

  /**
   * Synthesize one sentence. The mirror shows the written form ("7:30 PM",
   * "58°"); the voice gets it spelled the way a person says it.
   * @param {string} text
   */
  _synthesize(text) {
    this.spoken.push({ text, at: Date.now() });
    const promise = this.tts.synthesize(verbalize(text, { locale: this.config.locale }));
    promise.catch(() => {}); // handled when awaited; avoids unhandled rejections on cancel
    return promise;
  }

  /**
   * Show something on the mirror without saying it (quiet hours, nobody around).
   * @param {string} text
   */
  _showQuietly(text) {
    if (this._busy) return;
    this.emit("transcription", "");
    this.emit("response", text);
    this.emit("state", this.state); // restarts the front-end's fade-out timer
  }

  /**
   * Speak an unprompted announcement (a finished timer, a briefing, an alert) once free.
   * @param {string} text
   * @param {{ chimes?: number }} [options]
   */
  async _announce(text, { chimes = 2 } = {}) {
    const deadline = Date.now() + ANNOUNCE_WAIT_MS;
    while (this._busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    if (this._busy) return;

    const id = ++this.requestId;
    const controller = new AbortController();
    this.abortController = controller;
    this.emit("response", text);
    this._setState("speaking");
    try {
      // Chimes go straight to the speaker: a tone is never mistaken for words,
      // and the person may well start talking over it.
      for (let i = 0; this.chimeWav && i < chimes; i++) await this.speaker.play(this.chimeWav);
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
    this.emit("notify", { notification: "IRIS_TIMER_DONE", payload: { label } });
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
    this.healthTimer = null;
    const problems = [];

    const llm = await this.ollama.healthCheck();
    problems.push(...llm.problems);
    const ollamaOk = llm.usable;

    const sttProblem = await this.stt.healthCheck();
    if (sttProblem) problems.push(sttProblem);

    const ttsProblem = await this.tts.healthCheck();
    if (ttsProblem && !(this.tts instanceof EspeakTTS)) {
      this.ttsFallbackReason = `${ttsProblem} Using espeak-ng instead.`;
      this.tts.stop?.();
      this.tts = new EspeakTTS({ voice: this.config.tts.espeakVoice, speed: this.config.tts.espeakSpeed });
    }
    if (this.ttsFallbackReason) problems.push(this.ttsFallbackReason);
    this.voiceNote = this._voiceNote();

    if (this.camera.enabled && !this.camera.available) {
      problems.push("Camera enabled but no capture tool found (rpicam-still, fswebcam or ffmpeg).");
    }

    if (ollamaOk && !this.ready) {
      await this.skills.init();
      this.ready = true;
      log.info(`Ready. STT: ${this.stt.name}. TTS: ${this.tts.name}. LLM: ${this.ollama.model} @ ${this.ollama.url}.`);
      this.assistant.warmUp().catch((err) => log.warn(`Model warm-up failed: ${err.message}`));
    }

    // Retries re-find the same problems; only log what changed.
    const key = [...problems, this.voiceNote].join("\n");
    if (key !== this.loggedProblems) {
      for (const p of problems) log.warn(p);
      if (this.voiceNote) log.warn(this.voiceNote);
      this.loggedProblems = key;
    }
    this.serviceProblems = problems;
    this._emitProblems();

    clearTimeout(this.healthTimer); // a voice switch may have scheduled one meanwhile
    this.healthTimer = null;
    if (!ollamaOk || sttProblem) {
      this.healthTimer = setTimeout(() => this._checkHealth(), HEALTH_RETRY_MS);
    } else if (this.voiceNote) {
      this.healthTimer = setTimeout(() => this._checkHealth(), VOICE_RETRY_MS);
    }
  }

  /**
   * A note for the mirror while the robotic backup voice is speaking, unless
   * that is the voice the config asked for (or the fallback is already explained).
   * @returns {string|null}
   */
  _voiceNote() {
    if (this.config.tts?.provider === "espeak" || this.ttsFallbackReason) return null;
    return this.tts.robotic ? ROBOTIC_VOICE_NOTE : null;
  }

  /** The chain switched voices mid-conversation (the Mac fell asleep, or woke up). */
  _updateVoiceNote() {
    const note = this._voiceNote();
    if (note === this.voiceNote) return;
    this.voiceNote = note;
    if (note) {
      log.warn(note);
      if (!this.healthTimer) this.healthTimer = setTimeout(() => this._checkHealth(), VOICE_RETRY_MS);
    }
    this._emitProblems();
  }

  _emitProblems() {
    this.emit("problems", [...(this.micProblem ? [this.micProblem] : []), ...this.serviceProblems, ...(this.voiceNote ? [this.voiceNote] : [])]);
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

module.exports = Iris;
