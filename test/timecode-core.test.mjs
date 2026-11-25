import assert from 'node:assert/strict';
import test from 'node:test';

import { formatTimecode, framesPerDay, LtcDecoder, parseTimecode } from '../src/public/timecode-core.js';

function createLtcSamples() {
  const rate = '25';
  const sampleRate = 48_000;
  const halfBitSamples = sampleRate / (25 * 160);
  const sync = [0, 0, ...Array(12).fill(1), 0, 1];
  const createFrame = (frameNumber) => {
    const payload = new Array(64).fill(0);
    const setBcd = (start, units, tens, tensWidth) => {
      for (let bit = 0; bit < 4; bit += 1) payload[start + bit] = (units >> bit) & 1;
      for (let bit = 0; bit < tensWidth; bit += 1) payload[start + 8 + bit] = (tens >> bit) & 1;
    };
    setBcd(0, frameNumber % 10, Math.floor(frameNumber / 10), 2);
    setBcd(16, 4, 3, 3);
    setBcd(32, 6, 5, 3);
    setBcd(48, 1, 0, 2);
    return [...payload, ...sync];
  };
  const samples = [];
  let sign = 1;
  for (const bit of [0, ...createFrame(12), ...createFrame(13)]) {
      const intervals = bit ? [halfBitSamples, halfBitSamples] : [halfBitSamples * 2];
      for (const interval of intervals) {
        for (let sample = 0; sample < interval; sample += 1) samples.push(sign * 0.5);
        sign *= -1;
      }
  }
  return { rate, sampleRate, samples };
}

function decodeSamples(samples, rate, sampleRate, onDiagnostics = () => undefined) {
  const decoded = [];
  const decoder = new LtcDecoder(rate, (frame) => decoded.push(frame), undefined, onDiagnostics);
  for (let offset = 0; offset < samples.length; offset += 128) {
    decoder.pushSamples(Float32Array.from(samples.slice(offset, offset + 128)), sampleRate);
  }
  return decoded;
}

test('timecode frame formatting round-trips supported rates', () => {
  for (const rate of ['23.976', '24', '25', '29.97df', '30']) {
    const samples = [0, 1, 123_456, framesPerDay(rate) - 1];
    for (const frames of samples) {
      const label = formatTimecode(frames, rate);
      assert.equal(parseTimecode(label, rate), frames, `${rate} ${label}`);
    }
  }
});

test('29.97 drop-frame skips frame labels at non-tenth minutes', () => {
  assert.equal(formatTimecode(1_800, '29.97df'), '00:01:00;02');
  assert.equal(formatTimecode(17_982, '29.97df'), '00:10:00;00');
  assert.throws(() => parseTimecode('00:01:00;00', '29.97df'), /skipped/);
});

test('LTC decoder locks onto a forward biphase-mark encoded frame', () => {
  const { rate, sampleRate, samples } = createLtcSamples();
  const decoded = decodeSamples(samples, rate, sampleRate);
  assert.ok(decoded.some((frame) => frame.timecode === '01:56:34:12'));
  assert.ok(decoded.some((frame) => frame.timecode === '01:56:34:13'));
});

test('LTC decoder diagnostics count transitions, standard sync words, and decoded frames', () => {
  const { rate, sampleRate, samples } = createLtcSamples();
  let diagnostics;
  decodeSamples(samples, rate, sampleRate, (snapshot) => { diagnostics = snapshot; });
  assert.ok(diagnostics.zeroCrossings > 100);
  assert.ok(diagnostics.syncMatches >= 2);
  assert.ok(diagnostics.decodedFrames >= 2);
  assert.equal(diagnostics.lastTimecode, '01:56:34:13');
});

test('LTC decoder removes DC offset before detecting biphase-mark crossings', () => {
  const { rate, sampleRate, samples } = createLtcSamples();
  const offsetSamples = samples.map((sample) => sample + 0.35);
  const decoded = decodeSamples(offsetSamples, rate, sampleRate);
  assert.ok(decoded.some((frame) => frame.timecode === '01:56:34:12'));
});
