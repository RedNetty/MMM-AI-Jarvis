"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Jarvis = require("../lib/Jarvis");
const { createWakeWordMatcher } = require("../lib/wakeword");

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a Jarvis with fake audio/LLM components so the conversation logic
 * can be tested without a microphone, speaker or Ollama.
 */
function buildJarvis({ followUpWindow = 0, allowBargeIn = true, answerDelay = 0 } = {}) {
  const jarvis = new Jarvis(
    {
      dataDir: "data",
      wakeWord: "jarvis",
      wakeWordAliases: [],
      audio: { allowBargeIn },
      conversation: { listenTimeout: 1000, followUpWindow },
    },
    { moduleDir: __dirname },
  );

  const events = [];
  for (const e of ["state", "transcription", "response", "error"]) jarvis.on(e, (p) => events.push([e, p]));

  const asked = [];
  const played = [];
  jarvis.wakeWord = createWakeWordMatcher("jarvis");
  jarvis.chimeWav = null;
  jarvis.vad = { pause() {}, resume() {} };
  jarvis.assistant = {
    // Like the real Assistant: streams each sentence to onSentence, then returns the full reply.
    ask: async (q, { signal, onSentence }) => {
      asked.push(q);
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, answerDelay);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
      const sentences = [`Answer to ${q}.`, "Second sentence."];
      for (const sentence of sentences) onSentence(sentence);
      return sentences.join(" ");
    },
  };
  jarvis.tts = { synthesize: async (text) => Buffer.from(text) };
  jarvis.speaker = {
    stopped: 0,
    play: async (wav) => {
      played.push(wav.toString());
      return { interrupted: false };
    },
    stop() {
      this.stopped += 1;
    },
  };
  jarvis.ready = true;
  return { jarvis, events, asked, played };
}

test("wake word with a question is answered and spoken sentence by sentence", async () => {
  const { jarvis, events, asked, played } = buildJarvis();
  jarvis._onTranscript("Jarvis, what time is it?");
  await tick(20);

  assert.deepEqual(asked, ["what time is it?"]);
  assert.deepEqual(played, ["Answer to what time is it?.", "Second sentence."]);
  assert.deepEqual(
    events.map(([e, p]) => `${e}:${p}`),
    [
      "transcription:what time is it?",
      "state:processing",
      "response:Answer to what time is it?.",
      "response:Answer to what time is it?. Second sentence.",
      "state:speaking",
      "state:idle",
    ],
  );
});

test("speech without the wake word is ignored", async () => {
  const { jarvis, asked } = buildJarvis();
  jarvis._onTranscript("what time is it?");
  await tick();
  assert.deepEqual(asked, []);
});

test("wake word alone opens a listening window for the next utterance", async () => {
  const { jarvis, asked } = buildJarvis();
  jarvis._onTranscript("Hey Jarvis.");
  assert.equal(jarvis.state, "listening");
  jarvis._onTranscript("what should I wear");
  await tick(20);
  assert.deepEqual(asked, ["what should I wear"]);
});

test("follow-up window allows a reply without the wake word", async () => {
  const { jarvis, asked } = buildJarvis({ followUpWindow: 1000 });
  jarvis._onTranscript("Jarvis what should I wear");
  await tick(20);
  assert.equal(jarvis.state, "listening");
  jarvis._onTranscript("something warmer please");
  await tick(20);
  assert.deepEqual(asked, ["what should I wear", "something warmer please"]);

  // "stop" in the window just closes it.
  jarvis._onTranscript("never mind");
  assert.equal(jarvis.state, "idle");
  jarvis._onTranscript("and another thing");
  await tick(20);
  assert.equal(asked.length, 2);
});

test("stop while thinking cancels; barge-in replaces the question", async () => {
  const { jarvis, asked, played, events } = buildJarvis({ answerDelay: 200 });
  jarvis._onTranscript("Jarvis tell me a long story");
  await tick();
  assert.equal(jarvis.state, "processing");

  jarvis._onTranscript("Jarvis stop");
  assert.equal(jarvis.state, "idle");
  await tick(250);
  assert.deepEqual(played, [], "cancelled answer is never spoken");

  jarvis._onTranscript("Jarvis tell me a story");
  await tick();
  jarvis._onTranscript("Jarvis, what's the weather instead");
  await tick(250);
  assert.deepEqual(asked, ["tell me a long story", "tell me a story", "what's the weather instead"]);
  assert.deepEqual(played, ["Answer to what's the weather instead.", "Second sentence."]);
  assert.equal(events.filter(([e]) => e === "error").length, 0);
});

test("ask() from another module bypasses the wake word", async () => {
  const { jarvis, asked } = buildJarvis();
  jarvis.ask("What's on my calendar?");
  await tick(20);
  assert.deepEqual(asked, ["What's on my calendar?"]);
});
