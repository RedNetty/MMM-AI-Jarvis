"use strict";

const { EventEmitter } = require("events");
const crypto = require("crypto");
const log = require("./log");

/**
 * Live widgets shown on the mirror: scores, timers, info panels, outfits,
 * wardrobe items and camera snapshots.
 *
 * A widget is { id, type, key?, data, expiresAt?, refresh? } where
 *   key       – de-duplication key (asking for the same game twice updates
 *               the existing card instead of adding another)
 *   expiresAt – epoch ms when it disappears (null = until dismissed)
 *   refresh   – async (widget) => { data?, nextMs?, expireInMs? } called on a
 *               schedule to keep the widget live (e.g. scores)
 *
 * Events:
 *   "change" (publicList)  – the visible set or any widget's data changed
 *   "expired" (widget)     – a widget reached its expiry (timers use this)
 */
class Widgets extends EventEmitter {
  /**
   * @param {{ max?: number }} [options]
   */
  constructor({ max = 4 } = {}) {
    super();
    this.max = max;
    /** @type {Map<string, object>} */
    this.items = new Map();
  }

  /**
   * Add a widget, or update the existing one with the same key.
   * @param {{ type: string, key?: string, data: object, ttlMs?: number|null, refresh?: Function, firstRefreshMs?: number }} spec
   * @returns {object} The stored widget.
   */
  add({ type, key, data, ttlMs = null, refresh = null, firstRefreshMs = null }) {
    const existing = key ? [...this.items.values()].find((w) => w.key === key) : null;
    const widget = existing ?? { id: crypto.randomBytes(4).toString("hex"), type, key: key ?? null, createdAt: Date.now() };

    widget.data = data;
    widget.refresh = refresh;
    widget.updatedAt = Date.now();
    this._setExpiry(widget, ttlMs);

    if (!existing) {
      this.items.set(widget.id, widget);
      this._enforceLimit();
    } else {
      // Re-asking for something moves it to the top.
      this.items.delete(widget.id);
      this.items.set(widget.id, widget);
    }

    this._scheduleRefresh(widget, firstRefreshMs);
    this._emitChange();
    return widget;
  }

  /**
   * Remove widgets by id, or all widgets of a type.
   * @param {{ id?: string, type?: string, predicate?: (w: object) => boolean }} which
   * @returns {object[]} Removed widgets.
   */
  remove({ id, type, predicate } = {}) {
    const removed = [...this.items.values()].filter(
      (w) => (id && w.id === id) || (type && w.type === type) || (predicate && predicate(w)),
    );
    for (const w of removed) this._drop(w);
    if (removed.length) this._emitChange();
    return removed;
  }

  clear() {
    const all = [...this.items.values()];
    for (const w of all) this._drop(w);
    if (all.length) this._emitChange();
    return all;
  }

  list(type) {
    return [...this.items.values()].filter((w) => !type || w.type === type);
  }

  /** Serializable list for the front-end, newest first. */
  toPublic() {
    return [...this.items.values()]
      .reverse()
      .map((w) => ({ id: w.id, type: w.type, data: w.data, expiresAt: w.expiresAt ?? null, updatedAt: w.updatedAt }));
  }

  stop() {
    for (const w of this.items.values()) {
      clearTimeout(w.refreshTimer);
      clearTimeout(w.expiryTimer);
    }
    this.items.clear();
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  _setExpiry(widget, ttlMs) {
    clearTimeout(widget.expiryTimer);
    widget.expiresAt = ttlMs ? Date.now() + ttlMs : null;
    if (ttlMs) {
      widget.expiryTimer = setTimeout(() => {
        if (!this.items.has(widget.id)) return;
        this._drop(widget);
        this.emit("expired", widget);
        this._emitChange();
      }, ttlMs);
      widget.expiryTimer.unref?.();
    }
  }

  _scheduleRefresh(widget, delayMs) {
    clearTimeout(widget.refreshTimer);
    if (!widget.refresh || !delayMs) return;

    widget.refreshTimer = setTimeout(async () => {
      if (!this.items.has(widget.id)) return;
      let next = delayMs;
      try {
        const result = (await widget.refresh(widget)) ?? {};
        if (!this.items.has(widget.id)) return;
        if (result.data) {
          widget.data = result.data;
          widget.updatedAt = Date.now();
          this._emitChange();
        }
        if (result.expireInMs !== undefined) this._setExpiry(widget, result.expireInMs);
        next = result.nextMs ?? null;
      } catch (err) {
        log.warn(`Widget ${widget.type} refresh failed: ${err.message}`);
        next = Math.min(delayMs * 2, 5 * 60 * 1000);
      }
      if (next) this._scheduleRefresh(widget, next);
    }, delayMs);
    widget.refreshTimer.unref?.();
  }

  _enforceLimit() {
    // Oldest non-timer widgets go first; running timers are never evicted.
    while (this.items.size > this.max) {
      const victim = [...this.items.values()].find((w) => w.type !== "timer") ?? this.items.values().next().value;
      this._drop(victim);
    }
  }

  _drop(widget) {
    clearTimeout(widget.refreshTimer);
    clearTimeout(widget.expiryTimer);
    this.items.delete(widget.id);
  }

  _emitChange() {
    this.emit("change", this.toPublic());
  }
}

module.exports = Widgets;
