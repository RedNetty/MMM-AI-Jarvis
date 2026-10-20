"use strict";

const { EventEmitter } = require("events");

const FRAME_MS = 20;

/**
 * Energy-based voice activity detector that cuts a continuous PCM stream into
 * utterances.
 *
 * Only utterances are sent to speech-to-text, which is what makes local
 * Whisper practical on a Raspberry Pi and keeps cloud STT costs near zero
 * (the old design streamed the microphone to Google 24/7).
 *
 * The threshold adapts to the room: it is the larger of the configured
 * minimum and the tracked background noise floor × noiseMultiplier.
 * If steady noise starts later (a fan, a TV, a heater) and keeps the detector
 * "speaking" until the maximum length, the segment is recognised as noise by
 * its flat loudness, the noise floor is re-learned from it, and it is
 * discarded instead of being sent to speech-to-text.
 *
 * Events:
 *   "speechstart"            – speech began
 *   "utterance" (Buffer pcm) – a complete utterance, including pre-roll
 *   "discard"                – speech ended but was too short to keep
 */
class VoiceActivityDetector extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.sampleRate=16000]
   * @param {number} [options.threshold=500]       Minimum RMS (0-32767) counted as speech.
   * @param {number} [options.noiseMultiplier=3]   Speech must be this many times louder than the noise floor.
   * @param {number} [options.startMs=60]          Voiced audio needed before speech "starts".
   * @param {number} [options.silenceMs=900]       Silence that ends an utterance.
   * @param {number} [options.preRollMs=400]       Audio kept from before speech started.
   * @param {number} [options.minUtteranceMs=350]  Shorter utterances are discarded.
   * @param {number} [options.maxUtteranceMs=15000] Utterances are cut at this length.
   */
  constructor(options = {}) {
    super();
    this.sampleRate = options.sampleRate ?? 16000;
    this.threshold = options.threshold ?? 500;
    this.noiseMultiplier = options.noiseMultiplier ?? 3;
    this.startFrames = Math.max(1, Math.round((options.startMs ?? 60) / FRAME_MS));
    this.silenceFrames = Math.max(1, Math.round((options.silenceMs ?? 900) / FRAME_MS));
    this.preRollFrames = Math.max(0, Math.round((options.preRollMs ?? 400) / FRAME_MS));
    this.minFrames = Math.round((options.minUtteranceMs ?? 350) / FRAME_MS);
    this.maxFrames = Math.round((options.maxUtteranceMs ?? 15000) / FRAME_MS);

    this.frameBytes = (this.sampleRate * FRAME_MS * 2) / 1000;
    this.noiseFloor = null;
    this.paused = false;
    this.reset();
  }

  reset() {
    this.remainder = Buffer.alloc(0);
    this.preRoll = [];
    this.frames = [];
    this.levels = [];
    this.speaking = false;
    this.voicedRun = 0;
    this.silentRun = 0;
    this.voicedFrames = 0;
  }

  /** Stop producing utterances (input is still used to track noise). */
  pause() {
    this.paused = true;
    this.reset();
  }

  resume() {
    this.paused = false;
  }

  /** Current effective speech threshold. */
  get effectiveThreshold() {
    const adaptive = this.noiseFloor === null ? 0 : this.noiseFloor * this.noiseMultiplier;
    return Math.max(this.threshold, adaptive);
  }

  /**
   * Feed raw S16LE mono PCM.
   * @param {Buffer} chunk
   */
  write(chunk) {
    let buf = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;
    let offset = 0;
    while (offset + this.frameBytes <= buf.length) {
      this._processFrame(buf.subarray(offset, offset + this.frameBytes));
      offset += this.frameBytes;
    }
    this.remainder = Buffer.from(buf.subarray(offset));
  }

  _processFrame(frame) {
    const rms = VoiceActivityDetector.rms(frame);
    const voiced = rms >= this.effectiveThreshold;

    if (!this.speaking) this._trackNoise(rms, voiced);
    if (this.paused) return;

    const copy = Buffer.from(frame);

    if (!this.speaking) {
      this.preRoll.push(copy);
      if (this.preRoll.length > this.preRollFrames + this.startFrames) this.preRoll.shift();

      this.voicedRun = voiced ? this.voicedRun + 1 : 0;
      if (this.voicedRun >= this.startFrames) {
        this.speaking = true;
        this.frames = this.preRoll;
        this.levels = [];
        this.preRoll = [];
        this.voicedFrames = this.voicedRun;
        this.silentRun = 0;
        this.emit("speechstart");
      }
      return;
    }

    this.frames.push(copy);
    this.levels.push(rms);
    if (voiced) {
      this.voicedFrames += 1;
      this.silentRun = 0;
    } else {
      this.silentRun += 1;
    }

    if (this.silentRun >= this.silenceFrames) {
      this._finish(false);
    } else if (this.frames.length >= this.maxFrames) {
      this._finish(true);
    }
  }

  _finish(hitMaxLength) {
    const frames = this.frames;
    const levels = this.levels;
    const voiced = this.voicedFrames;
    this.reset();

    if (hitMaxLength && VoiceActivityDetector.isStationary(levels)) {
      // Constant loudness for the whole window: background noise, not a person.
      this.noiseFloor = median(levels);
      this.emit("discard");
      return;
    }

    if (voiced >= this.minFrames) {
      this.emit("utterance", Buffer.concat(frames));
    } else {
      this.emit("discard");
    }
  }

  /**
   * Speech rises and falls between syllables and words; fans, hums and
   * static stay level. Coefficient of variation of the frame loudness below
   * 0.25 is treated as stationary noise.
   * @param {number[]} levels Frame RMS values.
   */
  static isStationary(levels) {
    if (levels.length < 10) return false;
    const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
    if (mean === 0) return true;
    const variance = levels.reduce((a, b) => a + (b - mean) ** 2, 0) / levels.length;
    return Math.sqrt(variance) / mean < 0.25;
  }

  _trackNoise(rms, voiced) {
    if (this.noiseFloor === null) {
      this.noiseFloor = rms;
      return;
    }
    // Follow drops quickly, rises slowly – and ignore loud frames entirely so
    // speech does not drag the floor up.
    if (rms < this.noiseFloor) {
      this.noiseFloor = this.noiseFloor * 0.9 + rms * 0.1;
    } else if (!voiced) {
      this.noiseFloor = this.noiseFloor * 0.995 + rms * 0.005;
    }
  }

  /**
   * Root-mean-square amplitude of a S16LE frame.
   * @param {Buffer} frame
   */
  static rms(frame) {
    const samples = frame.length >> 1;
    if (samples === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples; i++) {
      const s = frame.readInt16LE(i * 2);
      sum += s * s;
    }
    return Math.sqrt(sum / samples);
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

module.exports = VoiceActivityDetector;
