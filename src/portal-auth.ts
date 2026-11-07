import { randomBytes, timingSafeEqual } from 'node:crypto';

import { ApiError } from './errors.js';
import { SettingsStore } from './settings-store.js';

const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

interface PortalSession {
  username: string;
  expiresAt: number;
}

export interface PortalSessionStatus {
  username: string;
}

export class PortalAuth {
  private readonly sessions = new Map<string, PortalSession>();

  constructor(private readonly settings: SettingsStore, private readonly resetToken?: string) {}

  setupRequired(): boolean {
    return !this.settings.hasPortalAccount();
  }

  passwordResetConfigured(): boolean {
    return Boolean(this.resetToken);
  }

  getSession(sessionId: string | undefined): PortalSessionStatus | undefined {
    if (!sessionId) {
      return undefined;
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return { username: session.username };
  }

  async setup(username: string, password: string): Promise<{ sessionId: string; username: string }> {
    await this.settings.createPortalAccount(username, password);
    return { sessionId: this.createSession(username), username };
  }

  async login(username: string, password: string): Promise<{ sessionId: string; username: string }> {
    if (!(await this.settings.verifyPortalPassword(username, password))) {
      throw new ApiError(401, 'invalid_credentials', 'The username or password is incorrect.');
    }
    return { sessionId: this.createSession(username), username };
  }

  async changePassword(sessionId: string | undefined, currentPassword: string, newPassword: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (!(await this.settings.verifyPortalPassword(session.username, currentPassword))) {
      throw new ApiError(401, 'invalid_credentials', 'The current password is incorrect.');
    }
    await this.settings.changePortalPassword(session.username, newPassword);
    this.invalidateAllSessions();
  }

  async resetPassword(username: string, resetToken: string, newPassword: string): Promise<void> {
    if (!this.resetToken) {
      throw new ApiError(404, 'password_reset_unavailable', 'Password reset has not been configured for this server.');
    }
    const received = Buffer.from(resetToken);
    const expected = Buffer.from(this.resetToken);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new ApiError(401, 'invalid_reset_token', 'The password reset token is incorrect.');
    }
    await this.settings.changePortalPassword(username, newPassword);
    this.invalidateAllSessions();
  }

  logout(sessionId: string | undefined): void {
    if (sessionId) {
      this.sessions.delete(sessionId);
    }
  }

  private createSession(username: string): string {
    const sessionId = randomBytes(32).toString('base64url');
    this.sessions.set(sessionId, { username, expiresAt: Date.now() + SESSION_LIFETIME_MS });
    return sessionId;
  }

  private requireSession(sessionId: string | undefined): PortalSession {
    if (!sessionId) {
      throw new ApiError(401, 'portal_login_required', 'Sign in to the portal to continue.');
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      throw new ApiError(401, 'portal_login_required', 'Your portal session has expired. Sign in again.');
    }
    return session;
  }

  private invalidateAllSessions(): void {
    this.sessions.clear();
  }
}
