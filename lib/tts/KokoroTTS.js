"use strict";

const ServerPool = require("../ServerPool");

/**
 * Natural-sounding local text-to-speech with Kokoro-82M, served by
 * scripts/kokoro_server.py (installed on a Mac by setup-mac.sh).
 *
 * Kokoro sounds much closer to a person than Piper, but is too heavy for a
 * Raspberry Pi, so it normally runs on a Mac with Piper on the Pi as the
 * fallback (see ChainTTS). The server is probed in the background, so while
 * the Mac sleeps sentences go straight to Piper without waiting on a timeout.
 */
class KokoroTTS {
  /**
   * @param {object} options
   * @param {string|string[]} options.url Kokoro server(s), e.g. "http://macbook.local:5006".
   * @param {string} [options.voice=""]   e.g. "af_heart", "bf_emma", "am_michael"; "" = the server's default.
   * @param {number|null} [options.speed=null] 1 = normal, 1.1 = a little faster.
   * @param {number} [options.timeoutMs=15000]
   */
  constructor({ url, voice = "", speed = null, timeoutMs = 15000 } = {}) {
    const servers = ServerPool.normalize(url ?? "").filter((s) => s.url);
    if (!servers.length) throw new Error('tts.kokoroUrl is required for tts.provider "kokoro".');
    this.pool = new ServerPool(servers, { label: "Kokoro", probeSingle: true });
    this.voice = voice;
    this.speed = speed;
    this.timeoutMs = timeoutMs;
  }

  get url() {
    return this.pool.active.url;
  }

  get name() {
    return `Kokoro (${this.url}${this.voice ? `, ${this.voice}` : ""})`;
  }

  /** False while every Kokoro server failed its last probe. */
  get available() {
    return this.pool.anyUp;
  }

  start() {
    this.pool.start();
  }

  stop() {
    this.pool.stop();
  }

  /**
   * @param {string} text
   * @returns {Promise<Buffer>} WAV audio
   */
  async synthesize(text) {
    const body = { text: text.replace(/\s+/g, " ").trim() };
    if (this.voice) body.voice = this.voice;
    if (this.speed) body.speed = Number(this.speed);

    return this.pool.run(async (server) => {
      const res = await fetch(`${server.url}/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`Kokoro server returned HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });
  }

  async healthCheck() {
    await this.pool.probeAll();
    return this.pool.anyUp ? null : `Cannot reach the Kokoro voice server at ${this.pool.servers.map((s) => s.url).join(", ")}.`;
  }
}

module.exports = KokoroTTS;
