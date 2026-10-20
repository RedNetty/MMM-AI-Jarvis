"use strict";

const log = require("./log");

/**
 * Client for a local Ollama server (https://ollama.com).
 *
 * Ollama can run on the mirror's Raspberry Pi itself, or on any faster PC on
 * your network – point `llm.ollamaUrl` at it. Model capabilities (vision,
 * tool calling, thinking) are read from Ollama so the assistant adapts to
 * whichever model you pull.
 */
class Ollama {
  /**
   * @param {object} options
   * @param {string} [options.url="http://127.0.0.1:11434"]
   * @param {string} options.model         Chat model, e.g. "qwen3.5:4b".
   * @param {string} [options.visionModel] Model used for camera images; defaults to `model`.
   * @param {string|number} [options.keepAlive="30m"] How long Ollama keeps the model in RAM.
   * @param {number} [options.temperature=0.6]
   * @param {number} [options.maxTokens=400]
   * @param {number} [options.contextSize=8192]
   * @param {boolean} [options.think=false] Enable "thinking" on models that support it (slower).
   * @param {number} [options.timeoutMs=180000]
   */
  constructor(options) {
    this.url = (options.url ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.model = options.model;
    this.visionModel = options.visionModel || options.model;
    this.keepAlive = options.keepAlive ?? "30m";
    this.temperature = options.temperature ?? 0.6;
    this.maxTokens = options.maxTokens ?? 400;
    this.contextSize = options.contextSize ?? 8192;
    this.think = Boolean(options.think);
    this.timeoutMs = options.timeoutMs ?? 180000;

    /** @type {Map<string, Set<string>>} model → capabilities */
    this.capabilities = new Map();
  }

  // ─── Capabilities ──────────────────────────────────────────────────────

  /**
   * Fetch (and cache) a model's capabilities, e.g. {"completion","vision","tools","thinking"}.
   * Unknown/older Ollama versions yield an empty set, which means "assume text only".
   * @param {string} model
   */
  async getCapabilities(model) {
    if (this.capabilities.has(model)) return this.capabilities.get(model);
    try {
      const info = await this._post("/api/show", { model }, AbortSignal.timeout(10000));
      const caps = new Set(info.capabilities ?? []);
      this.capabilities.set(model, caps);
      return caps;
    } catch (err) {
      log.warn(`Could not read capabilities of ${model}: ${err.message}`);
      return new Set();
    }
  }

  async supportsTools() {
    return (await this.getCapabilities(this.model)).has("tools");
  }

  async supportsVision() {
    return (await this.getCapabilities(this.visionModel)).has("vision");
  }

  // ─── Requests ──────────────────────────────────────────────────────────

  /**
   * Multi-turn chat with optional tool calling.
   * @param {object} req
   * @param {string} req.system
   * @param {object[]} req.messages Ollama chat messages (user/assistant/tool).
   * @param {object[]} [req.tools]  Ollama tool definitions.
   * @param {AbortSignal} [req.signal]
   * @returns {Promise<{ message: object, text: string, toolCalls: { name: string, args: object }[] }>}
   */
  async chat({ system, messages, tools, signal }) {
    const body = {
      model: this.model,
      messages: [{ role: "system", content: system }, ...messages],
      stream: false,
      keep_alive: this.keepAlive,
      options: this._options(),
    };
    if (tools?.length && (await this.supportsTools())) body.tools = tools;
    await this._applyThink(body, this.model);

    const res = await this._post("/api/chat", body, signal);
    const message = res.message ?? { role: "assistant", content: "" };
    const toolCalls = (message.tool_calls ?? []).map((tc) => ({
      name: tc.function?.name,
      args: parseArgs(tc.function?.arguments),
    }));

    return {
      message: { role: "assistant", content: message.content ?? "", ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) },
      text: stripThinking(message.content ?? ""),
      toolCalls: toolCalls.filter((tc) => tc.name),
    };
  }

  /**
   * Single-shot generation, optionally with images and/or a JSON schema.
   * @param {object} req
   * @param {string} [req.system]
   * @param {string} req.prompt
   * @param {Buffer[]} [req.images] JPEG images (uses the vision model).
   * @param {object} [req.schema]   JSON schema – the reply is parsed and returned as an object.
   * @param {number} [req.maxTokens]
   * @param {AbortSignal} [req.signal]
   * @returns {Promise<string|object>}
   */
  async generate({ system, prompt, images, schema, maxTokens, signal }) {
    const model = images?.length ? this.visionModel : this.model;
    const user = { role: "user", content: prompt };
    if (images?.length) user.images = images.map((img) => img.toString("base64"));

    const body = {
      model,
      messages: system ? [{ role: "system", content: system }, user] : [user],
      stream: false,
      keep_alive: this.keepAlive,
      options: this._options(maxTokens),
    };
    if (schema) {
      body.format = schema;
      body.options.temperature = Math.min(this.temperature, 0.3);
    }
    await this._applyThink(body, model);

    const res = await this._post("/api/chat", body, signal);
    const text = stripThinking(res.message?.content ?? "");
    if (!schema) return text;

    try {
      return JSON.parse(text);
    } catch {
      // Some models wrap JSON in prose or code fences despite `format`.
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error("The model did not return valid JSON.");
    }
  }

  /**
   * Load the chat (and vision) model into memory so the first question is fast.
   */
  async warmUp() {
    const models = [...new Set([this.model, this.visionModel])];
    await Promise.all(
      models.map((model) =>
        this._post("/api/chat", { model, messages: [], keep_alive: this.keepAlive }, AbortSignal.timeout(this.timeoutMs)),
      ),
    );
  }

  /**
   * @returns {Promise<string[]>} Human-readable problems (empty when healthy).
   */
  async healthCheck() {
    let tags;
    try {
      const res = await fetch(`${this.url}/api/tags`, { signal: AbortSignal.timeout(5000) });
      tags = await res.json();
    } catch {
      return [`Cannot reach Ollama at ${this.url}. Is it installed and running? (systemctl status ollama)`];
    }

    const installed = new Set();
    for (const m of tags.models ?? []) {
      installed.add(m.name);
      if (m.name.endsWith(":latest")) installed.add(m.name.slice(0, -":latest".length));
    }

    const problems = [];
    for (const model of new Set([this.model, this.visionModel])) {
      if (!installed.has(model)) problems.push(`Ollama model "${model}" is not installed. Run: ollama pull ${model}`);
    }
    if (problems.length) return problems;

    if (!(await this.supportsVision())) {
      problems.push(`"${this.visionModel}" has no vision support, so camera features are disabled. Use a vision model such as qwen3.5:4b.`);
    }
    if (!(await this.supportsTools())) {
      log.warn(`"${this.model}" has no tool-calling support; Jarvis will rely on built-in intent detection only.`);
    }
    return problems;
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  _options(maxTokens) {
    return {
      temperature: this.temperature,
      num_predict: maxTokens ?? this.maxTokens,
      num_ctx: this.contextSize,
    };
  }

  async _applyThink(body, model) {
    // Only send `think` to models that understand it; others reject the field.
    if ((await this.getCapabilities(model)).has("thinking")) body.think = this.think;
  }

  async _post(endpoint, body, signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await fetch(`${this.url}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).error ?? "";
      } catch {
        // Non-JSON error body.
      }
      throw new Error(`Ollama ${endpoint} failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
    }
    return res.json();
  }
}

function parseArgs(args) {
  if (!args) return {};
  if (typeof args === "object") return args;
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

/** Remove inline <think>…</think> blocks some models emit in their content. */
function stripThinking(text) {
  return String(text).replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}

module.exports = Ollama;
