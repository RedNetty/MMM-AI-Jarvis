"use strict";

/**
 * Arithmetic and unit conversions, offline and exact. Small language models
 * are unreliable at maths ("what's 17% of 240?"), so these never reach one.
 */

// Units by kind, each as a factor to the kind's base unit (metre, kilogram, litre, m/s, second, byte).
const UNITS = {
  length: {
    base: "m",
    units: {
      mm: [0.001, ["mm", "millimeter", "millimeters", "millimetre", "millimetres"]],
      cm: [0.01, ["cm", "centimeter", "centimeters", "centimetre", "centimetres"]],
      m: [1, ["m", "meter", "meters", "metre", "metres"]],
      km: [1000, ["km", "kilometer", "kilometers", "kilometre", "kilometres", "k"]],
      in: [0.0254, ["in", "inch", "inches"]],
      ft: [0.3048, ["ft", "foot", "feet"]],
      yd: [0.9144, ["yd", "yard", "yards"]],
      mi: [1609.344, ["mi", "mile", "miles"]],
      nmi: [1852, ["nautical mile", "nautical miles"]],
    },
  },
  mass: {
    base: "kg",
    units: {
      mg: [1e-6, ["mg", "milligram", "milligrams"]],
      g: [0.001, ["g", "gram", "grams", "gramme", "grammes"]],
      kg: [1, ["kg", "kilo", "kilos", "kilogram", "kilograms"]],
      oz: [0.028349523125, ["oz", "ounce", "ounces"]],
      lb: [0.45359237, ["lb", "lbs", "pound", "pounds"]],
      st: [6.35029318, ["stone", "stones"]],
      t: [1000, ["tonne", "tonnes", "metric ton", "metric tons"]],
      ton: [907.18474, ["ton", "tons"]],
    },
  },
  volume: {
    base: "l",
    units: {
      ml: [0.001, ["ml", "milliliter", "milliliters", "millilitre", "millilitres"]],
      l: [1, ["l", "liter", "liters", "litre", "litres"]],
      tsp: [0.00492892, ["tsp", "teaspoon", "teaspoons"]],
      tbsp: [0.0147868, ["tbsp", "tablespoon", "tablespoons"]],
      floz: [0.0295735, ["fl oz", "fluid ounce", "fluid ounces"]],
      cup: [0.236588, ["cup", "cups"]],
      pt: [0.473176, ["pint", "pints"]],
      qt: [0.946353, ["quart", "quarts"]],
      gal: [3.78541, ["gallon", "gallons"]],
    },
  },
  speed: {
    base: "m/s",
    units: {
      mps: [1, ["m/s", "meters per second", "metres per second"]],
      kmh: [1 / 3.6, ["km/h", "kph", "kmh", "kilometers per hour", "kilometres per hour", "kilometers an hour", "kilometres an hour"]],
      mph: [0.44704, ["mph", "miles per hour", "miles an hour"]],
      knot: [0.514444, ["knot", "knots"]],
    },
  },
  time: {
    base: "s",
    units: {
      s: [1, ["second", "seconds", "sec", "secs"]],
      min: [60, ["minute", "minutes", "min", "mins"]],
      h: [3600, ["hour", "hours", "hr", "hrs"]],
      d: [86400, ["day", "days"]],
      wk: [604800, ["week", "weeks"]],
      yr: [31557600, ["year", "years"]],
    },
  },
  data: {
    base: "B",
    units: {
      kb: [1e3, ["kb", "kilobyte", "kilobytes"]],
      mb: [1e6, ["mb", "megabyte", "megabytes"]],
      gb: [1e9, ["gb", "gigabyte", "gigabytes", "gig", "gigs"]],
      tb: [1e12, ["tb", "terabyte", "terabytes"]],
    },
  },
};
const TEMPS = {
  c: ["c", "celsius", "centigrade", "degrees celsius", "degrees c", "°c"],
  f: ["f", "fahrenheit", "degrees fahrenheit", "degrees f", "°f"],
  k: ["kelvin", "kelvins"],
};

// How each unit is said: [singular, plural].
const SPOKEN = {
  mm: ["millimeter", "millimeters"], cm: ["centimeter", "centimeters"], m: ["meter", "meters"], km: ["kilometer", "kilometers"],
  in: ["inch", "inches"], ft: ["foot", "feet"], yd: ["yard", "yards"], mi: ["mile", "miles"], nmi: ["nautical mile", "nautical miles"],
  mg: ["milligram", "milligrams"], g: ["gram", "grams"], kg: ["kilogram", "kilograms"], oz: ["ounce", "ounces"], lb: ["pound", "pounds"],
  st: ["stone", "stone"], t: ["tonne", "tonnes"], ton: ["ton", "tons"], ml: ["milliliter", "milliliters"], l: ["liter", "liters"],
  tsp: ["teaspoon", "teaspoons"], tbsp: ["tablespoon", "tablespoons"], floz: ["fluid ounce", "fluid ounces"], cup: ["cup", "cups"],
  pt: ["pint", "pints"], qt: ["quart", "quarts"], gal: ["gallon", "gallons"], mps: ["meter per second", "meters per second"],
  kmh: ["kilometer per hour", "kilometers per hour"], mph: ["mile per hour", "miles per hour"], knot: ["knot", "knots"],
  s: ["second", "seconds"], min: ["minute", "minutes"], h: ["hour", "hours"], d: ["day", "days"], wk: ["week", "weeks"], yr: ["year", "years"],
  kb: ["kilobyte", "kilobytes"], mb: ["megabyte", "megabytes"], gb: ["gigabyte", "gigabytes"], tb: ["terabyte", "terabytes"],
  c: ["degree Celsius", "degrees Celsius"], f: ["degree Fahrenheit", "degrees Fahrenheit"], k: ["kelvin", "kelvin"],
};

// alias → { kind, key, factor }
const ALIASES = new Map();
for (const [kind, { units }] of Object.entries(UNITS)) {
  for (const [key, [factor, names]] of Object.entries(units)) {
    for (const n of names) ALIASES.set(n, { kind, key, factor });
  }
}
for (const [key, names] of Object.entries(TEMPS)) {
  for (const n of names) ALIASES.set(n, { kind: "temperature", key, factor: null });
}
const UNIT_RE = [...ALIASES.keys()].sort((a, b) => b.length - a.length).map((a) => a.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|");

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, a: 1, an: 1, half: 0.5, quarter: 0.25,
};

class Calculator {
  /**
   * Answer a maths or conversion question, or return null if it isn't one.
   * @param {string} question
   * @returns {{ spoken: string, value: number, display: string, caption: string } | null}
   */
  static answer(question) {
    return Calculator.convert(question) ?? Calculator.tip(question) ?? Calculator.calculate(question);
  }

  // ─── Unit conversion ───────────────────────────────────────────────────

  /**
   * "convert 5 miles to km", "how many cups in a liter", "70 fahrenheit in celsius", "180 cm in feet".
   * @param {string} question
   */
  static convert(question) {
    const t = words(question);
    let m = new RegExp(`(?:^|\\b)(-?[\\d.]+|${Object.keys(NUMBER_WORDS).join("|")})\\s*(${UNIT_RE})\\s+(?:to|in|into|as|is how many|equals how many|in how many)\\s+(${UNIT_RE})(?:$|\\b)`).exec(t);
    let amount;
    let from;
    let to;
    if (m) {
      amount = toNumber(m[1]);
      from = ALIASES.get(m[2]);
      to = ALIASES.get(m[3]);
    } else {
      m = new RegExp(`\\bhow many (${UNIT_RE}) (?:are )?(?:in|per|make|make up|to) (?:a |an |one |(-?[\\d.]+) )?(${UNIT_RE})\\b`).exec(t);
      if (!m) return null;
      amount = m[2] ? Number(m[2]) : 1;
      from = ALIASES.get(m[3]);
      to = ALIASES.get(m[1]);
    }
    if (!from || !to || !Number.isFinite(amount) || from.kind !== to.kind || from.key === to.key) return null;

    let value;
    if (from.kind === "temperature") {
      const c = from.key === "c" ? amount : from.key === "f" ? ((amount - 32) * 5) / 9 : amount - 273.15;
      value = to.key === "c" ? c : to.key === "f" ? (c * 9) / 5 + 32 : c + 273.15;
    } else {
      value = (amount * from.factor) / to.factor;
    }

    const fromText = `${fmt(amount)} ${unitName(from, amount)}`;
    // Heights read better as feet and inches.
    if (to.key === "ft" && from.kind === "length" && value < 10) {
      const totalIn = Math.round(value * 12);
      const ft = Math.floor(totalIn / 12);
      const inches = totalIn % 12;
      const display = `${ft}′ ${inches}″`;
      return { spoken: `${capitalize(fromText)} is ${ft} ${ft === 1 ? "foot" : "feet"}${inches ? ` ${inches} ${inches === 1 ? "inch" : "inches"}` : ""}.`, value, display, caption: fromText };
    }
    if (to.kind === "temperature") value = Math.round(value * 10) / 10;
    const toText = `${fmt(value)} ${unitName(to, value)}`;
    return { spoken: `${capitalize(fromText)} is ${toText}.`, value, display: fmt(value), caption: `${unitName(to, value)} in ${fromText}` };
  }

  // ─── Tips ──────────────────────────────────────────────────────────────

  /** "what's a 20% tip on 85 dollars", "18 percent tip on $64.50". */
  static tip(question) {
    const t = words(question).replace(/\$/g, "");
    const m = /\b(\d+(?:\.\d+)?)\s*(?:%|percent)\s+tip\s+(?:on|for)\s+(\d+(?:\.\d+)?)/.exec(t);
    if (!m) return null;
    const pct = Number(m[1]);
    const bill = Number(m[2]);
    const tip = Math.round(bill * pct) / 100;
    const total = Math.round((bill + tip) * 100) / 100;
    return { spoken: `A ${fmt(pct)}% tip on ${money(bill)} is ${money(tip)}, so ${money(total)} in total.`, value: tip, display: money(tip), caption: `${fmt(pct)}% tip · ${money(total)} total` };
  }

  // ─── Arithmetic ────────────────────────────────────────────────────────

  /**
   * "what's 15% of 80", "12 times 7", "square root of 144", "2 to the power of 10", "(3 + 4) * 2".
   * @param {string} question
   */
  static calculate(question) {
    const expr = Calculator.toExpression(question);
    if (!expr) return null;
    let value;
    try {
      value = new Parser(expr).parse();
    } catch {
      return null;
    }
    if (!Number.isFinite(value)) return { spoken: "That doesn't have an answer. Dividing by zero, maybe?", value: NaN, display: "∞", caption: pretty(expr) };
    return { spoken: `${capitalize(spokenExpr(expr))} is ${fmt(value)}.`, value, display: fmt(value), caption: pretty(expr) };
  }

  /**
   * Turn spoken maths into an expression, or null if it isn't maths.
   * @param {string} question
   */
  static toExpression(question) {
    let t = words(question)
      .replace(/^(?:hey |ok |okay )?(?:iris |jarvis )?(?:what(?:'s| is| are)|whats|calculate|compute|work out|how much is|tell me|can you (?:calculate|work out|tell me))\s+/, "")
      .replace(/[?!=]+$/, "")
      .replace(/^the\s+/, "")
      .replace(/,(?=\d{3}\b)/g, "")
      .replace(/\$/g, "");
    t = t
      .replace(/\b(\d+(?:\.\d+)?)\s*(?:%|percent)\s+of\b/g, "($1/100)*")
      .replace(/\b(\d+(?:\.\d+)?)\s*(?:%|percent)\b/g, "($1/100)")
      .replace(/\bsquare root of\s+/g, "sqrt ")
      .replace(/\bcube root of\s+/g, "cbrt ")
      .replace(/\b(\S+)\s+squared\b/g, "$1^2")
      .replace(/\b(\S+)\s+cubed\b/g, "$1^3")
      .replace(/\bto the power of\b|\bto the\b|\braised to\b/g, "^")
      .replace(/\bplus\b|\band\b(?=\s*[\d(])/g, "+")
      .replace(/\bminus\b|\bless\b|\btake away\b/g, "-")
      .replace(/\btimes\b|\bmultiplied by\b|\bx\b|×/g, "*")
      .replace(/\bdivided by\b|\bover\b|÷/g, "/")
      .replace(/\bhalf of\b/g, "0.5*")
      .replace(/\bdouble\b/g, "2*")
      .replace(/\btriple\b/g, "3*");
    t = t.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/g, (w) => String(NUMBER_WORDS[w]));
    t = t.replace(/\s+/g, "");
    // Only digits, operators, parentheses and the two functions are allowed.
    if (!/^(?:[\d.+\-*/^()]|sqrt|cbrt)+$/.test(t)) return null;
    if (!/[+\-*/^]|sqrt|cbrt/.test(t) || !/\d/.test(t)) return null;
    return t;
  }
}

/** Recursive-descent parser for + - * / ^, unary minus, parentheses, sqrt and cbrt. No eval. */
class Parser {
  constructor(text) {
    this.text = text;
    this.i = 0;
  }

  parse() {
    const v = this.sum();
    if (this.i !== this.text.length) throw new Error("Unexpected input");
    return v;
  }

  sum() {
    let v = this.product();
    while (this.peek() === "+" || this.peek() === "-") {
      const op = this.text[this.i++];
      const r = this.product();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }

  product() {
    let v = this.power();
    while (this.peek() === "*" || this.peek() === "/") {
      const op = this.text[this.i++];
      const r = this.power();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }

  power() {
    const base = this.unary();
    if (this.peek() === "^") {
      this.i++;
      return base ** this.power();
    }
    return base;
  }

  unary() {
    if (this.peek() === "-") {
      this.i++;
      return -this.unary();
    }
    if (this.text.startsWith("sqrt", this.i)) {
      this.i += 4;
      return Math.sqrt(this.unary());
    }
    if (this.text.startsWith("cbrt", this.i)) {
      this.i += 4;
      return Math.cbrt(this.unary());
    }
    if (this.peek() === "(") {
      this.i++;
      const v = this.sum();
      if (this.text[this.i++] !== ")") throw new Error("Missing )");
      return v;
    }
    const m = /^\d+(?:\.\d+)?|^\.\d+/.exec(this.text.slice(this.i));
    if (!m) throw new Error("Number expected");
    this.i += m[0].length;
    return Number(m[0]);
  }

  peek() {
    return this.text[this.i];
  }
}

function words(text) {
  return String(text ?? "").toLowerCase().replace(/[?!]+$/, "").replace(/\s+/g, " ").trim();
}

function toNumber(w) {
  return NUMBER_WORDS[w] ?? Number(w);
}

/** Round sensibly for speech and display: 3 significant decimals, thousands separators. */
function fmt(v) {
  if (!Number.isFinite(v)) return String(v);
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 1 : abs >= 100 ? 2 : abs >= 1 ? 2 : abs === 0 ? 0 : 4;
  const rounded = Number(v.toFixed(digits));
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(rounded);
}

function money(v) {
  return `$${v.toFixed(2).replace(/\.00$/, "")}`;
}

function unitName(u, value) {
  const [one, many] = SPOKEN[u.key] ?? [u.key, u.key];
  return Math.abs(value) === 1 ? one : many;
}

/** "(15/100)*80" → "15% of 80" for captions. */
function pretty(expr) {
  return expr
    .replace(/\((\d+(?:\.\d+)?)\/100\)\*/g, "$1% of ")
    .replace(/\((\d+(?:\.\d+)?)\/100\)/g, "$1%")
    .replace(/sqrt/g, "√")
    .replace(/cbrt/g, "∛")
    .replace(/\*/g, " × ")
    .replace(/\//g, " ÷ ")
    .replace(/\+/g, " + ")
    .replace(/(?<=\d)-/g, " − ")
    .replace(/\^/g, " ^ ");
}

function spokenExpr(expr) {
  return pretty(expr)
    .replace(/ × /g, " times ")
    .replace(/ ÷ /g, " divided by ")
    .replace(/ − /g, " minus ")
    .replace(/ \+ /g, " plus ")
    .replace(/ \^ 2\b/g, " squared")
    .replace(/ \^ /g, " to the power of ")
    .replace(/√/g, "the square root of ")
    .replace(/∛/g, "the cube root of ")
    .replace(/(\d+(?:\.\d+)?)%/g, "$1 percent");
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

Calculator.Parser = Parser;
Calculator.fmt = fmt;
module.exports = Calculator;
