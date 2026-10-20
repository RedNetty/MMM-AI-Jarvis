"use strict";

const { spawn, spawnSync } = require("child_process");
const { isJpeg, jpegSize } = require("./jpeg");
const log = require("./log");

const LINUX_TOOLS = ["rpicam-still", "libcamera-still", "fswebcam", "ffmpeg"];
// AVFoundation cameras only accept their native modes; 1280×720 is supported
// by Mac FaceTime cameras and almost every USB webcam. The frame is then
// scaled down to the configured width, which keeps vision fast.
const MAC_CAPTURE_SIZE = "1280x720";

/**
 * Takes still photos for the assistant's vision features.
 *
 * Supports the Raspberry Pi camera (rpicam-still / libcamera-still), USB
 * webcams on Linux (fswebcam or ffmpeg) and, on macOS, the built-in or a USB
 * camera through ffmpeg's AVFoundation input. With tool "auto" the first one
 * installed is used. Photos are captured straight to memory (stdout);
 * nothing is written to disk unless an item is added to the wardrobe.
 */
class Camera {
  /**
   * @param {object} options
   * @param {boolean} [options.enabled=true]
   * @param {string} [options.tool="auto"]  auto | rpicam-still | libcamera-still | fswebcam | ffmpeg | custom
   * @param {string} [options.device="/dev/video0"] USB webcam device.
   * @param {number} [options.width=960]  Vision cost grows with resolution; 960×720 is plenty.
   * @param {number} [options.height=720]
   * @param {number} [options.rotation=0]   0 or 180 (mirror mounted upside down).
   * @param {boolean} [options.flip=false]  Horizontal flip (selfie view).
   * @param {number} [options.warmupMs=1200] Time for auto-exposure to settle.
   * @param {string[]} [options.customCommand] For tool "custom": argv writing a JPEG to stdout.
   *        Placeholders {width}, {height}, {device} are substituted.
   * @param {string} [options.platform=process.platform]
   */
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.enabled = options.enabled !== false;
    this.requestedTool = options.tool ?? "auto";
    this.device = options.device ?? "/dev/video0";
    this.width = options.width ?? 960;
    this.height = options.height ?? 720;
    this.rotation = Number(options.rotation) === 180 ? 180 : 0;
    this.flip = Boolean(options.flip);
    this.warmupMs = options.warmupMs ?? 1200;
    this.customCommand = options.customCommand ?? [];
    this.tool = null;
    this.busy = null;
  }

  /**
   * Resolve which capture tool to use.
   * @returns {string|null} null when no tool is available.
   */
  detect() {
    if (!this.enabled) return null;
    if (this.tool) return this.tool;

    if (this.requestedTool === "custom") {
      this.tool = this.customCommand.length ? "custom" : null;
    } else if (this.requestedTool !== "auto") {
      this.tool = commandExists(this.requestedTool) ? this.requestedTool : null;
    } else {
      this.tool = (this.platform === "darwin" ? ["ffmpeg"] : LINUX_TOOLS).find(commandExists) ?? null;
    }
    return this.tool;
  }

  get available() {
    return this.detect() !== null;
  }

  /**
   * Capture a JPEG. Concurrent calls share the same capture.
   * @returns {Promise<{ jpeg: Buffer, width: number, height: number }>}
   */
  capture() {
    if (!this.busy) {
      this.busy = this._capture().finally(() => {
        this.busy = null;
      });
    }
    return this.busy;
  }

  async _capture() {
    if (!this.enabled) throw new Error("The camera is disabled in the config.");
    const tool = this.detect();
    if (!tool) {
      throw new Error(
        this.platform === "darwin"
          ? "No camera tool found. Install it with: brew install ffmpeg"
          : "No camera tool found. Install rpicam-apps (Pi camera) or fswebcam (USB webcam).",
      );
    }

    const [cmd, ...args] = this._command(tool);
    log.debug(`Camera: ${cmd} ${args.join(" ")}`);
    const jpeg = await run(cmd, args, this.warmupMs + 15000);

    if (!isJpeg(jpeg)) throw new Error(`${tool} did not return a JPEG image.`);
    const size = jpegSize(jpeg) ?? { width: this.width, height: this.height };
    return { jpeg, ...size };
  }

  /** ffmpeg + AVFoundation (macOS). `device` is "default", an index or a camera name. */
  _macCommand() {
    const device = !this.device || this.device.startsWith("/dev/") ? "default" : this.device;
    const filters = [`select=gte(n\\,${Math.max(1, Math.round(this.warmupMs / 33))})`, `scale=${this.width}:-2`];
    if (this.rotation === 180) filters.push("hflip", "vflip");
    if (this.flip) filters.push("hflip");
    return [
      "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "avfoundation", "-framerate", "30", "-video_size", MAC_CAPTURE_SIZE, "-i", `${device}:none`,
      "-vf", filters.join(","), "-frames:v", "1", "-q:v", "3",
      "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
    ];
  }

  _command(tool) {
    const w = String(this.width);
    const h = String(this.height);
    const ms = String(this.warmupMs);

    switch (tool) {
      case "rpicam-still":
      case "libcamera-still": {
        const args = ["-n", "-t", ms, "--width", w, "--height", h, "-e", "jpg", "-q", "88", "-o", "-"];
        if (this.rotation === 180) args.push("--rotation", "180");
        if (this.flip) args.push("--hflip");
        return [tool, ...args];
      }
      case "fswebcam": {
        const skip = String(Math.max(1, Math.round(this.warmupMs / 100)));
        const args = ["-q", "-d", this.device, "-r", `${w}x${h}`, "--no-banner", "-S", skip, "--jpeg", "88"];
        if (this.rotation === 180) args.push("--rotate", "180");
        if (this.flip) args.push("--flip", "h");
        return ["fswebcam", ...args, "-"];
      }
      case "ffmpeg": {
        if (this.platform === "darwin") return this._macCommand();
        const filters = [`select=gte(n\\,${Math.max(1, Math.round(this.warmupMs / 66))})`];
        if (this.rotation === 180) filters.push("hflip", "vflip");
        if (this.flip) filters.push("hflip");
        return [
          "ffmpeg", "-hide_banner", "-loglevel", "error",
          "-f", "v4l2", "-video_size", `${w}x${h}`, "-i", this.device,
          "-vf", filters.join(","), "-frames:v", "1", "-q:v", "3",
          "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
        ];
      }
      case "custom":
        return this.customCommand.map((part) =>
          String(part).replaceAll("{width}", w).replaceAll("{height}", h).replaceAll("{device}", this.device),
        );
      default:
        throw new Error(`Unsupported camera tool "${tool}".`);
    }
  }
}

function commandExists(cmd) {
  return spawnSync("sh", ["-c", `command -v "${cmd}"`], { stdio: "ignore" }).status === 0;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${cmd} timed out.`));
    }, timeoutMs);

    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} failed to start: ${err.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim().split("\n").pop() ?? ""}`));
    });
  });
}

module.exports = Camera;
