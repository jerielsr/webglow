import { ApiError } from './errors.js';
import { isPattern, type CreateLightInput, type LightPatch } from './types.js';

const LIGHT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

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

export function validateCreateLight(value: unknown): CreateLightInput {
  if (value === undefined || value === null) {
    return {};
  }

  const record = asRecord(value, 'The request body');
  rejectUnknownKeys(record, ['id', 'name']);

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

  return input;
}

export function validateLightPatch(value: unknown): LightPatch {
  const record = asRecord(value, 'The request body');
  rejectUnknownKeys(record, ['name', 'on', 'brightness', 'color', 'pattern', 'speed', 'expectedRevision']);

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
      throw new ApiError(400, 'invalid_request', 'pattern must be one of solid, pulse, strobe, or rainbow.', {
        field: 'pattern',
      });
    }
    patch.pattern = record.pattern;
  }
  if (record.speed !== undefined) {
    patch.speed = validateNumber(record.speed, 'speed');
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
