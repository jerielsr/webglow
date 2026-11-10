import { timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';

import { getConfig, type WebglowConfig } from './config.js';
import { ApiError } from './errors.js';
import { LightStore } from './light-store.js';
import { Metrics } from './metrics.js';
import { PortalAuth } from './portal-auth.js';
import { SceneStore } from './scene-store.js';
import { SettingsStore } from './settings-store.js';
import { PATTERNS, type LightPatch, type LightResource } from './types.js';
import { WledClient } from './wled-client.js';
import {
  validateBatchLightPatch,
  validateChase,
  validateCreateScene,
  validateCreateLight,
  validateLightId,
  validateLightPatch,
  validateSceneId,
} from './validation.js';

const SESSION_COOKIE = 'webglow_portal_session';

export interface BuildAppOptions {
  config?: Partial<WebglowConfig>;
  logger?: boolean | FastifyBaseLogger;
  store?: LightStore;
  settingsStore?: SettingsStore;
  sceneStore?: SceneStore;
  wledClient?: WledClient;
}

function mergeConfig(overrides: Partial<WebglowConfig> = {}): WebglowConfig {
  const config = { ...getConfig(), ...overrides };
  if (overrides.dataFile && !overrides.settingsFile) {
    config.settingsFile = join(dirname(overrides.dataFile), 'settings.json');
  }
  if (overrides.dataFile && !overrides.scenesFile) {
    config.scenesFile = join(dirname(overrides.dataFile), 'scenes.json');
  }
  return config;
}

function hasValidToken(value: string | undefined, expected: string): boolean {
  if (!value) {
    return false;
  }
  const received = Buffer.from(value);
  const configured = Buffer.from(expected);
  return received.length === configured.length && timingSafeEqual(received, configured);
}

function displayPath(lightId: string): string {
  return `/display/${encodeURIComponent(lightId)}`;
}

function websocketMessage(type: 'state.snapshot' | 'state.changed', light: LightResource): string {
  return JSON.stringify({ type, light });
}

function deletedWebsocketMessage(lightId: string): string {
  return JSON.stringify({ type: 'light.deleted', lightId });
}

function byteLength(payload: unknown): number {
  if (typeof payload === 'string') return Buffer.byteLength(payload);
  if (Buffer.isBuffer(payload)) return payload.length;
  if (payload instanceof Uint8Array) return payload.byteLength;
  return 0;
}

function asRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'invalid_request', `${subject} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function rejectKeys(record: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ApiError(400, 'invalid_request', 'The request contains unsupported fields.', { fields: unknown });
  }
}

function validateUsername(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{3,64}$/.test(value)) {
    throw new ApiError(
      400,
      'invalid_request',
      'username must contain 3–64 letters, numbers, periods, underscores, or hyphens.',
      { field: 'username' },
    );
  }
  return value;
}

function validatePassword(value: unknown, field = 'password'): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) {
    throw new ApiError(400, 'invalid_request', `${field} must contain 12–256 characters.`, { field });
  }
  return value;
}

function validatePublicBaseUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_request', 'publicBaseUrl must be an HTTP or HTTPS URL.', {
      field: 'publicBaseUrl',
    });
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ApiError(400, 'invalid_request', 'publicBaseUrl must be an HTTP or HTTPS URL.', {
      field: 'publicBaseUrl',
    });
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ApiError(
      400,
      'invalid_request',
      'publicBaseUrl must be a plain HTTP or HTTPS base URL without credentials, query text, or a fragment.',
      { field: 'publicBaseUrl' },
    );
  }
  return url.toString().replace(/\/$/, '');
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = mergeConfig(options.config);
  const store = options.store ?? new LightStore(config.dataFile);
  const settings = options.settingsStore ?? new SettingsStore(config.settingsFile);
  const scenes = options.sceneStore ?? new SceneStore(config.scenesFile);
  const wled = options.wledClient ?? new WledClient();
  await Promise.all([store.initialize(), settings.initialize(), scenes.initialize()]);
  const portalAuth = new PortalAuth(settings, config.passwordResetToken);
  const metrics = new Metrics();

  const app = Fastify({ logger: options.logger ?? true, trustProxy: true });

  function sessionFor(request: FastifyRequest): { username: string } | undefined {
    return portalAuth.getSession(request.cookies[SESSION_COOKIE]);
  }

  function requireControllerAccess(request: FastifyRequest): void {
    if (sessionFor(request)) return;
    const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (config.apiToken && hasValidToken(token, config.apiToken)) return;
    if (settings.hasPortalAccount() || config.apiToken) {
      throw new ApiError(401, 'unauthorized', 'Sign in to the portal or provide a valid Bearer token.');
    }
  }

  function setSessionCookie(reply: { setCookie: Function }, request: FastifyRequest, sessionId: string): void {
    reply.setCookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'strict',
      secure: request.protocol === 'https',
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
    });
  }

  function clearSessionCookie(reply: { clearCookie: Function }): void {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  function hasOutputPatch(patch: LightPatch): boolean {
    return (
      patch.on !== undefined ||
      patch.brightness !== undefined ||
      patch.color !== undefined ||
      patch.pattern !== undefined ||
      patch.speed !== undefined ||
      patch.fadeMs !== undefined ||
      patch.phaseOffset !== undefined
    );
  }

  function previewLight(light: LightResource, patch: LightPatch): LightResource {
    return {
      ...light,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      state: {
        ...light.state,
        ...(patch.on === undefined ? {} : { on: patch.on }),
        ...(patch.brightness === undefined ? {} : { brightness: patch.brightness }),
        ...(patch.color === undefined ? {} : { color: patch.color }),
        ...(patch.pattern === undefined ? {} : { pattern: patch.pattern }),
        ...(patch.speed === undefined ? {} : { speed: patch.speed }),
        ...(patch.fadeMs === undefined ? {} : { fadeMs: patch.fadeMs }),
        ...(patch.phaseOffset === undefined ? {} : { phaseOffset: patch.phaseOffset }),
      },
    };
  }

  /**
   * Physical WLED fixtures are driven before their persisted state changes.
   * This prevents the console from reporting a successful live cue when a
   * reachable device has rejected or missed the command.
   */
  async function updateLights(updates: Array<{ id: string; patch: LightPatch }>): Promise<LightResource[]> {
    const current = await Promise.all(updates.map((update) => store.get(update.id)));
    if (current.some((light) => !light)) return [];

    const existing = current as LightResource[];
    for (let index = 0; index < updates.length; index += 1) {
      const expected = updates[index].patch.expectedRevision;
      if (expected !== undefined && expected !== existing[index].revision) {
        throw new ApiError(409, 'revision_conflict', 'The light changed since the revision supplied with this request.', {
          expectedRevision: expected,
          currentRevision: existing[index].revision,
        });
      }
    }

    // One clock value is shared by all browser renderers and WLED commands.
    // Calls are dispatched together; WLED's timebase then removes visible
    // phase drift caused by small per-device HTTP timing differences.
    const synchronizedAt = Date.now();
    await Promise.all(
      updates.map(async (update, index) => {
        const light = existing[index];
        if (light.kind === 'wled' && hasOutputPatch(update.patch)) {
          await wled.apply(previewLight(light, update.patch), synchronizedAt);
        }
      }),
    );

    return store.updateMany(
      updates.map((update, index) => ({
        id: update.id,
        patch: update.patch.expectedRevision === undefined
          ? { ...update.patch, expectedRevision: existing[index].revision }
          : update.patch,
      })),
      synchronizedAt,
    );
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.statusCode === 401) reply.header('WWW-Authenticate', 'Bearer');
      void reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
      return;
    }
    request.log.error(error);
    void reply.status(500).send({
      error: { code: 'internal_error', message: 'The server could not complete this request.' },
    });
  });

  app.addHook('onRequest', async (request) => {
    metrics.recordRequest(Number(request.headers['content-length']) || 0);
  });
  app.addHook('onSend', async (_request, _reply, payload) => {
    metrics.recordResponse(byteLength(payload));
    return payload;
  });
  app.addHook('onClose', async () => {
    await Promise.all([store.close(), settings.close(), scenes.close()]);
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: config.corsOrigin,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: config.corsOrigin !== '*',
  });
  await app.register(websocket);
  await app.register(fastifyStatic, { root: config.staticRoot, prefix: '/', index: false });

  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').sendFile('app.html'));
  app.get('/setup', async (_request, reply) => reply.type('text/html; charset=utf-8').sendFile('app.html'));
  app.get('/settings', async (_request, reply) => reply.type('text/html; charset=utf-8').sendFile('app.html'));
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/api/v1/info', async () => ({
    name: 'webglow',
    apiVersion: 'v1',
    portalPath: '/',
    setupPath: '/setup',
    portalAuthentication: 'username-password-session',
    controllerBearerTokenConfigured: Boolean(config.apiToken),
    capabilities: {
      patterns: [...PATTERNS],
      fixtureKinds: ['display', 'wled'],
      brightness: { minimum: 0, maximum: 100, unit: 'rendered-percent' },
      fadeMs: { minimum: 0, maximum: 60_000 },
      synchronizedEffects: 'shared effect clock and WLED timebase',
      realtime: 'websocket',
      persistence: 'file',
    },
  }));

  app.get('/api/v1/auth/status', async (request) => {
    const session = sessionFor(request);
    return {
      setupRequired: portalAuth.setupRequired(),
      authenticated: Boolean(session),
      ...(session ? { username: session.username } : {}),
      passwordResetConfigured: portalAuth.passwordResetConfigured(),
    };
  });

  app.post<{ Body: unknown }>('/api/v1/auth/setup', async (request, reply) => {
    if (!portalAuth.setupRequired()) {
      throw new ApiError(409, 'account_already_configured', 'A portal account is already configured.');
    }
    const body = asRecord(request.body, 'The request body');
    rejectKeys(body, ['username', 'password']);
    const result = await portalAuth.setup(validateUsername(body.username), validatePassword(body.password));
    setSessionCookie(reply, request, result.sessionId);
    return reply.status(201).send({ username: result.username });
  });

  app.post<{ Body: unknown }>('/api/v1/auth/login', async (request, reply) => {
    if (portalAuth.setupRequired()) {
      throw new ApiError(409, 'portal_setup_required', 'Create the first portal account before signing in.');
    }
    const body = asRecord(request.body, 'The request body');
    rejectKeys(body, ['username', 'password']);
    const result = await portalAuth.login(validateUsername(body.username), validatePassword(body.password));
    setSessionCookie(reply, request, result.sessionId);
    return { username: result.username };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    portalAuth.logout(request.cookies[SESSION_COOKIE]);
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.post<{ Body: unknown }>('/api/v1/auth/change-password', async (request, reply) => {
    const body = asRecord(request.body, 'The request body');
    rejectKeys(body, ['currentPassword', 'newPassword']);
    await portalAuth.changePassword(
      request.cookies[SESSION_COOKIE],
      validatePassword(body.currentPassword, 'currentPassword'),
      validatePassword(body.newPassword, 'newPassword'),
    );
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.post<{ Body: unknown }>('/api/v1/auth/reset-password', async (request, reply) => {
    const body = asRecord(request.body, 'The request body');
    rejectKeys(body, ['username', 'resetToken', 'newPassword']);
    if (typeof body.resetToken !== 'string' || body.resetToken.length === 0) {
      throw new ApiError(400, 'invalid_request', 'resetToken must be a non-empty string.', { field: 'resetToken' });
    }
    await portalAuth.resetPassword(
      validateUsername(body.username),
      body.resetToken,
      validatePassword(body.newPassword, 'newPassword'),
    );
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.get('/api/v1/settings', async (request) => {
    requireControllerAccess(request);
    return {
      ...settings.getPublicSettings(),
      controllerBearerTokenConfigured: Boolean(config.apiToken),
      passwordResetConfigured: portalAuth.passwordResetConfigured(),
      server: {
        port: config.port,
        corsOrigin: config.corsOrigin,
        persistence: 'DATA_DIR',
      },
    };
  });

  app.patch<{ Body: unknown }>('/api/v1/settings', async (request) => {
    requireControllerAccess(request);
    const body = asRecord(request.body, 'The request body');
    rejectKeys(body, ['publicBaseUrl']);
    if (!Object.hasOwn(body, 'publicBaseUrl')) {
      throw new ApiError(400, 'invalid_request', 'Provide publicBaseUrl to update settings.');
    }
    return settings.setPublicBaseUrl(validatePublicBaseUrl(body.publicBaseUrl));
  });

  app.get('/api/v1/metrics', async (request) => {
    requireControllerAccess(request);
    return metrics.snapshot();
  });

  app.get('/api/v1/lights', async (request) => {
    requireControllerAccess(request);
    return { lights: await store.list() };
  });

  app.post<{ Body: unknown }>('/api/v1/lights', async (request, reply) => {
    requireControllerAccess(request);
    const input = validateCreateLight(request.body);
    if (input.kind === 'wled' && input.wled) {
      const inspected = await wled.inspect(input.wled);
      const created = await store.create({
        ...input,
        ...(input.name === undefined && inspected.name ? { name: inspected.name } : {}),
        wled: { ...input.wled, effectMap: inspected.effectMap },
      });
      const light = (await store.update(created.id, {
        on: inspected.state.on,
        brightness: inspected.state.brightness,
        color: inspected.state.color,
        pattern: inspected.state.pattern,
        speed: inspected.state.speed,
        fadeMs: inspected.state.fadeMs,
        phaseOffset: inspected.state.phaseOffset,
      })) as LightResource;
      return reply.status(201).send({ light });
    }
    const light = await store.create(input);
    return reply.status(201).send({ light, displayPath: displayPath(light.id) });
  });

  app.get<{ Params: { lightId: string } }>('/api/v1/lights/:lightId', async (request) => {
    const id = validateLightId(request.params.lightId);
    const light = await store.get(id);
    if (!light) throw new ApiError(404, 'light_not_found', `No light exists with ID "${id}".`);
    if (light.kind === 'wled') requireControllerAccess(request);
    return light;
  });

  app.patch<{ Params: { lightId: string }; Body: unknown }>('/api/v1/lights/:lightId', async (request) => {
    requireControllerAccess(request);
    const id = validateLightId(request.params.lightId);
    const light = (await updateLights([{ id, patch: validateLightPatch(request.body) }]))[0];
    if (!light) throw new ApiError(404, 'light_not_found', `No light exists with ID "${id}".`);
    return light;
  });

  app.post<{ Params: { lightId: string } }>('/api/v1/lights/:lightId/wled/refresh', async (request) => {
    requireControllerAccess(request);
    const id = validateLightId(request.params.lightId);
    const light = await store.get(id);
    if (!light) throw new ApiError(404, 'light_not_found', 'No light exists with ID "' + id + '".');
    if (light.kind !== 'wled' || !light.wled) {
      throw new ApiError(409, 'not_a_wled_fixture', 'This fixture is not connected to WLED.');
    }
    const inspected = await wled.inspect(light.wled);
    const refreshed = await store.update(id, {
      on: inspected.state.on,
      brightness: inspected.state.brightness,
      color: inspected.state.color,
      pattern: inspected.state.pattern,
      speed: inspected.state.speed,
      fadeMs: inspected.state.fadeMs,
      phaseOffset: inspected.state.phaseOffset,
    });
    return { light: refreshed };
  });

  app.post<{ Body: unknown }>('/api/v1/lights/batch', async (request) => {
    requireControllerAccess(request);
    const input = validateBatchLightPatch(request.body);
    const targetIds = input.ids === 'all' ? (await store.list()).map((light) => light.id) : input.ids;
    const existing = await Promise.all(targetIds.map((id) => store.get(id)));
    const missing = targetIds.filter((_, index) => !existing[index]);
    if (missing.length > 0) {
      throw new ApiError(404, 'light_not_found', 'One or more selected lights do not exist.', { ids: missing });
    }
    const lights = await updateLights(targetIds.map((id) => ({ id, patch: input.state })));
    return { lights, count: lights.length };
  });

  app.post<{ Body: unknown }>('/api/v1/lights/chase', async (request) => {
    requireControllerAccess(request);
    const input = validateChase(request.body);
    const targetIds = input.ids === 'all' ? (await store.list()).map((light) => light.id) : input.ids;
    const existing = await Promise.all(targetIds.map((id) => store.get(id)));
    const missing = targetIds.filter((_, index) => !existing[index]);
    if (missing.length > 0) {
      throw new ApiError(404, 'light_not_found', 'One or more selected lights do not exist.', { ids: missing });
    }
    const denominator = Math.max(1, targetIds.length);
    const lights = await updateLights(
      targetIds.map((id, index) => ({
        id,
        patch: {
          pattern: 'chase',
          speed: input.speed,
          fadeMs: input.fadeMs,
          phaseOffset: index / denominator,
          ...(input.color === undefined ? {} : { color: input.color }),
          ...(input.on === undefined ? { on: true } : { on: input.on }),
        } satisfies LightPatch,
      })),
    );
    return { lights, count: lights.length };
  });

  app.get('/api/v1/scenes', async (request) => {
    requireControllerAccess(request);
    return { scenes: await scenes.list() };
  });

  app.post<{ Body: unknown }>('/api/v1/scenes', async (request, reply) => {
    requireControllerAccess(request);
    const scene = await scenes.create(validateCreateScene(request.body));
    return reply.status(201).send({ scene });
  });

  app.post<{ Params: { sceneId: string } }>('/api/v1/scenes/:sceneId/go', async (request) => {
    requireControllerAccess(request);
    const id = validateSceneId(request.params.sceneId);
    const scene = await scenes.get(id);
    if (!scene) {
      throw new ApiError(404, 'cue_not_found', 'No cue exists with number "' + id + '".');
    }
    const targetIds = scene.ids === 'all' ? (await store.list()).map((light) => light.id) : scene.ids;
    const existing = await Promise.all(targetIds.map((lightId) => store.get(lightId)));
    const missing = targetIds.filter((_, index) => !existing[index]);
    if (missing.length > 0) {
      throw new ApiError(409, 'cue_targets_missing', 'This cue includes lights that no longer exist.', { ids: missing });
    }
    const lights = await updateLights(targetIds.map((lightId) => ({ id: lightId, patch: scene.state })));
    return { scene, lights, count: lights.length };
  });

  app.delete<{ Params: { sceneId: string } }>('/api/v1/scenes/:sceneId', async (request, reply) => {
    requireControllerAccess(request);
    const id = validateSceneId(request.params.sceneId);
    const scene = await scenes.remove(id);
    if (!scene) {
      throw new ApiError(404, 'cue_not_found', 'No cue exists with number "' + id + '".');
    }
    return reply.status(204).send();
  });

  app.delete<{ Params: { lightId: string } }>('/api/v1/lights/:lightId', async (request, reply) => {
    requireControllerAccess(request);
    const id = validateLightId(request.params.lightId);
    const light = await store.remove(id);
    if (!light) throw new ApiError(404, 'light_not_found', `No light exists with ID "${id}".`);
    return reply.status(204).send();
  });

  app.get<{ Params: { lightId: string } }>('/display/:lightId', async (request, reply) => {
    const id = validateLightId(request.params.lightId);
    const light = await store.get(id);
    if (!light) throw new ApiError(404, 'light_not_found', 'No light exists with ID "' + id + '".');
    if (light.kind !== 'display') {
      throw new ApiError(409, 'not_a_web_display', 'This fixture is a physical WLED device, not a web display.');
    }
    return reply.type('text/html; charset=utf-8').sendFile('display.html');
  });

  app.get('/api/v1/ws', { websocket: true }, (socket, request) => {
    const requestUrl = new URL(request.raw.url ?? '/api/v1/ws', 'http://webglow.local');
    const lightId = requestUrl.searchParams.get('lightId');
    const role = requestUrl.searchParams.get('role');
    if (role !== 'display' || !lightId) {
      socket.close(1008, 'A display role and lightId are required.');
      return;
    }
    try {
      validateLightId(lightId);
    } catch {
      socket.close(1008, 'Invalid light ID.');
      return;
    }

    let unsubscribe: (() => void) | undefined;
    let closed = false;
    metrics.websocketOpened();
    const cleanup = () => {
      if (closed) return;
      closed = true;
      metrics.websocketClosed();
      unsubscribe?.();
      unsubscribe = undefined;
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    const send = (message: string) => {
      if (!closed && socket.readyState === 1) {
        socket.send(message);
        metrics.recordResponse(Buffer.byteLength(message));
      }
    };

    void store
      .get(lightId)
      .then((light) => {
        if (closed) return;
        if (!light) {
          socket.close(1008, 'The requested light does not exist.');
          return;
        }
        if (light.kind !== 'display') {
          socket.close(1008, 'The requested fixture is not a web display.');
          return;
        }
        send(websocketMessage('state.snapshot', light));
        const unsubscribeChanged = store.onChange((changedLight) => {
          if (changedLight.id === lightId) send(websocketMessage('state.changed', changedLight));
        });
        const unsubscribeDeleted = store.onDelete((deletedLight) => {
          if (deletedLight.id === lightId) {
            send(deletedWebsocketMessage(lightId));
            socket.close(1000, 'Light deleted.');
          }
        });
        unsubscribe = () => {
          unsubscribeChanged();
          unsubscribeDeleted();
        };
      })
      .catch((error: unknown) => {
        app.log.error(error, 'Unable to initialize display websocket.');
        socket.close(1011, 'Unable to load light state.');
      });
  });

  return app;
}
