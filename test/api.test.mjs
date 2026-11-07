import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { buildApp } from '../dist/app.js';

async function withApp(callback, configuration = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'webglow-test-'));
  const app = await buildApp({
    logger: false,
    config: {
      dataFile: join(directory, 'lights.json'),
      staticRoot: resolve('dist/public'),
      ...configuration,
    },
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
      patternStartedAt: created.json().light.state.patternStartedAt,
    });
    assert.equal(created.json().displayPath, '/display/phone-1');

    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/v1/lights/phone-1',
      payload: {
        on: true,
        brightness: 42.5,
        color: '#0aB',
        pattern: 'pulse',
        speed: 25,
        expectedRevision: 0,
      },
    });

    assert.equal(updated.statusCode, 200);
    assert.deepEqual(updated.json().state, {
      on: true,
      brightness: 42.5,
      color: '#00AABB',
      pattern: 'pulse',
      speed: 25,
      patternStartedAt: updated.json().state.patternStartedAt,
    });
    assert.equal(updated.json().revision, 1);

    const listed = await app.inject({ method: 'GET', url: '/api/v1/lights' });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().lights.length, 1);
    assert.equal(listed.json().lights[0].name, 'Kitchen phone');
  });
});

test('creates a light when a display fetches its state and serves the display page', async () => {
  await withApp(async (app) => {
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
    await app.inject({ method: 'GET', url: '/api/v1/lights/desk' });

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
    },
    { apiToken: 'secret-token' },
  );
});

test('broadcasts a snapshot and later state changes to a display websocket', async () => {
  await withApp(async (app) => {
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
    socket.close();
  });
});
