"use strict";

const Http = require("./http");

const CACHE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Word definitions from the Free Dictionary API (no key).
 */
class Dictionary {
  /**
   * @param {{ http?: Http }} [options]
   */
  constructor({ http = new Http() } = {}) {
    this.http = http;
  }

  /**
   * The word in "define serendipity", "what does ephemeral mean", "meaning of ubiquitous".
   * @param {string} text
   * @returns {string|null}
   */
  static word(text) {
    const t = String(text ?? "").trim().replace(/[?.!]+$/, "");
    const m = /^(?:please\s+)?(?:define|definition of|what(?:'s| is) the (?:definition|meaning) of|meaning of|what does)\s+(?:the word\s+)?["']?([a-z][a-z' -]{1,30}?)["']?(?:\s+mean)?$/i.exec(t)
      ?? /^what(?:'s| is) (?:a|an)?\s*["']?([a-z][a-z'-]{2,25})["']?\s+mean$/i.exec(t);
    return m ? m[1].trim().toLowerCase() : null;
  }

  /**
   * @param {string} word
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ word: string, phonetic: string, meanings: { partOfSpeech: string, definition: string, example: string }[] } | null>}
   */
  async define(word, signal) {
    let res;
    try {
      res = await this.http.json(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { signal, cacheMs: CACHE_MS });
    } catch {
      // The Free Dictionary API is sometimes down or answers "not found" when
      // busy; Wiktionary has the same words.
      return this._wiktionary(word, signal);
    }
    const entry = Array.isArray(res) ? res[0] : null;
    if (!entry) return this._wiktionary(word, signal);
    const meanings = (entry.meanings ?? []).slice(0, 3).map((m) => ({
      partOfSpeech: m.partOfSpeech ?? "",
      definition: m.definitions?.[0]?.definition ?? "",
      example: m.definitions?.[0]?.example ?? "",
    })).filter((m) => m.definition);
    if (!meanings.length) return null;
    return { word: entry.word ?? word, phonetic: entry.phonetic ?? entry.phonetics?.find((p) => p.text)?.text ?? "", meanings };
  }

  async _wiktionary(word, signal) {
    let res;
    try {
      res = await this.http.json(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`, { signal, cacheMs: CACHE_MS });
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
    const strip = (html) => String(html ?? "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    const meanings = (res.en ?? []).slice(0, 3).map((m) => {
      const d = (m.definitions ?? []).find((x) => strip(x.definition)) ?? {};
      return { partOfSpeech: String(m.partOfSpeech ?? "").toLowerCase(), definition: strip(d.definition), example: strip(d.examples?.[0]) };
    }).filter((m) => m.definition);
    return meanings.length ? { word, phonetic: "", meanings } : null;
  }

  /** "Serendipity, a noun: an unsought, unintended, and/or unexpected discovery." */
  static describe(d) {
    const m = d.meanings[0];
    const pos = m.partOfSpeech ? `, ${/^[aeiou]/.test(m.partOfSpeech) ? "an" : "a"} ${m.partOfSpeech}` : "";
    return `${d.word[0].toUpperCase()}${d.word.slice(1)}${pos}: ${m.definition.replace(/\.$/, "")}.`;
  }
}

module.exports = Dictionary;
