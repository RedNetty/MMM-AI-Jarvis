"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Wardrobe = require("../lib/Wardrobe");
const Memory = require("../lib/Memory");
const Weather = require("../lib/Weather");
const Skills = require("../lib/Skills");
const { detectIntent } = require("../lib/intents");
const { isoDate } = require("../lib/text");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-test-"));
}

test("Wardrobe add/sanitize/find/resolve and persistence", () => {
  const dir = tempDir();
  const w = new Wardrobe(dir);
  const shirt = w.add({ name: "Navy linen shirt", category: "TOP", colors: "navy, white", warmth: 9, formality: "smart-casual" });
  w.add({ name: "Grey wool coat", category: "outerwear", colors: ["grey"], warmth: 5, seasons: ["winter", "summerish"] });

  assert.equal(shirt.category, "top");
  assert.deepEqual(shirt.colors, ["navy", "white"]);
  assert.equal(shirt.warmth, 5);
  assert.equal(w.find({ color: "grey" }).length, 1);
  assert.equal(w.find({ query: "linen" })[0].id, shirt.id);
  assert.equal(w.resolve("navy shirt").id, shirt.id);
  assert.equal(w.resolve("purple hat"), null);
  assert.deepEqual(w.items[1].seasons, ["winter"]);

  const reloaded = new Wardrobe(dir);
  assert.equal(reloaded.items.length, 2);
});

test("Wardrobe wear log replaces same-day entries and tracks counts", () => {
  const w = new Wardrobe(tempDir());
  const a = w.add({ name: "White tee", category: "top" });
  const b = w.add({ name: "Blue jeans", category: "bottom" });
  const today = isoDate();

  w.logWorn([a.id, b.id]);
  w.logWorn([b.id]); // corrected outfit for today
  assert.equal(w.history.length, 1);
  assert.equal(w.get(a.id).wearCount, 0);
  assert.equal(w.get(b.id).wearCount, 1);
  assert.equal(w.get(b.id).lastWorn, today);
  assert.deepEqual(w.recentHistory(7)[0].items, ["Blue jeans"]);
  assert.match(w.describeForPrompt(), /Blue jeans \| bottom .* worn 0d ago/);
});

test("Wardrobe remove deletes unshared photo", async () => {
  const dir = tempDir();
  const w = new Wardrobe(dir);
  fs.mkdirSync(w.photoDir, { recursive: true });
  fs.writeFileSync(path.join(w.photoDir, "p.jpg"), "x");
  const a = w.add({ name: "Scarf", category: "accessory", photo: { file: "p.jpg" } });
  const b = w.add({ name: "Hat", category: "accessory", photo: { file: "p.jpg" } });

  w.remove(a.id);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(path.join(w.photoDir, "p.jpg")), "photo still used by hat");
  w.remove(b.id);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!fs.existsSync(path.join(w.photoDir, "p.jpg")));
});

test("Corrupt store is moved aside, not lost", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "memory.json"), "{not json");
  const m = new Memory(dir);
  assert.equal(m.facts.length, 0);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("memory.json.corrupt-")));
});

test("Memory add/dedupe/remove", () => {
  const m = new Memory(tempDir());
  m.add("Dislikes wearing yellow");
  m.add("dislikes wearing yellow.");
  m.add("Office dress code is business casual");
  assert.equal(m.facts.length, 2);
  assert.equal(m.remove("yellow").length, 1);
  assert.equal(m.facts.length, 1);
  assert.equal(m.remove("pizza").length, 0);
});

test("Weather from MagicMirror summary converts units", async () => {
  const w = new Weather({ units: "imperial" });
  w.updateFromMirror({
    locationName: "Leeds",
    current: { temperature: 10, feelsLike: 8, humidity: 80, windSpeed: 5, weatherType: "day-rain" },
    forecast: [{ maxTemperature: 12, minTemperature: 4, precipitationProbability: 70, weatherType: "night-alt-showers" }],
  });
  const today = await w.get("today");
  assert.equal(today.current.temperature, 50);
  assert.equal(today.current.condition, "rain");
  assert.equal(today.day.high, 53.6);
  assert.equal(today.day.condition, "showers");
  assert.match(Weather.describe(today), /Location: Leeds\. Now: 50°F \(feels like 46°F\), rain, wind 11 mph\. Today: showers, high 54°F, low 39°F, 70% chance/);
  assert.equal(await new Weather().get(), null);
});

test("Open-Meteo response parsing", () => {
  const w = new Weather({ latitude: 1, longitude: 2 });
  const parsed = w._fromOpenMeteo(
    {
      current: { temperature_2m: 3.21, apparent_temperature: -1, relative_humidity_2m: 90, weather_code: 71, wind_speed_10m: 20 },
      daily: {
        weather_code: [73, 0],
        temperature_2m_max: [4, 9],
        temperature_2m_min: [-2, 1],
        precipitation_probability_max: [80, 5],
        uv_index_max: [1, 3],
        wind_speed_10m_max: [30, 10],
      },
    },
    1,
  );
  assert.equal(parsed.current, null);
  assert.equal(parsed.day.label, "tomorrow");
  assert.equal(parsed.day.condition, "clear sky");
  assert.equal(parsed.day.high, 9);
});

test("Intent detection", () => {
  const name = (q) => detectIntent(q)?.name ?? null;
  assert.equal(name("what should I wear today"), "suggest_outfit");
  assert.equal(name("pick me an outfit for a wedding"), "suggest_outfit");
  assert.equal(name("how do I look"), "look_at_user");
  assert.equal(name("does this shirt go with my jeans"), null);
  assert.equal(name("do these match"), "look_at_user");
  assert.equal(name("add this jacket to my wardrobe"), "scan_clothing");
  assert.equal(name("save these shoes"), "scan_clothing");
  assert.equal(name("remember that I hate yellow"), "remember");
  assert.equal(name("what's the capital of France"), null);
  assert.equal(detectIntent("how do I look", { isAvailable: (n) => n !== "look_at_user" }), null);
});

test("Bounding box normalisation", () => {
  assert.deepEqual(Skills.normalizeBox([100, 200, 600, 900]), { x1: 100, y1: 200, x2: 600, y2: 900 });
  assert.deepEqual(Skills.normalizeBox([600, 900, 100, 200]), { x1: 100, y1: 200, x2: 600, y2: 900 });
  assert.deepEqual(Skills.normalizeBox([128, 96, 1280, 960], 1280, 960), { x1: 100, y1: 100, x2: 1000, y2: 1000 });
  assert.equal(Skills.normalizeBox([10, 10, 20, 20]), null);
  assert.equal(Skills.normalizeBox("nope"), null);
});
