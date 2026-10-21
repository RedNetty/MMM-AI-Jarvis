"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Replies pick among phrasings at random; tests always get the first one.
require("../lib/speech/talk").random = () => 0;

const Screen = require("../lib/Screen");
const DisplaySkills = require("../lib/DisplaySkills");
const Markets = require("../lib/data/Markets");
const { detectIntent } = require("../lib/intents");

const INVENTORY = [
  { id: "m1", name: "clock", position: "top_left" },
  { id: "m2", name: "calendar", position: "top_left" },
  { id: "m3", name: "weather", position: "top_right" },
  { id: "m4", name: "MMM-AI-Jarvis", position: "bottom_center" },
];

function build(file = null) {
  const screen = new Screen({ file });
  const commands = [];
  screen.on("command", (c) => commands.push(c));
  screen.setInventory(INVENTORY);
  return { screen, commands, display: new DisplaySkills({ screen }) };
}

const director = (commands) => commands.filter((c) => c.action === "director").map(({ op, args }) => ({ op, args }));

test("display: moving and resizing any module, itself included, says what changed", () => {
  const { display, commands } = build();
  assert.equal(display.move("calendar", "top right").spoken, "Done. The calendar is in the top right now.");
  assert.equal(display.move("you", "middle").spoken, "Okay, I'm in the middle now.");
  assert.match(display.move("calendar", "over there").spoken, /^Where should I put the calendar\?/);
  assert.equal(display.move("pancakes", "top left").spoken, "I can't find the pancakes on the mirror.");

  assert.equal(display.resize("clock", "bigger").spoken, "Done.");
  display.resize("clock", "bigger");
  assert.equal(display.resize("clock", "reset").spoken, "The clock is back to its normal size.");
  assert.equal(display.resize("everything", "bigger").spoken, "Bigger text everywhere. That's 115%.");
  assert.equal(display.resize("the text", "reset").spoken, "Text is back to normal size.");

  assert.deepEqual(director(commands), [
    { op: "move", args: { ids: ["m2"], position: "top_right" } },
    { op: "move", args: { ids: ["m4"], position: "middle_center" } },
    { op: "scale", args: { ids: ["m1"], factor: 1.3 } },
    { op: "scale", args: { ids: ["m1"], factor: 1.69 } },
    { op: "scale", args: { ids: ["m1"], factor: 1 } },
    { op: "fontScale", args: { factor: 1.15 } },
    { op: "fontScale", args: { factor: 1 } },
  ]);
});

test("display: brightness, screen off and on, night mode and pointing things out", () => {
  const { screen, display, commands } = build();
  assert.equal(display.brightness("dimmer").spoken, "Dimmed, 75%.");
  assert.equal(display.brightness("brighter").spoken, "Full brightness.");
  assert.equal(display.brightness(0.3).spoken, "Dimmed, 30%.");

  assert.equal(display.power(false).spoken, "Going dark. Say my name to wake me.");
  assert.equal(screen.asleep, true);
  assert.equal(display.power(true).spoken, "I'm back.");
  assert.equal(display.power(true).spoken, "The screen's already on.");
  assert.equal(screen.layout.brightness, 0.3, "waking restores the brightness it had");

  assert.equal(display.nightMode(true).spoken, "Night mode. Dim and warm.");
  assert.equal(screen.layout.mode, "night");
  assert.equal(display.nightMode(false).spoken, "Back to normal.");
  assert.equal(screen.layout.mode, "normal");

  assert.equal(display.whereIs("calendar").spoken, "The calendar is in the top left.");
  assert.deepEqual(director(commands).at(-1), { op: "highlight", args: { ids: ["m2"] } });
  assert.equal(display.describe().spoken, "On the mirror right now: the clock, the calendar and the weather.");
});

test("display: the layout survives a restart, and named layouts can be saved and recalled", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "iris-layout-")), "layout.json");
  const first = build(file);
  first.display.move("calendar", "top right");
  first.display.resize("everything", "bigger");
  assert.equal(first.display.saveScene("Morning").spoken, "Saved this layout as morning. Say switch to morning any time.");
  assert.equal(first.display.reset().spoken, "Everything's back where it started.");
  assert.equal(first.display.loadScene("party").spoken, "I don't have a layout called party. I have morning.");
  assert.equal(first.display.loadScene("my morning").spoken, "Here's morning.");

  // MagicMirror restarts: the first inventory puts everything back.
  const second = build(file);
  const applied = director(second.commands).find((c) => c.op === "apply");
  assert.ok(applied, "the saved layout is applied on start");
  assert.deepEqual(applied.args.state.moves, { m2: "top_right" });
  assert.equal(applied.args.state.fontScale, 1.15);
  assert.deepEqual(second.screen.listScenes(), ["morning"]);
});

test("intents: plain-language display control", () => {
  const { screen } = build();
  const intent = (q) => detectIntent(q, { screen });

  assert.deepEqual(intent("move the calendar to the top right"), { name: "move_module", args: { target: "calendar", where: "top right" } });
  assert.deepEqual(intent("put the weather on the left side"), { name: "move_module", args: { target: "weather", where: "left side" } });
  assert.deepEqual(intent("make the clock bigger"), { name: "resize_module", args: { target: "clock", change: "bigger" } });
  assert.deepEqual(intent("shrink the calendar"), { name: "resize_module", args: { target: "calendar", change: "smaller" } });
  assert.deepEqual(intent("the text is too small"), { name: "resize_module", args: { target: "everything", change: "bigger" } });
  assert.deepEqual(intent("the clock is way too big"), { name: "resize_module", args: { target: "clock", change: "smaller" } });
  assert.deepEqual(intent("I can't read the calendar"), { name: "resize_module", args: { target: "calendar", change: "bigger" } });
  assert.equal(intent("my shirt is too small"), null, "only things on the mirror");
  assert.deepEqual(intent("it's too bright"), { name: "brightness", args: { change: "dimmer" } });
  assert.deepEqual(intent("brightness 40 percent"), { name: "brightness", args: { change: 0.4 } });
  assert.deepEqual(intent("turn the screen off"), { name: "screen_power", args: { on: false } });
  assert.deepEqual(intent("night mode"), { name: "night_mode", args: { on: true } });
  assert.deepEqual(intent("turn off night mode"), { name: "night_mode", args: { on: false } });
  assert.deepEqual(intent("save this layout as morning"), { name: "save_scene", args: { name: "morning" } });
  assert.deepEqual(intent("switch to my morning layout"), { name: "load_scene", args: { name: "morning" } });
  assert.deepEqual(intent("reset the layout"), { name: "reset_layout", args: {} });
  assert.deepEqual(intent("where is the calendar"), { name: "where_is", args: { target: "calendar" } });
  assert.deepEqual(intent("whats on the screen"), { name: "describe_screen", args: {} });
  assert.equal(intent("what's the weather like")?.name, "weather_answer", "the weather module's name doesn't steal weather questions");

  // Looser phrasings, understood instantly (no language model needed on a Pi).
  assert.deepEqual(intent("can you shove the calendar up near the top"), { name: "move_module", args: { target: "calendar", where: "top" } });
  assert.deepEqual(intent("could you stick the clock over on the left"), { name: "move_module", args: { target: "clock", where: "left" } });
  assert.deepEqual(intent("move the clock left"), { name: "move_module", args: { target: "clock", where: "left" } });
  assert.equal(intent("put my shirt on the left"), null);
  assert.deepEqual(intent("it's hard to see, could you crank up the brightness"), { name: "brightness", args: { change: "brighter" } });
  assert.deepEqual(intent("turn the brightness down"), { name: "brightness", args: { change: "dimmer" } });
  assert.deepEqual(intent("lower the brightness"), { name: "brightness", args: { change: "dimmer" } });
});

test("markets: everything a request asks about, keeping names with & intact", () => {
  assert.deepEqual(Markets.subjects("how much is tesla"), ["tesla"]);
  assert.deepEqual(Markets.subjects("compare apple and microsoft"), ["apple", "microsoft"]);
  assert.deepEqual(Markets.subjects("s and p 500 and nasdaq"), ["s&p 500", "nasdaq"]);
  assert.deepEqual(Markets.subjects("AT&T vs verizon stock"), ["at&t", "verizon"]);
  assert.deepEqual(Markets.subjects("how is johnson and johnson doing"), ["johnson & johnson"]);
  assert.deepEqual(Markets.subjects("price of bitcoin, ethereum and gold"), ["bitcoin", "ethereum", "gold"]);
  assert.deepEqual(Markets.subjects("what's tesla going for these days"), ["tesla"]);
  assert.deepEqual(Markets.subjects("what is nvidia selling for at the moment"), ["nvidia"]);

  const intent = (q) => detectIntent(q, {})?.name;
  assert.equal(intent("how is amazon doing"), "market_quote");
  assert.equal(intent("how is johnson and johnson doing"), "market_quote");
  assert.equal(intent("how are the Lakers doing"), "show_score");
  assert.equal(intent("what's tesla going for these days"), "market_quote");
});
