"use strict";

const log = require("../log");

/**
 * Several voices in order of preference, e.g. Kokoro on the Mac, then Piper
 * on the Pi. Each sentence goes to the first engine that is available; if it
 * fails, the next one speaks instead, so a sleeping Mac never leaves the
 * mirror mute.
 */
class ChainTTS {
  /**
   * @param {object[]} engines TTS engines (synthesize, healthCheck, optional available/start/stop).
   */
  constructor(engines) {
    if (!engines.length) throw new Error("ChainTTS needs at least one engine.");
    this.engines = engines;
    this.lastUsed = engines[0];
  }

  get name() {
    const primary = this.engines[0].name;
    return this.engines.length > 1 ? `${primary}, falling back to ${this.engines.slice(1).map((e) => e.name).join(", ")}` : primary;
  }

  start() {
    for (const e of this.engines) e.start?.();
  }

  stop() {
    for (const e of this.engines) e.stop?.();
  }

  /**
   * @param {string} text
   * @returns {Promise<Buffer>} WAV audio
   */
  async synthesize(text) {
    const usable = this.engines.filter((e) => e.available !== false);
    const order = usable.length ? usable : this.engines;
    let lastError;
    for (const engine of order) {
      try {
        const wav = await engine.synthesize(text);
        if (engine !== this.lastUsed) {
          log.info(`Voice: now using ${engine.name}.`);
          this.lastUsed = engine;
        }
        return wav;
      } catch (err) {
        lastError = err;
        log.warn(`${engine.name} failed (${err.message}); trying the next voice.`);
      }
    }
    throw lastError;
  }

  /** @returns {Promise<string|null>} A problem only when no engine works. */
  async healthCheck() {
    const problems = await Promise.all(this.engines.map((e) => e.healthCheck().catch((err) => err.message)));
    if (problems.some((p) => !p)) {
      problems.filter(Boolean).forEach((p) => log.warn(`${p} Using the next voice while it's unavailable.`));
      return null;
    }
    return problems[0];
  }
}

module.exports = ChainTTS;
