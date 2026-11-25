import assert from 'node:assert/strict';
import test from 'node:test';

import { selectableAudioInputs, strongestAudioChannel } from '../src/public/timecode-console.js';

test('only audio inputs with unique, non-empty device IDs are selectable', () => {
  const defaultDevice = { kind: 'audioinput', deviceId: 'default', label: 'Default - Built-in Microphone' };
  const hiddenDevice = { kind: 'audioinput', deviceId: '', label: '' };
  const input = { kind: 'audioinput', deviceId: 'input-1', label: 'USB Audio Interface' };

  assert.deepEqual(
    selectableAudioInputs([
      defaultDevice,
      hiddenDevice,
      input,
      { ...input, label: 'Duplicate descriptor' },
      { kind: 'audiooutput', deviceId: 'speaker-1', label: 'Speakers' },
    ]),
    [input],
  );
});

test('LTC capture selects the channel with the strongest AC signal, not DC bias', () => {
  const weakSignal = Float32Array.from([0.4, 0.41, 0.39, 0.4]);
  const ltcSignal = Float32Array.from([-0.5, 0.5, -0.5, 0.5]);
  assert.equal(strongestAudioChannel([weakSignal, ltcSignal]), ltcSignal);
});
