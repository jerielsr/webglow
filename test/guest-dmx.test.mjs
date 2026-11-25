import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { buildApp } from '../dist/app.js';
import { STAIRVILLE_LED_PAR_64_PROFILE } from '../dist/dmx.js';

async function withApp(callback, dmxOutput) {
  const directory = await mkdtemp(join(tmpdir(), 'webglow-guest-dmx-test-'));
  const app = await buildApp({
    logger: false,
    config: { dataFile: join(directory, 'lights.json'), staticRoot: resolve('dist/public') },
    dmxOutput,
  });
  await app.ready();
  try { return await callback(app); }
  finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
}

test('guest lights remain joinable and resumable while optional uDMX output is unavailable', async () => {
  const output = {
    async apply() { throw new Error('No uDMX adapter was detected.'); },
    async close() {},
  };
  await withApp(async (app) => {
    const fixture = await app.inject({
      method: 'POST', url: '/api/v1/lights',
      payload: { id: 'par-1', name: 'Front wash', kind: 'dmx', dmx: { profileId: STAIRVILLE_LED_PAR_64_PROFILE.id, startAddress: 1 } },
    });
    assert.equal(fixture.statusCode, 201);

    const cue = await app.inject({
      method: 'POST', url: '/api/v1/scenes',
      payload: { id: '1', name: 'Welcome', ids: 'all', scaleEffect: true, state: { color: '#2244FF', brightness: 75 } },
    });
    assert.equal(cue.statusCode, 201);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/scenes/1/go' })).statusCode, 200);

    await app.inject({ method: 'PATCH', url: '/api/v1/settings', payload: { guestRegistrationEnabled: true } });
    const joined = await app.inject({ method: 'POST', url: '/api/v1/guest-registration', payload: { name: 'Guest one', section: 'Center', keepAwake: true } });
    assert.equal(joined.statusCode, 201, joined.body);
    const guest = joined.json();
    assert.equal(typeof guest.guestSessionToken, 'string');
    assert.equal(guest.light.guest.sessionTokenHash, undefined);

    await app.inject({ method: 'PATCH', url: '/api/v1/settings', payload: { guestRegistrationEnabled: false } });
    const resumed = await app.inject({ method: 'POST', url: '/api/v1/guest-registration', payload: { resumeToken: guest.guestSessionToken } });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().displayPath, guest.displayPath);
    const publicState = await app.inject({ method: 'GET', url: '/api/v1/lights/' + guest.light.id });
    assert.equal(publicState.json().guest.sessionTokenHash, undefined);

    const left = await app.inject({ method: 'POST', url: '/api/v1/guest-registration/leave', payload: { resumeToken: guest.guestSessionToken } });
    assert.equal(left.statusCode, 204);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/lights/' + guest.light.id })).statusCode, 404);
  }, output);
});

test('existing DMX fixtures can be repatched by address without a connected adapter', async () => {
  await withApp(async (app) => {
    const created = await app.inject({
      method: 'POST', url: '/api/v1/lights',
      payload: { id: 'par-1', name: 'Front wash', kind: 'dmx', dmx: { profileId: STAIRVILLE_LED_PAR_64_PROFILE.id, startAddress: 1 } },
    });
    assert.equal(created.statusCode, 201);
    const repatched = await app.inject({
      method: 'PATCH', url: '/api/v1/lights/par-1/dmx-patch',
      payload: { profileId: STAIRVILLE_LED_PAR_64_PROFILE.id, startAddress: 20 },
    });
    assert.equal(repatched.statusCode, 200, repatched.body);
    assert.equal(repatched.json().light.dmx.startAddress, 20);
    assert.match(repatched.json().outputWarning, /adapter/i);
    await app.inject({
      method: 'POST', url: '/api/v1/lights',
      payload: { id: 'par-2', name: 'Back wash', kind: 'dmx', dmx: { profileId: STAIRVILLE_LED_PAR_64_PROFILE.id, startAddress: 40 } },
    });
    const overlap = await app.inject({
      method: 'PATCH', url: '/api/v1/lights/par-1/dmx-patch',
      payload: { profileId: STAIRVILLE_LED_PAR_64_PROFILE.id, startAddress: 40 },
    });
    assert.equal(overlap.statusCode, 409);
    assert.equal(overlap.json().error.code, 'dmx_address_overlap');
  }, { async apply() { throw new Error('No uDMX adapter was detected.'); }, async close() {} });
});
