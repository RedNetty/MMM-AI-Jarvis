"use strict";

/**
 * Minimal JPEG helpers (no native image library needed on the Pi).
 */

/** @param {Buffer} buf */
function isJpeg(buf) {
  return Buffer.isBuffer(buf) && buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8;
}

/**
 * Read pixel dimensions from a JPEG's start-of-frame marker.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number } | null}
 */
function jpegSize(buf) {
  if (!isJpeg(buf)) return null;

  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];

    // Padding / standalone markers without a length field.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    const length = buf.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      return {
        height: buf.readUInt16BE(offset + 5),
        width: buf.readUInt16BE(offset + 7),
      };
    }
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
    offset += 2 + length;
  }
  return null;
}

module.exports = { isJpeg, jpegSize };
