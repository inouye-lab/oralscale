'use strict';
// Minimal PCM WAV writer for tests — N seconds of (near-)silence, 8 kHz mono 16-bit.
// A tiny tone is added so the file isn't pathologically empty.
const fs = require('fs');

function writeWav(path, seconds, { sampleRate = 8000, seed = 1 } = {}) {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const dataSize = n * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.round(1200 * Math.sin((2 * Math.PI * (220 + (seed % 40)) * i) / sampleRate));
    buf.writeInt16LE(s, 44 + i * 2);
  }
  fs.writeFileSync(path, buf);
  return buf.length;
}

module.exports = { writeWav };
