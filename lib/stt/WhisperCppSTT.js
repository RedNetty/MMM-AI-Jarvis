"use strict";

const { pcmToWav } = require("../audio/wav");

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
 * Runs entirely on the device – no internet, no API key.
 */
class WhisperCppSTT {
  /**
   * @param {{ url?: string, language?: string, timeoutMs?: number }} options
   */
  constructor({ url = "http://127.0.0.1:8178", language = "en", timeoutMs = 30000 } = {}) {
    this.url = url.replace(/\/+$/, "");
    this.language = language;
    this.timeoutMs = timeoutMs;
  }

  get name() {
    return `whisper.cpp (${this.url})`;
  }

  /**
   * @param {Buffer} pcm 16 kHz mono S16LE audio
   * @returns {Promise<string>}
   */
  async transcribe(pcm) {
    const form = new FormData();
    form.append("file", new Blob([pcmToWav(pcm, 16000)], { type: "audio/wav" }), "utterance.wav");
    form.append("response_format", "json");
    form.append("temperature", "0.0");
    if (this.language) form.append("language", this.language);

    const res = await fetch(`${this.url}/inference`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`whisper.cpp server returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const body = await res.json();
    return WhisperCppSTT.clean(body.text);
  }

  async healthCheck() {
    try {
      const res = await fetch(this.url, { signal: AbortSignal.timeout(4000) });
      if (res.status >= 500) return `whisper.cpp server at ${this.url} is unhealthy (HTTP ${res.status}).`;
      return null;
    } catch {
      return `Cannot reach the whisper.cpp server at ${this.url}. Is the jarvis-whisper service running?`;
    }
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
