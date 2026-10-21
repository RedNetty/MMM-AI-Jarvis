"use strict";

const fs = require("fs");
const path = require("path");
const Weather = require("./Weather");
const Wardrobe = require("./Wardrobe");
const OutfitPlanner = require("./OutfitPlanner");
const Clock = require("./Clock");
const Sports = require("./Sports");
const Talk = require("./speech/talk");
const WeatherTalk = require("./speech/weatherTalk");
const { cleanForSpeech, normalize } = require("./text");
const log = require("./log");

const MAX_PROMPT_ITEMS = 120;
const LIVE_REFRESH_MS = 20 * 1000;
const BOARD_REFRESH_MS = 30 * 1000;
const MAX_BOARD_GAMES = 8;
const PRE_GAME_MAX_REFRESH_MS = 10 * 60 * 1000;
const POST_GAME_LINGER_MS = 20 * 60 * 1000;
const MAX_TIMER_SECONDS = 24 * 3600;

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    category: { type: "string", enum: Wardrobe.CATEGORIES },
    colors: { type: "array", items: { type: "string" } },
    formality: { type: "string", enum: Wardrobe.FORMALITY },
    warmth: { type: "integer", minimum: 1, maximum: 5 },
    bbox_2d: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
  },
  required: ["name", "category", "colors", "formality", "warmth", "bbox_2d"],
};

// Four items fit comfortably in the output budget, even for small models.
const MAX_SCAN_ITEMS = 4;

const SCAN_SCHEMA = {
  type: "object",
  properties: { items: { type: "array", items: ITEM_SCHEMA, maxItems: MAX_SCAN_ITEMS }, more: { type: "boolean" } },
  required: ["items"],
};

const OUTFIT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    item_ids: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
  required: ["title", "item_ids", "reason"],
};

const PANEL_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    subtitle: { type: "string" },
    lines: { type: "array", items: { type: "string" }, maxItems: 6 },
    spoken: { type: "string" },
  },
  required: ["title", "lines", "spoken"],
};

// Words that refer to the assistant's own widgets rather than other modules.
const WIDGET_WORDS = {
  score: ["score", "scores", "game", "games", "match", "matches", "scoreboard"],
  scoreboard: ["score", "scores", "game", "games", "match", "matches", "scoreboard"],
  timer: ["timer", "timers", "countdown", "alarm"],
  outfit: ["outfit", "outfits", "clothes", "look"],
  items: ["wardrobe", "items", "closet", "clothing"],
  info: ["info", "card", "cards", "panel", "note", "notes", "list", "recipe"],
  snapshot: ["photo", "picture", "snapshot", "camera", "image"],
};
const EVERYTHING = /\b(everything|all|screen|all of it|it all)\b/;

/**
 * The assistant's abilities. Each skill returns
 *   { spoken: string, data?: object }
 * where `spoken` is a ready-to-say reply and `data` is extra detail for the
 * LLM when the skill is used as a tool.
 */
class Skills {
  /**
   * @param {object} deps
   * @param {import("./Ollama")} deps.ollama
   * @param {import("./Wardrobe")} deps.wardrobe
   * @param {import("./Memory")} deps.memory
   * @param {import("./Camera")} deps.camera
   * @param {import("./Weather")} deps.weather
   * @param {import("./WebSearch")|null} deps.search
   * @param {import("./Sports")|null} deps.sports
   * @param {import("./Widgets")} deps.widgets
   * @param {import("./Screen")} deps.screen
   * @param {object} deps.config Module config.
   */
  constructor({ ollama, wardrobe, memory, camera, weather, search, sports, widgets, screen, config }) {
    this.ollama = ollama;
    this.wardrobe = wardrobe;
    this.memory = memory;
    this.camera = camera;
    this.weather = weather;
    this.search = search;
    this.sports = sports;
    this.widgets = widgets;
    this.screen = screen;
    this.config = config;
    this.visionReady = false;
    this.lastSuggestion = null;
    this.clock = new Clock({ locale: config.locale, facts: () => memory.facts.map((f) => f.text) });
    /** Current time; replaceable in tests. */
    this.now = () => new Date();
  }

  /** Called once the vision model's capabilities are known. */
  async init() {
    this.visionReady = this.camera.available && (await this.ollama.supportsVision());
    log.info(
      this.visionReady
        ? `Vision enabled (camera: ${this.camera.tool}, model: ${this.ollama.visionModel}).`
        : "Vision disabled (no camera tool found or the model lacks vision support).",
    );
  }

  get searchReady() {
    return Boolean(this.search);
  }

  get sportsReady() {
    return Boolean(this.sports);
  }

  /** Weather is available from coordinates or the mirror's weather module. */
  get weatherReady() {
    return this.weather.hasCoordinates || Boolean(this.weather.mirror);
  }

  // ─── Vision ────────────────────────────────────────────────────────────

  /**
   * Look at the user through the camera and answer a question about them.
   * @param {string} question
   * @param {AbortSignal} [signal]
   */
  async lookAtUser(question, signal) {
    this._requireVision();
    const photo = await this.camera.capture();
    this._showSnapshot(photo.jpeg, "Taking a look");

    const known = this.wardrobe.items.slice(0, 40).map((i) => `${i.name} (${i.colors.join("/")} ${i.category})`);
    const system =
      `You are ${this.config.assistantName}, a warm, honest personal stylist seeing the user through a smart mirror's camera. ` +
      "Answer in 1-2 short spoken sentences with no lists or markdown: be specific about colours and how the pieces work together, " +
      "add one concrete tip when useful, and never comment on body shape or weight. " +
      "If no person is visible, say so.";
    const prompt =
      `The user asks: "${question || "How do I look?"}"` +
      (known.length ? `\nTheir wardrobe includes: ${known.join("; ")}. Mention an item by name if you clearly recognise it.` : "");

    const answer = await this.ollama.generate({ system, prompt, images: [photo.jpeg], maxTokens: 120, signal });
    return { spoken: cleanForSpeech(answer) || "Sorry, I couldn't get a good look." };
  }

  /**
   * Photograph clothing the user is holding up or wearing and add it to the wardrobe.
   * @param {string} [hint] What the user said about the item(s).
   * @param {AbortSignal} [signal]
   */
  async scanClothing(hint, signal) {
    this._requireVision();
    const photo = await this.camera.capture();
    this._showSnapshot(photo.jpeg, "Scanning clothing");

    const system =
      "You catalogue clothing for a personal wardrobe app. Identify each distinct garment, shoe or accessory that the person " +
      "is holding up to the camera, or wearing if nothing is held up. Ignore furniture and background. " +
      "For each item give: a short name (colour + style + type, e.g. 'navy linen shirt'), category, main colours, formality, " +
      "warmth from 1 (very light) to 5 (very warm), and bbox_2d as [x1, y1, x2, y2] relative coordinates from 0 to 1000. " +
      `List at most ${MAX_SCAN_ITEMS} items, the most prominent first, and set more to true if there are others. JSON only.`;
    const prompt = hint ? `The user said: "${hint}". List the clothing items.` : "List the clothing items.";

    const result = await this.ollama.generate({
      system,
      prompt,
      images: [photo.jpeg],
      schema: SCAN_SCHEMA,
      maxTokens: 450,
      signal,
    });

    const detected = Array.isArray(result?.items) ? result.items.filter((i) => i && i.name).slice(0, MAX_SCAN_ITEMS) : [];
    if (detected.length === 0) {
      return { spoken: "I couldn't make out any clothing. Try holding it up closer to the mirror in good light." };
    }

    const file = await this._savePhoto(photo.jpeg);
    const added = detected.map((d) =>
      this.wardrobe.add({
        ...d,
        name: capitalize(String(d.name).trim()),
        photo: { file, width: photo.width, height: photo.height, box: normalizeBox(d.bbox_2d, photo.width, photo.height) },
      }),
    );

    this._showItems(added.length === 1 ? "Added to your wardrobe" : `Added ${added.length} items`, added, "added");
    const rest = result?.more || result.items.length > added.length ? " Hold up the rest and ask me again to add them too." : "";
    return {
      spoken: `Got it. I've added ${joinNames(added.map((i) => i.name))} to your wardrobe.${rest}`,
      data: { added: added.map((i) => ({ id: i.id, name: i.name, category: i.category })) },
    };
  }

  // ─── Outfits ───────────────────────────────────────────────────────────

  /**
   * Suggest an outfit from the wardrobe, taking weather, recent wear and
   * remembered preferences into account. Shows it on the mirror.
   * @param {string} [request] e.g. "for a job interview" or "something warmer"
   * @param {AbortSignal} [signal]
   */
  async suggestOutfit(request, signal) {
    const now = this.now();
    const weather = await this.weather.get(Weather.parseWhen(request ?? "", now), now);
    const weatherText = Weather.describe(weather);
    const facts = this.memory.describeForPrompt();
    const items = this.wardrobe.items;

    if (items.length === 0) {
      const advice = await this.ollama.generate({
        system: `You are ${this.config.assistantName}, a concise personal stylist. Reply in 2 short spoken sentences, no lists.`,
        prompt:
          `Weather: ${weatherText}\n${facts ? `About the user:\n${facts}\n` : ""}` +
          `Request: ${request || "What should I wear?"}\nGive general clothing advice for this weather.`,
        maxTokens: 200,
        signal,
      });
      return {
        spoken:
          `${cleanForSpeech(advice)} Your wardrobe is empty, by the way. ` +
          "Hold up a piece of clothing and say, add this to my wardrobe.",
      };
    }

    if (this.config.llm.outfitPlanner !== "ai") {
      // Rule-based planner: a few milliseconds instead of a language-model call.
      const plan = OutfitPlanner.plan(items, weather, { request: request ?? "", facts: this.memory.facts.map((f) => f.text) });
      if (!plan) return { spoken: "I couldn't put an outfit together from your wardrobe." };
      return this._presentOutfit(plan.items, plan.title, weather, request, plan.spoken);
    }

    const recent = this.wardrobe
      .recentHistory(7)
      .map((h) => `${h.date}: ${h.items.join(", ")}`)
      .join("\n");

    const system =
      `You are ${this.config.assistantName}, a personal stylist choosing an outfit ONLY from the user's wardrobe list. ` +
      "Pick a complete, coordinated outfit: usually a top + bottom (or a dress) + shoes, adding outerwear when it is cold, " +
      "windy or likely to rain, and an accessory only if it really helps. Match formality to the occasion and warmth to the weather, " +
      "prefer items not worn in the last few days, and respect the user's preferences. " +
      "Return JSON: title (2-5 words), item_ids (ids copied exactly from the list), " +
      "reason (one short sentence, under 15 words, on why it suits the weather or occasion; no ids).";
    const prompt =
      `Date: ${now.toDateString()}\nWeather: ${weatherText}\n` +
      (facts ? `User preferences:\n${facts}\n` : "") +
      (recent ? `Recently worn:\n${recent}\n` : "") +
      `Wardrobe (id | name | category | colours | formality | warmth | last worn):\n` +
      `${this.wardrobe.describeForPrompt(items.slice(0, MAX_PROMPT_ITEMS))}\n\n` +
      `Request: ${request || "What should I wear today?"}`;

    const result = await this.ollama.generate({ system, prompt, schema: OUTFIT_SCHEMA, maxTokens: 160, signal });

    const chosen = [...new Set((result?.item_ids ?? []).map((id) => this.wardrobe.resolve(id)).filter(Boolean))];
    // Small models sometimes name a piece in the reason but leave it out of
    // item_ids. Show everything that is said, so the card matches the voice.
    const reason = cleanForSpeech(result?.reason);
    for (const item of items) {
      if (!chosen.includes(item) && normalize(reason).includes(normalize(item.name))) chosen.push(item);
    }
    if (chosen.length === 0) {
      return { spoken: "I couldn't put an outfit together from your wardrobe this time." };
    }

    const spoken = `How about your ${joinNames(chosen.map((i) => lowerFirst(i.name)))}?${reason ? ` ${capitalize(reason).replace(/([^.!?])$/, "$1.")}` : ""}`;
    return this._presentOutfit(chosen, result.title || "Today's outfit", weather, request, spoken);
  }

  /** Remember the suggestion (for "I'll wear that") and show it on the mirror. */
  _presentOutfit(chosen, title, weather, request, spoken) {
    this.lastSuggestion = { itemIds: chosen.map((i) => i.id), at: Date.now(), occasion: request ?? "" };
    this.widgets.add({
      type: "outfit",
      key: "outfit",
      ttlMs: this.config.display.cardTimeout,
      data: {
        title,
        weather: weather ? weatherBadge(weather) : null,
        items: chosen.map((i) => this.wardrobe.toCard(i)),
      },
    });
    return { spoken, data: { outfit: chosen.map((i) => ({ id: i.id, name: i.name })) } };
  }

  /**
   * Record that an outfit was worn (defaults to the last suggestion).
   * @param {string[]} [itemIds]
   * @param {string} [occasion]
   */
  logOutfitWorn(itemIds, occasion) {
    const ids = itemIds?.length ? itemIds : this.lastSuggestion?.itemIds;
    if (!ids?.length) return { spoken: "Which items are you wearing? I don't have a recent suggestion to log." };

    const items = this.wardrobe.logWorn(ids, { occasion: occasion ?? this.lastSuggestion?.occasion ?? "" });
    return {
      spoken: Talk.pick(["Noted, that's today's outfit.", "Great choice. I've logged it as today's outfit."]),
      data: { logged: items.map((i) => i.id) },
    };
  }

  outfitHistory(days = 7) {
    const history = this.wardrobe.recentHistory(Math.min(Math.max(1, days), 60));
    if (history.length === 0) return { spoken: "I don't have any outfits logged for that period.", data: { history } };
    return { spoken: `I have ${history.length} outfits logged.`, data: { history } };
  }

  // ─── Wardrobe management ───────────────────────────────────────────────

  addItem(fields) {
    const item = this.wardrobe.add(fields);
    this._showItems("Added to your wardrobe", [item], "added");
    return { spoken: `Added ${item.name} to your wardrobe.`, data: { id: item.id, name: item.name } };
  }

  updateItem(idOrName, changes) {
    const item = this.wardrobe.update(idOrName, changes);
    return { spoken: `Updated ${item.name}.`, data: { item: { id: item.id, name: item.name } } };
  }

  removeItem(idOrName) {
    const item = this.wardrobe.remove(idOrName);
    return { spoken: `Removed ${item.name} from your wardrobe.`, data: { removed: item.id } };
  }

  /**
   * Search the wardrobe and show matches on the mirror.
   * @param {{ query?: string, category?: string, color?: string }} filter
   */
  findItems(filter = {}) {
    const items = this.wardrobe.find(filter);
    if (items.length) {
      this._showItems(`${items.length} item${items.length === 1 ? "" : "s"} in your wardrobe`, items.slice(0, 24), "wardrobe");
    }
    return {
      spoken: items.length ? `You have ${items.length} matching item${items.length === 1 ? "" : "s"}.` : "No matching items in your wardrobe.",
      data: { total: this.wardrobe.items.length, matches: items.slice(0, 40).map((i) => ({ id: i.id, name: i.name, category: i.category })) },
    };
  }

  // ─── Sports ────────────────────────────────────────────────────────────

  /**
   * Find a team's game and pin a live-updating scoreboard to the mirror.
   * @param {string} team
   * @param {AbortSignal} [signal]
   */
  async showScore(team, signal) {
    if (!this.sports) return { spoken: "Sports scores are turned off in my settings." };
    // "NBA", "hockey", "" – a league or nothing at all means every game on now.
    if (!this.sports.parseQuery(team ?? "").team) return this.sportsOverview(team, signal);

    const game = await this.sports.findGame(team, signal);
    if (!game) return { spoken: `I couldn't find a game for ${team}.` };

    const sports = this.sports;
    this.widgets.add({
      type: "score",
      key: `score:${game.league.key}:${game.id}`,
      data: game,
      ttlMs: game.state === "post" ? POST_GAME_LINGER_MS : null,
      firstRefreshMs: scoreRefreshDelay(game),
      refresh: async () => {
        const fresh = await sports.getGame(game.league.key, game.id);
        return fresh.state === "post"
          ? { data: fresh, nextMs: null, expireInMs: POST_GAME_LINGER_MS }
          : { data: fresh, nextMs: scoreRefreshDelay(fresh) };
      },
    });

    return { spoken: this.sports.describe(game), data: { game } };
  }

  /**
   * Every game on right now (optionally in the leagues named), pinned to the
   * mirror as a live scoreboard. When nothing is live, says what's next.
   * Answers come straight from the scores feed, so the assistant never has
   * to guess whether anything is on.
   * @param {string} [query] e.g. "what games are on", "NBA scores", "any soccer on"
   * @param {AbortSignal} [signal]
   */
  async sportsOverview(query = "", signal) {
    if (!this.sports) return { spoken: "Sports scores are turned off in my settings." };
    const parsed = this.sports.parseQuery(query);
    if (parsed.team) return this.showScore(query, signal);

    const sports = this.sports;
    const leagueKeys = parsed.leagueKeys;
    const board = await sports.overview(leagueKeys, signal);
    const games = boardGames(board);
    const spoken = sports.describeOverview(board, { leagueKeys: parsed.named ? leagueKeys : [] });

    if (games.length) {
      const title = parsed.named ? leagueKeys.map((k) => Sports.LEAGUES[k].name).join(" · ") : "Scores";
      this.widgets.remove({ type: "score" });
      this.widgets.add({
        type: "scoreboard",
        key: "scoreboard",
        data: { title, live: board.live.length, games },
        ttlMs: board.live.length ? null : this.config.display.cardTimeout,
        firstRefreshMs: board.live.length ? BOARD_REFRESH_MS : null,
        refresh: async () => {
          const fresh = await sports.overview(leagueKeys);
          const list = boardGames(fresh);
          if (fresh.live.length === 0) return { data: { title, live: 0, games: list }, nextMs: null, expireInMs: POST_GAME_LINGER_MS };
          return { data: { title, live: fresh.live.length, games: list }, nextMs: BOARD_REFRESH_MS };
        },
      });
    }
    return {
      spoken,
      data: { live: board.live.length, games: games.slice(0, 4).map((g) => sports.describe(g)) },
    };
  }

  // ─── Timers ────────────────────────────────────────────────────────────

  /**
   * @param {number} seconds
   * @param {string} [label]
   */
  setTimer(seconds, label = "") {
    const secs = Math.round(Number(seconds));
    if (!Number.isFinite(secs) || secs <= 0) return { spoken: "How long should the timer be?" };
    if (secs > MAX_TIMER_SECONDS) return { spoken: "Timers can be at most 24 hours." };

    const name = cleanLabel(label);
    this.widgets.add({
      type: "timer",
      data: { label: name, durationMs: secs * 1000, endsAt: Date.now() + secs * 1000 },
      ttlMs: secs * 1000,
    });
    const length = Talk.duration(secs * 1000);
    const endsAt = new Date(Date.now() + secs * 1000);
    // Long timers also say when they'll go off ("…, that's 7:15").
    const at = secs >= 30 * 60 ? `, that's ${Talk.clock(endsAt, { hour12: !Talk.uses24h(this.config.locale) })}` : "";
    return {
      spoken: name
        ? Talk.pick([`${capitalize(name)} timer, ${length}${at}.`, `Okay, ${length} for the ${name}${at}.`])
        : Talk.pick([`Timer set for ${length}${at}.`, `Okay, ${length}${at}. I'll let you know.`]),
    };
  }

  /**
   * Cancel timers matching a label (or all timers).
   * @param {string} [label]
   */
  cancelTimer(label = "") {
    const name = normalize(cleanLabel(label));
    const removed = this.widgets.remove({
      predicate: (w) => w.type === "timer" && (!name || normalize(w.data.label).includes(name)),
    });
    if (removed.length === 0) return { spoken: name ? `There's no ${name} timer running.` : "There's no timer running." };
    if (removed.length > 1) return { spoken: `Okay, cancelled all ${Talk.count(removed.length)} timers.` };
    const which = removed[0].data.label;
    return { spoken: which ? `Okay, ${which} timer cancelled.` : Talk.pick(["Timer cancelled.", "Okay, cancelled."]) };
  }

  timeLeft() {
    const timers = this.widgets.list("timer");
    if (timers.length === 0) return { spoken: "There's no timer running." };
    const parts = timers.map((t) => {
      const left = Math.max(0, t.data.endsAt - Date.now());
      const amount = left < 60 * 1000 ? `${Math.ceil(left / 1000)} seconds` : Talk.duration(Math.round(left / 1000) * 1000);
      return `${amount} left${t.data.label ? ` on the ${t.data.label}` : ""}`;
    });
    return { spoken: `${timers.length === 1 ? "About " : ""}${joinNames(parts)}.`.replace(/^About (\d+ seconds)/, "Just $1") };
  }

  // ─── Screen ────────────────────────────────────────────────────────────

  /**
   * Show a panel of information on the mirror.
   * @param {{ title: string, subtitle?: string, lines?: string[] }} card
   */
  showInfo({ title, subtitle = "", lines = [] }) {
    const clean = (Array.isArray(lines) ? lines : String(lines).split("\n"))
      .map((l) => cleanForSpeech(l))
      .filter(Boolean)
      .slice(0, 12);
    this.widgets.add({
      type: "info",
      key: `info:${normalize(title)}`,
      ttlMs: this.config.display.infoTimeout,
      data: { title: cleanForSpeech(title).slice(0, 80), subtitle: cleanForSpeech(subtitle).slice(0, 120), lines: clean },
    });
    return { spoken: "It's on the mirror." };
  }

  /**
   * Write a panel for an explicit "put/show … on the mirror" request.
   * Uses structured output rather than free tool choice, because small local
   * models reliably fill a JSON schema but sometimes pick the wrong tool.
   * @param {string} request
   * @param {AbortSignal} [signal]
   */
  async composePanel(request, signal) {
    const facts = this.memory.describeForPrompt();
    const result = await this.ollama.generate({
      system:
        `You are ${this.config.assistantName}, a smart mirror assistant. The user wants something shown on the mirror. ` +
        "Write it as a short panel: a title (2-5 words), an optional subtitle, and 3-6 concise lines (each under 50 characters, " +
        "no numbering or bullets). Also write `spoken`: a few words to say while it appears (e.g. 'Here's your list.'). JSON only.",
      prompt: `${facts ? `About the user:\n${facts}\n\n` : ""}Request: ${request}`,
      schema: PANEL_SCHEMA,
      maxTokens: 260,
      signal,
    });

    const lines = Array.isArray(result?.lines) ? result.lines : [];
    if (!result?.title || lines.length === 0) {
      return { spoken: "Sorry, I couldn't put that together." };
    }
    this.showInfo({ title: result.title, subtitle: result.subtitle ?? "", lines });
    return { spoken: cleanForSpeech(result.spoken) || "It's on the mirror." };
  }

  /**
   * Hide something: one of Iris' own cards ("the score") or another module ("the news").
   * @param {string} target
   */
  hideOnScreen(target) {
    const q = normalize(target);
    if (!q || EVERYTHING.test(q)) {
      const removed = this.widgets.list().filter((w) => w.type !== "timer");
      this.widgets.remove({ predicate: (w) => w.type !== "timer" });
      return { spoken: removed.length ? "Cleared." : "There's nothing of mine on the screen." };
    }

    const types = widgetTypesFor(q);
    if (types.length) {
      const removed = this.widgets.remove({ predicate: (w) => types.includes(w.type) });
      if (removed.length) return { spoken: Talk.pick(["Done.", "Gone.", "Okay."]) };
    }

    // A team name hides its scoreboard ("hide the arsenal game").
    const team = this.widgets.remove({
      predicate: (w) => w.type === "score" && [w.data.home, w.data.away].some((t) => normalize(`${t.name} ${t.short}`).includes(q.split(" ")[0])),
    });
    if (team.length) return { spoken: "Done." };

    const modules = this.screen.find(q);
    if (modules.length === 0) return { spoken: `I couldn't find ${target} on the mirror.` };
    this.screen.hide(modules);
    return { spoken: "Done.", data: { hidden: modules.map((m) => m.name) } };
  }

  /**
   * Show a module Iris (or the user) hid, or everything.
   * @param {string} target
   */
  showOnScreen(target) {
    const q = normalize(target);
    if (!q || EVERYTHING.test(q)) {
      this.screen.restore();
      return { spoken: "Everything's back." };
    }
    const modules = this.screen.find(q);
    if (modules.length === 0) return { spoken: `I couldn't find ${target} on the mirror.` };
    this.screen.show(modules);
    return { spoken: "Here you go.", data: { shown: modules.map((m) => m.name) } };
  }

  focusMode() {
    const count = this.screen.focus();
    return { spoken: count ? "Focus mode. Say show everything to bring it all back." : "The mirror is already clear." };
  }

  restoreScreen() {
    this.screen.restore();
    return { spoken: "Everything's back." };
  }

  listScreen() {
    return {
      spoken: "Here's what's on the mirror.",
      data: {
        modules: this.screen.describe(),
        widgets: this.widgets.list().map((w) => ({ type: w.type, title: widgetTitle(w) })),
      },
    };
  }

  /**
   * Run a user-defined voice command (config.customCommands).
   * @param {{ notification: string, payload?: any, reply?: string }} command
   */
  runCustomCommand(command) {
    this.screen.notify(command.notification, command.payload ?? null);
    return { spoken: command.reply ?? "Done." };
  }

  // ─── Memory, weather, search ───────────────────────────────────────────

  remember(fact) {
    const saved = this.memory.add(fact);
    return { spoken: Talk.pick(["Got it, I'll remember that.", "Noted.", "Okay, I'll keep that in mind."]), data: { saved: saved.text } };
  }

  forget(query) {
    const removed = this.memory.remove(query);
    return removed.length
      ? { spoken: "Okay, I've forgotten that.", data: { removed: removed.map((f) => f.text) } }
      : { spoken: "I couldn't find anything like that in my memory.", data: { removed: [] } };
  }

  /**
   * Answer a spoken weather question straight from the forecast – no
   * language model, so it's instant on a Pi. Understands parts of the day
   * ("tonight", "tomorrow morning") and answers like a person would.
   * @param {string} question e.g. "will I need an umbrella tomorrow?"
   */
  async weatherAnswer(question) {
    const now = this.now();
    const w = await this.weather.get(Weather.parseWhen(question, now), now);
    if (!w) {
      return { spoken: "I don't have any weather data. Add the MagicMirror weather module, or set my latitude and longitude." };
    }
    return { spoken: new WeatherTalk(w, { now }).answer(question) };
  }

  /**
   * Weather as a tool for the language model: a natural summary to say, and
   * the facts in case the model wants to add something.
   * @param {string} [when] "today", "tomorrow", "tonight", "tomorrow morning", …
   */
  async getWeather(when = "today") {
    const now = this.now();
    const weather = await this.weather.get(Weather.parseWhen(String(when ?? ""), now), now);
    if (!weather) {
      return {
        spoken: "I don't have any weather data. Add latitude and longitude to my config, or enable the MagicMirror weather module.",
      };
    }
    return { spoken: new WeatherTalk(weather, { now }).overview(), data: { facts: Weather.describe(weather) } };
  }

  /**
   * Time and date questions, answered exactly: "what time is it in Tokyo",
   * "how long until Christmas", "what day is Halloween".
   * @param {string} question
   */
  timeAnswer(question) {
    const now = this.now();
    return { spoken: this.clock.answer(question, now) ?? Talk.timeNow(now, { locale: this.config.locale }) };
  }

  async webSearch(query, signal) {
    if (!this.search) return { spoken: "Web search isn't set up." };
    const results = await this.search.search(query, signal);
    return {
      spoken: results.length ? `I found ${results.length} results.` : "I couldn't find anything.",
      data: { results },
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  _requireVision() {
    if (!this.visionReady) {
      throw new UserFacingError("My camera isn't available right now. Check the camera setup and that the model supports vision.");
    }
  }

  _showSnapshot(jpeg, title) {
    this.widgets.add({
      type: "snapshot",
      key: "snapshot",
      ttlMs: this.config.display.snapshotTimeout,
      data: { title, image: `data:image/jpeg;base64,${jpeg.toString("base64")}` },
    });
  }

  _showItems(title, items, key) {
    this.widgets.remove({ type: "snapshot" });
    this.widgets.add({
      type: "items",
      key: `items:${key}`,
      ttlMs: this.config.display.cardTimeout,
      data: { title, items: items.map((i) => this.wardrobe.toCard(i)) },
    });
  }

  async _savePhoto(jpeg) {
    const dir = this.wardrobe.photoDir;
    await fs.promises.mkdir(dir, { recursive: true });
    const file = `${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
    await fs.promises.writeFile(path.join(dir, file), jpeg);
    return file;
  }
}

/** An error whose message is safe and friendly to speak aloud. */
class UserFacingError extends Error {}

/**
 * Convert a model bounding box to { x1, y1, x2, y2 } in 0-1000 space.
 * Accepts relative (0-1000) or absolute pixel coordinates.
 * @returns {{ x1: number, y1: number, x2: number, y2: number } | null}
 */
function normalizeBox(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  let [x1, y1, x2, y2] = box.map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;

  if (Math.max(x1, y1, x2, y2) > 1000 && width && height) {
    x1 = (x1 / width) * 1000;
    x2 = (x2 / width) * 1000;
    y1 = (y1 / height) * 1000;
    y2 = (y2 / height) * 1000;
  }
  const clamp = (v) => Math.min(1000, Math.max(0, Math.round(v)));
  [x1, x2] = [clamp(Math.min(x1, x2)), clamp(Math.max(x1, x2))];
  [y1, y2] = [clamp(Math.min(y1, y2)), clamp(Math.max(y1, y2))];

  // Reject degenerate boxes (< 3% of the frame in either direction).
  if (x2 - x1 < 30 || y2 - y1 < 30) return null;
  return { x1, y1, x2, y2 };
}

/**
 * Games for the scoreboard card: live first, then the next few to start,
 * then today's finals, grouped by league within each so the card can label
 * each league once.
 */
function boardGames(board) {
  const soon = Date.now() + 12 * 3600 * 1000;
  const upcoming = board.upcoming.filter((g) => Date.parse(g.date) < soon);
  const leagues = Object.keys(Sports.LEAGUES);
  const byLeague = (list) => [...list].sort((a, b) => leagues.indexOf(a.league.key) - leagues.indexOf(b.league.key));
  return [...byLeague(board.live), ...byLeague(upcoming), ...byLeague(board.finished)].slice(0, MAX_BOARD_GAMES);
}

/** How long until a scoreboard should refresh. */
function scoreRefreshDelay(game) {
  if (game.state === "in") return LIVE_REFRESH_MS;
  if (game.state === "post") return null;
  const untilStart = Date.parse(game.date) - Date.now();
  if (!Number.isFinite(untilStart)) return PRE_GAME_MAX_REFRESH_MS;
  return Math.min(PRE_GAME_MAX_REFRESH_MS, Math.max(LIVE_REFRESH_MS, untilStart));
}

function weatherBadge(w) {
  const d = w.window ?? w.day ?? {};
  const t = w.units.temp;
  return {
    condition: d.condition || w.current?.condition || "",
    high: d.high !== null && d.high !== undefined ? `${Math.round(d.high)}${t}` : "",
    low: d.low !== null && d.low !== undefined ? `${Math.round(d.low)}${t}` : "",
    rain: d.precipChance !== null && d.precipChance !== undefined ? `${Math.round(d.precipChance)}%` : "",
  };
}

function widgetTypesFor(q) {
  return Object.entries(WIDGET_WORDS)
    .filter(([, words]) => words.some((w) => new RegExp(`\\b${w}\\b`).test(q)))
    .map(([type]) => type);
}

function widgetTitle(w) {
  if (w.type === "score") return `${w.data.away.short} at ${w.data.home.short}`;
  if (w.type === "scoreboard") return w.data.title;
  if (w.type === "timer") return w.data.label || "timer";
  return w.data.title ?? w.type;
}

function cleanLabel(label) {
  return String(label ?? "")
    .replace(/\b(a|the|my|timer|for|called|named)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30);
}

function lowerFirst(s) {
  // Keep acronyms and brand-style capitals ("NASA tee", "iPhone case") as they are.
  return s && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function joinNames(names) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

Skills.UserFacingError = UserFacingError;
Skills.normalizeBox = normalizeBox;
Skills.scoreRefreshDelay = scoreRefreshDelay;
module.exports = Skills;
