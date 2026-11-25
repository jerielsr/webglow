import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { buildApp } from '../dist/app.js';
import { buildDmxUniverse, findUdmxDevice, STAIRVILLE_LED_PAR_64_PROFILE, UDMX_PRODUCT_ID, UDMX_VENDOR_ID, UdmxOutput } from '../dist/dmx.js';

function makeLight(overrides = {}) {
  return {
    id: 'par-1',
    name: 'Front wash',
    kind: 'dmx',
    dmx: { profileId: STAIRVILLE_LED_PAR_64_PROFILE.id, startAddress: 1 },
    state: {
      on: true,
      brightness: 50,
      color: '#804020',
      pattern: 'solid',
      speed: 25,
      fadeMs: 0,
      phaseOffset: 0,
      patternStartedAt: 0,
    },
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

async function withApp(callback, services = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'webglow-dmx-test-'));
  const app = await buildApp({
    logger: false,
    config: { dataFile: join(directory, 'lights.json'), staticRoot: resolve('dist/public') },
    ...services,
  });
  await app.ready();
  try { return await callback(app); }
  finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
}

test('the Stairville 5-channel profile maps RGB, speed, and address into the 512-channel universe', () => {
  const frame = buildDmxUniverse([makeLight()], [STAIRVILLE_LED_PAR_64_PROFILE]);
  assert.equal(frame.length, 512);
  assert.deepEqual([...frame.slice(0, 5)], [0, 64, 32, 16, 64]);
  assert.deepEqual([...frame.slice(5, 10)], [0, 0, 0, 0, 0]);
});

test('uDMX sends only the patched range with the documented vendor request', async () => {
  const calls = [];
  let opened = false;
  const device = {
    vendorId: 0x16c0,
    productId: 0x05dc,
    manufacturerName: 'www.anyma.ch',
    productName: 'uDMX',
    get opened() { return opened; },
    async open() { opened = true; },
    async close() { opened = false; },
    async controlTransferOut(setup, data) {
      calls.push({ setup, data: [...data] });
      return { status: 'ok', bytesWritten: data.byteLength };
    },
  };
  const output = new UdmxOutput(async () => device);
  await output.apply([makeLight()], [STAIRVILLE_LED_PAR_64_PROFILE]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].setup, { requestType: 'vendor', recipient: 'device', request: 2, value: 5, index: 0 });
  assert.equal(calls[0].data.length, 5);
  assert.deepEqual(calls[0].data.slice(0, 5), [0, 64, 32, 16, 64]);
  await output.apply([], [STAIRVILLE_LED_PAR_64_PROFILE]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].data, [0, 0, 0, 0, 0]);
  await output.close();
});

test('DMX effects render a shared timebase with per-fixture phase into colour channels', () => {
  const base = makeLight();
  const ramp = makeLight({ state: { ...base.state, pattern: 'ramp-up', speed: 0, patternStartedAt: 0, phaseOffset: 0 } });
  const red = buildDmxUniverse([ramp], [STAIRVILLE_LED_PAR_64_PROFILE], 10_000);
  assert.deepEqual([...red.slice(0, 5)], [0, 35, 17, 9, 0]);

  const multi = makeLight({ state: {
    ...base.state,
    pattern: 'multi-chase', speed: 0, patternStartedAt: 1_000, phaseOffset: 0.5,
    colors: ['#FF0000', '#0000FF'], colorTransitions: ['snap', 'snap'], colorStepMs: 500,
  } });
  const blue = buildDmxUniverse([multi], [STAIRVILLE_LED_PAR_64_PROFILE], 1_000);
  assert.deepEqual([...blue.slice(0, 5)], [0, 0, 0, 128, 0]);
});

test('DMX animated looks continue writing at a shared, bounded frame rate', async () => {
  const calls = [];
  let opened = false;
  const device = {
    get opened() { return opened; },
    async open() { opened = true; },
    async close() { opened = false; },
    async controlTransferOut(setup, data) {
      calls.push({ setup, data: [...data] });
      return { status: 'ok', bytesWritten: data.byteLength };
    },
  };
  const output = new UdmxOutput(async () => device);
  const base = makeLight();
  await output.apply([makeLight({ state: { ...base.state, pattern: 'pulse', patternStartedAt: Date.now() } })], [STAIRVILLE_LED_PAR_64_PROFILE]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(calls.length >= 2);
  assert.ok(calls.every((call) => call.setup.value === 5 && call.data.length === 5));
  await output.apply([base], [STAIRVILLE_LED_PAR_64_PROFILE]);
  const stoppedAt = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls.length, stoppedAt);
  await output.close();
});

test('macOS not-responding errors are converted to an actionable uDMX message', async () => {
  const output = new UdmxOutput(async () => ({
    get opened() { return true; },
    async open() {},
    async close() {},
    async controlTransferOut() { throw new Error('controlTransferOut error: unknown (error 0xe00002ed)'); },
  }));
  await assert.rejects(
    output.apply([makeLight()], [STAIRVILLE_LED_PAR_64_PROFILE]),
    /macOS reports that the uDMX adapter did not respond.*another lighting app is not using it/,
  );
  const status = await output.status();
  assert.match(status.lastError, /0xe00002ed/);
  await output.close();
});

test('uDMX discovery scans the Anyma adapter USB ID (16c0:05dc)', async () => {
  const calls = [];
  const device = { vendorId: 0x16c0, productId: 0x05dc };
  const found = await findUdmxDevice({
    async findDeviceByIds(vendorId, productId) {
      calls.push([vendorId, productId]);
      return device;
    },
  });

  assert.deepEqual(calls, [[UDMX_VENDOR_ID, UDMX_PRODUCT_ID]]);
  assert.deepEqual(calls[0], [0x16c0, 0x05dc]);
  assert.equal(found, device);
});

test('DMX API creates patches, rejects overlap, and writes changes through the adapter', async () => {
  const calls = [];
  let opened = false;
  const output = new UdmxOutput(async () => ({
    get opened() { return opened; },
    async open() { opened = true; },
    async close() { opened = false; },
    async controlTransferOut(setup, data) {
      calls.push({ setup, data: [...data] });
      return { status: 'ok', bytesWritten: data.byteLength };
    },
  }));
  await withApp(async (app) => {
    const profiles = await app.inject({ method: 'GET', url: '/api/v1/dmx/profiles' });
    assert.equal(profiles.statusCode, 200);
    assert.equal(profiles.json().profiles[0].id, STAIRVILLE_LED_PAR_64_PROFILE.id);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/lights',
      payload: { id: 'par-1', name: 'Front wash', kind: 'dmx', dmx: { profileId: STAIRVILLE_LED_PAR_64_PROFILE.id, startAddress: 1 } },
    });
    assert.equal(created.statusCode, 201);

    const overlap = await app.inject({
      method: 'POST',
      url: '/api/v1/lights',
      payload: { id: 'par-2', kind: 'dmx', dmx: { profileId: STAIRVILLE_LED_PAR_64_PROFILE.id, startAddress: 5 } },
    });
    assert.equal(overlap.statusCode, 409);
    assert.equal(overlap.json().error.code, 'dmx_address_overlap');

    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/v1/lights/par-1',
      payload: { on: true, brightness: 50, color: '#804020', speed: 25 },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].data.slice(0, 5), [0, 64, 32, 16, 64]);
  }, { dmxOutput: output });
});

test('custom DMX profiles can be created and cannot be deleted while patched fixtures use them', async () => {
  await withApp(async (app) => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/dmx/profiles',
      payload: { name: 'Custom RGBW', channels: [
        { name: 'Red', function: 'red' },
        { name: 'Green', function: 'green' },
        { name: 'Blue', function: 'blue' },
        { name: 'White', function: 'fixed', fixedValue: 42 },
      ] },
    });
    assert.equal(created.statusCode, 201);
    const profile = created.json().profile;
    assert.equal(profile.channels.length, 4);

    await app.inject({
      method: 'POST',
      url: '/api/v1/lights',
      payload: { id: 'custom-par', kind: 'dmx', dmx: { profileId: profile.id, startAddress: 1 } },
    });
    const removed = await app.inject({ method: 'DELETE', url: '/api/v1/dmx/profiles/' + profile.id });
    assert.equal(removed.statusCode, 409);
    assert.equal(removed.json().error.code, 'dmx_profile_in_use');
  });
});
