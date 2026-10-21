/* MagicMirror² Module: MMM-AI-Jarvis – display director
 *
 * Lets IRIS rearrange the whole mirror, not just its own cards: move any
 * module to another region, resize it, dim or switch off the screen, night
 * mode, bigger text everywhere, point out where something is, and apply a
 * saved layout. Every change animates (FLIP for moves, cross-fades for
 * size, slow fades for brightness), and the node helper keeps the layout
 * so it survives a restart.
 *
 * Hiding and showing modules still goes through MagicMirror's own
 * hide()/show() with a lockString (see MMM-AI-Jarvis.js), so other modules
 * that hide things (MMM-pages…) are respected.
 */
/* global window, document, requestAnimationFrame */
(function () {
  "use strict";

  const REGIONS = [
    "top_bar", "top_left", "top_center", "top_right", "upper_third", "middle_center",
    "lower_third", "bottom_left", "bottom_center", "bottom_right", "bottom_bar",
    "fullscreen_above", "fullscreen_below",
  ];
  const BASE_FONT_PX = 20;

  function container(position) {
    if (!REGIONS.includes(position)) return null;
    return document.querySelector(`.region.${position.split("_").join(".")} > .container`);
  }

  /** MagicMirror hides empty region containers; keep that true after moves. */
  function refreshContainers() {
    for (const position of REGIONS) {
      const c = container(position);
      if (!c) continue;
      const visible = [...c.children].some((child) => child.classList?.contains("module") && child.style.display !== "none" && !child.classList.contains("hidden"));
      if (visible) c.style.display = "block";
      else if ([...c.children].every((child) => !child.classList?.contains("module"))) c.style.display = "none";
    }
  }

  function overlay() {
    let el = document.getElementById("iris-dimmer");
    if (!el) {
      el = document.createElement("div");
      el.id = "iris-dimmer";
      document.body.appendChild(el);
    }
    return el;
  }

  class Director {
    constructor() {
      /** Where each moved module came from, to undo moves. */
      this.homes = new Map();
      this.state = { moves: {}, scales: {}, brightness: 1, fontScale: 1, mode: "normal" };
    }

    /**
     * Run one operation. Returns the new state (for the node helper to keep).
     * @param {string} op
     * @param {object} args
     */
    run(op, args = {}) {
      switch (op) {
        case "move":
          for (const id of args.ids ?? []) this.move(id, args.position);
          break;
        case "scale":
          for (const id of args.ids ?? []) this.scale(id, args.factor);
          break;
        case "brightness":
          this.brightness(args.level);
          break;
        case "fontScale":
          this.fontScale(args.factor);
          break;
        case "mode":
          this.mode(args.mode);
          break;
        case "highlight":
          for (const id of args.ids ?? []) this.highlight(id);
          break;
        case "apply":
          this.apply(args.state ?? {});
          break;
        case "reset":
          this.reset();
          break;
        case "reload":
          setTimeout(() => window.location.reload(), 600);
          break;
        default:
          break;
      }
      return this.snapshot();
    }

    snapshot() {
      return JSON.parse(JSON.stringify(this.state));
    }

    /** Re-apply a whole layout (on start, or a saved scene). */
    apply(state) {
      // Undo current moves that the new layout doesn't keep.
      for (const id of Object.keys(this.state.moves)) if (!state.moves?.[id]) this.unmove(id);
      for (const [id, position] of Object.entries(state.moves ?? {})) this.move(id, position, { animate: false });
      for (const id of Object.keys(this.state.scales)) if (!state.scales?.[id]) this.scale(id, 1);
      for (const [id, factor] of Object.entries(state.scales ?? {})) this.scale(id, factor);
      this.brightness(state.brightness ?? 1);
      this.fontScale(state.fontScale ?? 1);
      this.mode(state.mode ?? "normal");
    }

    reset() {
      this.apply({ moves: {}, scales: {}, brightness: 1, fontScale: 1, mode: "normal" });
    }

    // ─── Moving ────────────────────────────────────────────────────────

    /**
     * Move a module into another region, animated with FLIP so it glides
     * from where it was to where it lands.
     */
    move(id, position, { animate = true } = {}) {
      const wrapper = document.getElementById(id);
      const target = container(position);
      if (!wrapper || !target || wrapper.parentElement === target) {
        if (wrapper && target) this.state.moves[id] = position;
        return;
      }
      if (!this.homes.has(id)) this.homes.set(id, { parent: wrapper.parentElement, next: wrapper.nextSibling });
      const first = wrapper.getBoundingClientRect();
      target.style.display = "block";
      target.appendChild(wrapper);
      refreshContainers();
      this.state.moves[id] = position;
      if (!animate) return;
      const last = wrapper.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      wrapper.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.6 },
          { transform: "translate(0, 0)", opacity: 1 },
        ],
        { duration: 750, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }

    /** Put a moved module back where its config placed it. */
    unmove(id) {
      const home = this.homes.get(id);
      const wrapper = document.getElementById(id);
      delete this.state.moves[id];
      if (!home || !wrapper) return;
      home.parent.insertBefore(wrapper, home.next && home.next.parentElement === home.parent ? home.next : null);
      home.parent.style.display = "block";
      this.homes.delete(id);
      refreshContainers();
    }

    // ─── Size ──────────────────────────────────────────────────────────

    /** Resize one module (zoom keeps the layout honest), with a smooth settle. */
    scale(id, factor) {
      const wrapper = document.getElementById(id);
      if (!wrapper) return;
      const f = Math.max(0.5, Math.min(2.5, Number(factor) || 1));
      const before = Number(wrapper.style.zoom || 1);
      wrapper.style.zoom = f === 1 ? "" : String(f);
      if (f === 1) delete this.state.scales[id];
      else this.state.scales[id] = f;
      if (before !== f) {
        wrapper.animate([{ transform: `scale(${before / f})`, opacity: 0.7 }, { transform: "scale(1)", opacity: 1 }], {
          duration: 600,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        });
      }
    }

    /** Bigger or smaller text across every module (MagicMirror sizes everything from --font-size). */
    fontScale(factor) {
      const f = Math.max(0.7, Math.min(1.8, Number(factor) || 1));
      this.state.fontScale = f;
      document.documentElement.style.setProperty("--font-size", `${Math.round(BASE_FONT_PX * f)}px`);
    }

    // ─── Light ─────────────────────────────────────────────────────────

    /** 0 = screen off (black), 1 = full brightness. A black overlay fades over everything. */
    brightness(level) {
      const l = Math.max(0, Math.min(1, Number(level)));
      this.state.brightness = l;
      const el = overlay();
      el.classList.toggle("is-off", l === 0);
      el.style.opacity = String(1 - l);
    }

    /** "night": dim and warm; "normal": as configured. */
    mode(name) {
      const night = name === "night";
      this.state.mode = night ? "night" : "normal";
      document.body.classList.toggle("iris-night", night);
    }

    // ─── Pointing ──────────────────────────────────────────────────────

    /** "Where's the calendar?" – a soft ring pulses around it for a few seconds. */
    highlight(id) {
      const wrapper = document.getElementById(id);
      if (!wrapper) return;
      wrapper.classList.remove("iris-highlight");
      void wrapper.offsetWidth;
      wrapper.classList.add("iris-highlight");
      setTimeout(() => wrapper.classList.remove("iris-highlight"), 4200);
    }
  }

  window.IrisDirector = new Director();
  window.IrisDirector.REGIONS = REGIONS;
})();
