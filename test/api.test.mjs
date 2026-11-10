import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { buildApp } from '../dist/app.js';
import { WledClient } from '../dist/wled-client.js';

async function withApp(callback, configuration = {}, services = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'webglow-test-'));
  const app = await buildApp({
    logger: false,
    config: {
      dataFile: join(directory, 'lights.json'),
      staticRoot: resolve('dist/public'),
      ...configuration,
    },
    ...services,
  });
  await app.ready();

  try {
    return await callback(app, directory);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function waitForWebSocketOpen(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket did not open in time.')), 2_000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket failed to open.'));
      },
      { once: true },
    );
  });
}

function waitForWebSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket message did not arrive in time.')), 2_000);
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timeout);
        resolve(JSON.parse(String(event.data)));
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket failed while waiting for a message.'));
      },
      { once: true },
    );
  });
}

test('creates a light and updates its rendered state', async () => {
  await withApp(async (app) => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/lights',
      payload: { id: 'phone-1', name: 'Kitchen phone' },
    });

    assert.equal(created.statusCode, 201);
    assert.deepEqual(created.json().light.state, {
      on: false,
      brightness: 100,
      color: '#FFFFFF',
      pattern: 'solid',
      speed: 50,
      fadeMs: 0,
      phaseOffset: 0,
      patternStartedAt: created.json().light.state.patternStartedAt,
    });
    assert.equal(created.json().displayPath, '/display/phone-1');

    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/v1/lights/phone-1',
      payload: {
        name: 'Renamed kitchen phone',
        on: true,
        brightness: 42.5,
        color: '#0aB',
        pattern: 'pulse',
        speed: 25,
        fadeMs: 1250,
        phaseOffset: 0.25,
        expectedRevision: 0,
      },
    });

    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().name, 'Renamed kitchen phone');
    assert.deepEqual(updated.json().state, {
      on: true,
      brightness: 42.5,
      color: '#00AABB',
      pattern: 'pulse',
      speed: 25,
      fadeMs: 1250,
      phaseOffset: 0.25,
      patternStartedAt: updated.json().state.patternStartedAt,
    });
    assert.equal(updated.json().revision, 1);

    const listed = await app.inject({ method: 'GET', url: '/api/v1/lights' });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().lights.length, 1);
    assert.equal(listed.json().lights[0].name, 'Renamed kitchen phone');
  });
});

test('serves the portal and requires lights to be created before they can be fetched', async () => {
  await withApp(async (app) => {
    const portal = await app.inject({ method: 'GET', url: '/' });
    assert.equal(portal.statusCode, 200);
    assert.match(portal.headers['content-type'], /^text\/html/);
    assert.match(portal.body, /WebGlow Console/);

    const setup = await app.inject({ method: 'GET', url: '/setup' });
    assert.equal(setup.statusCode, 200);
    assert.match(setup.body, /WebGlow Console/);

    const monitor = await app.inject({ method: 'GET', url: '/monitor' });
    assert.equal(monitor.statusCode, 200);
    assert.match(monitor.body, /Live service health/);

    const settings = await app.inject({ method: 'GET', url: '/settings' });
    assert.equal(settings.statusCode, 200);
    assert.match(settings.body, /System settings/);

    const missing = await app.inject({ method: 'GET', url: '/api/v1/lights/tablet' });
    assert.equal(missing.statusCode, 404);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/lights',
      payload: { id: 'tablet', name: 'Living room tablet' },
    });
    assert.equal(created.statusCode, 201);

    const state = await app.inject({ method: 'GET', url: '/api/v1/lights/tablet' });
    assert.equal(state.statusCode, 200);
    assert.equal(state.json().id, 'tablet');
    assert.equal(state.json().state.on, false);

    const page = await app.inject({ method: 'GET', url: '/display/tablet' });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.match(page.body, /WebGlow display/);
  });
});

test('rejects invalid updates and stale revisions', async () => {
  await withApp(async (app) => {
    await app.inject({ method: 'POST', url: '/api/v1/lights', payload: { id: 'desk' } });

    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/v1/lights/desk',
      payload: { brightness: 101 },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, 'invalid_request');

    const stale = await app.inject({
      method: 'PATCH',
      url: '/api/v1/lights/desk',
      payload: { on: true, expectedRevision: 1 },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'revision_conflict');
  });
});

test('protects control routes when WEBGLOW_API_TOKEN is configured', async () => {
  await withApp(
    async (app) => {
      const unauthenticated = await app.inject({
        method: 'POST',
        url: '/api/v1/lights',
        payload: { id: 'protected' },
      });
      assert.equal(unauthenticated.statusCode, 401);
      assert.equal(unauthenticated.headers['www-authenticate'], 'Bearer');

      const authenticated = await app.inject({
        method: 'POST',
        url: '/api/v1/lights',
        headers: { authorization: 'Bearer secret-token' },
        payload: { id: 'protected' },
      });
      assert.equal(authenticated.statusCode, 201);

      const deleteWithoutToken = await app.inject({
        method: 'DELETE',
        url: '/api/v1/lights/protected',
      });
      assert.equal(deleteWithoutToken.statusCode, 401);
    },
    { apiToken: 'secret-token' },
  );
});

test('uses a portal session for protected management and persists display settings', async () => {
  await withApp(
    async (app) => {
      const beforeSetup = await app.inject({ method: 'GET', url: '/api/v1/auth/status' });
      assert.equal(beforeSetup.json().setupRequired, true);

      const account = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'portal-admin', password: 'a-long-test-password' },
      });
      assert.equal(account.statusCode, 201);
      const cookieHeader = Array.isArray(account.headers['set-cookie'])
        ? account.headers['set-cookie'][0]
        : account.headers['set-cookie'];
      assert.ok(cookieHeader);
      const sessionCookie = cookieHeader.split(';')[0];

      const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/lights' });
      assert.equal(unauthenticated.statusCode, 401);

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/lights',
        headers: { cookie: sessionCookie },
        payload: { id: 'portal-light' },
      });
      assert.equal(created.statusCode, 201);

      const settings = await app.inject({
        method: 'PATCH',
        url: '/api/v1/settings',
        headers: { cookie: sessionCookie },
        payload: { publicBaseUrl: 'https://lights.example.test/webglow/' },
      });
      assert.equal(settings.statusCode, 200);
      assert.equal(settings.json().publicBaseUrl, 'https://lights.example.test/webglow');

      const serverSettings = await app.inject({
        method: 'GET',
        url: '/api/v1/settings',
        headers: { cookie: sessionCookie },
      });
      assert.equal(serverSettings.statusCode, 200);
      assert.equal(serverSettings.json().server.port, 1828);

      const metrics = await app.inject({
        method: 'GET',
        url: '/api/v1/metrics',
        headers: { cookie: sessionCookie },
      });
      assert.equal(metrics.statusCode, 200);
      assert.equal(typeof metrics.json().process.rssBytes, 'number');
    },
    { apiToken: 'automation-token', passwordResetToken: 'recovery-token' },
  );
});

test('registers guest display lights and exposes the share QR and resource summary', async () => {
  await withApp(async (app) => {
    const closed = await app.inject({
      method: 'POST',
      url: '/api/v1/guest-registration',
      payload: { name: 'Guest One' },
    });
    assert.equal(closed.statusCode, 403);

    const settings = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { guestRegistrationEnabled: true },
    });
    assert.equal(settings.statusCode, 200);
    assert.equal(settings.json().guestRegistrationEnabled, true);

    const status = await app.inject({ method: 'GET', url: '/api/v1/guest-registration' });
    assert.deepEqual(status.json(), { enabled: true });

    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/guest-registration',
      payload: { name: 'Guest One' },
    });
    assert.equal(registered.statusCode, 201);
    assert.match(registered.json().light.id, /^guest-/);
    assert.equal(registered.json().light.name, "Guest One's light");
    assert.equal(registered.json().light.guest.displayName, 'Guest One');
    assert.equal(registered.json().displayPath, '/display/' + registered.json().light.id);

    const qr = await app.inject({ method: 'GET', url: '/api/v1/guest-registration/qr' });
    assert.equal(qr.statusCode, 200);
    assert.match(qr.headers['content-type'], /^image\/svg\+xml/);
    assert.match(qr.body, /<svg/);

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/v1/ws?role=display&lightId=${registered.json().light.id}`,
    );
    const snapshotPromise = waitForWebSocketMessage(socket);
    await waitForWebSocketOpen(socket);
    assert.equal((await snapshotPromise).type, 'state.snapshot');

    const summary = await app.inject({ method: 'GET', url: '/api/v1/guests' });
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.json().registered, 1);
    assert.equal(summary.json().active, 1);
    assert.equal(summary.json().activeSockets, 1);
    assert.equal(summary.json().guests[0].name, 'Guest One');
    assert.ok(summary.json().resources.persistedStateBytes > 0);
    assert.ok(summary.json().resources.outboundWebsocketBytes > 0);
    socket.close();
  });
});

test('updates groups and creates phased chases', async () => {
  await withApp(async (app) => {
    await app.inject({ method: 'POST', url: '/api/v1/lights', payload: { id: 'left' } });
    await app.inject({ method: 'POST', url: '/api/v1/lights', payload: { id: 'right' } });

    const batch = await app.inject({
      method: 'POST',
      url: '/api/v1/lights/batch',
      payload: {
        ids: 'all',
        state: { on: true, color: '#1ac', brightness: 68, pattern: 'twinkle', speed: 32, fadeMs: 500 },
      },
    });
    assert.equal(batch.statusCode, 200);
    assert.equal(batch.json().count, 2);
    assert.equal(batch.json().lights[0].state.color, '#11AACC');
    assert.equal(batch.json().lights[1].state.fadeMs, 500);

    const chase = await app.inject({
      method: 'POST',
      url: '/api/v1/lights/chase',
      payload: { ids: ['left', 'right'], speed: 62, fadeMs: 1000, color: '#f80' },
    });
    assert.equal(chase.statusCode, 200);
    assert.equal(chase.json().count, 2);
    assert.deepEqual(
      chase.json().lights.map((light) => light.state.phaseOffset),
      [0, 0.5],
    );
    assert.ok(chase.json().lights.every((light) => light.state.pattern === 'chase' && light.state.on));
  });
});

test('adds and drives a WLED fixture through its JSON API', async () => {
  const calls = [];
  const wledClient = new WledClient(async (url, init) => {
    calls.push({ url, init });
    const body = init?.method === 'POST'
      ? { state: { on: true } }
      : {
          info: { name: 'Garden pixels' },
          effects: ['Solid', 'Breathe', 'Strobe', 'Rainbow', 'Chase', 'Twinkle'],
          state: {
            on: true,
            bri: 128,
            transition: 5,
            seg: [{ id: 0, bri: 128, col: [[12, 34, 56]], fx: 0, sx: 64 }],
          },
        };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  await withApp(async (app) => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/lights',
      payload: { id: 'garden-wled', kind: 'wled', wled: { url: 'http://wled.test', segment: 0 } },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().light.kind, 'wled');
    assert.equal(created.json().light.name, 'Garden pixels');
    assert.equal(created.json().light.state.color, '#0C2238');
    assert.equal(created.json().displayPath, undefined);

    const display = await app.inject({ method: 'GET', url: '/display/garden-wled' });
    assert.equal(display.statusCode, 409);

    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/v1/lights/garden-wled',
      payload: { on: true, brightness: 75, color: '#f0a', pattern: 'breathe', speed: 40, fadeMs: 1000 },
    });
    assert.equal(updated.statusCode, 200);
    const command = JSON.parse(calls.at(-1).init.body);
    assert.equal(command.on, true);
    assert.equal(command.tt, 10);
    assert.deepEqual(command.seg[0].col, [[255, 0, 170]]);
    assert.equal(command.seg[0].fx, 1);
    assert.equal(command.seg[0].sx, 102);
    assert.equal(command.tb, updated.json().state.patternStartedAt >>> 0);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/lights',
      payload: { id: 'stage-wled', kind: 'wled', wled: { url: 'http://second-wled.test', segment: 0 } },
    });
    assert.equal(second.statusCode, 201);
    const batch = await app.inject({
      method: 'POST',
      url: '/api/v1/lights/batch',
      payload: { ids: ['garden-wled', 'stage-wled'], state: { on: true, pattern: 'chase', speed: 55 } },
    });
    assert.equal(batch.statusCode, 200);
    const synchronizedCommands = calls.filter((call) => call.init?.method === 'POST').slice(-2).map((call) => JSON.parse(call.init.body));
    assert.equal(synchronizedCommands[0].tb, synchronizedCommands[1].tb);
    assert.equal(synchronizedCommands[0].tb, batch.json().lights[0].state.patternStartedAt >>> 0);
    assert.equal(batch.json().lights[0].state.patternStartedAt, batch.json().lights[1].state.patternStartedAt);

    const refreshed = await app.inject({ method: 'POST', url: '/api/v1/lights/garden-wled/wled/refresh' });
    assert.equal(refreshed.statusCode, 200);
    assert.equal(refreshed.json().light.kind, 'wled');
  }, {}, { wledClient });
});

test('records, plays, and deletes persistent console cues', async () => {
  await withApp(async (app) => {
    await app.inject({ method: 'POST', url: '/api/v1/lights', payload: { id: 'cue-left' } });
    await app.inject({ method: 'POST', url: '/api/v1/lights', payload: { id: 'cue-right' } });

    const record = await app.inject({
      method: 'POST',
      url: '/api/v1/scenes',
      payload: {
        id: '1.5',
        name: 'Ocean look',
        ids: ['cue-left', 'cue-right'],
        state: { on: true, brightness: 71, color: '#07c', pattern: 'breathe', speed: 34, fadeMs: 2000 },
      },
    });
    assert.equal(record.statusCode, 201);
    assert.equal(record.json().scene.name, 'Ocean look');

    const listed = await app.inject({ method: 'GET', url: '/api/v1/scenes' });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().scenes.length, 1);

    const go = await app.inject({ method: 'POST', url: '/api/v1/scenes/1.5/go' });
    assert.equal(go.statusCode, 200);
    assert.equal(go.json().count, 2);
    assert.ok(go.json().lights.every((light) => light.state.color === '#0077CC' && light.state.pattern === 'breathe'));

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/scenes',
      payload: { id: '1.5', ids: 'all', state: { on: false } },
    });
    assert.equal(duplicate.statusCode, 409);

    const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/scenes/1.5' });
    assert.equal(deleted.statusCode, 204);
    const gone = await app.inject({ method: 'POST', url: '/api/v1/scenes/1.5/go' });
    assert.equal(gone.statusCode, 404);
  });
});

test('resets portal access using the configured recovery token', async () => {
  await withApp(
    async (app) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { username: 'reset-user', password: 'an-initial-password' },
      });
      assert.equal(created.statusCode, 201);

      const badReset = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/reset-password',
        payload: { username: 'reset-user', resetToken: 'wrong', newPassword: 'a-new-safe-password' },
      });
      assert.equal(badReset.statusCode, 401);

      const reset = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/reset-password',
        payload: { username: 'reset-user', resetToken: 'recovery-token', newPassword: 'a-new-safe-password' },
      });
      assert.equal(reset.statusCode, 204);

      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'reset-user', password: 'a-new-safe-password' },
      });
      assert.equal(login.statusCode, 200);
    },
    { passwordResetToken: 'recovery-token' },
  );
});

test('broadcasts a snapshot and later state changes to a display websocket', async () => {
  await withApp(async (app) => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/lights',
      payload: { id: 'websocket-display' },
    });
    assert.equal(created.statusCode, 201);

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');

    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/v1/ws?role=display&lightId=websocket-display`,
    );
    const snapshotPromise = waitForWebSocketMessage(socket);
    await waitForWebSocketOpen(socket);

    const snapshot = await snapshotPromise;
    assert.equal(snapshot.type, 'state.snapshot');
    assert.equal(snapshot.light.id, 'websocket-display');
    assert.equal(snapshot.light.state.on, false);

    const changedPromise = waitForWebSocketMessage(socket);
    const update = await app.inject({
      method: 'PATCH',
      url: '/api/v1/lights/websocket-display',
      payload: { on: true, color: '#f0a', pattern: 'rainbow' },
    });
    assert.equal(update.statusCode, 200);

    const changed = await changedPromise;
    assert.equal(changed.type, 'state.changed');
    assert.equal(changed.light.state.on, true);
    assert.equal(changed.light.state.color, '#FF00AA');
    assert.equal(changed.light.state.pattern, 'rainbow');

    const deletedPromise = waitForWebSocketMessage(socket);
    const deletedResponse = await app.inject({
      method: 'DELETE',
      url: '/api/v1/lights/websocket-display',
    });
    assert.equal(deletedResponse.statusCode, 204);
    const deleted = await deletedPromise;
    assert.deepEqual(deleted, { type: 'light.deleted', lightId: 'websocket-display' });

    const missing = await app.inject({ method: 'GET', url: '/api/v1/lights/websocket-display' });
    assert.equal(missing.statusCode, 404);
    socket.close();
  });
});
