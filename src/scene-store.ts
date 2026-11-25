import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ApiError } from './errors.js';
import type { CreateSceneInput, CueStackResource, LightPatch, SceneResource, UpdateSceneInput } from './types.js';

interface PersistedScenes {
  version: 1;
  scenes: SceneResource[];
  stacks?: CueStackResource[];
  activeScalableCueId?: string;
}

function cloneScene(scene: SceneResource): SceneResource {
  const legacyTransition = (scene.state.colorTransition as string | undefined) === 'ramp' ? 'ramp-up' : scene.state.colorTransition;
  return {
    ...scene,
    stackId: scene.stackId || 'main',
    ids: scene.ids === 'all' ? 'all' : [...scene.ids],
    state: {
      ...scene.state,
      ...(scene.state.colors ? { colors: [...scene.state.colors] } : {}),
      ...(legacyTransition ? { colorTransition: legacyTransition } : {}),
      ...(scene.state.colorTransitions ? { colorTransitions: scene.state.colorTransitions.map((transition) => (transition as string) === 'ramp' ? 'ramp-up' : transition) } : {}),
    },
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
    (scene.scaleEffect === undefined || typeof scene.scaleEffect === 'boolean') &&
    (scene.effectDirection === undefined || ['forward', 'reverse', 'front-to-back', 'back-to-front', 'diagonal-left', 'diagonal-right', 'center-out', 'edges-in', 'random'].includes(scene.effectDirection)) &&
    (scene.stackId === undefined || typeof scene.stackId === 'string')
  );
}

function hasStackShape(value: unknown): value is CueStackResource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const stack = value as Partial<CueStackResource>;
  return typeof stack.id === 'string' && typeof stack.name === 'string' && typeof stack.updatedAt === 'string' &&
    Array.isArray(stack.cueOrder) && stack.cueOrder.every((id) => typeof id === 'string');
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
  private readonly stacks = new Map<string, CueStackResource>();
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
        (parsed.stacks !== undefined && (!Array.isArray(parsed.stacks) || !parsed.stacks.every(hasStackShape))) ||
        (parsed.activeScalableCueId !== undefined && typeof parsed.activeScalableCueId !== 'string')) {
        throw new Error('The saved cue data does not match the expected format.');
      }
      this.activeScalableCueId = parsed.activeScalableCueId;
      for (const stack of parsed.stacks ?? [{ id: 'main', name: 'Main', cueOrder: [], updatedAt: new Date().toISOString() }]) {
        this.stacks.set(stack.id, { ...stack, cueOrder: [...stack.cueOrder] });
      }
      if (!this.stacks.has('main')) this.stacks.set('main', { id: 'main', name: 'Main', cueOrder: [], updatedAt: new Date().toISOString() });
      for (const scene of parsed.scenes) {
        const normalized = cloneScene(scene);
        if (!this.stacks.has(normalized.stackId)) normalized.stackId = 'main';
        this.scenes.set(scene.id, normalized);
      }
      for (const [id, stack] of this.stacks) {
        const validOrder = stack.cueOrder.filter((cueId) => this.scenes.get(cueId)?.stackId === id);
        const missing = [...this.scenes.values()].filter((scene) => scene.stackId === id && !validOrder.includes(scene.id)).sort(sortScenes).map((scene) => scene.id);
        this.stacks.set(id, { ...stack, cueOrder: [...validOrder, ...missing] });
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Unable to load saved cues from ' + this.dataFile + ': ' + String(error));
      }
    }
    if (!this.stacks.has('main')) this.stacks.set('main', { id: 'main', name: 'Main', cueOrder: [], updatedAt: new Date().toISOString() });
    this.initialized = true;
  }

  async list(): Promise<SceneResource[]> {
    return [...this.scenes.values()].map(cloneScene).sort(sortScenes);
  }

  async listStacks(): Promise<CueStackResource[]> {
    return [...this.stacks.values()].map((stack) => ({ ...stack, cueOrder: [...stack.cueOrder] }));
  }

  /** Atomically replace cues and stacks as one persisted showfile snapshot. */
  async replaceAll(scenes: SceneResource[], stacks: CueStackResource[]): Promise<void> {
    const previousScenes = new Map([...this.scenes].map(([id, scene]) => [id, cloneScene(scene)]));
    const previousStacks = new Map([...this.stacks].map(([id, stack]) => [id, { ...stack, cueOrder: [...stack.cueOrder] }]));
    const previousActiveCue = this.activeScalableCueId;
    const nextScenes = new Map(scenes.map((scene) => [scene.id, cloneScene(scene)]));
    const nextStacks = new Map(stacks.map((stack) => [stack.id, { ...stack, cueOrder: [...stack.cueOrder] }]));
    if (!nextStacks.has('main')) nextStacks.set('main', { id: 'main', name: 'Main', cueOrder: [], updatedAt: new Date().toISOString() });
    if (nextScenes.size !== scenes.length || nextStacks.size !== stacks.length + (stacks.some((stack) => stack.id === 'main') ? 0 : 1)) {
      throw new ApiError(400, 'invalid_showfile', 'Showfile cue and stack IDs must be unique.');
    }
    for (const scene of nextScenes.values()) {
      if (!nextStacks.has(scene.stackId)) throw new ApiError(400, 'invalid_showfile', `Cue ${scene.id} references a missing cue stack.`);
    }
    for (const [stackId, stack] of nextStacks) {
      const validOrder = stack.cueOrder.filter((cueId) => nextScenes.get(cueId)?.stackId === stackId);
      const missing = [...nextScenes.values()].filter((scene) => scene.stackId === stackId && !validOrder.includes(scene.id)).sort(sortScenes).map((scene) => scene.id);
      nextStacks.set(stackId, { ...stack, cueOrder: [...validOrder, ...missing] });
    }

    this.scenes.clear();
    nextScenes.forEach((scene, id) => this.scenes.set(id, scene));
    this.stacks.clear();
    nextStacks.forEach((stack, id) => this.stacks.set(id, stack));
    this.activeScalableCueId = undefined;
    try {
      await this.persist();
    } catch (error) {
      this.scenes.clear();
      previousScenes.forEach((scene, id) => this.scenes.set(id, scene));
      this.stacks.clear();
      previousStacks.forEach((stack, id) => this.stacks.set(id, stack));
      this.activeScalableCueId = previousActiveCue;
      throw error;
    }
  }

  async createStack(name: string): Promise<CueStackResource> {
    const normalized = name.trim();
    if ([...this.stacks.values()].some((stack) => stack.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
      throw new ApiError(409, 'cue_stack_already_exists', 'A cue stack with this name already exists.');
    }
    const stack: CueStackResource = { id: 'stack-' + randomUUID().slice(0, 8), name: normalized, cueOrder: [], updatedAt: new Date().toISOString() };
    this.stacks.set(stack.id, stack);
    try { await this.persist(); } catch (error) { this.stacks.delete(stack.id); throw error; }
    return { ...stack, cueOrder: [] };
  }

  async renameStack(id: string, name: string): Promise<CueStackResource | undefined> {
    const stack = this.stacks.get(id);
    if (!stack) return undefined;
    const normalized = name.trim();
    if ([...this.stacks.values()].some((candidate) => candidate.id !== id && candidate.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
      throw new ApiError(409, 'cue_stack_already_exists', 'A cue stack with this name already exists.');
    }
    const previous = { ...stack, cueOrder: [...stack.cueOrder] };
    const updated = { ...stack, name: normalized, updatedAt: new Date().toISOString() };
    this.stacks.set(id, updated);
    try { await this.persist(); } catch (error) { this.stacks.set(id, previous); throw error; }
    return { ...updated, cueOrder: [...updated.cueOrder] };
  }

  async reorderStacks(ids: string[]): Promise<void> {
    const existing = [...this.stacks.values()];
    const rank = new Map(ids.map((id, index) => [id, index]));
    const ordered = [...existing].sort((left, right) => (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER));
    this.stacks.clear();
    ordered.forEach((stack) => this.stacks.set(stack.id, { ...stack, updatedAt: new Date().toISOString() }));
    try { await this.persist(); } catch (error) { this.stacks.clear(); existing.forEach((stack) => this.stacks.set(stack.id, stack)); throw error; }
  }

  async reorderCues(stackId: string, ids: string[]): Promise<CueStackResource | undefined> {
    const stack = this.stacks.get(stackId);
    if (!stack) return undefined;
    const available = new Set([...this.scenes.values()].filter((scene) => scene.stackId === stackId).map((scene) => scene.id));
    const order = [...ids.filter((id) => available.has(id)), ...stack.cueOrder.filter((id) => available.has(id) && !ids.includes(id)), ...[...available].filter((id) => !ids.includes(id) && !stack.cueOrder.includes(id))];
    const previous = { ...stack, cueOrder: [...stack.cueOrder] };
    const updated = { ...stack, cueOrder: order, updatedAt: new Date().toISOString() };
    this.stacks.set(stackId, updated);
    try { await this.persist(); } catch (error) { this.stacks.set(stackId, previous); throw error; }
    return { ...updated, cueOrder: [...updated.cueOrder] };
  }

  async removeStack(id: string): Promise<CueStackResource | undefined> {
    const stack = this.stacks.get(id);
    if (!stack) return undefined;
    if (id === 'main') throw new ApiError(409, 'cue_stack_required', 'The Main cue stack cannot be deleted.');
    if ([...this.scenes.values()].some((scene) => scene.stackId === id)) {
      throw new ApiError(409, 'cue_stack_not_empty', 'Move or delete the cues in this stack before deleting it.');
    }
    this.stacks.delete(id);
    try { await this.persist(); } catch (error) { this.stacks.set(id, stack); throw error; }
    return { ...stack, cueOrder: [...stack.cueOrder] };
  }

  async update(id: string, input: UpdateSceneInput): Promise<SceneResource | undefined> {
    const current = this.scenes.get(id);
    if (!current) return undefined;
    const targetStackId = input.stackId ?? current.stackId;
    const targetStack = this.stacks.get(targetStackId);
    if (!targetStack) throw new ApiError(404, 'cue_stack_not_found', 'The selected cue stack does not exist.');
    const previous = cloneScene(current);
    const sourceStack = this.stacks.get(current.stackId);
    const previousSourceOrder = sourceStack?.cueOrder.slice();
    const previousTargetOrder = targetStack.cueOrder.slice();
    const updated: SceneResource = {
      ...current,
      ...(input.name === undefined ? {} : { name: input.name }),
      stackId: targetStackId,
      ...(input.ids === undefined ? {} : { ids: input.ids === 'all' ? 'all' : [...input.ids] }),
      ...(input.state === undefined ? {} : { state: { ...input.state } }),
      ...(input.scaleEffect === undefined ? {} : { scaleEffect: input.scaleEffect }),
      ...(input.effectDirection === undefined ? {} : { effectDirection: input.effectDirection }),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    if (sourceStack && current.stackId !== targetStackId) {
      sourceStack.cueOrder = sourceStack.cueOrder.filter((cueId) => cueId !== id);
      sourceStack.updatedAt = updated.updatedAt;
      if (!targetStack.cueOrder.includes(id)) targetStack.cueOrder.push(id);
      targetStack.updatedAt = updated.updatedAt;
    }
    this.scenes.set(id, updated);
    try { await this.persist(); } catch (error) {
      this.scenes.set(id, previous);
      if (sourceStack && previousSourceOrder) sourceStack.cueOrder = previousSourceOrder;
      targetStack.cueOrder = previousTargetOrder;
      throw error;
    }
    return cloneScene(updated);
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
      stackId: input.stackId ?? 'main',
      ids: input.ids === 'all' ? 'all' : [...input.ids],
      state: { ...input.state },
      ...(input.scaleEffect === undefined ? {} : { scaleEffect: input.scaleEffect }),
      ...(input.effectDirection === undefined ? {} : { effectDirection: input.effectDirection }),
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (!this.stacks.has(scene.stackId)) throw new ApiError(404, 'cue_stack_not_found', 'The selected cue stack does not exist.');
    this.scenes.set(scene.id, scene);
    const stack = this.stacks.get(scene.stackId)!;
    stack.cueOrder.push(scene.id);
    stack.updatedAt = now;
    try {
      await this.persist();
    } catch (error) {
      this.scenes.delete(scene.id);
      stack.cueOrder = stack.cueOrder.filter((id) => id !== scene.id);
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
    const stack = this.stacks.get(scene.stackId);
    const previousOrder = stack ? [...stack.cueOrder] : [];
    if (stack) stack.cueOrder = stack.cueOrder.filter((cueId) => cueId !== id);
    const previousActive = this.activeScalableCueId;
    if (this.activeScalableCueId === id) this.activeScalableCueId = undefined;
    try {
      await this.persist();
    } catch (error) {
      this.scenes.set(id, scene);
      if (stack) stack.cueOrder = previousOrder;
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
      stacks: await this.listStacks(),
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
