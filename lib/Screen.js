"use strict";

const { EventEmitter } = require("events");
const { normalize } = require("./text");

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

/**
 * Knows what is on the mirror and asks the front-end to show or hide modules.
 *
 * The front-end reports its module inventory; commands are emitted as
 * "command" events ({ action, ids }) which node_helper relays to the browser,
 * where MagicMirror's own hide()/show() is called with Jarvis' lockString –
 * so Jarvis never un-hides something another module (e.g. MMM-pages) hid.
 *
 * Events: "command" ({ action: "hide" | "show" | "restore", ids?: string[] })
 *         "notify"  ({ notification: string, payload: any })
 */
class Screen extends EventEmitter {
  constructor() {
    super();
    /** @type {{ id: string, name: string, header: string, position: string, hidden: boolean }[]} */
    this.modules = [];
  }

  /**
   * @param {object[]} inventory From the front-end.
   */
  setInventory(inventory) {
    if (!Array.isArray(inventory)) return;
    this.modules = inventory
      .filter((m) => m && m.id && m.name !== SELF)
      .map((m) => ({
        id: String(m.id),
        name: String(m.name),
        header: String(m.header ?? ""),
        position: String(m.position ?? ""),
        hidden: Boolean(m.hidden),
      }));
  }

  /**
   * Modules matching a spoken description ("the news", "calendar", "top left").
   * @param {string} query
   */
  find(query) {
    const q = normalize(query)
      .replace(/\b(the|my|module|modules|widget|panel|section|thing|on the screen|screen|please)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!q) return [];

    const wanted = new Set([q, ...(ALIASES[q] ?? [])]);
    return this.modules.filter((m) => {
      const name = normalize(m.name.replace(/^MMM-/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " "));
      const header = normalize(m.header);
      const position = normalize(m.position.replace(/_/g, " "));
      const hay = ` ${name} ${name.replace(/\s/g, "")} ${header} ${position} `;
      return [...wanted].some((w) => hay.includes(` ${w} `) || hay.includes(` ${w}`) || (w.length > 3 && hay.includes(w)));
    });
  }

  hide(modules) {
    const ids = modules.map((m) => m.id);
    if (ids.length) this.emit("command", { action: "hide", ids });
    return ids.length;
  }

  show(modules) {
    const ids = modules.map((m) => m.id);
    if (ids.length) this.emit("command", { action: "show", ids });
    return ids.length;
  }

  /** Hide every other module so only Jarvis is visible. */
  focus() {
    return this.hide(this.modules.filter((m) => !m.hidden));
  }

  /** Show everything Jarvis hid. */
  restore() {
    this.emit("command", { action: "restore" });
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
      position: m.position.replace(/_/g, " "),
      visible: !m.hidden,
    }));
  }
}

Screen.SELF = SELF;
module.exports = Screen;
