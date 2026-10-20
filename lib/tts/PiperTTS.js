"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const log = require("../log");
const ServerPool = require("../ServerPool");

/**
 * Local neural text-to-speech with Piper (https://github.com/OHF-Voice/piper1-gpl).
 *
 * Two modes, tried in this order:
 *  1. HTTP – a persistent `python -m piper.http_server` (installed as the
 *     jarvis-piper service by scripts/setup-pi.sh). The voice stays loaded,
 *     so a sentence takes ~0.1-0.4 s instead of ~3 s for a cold CLI start.
 *  2. CLI  – spawn `piper -m <voice.onnx> -f <out.wav>` per sentence. Slower,
 *     but needs no service. Used automatically if the server is unreachable.
 */
class PiperTTS {
  /**
   * @param {object} options
   * @param {string|string[]} [options.url] Piper HTTP server(s), e.g. "http://127.0.0.1:5005", in order of
   *        preference (a Mac on your network, then the Pi). Empty = CLI only.
   * @param {string} [options.command] Path to the piper executable (CLI mode).
   * @param {string} [options.model]   Path to the voice .onnx file (CLI mode).
   * @param {number|null} [options.speaker] Speaker id for multi-speaker voices.
   * @param {number|null} [options.lengthScale] Speaking speed (<1 faster, >1 slower).
   * @param {string[]} [options.extraArgs] Additional CLI arguments.
   * @param {number} [options.timeoutMs=30000]
   */
  constructor({ url = "", command = "piper", model = "", speaker = null, lengthScale = null, extraArgs = [], timeoutMs = 30000 } = {}) {
    const servers = ServerPool.normalize(url ?? "").filter((s) => s.url);
    this.pool = servers.length ? new ServerPool(servers, { label: "Piper" }) : null;
    this.command = expandHome(command);
    this.model = expandHome(model ?? "");
    this.speaker = speaker;
    this.lengthScale = lengthScale;
    this.extraArgs = extraArgs;
    this.timeoutMs = timeoutMs;
    this.httpFailedAt = 0;
  }

  get url() {
    return this.pool?.active.url ?? "";
  }

  start() {
    this.pool?.start();
  }

  stop() {
    this.pool?.stop();
  }

  get name() {
    return this.url ? `Piper server (${this.url})` : `Piper CLI (${path.basename(this.model)})`;
  }

  /**
   * @param {string} text
   * @returns {Promise<Buffer>} WAV audio
   */
  async synthesize(text) {
    const line = text.replace(/\s+/g, " ").trim();
    // After an HTTP failure, use the CLI for a minute before retrying the server.
    if (this.url && Date.now() - this.httpFailedAt > 60000) {
      try {
        return await this._http(line);
      } catch (err) {
        if (!this._cliConfigured) throw err;
        this.httpFailedAt = Date.now();
        log.warn(`Piper server failed (${err.message}); using the piper CLI.`);
      }
    }
    return this._cli(line);
  }

  async healthCheck() {
    if (this.pool) {
      await this.pool.probeAll();
      if (this.pool.servers.some((s) => s.up)) return null;
      if (!this._cliConfigured) return `Cannot reach the Piper server at ${this.url}. Is the jarvis-piper service running?`;
      log.warn(`Piper server at ${this.url} is unreachable; using the slower piper CLI.`);
    }
    if (!this.model || !fs.existsSync(this.model)) {
      return `Piper voice model not found at "${this.model}". Set tts.piperModel to your .onnx voice file.`;
    }
    if (!fs.existsSync(`${this.model}.json`)) {
      return `Piper voice config "${this.model}.json" is missing – download it next to the .onnx file.`;
    }
    return null;
  }

  get _cliConfigured() {
    return Boolean(this.model && fs.existsSync(this.model));
  }

  async _http(text) {
    const body = { text };
    if (this.speaker !== null && this.speaker !== undefined) body.speaker_id = Number(this.speaker);
    if (this.lengthScale) body.length_scale = Number(this.lengthScale);

    return this.pool.run(async (server) => {
      const res = await fetch(`${server.url}/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });
  }

  async _cli(text) {
    const outFile = path.join(os.tmpdir(), `jarvis-tts-${crypto.randomBytes(6).toString("hex")}.wav`);
    const args = ["-m", this.model, "-f", outFile, ...this.extraArgs];
    if (this.speaker !== null && this.speaker !== undefined) args.push("-s", String(this.speaker));
    if (this.lengthScale) args.push("--length-scale", String(this.lengthScale));

    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(this.command, args, { stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          reject(new Error("Piper timed out."));
        }, this.timeoutMs);

        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.stdin.on("error", () => {});
        proc.on("error", (err) => {
          clearTimeout(timer);
          reject(
            new Error(
              err.code === "ENOENT"
                ? `Piper executable not found at "${this.command}". Run scripts/setup-pi.sh or set tts.piperCommand.`
                : `Piper failed to start: ${err.message}`,
            ),
          );
        });
        proc.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`Piper exited with code ${code}: ${stderr.trim().split("\n").pop()}`));
        });

        proc.stdin.end(`${text}\n`);
      });

      return await fs.promises.readFile(outFile);
    } finally {
      fs.rm(outFile, { force: true }, () => {});
    }
  }
}

function expandHome(p) {
  return typeof p === "string" && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

PiperTTS.expandHome = expandHome;
module.exports = PiperTTS;
