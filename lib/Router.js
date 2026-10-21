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
 * Routing costs one extra prompt per request, and on a hybrid model it also
 * means the next answer can't reuse the conversation's cached prompt. That
 * is a fraction of a second on a Mac but many seconds on a Raspberry Pi, so
 * in "auto" mode the router only runs while the model's server reads
 * prompts fast enough; otherwise requests go straight to the instant
 * patterns and the language model.
 */

// Prompt tokens the next answer re-reads after a routing call (system prompt and recent history).
const CHAT_PROMPT_TOKENS = 1000;

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
