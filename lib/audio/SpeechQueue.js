"use strict";

/**
 * Speaks sentences in order as they arrive.
 *
 * Sentences can be pushed while earlier ones are still playing (e.g. while
 * the language model is still writing the rest of the answer). The next
 * sentence is synthesised while the current one plays, but never more than
 * one ahead, so text-to-speech doesn't compete with the LLM for the Pi's CPU.
 *
 * The first sentence is always synthesised on its own so the voice starts
 * as soon as possible. Sentences that are waiting together after that are
 * merged (up to `mergeChars`) and synthesised in one go: neural voices like
 * Kokoro and Piper then carry intonation and pauses across sentence
 * boundaries, which sounds like someone talking instead of a string of
 * separately read lines.
 */
class SpeechQueue {
  /**
   * @param {object} deps
   * @param {(text: string) => Promise<Buffer>} deps.synthesize
   * @param {(wav: Buffer) => Promise<{ interrupted: boolean }>} deps.play
   * @param {AbortSignal} deps.signal Abort stops playback of everything queued.
   * @param {() => void} [deps.onStart] Called when the first sentence starts playing.
   * @param {number} [deps.mergeChars=0] Merge waiting sentences up to this many characters (0 = never merge).
   */
  constructor({ synthesize, play, signal, onStart, mergeChars = 0 }) {
    this.synthesize = synthesize;
    this.play = play;
    this.signal = signal;
    this.onStart = onStart ?? (() => {});
    this.mergeChars = Math.max(0, Number(mergeChars) || 0);
    this.pending = [];
    this.closed = false;
    this.started = false;
    this.playing = false;
    this.error = null;
    this.wake = null;
    this.done = this._run();
  }

  /** @param {string} text */
  push(text) {
    if (this.closed || !text) return;
    this.pending.push(this._prepare(text));
    // A sentence streamed in while another plays: prepare it now rather than
    // when playback ends, so there's no gap (still only one ahead).
    if (this.playing) this._prepareNext();
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
        entry.wav = this.synthesize(entry.text);
        entry.wav.catch(() => {}); // surfaced when awaited
      }
      return entry.wav;
    };
    return entry;
  }

  /**
   * Fold the sentences waiting behind the next one into it, while it hasn't
   * started synthesising and the result stays within mergeChars. Never the
   * opening sentence: that one is about getting the voice going quickly.
   */
  _mergeNext() {
    const head = this.pending[0];
    if (!head || head.wav || !this.mergeChars || !this.started) return;
    while (this.pending.length > 1 && head.text.length + 1 + this.pending[1].text.length <= this.mergeChars) {
      head.text = `${head.text} ${this.pending[1].text}`;
      this.pending.splice(1, 1);
    }
  }

  _prepareNext() {
    this._mergeNext();
    this.pending[0]?.load();
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

        this._mergeNext();
        const current = this.pending.shift();
        const wav = await current.load();
        if (this.signal.aborted) return;

        const first = !this.started;
        this.started = true;
        // Prepare what comes next while this one plays.
        this._prepareNext();
        if (first) this.onStart();
        this.playing = true;
        let interrupted;
        try {
          ({ interrupted } = await this.play(wav));
        } finally {
          this.playing = false;
        }
        if (interrupted) return;
      }
    } catch (err) {
      if (!this.signal.aborted) this.error = err;
    }
  }
}

module.exports = SpeechQueue;
