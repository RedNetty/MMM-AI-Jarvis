"use strict";

const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const log = require("../log");

const SAMPLE_RATE = 16000;
const MAX_BACKOFF_MS = 30000;

/**
 * Continuous microphone capture via ALSA's `arecord`.
 * Emits "data" with raw 16 kHz mono S16LE PCM chunks and restarts with
 * exponential backoff if the recorder dies (e.g. USB mic unplugged).
 *
 * Events: "data" (Buffer), "error" (Error) – error is informational only.
 */
class Microphone extends EventEmitter {
  /**
   * @param {{ device?: string }} [options]
   */
  constructor({ device = "default" } = {}) {
    super();
    this.device = device;
    this.process = null;
    this.running = false;
    this.backoffMs = 1000;
    this.restartTimer = null;
    this.startedAt = 0;
  }

  get sampleRate() {
    return SAMPLE_RATE;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._spawn();
  }

  stop() {
    this.running = false;
    clearTimeout(this.restartTimer);
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }

  _spawn() {
    const args = ["-q", "-D", this.device, "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw"];
    log.debug(`arecord ${args.join(" ")}`);

    const proc = spawn("arecord", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.process = proc;
    this.startedAt = Date.now();

    proc.stdout.on("data", (chunk) => this.emit("data", chunk));

    proc.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg) log.warn(`arecord: ${msg}`);
    });

    proc.on("error", (err) => {
      const message =
        err.code === "ENOENT"
          ? "Microphone recorder 'arecord' not found. Install it with: sudo apt install alsa-utils"
          : `Microphone failed to start: ${err.message}`;
      this.emit("error", new Error(message));
    });

    proc.on("close", (code, signal) => {
      if (this.process === proc) this.process = null;
      if (!this.running) return;

      // A recorder that ran fine for a while gets a quick restart.
      if (Date.now() - this.startedAt > 60000) this.backoffMs = 1000;
      log.warn(`arecord exited (code ${code ?? signal}). Restarting in ${this.backoffMs / 1000}s.`);
      this.restartTimer = setTimeout(() => this._spawn(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    });
  }
}

module.exports = Microphone;
