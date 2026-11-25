import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import { ApiError } from './errors.js';
import { HISTORY_RETENTIONS, type HistoryRetention } from './command-history-store.js';

const scrypt = promisify(scryptCallback);

export interface PortalAccount {
  username: string;
  passwordSalt: string;
  passwordHash: string;
}

interface PersistedSettings {
  version: 1;
  publicBaseUrl?: string;
  cloudflaredToken?: string;
  cloudflaredHostname?: string;
  cloudflaredAutoStart?: boolean;
  guestRegistrationEnabled?: boolean;
  historyRetention?: HistoryRetention;
  guestAutoRemoveEnabled?: boolean;
  guestInactivityHours?: number;
  guestRememberHours?: number;
  autoRefreshDevices?: boolean;
  seatSections?: string[];
  virtualSubsectionsEnabled?: boolean;
  virtualSubsectionsCount?: number;
  fixtureSortMode?: 'id' | 'seat' | 'custom';
  fixtureOrder?: string[];
  portalAccount?: PortalAccount;
}

export interface PublicSettings {
  publicBaseUrl?: string;
  guestRegistrationEnabled: boolean;
  historyRetention: HistoryRetention;
  guestAutoRemoveEnabled: boolean;
  guestInactivityHours: number;
  guestRememberHours: number;
  autoRefreshDevices: boolean;
  seatSections: string[];
  virtualSubsectionsEnabled: boolean;
  virtualSubsectionsCount: number;
  fixtureSortMode: 'id' | 'seat' | 'custom';
  fixtureOrder: string[];
}

export interface CloudflaredSettings {
  configured: boolean;
  autoStart: boolean;
  token?: string;
  hostname?: string;
}

function cloneSettings(settings: PersistedSettings): PersistedSettings {
  return {
    version: 1,
    ...(settings.publicBaseUrl ? { publicBaseUrl: settings.publicBaseUrl } : {}),
    ...(settings.cloudflaredToken ? { cloudflaredToken: settings.cloudflaredToken } : {}),
    ...(settings.cloudflaredHostname ? { cloudflaredHostname: settings.cloudflaredHostname } : {}),
    ...(settings.cloudflaredAutoStart === undefined ? {} : { cloudflaredAutoStart: settings.cloudflaredAutoStart }),
    ...(settings.guestRegistrationEnabled ? { guestRegistrationEnabled: true } : {}),
    ...(settings.historyRetention ? { historyRetention: settings.historyRetention } : {}),
    ...(settings.guestAutoRemoveEnabled ? { guestAutoRemoveEnabled: true } : {}),
    ...(settings.guestInactivityHours ? { guestInactivityHours: settings.guestInactivityHours } : {}),
    ...(settings.guestRememberHours ? { guestRememberHours: settings.guestRememberHours } : {}),
    ...(settings.autoRefreshDevices === undefined ? {} : { autoRefreshDevices: settings.autoRefreshDevices }),
    ...(settings.seatSections ? { seatSections: [...settings.seatSections] } : {}),
    ...(settings.virtualSubsectionsEnabled === undefined ? {} : { virtualSubsectionsEnabled: settings.virtualSubsectionsEnabled }),
    ...(settings.virtualSubsectionsCount === undefined ? {} : { virtualSubsectionsCount: settings.virtualSubsectionsCount }),
    ...(settings.fixtureSortMode ? { fixtureSortMode: settings.fixtureSortMode } : {}),
    ...(settings.fixtureOrder ? { fixtureOrder: [...settings.fixtureOrder] } : {}),
    ...(settings.portalAccount ? { portalAccount: { ...settings.portalAccount } } : {}),
  };
}

function hasSettingsShape(value: unknown): value is PersistedSettings {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const settings = value as Partial<PersistedSettings>;
  const account = settings.portalAccount;
  return (
    settings.version === 1 &&
    (settings.publicBaseUrl === undefined || typeof settings.publicBaseUrl === 'string') &&
    (settings.cloudflaredToken === undefined || typeof settings.cloudflaredToken === 'string') &&
    (settings.cloudflaredHostname === undefined || typeof settings.cloudflaredHostname === 'string') &&
    (settings.cloudflaredAutoStart === undefined || typeof settings.cloudflaredAutoStart === 'boolean') &&
    (settings.guestRegistrationEnabled === undefined || typeof settings.guestRegistrationEnabled === 'boolean') &&
    (settings.historyRetention === undefined || HISTORY_RETENTIONS.includes(settings.historyRetention)) &&
    (settings.guestAutoRemoveEnabled === undefined || typeof settings.guestAutoRemoveEnabled === 'boolean') &&
    (settings.guestInactivityHours === undefined || [1, 6, 12, 24, 72, 168].includes(settings.guestInactivityHours)) &&
    (settings.guestRememberHours === undefined || [1, 6, 12, 24, 72, 168, 336].includes(settings.guestRememberHours)) &&
    (settings.autoRefreshDevices === undefined || typeof settings.autoRefreshDevices === 'boolean') &&
    (settings.seatSections === undefined || (Array.isArray(settings.seatSections) && settings.seatSections.length >= 1 && settings.seatSections.length <= 12 && settings.seatSections.every((name) => typeof name === 'string' && name.trim().length > 0 && name.length <= 80))) &&
    (settings.virtualSubsectionsEnabled === undefined || typeof settings.virtualSubsectionsEnabled === 'boolean') &&
    (settings.virtualSubsectionsCount === undefined || (Number.isInteger(settings.virtualSubsectionsCount) && settings.virtualSubsectionsCount >= 2 && settings.virtualSubsectionsCount <= 12)) &&
    (settings.fixtureSortMode === undefined || ['id', 'seat', 'custom'].includes(settings.fixtureSortMode)) &&
    (settings.fixtureOrder === undefined || (Array.isArray(settings.fixtureOrder) && settings.fixtureOrder.every((id) => typeof id === 'string' && id.length <= 64))) &&
    (account === undefined ||
      (typeof account.username === 'string' &&
        typeof account.passwordSalt === 'string' &&
        typeof account.passwordHash === 'string'))
  );
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return derived.toString('base64url');
}

export class SettingsStore {
  private settings: PersistedSettings = { version: 1 };
  private pendingWrite: Promise<void> = Promise.resolve();
  private initialized = false;
  private readonly events = new EventEmitter();

  constructor(private readonly settingsFile: string) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const raw = await readFile(this.settingsFile, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!hasSettingsShape(parsed)) {
        throw new Error('The saved portal settings do not match the expected format.');
      }
      this.settings = cloneSettings(parsed);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Unable to load saved settings from ${this.settingsFile}: ${String(error)}`);
      }
    }

    this.initialized = true;
  }

  hasPortalAccount(): boolean {
    return Boolean(this.settings.portalAccount);
  }

  getPublicSettings(): PublicSettings {
    return {
      ...(this.settings.publicBaseUrl ? { publicBaseUrl: this.settings.publicBaseUrl } : {}),
      guestRegistrationEnabled: this.settings.guestRegistrationEnabled === true,
      historyRetention: this.settings.historyRetention ?? 'month',
      guestAutoRemoveEnabled: this.settings.guestAutoRemoveEnabled === true,
      guestInactivityHours: this.settings.guestInactivityHours ?? 24,
      guestRememberHours: this.settings.guestRememberHours ?? 24,
      autoRefreshDevices: this.settings.autoRefreshDevices !== false,
      seatSections: [...(this.settings.seatSections ?? ['Left', 'Center', 'Right'])],
      virtualSubsectionsEnabled: this.settings.virtualSubsectionsEnabled === true,
      virtualSubsectionsCount: this.settings.virtualSubsectionsCount ?? 3,
      fixtureSortMode: this.settings.fixtureSortMode ?? 'id',
      fixtureOrder: [...(this.settings.fixtureOrder ?? [])],
    };
  }

  getCloudflaredSettings(): CloudflaredSettings {
    return {
      configured: Boolean(this.settings.cloudflaredToken),
      autoStart: this.settings.cloudflaredAutoStart === true,
      ...(this.settings.cloudflaredToken ? { token: this.settings.cloudflaredToken } : {}),
      ...(this.settings.cloudflaredHostname ? { hostname: this.settings.cloudflaredHostname } : {}),
    };
  }

  async updateCloudflaredSettings(input: {
    token?: string;
    clearToken?: boolean;
    hostname?: string;
    autoStart?: boolean;
  }): Promise<CloudflaredSettings> {
    const previous = cloneSettings(this.settings);
    this.settings = {
      ...this.settings,
      ...(input.token ? { cloudflaredToken: input.token } : {}),
      ...(input.clearToken ? { cloudflaredToken: undefined, cloudflaredAutoStart: false } : {}),
      ...(input.hostname === undefined ? {} : { cloudflaredHostname: input.hostname || undefined }),
      ...(input.autoStart === undefined ? {} : { cloudflaredAutoStart: input.autoStart }),
    };
    try {
      await this.persist();
    } catch (error) {
      this.settings = previous;
      throw error;
    }
    return this.getCloudflaredSettings();
  }

  getUsername(): string | undefined {
    return this.settings.portalAccount?.username;
  }

  async createPortalAccount(username: string, password: string): Promise<void> {
    if (this.settings.portalAccount) {
      throw new ApiError(409, 'account_already_configured', 'A portal account is already configured.');
    }
    await this.savePassword(username, password);
  }

  async verifyPortalPassword(username: string, password: string): Promise<boolean> {
    const account = this.settings.portalAccount;
    if (!account || account.username !== username) {
      return false;
    }
    const candidate = Buffer.from(await hashPassword(password, account.passwordSalt));
    const expected = Buffer.from(account.passwordHash);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  async changePortalPassword(username: string, password: string): Promise<void> {
    const account = this.settings.portalAccount;
    if (!account || account.username !== username) {
      throw new ApiError(404, 'portal_account_not_found', 'The portal account was not found.');
    }
    await this.savePassword(username, password);
  }

  async setPublicBaseUrl(publicBaseUrl: string | undefined): Promise<PublicSettings> {
    return this.updatePublicSettings({ publicBaseUrl });
  }

  async updatePublicSettings(input: {
    publicBaseUrl?: string | undefined;
    guestRegistrationEnabled?: boolean;
    historyRetention?: HistoryRetention;
    guestAutoRemoveEnabled?: boolean;
    guestInactivityHours?: number;
    guestRememberHours?: number;
    autoRefreshDevices?: boolean;
    seatSections?: string[];
    virtualSubsectionsEnabled?: boolean;
    virtualSubsectionsCount?: number;
    fixtureSortMode?: 'id' | 'seat' | 'custom';
    fixtureOrder?: string[];
  }): Promise<PublicSettings> {
    const previous = cloneSettings(this.settings);
    this.settings = {
      ...this.settings,
      ...(Object.hasOwn(input, 'publicBaseUrl')
        ? (input.publicBaseUrl ? { publicBaseUrl: input.publicBaseUrl } : { publicBaseUrl: undefined })
        : {}),
      ...(input.guestRegistrationEnabled === undefined ? {} : { guestRegistrationEnabled: input.guestRegistrationEnabled }),
      ...(input.historyRetention === undefined ? {} : { historyRetention: input.historyRetention }),
      ...(input.guestAutoRemoveEnabled === undefined ? {} : { guestAutoRemoveEnabled: input.guestAutoRemoveEnabled }),
      ...(input.guestInactivityHours === undefined ? {} : { guestInactivityHours: input.guestInactivityHours }),
      ...(input.guestRememberHours === undefined ? {} : { guestRememberHours: input.guestRememberHours }),
      ...(input.autoRefreshDevices === undefined ? {} : { autoRefreshDevices: input.autoRefreshDevices }),
      ...(input.seatSections === undefined ? {} : { seatSections: [...input.seatSections] }),
      ...(input.virtualSubsectionsEnabled === undefined ? {} : { virtualSubsectionsEnabled: input.virtualSubsectionsEnabled }),
      ...(input.virtualSubsectionsCount === undefined ? {} : { virtualSubsectionsCount: input.virtualSubsectionsCount }),
      ...(input.fixtureSortMode === undefined ? {} : { fixtureSortMode: input.fixtureSortMode }),
      ...(input.fixtureOrder === undefined ? {} : { fixtureOrder: [...input.fixtureOrder] }),
    };
    try {
      await this.persist();
    } catch (error) {
      this.settings = previous;
      throw error;
    }
    this.events.emit('changed', this.getPublicSettings());
    return this.getPublicSettings();
  }

  onChange(listener: (settings: PublicSettings) => void): () => void {
    this.events.on('changed', listener);
    return () => this.events.off('changed', listener);
  }

  async close(): Promise<void> {
    await this.pendingWrite;
  }

  private async savePassword(username: string, password: string): Promise<void> {
    const previous = cloneSettings(this.settings);
    const passwordSalt = randomBytes(16).toString('base64url');
    const passwordHash = await hashPassword(password, passwordSalt);
    this.settings = {
      ...this.settings,
      portalAccount: { username, passwordSalt, passwordHash },
    };
    try {
      await this.persist();
    } catch (error) {
      this.settings = previous;
      throw error;
    }
  }

  private async persist(): Promise<void> {
    const serialized = `${JSON.stringify(this.settings, null, 2)}\n`;
    const write = this.pendingWrite.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.settingsFile), { recursive: true });
      const temporaryFile = `${this.settingsFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporaryFile, serialized, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryFile, this.settingsFile);
    });
    this.pendingWrite = write;
    await write;
  }
}
