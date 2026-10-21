"use strict";

const Http = require("./http");

const QUOTE_CACHE_MS = 60 * 1000;
const SEARCH_CACHE_MS = 24 * 60 * 60 * 1000;

// Names people say → Yahoo symbols. Anything else is looked up with Yahoo's search.
const ALIASES = {
  bitcoin: "BTC-USD", btc: "BTC-USD", ethereum: "ETH-USD", ether: "ETH-USD", eth: "ETH-USD", dogecoin: "DOGE-USD",
  doge: "DOGE-USD", solana: "SOL-USD", xrp: "XRP-USD", ripple: "XRP-USD", cardano: "ADA-USD", litecoin: "LTC-USD",
  dow: "^DJI", "dow jones": "^DJI", "the dow": "^DJI", "s&p": "^GSPC", "s and p": "^GSPC", "s&p 500": "^GSPC",
  "s and p 500": "^GSPC", sp500: "^GSPC", nasdaq: "^IXIC", "russell 2000": "^RUT", ftse: "^FTSE", "ftse 100": "^FTSE",
  dax: "^GDAXI", nikkei: "^N225", "hang seng": "^HSI", vix: "^VIX", gold: "GC=F", silver: "SI=F", oil: "CL=F",
  "crude oil": "CL=F", "natural gas": "NG=F", google: "GOOGL", alphabet: "GOOGL", facebook: "META", meta: "META",
};
// "How's the market doing?" → the three main US indices.
const MARKET_WORDS = /^(?:the\s+)?(?:stock\s+)?market(?:s)?(?:\s+today)?$|^(?:the\s+)?stocks?$|^wall street$/;
const INDICES = ["^GSPC", "^DJI", "^IXIC"];
const NAMES = {
  "^GSPC": "S&P 500", "^DJI": "Dow", "^IXIC": "Nasdaq", "^RUT": "Russell 2000", "^FTSE": "FTSE 100", "^GDAXI": "DAX",
  "^N225": "Nikkei", "^HSI": "Hang Seng", "^VIX": "VIX", "GC=F": "Gold", "SI=F": "Silver", "CL=F": "Crude oil", "NG=F": "Natural gas",
};
const RANGES = { day: ["1d", "5m"], week: ["5d", "30m"], month: ["1mo", "1d"], year: ["1y", "1wk"] };

/**
 * Stocks, indices, crypto and commodities from Yahoo Finance's public chart
 * API (no key), with an intraday series for the mirror's sparkline.
 */
class Markets {
  /**
   * @param {{ http?: Http }} [options]
   */
  constructor({ http = new Http() } = {}) {
    this.http = http;
  }

  /**
   * Symbols a spoken request refers to: "apple stock" → ["AAPL"], "bitcoin" →
   * ["BTC-USD"], "how's the market" → the S&P 500, Dow and Nasdaq.
   * @param {string} name
   * @param {AbortSignal} [signal]
   * @returns {Promise<string[]>}
   */
  async resolve(name, signal) {
    const q = String(name ?? "")
      .toLowerCase()
      .replace(/[?.!,]/g, "")
      .replace(/\b(?:how'?s|how is|how are|what'?s|what is|what are)\b/g, " ")
      .replace(/\b(?:stock|stocks|shares?|price|prices|ticker|today|right now|now|doing|trading|worth|index|of|the price|value)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!q || MARKET_WORDS.test(q)) return INDICES;
    if (ALIASES[q]) return [ALIASES[q]];
    if (ALIASES[q.replace(/^the /, "")]) return [ALIASES[q.replace(/^the /, "")]];
    // A spoken ticker: "a a p l", "tsla".
    const letters = q.replace(/\s+/g, "");
    if (/^[a-z]{1,5}$/.test(letters) && q.includes(" ")) return [letters.toUpperCase()];

    const res = await this.http.json(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=5&newsCount=0`, { signal, cacheMs: SEARCH_CACHE_MS });
    const quote = (res.quotes ?? []).find((x) => ["EQUITY", "ETF", "INDEX", "CRYPTOCURRENCY", "FUTURE", "MUTUALFUND"].includes(x.quoteType));
    return quote ? [quote.symbol] : [];
  }

  /**
   * The things a request asks about: "compare Apple and Microsoft" →
   * ["apple", "microsoft"]; "what's Nvidia trading at" → ["nvidia"].
   * @param {string} request
   * @returns {string[]}
   */
  static subjects(request) {
    // Names with "&" or "and" in them are set aside first, so neither the
    // filler words ("at") nor the split on "and"/"&" can break them apart.
    const kept = [];
    const keep = (name) => ` keptname${kept.push(name) - 1} `;
    const t = String(request ?? "")
      .toLowerCase()
      .replace(/[?.!]/g, " ")
      .replace(/\bs\s*(?:&|and)\s*p(?:\s*500)?\b/g, () => keep("s&p 500"))
      .replace(/\bat\s*(?:&|and)\s*t\b/g, () => keep("at&t"))
      .replace(/\bjohnson\s*(?:&|and)\s*johnson\b/g, () => keep("johnson & johnson"))
      .replace(/\bprocter\s*(?:&|and)\s*gamble\b/g, () => keep("procter & gamble"))
      .replace(/\b(?:at the moment|these days|lately|(?:going|selling|go|sell) for|how much (?:is|are|does|do)|how much|how(?:'s|s| is| are| did| does)?|what(?:'s|s| is| are| was)?|is|are|was|did|does|show me|tell me|check|give me|compare|the price of|price of|prices? for|doing|trading|traded|at|worth|cost|costs|valued?|today|right now|now|this|past|last|week|month|year|please|on the mirror|up|down|or down|higher|lower|market cap(?:italization)?|of|share price|stock price|stocks?|shares?|ticker|52.week|fifty.two.week|high|low|range|all.time|performing|perform|has|have|had|done|been|the|a|one share)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const restore = (p) => p.replace(/keptname(\d+)/g, (_, i) => kept[Number(i)]).trim();
    return t.split(/\s*,\s*|\s+(?:and|vs\.?|versus|&)\s+/).map(restore).filter(Boolean).slice(0, 4);
  }

  /** "Today it's traded between $370 and $376; over the past year, $214 to $488." */
  static describeRanges(q) {
    const f = (v) => (q.type === "INDEX" ? formatPoints(v) : formatMoney(v, q.currency));
    const parts = [];
    if (Number.isFinite(q.dayLow) && Number.isFinite(q.dayHigh)) parts.push(`Today it's traded between ${f(q.dayLow)} and ${f(q.dayHigh)}`);
    if (Number.isFinite(q.yearLow) && Number.isFinite(q.yearHigh)) parts.push(`over the past year, ${f(q.yearLow)} to ${f(q.yearHigh)}`);
    return parts.length ? `${parts.join("; ")}.` : "";
  }

  /**
   * Latest price, change and a price series.
   * @param {string} symbol
   * @param {"day"|"week"|"month"|"year"} [period="day"]
   * @param {AbortSignal} [signal]
   */
  async quote(symbol, period = "day", signal) {
    const [range, interval] = RANGES[period] ?? RANGES.day;
    const res = await this.http.json(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`,
      { signal, cacheMs: QUOTE_CACHE_MS },
    );
    const r = res.chart?.result?.[0];
    if (!r?.meta) throw new Error(`No market data for ${symbol}`);
    const m = r.meta;
    const closes = r.indicators?.quote?.[0]?.close ?? [];
    const series = (r.timestamp ?? []).map((t, i) => [t * 1000, closes[i]]).filter(([, v]) => Number.isFinite(v));
    const price = m.regularMarketPrice ?? series.at(-1)?.[1];
    const base = period === "day" ? (m.chartPreviousClose ?? m.previousClose) : (series[0]?.[1] ?? m.chartPreviousClose);
    const change = Number.isFinite(base) ? price - base : null;
    return {
      symbol: m.symbol ?? symbol,
      name: NAMES[m.symbol] ?? cleanName(m.shortName ?? m.longName ?? symbol),
      type: m.instrumentType ?? "",
      currency: m.currency ?? "USD",
      price,
      previous: base ?? null,
      change,
      changePercent: change !== null && base ? (change / base) * 100 : null,
      dayHigh: m.regularMarketDayHigh ?? null,
      dayLow: m.regularMarketDayLow ?? null,
      yearHigh: m.fiftyTwoWeekHigh ?? null,
      yearLow: m.fiftyTwoWeekLow ?? null,
      time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
      period,
      // Thin the series to ~60 points: plenty for a sparkline, small over the socket.
      series: thin(series, 60).map(([t, v]) => [t, Math.round(v * 100) / 100]),
      marketState: m.currentTradingPeriod && m.regularMarketTime ? marketState(m) : "open",
    };
  }

  /**
   * One spoken sentence: "Apple is at $247.10, up 1.3% today."
   * @param {object} q quote()
   */
  static describe(q) {
    const price = q.type === "INDEX" ? formatPoints(q.price) : formatMoney(q.price, q.currency);
    const name = q.type === "INDEX" ? `The ${q.name}` : q.name;
    const when = { day: q.marketState === "closed" ? "" : " today", week: " this week", month: " this month", year: " this year" }[q.period] ?? "";
    if (q.changePercent === null || !Number.isFinite(q.changePercent)) return `${name} is at ${price}.`;
    const pct = Math.abs(q.changePercent);
    const move = pct < 0.05 ? "flat" : `${q.changePercent > 0 ? "up" : "down"} ${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
    const closed = q.marketState === "closed" && q.period === "day" ? " at the close" : "";
    return `${name} is ${move === "flat" ? `flat at ${price}` : `at ${price}${closed}, ${move}${when}`}.`;
  }

  /** "The S&P 500 is up 0.4%, the Dow up 0.2% and the Nasdaq up 0.8%." */
  static describeMarket(quotes) {
    const parts = quotes.map((q, i) => {
      const pct = q.changePercent ?? 0;
      const move = Math.abs(pct) < 0.05 ? "flat" : `${pct > 0 ? "up" : "down"} ${Math.abs(pct).toFixed(1)}%`;
      return `the ${q.name}${i === 0 || move === "flat" ? " is" : ""} ${move}`;
    });
    const ups = quotes.filter((q) => (q.changePercent ?? 0) >= 0.05).length;
    const downs = quotes.filter((q) => (q.changePercent ?? 0) <= -0.05).length;
    const lead = downs === 0 && ups > 0 ? "Stocks are up." : ups === 0 && downs > 0 ? "Stocks are down." : ups === 0 ? "Stocks are flat." : "It's a mixed day.";
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
    return `${lead} ${list[0].toUpperCase()}${list.slice(1)}.`;
  }
}

function marketState(m) {
  const now = Date.now() / 1000;
  const p = m.currentTradingPeriod?.regular;
  if (m.instrumentType === "CRYPTOCURRENCY") return "open";
  return p && now >= p.start && now <= p.end ? "open" : "closed";
}

function cleanName(name) {
  return String(name)
    .replace(/,?\s+(?:Inc\.?|Incorporated|Corporation|Corp\.?|Co\.?|Ltd\.?|plc|PLC|Holdings?|N\.V\.|S\.A\.|AG|SE|Class [A-C])$/g, "")
    .replace(/,?\s+(?:Inc\.?|Corp\.?)$/g, "")
    .replace(/ USD$/, "")
    .replace(/\.com$/i, "")
    .trim();
}

/** 52,496 – indices are points, not money. */
function formatPoints(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: value >= 1000 ? 0 : 2 }).format(value) : "unknown";
}

function thin(series, max) {
  if (series.length <= max) return series;
  const step = series.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(series[Math.floor(i * step)]);
  out[out.length - 1] = series.at(-1);
  return out;
}

/**
 * $1,234.56 / €12.30 / 82,735 for big crypto prices.
 * @param {number} value
 * @param {string} [currency="USD"]
 */
function formatMoney(value, currency = "USD") {
  if (!Number.isFinite(value)) return "unknown";
  const digits = value >= 10000 ? 0 : value >= 1 ? 2 : 4;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
  } catch {
    return `${value.toFixed(digits)} ${currency}`;
  }
}

Markets.ALIASES = ALIASES;
Markets.INDICES = INDICES;
Markets.formatMoney = formatMoney;
module.exports = Markets;
