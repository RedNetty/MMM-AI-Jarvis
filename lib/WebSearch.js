"use strict";

/**
 * Optional web search through a self-hosted SearXNG instance
 * (https://docs.searxng.org). No API keys, no tracking, and it can run on
 * the same Pi in Docker. The instance must have the JSON output format
 * enabled (search.formats: [html, json] in settings.yml).
 */
class WebSearch {
  /**
   * @param {{ url: string, maxResults?: number, language?: string }} options
   */
  constructor({ url, maxResults = 5, language = "en" }) {
    this.url = url.replace(/\/+$/, "");
    this.maxResults = maxResults;
    this.language = language;
  }

  /**
   * @param {string} query
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ title: string, snippet: string, source: string }[]>}
   */
  async search(query, signal) {
    const params = new URLSearchParams({ q: query, format: "json", language: this.language, safesearch: "1" });
    const timeout = AbortSignal.timeout(8000);
    const res = await fetch(`${this.url}/search?${params}`, {
      headers: { Accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    if (res.status === 403) {
      throw new Error("SearXNG refused JSON output. Add 'json' to search.formats in its settings.yml.");
    }
    if (!res.ok) throw new Error(`SearXNG returned HTTP ${res.status}.`);

    const body = await res.json();
    const answers = (body.answers ?? []).map((a) => ({
      title: "Instant answer",
      snippet: typeof a === "string" ? a : a.answer ?? "",
      source: "searxng",
    }));
    const results = (body.results ?? []).map((r) => ({
      title: String(r.title ?? "").slice(0, 120),
      snippet: String(r.content ?? "").slice(0, 400),
      source: safeHost(r.url),
    }));

    return [...answers, ...results].filter((r) => r.snippet || r.title).slice(0, this.maxResults);
  }
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

module.exports = WebSearch;
