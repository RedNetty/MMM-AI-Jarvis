"use strict";

const log = require("./log");

/**
 * Understands requests the instant patterns in intents.js don't catch
 * ("what's Tesla going for these days?", "can you stick the calendar over
 * on the left?", "who won the game last night?") by asking the language
 * model to pick one action from a fixed list and fill in its subject, as
 * JSON. Small local models are far more reliable at filling a schema than
 * at free tool calling, so this is what lets every skill be reached in
 * plain words.
 *
 * Actions the assistant answers itself are mapped back to skills; "answer"
 * (general knowledge) and "current" (recent events) tell the assistant how
 * to ground its reply.
 *
 * Routing costs one extra prompt per request. Ollama can't reuse any of it
 * between calls on a hybrid model like qwen3.5 (measured: the full ~820
 * tokens are read every time), and it also means the next answer can't
 * reuse the conversation's cached prompt. That is about a second on a Mac
 * and 15–20 s on a Raspberry Pi. So in "auto" mode the router only runs
 * while the model's server reads prompts fast enough, and only for requests
 * that look like they want a skill (a command for the mirror, a price, a
 * timer…). Conversation and questions go straight to the language model,
 * with no added delay.
 */

// Prompt tokens the next answer re-reads after a routing call (system prompt and recent history).
const CHAT_PROMPT_TOKENS = 1000;

// Words that suggest a request wants one of the skills rather than a conversation.
const SKILL_HINTS = new RegExp(
  "\\b(?:" +
    [
      // the mirror and its modules
      "move|put|place|stick|shove|slide|drag|shift|park|push|bring|make|turn|switch|set|show|hide|close|open|remove|clear|reset|restore",
      "dim\\w*|bright\\w*|darker|lighter|screen|display|mirror|monitor|layout|night mode|font|text|bigger|smaller|larger|size|zoom",
      "calendar|clock|compliments?|agenda|module|widget|corner|top|bottom|left|middle",
      // data and skills
      "timer|alarm|minutes?|seconds?|hours?|stocks?|shares?|prices?|worth|trading|going for|selling for|market|crypto|bitcoin|ethereum|nasdaq|dow",
      "dollars?|euros?|pounds?|yen|convert|exchange|percent|score|game|match|playing|team",
      "weather|rain\\w*|snow\\w*|forecast|temperature|cold|hot|umbrella|wear|outfit|dress|jacket|look|camera",
      // (not "won", "latest" or "who is": those are questions, grounded in headlines or Wikipedia without routing)
      "define|definition|spell|remember|forget|news|headlines|briefing",
    ].join("|") +
    ")\\b",
  "i",
);
// Follow-ups that only make sense with the previous request ("what about Tesla?").
const FOLLOW_UP = /^(?:and|also|what about|how about|same for|now)\b(?!\s+(?:you|yourself)\b)/i;
// Actions that were a conversation rather than a skill.
const CONVERSATION = new Set(["chat", "answer", "current"]);

const ACTIONS = {
  stock: "price or performance of a company stock, index, crypto or commodity (subject: names, comma-separated)",
  weather: "weather or forecast (subject: place, or empty for here)",
  time: "the time, a date, a countdown or the time in another place",
  sports: "a team's game or score (subject: team), or all games on (subject: league or empty)",
  news: "news headlines (subject: topic, or empty for top stories)",
  current: "a question about recent events or anything that changes over time: who won, latest, current holders of a role, prices of things (subject: what to search the news for)",
  answer: "a general knowledge question about a person, place, thing or idea (subject: the Wikipedia topic)",
  chat: "small talk, opinions, jokes, advice, creative requests, or questions about the assistant",
  define: "the meaning of a word (subject: the word)",
  convert: "a currency, unit or maths calculation (subject: the full calculation)",
  timer: "set, check or cancel a timer (value: duration)",
  outfit: "what to wear (subject: occasion)",
  look: "look at the user through the camera",
  show: "show a module on the mirror (subject: module name)",
  hide: "hide a module or card (subject: module name)",
  move: "move a module somewhere on the mirror (subject: module; value: where, e.g. top left)",
  resize: "make a module or all text bigger or smaller (subject: module or everything; value: bigger or smaller)",
  brightness: "dim or brighten the mirror (value: dimmer, brighter or a percent)",
  screen: "turn the screen off or on (value: off or on)",
  night: "night mode on or off (value: on or off)",
  layout: "save, switch to or reset a mirror layout (value: save, load or reset; subject: layout name)",
  remember: "remember a fact or preference (subject: the fact)",
  briefing: "a morning briefing or summary of the day",
};

const SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: Object.keys(ACTIONS) },
    subject: { type: "string" },
    value: { type: "string" },
  },
  required: ["action", "subject", "value"],
};

const EXAMPLES = [
  ["what's tesla going for", "stock", "tesla", ""],
  ["how did apple and microsoft do", "stock", "apple, microsoft", ""],
  ["is it gonna be chilly in boston", "weather", "boston", ""],
  ["who won the world series", "current", "world series winner", ""],
  ["who is the CEO of OpenAI", "current", "OpenAI CEO", ""],
  ["how tall is the empire state building", "answer", "Empire State Building", ""],
  ["why is the sky blue", "answer", "Rayleigh scattering", ""],
  ["tell me something funny", "chat", "", ""],
  ["stick the calendar over on the left", "move", "calendar", "left"],
  ["the clock is too small", "resize", "clock", "bigger"],
  ["it's way too bright in here", "brightness", "", "dimmer"],
  ["what about tesla", "stock", "tesla", ""],
];

class Router {
  /**
   * @param {object} deps
   * @param {import("./Ollama")} deps.ollama
   * @param {true|"auto"} [deps.mode="auto"] true = always route; "auto" = only when it costs less than budgetMs.
   * @param {number} [deps.budgetMs=2000] Most extra time routing may add to a request in "auto" mode.
   * @param {number} [deps.timeoutMs=8000]
   */
  constructor({ ollama, mode = "auto", budgetMs = 2000, timeoutMs = 8000 }) {
    this.ollama = ollama;
    this.mode = mode === true || mode === "always" ? "always" : "auto";
    this.budgetMs = budgetMs;
    this.timeoutMs = timeoutMs;
    this.system = Router.systemPrompt();
    // Rough token count (about 3.6 characters per token for English prose).
    this.promptTokens = Math.round(this.system.length / 3.6) + 40;
    this.lastEnabled = null;
  }

  /**
   * Whether to route this request. In "auto" mode: only once the server's
   * prompt speed is known and routing (its own prompt, plus re-reading the
   * conversation afterwards) fits in the budget.
   */
  get enabled() {
    if (this.mode === "always") return true;
    const rate = this.ollama.promptRate;
    const costMs = rate ? ((this.promptTokens + CHAT_PROMPT_TOKENS) / rate) * 1000 : Infinity;
    const enabled = costMs <= this.budgetMs;
    if (enabled !== this.lastEnabled && rate) {
      log.info(
        enabled
          ? `Router on: the model reads ${Math.round(rate)} tokens/s, so understanding free-form requests adds about ${(costMs / 1000).toFixed(1)}s.`
          : `Router off: the model reads ${Math.round(rate)} tokens/s, so it would add about ${(costMs / 1000).toFixed(0)}s per request. Using instant patterns only.`,
      );
      this.lastEnabled = enabled;
    }
    return enabled;
  }

  static systemPrompt() {
    return (
      "You route requests for IRIS, a voice assistant in a smart mirror. Pick the single action that fulfils the request, " +
      "and fill subject and value (empty strings when not needed). Use the previous request to resolve follow-ups like " +
      '"what about…". Prefer a specific action over chat or answer.\n\nActions:\n' +
      Object.entries(ACTIONS)
        .map(([name, what]) => `- ${name}: ${what}`)
        .join("\n") +
      "\n\nExamples:\n" +
      EXAMPLES.map(([q, action, subject, value]) => `"${q}" → {"action":"${action}","subject":"${subject}","value":"${value}"}`).join("\n")
    );
  }

  /**
   * Whether to route this particular request: always with `router: true`;
   * in "auto" mode only when routing is cheap on this server and the
   * request looks like it wants a skill (or follows up on one).
   * @param {string} query
   * @param {{ query: string, action: string } | null} [previous]
   */
  shouldRoute(query, previous = null) {
    if (this.mode === "always") return true;
    if (!this.enabled) return false;
    return Router.wantsSkill(query, previous);
  }

  /**
   * @param {string} query
   * @param {{ query: string, action: string } | null} [previous]
   */
  static wantsSkill(query, previous = null) {
    const q = String(query ?? "").trim();
    if (SKILL_HINTS.test(q)) return true;
    return Boolean(previous && !CONVERSATION.has(previous.action) && FOLLOW_UP.test(q));
  }

  /**
   * @param {string} query
   * @param {{ previous?: { query: string, action: string } | null, signal?: AbortSignal }} [options]
   * @returns {Promise<{ action: string, subject: string, value: string } | null>} null when routing failed
   */
  async route(query, { previous = null, signal } = {}) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const prompt = `${previous ? `Previous request: "${previous.query}" (${previous.action})\n` : ""}Request: "${query}"`;
    const started = Date.now();
    try {
      const result = await this.ollama.generate({
        system: this.system,
        prompt,
        schema: SCHEMA,
        maxTokens: 60,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!result || !ACTIONS[result.action]) return null;
      const route = { action: result.action, subject: String(result.subject ?? "").trim(), value: String(result.value ?? "").trim() };
      log.info(`Route (${Date.now() - started}ms): ${route.action} ${JSON.stringify({ subject: route.subject, value: route.value })}`);
      return route;
    } catch (err) {
      if (signal?.aborted) throw err;
      log.warn(`Routing failed (${err.message}); answering directly.`);
      return null;
    }
  }
}

Router.ACTIONS = ACTIONS;
module.exports = Router;
