"use strict";

const { availableTools, runTool } = require("./tools");
const { detectIntent, matchCustomCommand } = require("./intents");
const { cleanForSpeech } = require("./text");
const Skills = require("./Skills");
const log = require("./log");

const MAX_TOOL_ROUNDS = 4;
const NEEDS = {
  look_at_user: "visionReady",
  scan_clothing: "visionReady",
  show_score: "sportsReady",
};

/**
 * Conversational brain: keeps short-term conversation history, builds the
 * system prompt, routes common requests straight to skills, and runs the
 * LLM tool-calling loop for everything else.
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
  }

  /** Forget the current conversation (long-term memory is kept). */
  resetConversation() {
    this.history = [];
  }

  /**
   * Answer a user query.
   * @param {string} query
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<string>} Reply text, ready to speak.
   */
  async ask(query, { signal } = {}) {
    if (Date.now() - this.lastActivity > this.config.conversation.resetAfter) this.resetConversation();
    this.lastActivity = Date.now();

    let reply;
    try {
      reply = (await this._fastPath(query, signal)) ?? (await this._llmLoop(query, signal));
    } catch (err) {
      if (err.name === "AbortError" || signal?.aborted) throw err;
      if (!(err instanceof Skills.UserFacingError)) throw err;
      reply = err.message;
    }

    this.lastActivity = Date.now();
    return reply;
  }

  // ─── Fast path ─────────────────────────────────────────────────────────

  async _fastPath(query, signal) {
    const custom = matchCustomCommand(query, this.config.customCommands);
    if (custom) {
      log.info(`Custom command: ${custom.notification}`);
      return this._record(query, this.skills.runCustomCommand(custom).spoken);
    }

    if (!this.config.llm.fastIntents) return null;
    const intent = detectIntent(query, {
      screen: this.screen,
      isAvailable: (name) => !NEEDS[name] || this.skills[NEEDS[name]],
    });
    if (!intent) return null;

    log.info(`Intent: ${intent.name} ${JSON.stringify(intent.args)}`);
    const result = await runTool(this.skills, intent.name, intent.args, signal);
    return this._record(query, cleanForSpeech(result.spoken));
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

  async _llmLoop(query, signal) {
    const turn = [{ role: "user", content: query }];
    const tools = availableTools(this.skills);
    const system = this._systemPrompt();

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const lastRound = round === MAX_TOOL_ROUNDS;
      const res = await this.ollama.chat({
        system,
        messages: [...this.history, ...turn],
        tools: lastRound ? undefined : tools,
        signal,
      });
      turn.push(res.message);

      if (res.toolCalls.length === 0 || lastRound) {
        const reply = cleanForSpeech(res.text) || "Sorry, I don't have an answer for that.";
        turn[turn.length - 1] = { role: "assistant", content: reply };
        this._pushTurn(turn);
        return reply;
      }

      for (const call of res.toolCalls) {
        log.info(`Tool: ${call.name} ${JSON.stringify(call.args)}`);
        let content;
        try {
          const result = await runTool(this.skills, call.name, call.args, signal);
          content = { result: result.spoken, ...(result.data ?? {}) };
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

  _pushTurn(messages) {
    this.history.push(...messages);

    // Keep the last N user turns; always cut at a user message so tool
    // results are never separated from the call that produced them.
    const maxTurns = this.config.conversation.historyTurns;
    const userIdx = this.history.reduce((acc, m, i) => (m.role === "user" ? [...acc, i] : acc), []);
    if (userIdx.length > maxTurns) {
      this.history = this.history.slice(userIdx[userIdx.length - maxTurns]);
    }
  }

  _systemPrompt() {
    const now = new Date();
    const locale = this.config.locale || undefined;
    const name = this.config.assistantName;
    const user = this.config.userName ? ` for ${this.config.userName}` : "";
    const facts = this.memory.describeForPrompt();
    const visible = this.screen.modules.filter((m) => !m.hidden).map((m) => m.name);

    const lines = [
      `You are ${name}, a friendly voice assistant built into a smart mirror${user}.`,
      `It is ${now.toLocaleDateString(locale, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}, ` +
        `${now.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}.`,
      "Your replies are spoken aloud: answer in 1-3 short, natural sentences. Never use markdown, lists, emoji or URLs in speech.",
      "You control the mirror's display: show_on_mirror puts a panel of text on screen (use it for lists, steps or anything worth reading), " +
        "hide_on_mirror and show_module hide or show cards and other modules, and set_timer shows a countdown.",
      this.skills.sportsReady ? "For any sports score, result or fixture, call show_score – it pins a live scoreboard to the mirror." : "",
      this.skills.visionReady
        ? "You can see the user only by calling look_at_user, and can catalogue clothing with scan_clothing."
        : "The camera is unavailable, so you cannot see the user.",
      this.skills.searchReady
        ? "Use web_search for news, live information or anything that may have changed recently."
        : "You cannot browse the web; if asked about live events other than sports, say you don't have current information.",
      "Use tools whenever they help. Only mention wardrobe items that a tool returned; never invent clothing. " +
        "Never claim you saved, showed or changed something unless the tool call succeeded.",
      "If the user shares a lasting preference or personal fact, save it with remember.",
      `The user's wardrobe has ${this.wardrobe.items.length} items.`,
      visible.length ? `Modules currently visible on the mirror: ${visible.join(", ")}.` : "",
    ];
    if (facts) lines.push(`What you know about the user:\n${facts}`);
    return lines.filter(Boolean).join("\n");
  }
}

module.exports = Assistant;
