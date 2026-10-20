"use strict";

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const JsonStore = require("./JsonStore");
const { normalize, isoDate, daysBetween } = require("./text");

const CATEGORIES = ["top", "bottom", "dress", "outerwear", "shoes", "accessory", "other"];
const FORMALITY = ["athletic", "lounge", "casual", "smart-casual", "business", "formal"];
const SEASONS = ["spring", "summer", "autumn", "winter"];
const MAX_HISTORY = 365;

/**
 * Persistent wardrobe: clothing items, their photos and what was worn when.
 *
 * Item shape:
 * {
 *   id, name, category, colors[], pattern, material, formality, seasons[],
 *   warmth (1 = very light … 5 = very warm), notes,
 *   photo: { file, width, height, box: [ymin, xmin, ymax, xmax] (0-1000) } | null,
 *   addedAt, lastWorn (YYYY-MM-DD | null), wearCount
 * }
 */
class Wardrobe {
  /**
   * @param {string} dataDir Directory for wardrobe.json and photos/.
   */
  constructor(dataDir) {
    this.photoDir = path.join(dataDir, "photos");
    this.store = new JsonStore(path.join(dataDir, "wardrobe.json"), {
      version: 1,
      items: [],
      history: [],
    });
  }

  get items() {
    return this.store.data.items;
  }

  get history() {
    return this.store.data.history;
  }

  // ─── Items ─────────────────────────────────────────────────────────────

  /**
   * Add an item. Unknown enum values are coerced to safe defaults.
   * @param {object} input
   * @returns {object} The stored item.
   */
  add(input) {
    const item = this._sanitize({
      ...input,
      id: this._newId(),
      addedAt: new Date().toISOString(),
      lastWorn: null,
      wearCount: 0,
    });
    if (!item.name) throw new Error("A wardrobe item needs a name.");
    this.items.push(item);
    this.store.save();
    return item;
  }

  /**
   * Update fields on an existing item.
   * @param {string} idOrName
   * @param {object} changes
   */
  update(idOrName, changes) {
    const item = this.resolve(idOrName);
    if (!item) throw new Error(`No wardrobe item matches "${idOrName}".`);

    const editable = ["name", "category", "colors", "pattern", "material", "formality", "seasons", "warmth", "notes"];
    const patch = {};
    for (const key of editable) {
      if (changes[key] !== undefined && changes[key] !== null) patch[key] = changes[key];
    }
    Object.assign(item, this._sanitize({ ...item, ...patch }));
    this.store.save();
    return item;
  }

  /**
   * Remove an item and delete its photo if nothing else uses it.
   * @param {string} idOrName
   */
  remove(idOrName) {
    const item = this.resolve(idOrName);
    if (!item) throw new Error(`No wardrobe item matches "${idOrName}".`);

    this.store.data.items = this.items.filter((i) => i.id !== item.id);
    this.store.save();

    const file = item.photo?.file;
    if (file && !this.items.some((i) => i.photo?.file === file)) {
      fs.rm(path.join(this.photoDir, file), { force: true }, () => {});
    }
    return item;
  }

  get(id) {
    return this.items.find((i) => i.id === id) ?? null;
  }

  /**
   * Find an item by exact id, else by best name match.
   * @param {string} idOrName
   */
  resolve(idOrName) {
    if (!idOrName) return null;
    const byId = this.get(String(idOrName).trim());
    if (byId) return byId;

    const wanted = normalize(idOrName);
    if (!wanted) return null;
    const exact = this.items.find((i) => normalize(i.name) === wanted);
    if (exact) return exact;

    const tokens = wanted.split(" ");
    let best = null;
    let bestScore = 0;
    for (const item of this.items) {
      const hay = normalize(`${item.name} ${item.colors.join(" ")} ${item.category}`);
      const score = tokens.filter((t) => hay.includes(t)).length / tokens.length;
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }
    return bestScore >= 0.6 ? best : null;
  }

  /**
   * Filter items by free text, category and/or colour.
   * @param {{ query?: string, category?: string, color?: string }} [filter]
   */
  find({ query, category, color } = {}) {
    const q = normalize(query);
    const c = normalize(color);
    return this.items.filter((item) => {
      if (category && item.category !== category) return false;
      if (c && !item.colors.some((col) => normalize(col).includes(c))) return false;
      if (q) {
        const hay = normalize(
          [item.name, item.category, item.pattern, item.material, item.formality, item.notes, ...item.colors].join(" "),
        );
        if (!q.split(" ").every((t) => hay.includes(t))) return false;
      }
      return true;
    });
  }

  // ─── Wear history ──────────────────────────────────────────────────────

  /**
   * Record that a set of items was worn on a date (defaults to today).
   * Replaces any existing entry for the same date.
   * @param {string[]} itemIds
   * @param {{ date?: string, occasion?: string }} [opts]
   */
  logWorn(itemIds, { date = isoDate(), occasion = "" } = {}) {
    const items = itemIds.map((id) => this.resolve(id)).filter(Boolean);
    if (items.length === 0) throw new Error("None of those items are in the wardrobe.");

    const previous = this.history.find((h) => h.date === date);
    if (previous) {
      for (const id of previous.itemIds) {
        const old = this.get(id);
        if (old) old.wearCount = Math.max(0, old.wearCount - 1);
      }
    }

    this.store.data.history = this.history.filter((h) => h.date !== date);
    this.history.push({ date, itemIds: items.map((i) => i.id), occasion });
    this.history.sort((a, b) => a.date.localeCompare(b.date));
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);

    for (const item of items) {
      item.wearCount += 1;
      item.lastWorn = this.history.filter((h) => h.itemIds.includes(item.id)).at(-1)?.date ?? date;
    }
    this.store.save();
    return items;
  }

  /**
   * Outfits worn in the last N days, newest first, with item names resolved.
   * @param {number} [days=7]
   */
  recentHistory(days = 7) {
    const today = isoDate();
    return this.history
      .filter((h) => daysBetween(h.date, today) < days)
      .reverse()
      .map((h) => ({
        date: h.date,
        occasion: h.occasion,
        items: h.itemIds.map((id) => this.get(id)?.name ?? "(removed item)"),
      }));
  }

  // ─── Prompt helpers ────────────────────────────────────────────────────

  /**
   * Compact one-line-per-item listing for LLM prompts. Kept terse because
   * small local models have limited context.
   * @param {object[]} [items]
   */
  describeForPrompt(items = this.items) {
    const today = isoDate();
    return items
      .map((i) => {
        const worn = i.lastWorn ? `${daysBetween(i.lastWorn, today)}d ago` : "never";
        const colors = i.colors.length ? i.colors.join("/") : "?";
        return `${i.id} | ${i.name} | ${i.category} | ${colors} | ${i.formality} | warmth ${i.warmth} | worn ${worn}`;
      })
      .join("\n");
  }

  /**
   * Plain object suitable for the mirror UI.
   * @param {object} item
   */
  toCard(item) {
    return {
      id: item.id,
      name: item.name,
      category: item.category,
      colors: item.colors,
      photo: item.photo
        ? {
            url: `/MMM-AI-Jarvis/photos/${item.photo.file}`,
            width: item.photo.width,
            height: item.photo.height,
            box: item.photo.box,
          }
        : null,
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  _newId() {
    let id;
    do {
      id = `w${crypto.randomBytes(3).toString("hex")}`;
    } while (this.get(id));
    return id;
  }

  _sanitize(item) {
    const lowerList = (v) =>
      (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,/]/) : [])
        .map((s) => String(s).trim().toLowerCase())
        .filter(Boolean);

    const category = String(item.category ?? "").toLowerCase();
    const formality = String(item.formality ?? "").toLowerCase();
    const warmth = Math.round(Number(item.warmth));

    return {
      ...item,
      name: String(item.name ?? "").trim().slice(0, 80),
      category: CATEGORIES.includes(category) ? category : "other",
      colors: lowerList(item.colors).slice(0, 4),
      pattern: String(item.pattern ?? "").trim().toLowerCase().slice(0, 40),
      material: String(item.material ?? "").trim().toLowerCase().slice(0, 40),
      formality: FORMALITY.includes(formality) ? formality : "casual",
      seasons: lowerList(item.seasons).filter((s) => SEASONS.includes(s)),
      warmth: Number.isFinite(warmth) ? Math.min(5, Math.max(1, warmth)) : 3,
      notes: String(item.notes ?? "").trim().slice(0, 200),
      photo: item.photo ?? null,
    };
  }
}

Wardrobe.CATEGORIES = CATEGORIES;
Wardrobe.FORMALITY = FORMALITY;
Wardrobe.SEASONS = SEASONS;

module.exports = Wardrobe;
