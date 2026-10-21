"use strict";

const { availableTools, runTool } = require("./tools");
const { detectIntent, matchCustomCommand, toThirdPerson } = require("./intents");
const { cleanForSpeech, splitSentences, SentenceStreamer, parseDuration } = require("./text");
const Talk = require("./speech/talk");
const Router = require("./Router");
const Skills = require("./Skills");
const log = require("./log");

// Small models occasionally chain tool calls in circles; after this many
// rounds the model must answer with what it has.
const MAX_TOOL_ROUNDS = 2;
// Skills that take several seconds on a Pi say something right away, so the
// user knows they were heard while the work happens.
const ACKNOWLEDGEMENTS = {
  // The greeting goes out at once while the briefing's data loads.
  briefing: (a) => {
    const part = Talk.partOfDay(new Date().getHours());
    return `Good ${part === "night" ? "evening" : part}${a.config.userName ? `, ${a.config.userName}` : ""}.`;
  },
  compose_panel: ["Sure, putting that on the mirror.", "On it.", "Coming right up."],
  scan_clothing: ["Hold it up and keep still, I'm taking a look.", "Okay, hold it nice and still for me."],
  look_at_user: ["Let me take a look.", "Okay, let me see.", "One sec, taking a look."],
};

// Tool results go back into the prompt; large data objects cost prompt time.
const MAX_TOOL_DATA_CHARS = 600;
const NEEDS = {
  weather_answer: "weatherReady",
  look_at_user: "visionReady",
  scan_clothing: "visionReady",
  show_score: "sportsReady",
  sports_overview: "sportsReady",
  news: "infoReady",
  market_quote: "infoReady",
  knowledge: "infoReady",
  convert_currency: "infoReady",
  define_word: "infoReady",
};
// Questions about the world (not about the user or the assistant) get a
// Wikipedia reference in the prompt, so a small model answers from facts.
const FACTUAL = /^(?:(?:hey|ok|okay|so|and)\s+)?(?:who|what|when|where|which|why|how (?:many|much|tall|old|big|far|long|deep|high|heavy|fast|large|small|hot|cold)|tell me (?:about|who|what|when|where|how)|is it true)\b/i;
// Questions whose answer changes over time ("who won the world series", "who's the CEO of OpenAI"):
// grounded in recent headlines rather than an encyclopedia that may be out of date.
const CURRENT = /\b(?:who won|who(?:'s| is) winning|winner of|latest|currently|these days|this (?:week|season|year)|last night|yesterday|recent(?:ly)?|just (?:happened|announced)|what happened (?:to|with|in|at))\b|^(?:who|what)(?:'s| is) (?:the )?(?:current |new )?(?:ceo|president|prime minister|chancellor|leader|coach|manager|head|champion|mayor|governor|pope|price)\b/i;
const NOT_FACTUAL = /\b(?:you|your|yourself|i|me|my|mine|we|our|us|joke|story|poem|song|riddle|should i|can i|do i|weather|wear|time is it)\b/i;

/**
 * Conversational brain: keeps short-term conversation history, builds the
 * prompt, routes common requests straight to skills, and runs the LLM
 * tool-calling loop for everything else.
 *
 * Built for speed on CPU-only devices, where reading the prompt is the
 * slowest step:
 *  - Each request carries only the tools its words point to (tools.js), and
 *    plain questions ("tell me a joke") none at all, so the prompt stays a
 *    few hundred tokens and the model can't wander off calling tools.
 *  - The conversation is only ever appended to: the system prompt doesn't
 *    change per request (the time rides on the user's message), and history
 *    is trimmed in batches. Ollama reuses its cache when a prompt extends
 *    the previous one, which also works for hybrid models like qwen3.5.
 *  - Answers are streamed: each finished sentence is handed to `onSentence`
 *    and can be spoken while the rest is still being generated.
 */
class Assistant {
  /**
   * @param {object} deps
   * @param {import("./Ollama")} deps.ollama
   * @param {import("./Skills")} deps.skills
   * @param {import("./Memory")} deps.memory
   * @param {import("./Wardrobe")} deps.wardrobe
   * @param {import("./Screen")} deps.screen
   * @param {object} deps.config Module config.
   */
  constructor({ ollama, skills, memory, wardrobe, screen, config }) {
    this.ollama = ollama;
    this.skills = skills;
    this.memory = memory;
    this.wardrobe = wardrobe;
    this.screen = screen;
    this.config = config;
    this.history = [];
    this.lastActivity = 0;
    // Understands anything the instant patterns miss, by asking the model to pick a skill.
    // true = always; "auto" = only while the model's server is fast enough that it doesn't slow answers down.
    this.router = config.llm.router === false ? null : new Router({ ollama, mode: config.llm.router ?? "auto" });
    /** The last request and how it was handled, for follow-ups ("what about Tesla?"). */
    this.lastRoute = null;
  }

  /** Forget the current conversation (long-term memory is kept). */
  resetConversation() {
    this.history = [];
  }

  /**
   * Load the model and pre-process the system prompt + tools so the first
   * question is fast.
   */
  warmUp() {
    return this.ollama.warmUp({ system: this._systemPrompt(false) });
  }

  /**
   * Answer a user query.
   * @param {string} query
   * @param {{ signal?: AbortSignal, onSentence?: (sentence: string) => void }} [options]
   *   onSentence receives every sentence of the reply exactly once, as soon
   *   as it is ready (streamed for LLM answers).
   * @returns {Promise<string>} Full reply text.
   */
  async ask(query, { signal, onSentence } = {}) {
    if (Date.now() - this.lastActivity > this.config.conversation.resetAfter) this.resetConversation();
    this.lastActivity = Date.now();

    const emit = onSentence ?? (() => {});
    let reply;
    try {
      reply = await this._fastPath(query, signal, emit);
      let grounding = null;
      if (reply === null) ({ reply, grounding } = await this._routed(query, signal, emit));
      if (reply !== null) {
        for (const sentence of splitSentences(reply, 220, true)) emit(sentence);
      } else {
        reply = await this._llmLoop(query, signal, emit, grounding);
      }
    } catch (err) {
      if (err.name === "AbortError" || signal?.aborted) throw err;
      if (!(err instanceof Skills.UserFacingError)) throw err;
      reply = err.message;
      emit(reply);
    }

    this.lastActivity = Date.now();
    return reply;
  }

  // ─── Fast path ─────────────────────────────────────────────────────────

  async _fastPath(query, signal, emit) {
    const custom = matchCustomCommand(query, this.config.customCommands);
    if (custom) {
      log.info(`Custom command: ${custom.notification}`);
      return this._record(query, this.skills.runCustomCommand(custom).spoken);
    }

    if (!this.config.llm.fastIntents) return null;
    const intent = detectIntent(query, {
      screen: this.screen,
      clock: this.skills.clock,
      isAvailable: (name) => !NEEDS[name] || this.skills[NEEDS[name]],
    });
    if (!intent) return null;

    log.info(`Intent: ${intent.name} ${JSON.stringify(intent.args)}`);
    this.lastRoute = { query, action: intent.name };
    const ack = ACKNOWLEDGEMENTS[intent.name];
    if (ack) emit(typeof ack === "function" ? ack(this) : Talk.pick(ack));
    const result = await runTool(this.skills, intent.name, { ...intent.args, greeted: Boolean(ack) }, signal);
    // A skill can decline ("no Wikipedia page for that"): the language model answers instead.
    if (result.passThrough) return null;
    return this._record(query, cleanForSpeech(result.spoken));
  }

  // ─── Router ────────────────────────────────────────────────────────────

  /**
   * Ask the router which skill a request is for. Returns a reply when a
   * skill answered, or how to ground the language model's answer.
   * @returns {Promise<{ reply: string|null, grounding: { kind: "fact"|"news", subject: string } | "none" | null }>}
   */
  async _routed(query, signal, emit) {
    if (!this.router?.shouldRoute(query, this.lastRoute)) return { reply: null, grounding: null };
    const route = await this.router.route(query, { previous: this.lastRoute, signal });
    if (!route) return { reply: null, grounding: null };
    this.lastRoute = { query, action: route.action };

    if (route.action === "answer") return { reply: null, grounding: { kind: "fact", subject: route.subject || query } };
    if (route.action === "current") return { reply: null, grounding: { kind: "news", subject: route.subject || query } };
    if (route.action === "chat") return { reply: null, grounding: "none" };

    const call = this._routeToTool(route, query);
    if (!call || (NEEDS[call.name] && !this.skills[NEEDS[call.name]])) return { reply: null, grounding: null };
    log.info(`Routed to ${call.name} ${JSON.stringify(call.args)}`);
    const ack = ACKNOWLEDGEMENTS[call.name];
    if (ack) emit(typeof ack === "function" ? ack(this) : Talk.pick(ack));
    const result = await runTool(this.skills, call.name, { ...call.args, greeted: Boolean(ack) }, signal);
    if (result.passThrough) return { reply: null, grounding: null };
    return { reply: this._record(query, cleanForSpeech(result.spoken)), grounding: null };
  }

  /**
   * Turn a route into a skill call (the same skills the instant patterns use).
   * @param {{ action: string, subject: string, value: string }} r
   * @param {string} q The original request.
   * @returns {{ name: string, args: object } | null}
   */
  _routeToTool(r, q) {
    const subject = r.subject;
    const value = r.value.toLowerCase();
    switch (r.action) {
      case "stock":
        return { name: "market_quote", args: { request: subject ? subject.replace(/\s*,\s*/g, " and ") : q } };
      case "weather": {
        const named = subject && !q.toLowerCase().includes(subject.toLowerCase());
        return { name: "weather_answer", args: { question: named ? `${q} in ${subject}` : q } };
      }
      case "time":
        return this.skills.clock.answer(q) ? { name: "time_answer", args: { question: q } } : null;
      case "sports":
        return { name: "show_score", args: { team: subject } };
      case "news":
        return { name: "news", args: { request: subject ? `news about ${subject}` : "the news" } };
      case "define":
        return { name: "define_word", args: { request: `define ${subject || q}` } };
      case "convert":
        return { name: "calculate", args: { question: q, fallback: subject } };
      case "timer": {
        if (/\b(?:cancel|stop|delete|clear)\b/i.test(q)) return { name: "cancel_timer", args: { label: "" } };
        const seconds = parseDuration(`${value} ${q}`);
        return seconds ? { name: "set_timer", args: { seconds, label: "" } } : { name: "timer_status", args: {} };
      }
      case "outfit":
        return { name: "suggest_outfit", args: { request: q } };
      case "look":
        return { name: "look_at_user", args: { question: q } };
      case "show":
        return subject ? { name: "show_module", args: { target: subject } } : null;
      case "hide":
        return subject ? { name: "hide_on_mirror", args: { target: subject } } : null;
      case "move":
        return subject && value ? { name: "move_module", args: { target: subject, where: value } } : null;
      case "resize":
        return { name: "resize_module", args: { target: subject || "everything", change: /small|less|shrink|tiny|down/.test(value) ? "smaller" : /normal|reset|default/.test(value) ? "reset" : "bigger" } };
      case "brightness": {
        const pct = /(\d{1,3})/.exec(value);
        return { name: "brightness", args: { change: pct ? Math.min(100, Number(pct[1])) / 100 : /bright|up|more/.test(value) ? "brighter" : "dimmer" } };
      }
      case "screen":
        return { name: "screen_power", args: { on: !/off|sleep|dark/.test(value) } };
      case "night":
        return { name: "night_mode", args: { on: !/off|stop|end|day|normal/.test(value) } };
      case "layout":
        if (/reset|default/.test(value)) return { name: "reset_layout", args: {} };
        return { name: /save/.test(value) ? "save_scene" : "load_scene", args: { name: subject } };
      case "remember":
        return subject ? { name: "remember", args: { fact: toThirdPerson(subject) } } : null;
      case "briefing":
        return { name: "briefing", args: {} };
      default:
        return null;
    }
  }

  /** Record a fast-path exchange so follow-ups ("something warmer?") have context. */
  _record(query, reply) {
    this._pushTurn([
      { role: "user", content: query },
      { role: "assistant", content: reply },
    ]);
    return reply;
  }

  // ─── LLM tool loop ─────────────────────────────────────────────────────

  async _llmLoop(query, signal, emit, grounding = null) {
    const selected = availableTools(this.skills, query, this._recentToolNames());
    const tools = selected.length ? selected : undefined;
    const system = this._systemPrompt(Boolean(tools));
    // Per-request context rides on the user's message so the cached prefix stays valid.
    const reference = await this._reference(query, signal, grounding);
    const turn = [{ role: "user", content: `${this._context(query)}${reference}\n\n${query}` }];
    let spoken = "";
    let lastToolAnswer = "";

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const lastRound = round === MAX_TOOL_ROUNDS;
      const streamer = new SentenceStreamer();
      const say = (sentence) => {
        const clean = cleanForSpeech(sentence);
        if (!clean) return;
        spoken = spoken ? `${spoken} ${clean}` : clean;
        emit(clean);
      };

      const res = await this.ollama.chat({
        system,
        messages: [...this.history, ...turn],
        tools: lastRound || !tools ? undefined : tools,
        onText: (delta) => streamer.push(delta).forEach(say),
        signal,
      });
      turn.push(res.message);

      if (res.toolCalls.length === 0 || lastRound) {
        // Don't speak half a sentence when the answer hit the token limit.
        const rest = streamer.flush();
        if (!res.truncated || !spoken) say(rest);
        // A small model sometimes ends without words after using a tool; the
        // tool's own answer is better than an apology.
        if (!spoken) say(lastToolAnswer || "Sorry, I don't have an answer for that.");
        turn[turn.length - 1] = { role: "assistant", content: spoken };
        this._pushTurn(turn);
        return spoken;
      }

      // Text before a tool call ("Let me check…") has been spoken already.
      say(streamer.flush());
      for (const call of res.toolCalls) {
        log.info(`Tool: ${call.name} ${JSON.stringify(call.args)}`);
        let content;
        try {
          const result = await runTool(this.skills, call.name, call.args, signal);
          lastToolAnswer = result.spoken;
          const data = result.data && JSON.stringify(result.data).length <= MAX_TOOL_DATA_CHARS ? result.data : {};
          content = { result: result.spoken, ...data };
        } catch (err) {
          if (err.name === "AbortError" || signal?.aborted) throw err;
          log.warn(`Tool ${call.name} failed: ${err.message}`);
          content = { error: err.message };
        }
        turn.push({ role: "tool", tool_name: call.name, content: JSON.stringify(content) });
      }
    }
    throw new Error("Tool loop ended unexpectedly.");
  }

  /**
   * A short Wikipedia extract for factual questions ("how tall is Mount
   * Everest?"), appended to the request's context. Empty for chit-chat and
   * personal questions, or when the lookup is slow or finds nothing.
   * @param {string} query
   * @param {AbortSignal} [signal]
   */
  async _reference(query, signal, grounding = null) {
    if (!this.skills.infoReady || grounding === "none") return "";
    const started = Date.now();
    const q = query.trim();
    const personal = NOT_FACTUAL.test(q);
    // The router decides when it ran; otherwise questions about things that change are searched in the news.
    const news = grounding?.kind === "news" ? grounding.subject : !grounding && CURRENT.test(q) && !personal ? q.replace(/[?!.]+$/, "") : null;
    if (news) {
      const found = await this.skills.info.newsReference(news, signal);
      log.debug(`Headlines lookup ${Date.now() - started}ms: ${found ? found.count : 0} for "${news}"`);
      if (found) return `\n[Recent headlines about "${news}", newest first:\n${found.text}]`;
      if (grounding) return "";
      // Nothing recent: an encyclopedia answer is better than none.
    }
    // The router named the topic; without the router, only questions that look factual are looked up.
    const subject = grounding?.kind === "fact" ? grounding.subject : FACTUAL.test(q) && !personal ? query : null;
    if (!subject) return "";
    const ref = await this.skills.info.reference(subject, signal);
    log.debug(`Reference lookup ${Date.now() - started}ms: ${ref ? ref.title : "none"}`);
    return ref ? `\n[Reference, Wikipedia "${ref.title}": ${ref.extract}]` : "";
  }

  /**
   * Append a finished exchange. Messages are stored exactly as sent so the
   * next prompt extends the previous one (cache reuse).
   * @param {object[]} messages
   */
  _pushTurn(messages) {
    this.history.push(...messages);

    // Trim in batches: once history holds twice the configured turns, drop
    // back to the configured number. Cutting a little every turn would change
    // the start of every prompt and defeat the cache. Always cut at a user
    // message so tool results stay with the call that produced them.
    const maxTurns = this.config.conversation.historyTurns;
    const userIdx = this.history.reduce((acc, m, i) => (m.role === "user" ? [...acc, i] : acc), []);
    if (userIdx.length > maxTurns * 2) {
      this.history = this.history.slice(userIdx[userIdx.length - maxTurns]);
    }
  }

  /** Tools used in the last exchange, kept for follow-ups ("make it 10 minutes"). */
  _recentToolNames() {
    const lastUser = this.history.map((m) => m.role).lastIndexOf("user");
    return this.history.slice(Math.max(0, lastUser)).filter((m) => m.role === "tool").map((m) => m.tool_name);
  }

  /**
   * Static instructions. Only changes when long-term memory changes, so the
   * prompt cache stays warm between questions.
   * @param {boolean} withTools
   */
  _systemPrompt(withTools) {
    const name = this.config.assistantName;
    const user = this.config.userName ? ` for ${this.config.userName}` : "";
    const facts = this.memory.describeForPrompt();
    const lines = [
      `You are ${name}, the voice of a smart mirror${user}. Sound like a warm, natural person: answer directly, in everyday spoken English ` +
        "with contractions, and don't add commentary you aren't sure of.",
      "Your words are read aloud: usually one short sentence, two at most. Answer the question and stop; no small talk, " +
        "no markdown, lists, emoji or URLs.",
      "The current date and time is in brackets before each message. Use it to reason about time (how long until, " +
        "tonight vs tomorrow) and say times the way people do (\"about quarter to seven\", \"tomorrow night\").",
      "Never make up live facts such as scores, news or prices; if you don't have them, say so.",
      "When a Reference or Recent headlines are given, answer from them in your own words, briefly. If the headlines show it hasn't happened yet, say so and what's coming up; if they don't answer the question, say you're not sure.",
    ];
    if (withTools) {
      lines.push(
        "Most questions need no tool: just answer. Only call a tool when the user asks to see, show, hide, set, find, add or " +
          "remember something, or asks about their clothes, the weather, sports or live news. Call at most one tool, then answer from its result.",
        this.skills.visionReady ? "To see the user call look_at_user." : "You have no camera.",
        "Never invent wardrobe items. Never claim you did something unless a tool succeeded.",
      );
    } else {
      lines.push("Answer from your own knowledge.");
    }
    if (facts) lines.push(`About the user:\n${facts}`);
    return lines.join("\n");
  }

  /**
   * Per-request facts, prepended to the user's message:
   * "[Wednesday, October 21, 2026, 6:46 PM, evening. Local time in London: 11:46 PM Wednesday]".
   * Places named in the request get their local time, so "is it too late to
   * call my mom in London?" is reasoned about, not guessed.
   * @param {string} [query]
   */
  _context(query = "") {
    const now = new Date();
    const locale = this.config.locale || undefined;
    const places = this.skills.clock?.placeTimes(query, now) ?? [];
    return (
      `[${now.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}, ` +
      `${now.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}, ${Talk.partOfDay(now.getHours())}` +
      `${places.length ? `. Local time in ${places.join(", in ")}` : ""}]`
    );
  }
}

module.exports = Assistant;
