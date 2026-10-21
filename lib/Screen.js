"use strict";

const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { normalize } = require("./text");
const log = require("./log");

const SELF = "MMM-AI-Jarvis";

// Friendly words people use for common modules.
const ALIASES = {
  news: ["newsfeed", "news", "headlines"],
  newsfeed: ["newsfeed", "news"],
  headlines: ["newsfeed"],
  weather: ["weather", "weatherforecast", "currentweather", "forecast"],
  forecast: ["weather", "weatherforecast", "forecast"],
  calendar: ["calendar", "agenda", "events"],
  agenda: ["calendar"],
  appointments: ["calendar"],
  clock: ["clock", "time", "date"],
  time: ["clock"],
  date: ["clock"],
  compliments: ["compliments", "compliment"],
  alerts: ["alert"],
};

const REGIONS = [
  "top_bar", "top_left", "top_center", "top_right", "upper_third", "middle_center",
  "lower_third", "bottom_left", "bottom_center", "bottom_right", "bottom_bar",
];
const EMPTY_LAYOUT = () => ({ moves: {}, scales: {}, brightness: 1, fontScale: 1, mode: "normal", hidden: [] });

/**
 * Knows what is on the mirror and directs it: show and hide modules, move
 * them to other regions, resize them, dim or switch off the screen, night
 * mode, bigger text, point things out, and named layouts ("morning",
 * "party") that can be saved and recalled. The current layout is kept in
 * data/layout.json and re-applied when the mirror starts.
 *
 * Events: "command" ({ action: "hide" | "show" | "restore", ids? } or
 *                    { action: "director", op, args })
 *         "notify"  ({ notification, payload })
 */
class Screen extends EventEmitter {
  /**
   * @param {{ file?: string|null }} [options] Where to keep the layout (null = memory only).
   */
  constructor({ file = null } = {}) {
    super();
    /** @type {{ id: string, name: string, header: string, position: string, hidden: boolean }[]} */
    this.modules = [];
    this.file = file;
    const saved = this._load();
    this.layout = { ...EMPTY_LAYOUT(), ...saved.layout };
    this.scenes = saved.scenes ?? {};
    this.layoutApplied = false;
  }

  /**
   * @param {object[]} inventory From the front-end.
   */
  setInventory(inventory) {
    if (!Array.isArray(inventory)) return;
    const own = inventory.find((m) => m?.name === SELF);
    this.self = own ? { id: String(own.id), name: SELF, header: "", position: String(own.position ?? ""), hidden: false } : null;
    this.modules = inventory
      .filter((m) => m && m.id && m.name !== SELF)
      .map((m) => ({
        id: String(m.id),
        name: String(m.name),
        header: String(m.header ?? ""),
        position: String(m.position ?? ""),
        hidden: Boolean(m.hidden),
      }));
    // First inventory after a (re)load: put the mirror back the way it was left.
    if (!this.layoutApplied) {
      this.layoutApplied = true;
      if (!isDefault(this.layout)) this._applyLayout(this.layout);
    }
  }

  /** The browser reloaded: the saved layout needs applying again. */
  resetSession() {
    this.layoutApplied = false;
  }

  /**
   * Modules matching a spoken description ("the news", "calendar", "top left").
   * @param {string} query
   */
  find(query) {
    // "Move yourself to the bottom", "make Iris bigger".
    if (this.self && /^(?:you|yourself|iris|jarvis|the assistant|assistant|your (?:display|cards?|window|stuff))$/.test(normalize(query).replace(/^(?:the|my)\s+/, ""))) return [this.self];
    const q = normalize(query)
      .replace(/\b(the|my|module|modules|widget|panel|section|thing|on the screen|screen|please)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!q) return [];

    const wanted = new Set([q, ...(ALIASES[q] ?? [])]);
    return this.modules.filter((m) => {
      const name = normalize(m.name.replace(/^MMM-/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " "));
      const header = normalize(m.header);
      const position = normalize(this.positionOf(m).replace(/_/g, " "));
      const hay = ` ${name} ${name.replace(/\s/g, "")} ${header} ${position} `;
      return [...wanted].some((w) => hay.includes(` ${w} `) || hay.includes(` ${w}`) || (w.length > 3 && hay.includes(w)));
    });
  }

  /** Where a module is now (after any move). */
  positionOf(module) {
    return this.layout.moves[module.id] ?? module.position;
  }

  // ─── Visibility ────────────────────────────────────────────────────

  hide(modules) {
    const ids = modules.map((m) => m.id);
    if (ids.length) {
      this.emit("command", { action: "hide", ids });
      this.layout.hidden = [...new Set([...this.layout.hidden, ...ids])];
      this._save();
    }
    return ids.length;
  }

  show(modules) {
    const ids = modules.map((m) => m.id);
    if (ids.length) {
      this.emit("command", { action: "show", ids });
      this.layout.hidden = this.layout.hidden.filter((id) => !ids.includes(id));
      this._save();
    }
    return ids.length;
  }

  /** Hide every other module so only Iris is visible. */
  focus() {
    return this.hide(this.modules.filter((m) => !m.hidden));
  }

  /** Show everything Iris hid. */
  restore() {
    this.emit("command", { action: "restore" });
    this.layout.hidden = [];
    this._save();
  }

  // ─── Arranging ─────────────────────────────────────────────────────

  /**
   * Move modules to a region.
   * @param {object[]} modules
   * @param {string} position e.g. "top_left"
   */
  move(modules, position) {
    if (!REGIONS.includes(position) || !modules.length) return 0;
    const ids = modules.map((m) => m.id);
    for (const m of modules) {
      if (m.position === position) delete this.layout.moves[m.id];
      else this.layout.moves[m.id] = position;
    }
    this._direct("move", { ids, position });
    return ids.length;
  }

  /**
   * Resize modules: a factor, or relative ("bigger" ×1.25, "smaller" ×0.8).
   * @param {object[]} modules
   * @param {number|"bigger"|"smaller"|"reset"} change
   * @returns {number} The new factor of the first module.
   */
  scale(modules, change) {
    let factor = 1;
    for (const m of modules) {
      const current = this.layout.scales[m.id] ?? 1;
      factor = change === "bigger" ? current * 1.3 : change === "smaller" ? current / 1.3 : change === "reset" ? 1 : Number(change) || 1;
      factor = Math.round(Math.max(0.5, Math.min(2.5, factor)) * 100) / 100;
      if (factor === 1) delete this.layout.scales[m.id];
      else this.layout.scales[m.id] = factor;
    }
    // One direct call per distinct factor keeps the front-end simple.
    const byFactor = new Map();
    for (const m of modules) {
      const f = this.layout.scales[m.id] ?? 1;
      byFactor.set(f, [...(byFactor.get(f) ?? []), m.id]);
    }
    for (const [f, ids] of byFactor) this._direct("scale", { ids, factor: f });
    return factor;
  }

  /**
   * Text size across the whole mirror.
   * @param {number|"bigger"|"smaller"|"reset"} change
   */
  setFontScale(change) {
    const current = this.layout.fontScale;
    let f = change === "bigger" ? current + 0.15 : change === "smaller" ? current - 0.15 : change === "reset" ? 1 : Number(change) || 1;
    f = Math.round(Math.max(0.7, Math.min(1.8, f)) * 100) / 100;
    this.layout.fontScale = f;
    this._direct("fontScale", { factor: f });
    return f;
  }

  /**
   * Brightness from 0 (off) to 1, or relative ("dimmer", "brighter").
   * @param {number|"dimmer"|"brighter"} change
   */
  setBrightness(change) {
    const current = this.layout.brightness || this.lastBrightness || 1;
    let l = change === "dimmer" ? current - 0.25 : change === "brighter" ? current + 0.25 : Number(change);
    if (!Number.isFinite(l)) l = 1;
    l = Math.round(Math.max(change === "dimmer" ? 0.15 : 0, Math.min(1, l)) * 100) / 100;
    if (l > 0) this.lastBrightness = l;
    this.layout.brightness = l;
    this._direct("brightness", { level: l });
    return l;
  }

  get asleep() {
    return this.layout.brightness === 0;
  }

  /** Screen off (a black overlay; the mirror keeps listening). */
  sleep() {
    if (this.layout.brightness > 0) this.lastBrightness = this.layout.brightness;
    return this.setBrightness(0);
  }

  /** Screen back on at its previous brightness. */
  wake() {
    if (!this.asleep) return false;
    this.setBrightness(this.lastBrightness || 1);
    return true;
  }

  /** @param {"night"|"normal"} mode */
  setMode(mode) {
    this.layout.mode = mode === "night" ? "night" : "normal";
    this._direct("mode", { mode: this.layout.mode });
    return this.layout.mode;
  }

  /** Pulse a ring around modules ("where's the calendar?"). */
  highlight(modules) {
    const ids = modules.map((m) => m.id);
    if (ids.length) this.emit("command", { action: "director", op: "highlight", args: { ids } });
    return ids.length;
  }

  /** Back to the config's own layout: everything shown, where it started, normal size and brightness. */
  resetLayout() {
    this.layout = EMPTY_LAYOUT();
    this.emit("command", { action: "restore" });
    this._direct("reset", {});
  }

  /** Reload the mirror page (picks up config changes). */
  reload() {
    this.resetSession();
    this.emit("command", { action: "director", op: "reload", args: {} });
  }

  // ─── Scenes ────────────────────────────────────────────────────────

  /**
   * Save the current layout under a name ("morning", "party").
   * @param {string} name
   */
  saveScene(name) {
    const key = sceneKey(name);
    if (!key) return null;
    this.scenes[key] = JSON.parse(JSON.stringify({ ...this.layout, hidden: this._hiddenNow() }));
    this._save();
    return key;
  }

  /**
   * Switch to a saved layout.
   * @param {string} name
   * @returns {string|null} The scene's name, or null if there's none by that name.
   */
  loadScene(name) {
    const key = sceneKey(name);
    const scene = this.scenes[key];
    if (!scene) return null;
    this.layout = { ...EMPTY_LAYOUT(), ...JSON.parse(JSON.stringify(scene)) };
    this._applyLayout(this.layout);
    return key;
  }

  deleteScene(name) {
    const key = sceneKey(name);
    if (!this.scenes[key]) return false;
    delete this.scenes[key];
    this._save();
    return true;
  }

  listScenes() {
    return Object.keys(this.scenes);
  }

  /**
   * Send a MagicMirror notification to other modules.
   * @param {string} notification
   * @param {any} [payload]
   */
  notify(notification, payload = null) {
    this.emit("notify", { notification, payload });
  }

  describe() {
    return this.modules.map((m) => ({
      name: m.name,
      header: m.header || undefined,
      position: this.positionOf(m).replace(/_/g, " "),
      visible: !m.hidden,
      size: this.layout.scales[m.id] ?? 1,
    }));
  }

  // ─── Internals ─────────────────────────────────────────────────────

  _direct(op, args) {
    this.emit("command", { action: "director", op, args });
    this._save();
  }

  _applyLayout(layout) {
    const hidden = new Set(layout.hidden ?? []);
    const toHide = this.modules.filter((m) => hidden.has(m.id));
    // Show what this layout doesn't hide, then hide what it does.
    this.emit("command", { action: "restore" });
    if (toHide.length) this.emit("command", { action: "hide", ids: toHide.map((m) => m.id) });
    this.emit("command", { action: "director", op: "apply", args: { state: layout } });
    this._save();
  }

  _hiddenNow() {
    return [...new Set([...this.layout.hidden, ...this.modules.filter((m) => m.hidden).map((m) => m.id)])];
  }

  _load() {
    if (!this.file) return {};
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") log.warn(`Couldn't read ${this.file}: ${err.message}`);
      return {};
    }
  }

  _save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ layout: this.layout, scenes: this.scenes }, null, 2));
    } catch (err) {
      log.warn(`Couldn't save the layout: ${err.message}`);
    }
  }
}

function sceneKey(name) {
  return normalize(name)
    .replace(/\b(the|my|a|layout|scene|view|setup|mode|screen)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDefault(layout) {
  return (
    !Object.keys(layout.moves).length &&
    !Object.keys(layout.scales).length &&
    layout.brightness === 1 &&
    layout.fontScale === 1 &&
    layout.mode === "normal" &&
    !(layout.hidden ?? []).length
  );
}

/**
 * Turn spoken placement into a MagicMirror region: "top right", "the left
 * side", "bottom", "the middle". `current` fills in what wasn't said ("move
 * the clock to the right" keeps it at the top).
 * @param {string} text
 * @param {string} [current] The module's current region.
 * @returns {string|null}
 */
function parsePosition(text, current = "") {
  const t = normalize(text).replace(/\bcentre\b/g, "center");
  const [curV, curH] = String(current).split("_");
  let v = /\b(?:top|upper|up)\b/.test(t) ? "top" : /\b(?:bottom|lower|down)\b/.test(t) ? "bottom" : /\b(?:middle|center|centre)\b/.test(t) && !/\b(?:left|right)\b/.test(t) ? "middle" : null;
  let h = /\bleft\b/.test(t) ? "left" : /\bright\b/.test(t) ? "right" : /\b(?:center|middle)\b/.test(t) ? "center" : null;
  if (/\btop bar\b/.test(t)) return "top_bar";
  if (/\bbottom bar\b/.test(t)) return "bottom_bar";
  if (/\bupper third\b/.test(t)) return "upper_third";
  if (/\blower third\b/.test(t)) return "lower_third";
  if (!v && !h) return null;
  if (v === "middle") return "middle_center";
  if (!v) v = ["top", "bottom"].includes(curV) ? curV : "top";
  if (!h) h = ["left", "center", "right"].includes(curH) ? curH : "center";
  return `${v}_${h}`;
}

Screen.SELF = SELF;
Screen.REGIONS = REGIONS;
Screen.parsePosition = parsePosition;
Screen.sceneKey = sceneKey;
module.exports = Screen;
