"use strict";

const log = require("../log");

// After an engine fails, try the others first for this long, then give it another chance.
const RETRY_MS = 60000;

/**
 * Several voices in order of preference, e.g. Kokoro on the Mac, then Piper
 * on the Pi, then espeak-ng. Each sentence goes to the first engine that is
 * available; if it fails, the next one speaks instead, so a sleeping Mac
 * never leaves the mirror mute.
 */
class ChainTTS {
  /**
   * @param {object[]} engines TTS engines (synthesize, healthCheck, optional available/robotic/start/stop).
   * @param {{ onSwitch?: (engine: object) => void }} [options] Called when a different engine starts speaking.
   */
  constructor(engines, { onSwitch = null } = {}) {
    if (!engines.length) throw new Error("ChainTTS needs at least one engine.");
    this.engines = engines;
    this.lastUsed = null;
    this.onSwitch = onSwitch;
    /** When each engine last failed a health check or a sentence. */
    this.failedAt = new Map();
  }

  get name() {
    const primary = this.engines[0].name;
    return this.engines.length > 1 ? `${primary}, falling back to ${this.engines.slice(1).map((e) => e.name).join(", ")}` : primary;
  }

  /** The engine that will speak the next sentence, as far as is known. */
  get active() {
    return this._order()[0];
  }

  /** True when the voice in use is the robotic fallback. */
  get robotic() {
    return Boolean((this.lastUsed ?? this.active)?.robotic);
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
    let lastError;
    for (const engine of this._order()) {
      try {
        const wav = await engine.synthesize(text);
        this.failedAt.delete(engine);
        if (engine !== this.lastUsed) {
          if (this.lastUsed) log.info(`Voice: now using ${engine.name}.`);
          this.lastUsed = engine;
          this.onSwitch?.(engine);
        }
        return wav;
      } catch (err) {
        lastError = err;
        this.failedAt.set(engine, Date.now());
        log.warn(`${engine.name} failed (${err.message}); trying the next voice.`);
      }
    }
    throw lastError;
  }

  /** @returns {Promise<string|null>} A problem only when no engine works. */
  async healthCheck() {
    const problems = await Promise.all(this.engines.map((e) => e.healthCheck().catch((err) => err.message)));
    this.engines.forEach((e, i) => (problems[i] ? this.failedAt.set(e, Date.now()) : this.failedAt.delete(e)));
    if (problems.some((p) => !p)) {
      problems.filter(Boolean).forEach((p) => log.warn(`${p} Using the next voice while it's unavailable.`));
      return null;
    }
    return problems[0];
  }

  /**
   * Engines to try, best first: those that are reachable and haven't failed
   * recently, then the rest (a failure may have been a blip, and trying costs little).
   */
  _order() {
    const now = Date.now();
    const ready = (e) => e.available !== false && !(now - (this.failedAt.get(e) ?? -Infinity) < RETRY_MS);
    return [...this.engines.filter(ready), ...this.engines.filter((e) => !ready(e))];
  }
}

ChainTTS.RETRY_MS = RETRY_MS;
module.exports = ChainTTS;
