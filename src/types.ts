export const PATTERNS = ['solid', 'breathe', 'pulse', 'strobe', 'rainbow', 'chase', 'twinkle'] as const;

export type Pattern = (typeof PATTERNS)[number];

export const FIXTURE_KINDS = ['display', 'wled'] as const;

export type FixtureKind = (typeof FIXTURE_KINDS)[number];

/**
 * Connection details for a physical WLED fixture. The effect map is learned
 * while the fixture is added, so semantic WebGlow patterns can select the
 * closest available WLED effect without hard-coding a firmware-specific ID.
 */
export interface WledFixtureConfig {
  url: string;
  segment: number;
  effectMap?: Partial<Record<Pattern, number>>;
}

/** Identifies a browser display created through the public guest join page. */
export interface GuestFixtureConfig {
  registeredAt: string;
  displayName: string;
}

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
  /** Transition duration used when the display receives a new state. */
  fadeMs: number;
  /** Position within a multi-light effect, from 0 to 1. */
  phaseOffset: number;
  /** Unix epoch milliseconds used to keep independently rendered patterns in step. */
  patternStartedAt: number;
}

export interface LightResource {
  id: string;
  name: string;
  kind: FixtureKind;
  /** Present only for a physical WLED fixture. */
  wled?: WledFixtureConfig;
  /** Present only for a display registered by a guest. */
  guest?: GuestFixtureConfig;
  state: LightState;
  revision: number;
  updatedAt: string;
}

export interface CreateLightInput {
  id?: string;
  name?: string;
  kind?: FixtureKind;
  wled?: WledFixtureConfig;
  guest?: GuestFixtureConfig;
}

export interface LightPatch {
  name?: string;
  on?: boolean;
  brightness?: number;
  color?: string;
  pattern?: Pattern;
  speed?: number;
  fadeMs?: number;
  phaseOffset?: number;
  expectedRevision?: number;
}

/** A saved console cue. The state is applied to its targets when the cue is run. */
export interface SceneResource {
  id: string;
  name: string;
  ids: 'all' | string[];
  state: LightPatch;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSceneInput {
  id: string;
  name?: string;
  ids: 'all' | string[];
  state: LightPatch;
}

export const DEFAULT_LIGHT_STATE: Omit<LightState, 'patternStartedAt'> = {
  on: false,
  brightness: 100,
  color: '#FFFFFF',
  pattern: 'solid',
  speed: 50,
  fadeMs: 0,
  phaseOffset: 0,
};

export function isPattern(value: unknown): value is Pattern {
  return typeof value === 'string' && PATTERNS.includes(value as Pattern);
}
