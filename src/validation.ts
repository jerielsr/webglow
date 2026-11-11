import { ApiError } from './errors.js';
import { isPattern, type CreateLightInput, type CreateSceneInput, type LightPatch, type WledFixtureConfig } from './types.js';

export interface BatchLightPatchInput {
  ids: 'all' | string[];
  state: LightPatch;
}

export interface ChaseInput {
  ids: 'all' | string[];
  speed: number;
  fadeMs: number;
  color?: string;
  on?: boolean;
}

const LIGHT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SCENE_ID_PATTERN = /^\d{1,3}(?:\.\d{1,3})?$/;

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
  rejectUnknownKeys(record, ['id', 'name', 'kind', 'wled']);

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
  if (record.kind !== undefined && record.kind !== 'display' && record.kind !== 'wled') {
    throw new ApiError(400, 'invalid_request', 'kind must be "display" or "wled".', { field: 'kind' });
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

  return input;
}

export function validateLightPatch(value: unknown): LightPatch {
  const record = asRecord(value, 'The request body');
  rejectUnknownKeys(record, [
    'name',
    'on',
    'brightness',
    'color',
    'pattern',
    'speed',
    'fadeMs',
    'phaseOffset',
    'expectedRevision',
    'mediaUrl',
    'mediaKind',
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
  if (record.pattern !== undefined) {
    if (!isPattern(record.pattern)) {
      throw new ApiError(
        400,
        'invalid_request',
        'pattern must be one of solid, breathe, pulse, strobe, rainbow, chase, or twinkle.',
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
  rejectUnknownKeys(record, ['ids', 'state']);
  const ids = validateTargetIds(record.ids);
  const state = validateLightPatch(record.state);
  if (state.name !== undefined || state.expectedRevision !== undefined) {
    throw new ApiError(400, 'invalid_request', 'Batch state can only change light output fields.', { field: 'state' });
  }
  return { ids, state };
}

export function validateChase(value: unknown): ChaseInput {
  const record = asRecord(value, 'The request body');
  rejectUnknownKeys(record, ['ids', 'speed', 'fadeMs', 'color', 'on']);
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
  return input;
}

export function validateCreateScene(value: unknown): CreateSceneInput {
  const record = asRecord(value, 'The request body');
  rejectUnknownKeys(record, ['id', 'name', 'ids', 'state', 'scaleEffect']);
  const id = validateSceneId(record.id);
  const ids = validateTargetIds(record.ids);
  const state = validateLightPatch(record.state);
  if (state.name !== undefined || state.expectedRevision !== undefined || state.phaseOffset !== undefined) {
    throw new ApiError(400, 'invalid_request', 'Cue state can only include output fields.', { field: 'state' });
  }
  if (record.scaleEffect !== undefined && typeof record.scaleEffect !== 'boolean') {
    throw new ApiError(400, 'invalid_request', 'scaleEffect must be a boolean.', { field: 'scaleEffect' });
  }
  const input: CreateSceneInput = {
    id,
    ids,
    state,
    ...(record.scaleEffect === undefined ? {} : { scaleEffect: record.scaleEffect as boolean }),
  };
  if (record.name !== undefined) {
    input.name = validateName(record.name);
  }
  return input;
}
