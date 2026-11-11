import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ApiError } from './errors.js';
import type { CreateSceneInput, LightPatch, SceneResource } from './types.js';

interface PersistedScenes {
  version: 1;
  scenes: SceneResource[];
  activeScalableCueId?: string;
}

function cloneScene(scene: SceneResource): SceneResource {
  return {
    ...scene,
    ids: scene.ids === 'all' ? 'all' : [...scene.ids],
    state: { ...scene.state },
    ...(scene.scaleEffect === undefined ? {} : { scaleEffect: scene.scaleEffect }),
  };
}

function hasPatchShape(value: unknown): value is LightPatch {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasSceneShape(value: unknown): value is SceneResource {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const scene = value as Partial<SceneResource>;
  return (
    typeof scene.id === 'string' &&
    typeof scene.name === 'string' &&
    (scene.ids === 'all' || (Array.isArray(scene.ids) && scene.ids.every((id) => typeof id === 'string'))) &&
    hasPatchShape(scene.state) &&
    typeof scene.revision === 'number' &&
    typeof scene.createdAt === 'string' &&
    typeof scene.updatedAt === 'string' &&
    (scene.scaleEffect === undefined || typeof scene.scaleEffect === 'boolean')
  );
}

function sortScenes(left: SceneResource, right: SceneResource): number {
  const leftNumber = Number(left.id);
  const rightNumber = Number(right.id);
  if (leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return left.id.localeCompare(right.id);
}

export class SceneStore {
  private readonly scenes = new Map<string, SceneResource>();
  private pendingWrite: Promise<void> = Promise.resolve();
  private initialized = false;
  private activeScalableCueId?: string;

  constructor(private readonly dataFile: string) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    try {
      const raw = await readFile(this.dataFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedScenes>;
      if (parsed.version !== 1 || !Array.isArray(parsed.scenes) || !parsed.scenes.every(hasSceneShape) ||
        (parsed.activeScalableCueId !== undefined && typeof parsed.activeScalableCueId !== 'string')) {
        throw new Error('The saved cue data does not match the expected format.');
      }
      this.activeScalableCueId = parsed.activeScalableCueId;
      for (const scene of parsed.scenes) {
        this.scenes.set(scene.id, cloneScene(scene));
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Unable to load saved cues from ' + this.dataFile + ': ' + String(error));
      }
    }
    this.initialized = true;
  }

  async list(): Promise<SceneResource[]> {
    return [...this.scenes.values()].map(cloneScene).sort(sortScenes);
  }

  async get(id: string): Promise<SceneResource | undefined> {
    const scene = this.scenes.get(id);
    return scene ? cloneScene(scene) : undefined;
  }

  getActiveScalableCue(): string | undefined { return this.activeScalableCueId; }

  async setActiveScalableCue(id: string | undefined): Promise<void> {
    const previous = this.activeScalableCueId;
    this.activeScalableCueId = id;
    try { await this.persist(); } catch (error) { this.activeScalableCueId = previous; throw error; }
  }

  async create(input: CreateSceneInput): Promise<SceneResource> {
    if (this.scenes.has(input.id)) {
      throw new ApiError(409, 'cue_already_exists', 'A cue with number "' + input.id + '" already exists.');
    }
    const now = new Date().toISOString();
    const scene: SceneResource = {
      id: input.id,
      name: input.name ?? 'Cue ' + input.id,
      ids: input.ids === 'all' ? 'all' : [...input.ids],
      state: { ...input.state },
      ...(input.scaleEffect === undefined ? {} : { scaleEffect: input.scaleEffect }),
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.scenes.set(scene.id, scene);
    try {
      await this.persist();
    } catch (error) {
      this.scenes.delete(scene.id);
      throw error;
    }
    return cloneScene(scene);
  }

  async remove(id: string): Promise<SceneResource | undefined> {
    const scene = this.scenes.get(id);
    if (!scene) {
      return undefined;
    }
    this.scenes.delete(id);
    const previousActive = this.activeScalableCueId;
    if (this.activeScalableCueId === id) this.activeScalableCueId = undefined;
    try {
      await this.persist();
    } catch (error) {
      this.scenes.set(id, scene);
      this.activeScalableCueId = previousActive;
      throw error;
    }
    return cloneScene(scene);
  }

  async removeFixture(fixtureId: string): Promise<number> {
    const previous = new Map([...this.scenes].map(([id, scene]) => [id, cloneScene(scene)]));
    let changed = 0;
    for (const [id, scene] of this.scenes) {
      if (scene.ids === 'all' || !scene.ids.includes(fixtureId)) continue;
      this.scenes.set(id, { ...scene, ids: scene.ids.filter((target) => target !== fixtureId), revision: scene.revision + 1, updatedAt: new Date().toISOString() });
      changed += 1;
    }
    if (!changed) return 0;
    try { await this.persist(); } catch (error) {
      this.scenes.clear();
      for (const [id, scene] of previous) this.scenes.set(id, scene);
      throw error;
    }
    return changed;
  }

  async clearMedia(mediaUrl: string): Promise<number> {
    const previous = new Map([...this.scenes].map(([id, scene]) => [id, cloneScene(scene)]));
    let changed = 0;
    for (const [id, scene] of this.scenes) {
      if (scene.state.mediaUrl !== mediaUrl) continue;
      this.scenes.set(id, {
        ...scene,
        state: { ...scene.state, mediaUrl: null, mediaKind: null },
        revision: scene.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      changed += 1;
    }
    if (!changed) return 0;
    try { await this.persist(); } catch (error) {
      this.scenes.clear();
      for (const [id, scene] of previous) this.scenes.set(id, scene);
      throw error;
    }
    return changed;
  }

  async close(): Promise<void> {
    await this.pendingWrite;
  }

  private async persist(): Promise<void> {
    const snapshot: PersistedScenes = {
      version: 1,
      scenes: await this.list(),
      ...(this.activeScalableCueId ? { activeScalableCueId: this.activeScalableCueId } : {}),
    };
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    const write = this.pendingWrite.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.dataFile), { recursive: true });
      const temporaryFile = this.dataFile + '.' + process.pid + '.' + randomUUID() + '.tmp';
      await writeFile(temporaryFile, serialized, 'utf8');
      await rename(temporaryFile, this.dataFile);
    });
    this.pendingWrite = write;
    await write;
  }
}
