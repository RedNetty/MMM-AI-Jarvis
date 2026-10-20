"use strict";

const { spawn } = require("child_process");

/**
 * Fallback text-to-speech using espeak-ng. Robotic, but tiny, instant and
 * available from apt on every Raspberry Pi OS install.
 */
class EspeakTTS {
  /**
   * @param {{ voice?: string, speed?: number }} [options]
   */
  constructor({ voice = "en-us", speed = 165 } = {}) {
    this.voice = voice;
    this.speed = speed;
  }

  get name() {
    return `espeak-ng (${this.voice})`;
  }

  /**
   * @param {string} text
   * @returns {Promise<Buffer>} WAV audio
   */
  synthesize(text) {
    return new Promise((resolve, reject) => {
      const proc = spawn("espeak-ng", ["--stdout", "-v", this.voice, "-s", String(this.speed), "--stdin"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks = [];
      let stderr = "";

      proc.stdout.on("data", (d) => chunks.push(d));
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.stdin.on("error", () => {});
      proc.on("error", (err) =>
        reject(
          new Error(
            err.code === "ENOENT"
              ? "espeak-ng not found. Install it with: sudo apt install espeak-ng"
              : `espeak-ng failed: ${err.message}`,
          ),
        ),
      );
      proc.on("close", (code) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`espeak-ng exited with code ${code}: ${stderr.trim()}`));
      });

      proc.stdin.end(text);
    });
  }

  async healthCheck() {
    return null;
  }
}

module.exports = EspeakTTS;
