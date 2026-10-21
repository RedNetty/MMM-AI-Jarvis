"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const log = require("../log");

/**
 * Plays WAV audio.
 *
 *  - Linux (Raspberry Pi): ALSA's `aplay`, fed through stdin. Ships with
 *    alsa-utils, which the microphone already needs. `device` is an ALSA
 *    name (list with `aplay -L`).
 *  - macOS: the built-in `afplay`, from a temporary file. It plays on the
 *    system output device (choose it in System Settings → Sound).
 */
class Speaker {
  /**
   * @param {{ device?: string, platform?: string }} [options]
   */
  constructor({ device = "default", platform = process.platform } = {}) {
    this.device = device;
    this.platform = platform;
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
    return this.platform === "darwin" ? this._playFile(wav) : this._playStdin(wav);
  }

  /** Stop current playback, if any. */
  stop() {
    if (!this.current) return;
    this.current.interrupted = true;
    this.current.proc.kill("SIGTERM");
    this.current = null;
  }

  _playStdin(wav) {
    return this._run("aplay", ["-q", "-D", this.device, "-"], (proc) => {
      // aplay closing stdin early (e.g. when killed) must not crash us.
      proc.stdin.on("error", () => {});
      proc.stdin.end(wav);
    });
  }

  async _playFile(wav) {
    const file = path.join(os.tmpdir(), `iris-play-${crypto.randomBytes(6).toString("hex")}.wav`);
    await fs.promises.writeFile(file, wav);
    try {
      return await this._run("afplay", [file]);
    } finally {
      fs.rm(file, { force: true }, () => {});
    }
  }

  _run(cmd, args, feed) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: [feed ? "pipe" : "ignore", "ignore", "pipe"] });
      const entry = { proc, interrupted: false };
      this.current = entry;

      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      feed?.(proc);

      proc.on("error", (err) => {
        if (this.current === entry) this.current = null;
        reject(
          new Error(
            err.code === "ENOENT" && cmd === "aplay"
              ? "Audio player 'aplay' not found. Install it with: sudo apt install alsa-utils"
              : `Audio playback failed (${cmd}): ${err.message}`,
          ),
        );
      });

      proc.on("close", (code) => {
        if (this.current === entry) this.current = null;
        if (entry.interrupted || code === 0) {
          resolve({ interrupted: entry.interrupted });
        } else {
          log.warn(`${cmd} exited with code ${code}: ${stderr.trim()}`);
          reject(new Error(`Audio playback failed (${cmd} exit ${code}).`));
        }
      });
    });
  }
}

module.exports = Speaker;
