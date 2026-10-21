"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanForSpeech, splitSentences, normalize, daysBetween } = require("../lib/text");
const { createWakeWordMatcher, isStopCommand } = require("../lib/wakeword");

test("cleanForSpeech strips markdown, URLs and emoji but keeps accents", () => {
  const input = "## Tip\n- **Wear** the *navy* coat 🧥 to the café, see https://example.com\n1. `done`";
  assert.equal(cleanForSpeech(input), "Tip Wear the navy coat to the café, see done");
});

test("cleanForSpeech keeps snake_case-free normal words intact", () => {
  assert.equal(cleanForSpeech("It's 5 degrees — grab a scarf."), "It's 5 degrees — grab a scarf.");
});

test("splitSentences groups sentences under the limit", () => {
  const chunks = splitSentences("One. Two! Three? Four.", 10);
  assert.deepEqual(chunks, ["One. Two!", "Three?", "Four."]);
  assert.deepEqual(splitSentences("No punctuation at all"), ["No punctuation at all"]);
  assert.deepEqual(splitSentences("Hi. Two. Three.", 220, true), ["Hi.", "Two. Three."]);
});

test("normalize and daysBetween", () => {
  assert.equal(normalize("  Hello, WORLD!! "), "hello world");
  assert.equal(daysBetween("2026-10-01", "2026-10-20"), 19);
});

test("wake word at start, end, with filler and aliases", () => {
  const m = createWakeWordMatcher("iris", ["aris"]);
  assert.deepEqual(m.parse("Iris, what's the weather?"), { heard: true, query: "what's the weather?" });
  assert.deepEqual(m.parse("Hey Iris what should I wear"), { heard: true, query: "what should I wear" });
  assert.deepEqual(m.parse("what time is it, Iris?"), { heard: true, query: "what time is it" });
  assert.deepEqual(m.parse("Aris."), { heard: true, query: "" });
  assert.deepEqual(m.parse("OK, Iris, what time is it?"), { heard: true, query: "what time is it?" });
  assert.equal(m.parse("I love irises").heard, false);
  assert.equal(m.parse("nothing here").heard, false);
});

test("multi-word wake words", () => {
  const m = createWakeWordMatcher("mirror mirror");
  assert.deepEqual(m.parse("Mirror, mirror on the wall"), { heard: true, query: "on the wall" });
});

test("stop commands are short and exact", () => {
  assert.equal(isStopCommand("stop"), true);
  assert.equal(isStopCommand("Stop please."), true);
  assert.equal(isStopCommand("never mind"), true);
  assert.equal(isStopCommand("that's enough"), true);
  assert.equal(isStopCommand("don't stop me now"), false);
  assert.equal(isStopCommand("what time does the bus stop"), false);
});
