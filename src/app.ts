import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import QRCode from 'qrcode';

import { CommandHistoryStore, HISTORY_RETENTIONS, type HistoryRetention } from './command-history-store.js';
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
  validateName,
  validateSceneId,
} from './validation.js';

const SESSION_COOKIE = 'webglow_portal_session';
const MEDIA_TYPES: Record<string, { extension: string; kind: 'image' | 'video' }> = {
  'image/jpeg': { extension: '.jpg', kind: 'image' },
  'image/png': { extension: '.png', kind: 'image' },
  'image/webp': { extension: '.webp', kind: 'image' },
  'image/gif': { extension: '.gif', kind: 'image' },
  'video/mp4': { extension: '.mp4', kind: 'video' },
  'video/webm': { extension: '.webm', kind: 'video' },
};
const MEDIA_CONTENT_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(MEDIA_TYPES).map(([contentType, value]) => [value.extension, contentType]),
);

export interface BuildAppOptions {
  config?: Partial<WebglowConfig>;
  logger?: boolean | FastifyBaseLogger;
  store?: LightStore;
  settingsStore?: SettingsStore;
  sceneStore?: SceneStore;
  historyStore?: CommandHistoryStore;
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
  if (overrides.dataFile && !overrides.historyFile) config.historyFile = join(dirname(overrides.dataFile), 'history.json');
  if (overrides.dataFile && !overrides.mediaDirectory) config.mediaDirectory = join(dirname(overrides.dataFile), 'media');
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
  const history = options.historyStore ?? new CommandHistoryStore(config.historyFile);
  const wled = options.wledClient ?? new WledClient();
  await Promise.all([store.initialize(), settings.initialize(), scenes.initialize()]);
  await history.initialize(settings.getPublicSettings().historyRetention);
  await mkdir(config.mediaDirectory, { recursive: true });
  const portalAuth = new PortalAuth(settings, config.passwordResetToken);
  const metrics = new Metrics();
  const guestConnections = new Map<string, number>();
  const guestRegistrationAttempts = new Map<string, { count: number; resetAt: number }>();
  let guestOutboundWebsocketBytes = 0;
  let guestExpiryTimer: NodeJS.Timeout | undefined;
  let activeScalableCueId: string | null = scenes.getActiveScalableCue() ?? null;

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

  function guestJoinUrl(request: FastifyRequest): string {
    const configured = settings.getPublicSettings().publicBaseUrl;
    const base = configured ?? request.protocol + '://' + (request.headers.host ?? 'localhost');
    return new URL('join', base.replace(/\/$/, '') + '/').toString();
  }

  function noteGuestRegistration(request: FastifyRequest): void {
    const now = Date.now();
    const key = request.ip;
    const current = guestRegistrationAttempts.get(key);
    const windowState = !current || current.resetAt <= now ? { count: 0, resetAt: now + 10 * 60_000 } : current;
    if (windowState.count >= 12) {
      throw new ApiError(429, 'guest_registration_rate_limited', 'Too many guest registrations from this network. Try again in a few minutes.');
    }
    windowState.count += 1;
    guestRegistrationAttempts.set(key, windowState);
  }

  async function guestSnapshot(request: FastifyRequest) {
    const guests = (await store.list()).filter((light) => light.guest);
    const active = guests.filter((light) => (guestConnections.get(light.id) ?? 0) > 0);
    const guestState = guests.map((light) => ({
      id: light.id,
      name: light.guest?.displayName ?? light.name,
      connected: (guestConnections.get(light.id) ?? 0) > 0,
      registeredAt: light.guest?.registeredAt,
      lastSeenAt: light.guest?.lastSeenAt ?? light.guest?.registeredAt,
    }));
    return {
      registrationEnabled: settings.getPublicSettings().guestRegistrationEnabled,
      joinUrl: guestJoinUrl(request),
      registered: guests.length,
      active: active.length,
      activeSockets: active.reduce((total, light) => total + (guestConnections.get(light.id) ?? 0), 0),
      resources: {
        persistedStateBytes: Buffer.byteLength(JSON.stringify(guests)),
        outboundWebsocketBytes: guestOutboundWebsocketBytes,
      },
      guests: guestState,
    };
  }

  async function expireInactiveGuests(): Promise<number> {
    const options = settings.getPublicSettings();
    if (!options.guestAutoRemoveEnabled) return 0;
    const cutoff = Date.now() - options.guestInactivityHours * 60 * 60_000;
    const guests = (await store.list()).filter((light) => light.guest);
    const expired = guests.filter((light) => {
      if ((guestConnections.get(light.id) ?? 0) > 0) return false;
      const lastSeen = Date.parse(light.guest?.lastSeenAt ?? light.guest?.registeredAt ?? '');
      return Number.isFinite(lastSeen) && lastSeen < cutoff;
    });
    await Promise.all(expired.map(async (light) => {
      await store.remove(light.id);
      await scenes.removeFixture(light.id);
      await history.record({ action: 'Guest expiry', summary: 'Removed inactive guest ' + (light.guest?.displayName ?? light.name), fixtureIds: [light.id] });
    }));
    if (expired.length) await applyActiveScalableCue();
    return expired.length;
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

  async function applyActiveScalableCue(): Promise<void> {
    if (!activeScalableCueId) return;
    const scene = await scenes.get(activeScalableCueId);
    if (!scene || scene.ids !== 'all' || !scene.scaleEffect) {
      activeScalableCueId = null;
      await scenes.setActiveScalableCue(undefined);
      return;
    }
    const lights = await store.list();
    const count = Math.max(1, lights.length);
    await updateLights(lights.map((light, index) => ({
      id: light.id,
      patch: { ...scene.state, phaseOffset: index / count },
    })));
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
    if ((error as { code?: string; statusCode?: number }).code === 'FST_REQ_FILE_TOO_LARGE' || (error as { statusCode?: number }).statusCode === 413) {
      void reply.status(413).send({ error: { code: 'media_too_large', message: 'Media files must be 40 MB or smaller.' } });
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
    if (guestExpiryTimer) clearInterval(guestExpiryTimer);
    await Promise.all([store.close(), settings.close(), scenes.close(), history.close()]);
  });

  await app.register(multipart, { limits: { files: 1, fileSize: 40 * 1024 * 1024, fields: 2 } });
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
  app.get('/monitor', async (_request, reply) => reply.type('text/html; charset=utf-8').sendFile('app.html'));
  app.get('/settings', async (_request, reply) => reply.type('text/html; charset=utf-8').sendFile('app.html'));
  app.get('/join', async (_request, reply) => reply.type('text/html; charset=utf-8').sendFile('join.html'));
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
      media: ['jpeg', 'png', 'webp', 'gif', 'mp4', 'webm'],
      commandHistory: [...HISTORY_RETENTIONS],
      scalableCueEffects: true,
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
    const previousRetention = settings.getPublicSettings().historyRetention;
    const body = asRecord(request.body, 'The request body');
    rejectKeys(body, ['publicBaseUrl', 'guestRegistrationEnabled', 'historyRetention', 'guestAutoRemoveEnabled', 'guestInactivityHours']);
    if (!Object.keys(body).length) {
      throw new ApiError(400, 'invalid_request', 'Provide a setting to update.');
    }
    if (body.guestRegistrationEnabled !== undefined && typeof body.guestRegistrationEnabled !== 'boolean') {
      throw new ApiError(400, 'invalid_request', 'guestRegistrationEnabled must be true or false.', {
        field: 'guestRegistrationEnabled',
      });
    }
    if (body.historyRetention !== undefined && !HISTORY_RETENTIONS.includes(body.historyRetention as HistoryRetention)) {
      throw new ApiError(400, 'invalid_request', 'historyRetention must be all, year, month, week, or day.', { field: 'historyRetention' });
    }
    if (body.guestAutoRemoveEnabled !== undefined && typeof body.guestAutoRemoveEnabled !== 'boolean') {
      throw new ApiError(400, 'invalid_request', 'guestAutoRemoveEnabled must be true or false.', { field: 'guestAutoRemoveEnabled' });
    }
    if (body.guestInactivityHours !== undefined && ![1, 6, 12, 24, 72, 168].includes(body.guestInactivityHours as number)) {
      throw new ApiError(400, 'invalid_request', 'guestInactivityHours must be 1, 6, 12, 24, 72, or 168.', { field: 'guestInactivityHours' });
    }
    const updated = await settings.updatePublicSettings({
      ...(Object.hasOwn(body, 'publicBaseUrl') ? { publicBaseUrl: validatePublicBaseUrl(body.publicBaseUrl) } : {}),
      ...(Object.hasOwn(body, 'guestRegistrationEnabled') ? { guestRegistrationEnabled: body.guestRegistrationEnabled as boolean } : {}),
      ...(Object.hasOwn(body, 'historyRetention') ? { historyRetention: body.historyRetention as HistoryRetention } : {}),
      ...(Object.hasOwn(body, 'guestAutoRemoveEnabled') ? { guestAutoRemoveEnabled: body.guestAutoRemoveEnabled as boolean } : {}),
      ...(Object.hasOwn(body, 'guestInactivityHours') ? { guestInactivityHours: body.guestInactivityHours as number } : {}),
    });
    if (updated.historyRetention !== previousRetention) await history.setRetention(updated.historyRetention);
    return updated;
  });

  app.get('/api/v1/metrics', async (request) => {
    requireControllerAccess(request);
    return metrics.snapshot();
  });

  app.get('/api/v1/history', async (request) => {
    requireControllerAccess(request);
    const query = new URL(request.raw.url ?? '/api/v1/history', 'http://webglow.local').searchParams;
    if (query.get('includeEvents') !== 'true') return history.summary();
    const offset = Number(query.get('offset') ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ApiError(400, 'invalid_history_offset', 'History offset must be a non-negative integer.');
    }
    return history.list(offset, 200);
  });

  app.get('/api/v1/guests', async (request) => {
    requireControllerAccess(request);
    return guestSnapshot(request);
  });

  app.get('/api/v1/media', async (request) => {
    requireControllerAccess(request);
    const entries = await readdir(config.mediaDirectory, { withFileTypes: true });
    const assets = await Promise.all(entries.filter((entry) => entry.isFile() && Object.hasOwn(MEDIA_CONTENT_TYPES, extname(entry.name).toLowerCase())).map(async (entry) => {
      const info = await stat(join(config.mediaDirectory, entry.name));
      return {
        id: entry.name,
        url: '/media/' + encodeURIComponent(entry.name),
        kind: MEDIA_TYPES[MEDIA_CONTENT_TYPES[extname(entry.name).toLowerCase()]].kind,
        sizeBytes: info.size,
        updatedAt: info.mtime.toISOString(),
      };
    }));
    return { assets: assets.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) };
  });

  app.post('/api/v1/media', { bodyLimit: 42 * 1024 * 1024 }, async (request, reply) => {
    requireControllerAccess(request);
    const upload = await request.file();
    if (!upload) throw new ApiError(400, 'media_file_required', 'Choose one image, GIF, MP4, or WebM file to upload.');
    const type = MEDIA_TYPES[upload.mimetype.toLowerCase()];
    if (!type) {
      upload.file.resume();
      throw new ApiError(415, 'unsupported_media_type', 'Supported media: JPEG, PNG, WebP, GIF, MP4, and WebM.');
    }
    const id = randomUUID() + type.extension;
    const destination = join(config.mediaDirectory, id);
    try { await pipeline(upload.file, createWriteStream(destination, { flags: 'wx' })); } catch (error) {
      await unlink(destination).catch(() => undefined);
      throw error;
    }
    if (upload.file.truncated) {
      await unlink(destination).catch(() => undefined);
      throw new ApiError(413, 'media_too_large', 'Media files must be 40 MB or smaller.');
    }
    const info = await stat(destination);
    await history.record({ action: 'Media upload', summary: 'Uploaded ' + upload.filename, fixtureIds: [], detail: Math.round(info.size / 1024) + ' KB' });
    return reply.status(201).send({
      asset: { id, url: '/media/' + encodeURIComponent(id), kind: type.kind, sizeBytes: info.size, updatedAt: info.mtime.toISOString() },
    });
  });

  app.delete<{ Params: { assetId: string } }>('/api/v1/media/:assetId', async (request, reply) => {
    requireControllerAccess(request);
    const id = request.params.assetId;
    if (!/^[0-9a-f-]{36}\.(jpg|png|webp|gif|mp4|webm)$/i.test(id)) {
      throw new ApiError(400, 'invalid_media_id', 'The media ID is invalid.');
    }
    try { await stat(join(config.mediaDirectory, id)); } catch {
      throw new ApiError(404, 'media_not_found', 'The requested media file does not exist.');
    }
    const assetUrl = '/media/' + encodeURIComponent(id);
    const affected = (await store.list()).filter((light) => light.kind === 'display' && light.state.mediaUrl === assetUrl);
    if (affected.length) await updateLights(affected.map((light) => ({ id: light.id, patch: { mediaUrl: null, mediaKind: null } })));
    const cuesUpdated = await scenes.clearMedia(assetUrl);
    await unlink(join(config.mediaDirectory, id));
    await history.record({ action: 'Media delete', summary: 'Deleted media ' + id, fixtureIds: affected.map((light) => light.id), detail: cuesUpdated ? 'Cleared from ' + cuesUpdated + ' cue(s)' : undefined });
    return reply.status(204).send();
  });

  app.get<{ Params: { assetId: string } }>('/media/:assetId', async (request, reply) => {
    const id = request.params.assetId;
    const extension = extname(id).toLowerCase();
    if (!/^[0-9a-f-]{36}\.(jpg|png|webp|gif|mp4|webm)$/i.test(id) || !MEDIA_CONTENT_TYPES[extension]) {
      throw new ApiError(404, 'media_not_found', 'The requested media file does not exist.');
    }
    let info;
    try { info = await stat(join(config.mediaDirectory, id)); } catch {
      throw new ApiError(404, 'media_not_found', 'The requested media file does not exist.');
    }
    const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    const mediaStream = (start?: number, end?: number) => {
      const stream = createReadStream(join(config.mediaDirectory, id), { ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) });
      stream.on('data', (chunk: Buffer) => metrics.recordResponse(chunk.length));
      return stream;
    };
    if (range && (range[1] || range[2])) {
      const suffix = Number(range[2]);
      const start = range[1] ? Number(range[1]) : Math.max(0, info.size - suffix);
      const end = Math.min(info.size - 1, range[2] ? Number(range[2]) : info.size - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !range[1] && suffix <= 0 || start >= info.size || start > end) {
        return reply.status(416).header('Content-Range', 'bytes */' + info.size).send();
      }
      return reply.status(206).header('Accept-Ranges', 'bytes').header('Content-Range', 'bytes ' + start + '-' + end + '/' + info.size)
        .header('Content-Length', String(end - start + 1)).header('Cache-Control', 'public, max-age=31536000, immutable')
        .header('X-Content-Type-Options', 'nosniff').type(MEDIA_CONTENT_TYPES[extension]).send(mediaStream(start, end));
    }
    return reply.header('Accept-Ranges', 'bytes').header('Content-Length', String(info.size))
      .header('Cache-Control', 'public, max-age=31536000, immutable').header('X-Content-Type-Options', 'nosniff')
      .type(MEDIA_CONTENT_TYPES[extension]).send(mediaStream());
  });

  app.get('/api/v1/guest-registration', async () => ({
    enabled: settings.getPublicSettings().guestRegistrationEnabled,
  }));

  app.get('/api/v1/guest-registration/qr', async (request, reply) => {
    requireControllerAccess(request);
    if (!settings.getPublicSettings().guestRegistrationEnabled) {
      throw new ApiError(409, 'guest_registration_disabled', 'Enable guest registration before sharing a QR code.');
    }
    const svg = await QRCode.toString(guestJoinUrl(request), { type: 'svg', width: 360, margin: 1 });
    return reply.header('Cache-Control', 'no-store').type('image/svg+xml').send(svg);
  });

  app.post<{ Body: unknown }>('/api/v1/guest-registration', async (request, reply) => {
    if (!settings.getPublicSettings().guestRegistrationEnabled) {
      throw new ApiError(403, 'guest_registration_disabled', 'Guest registration is not currently enabled.');
    }
    const body = asRecord(request.body, 'The request body');
    rejectKeys(body, ['name']);
    noteGuestRegistration(request);
    const displayName = validateName(body.name);
    const light = await store.create({
      id: 'guest-' + randomUUID().slice(0, 8),
      name: displayName + "'s light",
      kind: 'display',
      guest: { displayName, registeredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() },
    });
    await history.record({ action: 'Guest join', summary: displayName + ' registered a light', fixtureIds: [light.id] });
    await applyActiveScalableCue();
    return reply.status(201).send({ light: (await store.get(light.id)) ?? light, displayPath: displayPath(light.id) });
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
      await history.record({ action: 'Fixture create', summary: 'Connected WLED ' + light.name, fixtureIds: [light.id] });
      await applyActiveScalableCue();
      return reply.status(201).send({ light: (await store.get(light.id)) ?? light });
    }
    const light = await store.create(input);
    await history.record({ action: 'Fixture create', summary: 'Created ' + light.name, fixtureIds: [light.id] });
    await applyActiveScalableCue();
    return reply.status(201).send({ light: (await store.get(light.id)) ?? light, displayPath: displayPath(light.id) });
  });

  app.get<{ Params: { lightId: string } }>('/api/v1/lights/:lightId', async (request) => {
    const id = validateLightId(request.params.lightId);
    const light = await store.get(id);
    if (!light) throw new ApiError(404, 'light_not_found', `No light exists with ID "${id}".`);
    if (light.kind === 'wled') requireControllerAccess(request);
    if (light.guest) return (await store.touchGuest(id)) ?? light;
    return light;
  });

  app.patch<{ Params: { lightId: string }; Body: unknown }>('/api/v1/lights/:lightId', async (request) => {
    requireControllerAccess(request);
    const id = validateLightId(request.params.lightId);
    const light = (await updateLights([{ id, patch: validateLightPatch(request.body) }]))[0];
    if (!light) throw new ApiError(404, 'light_not_found', `No light exists with ID "${id}".`);
    await history.record({ action: 'Programmer update', summary: 'Updated ' + light.name, fixtureIds: [id] });
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
    await history.record({ action: 'Batch programmer', summary: 'Updated ' + lights.length + ' fixture' + (lights.length === 1 ? '' : 's'), fixtureIds: targetIds, detail: Object.keys(input.state).filter((key) => key !== 'expectedRevision').join(', ') });
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
    await history.record({ action: 'Chase', summary: 'Programmed chase across ' + lights.length + ' fixtures', fixtureIds: targetIds });
    return { lights, count: lights.length };
  });

  app.get('/api/v1/scenes', async (request) => {
    requireControllerAccess(request);
    return { scenes: await scenes.list() };
  });

  app.post<{ Body: unknown }>('/api/v1/scenes', async (request, reply) => {
    requireControllerAccess(request);
    const scene = await scenes.create(validateCreateScene(request.body));
    await history.record({ action: 'Cue record', summary: 'Recorded Cue ' + scene.id + ' · ' + scene.name, fixtureIds: scene.ids === 'all' ? (await store.list()).map((light) => light.id) : scene.ids });
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
    const lights = await updateLights(targetIds.map((lightId, index) => ({
      id: lightId,
      patch: { ...scene.state, ...(scene.scaleEffect ? { phaseOffset: index / Math.max(1, targetIds.length) } : {}) },
    })));
    activeScalableCueId = scene.ids === 'all' && scene.scaleEffect ? scene.id : null;
    await scenes.setActiveScalableCue(activeScalableCueId ?? undefined);
    await history.record({ action: 'Cue GO', summary: 'Ran Cue ' + scene.id + ' · ' + scene.name, fixtureIds: targetIds });
    return { scene, lights, count: lights.length };
  });

  app.delete<{ Params: { sceneId: string } }>('/api/v1/scenes/:sceneId', async (request, reply) => {
    requireControllerAccess(request);
    const id = validateSceneId(request.params.sceneId);
    const scene = await scenes.remove(id);
    if (!scene) {
      throw new ApiError(404, 'cue_not_found', 'No cue exists with number "' + id + '".');
    }
    if (activeScalableCueId === scene.id) activeScalableCueId = null;
    await history.record({ action: 'Cue delete', summary: 'Deleted Cue ' + scene.id, fixtureIds: scene.ids === 'all' ? [] : scene.ids });
    return reply.status(204).send();
  });

  app.delete<{ Params: { lightId: string } }>('/api/v1/lights/:lightId', async (request, reply) => {
    requireControllerAccess(request);
    const id = validateLightId(request.params.lightId);
    const light = await store.remove(id);
    if (!light) throw new ApiError(404, 'light_not_found', `No light exists with ID "${id}".`);
    await scenes.removeFixture(id);
    await applyActiveScalableCue();
    await history.record({ action: 'Fixture delete', summary: 'Deleted ' + light.name, fixtureIds: [id] });
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
    let guestConnection = false;
    metrics.websocketOpened();
    const cleanup = () => {
      if (closed) return;
      closed = true;
      metrics.websocketClosed();
      if (guestConnection) {
        const remaining = Math.max(0, (guestConnections.get(lightId) ?? 1) - 1);
        if (remaining === 0) guestConnections.delete(lightId);
        else guestConnections.set(lightId, remaining);
        void store.touchGuest(lightId, Date.now(), true).catch((error: unknown) => app.log.error(error, 'Unable to persist guest last-seen time.'));
        guestConnection = false;
      }
      unsubscribe?.();
      unsubscribe = undefined;
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    const send = (message: string) => {
      if (!closed && socket.readyState === 1) {
        socket.send(message);
        const size = Buffer.byteLength(message);
        metrics.recordResponse(size);
        if (guestConnection) guestOutboundWebsocketBytes += size;
      }
    };

    void store
      .get(lightId)
      .then(async (light) => {
        if (closed) return;
        if (!light) {
          socket.close(1008, 'The requested light does not exist.');
          return;
        }
        if (light.kind !== 'display') {
          socket.close(1008, 'The requested fixture is not a web display.');
          return;
        }
        if (light.guest) {
          guestConnection = true;
          guestConnections.set(lightId, (guestConnections.get(lightId) ?? 0) + 1);
          light = (await store.touchGuest(lightId)) ?? light;
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

  guestExpiryTimer = setInterval(() => {
    void expireInactiveGuests().catch((error: unknown) => app.log.error(error, 'Unable to expire inactive guest lights.'));
  }, 60_000);
  guestExpiryTimer.unref();
  void expireInactiveGuests().catch((error: unknown) => app.log.error(error, 'Unable to expire inactive guest lights.'));

  return app;
}
