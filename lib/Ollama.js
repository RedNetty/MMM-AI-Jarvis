"use strict";

const ServerPool = require("./ServerPool");
const log = require("./log");

/**
 * Client for Ollama (https://ollama.com) with optional failover.
 *
 * Ollama can run on the mirror's Raspberry Pi, or on a faster computer on
 * your network such as an Apple Silicon Mac, whose GPU makes answers far
 * quicker. List several servers and Iris uses the first one that is up,
 * each with its own model:
 *
 *   servers: [
 *     { url: "http://macbook.local:11434", model: "qwen3.5:4b" },   // fast, when the Mac is on
 *     { url: "http://127.0.0.1:11434",     model: "qwen3.5:2b" },   // the Pi itself, as a fallback
 *   ]
 *
 * Model capabilities (vision, tool calling, thinking) are read from Ollama
 * so the assistant adapts to whichever model is answering.
 */
class Ollama {
  /**
   * @param {object} options
   * @param {object[]} [options.servers] [{ url, model, visionModel? }], in order of preference.
   * @param {string} [options.url]          Single server (used when `servers` is not given).
   * @param {string} [options.model]        Model for the single server, and default for servers without one.
   * @param {string} [options.visionModel]  Model for camera images; defaults to `model`.
   * @param {string|number} [options.keepAlive=-1] How long Ollama keeps the model in RAM (-1 = forever).
   * @param {number} [options.temperature=0.4]
   * @param {number} [options.maxTokens=160]
   * @param {number} [options.contextSize=4096]
   * @param {boolean} [options.think=false] Enable "thinking" on models that support it (much slower).
   * @param {number} [options.timeoutMs=300000]
   */
  constructor(options) {
    const servers = options.servers?.length
      ? ServerPool.normalize(options.servers)
      : [{ url: options.url ?? "http://127.0.0.1:11434" }];
    this.pool = new ServerPool(
      servers.map((s) => ({
        url: s.url,
        model: s.model || options.model,
        visionModel: s.visionModel || options.visionModel || s.model || options.model,
      })),
      { label: "Ollama", probePath: "/api/version" },
    );
    this.keepAlive = options.keepAlive ?? -1;
    this.temperature = options.temperature ?? 0.4;
    this.maxTokens = options.maxTokens ?? 160;
    this.contextSize = options.contextSize ?? 4096;
    this.think = Boolean(options.think);
    this.timeoutMs = options.timeoutMs ?? 300000;

    /** @type {Map<string, Set<string>>} "url|model" → capabilities */
    this.capabilities = new Map();
  }

  /** URL of the server currently answering. */
  get url() {
    return this.pool.active.url;
  }

  /** Chat model of the server currently answering. */
  get model() {
    return this.pool.active.model;
  }

  get visionModel() {
    return this.pool.active.visionModel;
  }

  /** Start background health checks when there is more than one server. */
  start() {
    this.pool.start();
  }

  stop() {
    this.pool.stop();
  }

  // ─── Capabilities ──────────────────────────────────────────────────────

  /**
   * Fetch (and cache) a model's capabilities on a server, e.g.
   * {"completion","vision","tools","thinking"}. Unknown or older Ollama
   * versions yield an empty set, which means "assume text only".
   * @param {object} server
   * @param {string} model
   */
  async getCapabilities(server, model) {
    const key = `${server.url}|${model}`;
    if (this.capabilities.has(key)) return this.capabilities.get(key);
    try {
      const res = await this._fetchFrom(server, "/api/show", { model }, AbortSignal.timeout(10000));
      const caps = new Set((await res.json()).capabilities ?? []);
      this.capabilities.set(key, caps);
      return caps;
    } catch (err) {
      if (ServerPool.isNetworkError(err)) throw err;
      log.warn(`Could not read capabilities of ${model} at ${server.url}: ${err.message}`);
      return new Set();
    }
  }

  async supportsTools() {
    const s = this.pool.active;
    return (await this.getCapabilities(s, s.model).catch(() => new Set())).has("tools");
  }

  async supportsVision() {
    const s = this.pool.active;
    return (await this.getCapabilities(s, s.visionModel).catch(() => new Set())).has("vision");
  }

  // ─── Requests ──────────────────────────────────────────────────────────

  /**
   * Multi-turn chat with optional tool calling and streaming.
   * @param {object} req
   * @param {string} req.system
   * @param {object[]} req.messages Ollama chat messages (user/assistant/tool).
   * @param {object[]} [req.tools]  Ollama tool definitions.
   * @param {(delta: string) => void} [req.onText] Receives answer text as it is generated.
   * @param {number} [req.maxTokens]
   * @param {AbortSignal} [req.signal]
   * @returns {Promise<{ message: object, text: string, toolCalls: { name: string, args: object }[], truncated: boolean }>}
   *   truncated is true when generation stopped at the token limit (mid-sentence).
   */
  async chat({ system, messages, tools, onText, maxTokens, signal }) {
    const res = await this.pool.run(async (server) => {
      const caps = await this.getCapabilities(server, server.model);
      const body = {
        model: server.model,
        messages: [{ role: "system", content: system }, ...messages],
        stream: Boolean(onText),
        keep_alive: this.keepAlive,
        options: this._options(maxTokens),
      };
      if (tools?.length && caps.has("tools")) body.tools = tools;
      if (caps.has("thinking")) body.think = this.think;

      // Once text has streamed out it can't be taken back, so a server that
      // drops mid-answer surfaces as an error instead of a silent retry.
      return onText ? this._stream(server, body, signal, onText) : (await this._fetchFrom(server, "/api/chat", body, signal)).json();
    });
    this._logStats("chat", res);

    const message = res.message ?? { role: "assistant", content: "" };
    const toolCalls = (message.tool_calls ?? []).map((tc) => ({
      name: tc.function?.name,
      args: parseArgs(tc.function?.arguments),
    }));

    return {
      message: { role: "assistant", content: message.content ?? "", ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) },
      text: stripThinking(message.content ?? ""),
      toolCalls: toolCalls.filter((tc) => tc.name),
      truncated: res.done_reason === "length",
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
    const user = { role: "user", content: prompt };
    if (images?.length) user.images = images.map((img) => img.toString("base64"));

    const res = await this.pool.run(async (server) => {
      const model = images?.length ? server.visionModel : server.model;
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
      if ((await this.getCapabilities(server, model)).has("thinking")) body.think = this.think;
      return (await this._fetchFrom(server, "/api/chat", body, signal)).json();
    });
    this._logStats(schema ? "json" : "generate", res);

    const text = stripThinking(res.message?.content ?? "");
    if (!schema) return text;
    try {
      return JSON.parse(text);
    } catch {
      // Output cut off at the token limit (or wrapped in prose): keep every
      // array entry that was written completely.
      const repaired = repairJson(text);
      if (repaired !== null) {
        log.warn("The model's JSON was incomplete; keeping the complete entries.");
        return JSON.parse(repaired);
      }
      throw new Error("The model did not return valid JSON.");
    }
  }

  /**
   * Load the model into memory and pre-process the given prompt prefix so
   * the first real question starts quickly.
   * @param {{ system?: string, tools?: object[] }} [prefix]
   */
  async warmUp(prefix = {}) {
    const started = Date.now();
    await this.chat({
      system: prefix.system ?? "",
      messages: [{ role: "user", content: "Hi" }],
      tools: prefix.tools,
      maxTokens: 1,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const s = this.pool.active;
    if (s.visionModel !== s.model) {
      await this._fetchFrom(s, "/api/chat", { model: s.visionModel, messages: [], keep_alive: this.keepAlive }, AbortSignal.timeout(this.timeoutMs));
    }
    log.info(`Model ${s.model} ready at ${s.url} in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  }

  /**
   * Check every configured server.
   * @returns {Promise<{ problems: string[], usable: boolean }>} usable = at least one server can answer.
   */
  async healthCheck() {
    const problems = [];
    let usable = false;

    for (const server of this.pool.servers) {
      let tags;
      try {
        const res = await fetch(`${server.url}/api/tags`, { signal: AbortSignal.timeout(4000) });
        tags = await res.json();
        server.up = true;
      } catch {
        server.up = false;
        problems.push(
          this.pool.size > 1
            ? `Ollama at ${server.url} is not reachable${usable ? "" : "; trying the next server"}.`
            : `Cannot reach Ollama at ${server.url}. Is it installed and running? (systemctl status ollama)`,
        );
        continue;
      }

      const installed = new Set();
      for (const m of tags.models ?? []) {
        installed.add(m.name);
        if (m.name.endsWith(":latest")) installed.add(m.name.slice(0, -":latest".length));
      }
      const missing = [...new Set([server.model, server.visionModel])].filter((m) => !installed.has(m));
      if (missing.length) {
        server.up = false;
        problems.push(...missing.map((m) => `Ollama model "${m}" is not installed at ${server.url}. Run: ollama pull ${m}`));
        continue;
      }

      usable = true;
      const vision = await this.getCapabilities(server, server.visionModel).catch(() => new Set());
      if (!vision.has("vision")) {
        problems.push(`"${server.visionModel}" has no vision support, so camera features are disabled. Use qwen3.5 (any size).`);
      }
    }

    this.pool._noteActive();
    // With failover, an unreachable *preferred* server is only worth a log
    // line as long as another one is answering.
    if (usable && this.pool.size > 1) {
      for (const p of problems.filter((x) => / is not reachable/.test(x))) log.warn(p);
      return { problems: problems.filter((x) => !/ is not reachable/.test(x)), usable };
    }
    return { problems, usable };
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  _options(maxTokens) {
    return {
      temperature: this.temperature,
      num_predict: maxTokens ?? this.maxTokens,
      num_ctx: this.contextSize,
    };
  }

  _logStats(kind, res) {
    if (res?.prompt_eval_count === undefined && res?.eval_count === undefined) return;
    const s = (ns) => ((ns ?? 0) / 1e9).toFixed(1);
    log.debug(
      `LLM ${kind} @ ${this.url}: read ${res.prompt_eval_count ?? 0} prompt tokens in ${s(res.prompt_eval_duration)}s, ` +
        `wrote ${res.eval_count ?? 0} tokens in ${s(res.eval_duration)}s` +
        (res.load_duration > 5e8 ? `, model load ${s(res.load_duration)}s` : ""),
    );
  }

  /**
   * POST a streaming chat request; forwards content deltas and returns the
   * assembled final response in the same shape as a non-streaming call.
   */
  async _stream(server, body, signal, onText) {
    const res = await this._fetchFrom(server, "/api/chat", body, signal);
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const toolCalls = [];
    let final = {};

    const handle = (line) => {
      if (!line.trim()) return;
      const chunk = JSON.parse(line);
      if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
      const delta = chunk.message?.content ?? "";
      if (delta) {
        content += delta;
        onText(delta);
      }
      if (chunk.message?.tool_calls) toolCalls.push(...chunk.message.tool_calls);
      if (chunk.done) final = chunk;
    };

    try {
      for await (const part of res.body) {
        buffer += decoder.decode(part, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          handle(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      }
      handle(buffer);
    } catch (err) {
      // Words already spoken can't be unsaid: don't let the pool retry this
      // answer on another server (it would repeat itself).
      if (content && ServerPool.isNetworkError(err)) throw new Error(`Lost connection to ${server.url} mid-answer.`);
      throw err;
    }

    return {
      ...final,
      message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    };
  }

  async _fetchFrom(server, endpoint, body, signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await fetch(`${server.url}${endpoint}`, {
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
    return res;
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

/**
 * Return the first complete JSON object in `text`, or – when it was cut off –
 * the object with its unfinished array entry dropped and brackets closed:
 *   '{"items":[{"a":1},{"b":'  →  '{"items":[{"a":1}]}'
 * @param {string} text
 * @returns {string|null}
 */
function repairJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const closers = [];
  let inString = false;
  let escaped = false;
  let safeEnd = -1;
  let safeClosers = null;

  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") closers.push("}");
    else if (c === "[") closers.push("]");
    else if (c === "}" || c === "]") {
      closers.pop();
      if (closers.length === 0) return text.slice(start, i + 1);
      // Just finished an element inside an array: a safe place to cut.
      if (closers.at(-1) === "]") {
        safeEnd = i + 1;
        safeClosers = [...closers];
      }
    }
  }
  return safeEnd < 0 ? null : text.slice(start, safeEnd) + safeClosers.reverse().join("");
}

/** Remove inline <think>…</think> blocks some models emit in their content. */
function stripThinking(text) {
  return String(text).replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}

Ollama.repairJson = repairJson;
module.exports = Ollama;
