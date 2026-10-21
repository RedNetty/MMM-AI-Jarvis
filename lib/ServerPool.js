"use strict";

const { EventEmitter } = require("events");
const log = require("./log");

const NETWORK_ERRORS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * An ordered list of equivalent servers (e.g. Ollama on a MacBook, then
 * Ollama on the Pi itself) with automatic failover.
 *
 * Each server is probed in the background, so a request never has to wait
 * for a sleeping machine to time out: it goes straight to the first server
 * that answered its last health check. If a request still fails with a
 * network error, that server is marked down and the next one is tried. When
 * a preferred server comes back, traffic returns to it on the next probe.
 *
 * Events: "change" ({ from, to }) when the active server changes.
 */
class ServerPool extends EventEmitter {
  /**
   * @param {object[]} servers Ordered by preference; each needs a `url`, other fields are kept.
   * @param {object} [options]
   * @param {string} [options.label="server"]   For log messages.
   * @param {string} [options.probePath="/"]    Path requested by the health probe.
   * @param {number} [options.intervalMs=15000] Probe interval.
   * @param {number} [options.timeoutMs=1500]   A server slower than this to answer a probe counts as down.
   * @param {boolean} [options.probeSingle=false] Probe even a single server (for callers that fall back to something else when it's down).
   */
  constructor(servers, { label = "server", probePath = "/", intervalMs = 15000, timeoutMs = 1500, probeSingle = false } = {}) {
    super();
    if (!servers.length) throw new Error(`No ${label} configured.`);
    this.label = label;
    this.probePath = probePath;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.probeSingle = probeSingle;
    this.servers = servers.map((s) => ({ ...s, url: String(s.url).replace(/\/+$/, ""), up: true }));
    this.timer = null;
    this.lastActive = this.servers[0];
  }

  /**
   * Accept "url", ["url", …] or [{ url, … }, …].
   * @param {string|string[]|object[]} value
   * @returns {object[]}
   */
  static normalize(value) {
    const list = Array.isArray(value) ? value : [value];
    return list.filter(Boolean).map((s) => (typeof s === "string" ? { url: s } : s));
  }

  get size() {
    return this.servers.length;
  }

  /** The server requests currently go to. */
  get active() {
    return this.servers.find((s) => s.up) ?? this.servers[0];
  }

  /** True when at least one server answered its last probe or request. */
  get anyUp() {
    return this.servers.some((s) => s.up);
  }

  /** Start background health probes (only useful with more than one server, unless probeSingle). */
  start() {
    if (this.timer || (this.servers.length < 2 && !this.probeSingle)) return;
    const probe = () => this.probeAll().catch(() => {});
    probe();
    this.timer = setInterval(probe, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async probeAll() {
    await Promise.all(this.servers.map((s) => this._probe(s)));
    this._noteActive();
  }

  /**
   * Run a request against the active server, failing over on network errors.
   * @template T
   * @param {(server: object) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async run(fn) {
    const order = [...this.servers.filter((s) => s.up), ...this.servers.filter((s) => !s.up)];
    let lastError;
    for (const server of order) {
      try {
        const result = await fn(server);
        if (!server.up) {
          server.up = true;
          this._noteActive();
        }
        return result;
      } catch (err) {
        if (!ServerPool.isNetworkError(err)) throw err;
        lastError = err;
        if (server.up) {
          server.up = false;
          log.warn(`${this.label} at ${server.url} is unreachable (${err.cause?.code ?? err.message}).`);
          this._noteActive();
        }
      }
    }
    throw lastError;
  }

  /**
   * True for "can't reach the server" failures (as opposed to the server
   * answering with an error, which failing over would not fix).
   * @param {Error} err
   */
  static isNetworkError(err) {
    if (!err) return false;
    const code = err.cause?.code ?? err.code;
    if (NETWORK_ERRORS.has(code)) return true;
    return err.name === "TypeError" && /fetch failed/i.test(err.message);
  }

  async _probe(server) {
    try {
      const res = await fetch(`${server.url}${this.probePath}`, { signal: AbortSignal.timeout(this.timeoutMs) });
      server.up = res.status < 500;
    } catch {
      server.up = false;
    }
  }

  _noteActive() {
    const active = this.active;
    if (active === this.lastActive) return;
    log.info(`${this.label}: now using ${active.url}${active.model ? ` (${active.model})` : ""}.`);
    this.emit("change", { from: this.lastActive, to: active });
    this.lastActive = active;
  }
}

module.exports = ServerPool;
