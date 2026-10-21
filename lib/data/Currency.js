"use strict";

const Http = require("./http");

const CACHE_MS = 60 * 60 * 1000;

// Spoken currency names → ISO codes.
const NAMES = {
  dollar: "USD", dollars: "USD", usd: "USD", buck: "USD", bucks: "USD", "us dollar": "USD", "us dollars": "USD", "american dollars": "USD",
  euro: "EUR", euros: "EUR", eur: "EUR",
  pound: "GBP", pounds: "GBP", quid: "GBP", gbp: "GBP", sterling: "GBP", "british pounds": "GBP",
  yen: "JPY", jpy: "JPY", "japanese yen": "JPY",
  yuan: "CNY", renminbi: "CNY", cny: "CNY",
  rupee: "INR", rupees: "INR", inr: "INR",
  franc: "CHF", francs: "CHF", "swiss francs": "CHF", chf: "CHF",
  "canadian dollar": "CAD", "canadian dollars": "CAD", cad: "CAD",
  "australian dollar": "AUD", "australian dollars": "AUD", aud: "AUD", aussie: "AUD",
  "new zealand dollars": "NZD", nzd: "NZD", peso: "MXN", pesos: "MXN", "mexican pesos": "MXN", mxn: "MXN",
  won: "KRW", krw: "KRW", krona: "SEK", kronor: "SEK", sek: "SEK", krone: "NOK", kroner: "NOK", nok: "NOK",
  "danish kroner": "DKK", dkk: "DKK", zloty: "PLN", pln: "PLN", lira: "TRY", try: "TRY", real: "BRL", reais: "BRL", brl: "BRL",
  rand: "ZAR", zar: "ZAR", "hong kong dollars": "HKD", hkd: "HKD", "singapore dollars": "SGD", sgd: "SGD",
};
const SYMBOLS = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", INR: "₹", KRW: "₩" };
const LABELS = { USD: "dollars", EUR: "euros", GBP: "pounds", JPY: "yen", CNY: "yuan", INR: "rupees", CHF: "Swiss francs", CAD: "Canadian dollars", AUD: "Australian dollars", MXN: "pesos" };

/**
 * Currency conversion with the European Central Bank's daily rates via
 * Frankfurter (no key).
 */
class Currency {
  /**
   * @param {{ http?: Http, home?: string }} [options] home: the currency to convert to when none is named.
   */
  constructor({ http = new Http(), home = "USD" } = {}) {
    this.http = http;
    this.home = home;
  }

  /**
   * "convert 100 dollars to euros", "how much is 50 pounds in dollars",
   * "what's the euro exchange rate" → { amount, from, to } or null.
   * @param {string} text
   */
  parse(text) {
    const t = String(text ?? "").toLowerCase().replace(/[?!,]/g, "").replace(/\s+/g, " ");
    const names = Object.keys(NAMES).sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const code = (w) => NAMES[w?.trim()] ?? null;
    let m = new RegExp(`(?:([$€£¥])\\s?)?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k|thousand|million)?\\s*(${names})?\\s+(?:to|in|into|as)\\s+(${names})\\b`).exec(t);
    if (m && (m[1] || m[4])) {
      const from = m[4] ? code(m[4]) : { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY" }[m[1]];
      const mult = { k: 1000, thousand: 1000, million: 1e6 }[m[3]] ?? 1;
      return { amount: Number(m[2].replace(/,/g, "")) * mult, from, to: code(m[5]) };
    }
    m = new RegExp(`\\b(?:exchange rate|rate)\\b.*?\\b(${names})\\b(?:\\s+(?:to|and|against|vs)\\s+(?:the\\s+)?(${names})\\b)?`).exec(t)
      ?? new RegExp(`\\b(${names})\\s+(?:exchange\\s+)?rate\\b(?:\\s+(?:to|against|vs)\\s+(?:the\\s+)?(${names})\\b)?`).exec(t)
      ?? new RegExp(`\\bhow much is (?:a|one|the)\\s+(${names})\\b(?:\\s+(?:in|worth in)\\s+(${names})\\b)?`).exec(t);
    if (m) {
      const from = code(m[1]);
      const to = m[2] ? code(m[2]) : from === this.home ? (this.home === "EUR" ? "USD" : "EUR") : this.home;
      return { amount: 1, from, to };
    }
    return null;
  }

  /**
   * @param {{ amount: number, from: string, to: string }} req
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ amount: number, from: string, to: string, rate: number, result: number, date: string }>}
   */
  async convert({ amount, from, to }, signal) {
    if (!from || !to) throw new Error("Unknown currency.");
    if (from === to) return { amount, from, to, rate: 1, result: amount, date: "" };
    const res = await this.http.json(`https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`, { signal, cacheMs: CACHE_MS });
    const rate = res.rates?.[to];
    if (!Number.isFinite(rate)) throw new Error(`No exchange rate for ${from} to ${to}.`);
    return { amount, from, to, rate, result: amount * rate, date: res.date ?? "" };
  }

  /** "100 dollars is about 89.17 euros." */
  static describe(c) {
    return `${Currency.format(c.amount, c.from)} is about ${Currency.format(c.result, c.to)}.`;
  }

  /** €89.17, ¥15,042 or 89.17 Swiss francs. */
  static format(value, code) {
    const digits = code === "JPY" || code === "KRW" || value >= 10000 || Number.isInteger(value) ? 0 : 2;
    const num = new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
    return SYMBOLS[code] ? `${SYMBOLS[code]}${num}` : `${num} ${LABELS[code] ?? code}`;
  }
}

Currency.NAMES = NAMES;
module.exports = Currency;
