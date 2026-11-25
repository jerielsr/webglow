import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ApiError } from './errors.js';
import {
  DEFAULT_LIGHT_STATE,
  isPattern,
  type CreateLightInput,
  type DmxFixtureConfig,
  type FixtureKind,
  type GuestFixtureConfig,
  type LightPatch,
  type LightResource,
  type LightState,
  type WledFixtureConfig,
} from './types.js';

interface PersistedLights {
  version: 1;
  lights: LightResource[];
}

function cloneLight(light: LightResource): LightResource {
  const legacyTransition = (light.state.colorTransition as string | undefined) === 'ramp' ? 'ramp-up' : light.state.colorTransition;
  return {
    ...light,
    kind: light.kind ?? 'display',
    state: {
      ...DEFAULT_LIGHT_STATE,
      ...light.state,
      ...(light.state.colors ? { colors: [...light.state.colors] } : {}),
      ...(legacyTransition ? { colorTransition: legacyTransition } : {}),
      ...(light.state.colorTransitions ? { colorTransitions: light.state.colorTransitions.map((transition) => (transition as string) === 'ramp' ? 'ramp-up' : transition) } : {}),
      ...(light.state.layers ? { layers: light.state.layers.map((layer) => ({ ...layer })) } : {}),
    },
  };
}

function hasWledShape(value: unknown): value is WledFixtureConfig {
  if (typeof value !== 'object' || value === null) return false;
  const wled = value as Partial<WledFixtureConfig>;
  const map = wled.effectMap;
  return (
    typeof wled.url === 'string' &&
    Number.isInteger(wled.segment) &&
    (map === undefined ||
      (typeof map === 'object' &&
        map !== null &&
        Object.values(map).every((effect) => Number.isInteger(effect) && (effect as number) >= 0)))
  );
}

function hasGuestShape(value: unknown): value is GuestFixtureConfig {
  if (typeof value !== 'object' || value === null) return false;
  const guest = value as Partial<GuestFixtureConfig>;
  return typeof guest.registeredAt === 'string' && typeof guest.displayName === 'string' &&
    (guest.lastSeenAt === undefined || typeof guest.lastSeenAt === 'string') &&
    (guest.section === undefined || typeof guest.section === 'string') &&
    (guest.keepAwake === undefined || typeof guest.keepAwake === 'boolean') &&
    (guest.sessionTokenHash === undefined || /^[a-f0-9]{64}$/.test(guest.sessionTokenHash));
}

function hasDmxShape(value: unknown): value is DmxFixtureConfig {
  if (typeof value !== 'object' || value === null) return false;
  const dmx = value as Partial<DmxFixtureConfig>;
  return typeof dmx.profileId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(dmx.profileId) &&
    Number.isInteger(dmx.startAddress) && (dmx.startAddress as number) >= 1 && (dmx.startAddress as number) <= 512;
}

function hasVisualLayers(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 8) return false;
  return value.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const layer = entry as Record<string, unknown>;
    return typeof layer.id === 'string' &&
      ['snowflakes', 'squares', 'orbit'].includes(String(layer.pattern)) &&
      typeof layer.color === 'string' &&
      typeof layer.opacity === 'number' &&
      Number.isInteger(layer.density) &&
      typeof layer.size === 'number' &&
      typeof layer.speed === 'number';
  });
}

function hasPersistedLightShape(value: unknown): value is LightResource {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const light = value as Partial<LightResource>;
  const state = light.state as Partial<LightState> | undefined;
  return (
    typeof light.id === 'string' &&
    typeof light.name === 'string' &&
    (light.fixtureNumber === undefined || (Number.isInteger(light.fixtureNumber) && light.fixtureNumber >= 1 && light.fixtureNumber <= 9999)) &&
    (light.kind === undefined || light.kind === 'display' || (light.kind === 'wled' && hasWledShape(light.wled)) || (light.kind === 'dmx' && hasDmxShape(light.dmx))) &&
    (light.guest === undefined || (light.kind === 'display' && hasGuestShape(light.guest))) &&
    typeof light.revision === 'number' &&
    typeof light.updatedAt === 'string' &&
    typeof state?.on === 'boolean' &&
    typeof state.brightness === 'number' &&
    typeof state.color === 'string' &&
    (state.colors === undefined || (Array.isArray(state.colors) && state.colors.length >= 2 && state.colors.length <= 8 && state.colors.every((color) => typeof color === 'string'))) &&
    (state.colorTransition === undefined || ['snap', 'fade', 'ramp', 'ramp-up', 'ramp-down'].includes(state.colorTransition)) &&
    (state.colorTransitions === undefined || (Array.isArray(state.colorTransitions) && state.colorTransitions.length >= 2 && state.colorTransitions.length <= 8 && state.colorTransitions.every((transition) => ['snap', 'fade', 'ramp', 'ramp-up', 'ramp-down'].includes(transition)))) &&
    (state.colorStepMs === undefined || (Number.isInteger(state.colorStepMs) && state.colorStepMs >= 100 && state.colorStepMs <= 60_000)) &&
    isPattern(state.pattern) &&
    typeof state.speed === 'number' &&
    typeof state.patternStartedAt === 'number' &&
    (state.fadeMs === undefined || typeof state.fadeMs === 'number') &&
    (state.phaseOffset === undefined || typeof state.phaseOffset === 'number') &&
    (state.mediaUrl === undefined || typeof state.mediaUrl === 'string') &&
    (state.mediaKind === undefined || state.mediaKind === 'image' || state.mediaKind === 'video') &&
    (state.mediaStartedAt === undefined || typeof state.mediaStartedAt === 'number') &&
    (state.mediaOpacity === undefined || typeof state.mediaOpacity === 'number') &&
    (state.layers === undefined || hasVisualLayers(state.layers))
  );
}

export class LightStore {
  private readonly lights = new Map<string, LightResource>();
  private readonly events = new EventEmitter();
  private pendingWrite: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(private readonly dataFile: string) {
    // A single logical light can legitimately have many browser renderers.
    this.events.setMaxListeners(0);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const raw = await readFile(this.dataFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedLights>;

      if (parsed.version !== 1 || !Array.isArray(parsed.lights) || !parsed.lights.every(hasPersistedLightShape)) {
        throw new Error('The saved light state does not match the expected format.');
      }

      for (const light of parsed.lights) this.lights.set(light.id, cloneLight(light));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Unable to load saved lights from ${this.dataFile}: ${String(error)}`);
      }
    }

    const assigned = new Set([...this.lights.values()].flatMap((light) => light.fixtureNumber === undefined ? [] : [light.fixtureNumber]));
    let migratedFixtureNumbers = false;
    for (const light of [...this.lights.values()].sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))) {
      if (light.fixtureNumber !== undefined) continue;
      let fixtureNumber = 1;
      while (assigned.has(fixtureNumber)) fixtureNumber += 1;
      light.fixtureNumber = fixtureNumber;
      assigned.add(fixtureNumber);
      migratedFixtureNumbers = true;
    }
    if (migratedFixtureNumbers) await this.persist();
    this.initialized = true;
  }

  async list(): Promise<LightResource[]> {
    return [...this.lights.values()].map(cloneLight).sort((left, right) => left.id.localeCompare(right.id));
  }

  async get(id: string): Promise<LightResource | undefined> {
    const light = this.lights.get(id);
    return light ? cloneLight(light) : undefined;
  }

  async ensure(id: string, name?: string): Promise<LightResource> {
    const existing = this.lights.get(id);
    if (existing) {
      return cloneLight(existing);
    }

    return this.create({ id, name });
  }

  async create(input: CreateLightInput = {}): Promise<LightResource> {
    const id = input.id ?? `light-${randomUUID().slice(0, 8)}`;
    if (this.lights.has(id)) {
      throw new ApiError(409, 'light_already_exists', `A light with ID "${id}" already exists.`);
    }
    const fixtureNumber = input.fixtureNumber ?? Math.max(0, ...[...this.lights.values()].map((light) => light.fixtureNumber ?? 0)) + 1;
    if ([...this.lights.values()].some((light) => light.fixtureNumber === fixtureNumber)) {
      throw new ApiError(409, 'fixture_number_already_exists', `Fixture number ${fixtureNumber} is already in use.`);
    }

    const now = new Date();
    const kind: FixtureKind = input.kind ?? 'display';
    const light: LightResource = {
      id,
      name: input.name ?? id,
      fixtureNumber,
      kind,
      ...(kind === 'wled' && input.wled ? { wled: input.wled } : {}),
      ...(kind === 'dmx' && input.dmx ? { dmx: input.dmx } : {}),
      ...(kind === 'display' && input.guest ? { guest: input.guest } : {}),
      state: {
        ...DEFAULT_LIGHT_STATE,
        patternStartedAt: now.getTime(),
      },
      revision: 0,
      updatedAt: now.toISOString(),
    };

    this.lights.set(id, light);
    try {
      await this.persist();
    } catch (error) {
      this.lights.delete(id);
      throw error;
    }

    const result = cloneLight(light);
    this.events.emit('changed', result);
    return result;
  }

  async update(id: string, patch: LightPatch): Promise<LightResource | undefined> {
    const result = await this.updateMany([{ id, patch }]);
    return result[0];
  }

  /** Replace the operator-patched fixtures while retaining QR-registered guest lights. */
  async replaceConfiguredLights(fixtures: LightResource[]): Promise<void> {
    if (fixtures.some((light) => light.guest)) {
      throw new ApiError(400, 'guest_fixture_in_showfile', 'Showfiles cannot replace QR-registered guest lights.');
    }
    const ids = fixtures.map((light) => light.id);
    if (new Set(ids).size !== ids.length) {
      throw new ApiError(400, 'duplicate_fixture_id', 'Fixture IDs in the showfile must be unique.');
    }
    const fixtureNumbers = fixtures.flatMap((light) => light.fixtureNumber === undefined ? [] : [light.fixtureNumber]);
    if (new Set(fixtureNumbers).size !== fixtureNumbers.length) {
      throw new ApiError(400, 'duplicate_fixture_number', 'Fixture numbers in the showfile must be unique.');
    }

    const previous = new Map(this.lights);
    const normalizedFixtures = fixtures.map(cloneLight);
    const guestFixtureNumbers = new Set([...previous.values()].filter((light) => Boolean(light.guest)).flatMap((light) => light.fixtureNumber === undefined ? [] : [light.fixtureNumber]));
    if (normalizedFixtures.some((light) => light.fixtureNumber !== undefined && guestFixtureNumbers.has(light.fixtureNumber))) {
      throw new ApiError(409, 'fixture_number_conflicts_with_guest', 'A showfile fixture number conflicts with a registered guest fixture. Renumber the fixture and load the showfile again.');
    }
    const usedFixtureNumbers = new Set([...guestFixtureNumbers, ...normalizedFixtures.flatMap((light) => light.fixtureNumber === undefined ? [] : [light.fixtureNumber])]);
    for (const light of normalizedFixtures) {
      if (light.fixtureNumber !== undefined) continue;
      let fixtureNumber = 1;
      while (usedFixtureNumbers.has(fixtureNumber)) fixtureNumber += 1;
      light.fixtureNumber = fixtureNumber;
      usedFixtureNumbers.add(fixtureNumber);
    }
    const guests = [...previous.values()].filter((light) => Boolean(light.guest));
    if (guests.some((guest) => ids.includes(guest.id))) {
      throw new ApiError(409, 'fixture_id_conflicts_with_guest', 'A showfile fixture ID conflicts with a currently registered guest light.');
    }

    this.lights.clear();
    guests.forEach((light) => this.lights.set(light.id, light));
    normalizedFixtures.forEach((light) => this.lights.set(light.id, light));
    try {
      await this.persist();
    } catch (error) {
      this.lights.clear();
      previous.forEach((light, id) => this.lights.set(id, light));
      throw error;
    }

    for (const [id, oldLight] of previous) {
      if (!oldLight.guest && !this.lights.has(id)) this.events.emit('deleted', cloneLight(oldLight));
    }
    normalizedFixtures.forEach((light) => this.events.emit('changed', cloneLight(light)));
  }

  /** Apply state changes as one persisted update, then notify all affected displays. */
  async updateMany(updates: Array<{ id: string; patch: LightPatch }>, timestamp = Date.now()): Promise<LightResource[]> {
    const uniqueIds = new Set(updates.map((update) => update.id));
    if (uniqueIds.size !== updates.length) {
      throw new Error('updateMany does not accept duplicate light IDs.');
    }

    const currents = updates.map((update) => this.lights.get(update.id));
    if (currents.some((light) => !light)) {
      return [];
    }

    const changed: Array<{ previous: LightResource; next: LightResource }> = [];
    for (let index = 0; index < updates.length; index += 1) {
      const current = currents[index] as LightResource;
      const next = this.updatedResource(current, updates[index].patch, timestamp);
      if (next !== current) {
        changed.push({ previous: current, next });
      }
    }

    if (changed.length === 0) {
      return currents.map((light) => cloneLight(light as LightResource));
    }

    for (const update of changed) {
      this.lights.set(update.next.id, update.next);
    }
    try {
      await this.persist();
    } catch (error) {
      for (const update of changed) {
        this.lights.set(update.previous.id, update.previous);
      }
      throw error;
    }

    for (const update of changed) {
      this.events.emit('changed', cloneLight(update.next));
    }
    return updates.map((update) => cloneLight(this.lights.get(update.id) as LightResource));
  }

  async remove(id: string): Promise<LightResource | undefined> {
    const current = this.lights.get(id);
    if (!current) {
      return undefined;
    }

    this.lights.delete(id);
    try {
      await this.persist();
    } catch (error) {
      this.lights.set(id, current);
      throw error;
    }

    const result = cloneLight(current);
    this.events.emit('deleted', result);
    return result;
  }

  async touchGuest(id: string, timestamp = Date.now(), force = false): Promise<LightResource | undefined> {
    const current = this.lights.get(id);
    if (!current?.guest) return current ? cloneLight(current) : undefined;
    const previousSeen = Date.parse(current.guest.lastSeenAt ?? current.guest.registeredAt);
    if (!force && Number.isFinite(previousSeen) && timestamp - previousSeen < 60_000) return cloneLight(current);
    const next: LightResource = {
      ...current,
      guest: { ...current.guest, lastSeenAt: new Date(timestamp).toISOString() },
    };
    this.lights.set(id, next);
    try { await this.persist(); } catch (error) { this.lights.set(id, current); throw error; }
    return cloneLight(next);
  }

  async updateDmxPatch(id: string, dmx: DmxFixtureConfig): Promise<LightResource | undefined> {
    const current = this.lights.get(id);
    if (!current || current.kind !== 'dmx') return current ? cloneLight(current) : undefined;
    const next: LightResource = {
      ...current,
      dmx: { ...dmx },
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.lights.set(id, next);
    try {
      await this.persist();
    } catch (error) {
      this.lights.set(id, current);
      throw error;
    }
    this.events.emit('changed', cloneLight(next));
    return cloneLight(next);
  }

  onChange(listener: (light: LightResource) => void): () => void {
    this.events.on('changed', listener);
    return () => this.events.off('changed', listener);
  }

  onDelete(listener: (light: LightResource) => void): () => void {
    this.events.on('deleted', listener);
    return () => this.events.off('deleted', listener);
  }

  async close(): Promise<void> {
    await this.pendingWrite;
  }

  private async persist(): Promise<void> {
    const snapshot: PersistedLights = {
      version: 1,
      lights: [...this.lights.values()].map(cloneLight).sort((left, right) => left.id.localeCompare(right.id)),
    };
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

    const write = this.pendingWrite.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.dataFile), { recursive: true });
      const temporaryFile = `${this.dataFile}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryFile, serialized, 'utf8');
      await rename(temporaryFile, this.dataFile);
    });
    this.pendingWrite = write;
    await write;
  }

  private updatedResource(current: LightResource, patch: LightPatch, timestamp: number): LightResource {
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== current.revision) {
      throw new ApiError(
        409,
        'revision_conflict',
        'The light changed since the revision supplied with this request.',
        { expectedRevision: patch.expectedRevision, currentRevision: current.revision },
      );
    }

    const currentState: LightState = { ...DEFAULT_LIGHT_STATE, ...current.state };
    const nextName = patch.name ?? current.name;
    const nextFixtureNumber = patch.fixtureNumber ?? current.fixtureNumber;
    const nextState: LightState = {
      ...currentState,
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
    };
    if (patch.mediaUrl === null) {
      nextState.mediaUrl = undefined;
      nextState.mediaKind = undefined;
    }
    const mediaContentChanged = nextState.mediaUrl !== currentState.mediaUrl || nextState.mediaKind !== currentState.mediaKind;
    if (mediaContentChanged) {
      nextState.mediaStartedAt = nextState.mediaUrl ? timestamp : undefined;
    }
    const effectChanged =
      nextState.pattern !== currentState.pattern ||
      JSON.stringify(nextState.colors) !== JSON.stringify(currentState.colors) ||
      nextState.colorTransition !== currentState.colorTransition ||
      JSON.stringify(nextState.colorTransitions) !== JSON.stringify(currentState.colorTransitions) ||
      nextState.colorStepMs !== currentState.colorStepMs ||
      nextState.speed !== currentState.speed ||
      nextState.phaseOffset !== currentState.phaseOffset ||
      JSON.stringify(nextState.layers) !== JSON.stringify(currentState.layers);
    if (effectChanged) {
      nextState.patternStartedAt = timestamp;
    }

    const changed =
      nextName !== current.name ||
      nextFixtureNumber !== current.fixtureNumber ||
      nextState.on !== currentState.on ||
      nextState.brightness !== currentState.brightness ||
      nextState.color !== currentState.color ||
      JSON.stringify(nextState.colors) !== JSON.stringify(currentState.colors) ||
      nextState.colorTransition !== currentState.colorTransition ||
      JSON.stringify(nextState.colorTransitions) !== JSON.stringify(currentState.colorTransitions) ||
      nextState.colorStepMs !== currentState.colorStepMs ||
      nextState.pattern !== currentState.pattern ||
      nextState.speed !== currentState.speed ||
      nextState.fadeMs !== currentState.fadeMs ||
      nextState.phaseOffset !== currentState.phaseOffset ||
      nextState.mediaUrl !== currentState.mediaUrl ||
      nextState.mediaKind !== currentState.mediaKind ||
      nextState.mediaStartedAt !== currentState.mediaStartedAt ||
      nextState.mediaOpacity !== currentState.mediaOpacity ||
      JSON.stringify(nextState.layers) !== JSON.stringify(currentState.layers);

    if (!changed) {
      return current;
    }

    return {
      ...current,
      name: nextName,
      fixtureNumber: nextFixtureNumber,
      state: nextState,
      revision: current.revision + 1,
      updatedAt: new Date(timestamp).toISOString(),
    };
  }
}
