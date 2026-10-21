"use strict";

/**
 * WAV helpers for 16-bit little-endian PCM.
 */

/**
 * Wrap raw PCM in a RIFF/WAVE header.
 * @param {Buffer} pcm
 * @param {number} [sampleRate=16000]
 * @param {number} [channels=1]
 * @returns {Buffer}
 */
function pcmToWav(pcm, sampleRate = 16000, channels = 1) {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/**
 * Generate a short soft chime (two rising sine tones with fade in/out).
 * Used as the "I'm listening" cue so no audio asset files are needed.
 * @param {number} [volume=0.25] 0..1
 * @returns {Buffer} WAV data
 */
function chime(volume = 0.25) {
  const sampleRate = 22050;
  const notes = [
    { freq: 880, ms: 90 },
    { freq: 1320, ms: 130 },
  ];
  const total = notes.reduce((sum, n) => sum + Math.round((sampleRate * n.ms) / 1000), 0);
  const pcm = Buffer.alloc(total * 2);
  const amplitude = Math.max(0, Math.min(1, volume)) * 32767;

  let offset = 0;
  for (const note of notes) {
    const samples = Math.round((sampleRate * note.ms) / 1000);
    const fade = Math.round(samples * 0.2);
    for (let i = 0; i < samples; i++) {
      const env = Math.min(1, i / fade, (samples - i) / fade);
      const value = Math.sin((2 * Math.PI * note.freq * i) / sampleRate) * amplitude * env;
      pcm.writeInt16LE(Math.round(value), offset);
      offset += 2;
    }
  }
  return pcmToWav(pcm, sampleRate, 1);
}

/**
 * How long a WAV file plays, from its header. Walks the RIFF chunks rather
 * than assuming a 44-byte header (Piper and Kokoro may add chunks), and
 * trusts the buffer's length over a streamed file's placeholder data size.
 * @param {Buffer} wav
 * @returns {number|null} milliseconds, or null if it isn't a readable WAV
 */
function wavDurationMs(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return null;
  let byteRate = 0;
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 16 <= wav.length) byteRate = wav.readUInt32LE(offset + 16);
    if (id === "data") {
      const bytes = Math.min(size, wav.length - offset - 8);
      return byteRate ? (bytes / byteRate) * 1000 : null;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

module.exports = { pcmToWav, chime, wavDurationMs };
