"use strict";

const Http = require("./http");

const CACHE_MS = 10 * 60 * 1000;

// Google News topic sections ("tech news", "sports headlines").
const TOPICS = {
  world: "WORLD",
  national: "NATION",
  business: "BUSINESS",
  technology: "TECHNOLOGY",
  entertainment: "ENTERTAINMENT",
  sports: "SPORTS",
  science: "SCIENCE",
  health: "HEALTH",
};
const TOPIC_WORDS = [
  [/\b(?:tech|technology|gadgets?|ai)\b/, "technology"],
  [/\b(?:business|economy|economic|financial|finance|markets?)\b/, "business"],
  [/\b(?:world|international|global)\b/, "world"],
  [/\b(?:national|local|domestic|us|u s|uk)\b/, "national"],
  [/\b(?:entertainment|celebrity|movies?|film|music|tv|showbiz)\b/, "entertainment"],
  [/\b(?:sports?|sporting)\b/, "sports"],
  [/\b(?:science|space|scientific)\b/, "science"],
  [/\b(?:health|medical|medicine)\b/, "health"],
];

/**
 * Headlines from Google News RSS (no key): top stories, a topic ("tech
 * news") or anything at all ("the latest on SpaceX"). Optionally other RSS
 * feeds from the config.
 */
class News {
  /**
   * @param {{ http?: Http, locale?: string, feeds?: string[] }} [options]
   *   feeds: extra RSS URLs used for "the news" instead of Google's top stories.
   */
  constructor({ http = new Http(), locale = "en-US", feeds = [] } = {}) {
    this.http = http;
    const [lang, region] = String(locale || "en-US").split(/[-_]/);
    this.hl = `${lang}-${(region || "US").toUpperCase()}`;
    this.gl = (region || "US").toUpperCase();
    this.ceid = `${this.gl}:${lang}`;
    this.feeds = feeds;
  }

  /**
   * Work out what was asked for: { topic } for a section, { query } for a
   * subject, or {} for the top stories.
   * @param {string} request e.g. "what's the tech news", "any news about the election"
   */
  static parse(request) {
    const q = String(request ?? "").toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
    const about = /\b(?:news|headlines|latest|happening|update|updates|stories)\s+(?:on|about|with|regarding|for|from)\s+(?:the\s+)?(.+)$/.exec(q)
      ?? /\b(?:latest|what's new|whats new|what is new|anything new)\s+(?:on|about|with|in)\s+(?:the\s+)?(.+)$/.exec(q);
    const subject = about?.[1]?.replace(/\b(?:today|right now|now|please|this week)\b/g, "").trim();
    if (subject) {
      for (const [re, topic] of TOPIC_WORDS) if (re.test(subject) && subject.split(" ").length === 1) return { topic };
      return { query: subject };
    }
    for (const [re, topic] of TOPIC_WORDS) if (re.test(q)) return { topic };
    return {};
  }

  /**
   * @param {{ topic?: string, query?: string }} [what]
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ title: string, items: { title: string, source: string, link: string, published: string|null, image: string|null }[] }>}
   */
  async headlines({ topic, query } = {}, signal) {
    const g = `hl=${this.hl}&gl=${this.gl}&ceid=${encodeURIComponent(this.ceid)}`;
    let url;
    let title;
    if (query) {
      url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:3d`)}&${g}`;
      title = capitalize(query);
    } else if (topic && TOPICS[topic]) {
      url = `https://news.google.com/rss/headlines/section/topic/${TOPICS[topic]}?${g}`;
      title = `${capitalize(topic)} news`;
    } else if (this.feeds.length) {
      const lists = await Promise.all(this.feeds.map((f) => this.http.text(f, { signal, cacheMs: CACHE_MS }).then(News.parseRss).catch(() => [])));
      const items = interleave(lists);
      return { title: "Headlines", items: dedupe(items).slice(0, 12) };
    } else {
      url = `https://news.google.com/rss?${g}`;
      title = "Headlines";
    }
    const xml = await this.http.text(url, { signal, cacheMs: CACHE_MS });
    return { title, items: dedupe(News.parseRss(xml)).slice(0, 12) };
  }

  /**
   * Minimal RSS 2.0 parser: title, link, source, date and image of each item.
   * @param {string} xml
   */
  static parseRss(xml) {
    const items = [];
    for (const [, body] of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
      const tag = (name) => {
        const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(body);
        return m ? decode(m[1]) : "";
      };
      let title = tag("title");
      let source = tag("source");
      // Google News titles end with " - Source".
      const dash = / - ([^-]{2,60})$/.exec(title);
      if (dash && (!source || dash[1].trim() === source.trim())) {
        source = source || dash[1].trim();
        title = title.slice(0, dash.index).trim();
      }
      const image = /<media:(?:content|thumbnail)\b[^>]*url="([^"]+)"/.exec(body)?.[1] ?? /<enclosure\b[^>]*url="([^"]+)"[^>]*type="image/.exec(body)?.[1] ?? null;
      const date = Date.parse(tag("pubDate"));
      if (title) items.push({ title, source, link: tag("link"), published: Number.isFinite(date) ? new Date(date).toISOString() : null, image: image ? decode(image) : null });
    }
    return items;
  }
}

function decode(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((i) => {
    const key = i.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function interleave(lists) {
  const out = [];
  for (let i = 0; lists.some((l) => l[i]); i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

News.TOPICS = TOPICS;
module.exports = News;
