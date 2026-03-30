"use strict";

/* MagicMirror² Node Helper: MMM-AI-Jarvis */

const NodeHelper = require("node_helper");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { PassThrough } = require("stream");

const { VertexAI } = require("@google-cloud/vertexai");
const speech = require("@google-cloud/speech");
const { TextToSpeechClient } = require("@google-cloud/text-to-speech");
const axios = require("axios");
const cheerio = require("cheerio");

// Phrases that don't benefit from a live web search
const NO_SEARCH_PHRASES = [
  "tell me a story",
  "read me a story",
  "bedtime story",
  "write a poem",
  "tell me a joke",
];

module.exports = NodeHelper.create({
  // ─── Internal state ──────────────────────────────────────────────────────

  config: null,
  vertexClient: null,
  generativeModel: null,
  ttsClient: null,
  isProcessing: false,
  audioProcess: null,
  abortController: null,
  micProcess: null,
  recognizeStream: null,

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  start() {
    console.log(`[MMM-AI-Jarvis] Node helper started.`);
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "INIT") {
      this.config = payload;
      this._initClients();
      this._startMic();
    }
  },

  // ─── Google Cloud client init ────────────────────────────────────────────

  _initClients() {
    const credPath = path.resolve(this.path, this.config.serviceAccountFile);

    if (!fs.existsSync(credPath)) {
      console.error(`[MMM-AI-Jarvis] Credentials not found at: ${credPath}`);
      this._send("ERROR", `Credentials file not found: ${this.config.serviceAccountFile}`);
      return;
    }

    process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;

    try {
      this.vertexClient = new VertexAI({
        project: this.config.projectId,
        location: this.config.location,
      });

      this.generativeModel = this.vertexClient.getGenerativeModel({
        model: this.config.model,
        generationConfig: {
          maxOutputTokens: this.config.maxTokens,
          temperature: 0.7,
          topP: 0.95,
        },
      });

      this.ttsClient = new TextToSpeechClient();
      console.log("[MMM-AI-Jarvis] Google Cloud clients initialized.");
    } catch (err) {
      console.error("[MMM-AI-Jarvis] Failed to initialize clients:", err.message);
      this._send("ERROR", "Failed to connect to Google Cloud.");
    }
  },

  // ─── Microphone & Speech Recognition ─────────────────────────────────────

  _startMic() {
    console.log("[MMM-AI-Jarvis] Starting microphone...");
    this._send("STATE_CHANGE", "idle");

    const micStream = new PassThrough();

    this.micProcess = spawn("arecord", ["-f", "S16_LE", "-r", "16000", "-c", "1"]);

    this.micProcess.stdout.pipe(micStream);

    this.micProcess.stderr.on("data", (d) => {
      // arecord writes recording info to stderr — only log actual errors
      const msg = d.toString().trim();
      if (!msg.startsWith("Recording") && !msg.startsWith("ALSA")) {
        console.warn("[MMM-AI-Jarvis] arecord:", msg);
      }
    });

    this.micProcess.on("close", (code) => {
      console.log(`[MMM-AI-Jarvis] arecord exited (${code}). Restarting in 2s...`);
      setTimeout(() => this._startMic(), 2000);
    });

    this.micProcess.on("error", (err) => {
      console.error("[MMM-AI-Jarvis] Failed to start arecord:", err.message);
      this._send("ERROR", "Microphone unavailable. Is arecord installed?");
    });

    this._setupSpeechStream(micStream);
  },

  _setupSpeechStream(micStream) {
    const client = new speech.SpeechClient();

    const streamConfig = {
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        languageCode: this.config.speechLanguage,
        enableAutomaticPunctuation: true,
      },
      interimResults: false,
    };

    // Google STT streams time out after ~5 min; restart automatically
    const STREAM_RESTART_MS = 4.5 * 60 * 1000;
    const restartTimer = setTimeout(() => {
      console.log("[MMM-AI-Jarvis] Refreshing STT stream...");
      if (this.recognizeStream) {
        this.recognizeStream.destroy();
      }
    }, STREAM_RESTART_MS);

    this.recognizeStream = client
      .streamingRecognize(streamConfig)
      .on("error", (err) => {
        clearTimeout(restartTimer);
        if (err.code === 11) {
          // "Audio timeout" — normal, just restart
          console.log("[MMM-AI-Jarvis] STT stream audio timeout. Restarting...");
        } else {
          console.error("[MMM-AI-Jarvis] STT error:", err.message);
          this._send("ERROR", "Speech recognition error.");
        }
        setTimeout(() => this._setupSpeechStream(micStream), 1000);
      })
      .on("data", (data) => {
        const result = data.results?.[0];
        if (!result?.alternatives?.[0]) return;

        const transcript = result.alternatives[0].transcript.trim().toLowerCase();
        if (!transcript) return;

        console.log(`[MMM-AI-Jarvis] Heard: "${transcript}"`);
        this._handleTranscript(transcript);
      })
      .on("end", () => {
        clearTimeout(restartTimer);
        console.log("[MMM-AI-Jarvis] STT stream ended. Restarting...");
        setTimeout(() => this._setupSpeechStream(micStream), 500);
      });

    micStream.pipe(this.recognizeStream);
  },

  // ─── Transcript handling ─────────────────────────────────────────────────

  _handleTranscript(transcript) {
    const keyword = (this.config.activationKeyword || "jarvis").toLowerCase();

    // Stop command always wins
    if (/\bstop\b/.test(transcript)) {
      this._stopPlayback();
      return;
    }

    if (this.isProcessing) return;

    if (transcript.includes(keyword)) {
      const query = transcript.replace(new RegExp(keyword, "g"), "").trim();
      if (!query) return; // just the wake word, nothing else

      this._send("TRANSCRIPTION", query);
      this._processQuery(query);
    }
  },

  // ─── Query pipeline ──────────────────────────────────────────────────────

  async _processQuery(query) {
    this.isProcessing = true;
    this.abortController = new AbortController();

    this._send("STATE_CHANGE", "processing");

    try {
      let context = "";
      if (this._needsSearch(query)) {
        context = await this._webSearch(query);
      }

      const prompt = this._buildPrompt(query, context);
      const text = await this._callVertex(prompt);
      const cleaned = this._cleanText(text);

      this._send("RESPONSE", cleaned);
      this._send("STATE_CHANGE", "speaking");

      await this._speak(cleaned);
    } catch (err) {
      if (err.name === "AbortError") {
        console.log("[MMM-AI-Jarvis] Query aborted.");
      } else {
        console.error("[MMM-AI-Jarvis] Query error:", err.message);
        this._send("ERROR", "I couldn't process that. Please try again.");
      }
    } finally {
      this.isProcessing = false;
      this.abortController = null;
      this._send("STATE_CHANGE", "idle");
    }
  },

  _needsSearch(query) {
    const q = query.toLowerCase();
    return !NO_SEARCH_PHRASES.some((p) => q.includes(p));
  },

  _buildPrompt(query, context) {
    const systemInstruction =
      "You are a concise smart home assistant displayed on a mirror. " +
      "Keep answers short (2-3 sentences max) and conversational. " +
      "If search context is available and relevant, use it. " +
      "Do not include URLs, markdown formatting, or asterisks in your response.";

    if (context) {
      return `${systemInstruction}\n\nSearch context:\n${context}\n\nUser: ${query}`;
    }
    return `${systemInstruction}\n\nUser: ${query}`;
  },

  async _callVertex(prompt) {
    const req = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    };

    const result = await this.generativeModel.generateContentStream(req);
    let full = "";
    for await (const chunk of result.stream) {
      const part = chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      full += part;
    }
    return full;
  },

  _cleanText(text) {
    return text
      .replace(/\*+/g, "")
      .replace(/#+\s?/g, "")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[^\x00-\x7F]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  },

  // ─── Web search ──────────────────────────────────────────────────────────

  async _webSearch(query) {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    };

    try {
      const { data } = await axios.get(url, {
        headers,
        timeout: 5000,
        signal: this.abortController?.signal,
      });

      const $ = cheerio.load(data);
      const snippets = [];

      $(".tF2Cxc").each((_, el) => {
        const title = $(el).find(".DKV0Md").text();
        const snippet = $(el).find(".VwiC3b").text();
        if (title || snippet) snippets.push(`${title}: ${snippet}`);
      });

      return snippets.slice(0, 5).join("\n") || "No relevant results found.";
    } catch (err) {
      if (err.name !== "AbortError") {
        console.warn("[MMM-AI-Jarvis] Web search failed:", err.message);
      }
      return "";
    }
  },

  // ─── Text-to-speech ──────────────────────────────────────────────────────

  async _speak(text) {
    const audioPath = path.join(this.path, "output.mp3");

    const [response] = await this.ttsClient.synthesizeSpeech({
      input: { text },
      voice: this.config.ttsVoice,
      audioConfig: { audioEncoding: "MP3" },
    });

    fs.writeFileSync(audioPath, response.audioContent, "binary");

    await new Promise((resolve, reject) => {
      // Use mpg123 on Linux/Pi; fall back to afplay on macOS
      const players = ["mpg123", "afplay", "ffplay"];
      const player = players[0]; // adjust if needed

      this.audioProcess = spawn(player, [audioPath]);

      this.audioProcess.on("close", (code) => {
        this.audioProcess = null;
        if (code === 0 || code === null) resolve();
        else reject(new Error(`Audio player exited with code ${code}`));
      });

      this.audioProcess.on("error", (err) => {
        this.audioProcess = null;
        reject(new Error(`Audio player error: ${err.message}`));
      });
    });
  },

  _stopPlayback() {
    if (this.audioProcess) {
      this.audioProcess.kill("SIGTERM");
      this.audioProcess = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.isProcessing = false;
    this._send("STATE_CHANGE", "idle");
    console.log("[MMM-AI-Jarvis] Playback stopped.");
  },

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _send(notification, payload) {
    this.sendSocketNotification(notification, payload);
  },
});
