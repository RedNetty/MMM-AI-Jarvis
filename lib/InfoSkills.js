"use strict";

const Http = require("./data/http");
const Knowledge = require("./data/Knowledge");
const News = require("./data/News");
const Markets = require("./data/Markets");
const Currency = require("./data/Currency");
const Dictionary = require("./data/Dictionary");
const Calculator = require("./data/Calculator");
const Weather = require("./Weather");
const WeatherTalk = require("./speech/weatherTalk");
const Talk = require("./speech/talk");
const log = require("./log");

const MARKET_REFRESH_MS = 60 * 1000;
const REFERENCE_TIMEOUT_MS = 1800;
// Home currency by region, for "what's the euro worth?"
const REGION_CURRENCY = { US: "USD", GB: "GBP", CA: "CAD", AU: "AUD", NZ: "NZD", IN: "INR", JP: "JPY", CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", MX: "MXN", BR: "BRL", ZA: "ZAR", CN: "CNY", KR: "KRW" };
const EURO_LANGS = /^(de|fr|es|it|nl|pt|fi|el|sk|sl|et|lv|lt|ga|mt|hr)\b/;

/**
 * Everyday knowledge and data, each answered in a sentence and shown as a
 * card that animates in: facts (Wikipedia), headlines, markets, currency,
 * definitions, maths and conversions, weather (here or anywhere), the time
 * elsewhere, countdowns, sunrise and sunset, and a morning briefing.
 *
 * Every source is free and needs no key. Answers come from data, never
 * from the language model's memory.
 */
class InfoSkills {
  /**
   * @param {object} deps
   * @param {import("./Widgets")} deps.widgets
   * @param {import("./Weather")} deps.weather
   * @param {import("./Clock")} deps.clock
   * @param {import("./Sports")|null} deps.sports
   * @param {object} deps.config Module config.
   * @param {() => Date} deps.now
   * @param {Http} [deps.http]
   */
  constructor({ widgets, weather, clock, sports, config, now, http = new Http() }) {
    this.widgets = widgets;
    this.weather = weather;
    this.clock = clock;
    this.sports = sports;
    this.config = config;
    this.now = now;
    const info = config.info ?? {};
    this.enabled = info.enabled !== false;
    this.knowledge = new Knowledge({ http, language: config.language });
    this.news = new News({ http, locale: config.locale, feeds: info.newsFeeds ?? [] });
    this.markets = new Markets({ http });
    this.currency = new Currency({ http, home: info.currency || homeCurrency(config.locale) });
    this.dictionary = new Dictionary({ http });
  }

  // ─── Facts ─────────────────────────────────────────────────────────────

  /**
   * "Who is Taylor Swift?", "tell me about the Eiffel Tower": answered from
   * Wikipedia with its picture. Falls through to the language model when
   * nothing fits.
   * @param {string} query
   * @param {AbortSignal} [signal]
   */
  async knowledgeAnswer(query, signal) {
    const page = await this.knowledge.lookup(query, signal).catch((err) => {
      log.warn(`Wikipedia lookup failed: ${err.message}`);
      return null;
    });
    if (!page) return { passThrough: true };
    this.showKnowledge(page);
    return { spoken: Knowledge.spoken(page.extract, 2), data: { source: `Wikipedia: ${page.title}` } };
  }

  /**
   * Background facts for a question the language model will answer. Bounded
   * by a short timeout so a slow network never holds the answer up.
   * @param {string} query
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ title: string, extract: string } | null>}
   */
  async reference(query, signal) {
    if (!this.enabled) return null;
    const timeout = AbortSignal.timeout(REFERENCE_TIMEOUT_MS);
    const page = await this.knowledge.lookup(query, signal ? AbortSignal.any([signal, timeout]) : timeout).catch(() => null);
    if (!page) return null;
    this.showKnowledge(page);
    return { title: page.title, extract: Knowledge.spoken(page.extract, 4, 700) };
  }

  /**
   * Fresh headlines about a subject, for questions about recent events
   * ("who won the world series?"): shown as a card and passed to the
   * language model so its answer is current, not from its training data.
   * @param {string} subject
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ text: string, count: number } | null>}
   */
  async newsReference(subject, signal) {
    if (!this.enabled) return null;
    const timeout = AbortSignal.timeout(REFERENCE_TIMEOUT_MS + 700);
    const result = await this.news.headlines({ query: subject }, signal ? AbortSignal.any([signal, timeout]) : timeout).catch(() => null);
    const items = result?.items ?? [];
    if (!items.length) return null;
    this.widgets.add({
      type: "news",
      key: "news",
      ttlMs: this.config.display.infoTimeout,
      data: { title: result.title, items: items.slice(0, 5).map((i) => ({ title: i.title, source: i.source, published: i.published, image: i.image })) },
    });
    const age = (iso) => {
      const h = Math.round((Date.now() - Date.parse(iso)) / 3600000);
      return Number.isFinite(h) ? (h < 1 ? "just now" : h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`) : "";
    };
    const text = items
      .slice(0, 6)
      .map((i, n) => `${n + 1}. ${i.title} (${[i.source, i.published && age(i.published)].filter(Boolean).join(", ")})`)
      .join("\n");
    return { text, count: Math.min(items.length, 6) };
  }

  showKnowledge(page) {
    this.widgets.add({
      type: "knowledge",
      key: "knowledge",
      ttlMs: this.config.display.infoTimeout,
      data: { title: page.title, description: page.description, extract: Knowledge.spoken(page.extract, 3, 420), image: page.image },
    });
  }

  // ─── News ──────────────────────────────────────────────────────────────

  /**
   * "What's the news?", "tech headlines", "the latest on SpaceX".
   * @param {string} request
   * @param {AbortSignal} [signal]
   */
  async newsHeadlines(request, signal) {
    const what = News.parse(request);
    const { title, items } = await this.news.headlines(what, signal);
    if (!items.length) return { spoken: what.query ? `I couldn't find any recent news about ${what.query}.` : "I couldn't get the news right now." };
    this.widgets.add({
      type: "news",
      key: "news",
      ttlMs: this.config.display.infoTimeout,
      data: { title, items: items.slice(0, 6).map((i) => ({ title: i.title, source: i.source, published: i.published, image: i.image })) },
    });
    // Read the top story; the rest are on the card. Long lists read aloud are tiring.
    const top = items[0].title.replace(/[.!?]+$/, "");
    const shown = Math.min(items.length, 5) - 1;
    const lead = what.query ? `The latest on ${what.query}:` : what.topic ? `Top ${what.topic} story:` : Talk.pick(["Top story:", "Leading the news:"]);
    return {
      spoken: `${lead} ${top}${items[0].source ? `, from ${items[0].source}` : ""}.${shown > 0 ? ` I've put ${Talk.count(shown)} more on the mirror.` : ""}`,
      data: { headlines: items.slice(0, 5).map((i) => `${i.title} (${i.source})`) },
    };
  }

  // ─── Markets ───────────────────────────────────────────────────────────

  /**
   * "How's the stock market?", "Apple stock", "price of bitcoin this week".
   * @param {string} request
   * @param {AbortSignal} [signal]
   */
  async marketQuote(request, signal) {
    const text = String(request ?? "");
    const period = /\b(?:this|past|last) week\b/i.test(text) ? "week" : /\b(?:this|past|last) month\b/i.test(text) ? "month" : /\b(?:this|past|last) year\b/i.test(text) ? "year" : "day";
    const subjects = Markets.subjects(text);
    const resolved = await Promise.all(subjects.map((s) => this.markets.resolve(s, signal).catch(() => [])));
    const symbols = [...new Set(resolved.flat())].slice(0, 4);
    if (!symbols.length) return { spoken: `I couldn't find a stock or coin called ${subjects.join(" or ") || text}.` };
    const quotes = (await Promise.all(symbols.map((s) => this.markets.quote(s, period, signal).catch(() => null)))).filter(Boolean);
    if (!quotes.length) return { spoken: "I couldn't get market data right now." };

    const markets = this.markets;
    this.widgets.add({
      type: "market",
      key: `market:${symbols.join(",")}:${period}`,
      ttlMs: this.config.display.cardTimeout * 2,
      data: { quotes: quotes.map(cardQuote) },
      firstRefreshMs: MARKET_REFRESH_MS,
      refresh: async () => {
        const fresh = (await Promise.all(symbols.map((s) => markets.quote(s, period).catch(() => null)))).filter(Boolean);
        return fresh.length ? { data: { quotes: fresh.map(cardQuote) }, nextMs: MARKET_REFRESH_MS } : { nextMs: MARKET_REFRESH_MS };
      },
    });

    const indices = quotes.length > 1 && quotes.every((q) => q.type === "INDEX");
    let spoken = indices ? Markets.describeMarket(quotes) : quotes.map((q) => Markets.describe(q)).join(" ");
    const q0 = quotes[0];
    // "Is Apple up today?" gets a yes or no first.
    const updown = /^\s*(?:is|are|was|did)\b.*\b(up|down|higher|lower|gaining|falling|rising|dropping)\b/i.exec(text);
    if (updown && quotes.length === 1 && Number.isFinite(q0.changePercent)) {
      const askedUp = /up|higher|gaining|rising/i.test(updown[1]);
      const isUp = q0.changePercent >= 0;
      spoken = `${askedUp === isUp ? "Yes" : "No"}. ${spoken}`;
    }
    // Ranges when asked: "52-week high", "how high did it go today".
    if (quotes.length === 1 && /\b(?:52|fifty.two).?week|year(?:'s)? (?:high|low|range)|all.time|range|high|low\b/i.test(text)) spoken += ` ${Markets.describeRanges(q0)}`;
    if (/\bmarket cap/i.test(text)) spoken += " I can't get market caps from my free data source, but that's the latest price.";
    return {
      spoken: spoken.trim(),
      data: { quotes: quotes.map((q) => ({ name: q.name, price: q.price, changePercent: q.changePercent })) },
    };
  }

  // ─── Currency, definitions, maths ──────────────────────────────────────

  /**
   * "Convert 100 dollars to euros", "what's the euro exchange rate".
   * @param {string} request
   * @param {AbortSignal} [signal]
   */
  async convertCurrency(request, signal) {
    const req = this.currency.parse(request);
    if (!req?.from || !req?.to) return { passThrough: true };
    const c = await this.currency.convert(req, signal);
    this.showAnswer({ label: "Exchange", display: Currency.format(c.result, c.to), value: c.result, caption: `${Currency.format(c.amount, c.from)} · rate ${c.rate.toFixed(4)}` });
    return { spoken: Currency.describe(c), data: c };
  }

  /**
   * "Define serendipity", "what does ephemeral mean".
   * @param {string} request
   * @param {AbortSignal} [signal]
   */
  async defineWord(request, signal) {
    const word = Dictionary.word(request) ?? String(request ?? "").trim();
    const d = await this.dictionary.define(word, signal).catch(() => null);
    if (!d) return { passThrough: true };
    this.widgets.add({ type: "definition", key: "definition", ttlMs: this.config.display.infoTimeout, data: d });
    return { spoken: Dictionary.describe(d), data: { word: d.word, meanings: d.meanings } };
  }

  /**
   * "What's 15% of 80?", "convert 5 miles to km", "a 20% tip on $85".
   * @param {string} question
   */
  calculate(question) {
    const r = Calculator.answer(question);
    if (!r) return { passThrough: true };
    this.showAnswer({ label: "Answer", display: r.display, value: Number.isFinite(r.value) ? r.value : null, caption: r.caption });
    return { spoken: r.spoken, data: { value: r.value } };
  }

  /** A big number that counts up, with a caption: answers, conversions, rates. */
  showAnswer({ label, display, value = null, caption = "" }) {
    this.widgets.add({ type: "answer", key: "answer", ttlMs: this.config.display.cardTimeout, data: { label, display, value, caption } });
  }

  // ─── Weather, time, sun ────────────────────────────────────────────────

  /**
   * Weather here or anywhere: "what's the weather in Paris", "will it rain tonight".
   * @param {string} question
   * @param {import("./Weather")} [weather]
   */
  async weatherAnswer(question) {
    const now = this.now();
    const place = placeIn(question);
    let w;
    if (place) {
      w = await this.weather.getAt(place, Weather.parseWhen(question, now), now).catch((err) => {
        log.warn(`Weather for ${place} failed: ${err.message}`);
        return undefined;
      });
      if (w === null) return { spoken: `I couldn't find a place called ${place}.` };
    }
    if (!w) w = await this.weather.get(Weather.parseWhen(question, now), now);
    if (!w) return { spoken: "I don't have any weather data. Add the MagicMirror weather module, or set my latitude and longitude." };

    const talk = new WeatherTalk(w, { now: w.remote ? new Date() : now });
    let spoken = talk.answer(question);
    if (w.remote) spoken = `In ${w.location}, ${lowerFirst(spoken)}`;
    this.showWeather(w);
    return { spoken, data: { facts: Weather.describe(w) } };
  }

  /** The animated weather card. */
  showWeather(w) {
    const scope = w.window ?? w.day;
    this.widgets.add({
      type: "weather",
      key: "weather",
      ttlMs: this.config.display.cardTimeout,
      data: {
        location: w.location || "",
        units: w.units,
        label: w.window ? capitalize(w.window.label) : w.current ? "Now" : capitalize(w.day?.label ?? ""),
        current: w.window ? null : w.current,
        scope: scope ? { high: scope.high, low: scope.low, precipChance: scope.precipChance, condition: scope.condition } : null,
        hours: w.hours ?? [],
        sun: w.sun ?? null,
      },
    });
  }

  /**
   * Time and countdowns, with an analog clock for other cities or a countdown card.
   * @param {string} question
   */
  timeAnswer(question) {
    const now = this.now();
    const r = this.clock.respond(question, now);
    if (!r) return { spoken: Talk.timeNow(now, { locale: this.config.locale }) };
    if (r.card?.type === "clock") {
      this.widgets.add({ type: "clock", key: `clock:${r.card.zone}`, ttlMs: this.config.display.cardTimeout, data: { ...r.card, hour12: !Talk.uses24h(this.config.locale) } });
    } else if (r.card?.type === "countdown") {
      this.widgets.add({ type: "countdown", key: "countdown", ttlMs: this.config.display.cardTimeout, data: r.card });
    }
    return { spoken: r.spoken };
  }

  /**
   * "When is sunset?", "what time does the sun come up tomorrow?"
   * @param {string} question
   */
  async sunTimes(question) {
    const now = this.now();
    const tomorrow = /\btomorrow\b/i.test(question);
    const w = await this.weather.get(tomorrow ? "tomorrow" : "today", now);
    if (!w?.sun) return { spoken: "I need my latitude and longitude, or the weather module, to know sunrise and sunset." };
    const rise = new Date(w.sun.sunrise);
    const set = new Date(w.sun.sunset);
    const h24 = Talk.uses24h(this.config.locale);
    const clock = (d) => Talk.clock(d, { hour12: !h24 });
    const day = tomorrow ? "Tomorrow" : "Today";
    this.widgets.add({ type: "sun", key: "sun", ttlMs: this.config.display.cardTimeout, data: { sunrise: w.sun.sunrise, sunset: w.sun.sunset, label: day, hour12: !h24 } });
    const asksRise = /\b(?:sunrise|sun (?:come |coming )?up|rise|rises|dawn)\b/i.test(question);
    const length = Talk.duration(set - rise).replace(/ and \d+ minutes?$/, "");
    if (asksRise) {
      const past = !tomorrow && rise < now;
      return { spoken: past ? `The sun came up at ${clock(rise)}. Tomorrow it rises around the same time.` : `${day} the sun rises at ${clock(rise)}.` };
    }
    const until = !tomorrow && set > now ? `, in ${Talk.duration(set - now)}` : "";
    return { spoken: `${day}'s sunset is at ${clock(set)}${until}. That's about ${length} of daylight.` };
  }

  // ─── Briefing ──────────────────────────────────────────────────────────

  /**
   * A short morning (or any time) briefing: weather and what to wear for it,
   * your teams playing today, the top headline and running timers.
   * @param {{ userName?: string, outfitHint?: string|null, greet?: boolean }} [options]
   *   greet: false when the greeting was already said while the data loaded.
   */
  async briefing({ userName = this.config.userName, outfitHint = null, greet = true } = {}) {
    const now = this.now();
    const part = Talk.partOfDay(now.getHours());
    const greeting = `Good ${part === "night" ? "evening" : part}${userName ? `, ${userName}` : ""}.`;
    const spoken = greet ? [greeting] : [];
    const lines = [];

    // Everything is fetched at once; the slowest source sets the pace, not the sum.
    const favorites = this.config.sports?.favorites ?? [];
    const [w, games, top] = await Promise.all([
      this.weather.get("today", now).catch(() => null),
      this.sports && favorites.length ? Promise.all(favorites.map((t) => withTimeout(this.sports.findGame(t), 2500).catch(() => null))) : [],
      this.news.headlines({}).catch(() => null),
    ]);
    if (w) {
      const talk = new WeatherTalk(w, { now });
      spoken.push(talk.overview());
      const t = w.current?.temperature;
      lines.push({ icon: "weather", text: `${t !== null && t !== undefined ? `${Math.round(t)}° · ` : ""}${capitalize(WeatherTalk.sky(w.current?.condition ?? w.day?.condition, { night: w.current?.isDay === false }) || "")}${w.day?.high !== null && w.day?.high !== undefined ? ` · high ${Math.round(w.day.high)}°` : ""}` });
      if (outfitHint) {
        spoken.push(outfitHint);
        lines.push({ icon: "outfit", text: capitalize(outfitHint.replace(/^I'd wear |^Wear /, "").replace(/^your /, "").replace(/\.$/, "")) });
      }
    }

    if (games.length) {
      for (const g of games.filter(Boolean)) {
        if (Talk.calendarDays(new Date(g.date), now) !== 0 && g.state !== "in") continue;
        const sentence = this.sports.describe(g, { now });
        spoken.push(sentence);
        lines.push({ icon: "sports", text: sentence.replace(/\.$/, "") });
      }
    }

    if (top?.items?.[0]) {
      spoken.push(`In the news: ${top.items[0].title.replace(/[.!?]+$/, "")}.`);
      lines.push({ icon: "news", text: top.items[0].title });
    }

    for (const t of this.widgets.list("timer")) {
      const left = Math.max(0, t.data.endsAt - Date.now());
      lines.push({ icon: "timer", text: `${t.data.label ? `${capitalize(t.data.label)}: ` : ""}${Talk.duration(left)} left` });
    }

    this.widgets.add({
      type: "briefing",
      key: "briefing",
      ttlMs: this.config.display.infoTimeout,
      data: { greeting: greeting.replace(/\.$/, ""), date: Talk.dateLong(now, { locale: this.config.locale }), lines },
    });
    return { spoken: spoken.join(" ") };
  }
}

/** The place in "what's the weather in Paris", "is it raining in London right now". */
function placeIn(question) {
  const text = String(question ?? "")
    .trim()
    .replace(/[?.!]+$/, "")
    .replace(/\s+(?:today|tonight|tomorrow(?: morning| afternoon| night)?|right now|now|this (?:morning|afternoon|evening|week|weekend)|later(?: today)?)$/i, "");
  const m = /\b(?:in|for|at)\s+((?:[a-z][\w'-]*\s?){1,3})$/i.exec(text);
  if (!m) return null;
  const place = m[1].trim();
  if (/^(?:the\s+)?(?:morning|afternoon|evening|night|week|weekend|here|my area|town|the city|outside|a bit|an hour|\d+)/i.test(place)) return null;
  return place;
}

/** Resolve with the promise's value, or reject after `ms`. */
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), ms)))]).finally(() => clearTimeout(timer));
}

function cardQuote(q) {
  return { symbol: q.symbol, name: q.name, type: q.type, currency: q.currency, price: q.price, change: q.change, changePercent: q.changePercent, series: q.series, marketState: q.marketState, period: q.period };
}

function homeCurrency(locale) {
  const region = String(locale ?? "").split(/[-_]/)[1]?.toUpperCase();
  if (region && REGION_CURRENCY[region]) return REGION_CURRENCY[region];
  if (EURO_LANGS.test(String(locale ?? ""))) return "EUR";
  return "USD";
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function lowerFirst(s) {
  return s && /^[A-Z][a-z]/.test(s) && !/^(?:I|I'm|I'll)\b/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

InfoSkills.placeIn = placeIn;
InfoSkills.homeCurrency = homeCurrency;
module.exports = InfoSkills;
