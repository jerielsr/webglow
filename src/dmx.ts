import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { usb as defaultUsb } from 'usb';

import { ApiError } from './errors.js';
import { PATTERNS, type DmxChannelFunction, type DmxFixtureConfig, type DmxFixtureProfile, type DmxProfileChannel, type LightResource, type Pattern } from './types.js';

export const UDMX_VENDOR_ID = 0x16c0;
export const UDMX_PRODUCT_ID = 0x05dc;
export const UDMX_SET_CHANNEL_RANGE = 2;
const DMX_EFFECT_FRAME_INTERVAL_MS = 40;

/** The channel order follows the 5-channel profile requested for this rig. */
export const STAIRVILLE_LED_PAR_64_PROFILE: DmxFixtureProfile = {
  id: 'stairville-led-par-64-5ch',
  name: 'Stairville LED PAR 64 (5-channel)',
  builtIn: true,
  channels: [
    { name: 'Operation Mode', function: 'operation', operationValues: { solid: 0 } },
    { name: 'Red', function: 'red' },
    { name: 'Green', function: 'green' },
    { name: 'Blue', function: 'blue' },
    { name: 'Speed', function: 'speed' },
  ],
};

const CHANNEL_FUNCTIONS: DmxChannelFunction[] = ['operation', 'red', 'green', 'blue', 'dimmer', 'speed', 'fixed'];
const PROFILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function validateDmxFixtureConfig(value: unknown): DmxFixtureConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'invalid_request', 'dmx must be a JSON object.', { field: 'dmx' });
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !['profileId', 'startAddress'].includes(key));
  if (unknown.length) throw new ApiError(400, 'invalid_request', 'dmx contains unsupported fields.', { fields: unknown });
  if (typeof record.profileId !== 'string' || !PROFILE_ID.test(record.profileId)) {
    throw new ApiError(400, 'invalid_request', 'dmx.profileId must be a valid fixture profile ID.', { field: 'dmx.profileId' });
  }
  const startAddress = record.startAddress === undefined ? 1 : record.startAddress;
  if (!Number.isInteger(startAddress) || (startAddress as number) < 1 || (startAddress as number) > 512) {
    throw new ApiError(400, 'invalid_request', 'dmx.startAddress must be an integer from 1 to 512.', { field: 'dmx.startAddress' });
  }
  return { profileId: record.profileId, startAddress: startAddress as number };
}

export function validateDmxFixtureProfile(value: unknown, options: { allowId?: boolean; builtIn?: boolean } = {}): DmxFixtureProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'invalid_request', 'A DMX profile must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = options.allowId ? ['id', 'name', 'channels'] : ['name', 'channels'];
  const unknown = Object.keys(record).filter((key) => !allowedKeys.includes(key));
  if (unknown.length) throw new ApiError(400, 'invalid_request', 'The DMX profile contains unsupported fields.', { fields: unknown });
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name || name.length > 80) throw new ApiError(400, 'invalid_request', 'Profile name must contain 1–80 characters.', { field: 'name' });
  const id = options.allowId ? record.id : `custom-${randomUUID().slice(0, 12)}`;
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new ApiError(400, 'invalid_request', 'The DMX profile ID is invalid.', { field: 'id' });
  if (!Array.isArray(record.channels) || record.channels.length < 1 || record.channels.length > 32) {
    throw new ApiError(400, 'invalid_request', 'A DMX profile must contain 1–32 channels.', { field: 'channels' });
  }
  const channels = record.channels.map((value, index): DmxProfileChannel => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ApiError(400, 'invalid_request', `channels[${index}] must be an object.`);
    const channel = value as Record<string, unknown>;
    const channelUnknown = Object.keys(channel).filter((key) => !['name', 'function', 'fixedValue', 'operationValues'].includes(key));
    if (channelUnknown.length) throw new ApiError(400, 'invalid_request', `channels[${index}] contains unsupported fields.`, { fields: channelUnknown });
    const channelName = typeof channel.name === 'string' ? channel.name.trim() : '';
    if (!channelName || channelName.length > 40) throw new ApiError(400, 'invalid_request', `channels[${index}].name must contain 1–40 characters.`);
    if (typeof channel.function !== 'string' || !CHANNEL_FUNCTIONS.includes(channel.function as DmxChannelFunction)) {
      throw new ApiError(400, 'invalid_request', `channels[${index}].function is not supported.`);
    }
    const fn = channel.function as DmxChannelFunction;
    let fixedValue: number | undefined;
    if (channel.fixedValue !== undefined) {
      if (!Number.isInteger(channel.fixedValue) || (channel.fixedValue as number) < 0 || (channel.fixedValue as number) > 255) {
        throw new ApiError(400, 'invalid_request', `channels[${index}].fixedValue must be an integer from 0 to 255.`);
      }
      fixedValue = channel.fixedValue as number;
    }
    if (fn === 'fixed' && fixedValue === undefined) throw new ApiError(400, 'invalid_request', `channels[${index}] needs a fixed value.`);
    if (fn !== 'fixed' && fixedValue !== undefined) throw new ApiError(400, 'invalid_request', `channels[${index}].fixedValue is only valid for a fixed channel.`);
    let operationValues: Partial<Record<Pattern, number>> | undefined;
    if (channel.operationValues !== undefined) {
      if (fn !== 'operation' || typeof channel.operationValues !== 'object' || channel.operationValues === null || Array.isArray(channel.operationValues)) {
        throw new ApiError(400, 'invalid_request', `channels[${index}].operationValues is only valid for an operation channel.`);
      }
      operationValues = {};
      for (const [pattern, output] of Object.entries(channel.operationValues as Record<string, unknown>)) {
        if (!PATTERNS.includes(pattern as Pattern) || !Number.isInteger(output) || (output as number) < 0 || (output as number) > 255) {
          throw new ApiError(400, 'invalid_request', `channels[${index}].operationValues has an invalid pattern or DMX value.`);
        }
        operationValues[pattern as Pattern] = output as number;
      }
    }
    return { name: channelName, function: fn, ...(fixedValue === undefined ? {} : { fixedValue }), ...(operationValues ? { operationValues } : {}) };
  });
  const uniqueFunctions = channels.map((channel) => channel.function).filter((fn) => fn !== 'fixed');
  if (new Set(uniqueFunctions).size !== uniqueFunctions.length) throw new ApiError(400, 'invalid_request', 'A profile can only map each output function once.');
  return { id, name, ...(options.builtIn ? { builtIn: true } : {}), channels };
}

interface PersistedProfiles { version: 1; profiles: DmxFixtureProfile[] }

export class DmxProfileStore {
  private customProfiles: DmxFixtureProfile[] = [];
  private pendingWrite: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(private readonly dataFile: string) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const parsed = JSON.parse(await readFile(this.dataFile, 'utf8')) as Partial<PersistedProfiles>;
      if (parsed.version !== 1 || !Array.isArray(parsed.profiles)) throw new Error('The saved DMX profiles do not match the expected format.');
      this.customProfiles = parsed.profiles.map((profile) => validateDmxFixtureProfile(profile, { allowId: true }));
      if (new Set(this.customProfiles.map((profile) => profile.id)).size !== this.customProfiles.length || this.customProfiles.some((profile) => profile.id === STAIRVILLE_LED_PAR_64_PROFILE.id)) {
        throw new Error('Saved DMX profile IDs must be unique and cannot replace a built-in profile.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Unable to load DMX profiles from ${this.dataFile}: ${String(error)}`);
    }
    this.initialized = true;
  }

  list(): DmxFixtureProfile[] {
    return [STAIRVILLE_LED_PAR_64_PROFILE, ...this.customProfiles].map((profile) => structuredClone(profile));
  }

  listCustom(): DmxFixtureProfile[] { return this.customProfiles.map((profile) => structuredClone(profile)); }

  get(id: string): DmxFixtureProfile | undefined {
    const profile = id === STAIRVILLE_LED_PAR_64_PROFILE.id ? STAIRVILLE_LED_PAR_64_PROFILE : this.customProfiles.find((item) => item.id === id);
    return profile ? structuredClone(profile) : undefined;
  }

  async create(value: unknown): Promise<DmxFixtureProfile> {
    const profile = validateDmxFixtureProfile(value);
    if (this.get(profile.id)) throw new ApiError(409, 'dmx_profile_exists', 'A DMX profile with this ID already exists.');
    this.customProfiles.push(profile);
    try { await this.persist(); } catch (error) { this.customProfiles.pop(); throw error; }
    return structuredClone(profile);
  }

  async update(id: string, value: unknown): Promise<DmxFixtureProfile> {
    const index = this.customProfiles.findIndex((item) => item.id === id);
    if (index < 0) throw new ApiError(404, 'dmx_profile_not_found', 'This custom DMX profile does not exist.');
    const updated = validateDmxFixtureProfile(value, { allowId: true });
    if (updated.id !== id) throw new ApiError(400, 'invalid_request', 'A DMX profile ID cannot be changed.');
    const previous = this.customProfiles[index];
    this.customProfiles[index] = updated;
    try { await this.persist(); } catch (error) { this.customProfiles[index] = previous; throw error; }
    return structuredClone(updated);
  }

  async remove(id: string): Promise<DmxFixtureProfile> {
    if (id === STAIRVILLE_LED_PAR_64_PROFILE.id) throw new ApiError(409, 'built_in_profile', 'Built-in DMX profiles cannot be deleted.');
    const index = this.customProfiles.findIndex((item) => item.id === id);
    if (index < 0) throw new ApiError(404, 'dmx_profile_not_found', 'This custom DMX profile does not exist.');
    const [removed] = this.customProfiles.splice(index, 1);
    try { await this.persist(); } catch (error) { this.customProfiles.splice(index, 0, removed); throw error; }
    return structuredClone(removed);
  }

  async replaceCustom(profiles: DmxFixtureProfile[]): Promise<void> {
    const previous = this.customProfiles;
    this.customProfiles = profiles.map((profile) => validateDmxFixtureProfile(profile, { allowId: true }));
    if (new Set(this.customProfiles.map((profile) => profile.id)).size !== this.customProfiles.length || this.customProfiles.some((profile) => profile.id === STAIRVILLE_LED_PAR_64_PROFILE.id)) {
      this.customProfiles = previous;
      throw new ApiError(400, 'invalid_dmx_profiles', 'Showfile DMX profile IDs must be unique and cannot replace built-in profiles.');
    }
    try { await this.persist(); } catch (error) { this.customProfiles = previous; throw error; }
  }

  private async persist(): Promise<void> {
    const write = async () => {
      await mkdir(dirname(this.dataFile), { recursive: true });
      const temporary = `${this.dataFile}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, profiles: this.customProfiles }, null, 2), 'utf8');
      await rename(temporary, this.dataFile);
    };
    this.pendingWrite = this.pendingWrite.then(write, write);
    await this.pendingWrite;
  }
}

export interface DmxUsbDevice {
  vendorId?: number;
  productId?: number;
  manufacturerName?: string | null;
  productName?: string | null;
  opened?: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  controlTransferOut(setup: { requestType: 'vendor'; recipient: 'device'; request: number; value: number; index: number }, data: Uint8Array): Promise<{ status: string; bytesWritten: number }>;
}

export type DmxUsbProvider = () => Promise<DmxUsbDevice | undefined>;

export interface DmxUsbDiscovery {
  findDeviceByIds(vendorId: number, productId: number): Promise<unknown>;
}

export async function findUdmxDevice(discovery: DmxUsbDiscovery = defaultUsb): Promise<DmxUsbDevice | undefined> {
  const device = await discovery.findDeviceByIds(UDMX_VENDOR_ID, UDMX_PRODUCT_ID);
  return device ? device as DmxUsbDevice : undefined;
}

export class UdmxOutput {
  private device?: DmxUsbDevice;
  private lastError?: string;
  private hasSentFrame = false;
  private lastSentChannelCount = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private currentLights: LightResource[] = [];
  private currentProfiles: DmxFixtureProfile[] = [];
  private animationTimer?: ReturnType<typeof setInterval>;
  private animationWritePending = false;

  constructor(private readonly findDevice: DmxUsbProvider = async () => await findUdmxDevice()) {}

  async status(): Promise<{ connected: boolean; device: string; vendorId: string; productId: string; lastError?: string }> {
    try {
      const device = await this.findDevice();
      if (!device) return { connected: false, device: 'Not detected', vendorId: `0x${UDMX_VENDOR_ID.toString(16)}`, productId: `0x${UDMX_PRODUCT_ID.toString(16)}`, ...(this.lastError ? { lastError: this.lastError } : {}) };
      const name = [device.manufacturerName, device.productName].filter(Boolean).join(' ').trim() || 'uDMX-compatible USB device';
      return { connected: true, device: name, vendorId: `0x${(device.vendorId ?? UDMX_VENDOR_ID).toString(16)}`, productId: `0x${(device.productId ?? UDMX_PRODUCT_ID).toString(16)}`, ...(this.lastError ? { lastError: this.lastError } : {}) };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'USB device scan failed.';
      return { connected: false, device: 'USB access unavailable', vendorId: `0x${UDMX_VENDOR_ID.toString(16)}`, productId: `0x${UDMX_PRODUCT_ID.toString(16)}`, lastError: this.lastError };
    }
  }

  async apply(lights: LightResource[], profiles: DmxFixtureProfile[]): Promise<void> {
    this.currentLights = structuredClone(lights);
    this.currentProfiles = structuredClone(profiles);
    const dmxLights = this.currentLights.filter((light) => light.kind === 'dmx' && light.dmx);
    const hasAnimatedFixture = dmxLights.some((light) => light.state.on && light.state.pattern !== 'solid');
    if (!hasAnimatedFixture) this.stopAnimationTimer();
    if (!dmxLights.length && !this.hasSentFrame) return;
    await this.writeCurrentFrame();
    if (hasAnimatedFixture) this.updateAnimationTimer();
  }

  private async writeCurrentFrame(): Promise<void> {
    const channelCount = Math.max(this.lastSentChannelCount, dmxUniverseLength(this.currentLights, this.currentProfiles));
    if (!channelCount && !this.hasSentFrame) return;
    const frame = buildDmxUniverse(this.currentLights, this.currentProfiles, Date.now()).subarray(0, channelCount);
    const write = async () => {
      try {
        const device = this.device ?? await this.findDevice();
        if (!device) throw new ApiError(503, 'dmx_adapter_not_found', 'No uDMX adapter was detected. Connect the adapter and check the USB details in Setup.');
        this.device = device;
        if (!device.opened) await device.open();
        // The uDMX protocol accepts a channel range of any length. Send only
        // through the highest patched address rather than a needless 512-byte
        // low-speed USB control transfer on every fader movement.
        const result = await device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: UDMX_SET_CHANNEL_RANGE, value: frame.length, index: 0 }, frame);
        if (result.status !== 'ok' || result.bytesWritten < frame.length) throw new Error('The uDMX adapter did not accept the complete DMX universe.');
        this.hasSentFrame = true;
        this.lastSentChannelCount = Math.max(this.lastSentChannelCount, frame.length);
        this.lastError = undefined;
      } catch (error) {
        const rawMessage = error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'The uDMX adapter could not be written.';
        const message = friendlyDmxError(rawMessage);
        this.lastError = message;
        const device = this.device;
        this.device = undefined;
        if (device?.opened) await device.close().catch(() => undefined);
        if (error instanceof ApiError) throw error;
        throw new ApiError(502, 'dmx_output_failed', message);
      }
    };
    this.writeQueue = this.writeQueue.then(write, write);
    await this.writeQueue;
  }

  private updateAnimationTimer(): void {
    const hasAnimatedFixture = this.currentLights.some((light) => light.kind === 'dmx' && light.state.on && light.state.pattern !== 'solid');
    if (!hasAnimatedFixture) {
      this.stopAnimationTimer();
      return;
    }
    if (this.animationTimer) return;
    this.animationTimer = setInterval(() => {
      if (this.animationWritePending) return;
      this.animationWritePending = true;
      void this.writeCurrentFrame()
        .catch(() => this.stopAnimationTimer())
        .finally(() => { this.animationWritePending = false; });
    }, DMX_EFFECT_FRAME_INTERVAL_MS);
    this.animationTimer.unref?.();
  }

  private stopAnimationTimer(): void {
    if (this.animationTimer) clearInterval(this.animationTimer);
    this.animationTimer = undefined;
  }

  async close(): Promise<void> {
    this.stopAnimationTimer();
    await this.writeQueue.catch(() => undefined);
    const device = this.device;
    this.device = undefined;
    if (device?.opened) await device.close().catch(() => undefined);
  }
}

export function buildDmxUniverse(lights: LightResource[], profiles: DmxFixtureProfile[], now = Date.now()): Uint8Array {
  const frame = new Uint8Array(512);
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  for (const light of lights) {
    if (light.kind !== 'dmx' || !light.dmx) continue;
    const profile = profileById.get(light.dmx.profileId);
    if (!profile) throw new ApiError(409, 'dmx_profile_not_found', `DMX profile "${light.dmx.profileId}" used by ${light.name} does not exist.`);
    if (light.dmx.startAddress + profile.channels.length - 1 > 512) {
      throw new ApiError(400, 'dmx_address_out_of_range', `The ${profile.name} profile on ${light.name} extends past DMX address 512.`);
    }
    const sample = sampleDmxEffect(light.state, now);
    const hasDimmer = profile.channels.some((channel) => channel.function === 'dimmer');
    const brightness = light.state.on ? Math.round(light.state.brightness * sample.level * 2.55) : 0;
    const values: Record<DmxChannelFunction, number> = {
      operation: light.state.on ? 0 : 0,
      red: light.state.on ? Math.round(sample.color[0] * (hasDimmer ? 1 : light.state.brightness * sample.level / 100)) : 0,
      green: light.state.on ? Math.round(sample.color[1] * (hasDimmer ? 1 : light.state.brightness * sample.level / 100)) : 0,
      blue: light.state.on ? Math.round(sample.color[2] * (hasDimmer ? 1 : light.state.brightness * sample.level / 100)) : 0,
      dimmer: brightness,
      speed: light.state.on ? Math.round(light.state.speed * 2.55) : 0,
      fixed: 0,
    };
    for (const [offset, channel] of profile.channels.entries()) {
      let value = channel.function === 'fixed' ? channel.fixedValue ?? 0 : values[channel.function];
      if (channel.function === 'operation') value = channel.operationValues?.[light.state.pattern] ?? channel.operationValues?.solid ?? value;
      frame[light.dmx.startAddress - 1 + offset] = value;
    }
  }
  return frame;
}

function dmxUniverseLength(lights: LightResource[], profiles: DmxFixtureProfile[]): number {
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  let channelCount = 0;
  for (const light of lights) {
    if (light.kind !== 'dmx' || !light.dmx) continue;
    const profile = profileById.get(light.dmx.profileId);
    if (!profile) throw new ApiError(409, 'dmx_profile_not_found', `DMX profile "${light.dmx.profileId}" used by ${light.name} does not exist.`);
    const lastAddress = light.dmx.startAddress + profile.channels.length - 1;
    if (lastAddress > 512) throw new ApiError(400, 'dmx_address_out_of_range', `The ${profile.name} profile on ${light.name} extends past DMX address 512.`);
    channelCount = Math.max(channelCount, lastAddress);
  }
  return channelCount;
}

function friendlyDmxError(message: string): string {
  if (/0xe00002ed/i.test(message)) {
    return 'macOS reports that the uDMX adapter did not respond to the USB transfer (0xe00002ed). Reconnect the adapter and make sure another lighting app is not using it.';
  }
  return message;
}

interface DmxEffectSample { color: [number, number, number]; level: number }

function sampleDmxEffect(state: LightResource['state'], now: number): DmxEffectSample {
  const color = rgbValues(state.color);
  const elapsedSeconds = Math.max(0, now - state.patternStartedAt) / 1_000;
  const speed = Math.max(0, Math.min(100, state.speed));
  const frequency = 0.05 + (2.95 * speed) / 100;
  const phaseCycles = elapsedSeconds * frequency + Math.max(0, Math.min(1, state.phaseOffset));
  let level = 1;
  let outputColor = color;

  if (state.pattern === 'multi-chase' && state.colors && state.colors.length > 1) {
    const stepMs = Math.max(100, state.colorStepMs ?? 750);
    const stagePosition = (elapsedSeconds * 1_000) / stepMs + state.phaseOffset * state.colors.length;
    const stage = Math.floor(stagePosition);
    const colorIndex = ((stage % state.colors.length) + state.colors.length) % state.colors.length;
    outputColor = rgbValues(state.colors[colorIndex]);
    const transition = state.colorTransitions?.[colorIndex] ?? state.colorTransition ?? 'snap';
    if (transition !== 'snap') {
      const nextColor = rgbValues(state.colors[(colorIndex + 1) % state.colors.length]);
      const progress = stagePosition - stage;
      const eased = transition === 'fade' ? progress * progress * (3 - 2 * progress)
        : transition === 'ramp-up' ? progress * progress
          : transition === 'ramp-down' ? 1 - (1 - progress) * (1 - progress)
            : progress;
      outputColor = mixRgb(outputColor, nextColor, eased);
    }
  }

  if (state.pattern === 'breathe' || state.pattern === 'pulse') {
    const floor = state.pattern === 'breathe' ? 0.28 : 0.08;
    level = floor + (1 - floor) * (0.5 - 0.5 * Math.cos(phaseCycles * Math.PI * 2));
  } else if (state.pattern === 'strobe') {
    level = phaseCycles % 1 >= 0.34 ? 0 : 1;
  } else if (state.pattern === 'rainbow') {
    outputColor = hueToRgb(rgbToHue(color) + phaseCycles * 360);
  } else if (state.pattern === 'chase' || state.pattern === 'multi-chase') {
    const progress = ((phaseCycles % 1) + 1) % 1;
    level = 0.08 + 0.92 * Math.max(0, 1 - Math.abs(progress - 0.5) * 2) ** 3;
  } else if (state.pattern === 'twinkle') {
    const seed = Math.sin((elapsedSeconds * frequency + state.phaseOffset * 13.37) * 9.71);
    level = Math.max(0.12, seed > 0.72 ? 1 : 0.22 + ((seed + 1) / 2) * 0.26);
  } else if (state.pattern === 'ramp-up') {
    level = 0.08 + 0.92 * (((phaseCycles % 1) + 1) % 1);
  } else if (state.pattern === 'ramp-down') {
    level = 1 - 0.92 * (((phaseCycles % 1) + 1) % 1);
  }

  return { color: outputColor, level };
}

function mixRgb(from: [number, number, number], to: [number, number, number], progress: number): [number, number, number] {
  return from.map((value, index) => Math.round(value + (to[index] - value) * progress)) as [number, number, number];
}

function rgbToHue([redByte, greenByte, blueByte]: [number, number, number]): number {
  const red = redByte / 255;
  const green = greenByte / 255;
  const blue = blueByte / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  if (delta === 0) return 0;
  const hue = maximum === red ? (green - blue) / delta + (green < blue ? 6 : 0)
    : maximum === green ? (blue - red) / delta + 2
      : (red - green) / delta + 4;
  return (hue / 6) * 360;
}

function hueToRgb(hue: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360 / 60;
  const x = 255 * (1 - Math.abs((h % 2) - 1));
  const sector = Math.floor(h);
  const [red, green, blue] = sector === 0 ? [255, x, 0]
    : sector === 1 ? [x, 255, 0]
      : sector === 2 ? [0, 255, x]
        : sector === 3 ? [0, x, 255]
          : sector === 4 ? [x, 0, 255]
            : [255, 0, x];
  return [Math.round(red), Math.round(green), Math.round(blue)];
}

export function validateDmxPatch(lights: LightResource[], profiles: DmxFixtureProfile[]): void {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const intervals: Array<{ light: LightResource; start: number; end: number }> = [];
  for (const light of lights) {
    if (light.kind !== 'dmx' || !light.dmx) continue;
    const profile = byId.get(light.dmx.profileId);
    if (!profile) throw new ApiError(400, 'dmx_profile_not_found', `Select an existing DMX profile for ${light.name}.`);
    const end = light.dmx.startAddress + profile.channels.length - 1;
    if (end > 512) throw new ApiError(400, 'dmx_address_out_of_range', `${light.name} ends at address ${end}; a DMX universe ends at 512.`);
    intervals.push({ light, start: light.dmx.startAddress, end });
  }
  intervals.sort((left, right) => left.start - right.start);
  for (let index = 1; index < intervals.length; index += 1) {
    const previous = intervals[index - 1];
    const current = intervals[index];
    if (current.start <= previous.end) {
      throw new ApiError(409, 'dmx_address_overlap', `${current.light.name} overlaps ${previous.light.name} at DMX address ${current.start}.`);
    }
  }
}

function rgbValues(color: string): [number, number, number] {
  const hex = color.replace(/^#/, '');
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
}
