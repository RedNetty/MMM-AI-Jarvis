"use strict";

const { pcmToWav } = require("../audio/wav");
const ServerPool = require("../ServerPool");

// Whisper emits these for silence, music or noise – never real speech.
const NON_SPEECH = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g;
const HALLUCINATIONS = new Set([
  "you",
  "thank you",
  "thanks for watching",
  "thank you for watching",
  "bye",
  "subtitles by the amara org community",
]);

/**
 * Local speech-to-text via a whisper.cpp server (`whisper-server`).
 * No internet, no API key. The server can run on the mirror itself or on a
 * faster machine on your network (e.g. a Mac, where it uses the GPU); give
 * several URLs to fail over between them.
 */
class WhisperCppSTT {
  /**
   * @param {{ url?: string|string[], language?: string, timeoutMs?: number }} options
   */
  constructor({ url = "http://127.0.0.1:8178", language = "en", timeoutMs = 30000 } = {}) {
    this.pool = new ServerPool(ServerPool.normalize(url), { label: "whisper.cpp" });
    this.language = language;
    this.timeoutMs = timeoutMs;
  }

  get url() {
    return this.pool.active.url;
  }

  get name() {
    return `whisper.cpp (${this.url})`;
  }

  start() {
    this.pool.start();
  }

  stop() {
    this.pool.stop();
  }

  /**
   * @param {Buffer} pcm 16 kHz mono S16LE audio
   * @returns {Promise<string>}
   */
  async transcribe(pcm) {
    const wav = new Blob([pcmToWav(pcm, 16000)], { type: "audio/wav" });
    const body = await this.pool.run(async (server) => {
      const form = new FormData();
      form.append("file", wav, "utterance.wav");
      form.append("response_format", "json");
      form.append("temperature", "0.0");
      if (this.language) form.append("language", this.language);

      const res = await fetch(`${server.url}/inference`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`whisper.cpp server returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      return res.json();
    });
    return WhisperCppSTT.clean(body.text);
  }

  /** @returns {Promise<string|null>} A problem, or null when at least one server answers. */
  async healthCheck() {
    await this.pool.probeAll();
    if (this.pool.servers.some((s) => s.up)) return null;
    return this.pool.size > 1
      ? `None of the whisper.cpp servers answer (${this.pool.servers.map((s) => s.url).join(", ")}).`
      : `Cannot reach the whisper.cpp server at ${this.url}. Is the iris-whisper service running?`;
  }

  /**
   * Remove whisper's non-speech annotations and common silence hallucinations.
   * @param {string} text
   */
  static clean(text) {
    const cleaned = String(text ?? "")
      .replace(NON_SPEECH, " ")
      .replace(/\s+/g, " ")
      .trim();
    const bare = cleaned.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim();
    if (!bare || HALLUCINATIONS.has(bare)) return "";
    return cleaned;
  }
}

module.exports = WhisperCppSTT;
