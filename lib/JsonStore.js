"use strict";

const fs = require("fs");
const path = require("path");
const log = require("./log");

/**
 * Small JSON file persistence with atomic writes.
 *
 * Writes go to a temp file that is then renamed over the target, so a power cut
 * mid-write (common on a mirror Pi) never leaves a half-written file behind.
 * A file that fails to parse is moved aside rather than silently overwritten.
 */
class JsonStore {
  /**
   * @param {string} filePath Absolute path of the JSON file.
   * @param {object} defaults Initial data used when the file does not exist.
   */
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.data = this._load();
  }

  _load() {
    const fresh = structuredClone(this.defaults);
    if (!fs.existsSync(this.filePath)) return fresh;

    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return { ...fresh, ...parsed };
    } catch (err) {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      log.error(`Could not parse ${this.filePath} (${err.message}). Moved to ${backup}.`);
      try {
        fs.renameSync(this.filePath, backup);
      } catch {
        // Nothing more we can do; start fresh in memory.
      }
      return fresh;
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}

module.exports = JsonStore;
