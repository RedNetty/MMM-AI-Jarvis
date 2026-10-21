"use strict";

const Screen = require("./Screen");
const Talk = require("./speech/talk");
const { normalize } = require("./text");

// Words that mean the whole mirror rather than one module.
const EVERYTHING = /^(?:everything|all|it all|the whole (?:mirror|screen|thing)|the text|text|the font|font|the writing|writing|all the text|the mirror|the screen|things)$/;
// How each region is said, with the preposition that goes with it ("in the top left", "at the top").
const PLACES = {
  top_left: ["in", "the top left"], top_center: ["at", "the top"], top_right: ["in", "the top right"], top_bar: ["in", "the top bar"],
  upper_third: ["in", "the upper third"], middle_center: ["in", "the middle"], lower_third: ["in", "the lower third"],
  bottom_left: ["in", "the bottom left"], bottom_center: ["at", "the bottom"], bottom_right: ["in", "the bottom right"], bottom_bar: ["in", "the bottom bar"],
};
/** "the top left" */
const placeName = (position) => PLACES[position]?.[1] ?? String(position).replace(/_/g, " ");
/** "in the top left", "at the top" */
const atPlace = (position) => (PLACES[position] ? PLACES[position].join(" ") : `in ${placeName(position)}`);

/**
 * Control of the whole mirror's layout by voice: move and resize any
 * module, text size, brightness, screen on/off, night mode, "where is…",
 * named layouts, reset and reload. Replies are short and say what changed.
 */
class DisplaySkills {
  /**
   * @param {{ screen: Screen }} deps
   */
  constructor({ screen }) {
    this.screen = screen;
  }

  /**
   * "Move the clock to the top right", "put the weather on the left".
   * @param {string} target
   * @param {string} where
   */
  move(target, where) {
    const modules = this._find(target);
    if (!modules.length) return this._notFound(target);
    const position = Screen.parsePosition(where, this.screen.positionOf(modules[0]));
    if (!position) return { spoken: `Where should I put ${this._name(target)}? Say something like the top right.` };
    this.screen.move(modules, position);
    if (this._isSelf(modules)) return { spoken: `Okay, I'm ${atPlace(position)} now.` };
    return {
      spoken: Talk.pick([`Done. ${capitalize(this._name(target))} ${this._is(target)} ${atPlace(position)} now.`, `Moved ${this._name(target)} to ${placeName(position)}.`]),
    };
  }

  /**
   * "Make the clock bigger", "shrink the news", "make everything bigger".
   * @param {string} target
   * @param {"bigger"|"smaller"|"reset"|number} change
   */
  resize(target, change) {
    const t = normalize(target).replace(/^(?:the|my)\s+/, "");
    if (EVERYTHING.test(t) || EVERYTHING.test(`the ${t}`)) {
      const f = this.screen.setFontScale(change);
      return { spoken: change === "reset" || f === 1 ? "Text is back to normal size." : `${change === "smaller" ? "Smaller" : "Bigger"} text everywhere. ${f > 1 ? `That's ${Math.round(f * 100)}%.` : ""}`.trim() };
    }
    const modules = this._find(target);
    if (!modules.length) return this._notFound(target);
    const f = this.screen.scale(modules, change);
    if (f === 1) {
      if (this._isSelf(modules)) return { spoken: "I'm back to normal size." };
      const plural = this._is(target) === "are";
      return { spoken: `${capitalize(this._name(target))} ${plural ? "are" : "is"} back to ${plural ? "their" : "its"} normal size.` };
    }
    const limit = f >= 2.5 ? " That's as big as it goes." : f <= 0.5 ? " That's as small as it goes." : "";
    return { spoken: `${Talk.pick(["Done.", "There you go."])}${limit}` };
  }

  /**
   * "Dim the mirror", "brighter", "brightness 50 percent".
   * @param {"dimmer"|"brighter"|number} change
   */
  brightness(change) {
    const level = this.screen.setBrightness(change);
    if (level >= 1) return { spoken: "Full brightness." };
    return { spoken: `${change === "brighter" ? "Brighter" : "Dimmed"}, ${Math.round(level * 100)}%.` };
  }

  /** "Turn the screen off" / "wake up". */
  power(on) {
    if (on) return { spoken: this.screen.wake() ? Talk.pick(["I'm back.", "Screen's on."]) : "The screen's already on." };
    this.screen.sleep();
    return { spoken: Talk.pick(["Going dark. Say my name to wake me.", "Screen off. I'm still listening."]) };
  }

  /** "Night mode" / "day mode". */
  nightMode(on) {
    this.screen.setMode(on ? "night" : "normal");
    if (on) this.screen.setBrightness(Math.min(this.screen.layout.brightness || 1, 0.6));
    else if (this.screen.layout.brightness < 1 && this.screen.layout.brightness > 0) this.screen.setBrightness(1);
    return { spoken: on ? "Night mode. Dim and warm." : "Back to normal." };
  }

  /** "Where's the calendar?" */
  whereIs(target) {
    const modules = this._find(target);
    if (!modules.length) return this._notFound(target);
    this.screen.highlight(modules);
    const place = atPlace(this.screen.positionOf(modules[0]));
    if (this._isSelf(modules)) return { spoken: `I'm ${place}.` };
    const plural = this._is(target) === "are";
    const hidden = modules[0].hidden ? ` ${plural ? "They're" : "It's"} hidden right now; say show ${plural ? "them" : "it"} to bring ${plural ? "them" : "it"} back.` : "";
    return { spoken: `${capitalize(this._name(target))} ${plural ? "are" : "is"} ${place}.${hidden}` };
  }

  /** "Save this layout as morning". */
  saveScene(name) {
    const key = this.screen.saveScene(name || "my layout");
    return { spoken: `Saved this layout as ${key}. Say switch to ${key} any time.` };
  }

  /** "Switch to my morning layout". */
  loadScene(name) {
    const key = this.screen.loadScene(name);
    if (key) return { spoken: Talk.pick([`Here's ${key}.`, `Switched to ${key}.`]) };
    const saved = this.screen.listScenes();
    return {
      spoken: saved.length
        ? `I don't have a layout called ${Screen.sceneKey(name) || name}. I have ${Talk.list(saved)}.`
        : "You haven't saved any layouts yet. Arrange the mirror, then say save this layout as, and a name.",
    };
  }

  /** "Reset the layout": config positions, normal size and brightness, everything shown. */
  reset() {
    this.screen.resetLayout();
    return { spoken: "Everything's back where it started." };
  }

  reload() {
    this.screen.reload();
    return { spoken: "Refreshing the mirror." };
  }

  /** What's on the mirror, for "what's on the screen?" */
  describe() {
    const visible = this.screen.modules.filter((m) => !m.hidden);
    const names = [...new Set(visible.map((m) => friendly(m)))];
    return { spoken: names.length ? `On the mirror right now: ${Talk.list(names)}.` : "Just me right now.", data: { modules: this.screen.describe() } };
  }

  _isSelf(modules) {
    return modules.length === 1 && modules[0].name === Screen.SELF;
  }

  _find(target) {
    return this.screen.find(target);
  }

  _name(target) {
    const t = String(target ?? "").trim().replace(/^(?:my|the)\s+/i, "");
    if (/^(?:you|yourself)$/i.test(t)) return "me";
    return `the ${t}`;
  }

  /** "is" or "are": "the compliments are", "the news is", "the clock is". */
  _is(target) {
    const last = String(target ?? "").trim().toLowerCase().split(/\s+/).pop() ?? "";
    return /[^su]s$/.test(last) && !/(?:news|headlines? news|series|status|always)$/.test(last) ? "are" : "is";
  }

  _notFound(target) {
    return { spoken: `I can't find ${this._name(target)} on the mirror.` };
  }
}

function friendly(m) {
  const name = m.header || m.name.replace(/^MMM-/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ");
  return name.toLowerCase() === "newsfeed" ? "the news" : `the ${name.toLowerCase()}`;
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

module.exports = DisplaySkills;
