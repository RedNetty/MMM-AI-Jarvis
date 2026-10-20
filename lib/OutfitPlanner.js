"use strict";

const Wardrobe = require("./Wardrobe");
const { normalize, isoDate, daysBetween } = require("./text");

const NEUTRALS = new Set([
  "black", "white", "grey", "gray", "charcoal", "navy", "beige", "tan", "brown", "cream", "ivory",
  "khaki", "olive", "denim", "blue", "camel", "stone", "taupe",
]);

const OCCASIONS = [
  { formality: "formal", re: /\b(wedding|formal|gala|black tie|funeral|ceremony|opera)\b/ },
  { formality: "business", re: /\b(interview|office|work|meeting|business|presentation|conference|client)\b/ },
  { formality: "smart-casual", re: /\b(dinner|date|party|drinks|restaurant|brunch|theatre|theater|smart)\b/ },
  { formality: "athletic", re: /\b(gym|run|running|workout|hike|hiking|training|yoga|sport)\b/ },
  { formality: "lounge", re: /\b(lounge|home|relax|chill|sofa|couch|lazy)\b/ },
];

const RAIN_WORDS = /\b(rain|waterproof|shell|parka|trench|mac|anorak|windbreaker)\b/;
const OPEN_SHOES = /\b(sandals?|flip ?flops?|slides|espadrilles|canvas)\b/;
const RAIN_SHOES = /\b(boots?|wellies|wellingtons|leather)\b/;
const COLD_ACCESSORIES = /\b(beanie|scarf|gloves?|wool hat|knit hat|hat|cap)\b/;
const SUN_ACCESSORIES = /\b(sunglasses|cap|sun hat|hat)\b/;
const DISLIKE = /\b(?:doesn't like|does not like|dislikes|hates|never wears|can't stand|is allergic to|avoids)\s+(?:wearing\s+)?([^.,;]+)/gi;

/**
 * Rule-based outfit planner: picks a coordinated outfit from the wardrobe in
 * a few milliseconds, with no language model. On a Raspberry Pi that's the
 * difference between an instant answer and a 10-20 second one.
 *
 * It matches item warmth to the temperature, adds outerwear for cold, rain
 * or wind, avoids open shoes in the rain, matches formality to the occasion
 * named in the request, avoids recently worn items and anything the user
 * said they dislike, and prefers combinations with at most one bold colour.
 */
class OutfitPlanner {
  /**
   * @param {object[]} items Wardrobe items.
   * @param {object|null} weather Normalised weather (see Weather.js).
   * @param {{ request?: string, facts?: string[], today?: string }} [options]
   * @returns {{ items: object[], title: string, spoken: string } | null}
   */
  static plan(items, weather, { request = "", facts = [], today = isoDate() } = {}) {
    if (!items.length) return null;

    const conditions = OutfitPlanner.conditions(weather);
    const formality = OutfitPlanner.occasion(request);
    const dislikes = OutfitPlanner.dislikes(facts);
    const ctx = { conditions, formality, dislikes, today };

    const best = (category, extraScore = () => 0) => {
      const ranked = items
        .filter((i) => i.category === category)
        .map((i) => ({ item: i, score: OutfitPlanner.score(i, ctx) + extraScore(i) }))
        .sort((a, b) => b.score - a.score || (a.item.lastWorn ?? "").localeCompare(b.item.lastWorn ?? "") || a.item.id.localeCompare(b.item.id));
      return ranked[0] && ranked[0].score > -50 ? ranked[0] : null;
    };

    const chosen = [];
    const top = best("top");
    const bottom = best("bottom", (i) => (/\bshorts\b/i.test(i.name) ? (conditions.tempC >= 22 ? 1 : -6) : 0));
    const dress = best("dress");
    const separatesScore = top && bottom ? (top.score + bottom.score) / 2 : -Infinity;
    if (dress && dress.score > separatesScore) {
      chosen.push(dress.item);
    } else {
      if (top) chosen.push(top.item);
      if (bottom) chosen.push(bottom.item);
    }

    const shoes = best("shoes", (i) => {
      const name = normalize(i.name);
      if (conditions.rainy) return OPEN_SHOES.test(name) ? -8 : RAIN_SHOES.test(name) ? 3 : 0;
      if (conditions.tempC >= 24) return OPEN_SHOES.test(name) ? 2 : 0;
      return OPEN_SHOES.test(name) ? -4 : 0;
    });
    if (shoes) chosen.push(shoes.item);

    // Outerwear for cold, rain or wind – and a tailored layer (blazer) for dressy occasions.
    const dressy = formality === "business" || formality === "formal";
    if (conditions.targetWarmth >= 4 || conditions.rainy || conditions.windy || dressy) {
      const outer = best("outerwear", (i) => (conditions.rainy && RAIN_WORDS.test(normalize(i.name)) ? 6 : 0));
      if (outer && (!dressy || conditions.targetWarmth >= 4 || conditions.rainy || outer.item.formality === formality)) {
        chosen.push(outer.item);
      }
    }

    const accessory = best("accessory", (i) => {
      const name = normalize(i.name);
      if (conditions.tempC < 8 && COLD_ACCESSORIES.test(name)) return 4;
      if (conditions.sunny && conditions.tempC >= 18 && SUN_ACCESSORIES.test(name)) return 4;
      return -10; // only add accessories that serve a purpose
    });
    if (accessory && accessory.score > 0) chosen.push(accessory.item);

    OutfitPlanner.harmonize(chosen, items, ctx);
    if (chosen.length === 0) return null;

    return {
      items: chosen,
      title: OutfitPlanner.title(conditions, formality),
      spoken: OutfitPlanner.describe(chosen, conditions, weather),
    };
  }

  /**
   * Weather in planner terms. Without weather, assumes a mild dry day.
   * @param {object|null} w
   */
  static conditions(w) {
    const toC = (v) => (v === null || v === undefined ? null : w?.units?.temp === "°F" ? ((v - 32) * 5) / 9 : v);
    const toKmh = (v) => (v === null || v === undefined ? null : w?.units?.wind === "mph" ? v * 1.609 : v);
    const now = w?.current;
    const day = w?.day;

    const first = (...vals) => vals.find((v) => v !== null && v !== undefined && Number.isFinite(v)) ?? null;
    const dayMean = day && day.high !== null && day.low !== null ? (day.high + day.low) / 2 : null;
    // Choose clothes by what it feels like; say the actual temperature.
    const tempC = first(toC(now?.feelsLike), toC(now?.temperature), toC(dayMean)) ?? 18;
    const shownC = first(toC(now?.temperature), toC(dayMean), tempC);
    const condition = `${now?.condition ?? ""} ${day?.condition ?? ""}`.toLowerCase();
    const rainChance = day?.precipChance ?? null;
    const rainy = /rain|drizzle|shower|storm|snow|sleet/.test(condition) || (rainChance ?? 0) >= 40;
    const windy = (toKmh(now?.wind ?? day?.wind) ?? 0) >= 30;
    const sunny = /clear|sun/.test(condition) && !rainy;

    let targetWarmth;
    if (tempC >= 27) targetWarmth = 1;
    else if (tempC >= 21) targetWarmth = 2;
    else if (tempC >= 15) targetWarmth = 3;
    else if (tempC >= 8) targetWarmth = 4;
    else targetWarmth = 5;

    return { known: Boolean(w), tempC, shownC, rainy, rainChance, windy, sunny, targetWarmth };
  }

  /** Formality implied by the request, or null when none is named. */
  static occasion(request) {
    const text = normalize(request);
    return OCCASIONS.find((o) => o.re.test(text))?.formality ?? null;
  }

  /** Words the user said they dislike ("the user hates wool" → ["wool"]). */
  static dislikes(facts) {
    const words = [];
    for (const fact of facts) {
      for (const m of String(fact).matchAll(DISLIKE)) {
        words.push(...normalize(m[1]).split(" ").filter((w) => w.length > 2 && !["the", "and", "any", "too"].includes(w)));
      }
    }
    return [...new Set(words)];
  }

  /** Score one item for the conditions (higher is better). */
  static score(item, { conditions, formality, dislikes, today }) {
    let score = 0;

    // Tops and bottoms rarely carry full winter warmth; outerwear does the rest.
    const target = item.category === "outerwear" ? conditions.targetWarmth : Math.min(conditions.targetWarmth, 3);
    score -= Math.abs((item.warmth ?? 3) - target) * 2;

    if (formality) {
      const scale = Wardrobe.FORMALITY;
      score -= Math.abs(scale.indexOf(item.formality) - scale.indexOf(formality)) * 2.5;
    } else if (["formal", "athletic", "lounge"].includes(item.formality)) {
      score -= 2; // without an occasion, prefer everyday clothes
    }

    if (item.lastWorn) {
      const days = daysBetween(item.lastWorn, today);
      if (days <= 1) score -= 3;
      else if (days <= 4) score -= 1.5;
    }

    const hay = normalize(`${item.name} ${item.colors.join(" ")} ${item.material ?? ""} ${item.pattern ?? ""}`);
    if (dislikes.some((w) => hay.split(" ").includes(w))) score -= 100;

    return score;
  }

  /** Swap the weakest piece if more than one bold (non-neutral) colour clashes. */
  static harmonize(chosen, items, ctx) {
    const bold = (i) => i.colors.length > 0 && !i.colors.every((c) => NEUTRALS.has(c));
    const bolds = chosen.filter(bold);
    if (bolds.length <= 1) return;

    for (const piece of bolds.slice(1)) {
      const alternative = items
        .filter((i) => i.category === piece.category && !bold(i) && !chosen.includes(i))
        .map((i) => ({ item: i, score: OutfitPlanner.score(i, ctx) }))
        .sort((a, b) => b.score - a.score)[0];
      if (alternative && alternative.score >= OutfitPlanner.score(piece, ctx) - 3) {
        chosen[chosen.indexOf(piece)] = alternative.item;
      }
    }
  }

  static title(c, formality) {
    if (formality === "business") return "Office ready";
    if (formality === "formal") return "Dressed up";
    if (formality === "athletic") return "Ready to move";
    if (c.rainy) return c.tempC < 10 ? "Cold and wet" : "Rain ready";
    if (c.targetWarmth >= 5) return "Bundle up";
    if (c.targetWarmth >= 4) return "Cool day layers";
    if (c.targetWarmth <= 1) return "Hot day light";
    return c.sunny ? "Fair weather" : "Everyday easy";
  }

  /** One or two natural sentences naming the pieces and the reason. */
  static describe(chosen, c, weather) {
    const lower = (s) => (s && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
    const your = (items) => items.map((i) => `your ${lower(i.name)}`);
    const list = (xs) => (xs.length <= 1 ? xs[0] ?? "" : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
    const main = your(chosen.filter((i) => !["outerwear", "accessory"].includes(i.category)));
    const outer = your(chosen.filter((i) => i.category === "outerwear"));
    const extra = your(chosen.filter((i) => i.category === "accessory"));

    let lead;
    if (!c.known) {
      lead = "I don't have the weather, but I'd go with";
    } else {
      const t = weather?.units?.temp === "°F" ? Math.round((c.shownC * 9) / 5 + 32) : Math.round(c.shownC);
      const sky = c.rainy ? (c.rainChance !== null && c.rainChance < 70 ? " and rain is possible" : " and wet") : c.sunny ? " and sunny" : "";
      lead = `It's ${t} ${Math.abs(t) === 1 ? "degree" : "degrees"}${sky}, so I'd go with`;
    }

    if (main.length === 0) return `${lead} ${list([...outer, ...extra])}.`;
    const sentences = [`${lead} ${list(main)}.`];
    if (outer.length) {
      const why = c.rainy ? " for the rain" : c.windy ? " against the wind" : c.targetWarmth >= 4 ? " to keep warm" : "";
      sentences.push(`Add ${list(outer)}${why}${extra.length ? `, plus ${list(extra)}` : ""}.`);
    } else if (extra.length) {
      sentences.push(`Add ${list(extra)}.`);
    }
    return sentences.join(" ");
  }
}

module.exports = OutfitPlanner;
