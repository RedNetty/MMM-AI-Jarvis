"use strict";

const { spawn } = require("child_process");
const log = require("../log");

/**
 * Plays WAV audio through ALSA's `aplay` (ships with alsa-utils, which is
 * already required for the microphone – no extra player needed).
 */
class Speaker {
  /**
   * @param {{ device?: string }} [options]
   */
  constructor({ device = "default" } = {}) {
    this.device = device;
    this.current = null;
  }

  get isPlaying() {
    return this.current !== null;
  }

  /**
   * Play a WAV buffer. Resolves when playback finishes or is stopped.
   * @param {Buffer} wav
   * @returns {Promise<{ interrupted: boolean }>}
   */
  play(wav) {
    this.stop();

    return new Promise((resolve, reject) => {
      const proc = spawn("aplay", ["-q", "-D", this.device, "-"], { stdio: ["pipe", "ignore", "pipe"] });
      const entry = { proc, interrupted: false };
      this.current = entry;

      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += d.toString()));

      // aplay closing stdin early (e.g. when killed) must not crash us.
      proc.stdin.on("error", () => {});
      proc.stdin.end(wav);

      proc.on("error", (err) => {
        if (this.current === entry) this.current = null;
        reject(
          new Error(
            err.code === "ENOENT"
              ? "Audio player 'aplay' not found. Install it with: sudo apt install alsa-utils"
              : `Audio playback failed: ${err.message}`,
          ),
        );
      });

      proc.on("close", (code) => {
        if (this.current === entry) this.current = null;
        if (entry.interrupted || code === 0) {
          resolve({ interrupted: entry.interrupted });
        } else {
          log.warn(`aplay exited with code ${code}: ${stderr.trim()}`);
          reject(new Error(`Audio playback failed (aplay exit ${code}).`));
        }
      });
    });
  }

  /** Stop current playback, if any. */
  stop() {
    if (!this.current) return;
    this.current.interrupted = true;
    this.current.proc.kill("SIGTERM");
    this.current = null;
  }
}

module.exports = Speaker;
