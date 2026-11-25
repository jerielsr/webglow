import { ApiError } from './errors.js';
import { STAIRVILLE_LED_PAR_64_PROFILE, validateDmxFixtureProfile, validateDmxPatch } from './dmx.js';
import {
  DEFAULT_LIGHT_STATE,
  type CueStackResource,
  type LightResource,
  type LightState,
  type SceneResource,
  type TimecodeProgram,
} from './types.js';
import {
  validateCreateLight,
  validateCreateScene,
  validateCueStackId,
  validateLightId,
  validateLightPatch,
  validateName,
  validateSceneId,
  validateTimecodeProgram,
} from './validation.js';

export const SHOWFILE_FORMAT = 'webglow.showfile';
export const SHOWFILE_MAX_MEDIA_BYTES = 200 * 1024 * 1024;

const MEDIA_TYPES_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export interface EmbeddedShowfileMedia {
  id: string;
  contentType: string;
  bytes: Buffer;
}

export interface ImportedShowfile {
  fixtures: LightResource[];
  scenes: SceneResource[];
  stacks: CueStackResource[];
  timecode: TimecodeProgram;
  settings: {
    seatSections: string[];
    virtualSubsectionsEnabled: boolean;
    virtualSubsectionsCount: number;
    fixtureSortMode: 'id' | 'seat' | 'custom';
    fixtureOrder: string[];
  };
  media: EmbeddedShowfileMedia[];
  dmxProfiles: ReturnType<typeof validateDmxFixtureProfile>[];
}

function asRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'invalid_showfile', `${subject} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectKeys(record: Record<string, unknown>, allowed: string[], subject: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ApiError(400, 'invalid_showfile', `${subject} contains unsupported fields.`, { fields: unknown });
}

function stringArray(value: unknown, subject: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum || !value.every((item) => typeof item === 'string')) {
    throw new ApiError(400, 'invalid_showfile', `${subject} must be a list of up to ${maximum} strings.`);
  }
  return value;
}

function validateFixture(value: unknown, index: number, now: string): LightResource {
  const record = asRecord(value, `fixtures[${index}]`);
  rejectKeys(record, ['id', 'name', 'fixtureNumber', 'kind', 'wled', 'dmx', 'state'], `fixtures[${index}]`);
  const rawWled = record.wled === undefined ? undefined : asRecord(record.wled, `fixtures[${index}].wled`);
  const rawDmx = record.dmx === undefined ? undefined : asRecord(record.dmx, `fixtures[${index}].dmx`);
  if (rawDmx) rejectKeys(rawDmx, ['profileId', 'startAddress'], `fixtures[${index}].dmx`);
  const input = validateCreateLight({
    id: record.id,
    name: record.name,
    ...(record.fixtureNumber === undefined ? {} : { fixtureNumber: record.fixtureNumber }),
    kind: record.kind,
    ...(rawWled === undefined ? {} : { wled: { url: rawWled.url, segment: rawWled.segment } }),
    ...(rawDmx === undefined ? {} : { dmx: { profileId: rawDmx.profileId, startAddress: rawDmx.startAddress } }),
  });
  if (!input.id || !input.name) throw new ApiError(400, 'invalid_showfile', `fixtures[${index}] must include an id and name.`);
  let wled = input.wled;
  if (rawWled && rawWled.effectMap !== undefined) {
    const effectMap = asRecord(rawWled.effectMap, `fixtures[${index}].wled.effectMap`);
    const normalized: Record<string, number> = {};
    for (const [pattern, effect] of Object.entries(effectMap)) {
      if (!['solid', 'breathe', 'pulse', 'strobe', 'rainbow', 'chase', 'twinkle', 'ramp-up', 'ramp-down', 'multi-chase'].includes(pattern) || !Number.isInteger(effect) || (effect as number) < 0) {
        throw new ApiError(400, 'invalid_showfile', `fixtures[${index}].wled.effectMap contains an invalid effect.`);
      }
      normalized[pattern] = effect as number;
    }
    wled = { ...input.wled!, effectMap: normalized as NonNullable<typeof input.wled>['effectMap'] };
  }

  const rawState = asRecord(record.state, `fixtures[${index}].state`);
  const allowedState = ['on', 'brightness', 'color', 'colors', 'colorTransition', 'colorTransitions', 'colorStepMs', 'pattern', 'speed', 'fadeMs', 'phaseOffset', 'mediaUrl', 'mediaKind', 'mediaOpacity', 'layers'];
  rejectKeys(rawState, allowedState, `fixtures[${index}].state`);
  for (const field of ['on', 'brightness', 'color', 'pattern', 'speed']) {
    if (rawState[field] === undefined) throw new ApiError(400, 'invalid_showfile', `fixtures[${index}].state.${field} is required.`);
  }
  const patch = validateLightPatch(rawState);
  const kind = input.kind ?? 'display';
  const state: LightState = {
    on: patch.on!,
    brightness: patch.brightness!,
    color: patch.color!,
    ...(patch.colors ? { colors: [...patch.colors] } : {}),
    ...(patch.colorTransition ? { colorTransition: patch.colorTransition } : {}),
    ...(patch.colorTransitions ? { colorTransitions: [...patch.colorTransitions] } : {}),
    ...(patch.colorStepMs === undefined ? {} : { colorStepMs: patch.colorStepMs }),
    pattern: patch.pattern!,
    speed: patch.speed!,
    fadeMs: patch.fadeMs ?? DEFAULT_LIGHT_STATE.fadeMs,
    phaseOffset: patch.phaseOffset ?? DEFAULT_LIGHT_STATE.phaseOffset,
    patternStartedAt: Date.parse(now),
    ...(typeof patch.mediaUrl === 'string' && patch.mediaUrl ? { mediaUrl: patch.mediaUrl, mediaStartedAt: Date.parse(now) } : {}),
    ...(patch.mediaKind === 'image' || patch.mediaKind === 'video' ? { mediaKind: patch.mediaKind } : {}),
    ...(patch.mediaOpacity === undefined ? {} : { mediaOpacity: patch.mediaOpacity }),
    ...(patch.layers === undefined || patch.layers === null ? {} : { layers: patch.layers.map((layer) => ({ ...layer })) }),
  };
  return {
    id: input.id,
    name: input.name,
    ...(input.fixtureNumber === undefined ? {} : { fixtureNumber: input.fixtureNumber }),
    kind,
    ...(kind === 'wled' && wled ? { wled } : {}),
    ...(kind === 'dmx' && input.dmx ? { dmx: input.dmx } : {}),
    state,
    revision: 0,
    updatedAt: now,
  };
}

function validateCue(value: unknown, now: string): SceneResource {
  const input = validateCreateScene(value);
  return {
    id: input.id,
    name: input.name ?? `Cue ${input.id}`,
    stackId: input.stackId ?? 'main',
    ids: input.ids,
    state: { ...input.state },
    ...(input.scaleEffect === undefined ? {} : { scaleEffect: input.scaleEffect }),
    ...(input.effectDirection === undefined ? {} : { effectDirection: input.effectDirection }),
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function validateShowfile(value: unknown): ImportedShowfile {
  const record = asRecord(value, 'Showfile');
  rejectKeys(record, ['format', 'version', 'exportedAt', 'fixtures', 'cues', 'cueStacks', 'timecode', 'settings', 'media', 'dmxProfiles'], 'Showfile');
  if (record.format !== SHOWFILE_FORMAT || record.version !== 1) {
    throw new ApiError(400, 'unsupported_showfile', 'This is not a supported WebGlow showfile.');
  }
  const now = new Date().toISOString();
  if (!Array.isArray(record.fixtures) || record.fixtures.length > 512) {
    throw new ApiError(400, 'invalid_showfile', 'fixtures must contain no more than 512 fixtures.');
  }
  const fixtures = record.fixtures.map((fixture, index) => validateFixture(fixture, index, now));
  if (new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length) {
    throw new ApiError(400, 'invalid_showfile', 'Fixture IDs must be unique.');
  }
  const dmxProfiles = record.dmxProfiles === undefined ? [] : Array.isArray(record.dmxProfiles)
    ? record.dmxProfiles.map((profile) => validateDmxFixtureProfile(profile, { allowId: true }))
    : (() => { throw new ApiError(400, 'invalid_showfile', 'dmxProfiles must be a list of custom DMX profiles.'); })();
  if (new Set(dmxProfiles.map((profile) => profile.id)).size !== dmxProfiles.length || dmxProfiles.some((profile) => profile.id === STAIRVILLE_LED_PAR_64_PROFILE.id)) {
    throw new ApiError(400, 'invalid_showfile', 'DMX profile IDs must be unique and cannot replace a built-in profile.');
  }
  validateDmxPatch(fixtures, [STAIRVILLE_LED_PAR_64_PROFILE, ...dmxProfiles]);

  if (!Array.isArray(record.cues) || record.cues.length > 1_000) {
    throw new ApiError(400, 'invalid_showfile', 'cues must contain no more than 1,000 cues.');
  }
  const scenes = record.cues.map((cue) => validateCue(cue, now));
  if (new Set(scenes.map((scene) => scene.id)).size !== scenes.length) {
    throw new ApiError(400, 'invalid_showfile', 'Cue numbers must be unique.');
  }

  if (!Array.isArray(record.cueStacks) || record.cueStacks.length > 128) {
    throw new ApiError(400, 'invalid_showfile', 'cueStacks must contain no more than 128 stacks.');
  }
  const stacks = record.cueStacks.map((value, index): CueStackResource => {
    const stack = asRecord(value, `cueStacks[${index}]`);
    rejectKeys(stack, ['id', 'name', 'cueOrder'], `cueStacks[${index}]`);
    const id = validateCueStackId(stack.id);
    const name = validateName(stack.name);
    const cueOrder = stringArray(stack.cueOrder, `cueStacks[${index}].cueOrder`, 1_000).map(validateSceneId);
    if (new Set(cueOrder).size !== cueOrder.length) throw new ApiError(400, 'invalid_showfile', `cueStacks[${index}].cueOrder contains duplicates.`);
    return { id, name, cueOrder, updatedAt: now };
  });
  if (!stacks.some((stack) => stack.id === 'main')) stacks.unshift({ id: 'main', name: 'Main', cueOrder: [], updatedAt: now });
  if (new Set(stacks.map((stack) => stack.id)).size !== stacks.length || new Set(stacks.map((stack) => stack.name.toLocaleLowerCase())).size !== stacks.length) {
    throw new ApiError(400, 'invalid_showfile', 'Cue stack IDs and names must be unique.');
  }
  const stackById = new Map(stacks.map((stack) => [stack.id, stack]));
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  for (const scene of scenes) {
    const stack = stackById.get(scene.stackId);
    if (!stack) throw new ApiError(400, 'invalid_showfile', `Cue ${scene.id} references a missing cue stack.`);
    if (!stack.cueOrder.includes(scene.id)) stack.cueOrder.push(scene.id);
  }
  for (const stack of stacks) {
    if (stack.cueOrder.some((cueId) => sceneById.get(cueId)?.stackId !== stack.id)) {
      throw new ApiError(400, 'invalid_showfile', `Cue stack ${stack.name} contains an invalid cue reference.`);
    }
  }

  const timecode = validateTimecodeProgram(record.timecode);
  for (const sequence of timecode.sequences) {
    if (sequence.events.some((event) => !sceneById.has(event.cueId))) {
      throw new ApiError(400, 'invalid_showfile', `Timeline ${sequence.name} references a cue that is not in this showfile.`);
    }
  }

  const rawSettings = asRecord(record.settings, 'settings');
  rejectKeys(rawSettings, ['seatSections', 'virtualSubsectionsEnabled', 'virtualSubsectionsCount', 'fixtureSortMode', 'fixtureOrder'], 'settings');
  const seatSections = stringArray(rawSettings.seatSections, 'settings.seatSections', 12).map((name) => name.trim());
  if (seatSections.length < 1 || seatSections.some((name) => !name || name.length > 80) || new Set(seatSections.map((name) => name.toLocaleLowerCase())).size !== seatSections.length) {
    throw new ApiError(400, 'invalid_showfile', 'Section names must be unique and contain 1–80 characters.');
  }
  if (!['id', 'seat', 'custom'].includes(rawSettings.fixtureSortMode as string)) {
    throw new ApiError(400, 'invalid_showfile', 'settings.fixtureSortMode must be id, seat, or custom.');
  }
  const fixtureOrder = stringArray(rawSettings.fixtureOrder, 'settings.fixtureOrder', 512).map(validateLightId);
  if (new Set(fixtureOrder).size !== fixtureOrder.length) throw new ApiError(400, 'invalid_showfile', 'settings.fixtureOrder contains duplicates.');
  const virtualSubsectionsEnabled = rawSettings.virtualSubsectionsEnabled === undefined ? false : rawSettings.virtualSubsectionsEnabled;
  const virtualSubsectionsCount = rawSettings.virtualSubsectionsCount === undefined ? 3 : rawSettings.virtualSubsectionsCount;
  if (typeof virtualSubsectionsEnabled !== 'boolean' || !Number.isInteger(virtualSubsectionsCount) || (virtualSubsectionsCount as number) < 2 || (virtualSubsectionsCount as number) > 12) {
    throw new ApiError(400, 'invalid_showfile', 'Virtual subsections must be disabled/enabled and use a count from 2 to 12.');
  }

  const media: EmbeddedShowfileMedia[] = [];
  let mediaBytes = 0;
  if (record.media !== undefined) {
    if (!Array.isArray(record.media) || record.media.length > 512) throw new ApiError(400, 'invalid_showfile', 'media must contain no more than 512 assets.');
    const mediaIds = new Set<string>();
    record.media.forEach((value, index) => {
      const asset = asRecord(value, `media[${index}]`);
      rejectKeys(asset, ['id', 'contentType', 'dataBase64'], `media[${index}]`);
      if (typeof asset.id !== 'string' || !/^[0-9a-f-]{36}\.(jpg|png|webp|gif|mp4|webm)$/i.test(asset.id)) {
        throw new ApiError(400, 'invalid_showfile', `media[${index}].id is invalid.`);
      }
      if (mediaIds.has(asset.id)) throw new ApiError(400, 'invalid_showfile', 'Media asset IDs must be unique.');
      mediaIds.add(asset.id);
      const extension = asset.id.slice(asset.id.lastIndexOf('.')).toLowerCase();
      if (asset.contentType !== MEDIA_TYPES_BY_EXTENSION[extension]) throw new ApiError(400, 'invalid_showfile', `media[${index}] has an unsupported media type.`);
      if (typeof asset.dataBase64 !== 'string' || asset.dataBase64.length > SHOWFILE_MAX_MEDIA_BYTES * 4 / 3 + 8 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.dataBase64)) {
        throw new ApiError(400, 'invalid_showfile', `media[${index}].dataBase64 is invalid or too large.`);
      }
      const bytes = Buffer.from(asset.dataBase64, 'base64');
      if (bytes.toString('base64') !== asset.dataBase64 || bytes.byteLength === 0) throw new ApiError(400, 'invalid_showfile', `media[${index}].dataBase64 is not valid base64 data.`);
      mediaBytes += bytes.byteLength;
      if (mediaBytes > SHOWFILE_MAX_MEDIA_BYTES) throw new ApiError(413, 'showfile_media_too_large', 'Bundled media cannot exceed 200 MB in total.');
      media.push({ id: asset.id, contentType: asset.contentType, bytes });
    });
  }

  return {
    fixtures,
    scenes,
    stacks,
    timecode,
    settings: {
      seatSections,
      virtualSubsectionsEnabled,
      virtualSubsectionsCount: virtualSubsectionsCount as number,
      fixtureSortMode: rawSettings.fixtureSortMode as 'id' | 'seat' | 'custom',
      fixtureOrder,
    },
    media,
    dmxProfiles,
  };
}

export function mediaContentType(id: string): string | undefined {
  return MEDIA_TYPES_BY_EXTENSION[id.slice(id.lastIndexOf('.')).toLowerCase()];
}
