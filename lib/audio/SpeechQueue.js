"use strict";

/**
 * Speaks sentences in order as they arrive.
 *
 * Sentences can be pushed while earlier ones are still playing (e.g. while
 * the language model is still writing the rest of the answer). The next
 * sentence is synthesised while the current one plays, but never more than
 * one ahead, so text-to-speech doesn't compete with the LLM for the Pi's CPU.
 */
class SpeechQueue {
  /**
   * @param {object} deps
   * @param {(text: string) => Promise<Buffer>} deps.synthesize
   * @param {(wav: Buffer) => Promise<{ interrupted: boolean }>} deps.play
   * @param {AbortSignal} deps.signal Abort stops playback of everything queued.
   * @param {() => void} [deps.onStart] Called when the first sentence starts playing.
   */
  constructor({ synthesize, play, signal, onStart }) {
    this.synthesize = synthesize;
    this.play = play;
    this.signal = signal;
    this.onStart = onStart ?? (() => {});
    this.pending = [];
    this.closed = false;
    this.started = false;
    this.error = null;
    this.wake = null;
    this.done = this._run();
  }

  /** @param {string} text */
  push(text) {
    if (this.closed || !text) return;
    this.pending.push(this._prepare(text));
    this.wake?.();
  }

  /** Stop accepting sentences; whatever is queued still plays unless aborted. */
  close() {
    this.closed = true;
    this.wake?.();
  }

  /**
   * No more sentences will be pushed. Resolves when everything has played
   * (or playback was cancelled); rejects if synthesis or playback failed.
   */
  async finish() {
    this.close();
    await this.done;
    if (this.error) throw this.error;
  }

  _prepare(text) {
    // Synthesis starts lazily: only the next sentence in line is prepared.
    const entry = { text, wav: null };
    entry.load = () => {
      if (!entry.wav) {
        entry.wav = this.synthesize(text);
        entry.wav.catch(() => {}); // surfaced when awaited
      }
      return entry.wav;
    };
    return entry;
  }

  async _run() {
    try {
      while (!this.signal.aborted) {
        if (this.pending.length === 0) {
          if (this.closed) return;
          await new Promise((resolve) => {
            this.wake = resolve;
          });
          this.wake = null;
          continue;
        }

        const current = this.pending.shift();
        const wav = await current.load();
        this.pending[0]?.load(); // prepare the next sentence while this one plays
        if (this.signal.aborted) return;

        if (!this.started) {
          this.started = true;
          this.onStart();
        }
        const { interrupted } = await this.play(wav);
        if (interrupted) return;
      }
    } catch (err) {
      if (!this.signal.aborted) this.error = err;
    }
  }
}

module.exports = SpeechQueue;
