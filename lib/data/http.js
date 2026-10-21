"use strict";

/**
 * Small HTTP helper for the keyless public data sources (Wikipedia, news
 * feeds, markets, currency, dictionary, geocoding): a polite User-Agent
 * (Wikipedia rate-limits anonymous clients without one), a timeout that
 * combines with the request's abort signal, and an in-memory cache so
 * repeated questions ("and what about…") don't refetch.
 */

const USER_AGENT = "MMM-AI-Jarvis/3.2 (IRIS smart mirror; https://github.com/RedNetty/MMM-AI-Jarvis)";
const MAX_CACHE_ENTRIES = 300;

class Http {
  /**
   * @param {{ timeoutMs?: number, fetch?: typeof fetch }} [options] fetch is injectable for tests.
   */
  constructor({ timeoutMs = 6000, fetch: fetchImpl = (...args) => fetch(...args) } = {}) {
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    /** @type {Map<string, { at: number, value: any }>} */
    this.cache = new Map();
  }

  /**
   * @param {string} url
   * @param {{ signal?: AbortSignal, cacheMs?: number, headers?: object }} [options]
   * @returns {Promise<any>}
   */
  json(url, options = {}) {
    return this._get(url, options, (res) => res.json());
  }

  /**
   * @param {string} url
   * @param {{ signal?: AbortSignal, cacheMs?: number, headers?: object }} [options]
   * @returns {Promise<string>}
   */
  text(url, options = {}) {
    return this._get(url, options, (res) => res.text());
  }

  async _get(url, { signal, cacheMs = 0, headers = {} }, read) {
    const cached = this.cache.get(url);
    if (cacheMs && cached && Date.now() - cached.at < cacheMs) return cached.value;

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json, application/xml;q=0.9, */*;q=0.8", ...headers },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      const err = new Error(`${new URL(url).host} returned HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const value = await read(res);
    if (cacheMs) {
      this.cache.set(url, { at: Date.now(), value });
      if (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value);
    }
    return value;
  }
}

Http.USER_AGENT = USER_AGENT;
module.exports = Http;
