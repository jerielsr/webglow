export const PATTERNS = ['solid', 'pulse', 'strobe', 'rainbow'] as const;

export type Pattern = (typeof PATTERNS)[number];

export interface LightState {
  /** Whether the display should emit light. Settings are retained while off. */
  on: boolean;
  /** Rendered brightness from 0 to 100. This cannot change a device's hardware backlight. */
  brightness: number;
  /** A normalized six-digit CSS hex color. */
  color: string;
  pattern: Pattern;
  /** Pattern speed from 0 (slowest) to 100 (fastest). */
  speed: number;
  /** Unix epoch milliseconds used to keep independently rendered patterns in step. */
  patternStartedAt: number;
}

export interface LightResource {
  id: string;
  name: string;
  state: LightState;
  revision: number;
  updatedAt: string;
}

export interface CreateLightInput {
  id?: string;
  name?: string;
}

export interface LightPatch {
  name?: string;
  on?: boolean;
  brightness?: number;
  color?: string;
  pattern?: Pattern;
  speed?: number;
  expectedRevision?: number;
}

export const DEFAULT_LIGHT_STATE: Omit<LightState, 'patternStartedAt'> = {
  on: false,
  brightness: 100,
  color: '#FFFFFF',
  pattern: 'solid',
  speed: 50,
};

export function isPattern(value: unknown): value is Pattern {
  return typeof value === 'string' && PATTERNS.includes(value as Pattern);
}
