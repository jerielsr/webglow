import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ApiError } from './errors.js';
import {
  DEFAULT_LIGHT_STATE,
  isPattern,
  type CreateLightInput,
  type FixtureKind,
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
  return {
    ...light,
    kind: light.kind ?? 'display',
    state: {
      ...DEFAULT_LIGHT_STATE,
      ...light.state,
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

function hasPersistedLightShape(value: unknown): value is LightResource {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const light = value as Partial<LightResource>;
  const state = light.state as Partial<LightState> | undefined;
  return (
    typeof light.id === 'string' &&
    typeof light.name === 'string' &&
    (light.kind === undefined || light.kind === 'display' || (light.kind === 'wled' && hasWledShape(light.wled))) &&
    typeof light.revision === 'number' &&
    typeof light.updatedAt === 'string' &&
    typeof state?.on === 'boolean' &&
    typeof state.brightness === 'number' &&
    typeof state.color === 'string' &&
    isPattern(state.pattern) &&
    typeof state.speed === 'number' &&
    typeof state.patternStartedAt === 'number' &&
    (state.fadeMs === undefined || typeof state.fadeMs === 'number') &&
    (state.phaseOffset === undefined || typeof state.phaseOffset === 'number')
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

      for (const light of parsed.lights) {
        this.lights.set(light.id, cloneLight(light));
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Unable to load saved lights from ${this.dataFile}: ${String(error)}`);
      }
    }

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

    const now = new Date();
    const kind: FixtureKind = input.kind ?? 'display';
    const light: LightResource = {
      id,
      name: input.name ?? id,
      kind,
      ...(kind === 'wled' && input.wled ? { wled: input.wled } : {}),
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
      lights: await this.list(),
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
    const nextState: LightState = {
      ...currentState,
      ...(patch.on === undefined ? {} : { on: patch.on }),
      ...(patch.brightness === undefined ? {} : { brightness: patch.brightness }),
      ...(patch.color === undefined ? {} : { color: patch.color }),
      ...(patch.pattern === undefined ? {} : { pattern: patch.pattern }),
      ...(patch.speed === undefined ? {} : { speed: patch.speed }),
      ...(patch.fadeMs === undefined ? {} : { fadeMs: patch.fadeMs }),
      ...(patch.phaseOffset === undefined ? {} : { phaseOffset: patch.phaseOffset }),
    };
    const effectChanged =
      nextState.pattern !== currentState.pattern ||
      nextState.speed !== currentState.speed ||
      nextState.phaseOffset !== currentState.phaseOffset;
    if (effectChanged) {
      nextState.patternStartedAt = timestamp;
    }

    const changed =
      nextName !== current.name ||
      nextState.on !== currentState.on ||
      nextState.brightness !== currentState.brightness ||
      nextState.color !== currentState.color ||
      nextState.pattern !== currentState.pattern ||
      nextState.speed !== currentState.speed ||
      nextState.fadeMs !== currentState.fadeMs ||
      nextState.phaseOffset !== currentState.phaseOffset;

    if (!changed) {
      return current;
    }

    return {
      ...current,
      name: nextName,
      state: nextState,
      revision: current.revision + 1,
      updatedAt: new Date(timestamp).toISOString(),
    };
  }
}
