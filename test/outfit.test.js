"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// Replies pick among phrasings at random; tests always get the first one.
require("../lib/speech/talk").random = () => 0;
const OutfitPlanner = require("../lib/OutfitPlanner");

let n = 0;
const item = (name, category, colors, warmth, formality = "casual", lastWorn = null) => ({
  id: `w${n++}`, name, category, colors, warmth, formality, lastWorn,
});

const WARDROBE = [
  item("Navy oxford shirt", "top", ["navy"], 2, "smart-casual"),
  item("White tee", "top", ["white"], 1),
  item("Grey hoodie", "top", ["grey"], 3),
  item("Red flannel shirt", "top", ["red"], 3),
  item("White dress shirt", "top", ["white"], 2, "business"),
  item("Dark jeans", "bottom", ["blue"], 3),
  item("Khaki shorts", "bottom", ["khaki"], 1),
  item("Grey suit trousers", "bottom", ["grey"], 2, "business"),
  item("Grey wool overcoat", "outerwear", ["grey"], 5, "smart-casual"),
  item("Black rain jacket", "outerwear", ["black"], 3),
  item("Navy blazer", "outerwear", ["navy"], 3, "business"),
  item("White sneakers", "shoes", ["white"], 2),
  item("Brown leather boots", "shoes", ["brown"], 3),
  item("Tan sandals", "shoes", ["tan"], 1),
  item("Black oxford shoes", "shoes", ["black"], 2, "business"),
  item("Red wool beanie", "accessory", ["red"], 4),
  item("Sunglasses", "accessory", ["black"], 1),
];

const weather = (current, day, units = "°C") => ({ units: { temp: units, wind: units === "°F" ? "mph" : "km/h" }, current, day });
const names = (plan) => plan.items.map((i) => i.name);

test("cold rain: warm layers, boots, rain jacket and a beanie; says the real temperature", () => {
  const plan = OutfitPlanner.plan(
    WARDROBE,
    weather({ temperature: 6, feelsLike: 3, condition: "light rain", wind: 15 }, { high: 8, low: 3, precipChance: 80, condition: "rain" }),
  );
  assert.deepEqual(names(plan), ["Grey hoodie", "Dark jeans", "Brown leather boots", "Black rain jacket", "Red wool beanie"]);
  assert.equal(plan.title, "Cold and wet");
  assert.equal(
    plan.spoken,
    "It's 6° and wet, so I'd go with your grey hoodie, dark jeans and brown leather boots. Add the black rain jacket for the rain, and the red wool beanie.",
  );
});

test("hot sun: light clothes, shorts, sandals and sunglasses", () => {
  const plan = OutfitPlanner.plan(
    WARDROBE,
    weather({ temperature: 29, feelsLike: 30, condition: "clear sky", wind: 5 }, { high: 31, low: 20, precipChance: 0, condition: "clear sky" }),
  );
  assert.deepEqual(names(plan), ["White tee", "Khaki shorts", "Tan sandals", "Sunglasses"]);
});

test("occasion sets formality, including a blazer; °F is spoken in °F", () => {
  const plan = OutfitPlanner.plan(
    WARDROBE,
    weather({ temperature: 62, condition: "partly cloudy", wind: 6 }, { high: 66, low: 50, precipChance: 10 }, "°F"),
    { request: "I have a job interview" },
  );
  assert.deepEqual(names(plan), ["White dress shirt", "Grey suit trousers", "Black oxford shoes", "Navy blazer"]);
  assert.equal(plan.title, "Office ready");
  assert.match(plan.spoken, /^It's 62°, so I'd go with your white dress shirt, grey suit trousers and black oxford shoes\. Add the navy blazer\.$/);
});

test("dislikes, recent wear and missing weather", () => {
  const cold = weather({ temperature: 4, condition: "overcast", wind: 10 }, { high: 6, low: 1, precipChance: 10 });
  const plan = OutfitPlanner.plan(WARDROBE, cold, { facts: ["the user hates red"] });
  assert.ok(!names(plan).some((n) => /red/i.test(n)), "nothing red");

  const today = "2026-10-20";
  const worn = WARDROBE.map((i) => (i.name === "Grey hoodie" ? { ...i, lastWorn: "2026-10-19" } : i));
  assert.ok(!names(OutfitPlanner.plan(worn, cold, { today })).includes("Grey hoodie"), "worn yesterday is skipped");

  const unknown = OutfitPlanner.plan(WARDROBE, null);
  assert.match(unknown.spoken, /^I don't have the weather, but I'd go with your /);
  assert.equal(OutfitPlanner.plan([], null), null);
});

test("dislike extraction from remembered facts", () => {
  assert.deepEqual(OutfitPlanner.dislikes(["the user really doesn't like wearing orange", "the user is allergic to wool", "the user's office is casual"]), [
    "orange",
    "wool",
  ]);
});

test("plans for the part of the day asked about", () => {
  // Mild now, but the evening window drops to 6°: dress for the evening.
  const w = {
    units: { temp: "°C", wind: "km/h" },
    current: { temperature: 17, feelsLike: 17, condition: "clear sky", wind: 5 },
    day: { label: "today", high: 18, low: 6, precipChance: 0, condition: "clear sky" },
    window: { label: "tonight", high: 11, low: 6, precipChance: 0, condition: "clear sky", wind: 5 },
  };
  const plan = OutfitPlanner.plan(WARDROBE, w, { request: "dinner tonight" });
  assert.ok(plan.items.some((i) => i.category === "outerwear"), "a layer for the cold evening");
  assert.match(plan.spoken, /^Tonight it'll be about 6° and clear, so I'd go with your /);
});
