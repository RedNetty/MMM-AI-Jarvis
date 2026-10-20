"use strict";

const Wardrobe = require("./Wardrobe");

/**
 * Tool (function-calling) definitions exposed to the LLM, and their dispatch
 * to Skills. Only tools whose dependencies are available are offered, so the
 * model never tries to use a camera or feed that isn't there.
 */

const fn = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

const ITEM_FIELDS = {
  name: { type: "string", description: "Short descriptive name, e.g. 'grey wool overcoat'" },
  category: { type: "string", enum: Wardrobe.CATEGORIES },
  colors: { type: "array", items: { type: "string" } },
  pattern: { type: "string" },
  material: { type: "string" },
  formality: { type: "string", enum: Wardrobe.FORMALITY },
  seasons: { type: "array", items: { type: "string", enum: Wardrobe.SEASONS } },
  warmth: { type: "integer", description: "1 (very light) to 5 (very warm)" },
  notes: { type: "string" },
};

const DEFINITIONS = {
  // ── Vision & wardrobe ─────────────────────────────────────────────────
  look_at_user: {
    needs: "vision",
    def: fn(
      "look_at_user",
      "Take a photo with the mirror camera and look at the user. Use for 'how do I look', 'what am I wearing', 'does this match', or anything that needs seeing them.",
      { question: { type: "string", description: "What to look for or answer, in the user's words" } },
      ["question"],
    ),
  },
  scan_clothing: {
    needs: "vision",
    def: fn(
      "scan_clothing",
      "Photograph clothing the user is holding up or wearing and add it to their wardrobe.",
      { hint: { type: "string", description: "Anything the user said about the item(s)" } },
    ),
  },
  suggest_outfit: {
    def: fn(
      "suggest_outfit",
      "Choose an outfit from the user's wardrobe using the weather, recent wear and their preferences, and show it on the mirror. Use for any 'what should I wear' style request, including follow-ups like 'something warmer'.",
      { request: { type: "string", description: "Occasion or constraints, e.g. 'dinner date tonight', 'something warmer'" } },
    ),
  },
  log_outfit_worn: {
    def: fn(
      "log_outfit_worn",
      "Record what the user is wearing today. With no item_ids, logs the most recently suggested outfit.",
      {
        item_ids: { type: "array", items: { type: "string" }, description: "Wardrobe item ids or names" },
        occasion: { type: "string" },
      },
    ),
  },
  outfit_history: {
    def: fn("outfit_history", "List outfits the user wore recently.", {
      days: { type: "integer", description: "How many days back (default 7)" },
    }),
  },
  find_wardrobe_items: {
    def: fn(
      "find_wardrobe_items",
      "Search the user's wardrobe and show matching items on the mirror. Call with no arguments to list everything.",
      {
        query: { type: "string" },
        category: { type: "string", enum: Wardrobe.CATEGORIES },
        color: { type: "string" },
      },
    ),
  },
  add_wardrobe_item: {
    def: fn("add_wardrobe_item", "Add a clothing item the user describes by voice (no photo).", ITEM_FIELDS, ["name", "category"]),
  },
  update_wardrobe_item: {
    def: fn(
      "update_wardrobe_item",
      "Change details of a wardrobe item.",
      { item: { type: "string", description: "Item id or name" }, ...ITEM_FIELDS },
      ["item"],
    ),
  },
  remove_wardrobe_item: {
    def: fn(
      "remove_wardrobe_item",
      "Remove an item from the wardrobe. Only when the user clearly asks to delete it.",
      { item: { type: "string", description: "Item id or name" } },
      ["item"],
    ),
  },

  // ── Mirror display ────────────────────────────────────────────────────
  show_score: {
    needs: "sports",
    def: fn(
      "show_score",
      "Show a live-updating scoreboard for a sports team's current, latest or next game (NFL, NBA, MLB, NHL, soccer leagues and more).",
      { team: { type: "string", description: "Team name, optionally with league, e.g. 'Arsenal' or 'Lakers'" } },
      ["team"],
    ),
  },
  show_on_mirror: {
    def: fn(
      "show_on_mirror",
      "Display a panel of information on the mirror (a list, steps, key facts, a summary). Use when the user asks to see or show something, or when a short list is clearer on screen than spoken.",
      {
        title: { type: "string" },
        subtitle: { type: "string" },
        lines: { type: "array", items: { type: "string" }, description: "Up to 12 short lines" },
      },
      ["title", "lines"],
    ),
  },
  hide_on_mirror: {
    def: fn(
      "hide_on_mirror",
      "Hide something on the mirror: one of your cards (score, timer, outfit, panel) or another module such as the news, calendar, weather or clock. Use 'everything' to clear your cards.",
      { target: { type: "string", description: "What to hide, in the user's words" } },
      ["target"],
    ),
  },
  show_module: {
    def: fn(
      "show_module",
      "Show a mirror module that is hidden (e.g. 'the calendar'), or 'everything' to restore all hidden modules.",
      { target: { type: "string" } },
      ["target"],
    ),
  },
  focus_mode: {
    def: fn("focus_mode", "Hide every other module on the mirror so only you are visible."),
  },
  list_mirror: {
    def: fn("list_mirror", "List the modules and cards currently on the mirror and whether they are visible."),
  },

  // ── Timers ────────────────────────────────────────────────────────────
  set_timer: {
    def: fn(
      "set_timer",
      "Start a countdown timer shown on the mirror; you will announce when it finishes.",
      {
        seconds: { type: "integer", description: "Duration in seconds" },
        label: { type: "string", description: "Optional name, e.g. 'pasta'" },
      },
      ["seconds"],
    ),
  },
  cancel_timer: {
    def: fn("cancel_timer", "Cancel a running timer (all timers if no label).", { label: { type: "string" } }),
  },
  timer_status: {
    def: fn("timer_status", "Say how much time is left on running timers."),
  },

  // ── Memory, weather, web ──────────────────────────────────────────────
  remember: {
    def: fn(
      "remember",
      "Save a lasting fact or preference about the user (e.g. 'dislikes yellow', 'office is business casual', 'supports Arsenal').",
      { fact: { type: "string", description: "The fact, written in third person" } },
      ["fact"],
    ),
  },
  forget: {
    def: fn("forget", "Delete a remembered fact.", { fact: { type: "string", description: "Description of what to forget" } }, ["fact"]),
  },
  get_weather: {
    def: fn("get_weather", "Get the current weather and forecast.", {
      day: { type: "string", enum: ["today", "tomorrow"] },
    }),
  },
  web_search: {
    needs: "search",
    def: fn(
      "web_search",
      "Search the web for current information (news, opening hours, facts that may have changed).",
      { query: { type: "string" } },
      ["query"],
    ),
  },
};

const READY = {
  vision: (s) => s.visionReady,
  search: (s) => s.searchReady,
  sports: (s) => s.sportsReady,
};

/**
 * Tool definitions available given the current capabilities.
 * @param {import("./Skills")} skills
 */
function availableTools(skills) {
  return Object.values(DEFINITIONS)
    .filter(({ needs }) => !needs || READY[needs](skills))
    .map(({ def }) => def);
}

/**
 * Execute a tool call.
 * @param {import("./Skills")} skills
 * @param {string} name
 * @param {object} args
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ spoken: string, data?: object }>}
 */
async function runTool(skills, name, args = {}, signal) {
  switch (name) {
    case "look_at_user":
      return skills.lookAtUser(args.question, signal);
    case "scan_clothing":
      return skills.scanClothing(args.hint, signal);
    case "suggest_outfit":
      return skills.suggestOutfit(args.request, signal);
    case "log_outfit_worn":
      return skills.logOutfitWorn(toList(args.item_ids), args.occasion);
    case "outfit_history":
      return skills.outfitHistory(Number(args.days) || 7);
    case "find_wardrobe_items":
      return skills.findItems({ query: args.query, category: args.category, color: args.color });
    case "add_wardrobe_item":
      return skills.addItem(args);
    case "update_wardrobe_item": {
      const { item, ...changes } = args;
      return skills.updateItem(item, changes);
    }
    case "remove_wardrobe_item":
      return skills.removeItem(args.item);
    case "show_score":
      return skills.showScore(args.team, signal);
    case "compose_panel":
      return skills.composePanel(args.request, signal);
    case "show_on_mirror":
      return skills.showInfo({ title: args.title, subtitle: args.subtitle, lines: toList(args.lines, "\n") });
    case "hide_on_mirror":
      return skills.hideOnScreen(args.target);
    case "show_module":
      return skills.showOnScreen(args.target);
    case "focus_mode":
      return skills.focusMode();
    case "list_mirror":
      return skills.listScreen();
    case "set_timer":
      return skills.setTimer(args.seconds, args.label);
    case "cancel_timer":
      return skills.cancelTimer(args.label);
    case "timer_status":
      return skills.timeLeft();
    case "remember":
      return skills.remember(args.fact);
    case "forget":
      return skills.forget(args.fact);
    case "get_weather":
      return skills.getWeather(args.day);
    case "web_search":
      return skills.webSearch(args.query, signal);
    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}

function toList(v, separator = ",") {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim()) return v.split(separator).map((s) => s.trim()).filter(Boolean);
  return [];
}

module.exports = { availableTools, runTool, TOOL_NAMES: Object.keys(DEFINITIONS) };
