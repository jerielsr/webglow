import { ApiError } from './errors.js';
import { validateDmxFixtureConfig } from './dmx.js';
import {
  isPattern,
  TIMECODE_RATES,
  type CreateLightInput,
  type CreateSceneInput,
  type ColorTransition,
  type EffectDirection,
  type LightPatch,
  type TimecodeProgram,
  type TimecodeRate,
  type UpdateSceneInput,
  type VisualEffectLayer,
  VISUAL_LAYER_PATTERNS,
  type WledFixtureConfig,
} from './types.js';

export interface BatchLightPatchInput {
  ids: 'all' | string[];
  state: LightPatch;
  direction?: EffectDirection;
}

export interface ChaseInput {
  ids: 'all' | string[];
  speed: number;
  fadeMs: number;
  color?: string;
  on?: boolean;
  direction?: EffectDirection;
}

const LIGHT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SCENE_ID_PATTERN = /^\d{1,3}(?:\.\d{1,3})?$/;
const EFFECT_DIRECTIONS = ['forward', 'reverse', 'front-to-back', 'back-to-front', 'diagonal-left', 'diagonal-right', 'center-out', 'edges-in', 'random'] as const;

function asRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'invalid_request', `${subject} must be a JSON object.`);
  }

  return value as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowedKeys: string[]): void {
  const unknownKeys = Object.keys(record).filter((key) => !allowedKeys.includes(key));

  if (unknownKeys.length > 0) {
    throw new ApiError(400, 'invalid_request', 'The request contains unsupported fields.', {
      fields: unknownKeys,
    });
  }
}

function validateNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new ApiError(400, 'invalid_request', `${field} must be a number from 0 to 100.`, {
      field,
    });
  }

  return value;
}

function validateBoundedNumber(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ApiError(400, 'invalid_request', `${field} must be a number from ${minimum} to ${maximum}.`, {
      field,
    });
  }

  return value;
}

function validateTargetIds(value: unknown): 'all' | string[] {
  if (value === 'all') {
    return value;
  }

  if (!Array.isArray(value) || value.length === 0 || !value.every((id) => typeof id === 'string')) {
    throw new ApiError(400, 'invalid_request', 'ids must be "all" or a non-empty array of light IDs.', {
      field: 'ids',
    });
  }

  const ids = value.map((id) => validateLightId(id));
  if (new Set(ids).size !== ids.length) {
    throw new ApiError(400, 'invalid_request', 'ids must not contain duplicates.', { field: 'ids' });
  }

  return ids;
}

export function validateLightId(value: string): string {
  if (!LIGHT_ID_PATTERN.test(value)) {
    throw new ApiError(
      400,
      'invalid_light_id',
      'Light IDs must be 1–64 characters using letters, numbers, underscores, or hyphens.',
      { value },
    );
  }

  return value;
}

export function validateSceneId(value: unknown): string {
  if (typeof value !== 'string' || !SCENE_ID_PATTERN.test(value.trim())) {
    throw new ApiError(
      400,
      'invalid_scene_id',
      'Cue numbers must use up to three digits, with an optional decimal part such as 1 or 12.5.',
      { field: 'id' },
    );
  }
  return value.trim();
}

export function validateCueStackId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    throw new ApiError(400, 'invalid_cue_stack_id', 'Cue stack IDs must use 1–64 letters, numbers, underscores, or hyphens.', { field: 'stackId' });
  }
  return value;
}

export function validateName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_request', 'name must be a string.', { field: 'name' });
  }

  const name = value.trim();
  if (name.length < 1 || name.length > 80) {
    throw new ApiError(400, 'invalid_request', 'name must contain 1–80 characters.', {
      field: 'name',
    });
  }

  return name;
}

export function normalizeColor(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_request', 'color must be a CSS hex color.', { field: 'color' });
  }

  const match = value.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) {
    throw new ApiError(400, 'invalid_request', 'color must be a three- or six-digit CSS hex color.', {
      field: 'color',
    });
  }

  const hex = match[1].toUpperCase();
  const expanded = hex.length === 3 ? [...hex].map((part) => `${part}${part}`).join('') : hex;
  return `#${expanded}`;
}

function validateVisualLayers(value: unknown): VisualEffectLayer[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new ApiError(400, 'invalid_request', 'layers must be a list of up to 8 visual layers.', { field: 'layers' });
  }
  return value.map((entry, index) => {
    const record = asRecord(entry, `layers[${index}]`);
    rejectUnknownKeys(record, ['id', 'pattern', 'color', 'opacity', 'density', 'size', 'speed']);
    if (typeof record.id !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(record.id)) {
      throw new ApiError(400, 'invalid_request', `layers[${index}].id must be a short identifier.`, { field: 'layers' });
    }
    if (!VISUAL_LAYER_PATTERNS.includes(record.pattern as (typeof VISUAL_LAYER_PATTERNS)[number])) {
      throw new ApiError(400, 'invalid_request', `layers[${index}].pattern must be snowflakes, squares, or orbit.`, { field: 'layers' });
    }
    if (!Number.isInteger(record.density)) {
      throw new ApiError(400, 'invalid_request', `layers[${index}].density must be an integer from 1 to 120.`, { field: 'layers' });
    }
    return {
      id: record.id,
      pattern: record.pattern as VisualEffectLayer['pattern'],
      color: normalizeColor(record.color),
      opacity: validateNumber(record.opacity, `layers[${index}].opacity`),
      density: validateBoundedNumber(record.density, `layers[${index}].density`, 1, 120),
      size: validateBoundedNumber(record.size, `layers[${index}].size`, 8, 100),
      speed: validateNumber(record.speed, `layers[${index}].speed`),
    };
  });
}

function validateWledConfig(value: unknown): WledFixtureConfig {
  const record = asRecord(value, 'wled');
  rejectUnknownKeys(record, ['url', 'segment']);
  if (typeof record.url !== 'string') {
    throw new ApiError(400, 'invalid_request', 'wled.url must be an HTTP or HTTPS URL.', { field: 'wled.url' });
  }

  let url: URL;
  try {
    url = new URL(record.url.trim());
  } catch {
    throw new ApiError(400, 'invalid_request', 'wled.url must be an HTTP or HTTPS URL.', { field: 'wled.url' });
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
      'wled.url must be a plain HTTP or HTTPS address without credentials, query text, or a fragment.',
      { field: 'wled.url' },
    );
  }

  const segment = record.segment === undefined ? 0 : record.segment;
  if (!Number.isInteger(segment) || (segment as number) < 0 || (segment as number) > 255) {
    throw new ApiError(400, 'invalid_request', 'wled.segment must be an integer from 0 to 255.', {
      field: 'wled.segment',
    });
  }

  return { url: url.toString().replace(/\/$/, ''), segment: segment as number };
}

export function validateCreateLight(value: unknown): CreateLightInput {
  if (value === undefined || value === null) {
    return {};
  }

  const record = asRecord(value, 'The request body');
  rejectUnknownKeys(record, ['id', 'name', 'fixtureNumber', 'kind', 'wled', 'dmx']);

  const input: CreateLightInput = {};
  if (record.id !== undefined) {
    if (typeof record.id !== 'string') {
      throw new ApiError(400, 'invalid_request', 'id must be a string.', { field: 'id' });
    }
    input.id = validateLightId(record.id);
  }
  if (record.name !== undefined) {
    input.name = validateName(record.name);
  }
  if (record.fixtureNumber !== undefined) {
    if (!Number.isInteger(record.fixtureNumber) || (record.fixtureNumber as number) < 1 || (record.fixtureNumber as number) > 9999) {
      throw new ApiError(400, 'invalid_request', 'fixtureNumber must be an integer from 1 to 9999.', { field: 'fixtureNumber' });
    }
    input.fixtureNumber = record.fixtureNumber as number;
  }
  if (record.kind !== undefined && record.kind !== 'display' && record.kind !== 'wled' && record.kind !== 'dmx') {
    throw new ApiError(400, 'invalid_request', 'kind must be "display", "wled", or "dmx".', { field: 'kind' });
  }
  const kind = record.kind ?? 'display';
  if (kind === 'wled') {
    if (record.wled === undefined) {
      throw new ApiError(400, 'invalid_request', 'wled is required when kind is "wled".', { field: 'wled' });
    }
    input.kind = 'wled';
    input.wled = validateWledConfig(record.wled);
  } else if (record.wled !== undefined) {
    throw new ApiError(400, 'invalid_request', 'wled can only be provided when kind is "wled".', { field: 'wled' });
  }
  if (kind === 'dmx') {
    if (record.dmx === undefined) throw new ApiError(400, 'invalid_request', 'dmx is required when kind is "dmx".', { field: 'dmx' });
    input.kind = 'dmx';
    input.dmx = validateDmxFixtureConfig(record.dmx);
  } else if (record.dmx !== undefined) {
    throw new ApiError(400, 'invalid_request', 'dmx can only be provided when kind is "dmx".', { field: 'dmx' });
  }

  return input;
}

export function validateLightPatch(value: unknown): LightPatch {
  const record = asRecord(value, 'The request body');
  rejectUnknownKeys(record, [
    'name',
    'fixtureNumber',
    'on',
    'brightness',
    'color',
    'colors',
    'colorTransition',
    'colorTransitions',
    'colorStepMs',
    'pattern',
    'speed',
    'fadeMs',
    'phaseOffset',
    'expectedRevision',
    'mediaUrl',
    'mediaKind',
    'mediaOpacity',
    'layers',
  ]);

  if (Object.keys(record).length === 0) {
    throw new ApiError(400, 'invalid_request', 'Provide at least one field to update.');
  }

  const patch: LightPatch = {};
  if (record.name !== undefined) {
    patch.name = validateName(record.name);
  }
  if (record.on !== undefined) {
    if (typeof record.on !== 'boolean') {
      throw new ApiError(400, 'invalid_request', 'on must be a boolean.', { field: 'on' });
    }
    patch.on = record.on;
  }
  if (record.brightness !== undefined) {
    patch.brightness = validateNumber(record.brightness, 'brightness');
  }
  if (record.color !== undefined) {
    patch.color = normalizeColor(record.color);
  }
  if (record.colors !== undefined) {
    if (!Array.isArray(record.colors) || record.colors.length < 2 || record.colors.length > 8) {
      throw new ApiError(400, 'invalid_request', 'colors must contain between 2 and 8 hex colours.', { field: 'colors' });
    }
    patch.colors = record.colors.map(normalizeColor);
  }
  if (record.colorTransition !== undefined) {
    if (!['snap', 'fade', 'ramp-up', 'ramp-down', 'ramp'].includes(record.colorTransition as string)) {
      throw new ApiError(400, 'invalid_request', 'colorTransition must be snap, fade, ramp-up, or ramp-down.', { field: 'colorTransition' });
    }
    patch.colorTransition = (record.colorTransition === 'ramp' ? 'ramp-up' : record.colorTransition) as ColorTransition;
  }
  if (record.colorTransitions !== undefined) {
    if (!Array.isArray(record.colorTransitions) || record.colorTransitions.length < 2 || record.colorTransitions.length > 8) {
      throw new ApiError(400, 'invalid_request', 'colorTransitions must contain between 2 and 8 transition values.', { field: 'colorTransitions' });
    }
    patch.colorTransitions = record.colorTransitions.map((transition, index) => {
      if (!['snap', 'fade', 'ramp-up', 'ramp-down', 'ramp'].includes(transition as string)) {
        throw new ApiError(400, 'invalid_request', `colorTransitions[${index}] must be snap, fade, ramp-up, or ramp-down.`, { field: `colorTransitions[${index}]` });
      }
      return (transition === 'ramp' ? 'ramp-up' : transition) as ColorTransition;
    });
    if (record.colors !== undefined && Array.isArray(record.colors) && record.colorTransitions.length !== record.colors.length) {
      throw new ApiError(400, 'invalid_request', 'colorTransitions must contain one transition for each colour.', { field: 'colorTransitions' });
    }
  }
  if (record.colorStepMs !== undefined) {
    if (!Number.isInteger(record.colorStepMs)) {
      throw new ApiError(400, 'invalid_request', 'colorStepMs must be an integer from 100 to 60000 milliseconds.', { field: 'colorStepMs' });
    }
    patch.colorStepMs = validateBoundedNumber(record.colorStepMs, 'colorStepMs', 100, 60_000);
  }
  if (record.fixtureNumber !== undefined) {
    if (!Number.isInteger(record.fixtureNumber) || (record.fixtureNumber as number) < 1 || (record.fixtureNumber as number) > 9999) {
      throw new ApiError(400, 'invalid_request', 'fixtureNumber must be an integer from 1 to 9999.', { field: 'fixtureNumber' });
    }
    patch.fixtureNumber = record.fixtureNumber as number;
  }
  if (record.pattern !== undefined) {
    if (!isPattern(record.pattern)) {
      throw new ApiError(
        400,
        'invalid_request',
        'pattern must be a supported WebGlow pattern.',
        {
        field: 'pattern',
        },
      );
    }
    patch.pattern = record.pattern;
  }
  if (record.speed !== undefined) {
    patch.speed = validateNumber(record.speed, 'speed');
  }
  if (record.fadeMs !== undefined) {
    patch.fadeMs = validateBoundedNumber(record.fadeMs, 'fadeMs', 0, 60_000);
  }
  if (record.phaseOffset !== undefined) {
    patch.phaseOffset = validateBoundedNumber(record.phaseOffset, 'phaseOffset', 0, 1);
  }
  if (record.mediaUrl !== undefined) {
    if (record.mediaUrl !== null && (typeof record.mediaUrl !== 'string' || !/^\/media\/[0-9a-f-]{36}\.(jpg|png|webp|gif|mp4|webm)$/i.test(record.mediaUrl))) {
      throw new ApiError(400, 'invalid_request', 'mediaUrl must be a WebGlow media asset path or null.', { field: 'mediaUrl' });
    }
    patch.mediaUrl = record.mediaUrl as string | null;
  }
  if (record.mediaKind !== undefined) {
    if (record.mediaKind !== null && record.mediaKind !== 'image' && record.mediaKind !== 'video') {
      throw new ApiError(400, 'invalid_request', 'mediaKind must be image, video, or null.', { field: 'mediaKind' });
    }
    patch.mediaKind = record.mediaKind as 'image' | 'video' | null;
  }
  if (record.mediaOpacity !== undefined) {
    patch.mediaOpacity = validateNumber(record.mediaOpacity, 'mediaOpacity');
  }
  if (record.layers !== undefined) {
    patch.layers = record.layers === null ? null : validateVisualLayers(record.layers);
  }
  if (record.expectedRevision !== undefined) {
    if (!Number.isInteger(record.expectedRevision) || (record.expectedRevision as number) < 0) {
      throw new ApiError(400, 'invalid_request', 'expectedRevision must be a non-negative integer.', {
        field: 'expectedRevision',
      });
    }
    patch.expectedRevision = record.expectedRevision as number;
  }

  return patch;
}

export function validateBatchLightPatch(value: unknown): BatchLightPatchInput {
  const record = asRecord(value, 'The request body');
  rejectUnknownKeys(record, ['ids', 'state', 'direction']);
  const ids = validateTargetIds(record.ids);
  const state = validateLightPatch(record.state);
  if (state.name !== undefined || state.expectedRevision !== undefined) {
    throw new ApiError(400, 'invalid_request', 'Batch state can only change light output fields.', { field: 'state' });
  }
  if (record.direction !== undefined && !EFFECT_DIRECTIONS.includes(record.direction as (typeof EFFECT_DIRECTIONS)[number])) {
    throw new ApiError(400, 'invalid_request', 'direction must be a supported fixture or section direction.', { field: 'direction' });
  }
  if (state.fixtureNumber !== undefined) throw new ApiError(400, 'invalid_request', 'Batch state cannot change fixture numbers.', { field: 'state.fixtureNumber' });
  return { ids, state, ...(record.direction === undefined ? {} : { direction: record.direction as EffectDirection }) };
}

export function validateChase(value: unknown): ChaseInput {
  const record = asRecord(value, 'The request body');
  rejectUnknownKeys(record, ['ids', 'speed', 'fadeMs', 'color', 'on', 'direction']);
  const ids = validateTargetIds(record.ids);
  const speed = validateNumber(record.speed, 'speed');
  const fadeMs =
    record.fadeMs === undefined ? 0 : validateBoundedNumber(record.fadeMs, 'fadeMs', 0, 60_000);
  const input: ChaseInput = { ids, speed, fadeMs };
  if (record.color !== undefined) {
    input.color = normalizeColor(record.color);
  }
  if (record.on !== undefined) {
    if (typeof record.on !== 'boolean') {
      throw new ApiError(400, 'invalid_request', 'on must be a boolean.', { field: 'on' });
    }
    input.on = record.on;
  }
  if (record.direction !== undefined) {
    if (!EFFECT_DIRECTIONS.includes(record.direction as (typeof EFFECT_DIRECTIONS)[number])) {
      throw new ApiError(400, 'invalid_request', 'direction must be a supported fixture or section direction.', { field: 'direction' });
    }
    input.direction = record.direction as EffectDirection;
  }
  return input;
}

export function validateCreateScene(value: unknown): CreateSceneInput {
  const record = asRecord(value, 'The request body');
  rejectUnknownKeys(record, ['id', 'name', 'stackId', 'ids', 'state', 'scaleEffect', 'effectDirection']);
  const id = validateSceneId(record.id);
  const ids = validateTargetIds(record.ids);
  const state = validateLightPatch(record.state);
  if (state.name !== undefined || state.fixtureNumber !== undefined || state.expectedRevision !== undefined || state.phaseOffset !== undefined) {
    throw new ApiError(400, 'invalid_request', 'Cue state can only include output fields.', { field: 'state' });
  }
  if (record.scaleEffect !== undefined && typeof record.scaleEffect !== 'boolean') {
    throw new ApiError(400, 'invalid_request', 'scaleEffect must be a boolean.', { field: 'scaleEffect' });
  }
  if (record.effectDirection !== undefined && !EFFECT_DIRECTIONS.includes(record.effectDirection as (typeof EFFECT_DIRECTIONS)[number])) {
    throw new ApiError(400, 'invalid_request', 'effectDirection must be a supported fixture or section direction.', { field: 'effectDirection' });
  }
  const input: CreateSceneInput = {
    id,
    ids,
    state,
    ...(record.scaleEffect === undefined ? {} : { scaleEffect: record.scaleEffect as boolean }),
    ...(record.effectDirection === undefined ? {} : { effectDirection: record.effectDirection as EffectDirection }),
  };
  if (record.name !== undefined) {
    input.name = validateName(record.name);
  }
  if (record.stackId !== undefined) input.stackId = validateCueStackId(record.stackId);
  return input;
}

export function validateUpdateScene(value: unknown): UpdateSceneInput {
  const record = asRecord(value, 'The request body');
  rejectUnknownKeys(record, ['name', 'stackId', 'ids', 'state', 'scaleEffect', 'effectDirection']);
  const input: UpdateSceneInput = {};
  if (record.name !== undefined) input.name = validateName(record.name);
  if (record.stackId !== undefined) input.stackId = validateCueStackId(record.stackId);
  if (record.ids !== undefined) input.ids = validateTargetIds(record.ids);
  if (record.state !== undefined) {
    const state = validateLightPatch(record.state);
    if (state.name !== undefined || state.fixtureNumber !== undefined || state.expectedRevision !== undefined || state.phaseOffset !== undefined) {
      throw new ApiError(400, 'invalid_request', 'Cue state can only include output fields.', { field: 'state' });
    }
    input.state = state;
  }
  if (record.scaleEffect !== undefined) {
    if (typeof record.scaleEffect !== 'boolean') throw new ApiError(400, 'invalid_request', 'scaleEffect must be a boolean.', { field: 'scaleEffect' });
    input.scaleEffect = record.scaleEffect;
  }
  if (record.effectDirection !== undefined) {
    if (!EFFECT_DIRECTIONS.includes(record.effectDirection as (typeof EFFECT_DIRECTIONS)[number])) throw new ApiError(400, 'invalid_request', 'effectDirection must be a supported fixture or section direction.', { field: 'effectDirection' });
    input.effectDirection = record.effectDirection as CreateSceneInput['effectDirection'];
  }
  if (!Object.keys(input).length) throw new ApiError(400, 'invalid_request', 'Provide at least one cue field to update.');
  return input;
}

function timecodeDayFrames(rate: TimecodeRate): number {
  const nominal = rate === '23.976' || rate === '24' ? 24 : rate === '25' ? 25 : 30;
  const drop = rate === '29.97df' ? 2 : 0;
  return nominal * 86_400 - drop * (1_440 - 144);
}

function validateTimelineId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    throw new ApiError(400, 'invalid_timecode_program', `${field} must be 1–64 letters, numbers, underscores, or hyphens.`, { field });
  }
  return value;
}

function validateTimelineFrame(value: unknown, field: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= maximum) {
    throw new ApiError(400, 'invalid_timecode_program', `${field} must be a frame number within the 24-hour timecode day.`, { field });
  }
  return value;
}

export function validateTimecodeProgram(value: unknown): TimecodeProgram {
  const record = asRecord(value, 'The timecode program');
  rejectUnknownKeys(record, ['frameRate', 'sequences', 'segments']);
  if (typeof record.frameRate !== 'string' || !TIMECODE_RATES.includes(record.frameRate as TimecodeRate)) {
    throw new ApiError(400, 'invalid_timecode_program', 'frameRate must be 23.976, 24, 25, 29.97df, or 30.', { field: 'frameRate' });
  }
  const frameRate = record.frameRate as TimecodeRate;
  const maximum = timecodeDayFrames(frameRate);
  if (!Array.isArray(record.sequences) || record.sequences.length > 128) {
    throw new ApiError(400, 'invalid_timecode_program', 'sequences must contain no more than 128 timelines.', { field: 'sequences' });
  }
  if (!Array.isArray(record.segments) || record.segments.length > 256) {
    throw new ApiError(400, 'invalid_timecode_program', 'segments must contain no more than 256 show placements.', { field: 'segments' });
  }
  const sequenceIds = new Set<string>();
  const eventIds = new Set<string>();
  const sequences = record.sequences.map((value, sequenceIndex) => {
    const sequence = asRecord(value, `sequences[${sequenceIndex}]`);
    rejectUnknownKeys(sequence, ['id', 'name', 'sourceStartFrame', 'events']);
    const id = validateTimelineId(sequence.id, `sequences[${sequenceIndex}].id`);
    if (sequenceIds.has(id)) throw new ApiError(400, 'invalid_timecode_program', 'Sequence IDs must be unique.', { field: 'sequences' });
    sequenceIds.add(id);
    const name = validateName(sequence.name);
    const sourceStartFrame = sequence.sourceStartFrame === undefined
      ? undefined
      : validateTimelineFrame(sequence.sourceStartFrame, `sequences[${sequenceIndex}].sourceStartFrame`, maximum);
    if (!Array.isArray(sequence.events) || sequence.events.length > 1_000) {
      throw new ApiError(400, 'invalid_timecode_program', 'Each timeline can contain no more than 1,000 cue events.', { field: `sequences[${sequenceIndex}].events` });
    }
    const events = sequence.events.map((value, eventIndex) => {
      const event = asRecord(value, `sequences[${sequenceIndex}].events[${eventIndex}]`);
      rejectUnknownKeys(event, ['id', 'frame', 'cueId']);
      const eventId = validateTimelineId(event.id, `sequences[${sequenceIndex}].events[${eventIndex}].id`);
      if (eventIds.has(eventId)) throw new ApiError(400, 'invalid_timecode_program', 'Cue event IDs must be unique.', { field: 'sequences' });
      eventIds.add(eventId);
      return {
        id: eventId,
        frame: validateTimelineFrame(event.frame, `sequences[${sequenceIndex}].events[${eventIndex}].frame`, maximum),
        cueId: validateSceneId(event.cueId),
      };
    }).sort((left, right) => left.frame - right.frame);
    return { id, name, ...(sourceStartFrame === undefined ? {} : { sourceStartFrame }), events };
  });
  const segmentIds = new Set<string>();
  const segments = record.segments.map((value, segmentIndex) => {
    const segment = asRecord(value, `segments[${segmentIndex}]`);
    rejectUnknownKeys(segment, ['id', 'sequenceId', 'startFrame']);
    const id = validateTimelineId(segment.id, `segments[${segmentIndex}].id`);
    if (segmentIds.has(id)) throw new ApiError(400, 'invalid_timecode_program', 'Show placement IDs must be unique.', { field: 'segments' });
    segmentIds.add(id);
    const sequenceId = validateTimelineId(segment.sequenceId, `segments[${segmentIndex}].sequenceId`);
    if (!sequenceIds.has(sequenceId)) throw new ApiError(400, 'invalid_timecode_program', 'Every show placement must reference an existing timeline.', { field: `segments[${segmentIndex}].sequenceId` });
    return { id, sequenceId, startFrame: validateTimelineFrame(segment.startFrame, `segments[${segmentIndex}].startFrame`, maximum) };
  }).sort((left, right) => left.startFrame - right.startFrame);
  return { frameRate, sequences, segments };
}
