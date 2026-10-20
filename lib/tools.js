"use strict";

const Wardrobe = require("./Wardrobe");

/**
 * Tool (function-calling) definitions exposed to the LLM, and their dispatch
 * to Skills.
 *
 * Every tool definition is part of the prompt the model has to read, and on
 * a Raspberry Pi reading the prompt is the slowest step. Two things keep it
 * small:
 *  - compact, multi-action tools (≈ a third of the size of one tool per action);
 *    the deterministic fast intents in intents.js call finer-grained skills;
 *  - per-request selection: each tool lists the words that suggest it is
 *    needed, and a request only carries the tools its words point to
 *    ("set a timer" → just the timer tool). A plain question gets none.
 *
 * Hybrid models such as qwen3.5 can't reuse a cached prompt after it branches,
 * so a short prompt matters more than a stable one.
 */

const CLOTHES = "wear|wearing|wore|outfit|clothes|clothing|wardrobe|closet|dress|shirt|t-?shirt|top|jacket|coat|hoodie|sweater|jumper|jeans|trousers|pants|shorts|skirt|shoes|boots|sneakers|trainers|hat|cap|scarf|style";
const hints = (words) => new RegExp(`\\b(?:${words})\\b`, "i");

const fn = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

const DEFINITIONS = {
  look_at_user: {
    hints: hints(`look|looking|see me|camera|match|matches|suit me|wearing`),
    needs: "vision",
    def: fn("look_at_user", "See the user through the mirror camera and answer about their look or clothes.", { question: { type: "string" } }, ["question"]),
  },
  scan_clothing: {
    hints: hints(`add|scan|save|catalog(?:ue)?|wardrobe|closet`),
    needs: "vision",
    def: fn("scan_clothing", "Photograph clothes the user holds up and add them to their wardrobe.", { hint: { type: "string" } }),
  },
  suggest_outfit: {
    hints: hints(`${CLOTHES}|weather|cold|warm|rain|occasion|interview|date|wedding|party`),
    def: fn("suggest_outfit", "Pick an outfit from the user's wardrobe for the weather and show it.", {
      request: { type: "string", description: "occasion or constraint" },
    }),
  },
  wardrobe: {
    hints: hints(`${CLOTHES}|own|have any|add|remove|delete`),
    def: fn(
      "wardrobe",
      "Manage the user's clothes: find, add (by description), remove, wore (log today's outfit; no item = last suggestion), history.",
      {
        action: { type: "string", enum: ["find", "add", "remove", "wore", "history"] },
        item: { type: "string", description: "item name or description" },
        category: { type: "string", enum: Wardrobe.CATEGORIES },
        color: { type: "string" },
      },
      ["action"],
    ),
  },
  show_score: {
    hints: hints(`score|scores|game|games|match|won|win|lose|lost|beat|play|playing|plays|fixture|team|league|cup|final|nfl|nba|mlb|nhl|premier|soccer|football|basketball|baseball|hockey`),
    needs: "sports",
    def: fn("show_score", "Show a live scoreboard for a sports team's current or next game.", { team: { type: "string" } }, ["team"]),
  },
  show_on_mirror: {
    hints: hints(`show|display|screen|mirror|list|steps|recipe|put up|pull up|write|panel|checklist|plan`),
    def: fn(
      "show_on_mirror",
      "Display a panel of text on the mirror (lists, steps, key facts).",
      { title: { type: "string" }, lines: { type: "array", items: { type: "string" } } },
      ["title", "lines"],
    ),
  },
  mirror: {
    hints: hints(`hide|show|close|dismiss|focus|restore|bring back|unhide|module|calendar|clock|news|newsfeed|compliments|screen|mirror|clear`),
    def: fn(
      "mirror",
      "Control the mirror screen: hide or show a module or card (e.g. news, calendar, score), focus (hide all others), restore (show all).",
      {
        action: { type: "string", enum: ["hide", "show", "focus", "restore"] },
        target: { type: "string" },
      },
      ["action"],
    ),
  },
  timer: {
    hints: hints(`timer|timers|countdown|remind|reminder|alarm|minutes?|seconds?|hours?|time left`),
    def: fn(
      "timer",
      "Set, cancel or check countdown timers shown on the mirror.",
      {
        action: { type: "string", enum: ["set", "cancel", "status"] },
        seconds: { type: "integer" },
        label: { type: "string" },
      },
      ["action"],
    ),
  },
  memory: {
    hints: hints(`remember|forget|my name|i like|i love|i hate|don'?t like|prefer|allergic|favou?rite|never|always`),
    def: fn(
      "memory",
      "Remember or forget a lasting fact or preference about the user.",
      { action: { type: "string", enum: ["remember", "forget"] }, fact: { type: "string" } },
      ["action", "fact"],
    ),
  },
  get_weather: {
    hints: hints(`weather|rain|raining|snow|temperature|forecast|cold|hot|warm|sunny|umbrella|wind|windy|degrees|outside|tomorrow`),
    def: fn("get_weather", "Current weather and forecast.", { day: { type: "string", enum: ["today", "tomorrow"] } }),
  },
  web_search: {
    hints: hints(`search|news|latest|today'?s|tonight|current|currently|price|open now|who is|what happened|look up`),
    needs: "search",
    def: fn("web_search", "Search the web for current information.", { query: { type: "string" } }, ["query"]),
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
 * @param {string} [query] When given, only tools whose hint words appear in it.
 * @param {string[]} [alsoInclude] Tool names to keep regardless (follow-ups).
 */
function availableTools(skills, query, alsoInclude = []) {
  return Object.entries(DEFINITIONS)
    .filter(([, { needs }]) => !needs || READY[needs](skills))
    .filter(([name, { hints: h }]) => query === undefined || h.test(query) || alsoInclude.includes(name))
    .map(([, { def }]) => def);
}

/**
 * Execute a tool call (LLM tool names) or a fast intent (skill names).
 * @param {import("./Skills")} skills
 * @param {string} name
 * @param {object} args
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ spoken: string, data?: object }>}
 */
async function runTool(skills, name, args = {}, signal) {
  switch (name) {
    // ── LLM tools ──
    case "look_at_user":
      return skills.lookAtUser(args.question, signal);
    case "scan_clothing":
      return skills.scanClothing(args.hint, signal);
    case "suggest_outfit":
      return skills.suggestOutfit(args.request, signal);
    case "wardrobe":
      return wardrobeAction(skills, args);
    case "show_score":
      return skills.showScore(args.team, signal);
    case "show_on_mirror":
      return skills.showInfo({ title: args.title, subtitle: args.subtitle, lines: toList(args.lines, "\n") });
    case "mirror":
      return mirrorAction(skills, args);
    case "timer":
      return timerAction(skills, args);
    case "memory":
      return args.action === "forget" ? skills.forget(args.fact) : skills.remember(args.fact);
    case "get_weather":
      return skills.getWeather(args.day);
    case "web_search":
      return skills.webSearch(args.query, signal);

    // ── Fast intents ──
    case "weather_answer":
      return skills.weatherAnswer(args.question);
    case "log_outfit_worn":
      return skills.logOutfitWorn(toList(args.item_ids), args.occasion);
    case "compose_panel":
      return skills.composePanel(args.request, signal);
    case "hide_on_mirror":
      return skills.hideOnScreen(args.target);
    case "show_module":
      return skills.showOnScreen(args.target);
    case "focus_mode":
      return skills.focusMode();
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
    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}

function wardrobeAction(skills, { action, item, category, color }) {
  switch (action) {
    case "add":
      if (!item) return { spoken: "What should I call that item?" };
      return skills.addItem({ name: item, category: category ?? Wardrobe.guessCategory(item), colors: color ? [color] : [] });
    case "remove":
      return skills.removeItem(item);
    case "wore":
      return skills.logOutfitWorn(toList(item));
    case "history":
      return skills.outfitHistory(7);
    case "find":
    default:
      return skills.findItems({ query: item, category, color });
  }
}

function mirrorAction(skills, { action, target }) {
  switch (action) {
    case "show":
      return skills.showOnScreen(target);
    case "focus":
      return skills.focusMode();
    case "restore":
      return skills.restoreScreen();
    case "hide":
    default:
      return skills.hideOnScreen(target);
  }
}

function timerAction(skills, { action, seconds, label }) {
  switch (action) {
    case "cancel":
      return skills.cancelTimer(label);
    case "status":
      return skills.timeLeft();
    case "set":
    default:
      return skills.setTimer(seconds, label);
  }
}

function toList(v, separator = ",") {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim()) return v.split(separator).map((s) => s.trim()).filter(Boolean);
  return [];
}

module.exports = { availableTools, runTool, TOOL_NAMES: Object.keys(DEFINITIONS) };
