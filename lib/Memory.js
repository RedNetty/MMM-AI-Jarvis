"use strict";

const crypto = require("crypto");
const path = require("path");
const JsonStore = require("./JsonStore");
const { normalize } = require("./text");

const MAX_FACTS = 60;

/**
 * Long-term memory of facts about the user ("I hate wearing yellow",
 * "my office is business casual"). Facts are injected into every prompt so
 * the assistant stays personal across restarts.
 */
class Memory {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.store = new JsonStore(path.join(dataDir, "memory.json"), { version: 1, facts: [] });
  }

  get facts() {
    return this.store.data.facts;
  }

  /**
   * Remember a fact. Exact duplicates are ignored; the oldest facts are
   * dropped once the limit is reached.
   * @param {string} text
   */
  add(text) {
    const clean = String(text ?? "").trim().replace(/\s+/g, " ").slice(0, 240);
    if (!clean) throw new Error("Nothing to remember.");

    const existing = this.facts.find((f) => normalize(f.text) === normalize(clean));
    if (existing) return existing;

    const fact = { id: crypto.randomBytes(3).toString("hex"), text: clean, createdAt: new Date().toISOString() };
    this.facts.push(fact);
    if (this.facts.length > MAX_FACTS) this.facts.splice(0, this.facts.length - MAX_FACTS);
    this.store.save();
    return fact;
  }

  /**
   * Forget facts matching a description. Matches by id, then by word overlap.
   * @param {string} query
   * @returns {object[]} The removed facts.
   */
  remove(query) {
    const q = normalize(query);
    if (!q) return [];

    const tokens = q.split(" ").filter((t) => t.length > 2);
    const matches = this.facts.filter((f) => {
      if (f.id === query) return true;
      const hay = normalize(f.text);
      if (hay.includes(q)) return true;
      if (tokens.length === 0) return false;
      return tokens.filter((t) => hay.includes(t)).length / tokens.length >= 0.6;
    });

    if (matches.length) {
      const ids = new Set(matches.map((m) => m.id));
      this.store.data.facts = this.facts.filter((f) => !ids.has(f.id));
      this.store.save();
    }
    return matches;
  }

  clear() {
    this.store.data.facts = [];
    this.store.save();
  }

  describeForPrompt() {
    return this.facts.map((f) => `- ${f.text}`).join("\n");
  }
}

module.exports = Memory;
