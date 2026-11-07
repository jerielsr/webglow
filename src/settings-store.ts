import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import { ApiError } from './errors.js';

const scrypt = promisify(scryptCallback);

export interface PortalAccount {
  username: string;
  passwordSalt: string;
  passwordHash: string;
}

interface PersistedSettings {
  version: 1;
  publicBaseUrl?: string;
  portalAccount?: PortalAccount;
}

export interface PublicSettings {
  publicBaseUrl?: string;
}

function cloneSettings(settings: PersistedSettings): PersistedSettings {
  return {
    version: 1,
    ...(settings.publicBaseUrl ? { publicBaseUrl: settings.publicBaseUrl } : {}),
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
    return this.settings.publicBaseUrl ? { publicBaseUrl: this.settings.publicBaseUrl } : {};
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
    const previous = cloneSettings(this.settings);
    this.settings = {
      ...this.settings,
      ...(publicBaseUrl ? { publicBaseUrl } : { publicBaseUrl: undefined }),
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
      await writeFile(temporaryFile, serialized, 'utf8');
      await rename(temporaryFile, this.settingsFile);
    });
    this.pendingWrite = write;
    await write;
  }
}
