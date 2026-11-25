export const PATTERNS = ['solid', 'breathe', 'pulse', 'strobe', 'rainbow', 'chase', 'twinkle', 'ramp-up', 'ramp-down', 'multi-chase'] as const;

export type Pattern = (typeof PATTERNS)[number];
export type ColorTransition = 'snap' | 'fade' | 'ramp-up' | 'ramp-down';
export type EffectDirection = 'forward' | 'reverse' | 'front-to-back' | 'back-to-front' | 'diagonal-left' | 'diagonal-right' | 'center-out' | 'edges-in' | 'random';

export const FIXTURE_KINDS = ['display', 'wled', 'dmx'] as const;

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

export type DmxChannelFunction = 'operation' | 'red' | 'green' | 'blue' | 'dimmer' | 'speed' | 'fixed';

export interface DmxProfileChannel {
  name: string;
  function: DmxChannelFunction;
  /** Value used by fixed channels, from 0 to 255. */
  fixedValue?: number;
  /** DMX values to use for a fixture's built-in operation modes. */
  operationValues?: Partial<Record<Pattern, number>>;
}

export interface DmxFixtureProfile {
  id: string;
  name: string;
  builtIn?: boolean;
  channels: DmxProfileChannel[];
}

export interface DmxFixtureConfig {
  profileId: string;
  /** DMX start address, in the user-facing 1–512 range. */
  startAddress: number;
}

/** Identifies a browser display created through the public guest join page. */
export interface GuestFixtureConfig {
  registeredAt: string;
  displayName: string;
  lastSeenAt?: string;
  /** Operator-defined seating section used to orient guest-light effects. */
  section?: string;
  /** Guest agreed that WebGlow may request an automatic screen wake lock. */
  keepAwake?: boolean;
  /** Hash of the browser's opaque resume token; never sent to guest displays. */
  sessionTokenHash?: string;
}

export const VISUAL_LAYER_PATTERNS = ['snowflakes', 'squares', 'orbit'] as const;
export type VisualLayerPattern = (typeof VISUAL_LAYER_PATTERNS)[number];

/** A lightweight procedural overlay drawn above the display's base lighting. */
export interface VisualEffectLayer {
  id: string;
  pattern: VisualLayerPattern;
  color: string;
  opacity: number;
  density: number;
  size: number;
  speed: number;
}

export interface LightState {
  /** Whether the display should emit light. Settings are retained while off. */
  on: boolean;
  /** Rendered brightness from 0 to 100. This cannot change a device's hardware backlight. */
  brightness: number;
  /** A normalized six-digit CSS hex color. */
  color: string;
  /** Optional colour sequence used by multi-chase programming. */
  colors?: string[];
  /** How a multi-colour chase transitions from one palette colour to the next. */
  /** @deprecated Use colorTransitions to configure each palette step. */
  colorTransition?: ColorTransition;
  /** Transition from each colour to the following colour; the final entry wraps to the first. */
  colorTransitions?: ColorTransition[];
  /** Duration of each multi-colour chase colour stage in milliseconds. */
  colorStepMs?: number;
  pattern: Pattern;
  /** Pattern speed from 0 (slowest) to 100 (fastest). */
  speed: number;
  /** Transition duration used when the display receives a new state. */
  fadeMs: number;
  /** Position within a multi-light effect, from 0 to 1. */
  phaseOffset: number;
  /** Unix epoch milliseconds used to keep independently rendered patterns in step. */
  patternStartedAt: number;
  /** Optional browser media asset served by this WebGlow instance. */
  mediaUrl?: string;
  mediaKind?: 'image' | 'video';
  mediaStartedAt?: number;
  /** Opacity of the media overlay, from 0 to 100 percent. */
  mediaOpacity?: number;
  /** Procedural effects composited above the base wash and media. */
  layers?: VisualEffectLayer[];
}

export interface LightResource {
  id: string;
  name: string;
  /** Operator-facing fixture number; changing it never changes the stable ID. */
  fixtureNumber?: number;
  kind: FixtureKind;
  /** Present only for a physical WLED fixture. */
  wled?: WledFixtureConfig;
  /** Present only for a patched DMX fixture. */
  dmx?: DmxFixtureConfig;
  /** Present only for a display registered by a guest. */
  guest?: GuestFixtureConfig;
  state: LightState;
  revision: number;
  updatedAt: string;
}

export interface CreateLightInput {
  id?: string;
  name?: string;
  fixtureNumber?: number;
  kind?: FixtureKind;
  wled?: WledFixtureConfig;
  dmx?: DmxFixtureConfig;
  guest?: GuestFixtureConfig;
}

export interface LightPatch {
  name?: string;
  fixtureNumber?: number;
  on?: boolean;
  brightness?: number;
  color?: string;
  /** Optional palette used by multicolour patterns. */
  colors?: string[];
  /** @deprecated Use colorTransitions to configure each palette step. */
  colorTransition?: ColorTransition;
  /** Transition from each colour to the following colour; the final entry wraps to the first. */
  colorTransitions?: ColorTransition[];
  colorStepMs?: number;
  pattern?: Pattern;
  speed?: number;
  fadeMs?: number;
  phaseOffset?: number;
  expectedRevision?: number;
  mediaUrl?: string | null;
  mediaKind?: 'image' | 'video' | null;
  mediaOpacity?: number;
  layers?: VisualEffectLayer[] | null;
}

/** A saved console cue. The state is applied to its targets when the cue is run. */
export interface SceneResource {
  id: string;
  name: string;
  stackId: string;
  ids: 'all' | string[];
  state: LightPatch;
  /** Recalculate phase spacing against the fixtures present at GO time. */
  scaleEffect?: boolean;
  effectDirection?: EffectDirection;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSceneInput {
  id: string;
  name?: string;
  stackId?: string;
  ids: 'all' | string[];
  state: LightPatch;
  scaleEffect?: boolean;
  effectDirection?: EffectDirection;
}

export interface CueStackResource {
  id: string;
  name: string;
  cueOrder: string[];
  updatedAt: string;
}

export interface UpdateSceneInput {
  name?: string;
  stackId?: string;
  ids?: 'all' | string[];
  state?: LightPatch;
  scaleEffect?: boolean;
  effectDirection?: EffectDirection;
}

export const TIMECODE_RATES = ['23.976', '24', '25', '29.97df', '30'] as const;
export type TimecodeRate = (typeof TIMECODE_RATES)[number];

export interface TimedCueEvent {
  id: string;
  frame: number;
  cueId: string;
}

export interface TimecodeSequence {
  id: string;
  name: string;
  sourceStartFrame?: number;
  events: TimedCueEvent[];
}

export interface TimecodeSegment {
  id: string;
  sequenceId: string;
  startFrame: number;
}

/** Song-level cue timelines arranged on the external show timecode. */
export interface TimecodeProgram {
  frameRate: TimecodeRate;
  sequences: TimecodeSequence[];
  segments: TimecodeSegment[];
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
