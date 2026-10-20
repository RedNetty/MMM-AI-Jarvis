"use strict";

const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const log = require("../log");

const SAMPLE_RATE = 16000;
const MAX_BACKOFF_MS = 30000;

/**
 * Continuous microphone capture as raw 16 kHz mono S16LE PCM.
 *
 *  - Linux (Raspberry Pi): ALSA's `arecord`. `device` is an ALSA name such
 *    as "default" or "plughw:1,0" (list with `arecord -L`).
 *  - macOS: ffmpeg with AVFoundation. `device` is "default", an index ("1")
 *    or a name (list with `ffmpeg -f avfoundation -list_devices true -i ""`).
 *
 * Restarts with exponential backoff if the recorder dies (e.g. USB mic unplugged).
 *
 * Events: "data" (Buffer), "error" (Error) – error is informational only.
 */
class Microphone extends EventEmitter {
  /**
   * @param {{ device?: string, platform?: string }} [options]
   */
  constructor({ device = "default", platform = process.platform } = {}) {
    super();
    this.device = device;
    this.platform = platform;
    this.process = null;
    this.running = false;
    this.backoffMs = 1000;
    this.restartTimer = null;
    this.startedAt = 0;
  }

  get sampleRate() {
    return SAMPLE_RATE;
  }

  /**
   * The recorder command for this platform.
   * @returns {string[]} argv
   */
  command() {
    if (this.platform === "darwin") {
      const device = String(this.device || "default");
      return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "avfoundation", "-i", `:${device}`,
        "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "pipe:1",
      ];
    }
    return ["arecord", "-q", "-D", this.device, "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw"];
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
    const [cmd, ...args] = this.command();
    log.debug(`${cmd} ${args.join(" ")}`);

    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.process = proc;
    this.startedAt = Date.now();

    proc.stdout.on("data", (chunk) => this.emit("data", chunk));

    proc.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg) log.warn(`${cmd}: ${msg}`);
    });

    proc.on("error", (err) => {
      let message = `Microphone failed to start: ${err.message}`;
      if (err.code === "ENOENT") {
        message =
          this.platform === "darwin"
            ? "Microphone recorder 'ffmpeg' not found. Install it with: brew install ffmpeg"
            : "Microphone recorder 'arecord' not found. Install it with: sudo apt install alsa-utils";
      }
      this.emit("error", new Error(message));
    });

    proc.on("close", (code, signal) => {
      if (this.process === proc) this.process = null;
      if (!this.running) return;

      // A recorder that ran fine for a while gets a quick restart.
      if (Date.now() - this.startedAt > 60000) this.backoffMs = 1000;
      log.warn(`${cmd} exited (code ${code ?? signal}). Restarting in ${this.backoffMs / 1000}s.`);
      this.restartTimer = setTimeout(() => this._spawn(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    });
  }
}

module.exports = Microphone;
