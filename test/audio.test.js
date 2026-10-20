"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const VoiceActivityDetector = require("../lib/audio/VoiceActivityDetector");
const { pcmToWav, chime } = require("../lib/audio/wav");
const { jpegSize, isJpeg } = require("../lib/jpeg");
const WhisperCppSTT = require("../lib/stt/WhisperCppSTT");

const RATE = 16000;

function tone(ms, amplitude) {
  const samples = Math.round((RATE * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 300 * i) / RATE) * amplitude), i * 2);
  }
  return buf;
}

test("VAD emits one utterance with pre-roll for speech between silence", () => {
  const vad = new VoiceActivityDetector({ threshold: 500, silenceMs: 300, preRollMs: 200, minUtteranceMs: 200 });
  const utterances = [];
  let starts = 0;
  vad.on("speechstart", () => starts++);
  vad.on("utterance", (pcm) => utterances.push(pcm));

  vad.write(tone(1000, 50)); // room noise
  // Feed speech in odd-sized chunks to exercise frame reassembly.
  const speech = tone(800, 6000);
  for (let i = 0; i < speech.length; i += 999) vad.write(speech.subarray(i, i + 999));
  vad.write(tone(600, 50));

  assert.equal(starts, 1);
  assert.equal(utterances.length, 1);
  const seconds = utterances[0].length / 2 / RATE;
  assert.ok(seconds >= 0.9 && seconds <= 1.4, `utterance length ${seconds}s`);
});

test("VAD discards short blips and ignores input while paused", () => {
  const vad = new VoiceActivityDetector({ threshold: 500, silenceMs: 200, minUtteranceMs: 300 });
  let utterances = 0;
  let discards = 0;
  vad.on("utterance", () => utterances++);
  vad.on("discard", () => discards++);

  vad.write(tone(500, 50));
  vad.write(tone(100, 8000)); // door slam
  vad.write(tone(400, 50));
  assert.equal(utterances, 0);
  assert.equal(discards, 1);

  vad.pause();
  vad.write(tone(800, 8000));
  vad.write(tone(400, 50));
  assert.equal(utterances, 0);
});

test("VAD threshold adapts to a noisy room", () => {
  const vad = new VoiceActivityDetector({ threshold: 100, noiseMultiplier: 3 });
  vad.write(tone(2000, 1500));
  assert.ok(vad.effectiveThreshold > 2000, `threshold ${vad.effectiveThreshold}`);
});

test("VAD recovers when steady noise starts after calibration", () => {
  const vad = new VoiceActivityDetector({ threshold: 300, silenceMs: 300, maxUtteranceMs: 2000, minUtteranceMs: 200 });
  let utterances = 0;
  let discards = 0;
  vad.on("utterance", () => utterances++);
  vad.on("discard", () => discards++);

  vad.write(tone(1000, 30)); // quiet room calibrates a low floor
  vad.write(tone(6000, 2000)); // a fan switches on: steady, above the old threshold
  assert.equal(utterances, 0, "steady noise is never sent to speech-to-text");
  assert.ok(discards >= 1);
  assert.ok(vad.effectiveThreshold > 2000, `re-learned threshold ${vad.effectiveThreshold}`);

  // Speech over the fan is still heard: syllable-like bursts well above the new floor.
  for (let i = 0; i < 4; i++) {
    vad.write(tone(180, 12000));
    vad.write(tone(60, 2000));
  }
  vad.write(tone(500, 2000));
  assert.equal(utterances, 1);
});

test("VAD stationarity check separates hum from speech", () => {
  assert.equal(VoiceActivityDetector.isStationary(Array(100).fill(1500)), true);
  assert.equal(VoiceActivityDetector.isStationary([...Array(50)].flatMap(() => [3000, 400])), false);
  assert.equal(VoiceActivityDetector.isStationary([1, 2, 3]), false, "too short to judge");
});

test("WAV header and chime", () => {
  const wav = pcmToWav(Buffer.alloc(320), 16000);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), 320);
  assert.equal(chime().toString("ascii", 8, 12), "WAVE");
});

test("jpegSize reads SOF dimensions", () => {
  // SOI, APP0 (len 16), SOF0 (len 17, 8-bit, h=480, w=640), EOI
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
  assert.equal(isJpeg(jpeg), true);
  assert.deepEqual(jpegSize(jpeg), { width: 640, height: 480 });
  assert.equal(jpegSize(Buffer.from("not a jpeg")), null);
});

test("Whisper output cleaning removes non-speech and hallucinations", () => {
  assert.equal(WhisperCppSTT.clean(" [BLANK_AUDIO] "), "");
  assert.equal(WhisperCppSTT.clean("(music) Thank you."), "");
  assert.equal(WhisperCppSTT.clean(" Jarvis, what time is it? [ Silence ]"), "Jarvis, what time is it?");
});

const SpeechQueue = require("../lib/audio/SpeechQueue");

test("SpeechQueue plays streamed sentences in order, synthesising one ahead", async () => {
  const log = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const controller = new AbortController();
  const queue = new SpeechQueue({
    signal: controller.signal,
    synthesize: async (text) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      log.push(`synth:${text}`);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return Buffer.from(text);
    },
    play: async (wav) => {
      log.push(`play:${wav}`);
      await new Promise((r) => setTimeout(r, 15));
      return { interrupted: false };
    },
    onStart: () => log.push("start"),
  });

  queue.push("one");
  await new Promise((r) => setTimeout(r, 2));
  queue.push("two"); // arrives while "one" is being prepared – like streamed LLM output
  queue.push("three");
  await queue.finish();

  assert.deepEqual(log.filter((l) => l.startsWith("play")), ["play:one", "play:two", "play:three"]);
  assert.equal(log.indexOf("start"), log.indexOf("play:one") - 1);
  assert.ok(maxInFlight <= 1, "never synthesises more than one sentence ahead");
});

test("SpeechQueue stops on abort and reports synthesis errors", async () => {
  const controller = new AbortController();
  const played = [];
  const queue = new SpeechQueue({
    signal: controller.signal,
    synthesize: async (t) => Buffer.from(t),
    play: async (wav) => {
      played.push(String(wav));
      controller.abort();
      return { interrupted: true };
    },
  });
  queue.push("first");
  queue.push("second");
  await queue.finish();
  assert.deepEqual(played, ["first"]);

  const failing = new SpeechQueue({
    signal: new AbortController().signal,
    synthesize: async () => {
      throw new Error("tts down");
    },
    play: async () => ({ interrupted: false }),
  });
  failing.push("hello");
  await assert.rejects(failing.finish(), /tts down/);
});
