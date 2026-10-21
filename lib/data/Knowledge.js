"use strict";

const Http = require("./http");

const CACHE_MS = 6 * 60 * 60 * 1000;
// Words that make a question, not a topic: "who is", "tell me about", "what's the"…
const QUESTION_WORDS = /^(?:(?:hey|ok|okay|so|and|um|uh)\s+)*(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:tell me (?:about|who|what)|what do you know about|who (?:is|was|are|were)|what (?:is|was|are|were)|what's|whats|who's|whos|where (?:is|was|are)|when (?:is|was|did|does)|how (?:many|much|tall|old|big|far|long|deep|high|heavy)(?: is| are| was| were| does| did)?|which|why (?:is|are|was|do|does|did)|explain|describe|define)\s+/i;

/**
 * Facts from Wikipedia (no key): a search, then the page summary with its
 * lead image. Used two ways:
 *  - "who is…", "tell me about…" are answered straight from the summary and
 *    shown as a card with the picture;
 *  - other factual questions pass the summary to the language model as a
 *    reference, so a small local model answers from facts instead of
 *    guessing.
 */
class Knowledge {
  /**
   * @param {{ http?: Http, language?: string }} [options]
   */
  constructor({ http = new Http(), language = "en" } = {}) {
    this.http = http;
    this.base = `https://${String(language || "en").slice(0, 2)}.wikipedia.org`;
  }

  /**
   * Best Wikipedia page for a question or topic.
   * @param {string} query e.g. "who is Taylor Swift", "the Eiffel Tower", "tallest building in the world"
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ title: string, description: string, extract: string, image: string|null, url: string } | null>}
   */
  async lookup(query, signal) {
    const topic = Knowledge.topic(query);
    if (!topic) return null;
    const search = await this.http.json(`${this.base}/w/rest.php/v1/search/page?q=${encodeURIComponent(topic)}&limit=4`, { signal, cacheMs: CACHE_MS });
    for (const page of search.pages ?? []) {
      const summary = await this.summary(page.key, signal).catch(() => null);
      if (summary && summary.extract) return summary;
    }
    return null;
  }

  /**
   * @param {string} key Page key ("Eiffel_Tower").
   * @param {AbortSignal} [signal]
   */
  async summary(key, signal) {
    const s = await this.http.json(`${this.base}/api/rest_v1/page/summary/${encodeURIComponent(key)}`, { signal, cacheMs: CACHE_MS });
    if (s.type === "disambiguation" || !s.extract) return null;
    return {
      title: s.title,
      description: s.description ?? "",
      extract: s.extract,
      image: s.thumbnail?.source ?? s.originalimage?.source ?? null,
      url: s.content_urls?.desktop?.page ?? `${this.base}/wiki/${encodeURIComponent(key)}`,
    };
  }

  /**
   * The topic of a question: "who is the president of France?" → "the president of France".
   * @param {string} query
   */
  static topic(query) {
    return String(query ?? "")
      .trim()
      .replace(QUESTION_WORDS, "")
      .replace(/[?.!]+$/, "")
      .replace(/^(?:a|an)\s+/i, "")
      .trim();
  }

  /**
   * The first sentences of an extract, ready to speak: no parentheses (birth
   * dates, pronunciations), at most `maxChars`.
   * @param {string} extract
   * @param {number} [maxSentences=2]
   * @param {number} [maxChars=320]
   */
  static spoken(extract, maxSentences = 2, maxChars = 320) {
    const clean = String(extract ?? "")
      .replace(/\s*\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "")
      .replace(/\s*\[[^\]]*\]/g, "")
      .replace(/\s+([,.;])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    // Split on sentence ends, but not after initials or common abbreviations ("U.S.", "Dr.", "St.").
    const sentences = clean.match(/(?:[^.!?]|\.(?=\S)|\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|No|Mt|U\.S|e\.g|i\.e)\.\s)+[.!?]+/g) ?? [clean];
    let out = "";
    for (const s of sentences.slice(0, maxSentences)) {
      const next = out ? `${out} ${s.trim()}` : s.trim();
      if (out && next.length > maxChars) break;
      out = next;
    }
    return out.length > maxChars ? `${out.slice(0, maxChars).replace(/\s+\S*$/, "")}…` : out;
  }
}

module.exports = Knowledge;
