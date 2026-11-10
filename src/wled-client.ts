import { ApiError } from './errors.js';
import { DEFAULT_LIGHT_STATE, type LightResource, type LightState, type Pattern, type WledFixtureConfig } from './types.js';

export interface WledInspection {
  name?: string;
  state: LightState;
  effectMap: Partial<Record<Pattern, number>>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const PATTERN_NAMES: Record<Pattern, string[]> = {
  solid: ['solid'],
  breathe: ['breathe'],
  pulse: ['pulse', 'blink'],
  strobe: ['strobe'],
  rainbow: ['rainbow'],
  chase: ['chase'],
  twinkle: ['twinkle'],
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberInRange(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

function wledUrl(base: string, path: string): string {
  return new URL(path.replace(/^\//, ''), base.replace(/\/$/, '') + '/').toString();
}

function hexFromRgb(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length < 3 || !value.slice(0, 3).every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return undefined;
  }
  return '#' + value.slice(0, 3).map((part) => (part as number).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function selectedSegment(state: Record<string, unknown>, segmentId: number): Record<string, unknown> {
  const raw = state.seg;
  const segments = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const matched = segments.map(asRecord).find((segment) => segment.id === segmentId);
  return matched ?? asRecord(segments[0]);
}

function effectMapFrom(effects: unknown): Partial<Record<Pattern, number>> {
  if (!Array.isArray(effects)) return {};
  const names = effects.map((effect) => (typeof effect === 'string' ? effect.trim().toLowerCase() : ''));
  const map: Partial<Record<Pattern, number>> = {};
  for (const [pattern, candidates] of Object.entries(PATTERN_NAMES) as Array<[Pattern, string[]]>) {
    const effectIndex = names.findIndex((name) => candidates.some((candidate) => name === candidate || name.startsWith(candidate + ' ')));
    if (effectIndex >= 0) map[pattern] = effectIndex;
  }
  return map;
}

function patternForEffect(effectMap: Partial<Record<Pattern, number>>, effect: unknown): Pattern {
  if (typeof effect === 'number') {
    const found = (Object.entries(effectMap) as Array<[Pattern, number]>).find(([, value]) => value === effect);
    if (found) return found[0];
  }
  return 'solid';
}

function stateFromWled(response: Record<string, unknown>, segmentId: number, effectMap: Partial<Record<Pattern, number>>): LightState {
  const state = asRecord(response.state ?? response);
  const segment = selectedSegment(state, segmentId);
  const brightness = numberInRange(state.bri, 0, 255, 255);
  const segmentBrightness = numberInRange(segment.bri, 0, 255, brightness);
  const effect = segment.fx;
  const speed = numberInRange(segment.sx, 0, 255, 128);
  const transition = numberInRange(state.transition, 0, 65535, 0);
  return {
    ...DEFAULT_LIGHT_STATE,
    on: typeof state.on === 'boolean' ? state.on : true,
    brightness: Math.round((segmentBrightness / 255) * 100),
    color: hexFromRgb(segment.col && Array.isArray(segment.col) ? segment.col[0] : undefined) ?? DEFAULT_LIGHT_STATE.color,
    pattern: patternForEffect(effectMap, effect),
    speed: Math.round((speed / 255) * 100),
    fadeMs: Math.round(transition * 100),
    patternStartedAt: Date.now(),
  };
}

function rgbFromHex(color: string): [number, number, number] {
  const normalized = color.replace('#', '');
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

/**
 * Small adapter for WLED's documented HTTP JSON API. A new fixture is probed
 * before it is persisted, which both verifies reachability and learns the
 * effect IDs offered by that particular firmware/build.
 */
export class WledClient {
  constructor(private readonly request: FetchLike = fetch) {}

  async inspect(config: Pick<WledFixtureConfig, 'url' | 'segment'>): Promise<WledInspection> {
    const response = await this.fetchJson(wledUrl(config.url, '/json'));
    const info = asRecord(response.info);
    const effectMap = effectMapFrom(response.effects);
    return {
      ...(typeof info.name === 'string' && info.name.trim() ? { name: info.name.trim() } : {}),
      state: stateFromWled(response, config.segment, effectMap),
      effectMap,
    };
  }

  async apply(light: LightResource, synchronizedAt: number): Promise<void> {
    if (light.kind !== 'wled' || !light.wled) return;
    const effect = light.wled.effectMap?.[light.state.pattern];
    const payload: Record<string, unknown> = {
      on: light.state.on,
      tt: Math.min(65535, Math.round(light.state.fadeMs / 100)),
      // WLED uses this uint32 timebase to calculate the phase of an effect.
      // Every fixture receives the identical value, keeping compatible
      // WLED effects aligned even when HTTP requests arrive a few ms apart.
      tb: synchronizedAt >>> 0,
      seg: [
        {
          id: light.wled.segment,
          ...(light.state.on ? { bri: Math.max(1, Math.round((light.state.brightness / 100) * 255)) } : {}),
          col: [rgbFromHex(light.state.color)],
          sx: Math.round((light.state.speed / 100) * 255),
          ...(effect === undefined ? {} : { fx: effect }),
        },
      ],
    };
    await this.fetchJson(wledUrl(light.wled.url, '/json/state'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  private async fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.request(url, { ...init, signal: AbortSignal.timeout(5_000) });
    } catch {
      throw new ApiError(502, 'wled_unreachable', 'WebGlow could not reach the WLED fixture.');
    }
    if (!response.ok) {
      throw new ApiError(502, 'wled_unreachable', 'The WLED fixture returned HTTP ' + response.status + '.');
    }
    const body = await response.json().catch(() => undefined);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ApiError(502, 'wled_invalid_response', 'The WLED fixture did not return a valid JSON response.');
    }
    return body as Record<string, unknown>;
  }
}
