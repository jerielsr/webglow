import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import QRCode from 'qrcode';

import { CommandHistoryStore, HISTORY_RETENTIONS, type HistoryFixtureState, type HistoryRetention } from './command-history-store.js';
import { CloudflaredTunnel } from './cloudflared-tunnel.js';
import { getConfig, type WebglowConfig } from './config.js';
import { DmxProfileStore, UdmxOutput, validateDmxFixtureConfig, validateDmxFixtureProfile, validateDmxPatch } from './dmx.js';
import { ApiError } from './errors.js';
import { LightStore } from './light-store.js';
import { Metrics } from './metrics.js';
import { PortalAuth } from './portal-auth.js';
import { SceneStore } from './scene-store.js';
import { SettingsStore } from './settings-store.js';
import { SHOWFILE_FORMAT, SHOWFILE_MAX_MEDIA_BYTES, mediaContentType, validateShowfile } from './showfile.js';
import { TimecodeStore } from './timecode-store.js';
import { DEFAULT_LIGHT_STATE, PATTERNS, type LightPatch, type LightResource } from './types.js';
import { WledClient } from './wled-client.js';
import {
  validateBatchLightPatch,
  validateChase,
  validateCreateScene,
  validateCueStackId,
  validateCreateLight,
  validateLightId,
  validateLightPatch,
  validateName,
  validateSceneId,
  validateTimecodeProgram,
  validateUpdateScene,
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
  timecodeStore?: TimecodeStore;
  historyStore?: CommandHistoryStore;
  wledClient?: WledClient;
  dmxProfileStore?: DmxProfileStore;
  dmxOutput?: UdmxOutput;
}

function mergeConfig(overrides: Partial<WebglowConfig> = {}): WebglowConfig {
  const config = { ...getConfig(), ...overrides };
  if (overrides.dataFile && !overrides.settingsFile) {
    config.settingsFile = join(dirname(overrides.dataFile), 'settings.json');
  }
  if (overrides.dataFile && !overrides.scenesFile) {
    config.scenesFile = join(dirname(overrides.dataFile), 'scenes.json');
  }
  if (overrides.dataFile && !overrides.dmxProfilesFile) {
    config.dmxProfilesFile = join(dirname(overrides.dataFile), 'dmx-profiles.json');
  }
  if (overrides.dataFile && !overrides.timecodeFile) config.timecodeFile = join(dirname(overrides.dataFile), 'timecode.json');
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
  if (!light.guest?.sessionTokenHash) return JSON.stringify({ type, light });
  const { sessionTokenHash: _sessionTokenHash, ...guest } = light.guest;
  return JSON.stringify({ type, light: { ...light, guest } });
}

function guestSessionHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function guestHasSession(light: LightResource, token: string): boolean {
  const savedHash = light.guest?.sessionTokenHash;
  if (!savedHash || !/^[a-f0-9]{64}$/i.test(token)) return false;
  const candidate = Buffer.from(guestSessionHash(token), 'hex');
  const expected = Buffer.from(savedHash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function publicGuestLight(light: LightResource): LightResource {
  if (!light.guest?.sessionTokenHash) return light;
  const { sessionTokenHash: _sessionTokenHash, ...guest } = light.guest;
  return { ...light, guest };
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
  const timecode = options.timecodeStore ?? new TimecodeStore(config.timecodeFile);
  const history = options.historyStore ?? new CommandHistoryStore(config.historyFile);
  const wled = options.wledClient ?? new WledClient();
  const dmxProfiles = options.dmxProfileStore ?? new DmxProfileStore(config.dmxProfilesFile);
  const dmxOutput = options.dmxOutput ?? new UdmxOutput();
  await Promise.all([store.initialize(), settings.initialize(), scenes.initialize(), timecode.initialize(), dmxProfiles.initialize()]);
  await history.initialize(settings.getPublicSettings().historyRetention);
  await mkdir(config.mediaDirectory, { recursive: true });
  const portalAuth = new PortalAuth(settings, config.passwordResetToken);
  const cloudflared = new CloudflaredTunnel(settings, config.port);
  const metrics = new Metrics();
  const guestConnections = new Map<string, number>();
  const guestRegistrationAttempts = new Map<string, { count: number; resetAt: number }>();
  let lastDmxOutputWarning: string | undefined;
  let guestOutboundWebsocketBytes = 0;
  let guestExpiryTimer: NodeJS.Timeout | undefined;
  let activeScalableCueId: string | null = scenes.getActiveScalableCue() ?? null;
  let historyBaseline = new Map((await store.list()).map((light) => [light.id, historyLightState(light)]));
  const undoTransitions: Array<{ beforeState: HistoryFixtureState[]; afterState: HistoryFixtureState[] }> = [];
  const redoTransitions: Array<{ beforeState: HistoryFixtureState[]; afterState: HistoryFixtureState[] }> = [];

  const app = Fastify({ logger: options.logger ?? true, trustProxy: true });

  function logOptionalDmxFailure(error: unknown, context: string): string {
    const message = error instanceof Error ? error.message : 'The DMX output could not be refreshed.';
    if (message !== lastDmxOutputWarning) app.log.warn({ err: error }, context);
    lastDmxOutputWarning = message;
    return message;
  }

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

  function historyLightState(light: LightResource): HistoryFixtureState {
    return {
      id: light.id,
      state: {
        on: light.state.on,
        brightness: light.state.brightness,
        color: light.state.color,
        ...(light.state.colors ? { colors: [...light.state.colors] } : {}),
        ...(light.state.colorTransition ? { colorTransition: light.state.colorTransition } : {}),
        ...(light.state.colorTransitions ? { colorTransitions: [...light.state.colorTransitions] } : {}),
        ...(light.state.colorStepMs === undefined ? {} : { colorStepMs: light.state.colorStepMs }),
        pattern: light.state.pattern,
        speed: light.state.speed,
        fadeMs: light.state.fadeMs,
        phaseOffset: light.state.phaseOffset,
        mediaUrl: light.state.mediaUrl ?? null,
        mediaKind: light.state.mediaKind ?? null,
        mediaOpacity: light.state.mediaOpacity ?? 100,
        layers: light.state.layers?.map((layer) => ({ ...layer })) ?? [],
      },
    };
  }

  async function captureHistoryStates(ids: string[]): Promise<HistoryFixtureState[]> {
    const requested = new Set(ids);
    return (await store.list()).filter((light) => requested.has(light.id)).map(historyLightState);
  }

  async function recordHistory(input: { action: string; summary: string; fixtureIds: string[]; detail?: string }): Promise<void> {
    const fixtureIds = [...new Set(input.fixtureIds)];
    const beforeState = fixtureIds.flatMap((id) => historyBaseline.has(id) ? [historyBaseline.get(id)!] : []);
    const afterState = await captureHistoryStates(fixtureIds);
    const undoable = ['Programmer update', 'Batch programmer', 'Chase', 'Cue GO'].includes(input.action) &&
      beforeState.length > 0 && beforeState.length === afterState.length;
    await history.record({
      ...input,
      fixtureIds,
      ...(undoable ? { beforeState, checkpoint: afterState } : {}),
    });
    if (undoable) {
      undoTransitions.push({ beforeState, afterState });
      redoTransitions.length = 0;
    }
    const afterById = new Map(afterState.map((state) => [state.id, state]));
    fixtureIds.forEach((id) => {
      const current = afterById.get(id);
      if (current) historyBaseline.set(id, current);
      else historyBaseline.delete(id);
    });
  }

  async function applyHistoryStates(states: HistoryFixtureState[]): Promise<LightResource[]> {
    const available = await Promise.all(states.map((state) => store.get(state.id)));
    const updates = states.flatMap((state, index) => available[index] ? [{ id: state.id, patch: state.state }] : []);
    if (!updates.length) throw new ApiError(409, 'history_state_unavailable', 'The fixtures from this history point are no longer available.');
    const changed = await updateLights(updates);
    const updatedById = new Map(changed.map((light) => [light.id, historyLightState(light)]));
    states.forEach((state) => {
      const current = updatedById.get(state.id);
      if (current) historyBaseline.set(state.id, current);
    });
    return changed;
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

  function publicBaseUrl(request: FastifyRequest): string {
    const configured = settings.getPublicSettings().publicBaseUrl ?? config.publicBaseUrl;
    let base = configured;
    if (base && config.httpsEnabled) {
      const url = new URL(base);
      if (url.protocol === 'http:') {
        const oldPort = url.port;
        url.protocol = 'https:';
        if (!oldPort || oldPort === String(config.port) || oldPort === '80') {
          url.port = config.httpsPublicPort === 443 ? '' : String(config.httpsPublicPort);
        }
        base = url.toString().replace(/\/$/, '');
      }
    }
    if (!base) {
      const url = new URL((config.httpsEnabled ? 'https://' : request.protocol + '://') + (request.headers.host ?? 'localhost'));
      if (config.httpsEnabled) url.port = config.httpsPublicPort === 443 ? '' : String(config.httpsPublicPort);
      base = url.origin;
    }
    return base.replace(/\/$/, '');
  }

  function guestJoinUrl(request: FastifyRequest): string {
    const base = publicBaseUrl(request);
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
    const retentionHours = Math.max(options.guestInactivityHours, options.guestRememberHours);
    const cutoff = Date.now() - retentionHours * 60 * 60_000;
    const guests = (await store.list()).filter((light) => light.guest);
    const expired = guests.filter((light) => {
      if ((guestConnections.get(light.id) ?? 0) > 0) return false;
      const lastSeen = Date.parse(light.guest?.lastSeenAt ?? light.guest?.registeredAt ?? '');
      return Number.isFinite(lastSeen) && lastSeen < cutoff;
    });
    await Promise.all(expired.map(async (light) => {
      await store.remove(light.id);
      await scenes.removeFixture(light.id);
      await recordHistory({ action: 'Guest expiry', summary: 'Removed inactive guest ' + (light.guest?.displayName ?? light.name), fixtureIds: [light.id] });
    }));
    if (expired.length) await applyActiveScalableCue();
    return expired.length;
  }

  function hasOutputPatch(patch: LightPatch): boolean {
    return (
      patch.on !== undefined ||
      patch.brightness !== undefined ||
      patch.color !== undefined ||
      patch.colors !== undefined ||
      patch.colorTransition !== undefined ||
      patch.colorTransitions !== undefined ||
      patch.colorStepMs !== undefined ||
      patch.pattern !== undefined ||
      patch.speed !== undefined ||
      patch.fadeMs !== undefined ||
      patch.phaseOffset !== undefined ||
      patch.mediaUrl !== undefined ||
      patch.mediaKind !== undefined ||
      patch.mediaOpacity !== undefined ||
      patch.layers !== undefined
    );
  }

  function hasDmxOutputPatch(patch: LightPatch): boolean {
    return patch.on !== undefined || patch.brightness !== undefined || patch.color !== undefined ||
      patch.colors !== undefined || patch.colorTransitions !== undefined || patch.colorStepMs !== undefined ||
      patch.pattern !== undefined || patch.speed !== undefined;
  }

  function effectClockChanges(light: LightResource, patch: LightPatch): boolean {
    const current = light.state;
    return (patch.pattern !== undefined && patch.pattern !== current.pattern) ||
      (patch.colors !== undefined && JSON.stringify(patch.colors) !== JSON.stringify(current.colors)) ||
      (patch.colorTransition !== undefined && patch.colorTransition !== current.colorTransition) ||
      (patch.colorTransitions !== undefined && JSON.stringify(patch.colorTransitions) !== JSON.stringify(current.colorTransitions)) ||
      (patch.colorStepMs !== undefined && patch.colorStepMs !== current.colorStepMs) ||
      (patch.speed !== undefined && patch.speed !== current.speed) ||
      (patch.phaseOffset !== undefined && patch.phaseOffset !== current.phaseOffset) ||
      (patch.layers !== undefined && JSON.stringify(patch.layers) !== JSON.stringify(current.layers));
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
        ...(patch.colors === undefined ? {} : { colors: [...patch.colors] }),
        ...(patch.colorTransition === undefined ? {} : { colorTransition: patch.colorTransition }),
        ...(patch.colorTransitions === undefined ? {} : { colorTransitions: [...patch.colorTransitions] }),
        ...(patch.colorStepMs === undefined ? {} : { colorStepMs: patch.colorStepMs }),
        ...(patch.pattern === undefined ? {} : { pattern: patch.pattern }),
        ...(patch.speed === undefined ? {} : { speed: patch.speed }),
        ...(patch.fadeMs === undefined ? {} : { fadeMs: patch.fadeMs }),
        ...(patch.phaseOffset === undefined ? {} : { phaseOffset: patch.phaseOffset }),
        ...(patch.mediaUrl === undefined ? {} : { mediaUrl: patch.mediaUrl || undefined }),
        ...(patch.mediaKind === undefined ? {} : { mediaKind: patch.mediaKind || undefined }),
        ...(patch.mediaOpacity === undefined ? {} : { mediaOpacity: patch.mediaOpacity }),
        ...(patch.layers === undefined ? {} : { layers: patch.layers ? patch.layers.map((layer) => ({ ...layer })) : [] }),
      },
    };
  }

  /**
   * WLED is driven before its persisted state changes. uDMX is deliberately
   * fail-soft: it is optional hardware, so state and browser lights still
   * update when no adapter is attached; its output error stays in DMX status.
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

    const dmxUpdates = updates.some((update, index) => existing[index].kind === 'dmx' && hasDmxOutputPatch(update.patch));
    if (dmxUpdates) {
      const allLights = await store.list();
      const previewById = new Map(updates.map((update, index) => {
        const preview = previewLight(existing[index], update.patch);
        if (effectClockChanges(existing[index], update.patch)) preview.state.patternStartedAt = synchronizedAt;
        return [update.id, preview] as const;
      }));
      try {
        await dmxOutput.apply(allLights.map((light) => previewById.get(light.id) ?? light), dmxProfiles.list());
        lastDmxOutputWarning = undefined;
      } catch (error) {
        // DMX is an optional output. Keep the logical programmer and browser
        // fixtures usable even when no adapter is connected or it is busy.
        logOptionalDmxFailure(error, 'Optional uDMX output failed; WebGlow state was still applied.');
      }
    }

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
    const ordered = await arrangeFixtureIds(lights.map((light) => light.id), scene.effectDirection ?? 'forward');
    await updateLights(ordered.map((id, index) => ({
      id,
      patch: { ...scene.state, phaseOffset: index / count },
    })));
  }

  async function arrangeFixtureIds(ids: string[], direction: 'forward' | 'reverse' | 'front-to-back' | 'back-to-front' | 'diagonal-left' | 'diagonal-right' | 'center-out' | 'edges-in' | 'random' = 'forward'): Promise<string[]> {
    const lights = await store.list();
    const byId = new Map(lights.map((light) => [light.id, light]));
    const publicSettings = settings.getPublicSettings();
    const sections = [...publicSettings.seatSections];
    const subsectionCount = publicSettings.virtualSubsectionsEnabled ? publicSettings.virtualSubsectionsCount : 1;
    const virtualSections = sections.flatMap((section) => Array.from({ length: subsectionCount }, (_, index) => ({
      section,
      subsection: index,
      key: `${section.toLocaleLowerCase()}\u0000${index}`,
    })));
    const orderedVirtualSections = [...virtualSections];
    if (direction === 'diagonal-left' || direction === 'diagonal-right') {
      const evenSections = orderedVirtualSections.filter((_, index) => index % 2 === 0);
      const oddSections = orderedVirtualSections.filter((_, index) => index % 2 === 1);
      orderedVirtualSections.splice(0, orderedVirtualSections.length, ...evenSections, ...oddSections);
      if (direction === 'diagonal-right') orderedVirtualSections.reverse();
    }
    if (direction === 'center-out' || direction === 'edges-in') {
      const center = (orderedVirtualSections.length - 1) / 2;
      orderedVirtualSections.sort((left, right) => {
        const leftDistance = Math.abs(virtualSections.findIndex((item) => item.key === left.key) - center);
        const rightDistance = Math.abs(virtualSections.findIndex((item) => item.key === right.key) - center);
        return direction === 'center-out' ? leftDistance - rightDistance : rightDistance - leftDistance;
      });
    }
    const sectionOrder = new Map(orderedVirtualSections.map((item, index) => [item.key, index]));
    const guestRanks = new Map<string, number>();
    if (subsectionCount > 1) {
      const guestsBySection = new Map<string, LightResource[]>();
      for (const light of lights) {
        const sectionKey = light.guest?.section?.toLocaleLowerCase();
        if (!sectionKey) continue;
        const members = guestsBySection.get(sectionKey) ?? [];
        members.push(light);
        guestsBySection.set(sectionKey, members);
      }
      for (const members of guestsBySection.values()) {
        members.sort((left, right) => (left.guest?.registeredAt ?? '').localeCompare(right.guest?.registeredAt ?? '') || (left.fixtureNumber ?? Number.MAX_SAFE_INTEGER) - (right.fixtureNumber ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id, undefined, { numeric: true }));
        members.forEach((light, index) => guestRanks.set(light.id, index));
      }
    }
    const customOrder = new Map(publicSettings.fixtureOrder.map((id, index) => [id, index]));
    const ordered = [...ids].sort((leftId, rightId) => {
      const left = byId.get(leftId);
      const right = byId.get(rightId);
      const leftSection = left?.guest?.section?.toLocaleLowerCase();
      const rightSection = right?.guest?.section?.toLocaleLowerCase();
      const leftGuestRank = guestRanks.get(leftId);
      const rightGuestRank = guestRanks.get(rightId);
      const leftSubsection = leftGuestRank === undefined ? 0 : leftGuestRank % subsectionCount;
      const rightSubsection = rightGuestRank === undefined ? 0 : rightGuestRank % subsectionCount;
      const leftKey = leftSection === undefined ? undefined : `${leftSection}\u0000${leftSubsection}`;
      const rightKey = rightSection === undefined ? undefined : `${rightSection}\u0000${rightSubsection}`;
      const leftRank = leftKey === undefined ? Number.MAX_SAFE_INTEGER : sectionOrder.get(leftKey) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rightKey === undefined ? Number.MAX_SAFE_INTEGER : sectionOrder.get(rightKey) ?? Number.MAX_SAFE_INTEGER;
      const sectionDifference = leftRank - rightRank;
      if (sectionDifference) return sectionDifference;
      if (subsectionCount > 1 && leftGuestRank !== undefined && rightGuestRank !== undefined && leftGuestRank !== rightGuestRank) {
        return Math.floor(leftGuestRank / subsectionCount) - Math.floor(rightGuestRank / subsectionCount);
      }
      if (publicSettings.fixtureSortMode === 'custom') {
        const leftCustomRank = customOrder.get(leftId) ?? Number.MAX_SAFE_INTEGER;
        const rightCustomRank = customOrder.get(rightId) ?? Number.MAX_SAFE_INTEGER;
        if (leftCustomRank !== rightCustomRank) return leftCustomRank - rightCustomRank;
      }
      return (left?.fixtureNumber ?? Number.MAX_SAFE_INTEGER) - (right?.fixtureNumber ?? Number.MAX_SAFE_INTEGER) || leftId.localeCompare(rightId, undefined, { numeric: true, sensitivity: 'base' });
    });
    if (direction === 'reverse' || direction === 'back-to-front') ordered.reverse();
    if (direction === 'random') {
      for (let index = ordered.length - 1; index > 0; index -= 1) {
        const other = randomInt(index + 1);
        [ordered[index], ordered[other]] = [ordered[other], ordered[index]];
      }
    }
    return ordered;
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
    await cloudflared.stop();
    await Promise.all([store.close(), settings.close(), scenes.close(), history.close(), timecode.close(), dmxOutput.close()]);
  });
  app.addHook('onListen', async () => cloudflared.autoStart());

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
  app.get('/playback', async (_request, reply) => reply.type('text/html; charset=utf-8').sendFile('app.html'));
  app.get('/monitor', async (_request, reply) => reply.type('text/html; charset=utf-8').sendFile('app.html'));
  app.get('/timelines', async (_request, reply) => reply.type('text/html; charset=utf-8').sendFile('app.html'));
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
      effectDirections: ['forward', 'reverse', 'front-to-back', 'back-to-front', 'diagonal-left', 'diagonal-right', 'center-out', 'edges-in', 'random'],
      fixtureKinds: ['display', 'wled', 'dmx'],
      dmx: { adapter: 'uDMX USB', universeChannels: 512, fixtureProfiles: '/api/v1/dmx/profiles', patchAddresses: '1-512' },
      media: ['jpeg', 'png', 'webp', 'gif', 'mp4', 'webm'],
      commandHistory: [...HISTORY_RETENTIONS],
      scalableCueEffects: true,
      timecodeRates: ['23.976', '24', '25', '29.97df', '30'],
      timecodeInput: 'microphone LTC',
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
    const publicSettings = settings.getPublicSettings();
    let localCaFingerprint: string | undefined;
    if (config.httpsEnabled && !config.tlsCertFile) {
      try {
        const ca = await readFile(join(dirname(config.dataFile), 'tls', 'ca.crt'));
        localCaFingerprint = new X509Certificate(ca).fingerprint256;
      } catch {
        localCaFingerprint = undefined;
      }
    }
    return {
      ...publicSettings,
      publicBaseUrl: publicBaseUrl(request),
      controllerBearerTokenConfigured: Boolean(config.apiToken),
      passwordResetConfigured: portalAuth.passwordResetConfigured(),
      server: {
        port: config.port,
        https: {
          enabled: config.httpsEnabled,
          port: config.httpsPort,
          publicPort: config.httpsPublicPort,
          certificateMode: !config.httpsEnabled ? 'disabled' : config.tlsCertFile ? 'custom' : 'local-ca',
          configuredHosts: config.tlsHosts,
          ...(localCaFingerprint ? { localCaFingerprint } : {}),
        },
        corsOrigin: config.corsOrigin,
        persistence: 'DATA_DIR',
      },
    };
  });

  app.get('/api/v1/https/ca', async (request, reply) => {
    requireControllerAccess(request);
    if (!config.httpsEnabled || config.tlsCertFile) {
      throw new ApiError(404, 'https_ca_unavailable', 'A WebGlow-generated HTTPS certificate authority is not available.');
    }
    const caFile = join(dirname(config.dataFile), 'tls', 'ca.crt');
    let certificate: Buffer;
    try {
      certificate = await readFile(caFile);
    } catch {
      throw new ApiError(503, 'https_ca_unavailable', 'The HTTPS certificate authority has not been generated yet.');
    }
    return reply.header('Content-Disposition', 'attachment; filename="webglow-local-ca.crt"')
      .type('application/x-pem-file').send(certificate);
  });

  app.get('/api/v1/tunnel', async (request) => {
    requireControllerAccess(request);
    return cloudflared.status();
  });

  app.patch<{ Body: unknown }>('/api/v1/tunnel', async (request) => {
    requireControllerAccess(request);
    const body = asRecord(request.body, 'The request body');
    rejectKeys(body, ['token', 'clearToken', 'hostname', 'autoStart']);
    if (!Object.keys(body).length) throw new ApiError(400, 'invalid_request', 'Provide a tunnel setting to update.');
    if (body.token !== undefined && (typeof body.token !== 'string' || body.token.trim().length < 20 || body.token.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(body.token))) {
      throw new ApiError(400, 'invalid_request', 'token must be a Cloudflare Tunnel token between 20 and 4096 characters.', { field: 'token' });
    }
    if (body.clearToken !== undefined && typeof body.clearToken !== 'boolean') {
      throw new ApiError(400, 'invalid_request', 'clearToken must be true or false.', { field: 'clearToken' });
    }
    if (body.clearToken === true && body.token !== undefined) {
      throw new ApiError(400, 'invalid_request', 'Set a new token or clear the saved token, not both.');
    }
    if (body.autoStart !== undefined && typeof body.autoStart !== 'boolean') {
      throw new ApiError(400, 'invalid_request', 'autoStart must be true or false.', { field: 'autoStart' });
    }
    let hostname: string | undefined;
    if (body.hostname !== undefined) {
      if (typeof body.hostname !== 'string' || body.hostname.length > 253) {
        throw new ApiError(400, 'invalid_request', 'hostname must be a domain name without a scheme or port.', { field: 'hostname' });
      }
      hostname = body.hostname.trim().toLocaleLowerCase();
      if (hostname && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname)) {
        throw new ApiError(400, 'invalid_request', 'hostname must be a domain name without a scheme or port.', { field: 'hostname' });
      }
    }
    await settings.updateCloudflaredSettings({
      ...(body.token === undefined ? {} : { token: (body.token as string).trim() }),
      ...(body.clearToken === undefined ? {} : { clearToken: body.clearToken as boolean }),
      ...(body.hostname === undefined ? {} : { hostname }),
      ...(body.autoStart === undefined ? {} : { autoStart: body.autoStart as boolean }),
    });
    if (body.clearToken === true) await cloudflared.stop();
    return cloudflared.status();
  });

  app.post('/api/v1/tunnel/start', async (request) => {
    requireControllerAccess(request);
    return cloudflared.start();
  });

  app.post('/api/v1/tunnel/stop', async (request) => {
    requireControllerAccess(request);
    return cloudflared.stop();
  });

  app.patch<{ Body: unknown }>('/api/v1/settings', async (request) => {
    requireControllerAccess(request);
    const previousRetention = settings.getPublicSettings().historyRetention;
    const body = asRecord(request.body, 'The request body');
    rejectKeys(body, ['publicBaseUrl', 'guestRegistrationEnabled', 'historyRetention', 'guestAutoRemoveEnabled', 'guestInactivityHours', 'guestRememberHours', 'autoRefreshDevices', 'seatSections', 'virtualSubsectionsEnabled', 'virtualSubsectionsCount', 'fixtureSortMode', 'fixtureOrder']);
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
    if (body.guestRememberHours !== undefined && ![1, 6, 12, 24, 72, 168, 336].includes(body.guestRememberHours as number)) {
      throw new ApiError(400, 'invalid_request', 'guestRememberHours must be 1, 6, 12, 24, 72, 168, or 336.', { field: 'guestRememberHours' });
    }
    if (body.autoRefreshDevices !== undefined && typeof body.autoRefreshDevices !== 'boolean') {
      throw new ApiError(400, 'invalid_request', 'autoRefreshDevices must be true or false.', { field: 'autoRefreshDevices' });
    }
    if (body.virtualSubsectionsEnabled !== undefined && typeof body.virtualSubsectionsEnabled !== 'boolean') {
      throw new ApiError(400, 'invalid_request', 'virtualSubsectionsEnabled must be true or false.', { field: 'virtualSubsectionsEnabled' });
    }
    if (body.virtualSubsectionsCount !== undefined && (!Number.isInteger(body.virtualSubsectionsCount) || (body.virtualSubsectionsCount as number) < 2 || (body.virtualSubsectionsCount as number) > 12)) {
      throw new ApiError(400, 'invalid_request', 'virtualSubsectionsCount must be an integer from 2 to 12.', { field: 'virtualSubsectionsCount' });
    }
    let seatSections: string[] | undefined;
    if (body.seatSections !== undefined) {
      if (!Array.isArray(body.seatSections) || body.seatSections.length < 1 || body.seatSections.length > 12 || !body.seatSections.every((item) => typeof item === 'string')) {
        throw new ApiError(400, 'invalid_request', 'seatSections must contain between 1 and 12 section names.', { field: 'seatSections' });
      }
      seatSections = body.seatSections.map((name) => name.trim());
      if (seatSections.some((name) => name.length < 1 || name.length > 80) || new Set(seatSections.map((name) => name.toLocaleLowerCase())).size !== seatSections.length) {
        throw new ApiError(400, 'invalid_request', 'Section names must be unique and between 1 and 80 characters.', { field: 'seatSections' });
      }
    }
    if (body.fixtureSortMode !== undefined && !['id', 'seat', 'custom'].includes(body.fixtureSortMode as string)) {
      throw new ApiError(400, 'invalid_request', 'fixtureSortMode must be id, seat, or custom.', { field: 'fixtureSortMode' });
    }
    if (body.fixtureOrder !== undefined && (!Array.isArray(body.fixtureOrder) || body.fixtureOrder.length > 512 || !body.fixtureOrder.every((id) => typeof id === 'string' && id.length <= 64) || new Set(body.fixtureOrder as string[]).size !== body.fixtureOrder.length)) {
      throw new ApiError(400, 'invalid_request', 'fixtureOrder must be an array of fixture IDs.', { field: 'fixtureOrder' });
    }
    const updated = await settings.updatePublicSettings({
      ...(Object.hasOwn(body, 'publicBaseUrl') ? { publicBaseUrl: validatePublicBaseUrl(body.publicBaseUrl) } : {}),
      ...(Object.hasOwn(body, 'guestRegistrationEnabled') ? { guestRegistrationEnabled: body.guestRegistrationEnabled as boolean } : {}),
      ...(Object.hasOwn(body, 'historyRetention') ? { historyRetention: body.historyRetention as HistoryRetention } : {}),
      ...(Object.hasOwn(body, 'guestAutoRemoveEnabled') ? { guestAutoRemoveEnabled: body.guestAutoRemoveEnabled as boolean } : {}),
      ...(Object.hasOwn(body, 'guestInactivityHours') ? { guestInactivityHours: body.guestInactivityHours as number } : {}),
      ...(Object.hasOwn(body, 'guestRememberHours') ? { guestRememberHours: body.guestRememberHours as number } : {}),
      ...(body.autoRefreshDevices === undefined ? {} : { autoRefreshDevices: body.autoRefreshDevices as boolean }),
      ...(seatSections === undefined ? {} : { seatSections }),
      ...(body.virtualSubsectionsEnabled === undefined ? {} : { virtualSubsectionsEnabled: body.virtualSubsectionsEnabled as boolean }),
      ...(body.virtualSubsectionsCount === undefined ? {} : { virtualSubsectionsCount: body.virtualSubsectionsCount as number }),
      ...(body.fixtureSortMode === undefined ? {} : { fixtureSortMode: body.fixtureSortMode as 'id' | 'seat' | 'custom' }),
      ...(body.fixtureOrder === undefined ? {} : { fixtureOrder: body.fixtureOrder as string[] }),
    });
    if (updated.historyRetention !== previousRetention) await history.setRetention(updated.historyRetention);
    return { ...updated, publicBaseUrl: publicBaseUrl(request) };
  });

  app.get('/api/v1/metrics', async (request) => {
    requireControllerAccess(request);
    return metrics.snapshot();
  });

  app.get('/api/v1/history', async (request) => {
    requireControllerAccess(request);
    const query = new URL(request.raw.url ?? '/api/v1/history', 'http://webglow.local').searchParams;
    if (query.get('includeEvents') !== 'true') return { ...(await history.summary()), undoAvailable: undoTransitions.length > 0, redoAvailable: redoTransitions.length > 0 };
    const offset = Number(query.get('offset') ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ApiError(400, 'invalid_history_offset', 'History offset must be a non-negative integer.');
    }
    const result = await history.list(offset, 200);
    return {
      ...result,
      undoAvailable: undoTransitions.length > 0,
      redoAvailable: redoTransitions.length > 0,
      events: result.events.map(({ checkpoint, beforeState: _beforeState, ...event }) => ({ ...event, canRestore: Boolean(checkpoint?.length) })),
    };
  });

  app.post<{ Params: { eventId: string } }>('/api/v1/history/:eventId/restore', async (request) => {
    requireControllerAccess(request);
    const event = await history.get(request.params.eventId);
    if (!event?.checkpoint?.length) throw new ApiError(409, 'history_point_not_restorable', 'This history point has no saved output snapshot.');
    const beforeState = await captureHistoryStates(event.checkpoint.map((state) => state.id));
    const lights = await applyHistoryStates(event.checkpoint);
    if (beforeState.length) undoTransitions.push({ beforeState, afterState: event.checkpoint });
    redoTransitions.length = 0;
    await history.record({ action: 'History restore', summary: 'Restored output to “' + event.summary + '”', fixtureIds: event.checkpoint.map((state) => state.id) });
    return { lights, undoAvailable: undoTransitions.length > 0, redoAvailable: redoTransitions.length > 0 };
  });

  app.post('/api/v1/history/undo', async (request) => {
    requireControllerAccess(request);
    const transition = undoTransitions.pop();
    if (!transition) throw new ApiError(409, 'nothing_to_undo', 'There is no recorded output change to undo.');
    const lights = await applyHistoryStates(transition.beforeState);
    redoTransitions.push(transition);
    await history.record({ action: 'Undo', summary: 'Undid the previous output change', fixtureIds: transition.beforeState.map((state) => state.id) });
    return { lights, undoAvailable: undoTransitions.length > 0, redoAvailable: redoTransitions.length > 0 };
  });

  app.post('/api/v1/history/redo', async (request) => {
    requireControllerAccess(request);
    const transition = redoTransitions.pop();
    if (!transition) throw new ApiError(409, 'nothing_to_redo', 'There is no output change to redo.');
    const lights = await applyHistoryStates(transition.afterState);
    undoTransitions.push(transition);
    await history.record({ action: 'Redo', summary: 'Redid the previous output change', fixtureIds: transition.afterState.map((state) => state.id) });
    return { lights, undoAvailable: undoTransitions.length > 0, redoAvailable: redoTransitions.length > 0 };
  });

  app.get('/api/v1/timecode/program', async (request) => {
    requireControllerAccess(request);
    return { program: timecode.get() };
  });

  app.put<{ Body: unknown }>('/api/v1/timecode/program', async (request) => {
    requireControllerAccess(request);
    const program = validateTimecodeProgram(request.body);
    const availableCues = new Set((await scenes.list()).map((scene) => scene.id));
    const missingCueIds = [...new Set(program.sequences.flatMap((sequence) => sequence.events.map((event) => event.cueId).filter((cueId) => !availableCues.has(cueId))))];
    if (missingCueIds.length) {
      throw new ApiError(404, 'timecode_cue_not_found', 'The timecode program refers to cues that no longer exist.', { cueIds: missingCueIds });
    }
    const saved = await timecode.replace(program);
    await recordHistory({ action: 'Timecode edit', summary: 'Updated timecode timelines', fixtureIds: [] });
    return { program: saved };
  });

  app.get('/api/v1/showfile', async (request, reply) => {
    requireControllerAccess(request);
    const query = new URL(request.raw.url ?? '/api/v1/showfile', 'http://webglow.local').searchParams;
    const includeMedia = query.get('includeMedia') === 'true';
    const fixtures = (await store.list()).filter((light) => !light.guest);
    const cueScenes = await scenes.list();
    const showfile = {
      format: SHOWFILE_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      fixtures: fixtures.map(({ id, name, fixtureNumber, kind, wled, dmx, state }) => ({
        id, name, ...(fixtureNumber === undefined ? {} : { fixtureNumber }), kind,
        ...(wled ? { wled } : {}),
        ...(dmx ? { dmx } : {}),
        state: {
          on: state.on,
          brightness: state.brightness,
          color: state.color,
          ...(state.colors ? { colors: state.colors } : {}),
          ...(state.colorTransition ? { colorTransition: state.colorTransition } : {}),
          ...(state.colorTransitions ? { colorTransitions: state.colorTransitions } : {}),
          ...(state.colorStepMs === undefined ? {} : { colorStepMs: state.colorStepMs }),
          pattern: state.pattern,
          speed: state.speed,
          fadeMs: state.fadeMs,
          phaseOffset: state.phaseOffset,
          ...(state.mediaUrl ? { mediaUrl: state.mediaUrl } : {}),
          ...(state.mediaKind ? { mediaKind: state.mediaKind } : {}),
          ...(state.mediaOpacity === undefined ? {} : { mediaOpacity: state.mediaOpacity }),
          ...(state.layers?.length ? { layers: state.layers } : {}),
        },
      })),
      dmxProfiles: dmxProfiles.listCustom(),
      cues: cueScenes.map(({ id, name, stackId, ids, state, scaleEffect, effectDirection }) => ({
        id, name, stackId, ids, state,
        ...(scaleEffect === undefined ? {} : { scaleEffect }),
        ...(effectDirection === undefined ? {} : { effectDirection }),
      })),
      cueStacks: (await scenes.listStacks()).map(({ id, name, cueOrder }) => ({ id, name, cueOrder })),
      timecode: timecode.get(),
      settings: (({ seatSections, virtualSubsectionsEnabled, virtualSubsectionsCount, fixtureSortMode, fixtureOrder }) => ({
        seatSections,
        virtualSubsectionsEnabled,
        virtualSubsectionsCount,
        fixtureSortMode,
        fixtureOrder: fixtureOrder.filter((id) => fixtures.some((light) => light.id === id)),
      }))(settings.getPublicSettings()),
    };
    if (includeMedia) {
      const referencedIds = new Set<string>();
      for (const light of fixtures) {
        const id = light.state.mediaUrl?.match(/^\/media\/([0-9a-f-]{36}\.(?:jpg|png|webp|gif|mp4|webm))$/i)?.[1];
        if (id) referencedIds.add(id);
      }
      for (const scene of cueScenes) {
        const id = scene.state.mediaUrl?.match(/^\/media\/([0-9a-f-]{36}\.(?:jpg|png|webp|gif|mp4|webm))$/i)?.[1];
        if (id) referencedIds.add(id);
      }
      let bundledBytes = 0;
      const media = [] as Array<{ id: string; contentType: string; dataBase64: string }>;
      for (const id of referencedIds) {
        const contentType = mediaContentType(id);
        if (!contentType) continue;
        let info;
        try { info = await stat(join(config.mediaDirectory, id)); } catch { continue; }
        if (!info.isFile()) continue;
        bundledBytes += info.size;
        if (bundledBytes > SHOWFILE_MAX_MEDIA_BYTES) {
          throw new ApiError(413, 'showfile_media_too_large', 'Referenced media exceeds the 200 MB showfile bundle limit. Export without media or reduce the media used by this show.');
        }
        media.push({ id, contentType, dataBase64: (await readFile(join(config.mediaDirectory, id))).toString('base64') });
      }
      Object.assign(showfile, { media });
    }
    return reply.type('application/json').header('Content-Disposition', 'attachment; filename="webglow-showfile.wgshow"').send(showfile);
  });

  app.put('/api/v1/showfile', { bodyLimit: 280 * 1024 * 1024 }, async (request) => {
    requireControllerAccess(request);
    const imported = validateShowfile(request.body);
    const guestIds = new Set((await store.list()).filter((light) => light.guest).map((light) => light.id));
    if (imported.fixtures.some((light) => guestIds.has(light.id))) {
      throw new ApiError(409, 'fixture_id_conflicts_with_guest', 'A showfile fixture ID conflicts with a currently registered guest light.');
    }
    for (const asset of imported.media) {
      const destination = join(config.mediaDirectory, asset.id);
      const temporary = destination + '.' + process.pid + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, asset.bytes, { flag: 'wx' });
        await rename(temporary, destination);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    }

    const mediaEntries = await readdir(config.mediaDirectory, { withFileTypes: true });
    const availableMedia = new Set(mediaEntries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const unavailableMedia = new Set<string>();
    const resolveMediaUrl = (url: string | null | undefined): string | undefined => {
      if (!url) return undefined;
      const id = url.match(/^\/media\/([0-9a-f-]{36}\.(?:jpg|png|webp|gif|mp4|webm))$/i)?.[1];
      if (!id || !availableMedia.has(id)) {
        if (id) unavailableMedia.add(id);
        return undefined;
      }
      return '/media/' + encodeURIComponent(id);
    };
    const fixtures = imported.fixtures.map((light) => {
      const mediaUrl = resolveMediaUrl(light.state.mediaUrl);
      return {
        ...light,
        state: {
          ...light.state,
          ...(mediaUrl ? { mediaUrl } : { mediaUrl: undefined, mediaKind: undefined, mediaStartedAt: undefined }),
        },
      };
    });
    const importedScenes = imported.scenes.map((scene) => {
      const mediaUrl = resolveMediaUrl(scene.state.mediaUrl);
      return {
        ...scene,
        state: {
          ...scene.state,
          ...(mediaUrl ? { mediaUrl } : { mediaUrl: null, mediaKind: null }),
        },
      };
    });

    const previousFixtures = (await store.list()).filter((light) => !light.guest);
    const previousScenes = await scenes.list();
    const previousStacks = await scenes.listStacks();
    const previousTimecode = timecode.get();
    const previousSettings = settings.getPublicSettings();
    const previousDmxProfiles = dmxProfiles.listCustom();
    const applyImport = async (): Promise<void> => {
      const results = await Promise.allSettled([
        store.replaceConfiguredLights(fixtures),
        scenes.replaceAll(importedScenes, imported.stacks),
        timecode.replace(imported.timecode),
        settings.updatePublicSettings(imported.settings),
        dmxProfiles.replaceCustom(imported.dmxProfiles),
      ]);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    };
    try {
      await applyImport();
    } catch (error) {
      await Promise.allSettled([
        store.replaceConfiguredLights(previousFixtures),
        scenes.replaceAll(previousScenes, previousStacks),
        timecode.replace(previousTimecode),
        settings.updatePublicSettings({
          seatSections: previousSettings.seatSections,
          virtualSubsectionsEnabled: previousSettings.virtualSubsectionsEnabled,
          virtualSubsectionsCount: previousSettings.virtualSubsectionsCount,
          fixtureSortMode: previousSettings.fixtureSortMode,
          fixtureOrder: previousSettings.fixtureOrder,
        }),
        dmxProfiles.replaceCustom(previousDmxProfiles),
      ]);
      throw error;
    }

    activeScalableCueId = null;
    historyBaseline = new Map((await store.list()).map((light) => [light.id, historyLightState(light)]));
    undoTransitions.length = 0;
    redoTransitions.length = 0;
    const timestamp = Date.now();
    const wledResults = await Promise.allSettled(fixtures.filter((light) => light.kind === 'wled').map((light) => wled.apply(light, timestamp)));
    const wledFailures = wledResults.filter((result) => result.status === 'rejected').length;
    const dmxResults = await Promise.allSettled([dmxOutput.apply(fixtures, dmxProfiles.list())]);
    const dmxFailures = dmxResults.filter((result) => result.status === 'rejected').length;
    await recordHistory({ action: 'Showfile load', summary: 'Loaded showfile with ' + importedScenes.length + ' cues', fixtureIds: fixtures.map((light) => light.id) });
    return {
      loaded: true,
      fixtures: fixtures.length,
      cues: importedScenes.length,
      cueStacks: imported.stacks.length,
      timelines: imported.timecode.sequences.length,
      media: imported.media.length,
      missingMedia: unavailableMedia.size,
      wledFailures,
      dmxFailures,
    };
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
    await recordHistory({ action: 'Media upload', summary: 'Uploaded ' + upload.filename, fixtureIds: [], detail: Math.round(info.size / 1024) + ' KB' });
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
    await recordHistory({ action: 'Media delete', summary: 'Deleted media ' + id, fixtureIds: affected.map((light) => light.id), detail: cuesUpdated ? 'Cleared from ' + cuesUpdated + ' cue(s)' : undefined });
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
    seatSections: settings.getPublicSettings().seatSections,
  }));

  app.get('/api/v1/guest-registration/qr', async (request, reply) => {
    requireControllerAccess(request);
    if (!settings.getPublicSettings().guestRegistrationEnabled) {
      throw new ApiError(409, 'guest_registration_disabled', 'Enable guest registration before sharing a QR code.');
    }
    const svg = await QRCode.toString(guestJoinUrl(request), { type: 'svg', width: 360, margin: 1, color: { dark: '#000000ff', light: '#00000000' } });
    return reply.header('Cache-Control', 'no-store').type('image/svg+xml').send(svg);
  });

  app.get('/api/v1/application-url/qr', async (request, reply) => {
    requireControllerAccess(request);
    const svg = await QRCode.toString(publicBaseUrl(request), { type: 'svg', width: 480, margin: 2, color: { dark: '#000000ff', light: '#00000000' } });
    return reply.header('Cache-Control', 'no-store').header('Content-Disposition', 'inline; filename="webglow-application-url.svg"')
      .type('image/svg+xml').send(svg);
  });

  app.post<{ Body: unknown }>('/api/v1/guest-registration', async (request, reply) => {
    const body = asRecord(request.body, 'The request body');
    rejectKeys(body, ['name', 'section', 'keepAwake', 'resumeToken']);
    if (body.keepAwake !== undefined && typeof body.keepAwake !== 'boolean') {
      throw new ApiError(400, 'invalid_request', 'keepAwake must be a boolean.', { field: 'keepAwake' });
    }
    if (body.resumeToken !== undefined && (typeof body.resumeToken !== 'string' || !/^[a-f0-9]{64}$/i.test(body.resumeToken))) {
      throw new ApiError(400, 'invalid_request', 'resumeToken is invalid.', { field: 'resumeToken' });
    }

    // A returning guest can reconnect during the configured grace period even
    // if the operator has since closed registration for new devices.
    if (typeof body.resumeToken === 'string') {
      const candidate = (await store.list()).find((light) => light.guest && guestHasSession(light, body.resumeToken as string));
      if (candidate?.guest) {
        const lastSeen = Date.parse(candidate.guest.lastSeenAt ?? candidate.guest.registeredAt);
        const graceMs = settings.getPublicSettings().guestRememberHours * 60 * 60_000;
        if (Number.isFinite(lastSeen) && Date.now() - lastSeen <= graceMs) {
          const light = await store.touchGuest(candidate.id, Date.now(), true) ?? candidate;
          return reply.send({ light: publicGuestLight(light), displayPath: displayPath(light.id), resumed: true });
        }
      }
      throw new ApiError(410, 'guest_session_expired', 'This device can no longer resume its previous light. Please register again.');
    }

    if (!settings.getPublicSettings().guestRegistrationEnabled) {
      throw new ApiError(403, 'guest_registration_disabled', 'Guest registration is not currently enabled.');
    }
    noteGuestRegistration(request);
    const displayName = validateName(body.name);
    const seatSections = settings.getPublicSettings().seatSections;
    const section = typeof body.section === 'string' && seatSections.includes(body.section) ? body.section : seatSections[0];
    const guestSessionToken = randomBytes(32).toString('hex');
    const light = await store.create({
      id: 'guest-' + randomUUID().slice(0, 8),
      name: displayName,
      kind: 'display',
      guest: { displayName, registeredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), section, keepAwake: body.keepAwake !== false, sessionTokenHash: guestSessionHash(guestSessionToken) },
    });
    await recordHistory({ action: 'Guest join', summary: displayName + ' registered a light', fixtureIds: [light.id] });
    await applyActiveScalableCue().catch((error: unknown) => app.log.warn({ err: error }, 'Guest registration succeeded but the active scalable cue could not be refreshed.'));
    return reply.status(201).send({ light: publicGuestLight((await store.get(light.id)) ?? light), displayPath: displayPath(light.id), guestSessionToken });
  });

  app.post<{ Body: unknown }>('/api/v1/guest-registration/leave', async (request, reply) => {
    const body = asRecord(request.body, 'The request body');
    rejectKeys(body, ['resumeToken']);
    if (typeof body.resumeToken !== 'string' || !/^[a-f0-9]{64}$/i.test(body.resumeToken)) {
      throw new ApiError(400, 'invalid_request', 'A valid guest session is required.');
    }
    const guest = (await store.list()).find((light) => light.guest && guestHasSession(light, body.resumeToken as string));
    if (!guest) return reply.status(204).send();
    await store.remove(guest.id);
    await scenes.removeFixture(guest.id);
    await applyActiveScalableCue().catch((error: unknown) => app.log.warn({ err: error }, 'Guest left, but the active scalable cue could not be refreshed.'));
    await recordHistory({ action: 'Guest leave', summary: (guest.guest?.displayName ?? guest.name) + ' left the audience lights', fixtureIds: [guest.id] });
    return reply.status(204).send();
  });

  app.get('/api/v1/dmx/status', async (request) => {
    requireControllerAccess(request);
    const status = await dmxOutput.status();
    const fixtures = (await store.list()).filter((light) => light.kind === 'dmx');
    return { ...status, patchedFixtures: fixtures.length, channelCount: 512 };
  });

  app.get('/api/v1/dmx/profiles', async (request) => {
    requireControllerAccess(request);
    return { profiles: dmxProfiles.list() };
  });

  app.patch<{ Params: { lightId: string }; Body: unknown }>('/api/v1/lights/:lightId/dmx-patch', async (request) => {
    requireControllerAccess(request);
    const id = validateLightId(request.params.lightId);
    const current = await store.get(id);
    if (!current) throw new ApiError(404, 'light_not_found', `No light exists with ID "${id}".`);
    if (current.kind !== 'dmx') throw new ApiError(409, 'not_a_dmx_fixture', 'Only DMX fixtures can be patched to the universe.');
    const body = asRecord(request.body, 'The request body');
    rejectKeys(body, ['profileId', 'startAddress']);
    const dmx = validateDmxFixtureConfig(body);
    const existing = await store.list();
    validateDmxPatch(existing.map((light) => light.id === id ? { ...light, dmx } : light), dmxProfiles.list());
    const light = await store.updateDmxPatch(id, dmx);
    if (!light) throw new ApiError(404, 'light_not_found', `No light exists with ID "${id}".`);
    const outputWarning = await dmxOutput.apply(await store.list(), dmxProfiles.list()).then(() => {
      lastDmxOutputWarning = undefined;
      return undefined;
    }, (error: unknown) => logOptionalDmxFailure(error, 'DMX patch saved but the optional uDMX output did not refresh.'));
    await recordHistory({ action: 'DMX patch', summary: 'Repatched ' + light.name + ' to address ' + dmx.startAddress, fixtureIds: [id] });
    return { light, ...(outputWarning ? { outputWarning } : {}) };
  });

  app.post<{ Body: unknown }>('/api/v1/dmx/profiles', async (request, reply) => {
    requireControllerAccess(request);
    return reply.status(201).send({ profile: await dmxProfiles.create(request.body) });
  });

  app.patch<{ Params: { profileId: string }; Body: unknown }>('/api/v1/dmx/profiles/:profileId', async (request) => {
    requireControllerAccess(request);
    const profileId = request.params.profileId;
    const body = asRecord(request.body, 'The request body');
    const updated = validateDmxFixtureProfile({ ...body, id: profileId }, { allowId: true });
    const candidateProfiles = dmxProfiles.list().map((profile) => profile.id === profileId ? updated : profile);
    validateDmxPatch(await store.list(), candidateProfiles);
    const profile = await dmxProfiles.update(profileId, updated);
    const outputWarning = await dmxOutput.apply(await store.list(), dmxProfiles.list()).then(() => undefined, (error: unknown) => error instanceof Error ? error.message : 'The DMX output could not be refreshed.');
    return { profile, ...(outputWarning ? { outputWarning } : {}) };
  });

  app.delete<{ Params: { profileId: string } }>('/api/v1/dmx/profiles/:profileId', async (request, reply) => {
    requireControllerAccess(request);
    const profileId = request.params.profileId;
    if ((await store.list()).some((light) => light.kind === 'dmx' && light.dmx?.profileId === profileId)) {
      throw new ApiError(409, 'dmx_profile_in_use', 'Repatch or delete DMX fixtures using this profile before deleting it.');
    }
    await dmxProfiles.remove(profileId);
    return reply.status(204).send();
  });

  app.get('/api/v1/lights', async (request) => {
    requireControllerAccess(request);
    return { lights: await store.list() };
  });

  app.post<{ Body: unknown }>('/api/v1/lights', async (request, reply) => {
    requireControllerAccess(request);
    const input = validateCreateLight(request.body);
    if (input.fixtureNumber !== undefined && (await store.list()).some((light) => light.fixtureNumber === input.fixtureNumber)) {
      throw new ApiError(409, 'fixture_number_already_exists', `Fixture number ${input.fixtureNumber} is already in use.`);
    }
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
      await recordHistory({ action: 'Fixture create', summary: 'Connected WLED ' + light.name, fixtureIds: [light.id] });
      await applyActiveScalableCue();
      return reply.status(201).send({ light: (await store.get(light.id)) ?? light });
    }
    if (input.kind === 'dmx' && input.dmx) {
      const existing = await store.list();
      const candidate: LightResource = {
        id: input.id ?? 'pending-dmx-fixture', name: input.name ?? input.id ?? 'DMX fixture',
        ...(input.fixtureNumber === undefined ? {} : { fixtureNumber: input.fixtureNumber }),
        kind: 'dmx', dmx: input.dmx,
        state: { ...DEFAULT_LIGHT_STATE, patternStartedAt: Date.now() }, revision: 0, updatedAt: new Date().toISOString(),
      };
      validateDmxPatch([...existing, candidate], dmxProfiles.list());
      const light = await store.create(input);
      await recordHistory({ action: 'Fixture create', summary: 'Patched DMX ' + light.name, fixtureIds: [light.id] });
      await applyActiveScalableCue();
      return reply.status(201).send({ light: (await store.get(light.id)) ?? light });
    }
    const light = await store.create(input);
    await recordHistory({ action: 'Fixture create', summary: 'Created ' + light.name, fixtureIds: [light.id] });
    await applyActiveScalableCue();
    return reply.status(201).send({ light: (await store.get(light.id)) ?? light, displayPath: displayPath(light.id) });
  });

  app.get<{ Params: { lightId: string } }>('/api/v1/lights/:lightId', async (request) => {
    const id = validateLightId(request.params.lightId);
    const light = await store.get(id);
    if (!light) throw new ApiError(404, 'light_not_found', `No light exists with ID "${id}".`);
    if (light.kind !== 'display') requireControllerAccess(request);
    if (light.guest) return publicGuestLight((await store.touchGuest(id)) ?? light);
    return light;
  });

  app.patch<{ Params: { lightId: string }; Body: unknown }>('/api/v1/lights/:lightId', async (request) => {
    requireControllerAccess(request);
    const id = validateLightId(request.params.lightId);
    const patch = validateLightPatch(request.body);
    if (patch.fixtureNumber !== undefined && (await store.list()).some((candidate) => candidate.id !== id && candidate.fixtureNumber === patch.fixtureNumber)) {
      throw new ApiError(409, 'fixture_number_already_exists', `Fixture number ${patch.fixtureNumber} is already in use.`);
    }
    const light = (await updateLights([{ id, patch }]))[0];
    if (!light) throw new ApiError(404, 'light_not_found', `No light exists with ID "${id}".`);
    await recordHistory({ action: 'Programmer update', summary: 'Updated ' + light.name, fixtureIds: [id] });
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
    const effectPattern = input.state.pattern !== undefined && input.state.pattern !== 'solid';
    const orderedTargetIds = effectPattern
      ? await arrangeFixtureIds(targetIds, input.direction ?? 'forward')
      : targetIds;
    const existing = await Promise.all(orderedTargetIds.map((id) => store.get(id)));
    const missing = orderedTargetIds.filter((_, index) => !existing[index]);
    if (missing.length > 0) {
      throw new ApiError(404, 'light_not_found', 'One or more selected lights do not exist.', { ids: missing });
    }
    const denominator = Math.max(1, orderedTargetIds.length);
    const lights = await updateLights(orderedTargetIds.map((id, index) => ({
      id,
      patch: effectPattern
        ? { ...input.state, phaseOffset: index / denominator }
        : input.state,
    })));
    await recordHistory({ action: 'Batch programmer', summary: 'Updated ' + lights.length + ' fixture' + (lights.length === 1 ? '' : 's'), fixtureIds: orderedTargetIds, detail: Object.keys(input.state).filter((key) => key !== 'expectedRevision').join(', ') });
    return { lights, count: lights.length };
  });

  app.post<{ Body: unknown }>('/api/v1/lights/chase', async (request) => {
    requireControllerAccess(request);
    const input = validateChase(request.body);
    const targetIds = input.ids === 'all' ? (await store.list()).map((light) => light.id) : input.ids;
    const orderedTargetIds = await arrangeFixtureIds(targetIds, input.direction ?? 'forward');
    const existing = await Promise.all(orderedTargetIds.map((id) => store.get(id)));
    const missing = orderedTargetIds.filter((_, index) => !existing[index]);
    if (missing.length > 0) {
      throw new ApiError(404, 'light_not_found', 'One or more selected lights do not exist.', { ids: missing });
    }
    const denominator = Math.max(1, orderedTargetIds.length);
    const lights = await updateLights(
      orderedTargetIds.map((id, index) => ({
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
    await recordHistory({ action: 'Chase', summary: 'Programmed ' + (input.direction ?? 'forward') + ' chase across ' + lights.length + ' fixtures', fixtureIds: orderedTargetIds });
    return { lights, count: lights.length };
  });

  app.get('/api/v1/scenes', async (request) => {
    requireControllerAccess(request);
    return { scenes: await scenes.list(), stacks: await scenes.listStacks() };
  });

  app.post<{ Body: unknown }>('/api/v1/cue-stacks', async (request, reply) => {
    requireControllerAccess(request);
    const body = asRecord(request.body, 'The request body');
    rejectKeys(body, ['name']);
    const stack = await scenes.createStack(validateName(body.name));
    await recordHistory({ action: 'Cue stack create', summary: 'Created cue stack ' + stack.name, fixtureIds: [] });
    return reply.status(201).send({ stack });
  });

  app.put<{ Body: unknown }>('/api/v1/cue-stacks/order', async (request) => {
    requireControllerAccess(request);
    const body = asRecord(request.body, 'The request body');
    rejectKeys(body, ['stackIds']);
    if (!Array.isArray(body.stackIds) || !body.stackIds.every((id) => typeof id === 'string')) throw new ApiError(400, 'invalid_request', 'stackIds must be an array of cue stack IDs.');
    const ids = body.stackIds.map(validateCueStackId);
    if (new Set(ids).size !== ids.length) throw new ApiError(400, 'invalid_request', 'stackIds must not contain duplicates.');
    const current = await scenes.listStacks();
    if (ids.some((id) => !current.some((stack) => stack.id === id))) throw new ApiError(404, 'cue_stack_not_found', 'One or more cue stacks do not exist.');
    await scenes.reorderStacks(ids);
    return { stacks: await scenes.listStacks() };
  });

  app.patch<{ Params: { stackId: string }; Body: unknown }>('/api/v1/cue-stacks/:stackId', async (request) => {
    requireControllerAccess(request);
    const body = asRecord(request.body, 'The request body');
    rejectKeys(body, ['name']);
    const stack = await scenes.renameStack(validateCueStackId(request.params.stackId), validateName(body.name));
    if (!stack) throw new ApiError(404, 'cue_stack_not_found', 'The cue stack was not found.');
    await recordHistory({ action: 'Cue stack rename', summary: 'Renamed cue stack to ' + stack.name, fixtureIds: [] });
    return { stack };
  });

  app.delete<{ Params: { stackId: string } }>('/api/v1/cue-stacks/:stackId', async (request, reply) => {
    requireControllerAccess(request);
    const stack = await scenes.removeStack(validateCueStackId(request.params.stackId));
    if (!stack) throw new ApiError(404, 'cue_stack_not_found', 'The cue stack was not found.');
    await recordHistory({ action: 'Cue stack delete', summary: 'Deleted cue stack ' + stack.name, fixtureIds: [] });
    return reply.status(204).send();
  });

  app.put<{ Params: { stackId: string }; Body: unknown }>('/api/v1/cue-stacks/:stackId/cues/order', async (request) => {
    requireControllerAccess(request);
    const body = asRecord(request.body, 'The request body');
    rejectKeys(body, ['cueOrder']);
    if (!Array.isArray(body.cueOrder) || !body.cueOrder.every((id) => typeof id === 'string')) throw new ApiError(400, 'invalid_request', 'cueOrder must be an array of cue numbers.');
    const ids = body.cueOrder.map(validateSceneId);
    if (new Set(ids).size !== ids.length) throw new ApiError(400, 'invalid_request', 'cueOrder must not contain duplicates.');
    const stackId = validateCueStackId(request.params.stackId);
    const stack = await scenes.reorderCues(stackId, ids);
    if (!stack) throw new ApiError(404, 'cue_stack_not_found', 'The cue stack was not found.');
    return { stack };
  });

  app.post<{ Body: unknown }>('/api/v1/scenes', async (request, reply) => {
    requireControllerAccess(request);
    const scene = await scenes.create(validateCreateScene(request.body));
    await recordHistory({ action: 'Cue record', summary: 'Recorded Cue ' + scene.id + ' · ' + scene.name, fixtureIds: scene.ids === 'all' ? (await store.list()).map((light) => light.id) : scene.ids });
    return reply.status(201).send({ scene });
  });

  app.patch<{ Params: { sceneId: string }; Body: unknown }>('/api/v1/scenes/:sceneId', async (request) => {
    requireControllerAccess(request);
    const id = validateSceneId(request.params.sceneId);
    const scene = await scenes.update(id, validateUpdateScene(request.body));
    if (!scene) throw new ApiError(404, 'cue_not_found', 'No cue exists with number "' + id + '".');
    await recordHistory({ action: 'Cue update', summary: 'Updated Cue ' + scene.id + ' · ' + scene.name, fixtureIds: scene.ids === 'all' ? (await store.list()).map((light) => light.id) : scene.ids });
    return { scene };
  });

  app.post<{ Params: { sceneId: string } }>('/api/v1/scenes/:sceneId/go', async (request) => {
    requireControllerAccess(request);
    const id = validateSceneId(request.params.sceneId);
    const scene = await scenes.get(id);
    if (!scene) {
      throw new ApiError(404, 'cue_not_found', 'No cue exists with number "' + id + '".');
    }
    const targetIds = scene.ids === 'all' ? (await store.list()).map((light) => light.id) : scene.ids;
    const orderedTargetIds = await arrangeFixtureIds(targetIds, scene.effectDirection ?? 'forward');
    const existing = await Promise.all(orderedTargetIds.map((lightId) => store.get(lightId)));
    const missing = orderedTargetIds.filter((_, index) => !existing[index]);
    if (missing.length > 0) {
      throw new ApiError(409, 'cue_targets_missing', 'This cue includes lights that no longer exist.', { ids: missing });
    }
    const hasEffect = scene.state.pattern !== 'solid';
    const lights = await updateLights(orderedTargetIds.map((lightId, index) => ({
      id: lightId,
      patch: { ...scene.state, ...(hasEffect ? { phaseOffset: index / Math.max(1, orderedTargetIds.length) } : {}) },
    })));
    activeScalableCueId = scene.ids === 'all' && scene.scaleEffect ? scene.id : null;
    await scenes.setActiveScalableCue(activeScalableCueId ?? undefined);
    await recordHistory({ action: 'Cue GO', summary: 'Ran Cue ' + scene.id + ' · ' + scene.name, fixtureIds: orderedTargetIds });
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
    await timecode.removeCue(scene.id);
    await recordHistory({ action: 'Cue delete', summary: 'Deleted Cue ' + scene.id, fixtureIds: scene.ids === 'all' ? [] : scene.ids });
    return reply.status(204).send();
  });

  app.delete<{ Params: { lightId: string } }>('/api/v1/lights/:lightId', async (request, reply) => {
    requireControllerAccess(request);
    const id = validateLightId(request.params.lightId);
    const light = await store.remove(id);
    if (!light) throw new ApiError(404, 'light_not_found', `No light exists with ID "${id}".`);
    if (light.kind === 'dmx') await dmxOutput.apply(await store.list(), dmxProfiles.list()).catch(() => undefined);
    await scenes.removeFixture(id);
    await applyActiveScalableCue();
    await recordHistory({ action: 'Fixture delete', summary: 'Deleted ' + light.name, fixtureIds: [id] });
    return reply.status(204).send();
  });

  app.get<{ Params: { lightId: string } }>('/display/:lightId', async (request, reply) => {
    const id = validateLightId(request.params.lightId);
    const light = await store.get(id);
    if (!light) throw new ApiError(404, 'light_not_found', 'No light exists with ID "' + id + '".');
    if (light.kind !== 'display') {
      throw new ApiError(409, 'not_a_web_display', 'This fixture is a physical output, not a browser display.');
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
        void store.touchGuest(lightId).catch((error: unknown) => app.log.error(error, 'Unable to persist guest last-seen time.'));
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
