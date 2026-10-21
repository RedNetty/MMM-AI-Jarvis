"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

// Replies pick among phrasings at random; tests always get the first one.
require("../lib/speech/talk").random = () => 0;
const Iris = require("../lib/Iris");
const { createWakeWordMatcher } = require("../lib/wakeword");

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** Wait until a condition holds (robust on a busy machine), failing after `timeoutMs`. */
async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${condition}`);
    await tick(5);
  }
}

/** A stand-in for the voice activity detector: tracks the current utterance like the real one. */
class FakeVad extends EventEmitter {
  constructor() {
    super();
    this.speaking = false;
    this.utteranceId = 0;
    this.startedAt = 0;
    this.cuts = [];
  }

  begin() {
    this.speaking = true;
    this.utteranceId += 1;
    this.startedAt = Date.now();
    return this.utteranceId;
  }

  cut(id) {
    if (!this.speaking || id !== this.utteranceId) return false;
    this.speaking = false;
    this.cuts.push(id);
    return true;
  }

  pause() {}

  resume() {}
}

/**
 * Build an Iris with fake audio/STT/LLM components so the conversation logic
 * can be tested without a microphone, speaker or Ollama.
 */
function buildIris({ followUpWindow = 0, allowBargeIn = true, answerDelay = 0, playMs = 0, sttDelay = 0 } = {}) {
  const iris = new Iris(
    {
      dataDir: "data",
      wakeWord: "iris",
      wakeWordAliases: [],
      locale: "en-US",
      audio: { allowBargeIn },
      conversation: { listenTimeout: 1000, followUpWindow },
    },
    { moduleDir: __dirname },
  );

  const events = [];
  for (const e of ["state", "transcription", "response", "error"]) iris.on(e, (p) => events.push([e, p]));

  const asked = [];
  const played = [];
  const transcribed = [];
  iris.wakeWord = createWakeWordMatcher("iris");
  iris.chimeWav = null;
  iris.vad = new FakeVad();
  iris.stt = {
    // The fake "audio" is just the text to recognise.
    transcribe: async (pcm) => {
      transcribed.push(pcm.toString());
      await tick(sttDelay);
      return pcm.toString();
    },
  };
  iris.assistant = {
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
  iris.tts = { synthesize: async (text) => Buffer.from(text) };
  iris.speaker = {
    stopped: 0,
    play: async (wav) => {
      played.push(wav.toString());
      await tick(playMs);
      return { interrupted: false };
    },
    stop() {
      this.stopped += 1;
    },
  };
  iris.ready = true;
  return { iris, events, asked, played, transcribed };
}

test("wake word with a question is answered and spoken sentence by sentence", async () => {
  const { iris, events, asked, played } = buildIris();
  iris._onTranscript("Iris, what time is it?");
  await waitFor(() => iris.state === "idle" && played.length === 2);

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

test("the voice gets times and units spelled out; the mirror keeps the written form", async () => {
  const { iris, events, played } = buildIris();
  iris.assistant.ask = async (q, { onSentence }) => {
    onSentence("Kick-off is at 7:30 PM, it's 58°F.");
    return "Kick-off is at 7:30 PM, it's 58°F.";
  };
  iris._onTranscript("Iris, when's kick-off?");
  await waitFor(() => played.length === 1);
  assert.deepEqual(played, ["Kick-off is at seven thirty p.m., it's 58 degrees."]);
  assert.ok(events.some(([e, p]) => e === "response" && p === "Kick-off is at 7:30 PM, it's 58°F."));
});

test("speech without the wake word is ignored", async () => {
  const { iris, asked } = buildIris();
  iris._onTranscript("what time is it?");
  await tick();
  assert.deepEqual(asked, []);
});

test("wake word alone opens a listening window for the next utterance", async () => {
  const { iris, asked } = buildIris();
  iris._onTranscript("Hey Iris.");
  assert.equal(iris.state, "listening");
  iris._onTranscript("what should I wear");
  await waitFor(() => asked.length === 1);
  assert.deepEqual(asked, ["what should I wear"]);
});

test("follow-up window allows a reply without the wake word", async () => {
  const { iris, asked } = buildIris({ followUpWindow: 1000 });
  iris._onTranscript("Iris what should I wear");
  await waitFor(() => iris.state === "listening");
  iris._onTranscript("something warmer please");
  await waitFor(() => iris.state === "listening" && asked.length === 2);
  assert.deepEqual(asked, ["what should I wear", "something warmer please"]);

  // "stop" in the window just closes it.
  iris._onTranscript("never mind");
  assert.equal(iris.state, "idle");
  iris._onTranscript("and another thing");
  await tick(20);
  assert.equal(asked.length, 2);
});

test("stop while thinking cancels; barge-in replaces the question", async () => {
  const { iris, asked, played, events } = buildIris({ answerDelay: 200 });
  iris._onTranscript("Iris tell me a long story");
  await tick();
  assert.equal(iris.state, "processing");

  iris._onTranscript("Iris stop");
  assert.equal(iris.state, "idle");
  await tick(250);
  assert.deepEqual(played, [], "cancelled answer is never spoken");

  iris._onTranscript("Iris tell me a story");
  await tick();
  iris._onTranscript("Iris, what's the weather instead");
  await tick(250);
  assert.deepEqual(asked, ["tell me a long story", "tell me a story", "what's the weather instead"]);
  assert.deepEqual(played, ["Answer to what's the weather instead.", "Second sentence."]);
  assert.equal(events.filter(([e]) => e === "error").length, 0);
});

test("it never answers itself: speech heard while talking needs the wake word", async () => {
  const { iris, asked } = buildIris({ followUpWindow: 2000, playMs: 30 });
  iris._onTranscript("Iris, what games are on?");
  await tick(10);
  assert.equal(iris.state, "speaking");
  const startedWhileTalking = Date.now();
  await tick(80);
  assert.equal(iris.state, "listening", "follow-up window is open after the reply");

  // The microphone picked up the reply itself; it is transcribed after playback ended.
  iris._onTranscript("Answer to what games are on?", { startedAt: startedWhileTalking, endedAt: Date.now() });
  // Someone talking over it, not to it.
  iris._onTranscript("no way that's wild", { startedAt: startedWhileTalking, endedAt: Date.now() });
  await tick(20);
  assert.deepEqual(asked, ["what games are on?"]);

  // Its own words coming back later still don't count, even inside the window.
  iris._onTranscript("Answer to what games are on? Second sentence.", { startedAt: Date.now(), endedAt: Date.now() });
  await tick(20);
  assert.deepEqual(asked, ["what games are on?"]);

  // A real follow-up, started once it had finished talking (past the echo tail), does.
  await tick(300);
  iris._onTranscript("what about hockey", { startedAt: Date.now(), endedAt: Date.now() });
  await tick(80);
  assert.deepEqual(asked, ["what games are on?", "what about hockey"]);
});

test("barge-in with the wake word still works while it talks", async () => {
  const { iris, asked } = buildIris({ playMs: 60 });
  iris._onTranscript("Iris, tell me a story");
  await tick(20);
  assert.equal(iris.state, "speaking");
  iris._onTranscript("Iris, what's the time", { startedAt: Date.now(), endedAt: Date.now() });
  await tick(10);
  assert.deepEqual(asked, ["tell me a story", "what's the time"]);
});

test("early end-point: 'Iris.' alone is acted on at the first pause", async () => {
  const { iris, transcribed } = buildIris({ sttDelay: 5 });
  const id = iris.vad.begin();
  iris._onPause({ id, pcm: Buffer.from("Iris.") });
  await tick(20);
  assert.deepEqual(iris.vad.cuts, [id], "utterance ended without waiting for the full silence");
  assert.equal(iris.state, "listening");
  assert.deepEqual(transcribed, ["Iris."]);
});

test("early end-point waits for half sentences, and reuses the guess when nothing more is said", async () => {
  const { iris, asked, transcribed } = buildIris({ sttDelay: 5 });

  // "Iris, what's the weather in…" – clearly unfinished: keep listening.
  let id = iris.vad.begin();
  iris._onPause({ id, pcm: Buffer.from("Iris, what's the weather in") });
  await tick(20);
  assert.deepEqual(iris.vad.cuts, []);
  // The person said nothing more; the end-point reuses the transcript instead of transcribing again.
  iris.vad.speaking = false;
  iris._onUtterance(Buffer.from("Iris, what's the weather in"), { id, startedAt: Date.now(), endedAt: Date.now() });
  await tick(20);
  assert.deepEqual(transcribed, ["Iris, what's the weather in"], "transcribed once");
  assert.deepEqual(asked, ["what's the weather in"]);

  // Speech resumed after the pause: the guess is dropped and the full utterance transcribed.
  await tick(20);
  id = iris.vad.begin();
  iris._onPause({ id, pcm: Buffer.from("Iris, set a timer") });
  iris.vad.emit("resume", id);
  iris.speculation = iris.speculation?.id === id ? null : iris.speculation; // what the "resume" listener does
  await tick(20);
  iris.vad.speaking = false;
  iris._onUtterance(Buffer.from("Iris, set a timer for ten minutes."), { id, startedAt: Date.now(), endedAt: Date.now() });
  await tick(30);
  assert.equal(asked.at(-1), "set a timer for ten minutes.");
});

test("a finished question is answered at the pause", async () => {
  const { iris, asked } = buildIris({ sttDelay: 5 });
  const id = iris.vad.begin();
  iris._onPause({ id, pcm: Buffer.from("Iris, what time is it in Tokyo?") });
  await tick(30);
  assert.deepEqual(iris.vad.cuts, [id]);
  assert.deepEqual(asked, ["what time is it in Tokyo?"]);
});

test("ask() from another module bypasses the wake word", async () => {
  const { iris, asked } = buildIris();
  iris.ask("What's on my calendar?");
  await waitFor(() => asked.length === 1);
  assert.deepEqual(asked, ["What's on my calendar?"]);
});
