import { spawn, type ChildProcess } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';

import { ApiError } from './errors.js';
import { SettingsStore } from './settings-store.js';

type TunnelState = 'unconfigured' | 'unavailable' | 'stopped' | 'starting' | 'connected' | 'stopping' | 'error';

export interface CloudflaredTunnelStatus {
  installed: boolean;
  configured: boolean;
  autoStart: boolean;
  hostname?: string;
  state: TunnelState;
  message: string;
  output: string[];
}

function findCloudflared(): string | undefined {
  const candidates = [
    ...(process.env.CLOUDFLARED_BIN ? [process.env.CLOUDFLARED_BIN] : []),
    ...((process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'))),
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'] : []),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export class CloudflaredTunnel {
  private readonly executable = findCloudflared();
  private process?: ChildProcess;
  private state: TunnelState = 'stopped';
  private message = 'Tunnel is stopped.';
  private output: string[] = [];
  private pendingOutput: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  private stopTimer?: NodeJS.Timeout;

  constructor(private readonly settings: SettingsStore, private readonly originPort: number) {}

  status(): CloudflaredTunnelStatus {
    const settings = this.settings.getCloudflaredSettings();
    let state = this.state;
    let message = this.message;
    if (!settings.configured && !this.process) {
      state = 'unconfigured';
      message = 'Add a tunnel token from your Cloudflare dashboard to get started.';
    } else if (!this.executable && !this.process) {
      state = 'unavailable';
      message = 'cloudflared is not installed where WebGlow is running.';
    }
    return {
      installed: Boolean(this.executable),
      configured: settings.configured,
      autoStart: settings.autoStart,
      ...(settings.hostname ? { hostname: settings.hostname } : {}),
      state,
      message,
      output: [...this.output],
    };
  }

  async start(): Promise<CloudflaredTunnelStatus> {
    if (this.process) return this.status();
    const settings = this.settings.getCloudflaredSettings();
    if (!settings.token) {
      throw new ApiError(400, 'cloudflared_token_required', 'Save a Cloudflare Tunnel token before connecting.');
    }
    if (!this.executable) {
      throw new ApiError(503, 'cloudflared_not_installed', 'Install cloudflared where WebGlow is running, then restart WebGlow.');
    }

    this.output = [];
    this.pendingOutput = { stdout: '', stderr: '' };
    this.state = 'starting';
    this.message = `Connecting to Cloudflare; local origin is http://127.0.0.1:${this.originPort}.`;
    const child = spawn(this.executable, ['tunnel', '--no-autoupdate', 'run'], {
      env: { ...process.env, TUNNEL_TOKEN: settings.token },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.process = child;
    child.stdout?.on('data', (chunk: Buffer) => this.readOutput(chunk, settings.token!, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => this.readOutput(chunk, settings.token!, 'stderr'));
    child.once('spawn', () => {
      this.state = 'starting';
      this.message = 'cloudflared started; waiting for a tunnel connection.';
    });
    child.once('error', (error) => {
      this.state = 'error';
      this.message = `Could not start cloudflared: ${error.message}`;
      this.process = undefined;
    });
    child.once('close', (code, signal) => {
      if (this.stopTimer) clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
      this.process = undefined;
      if (this.state !== 'stopping') {
        this.state = code === 0 ? 'stopped' : 'error';
        this.message = code === 0 ? 'cloudflared exited.' : `cloudflared exited (${signal ?? `code ${code ?? 'unknown'}`}).`;
      } else {
        this.state = 'stopped';
        this.message = 'Tunnel stopped.';
      }
    });
    return this.status();
  }

  async stop(): Promise<CloudflaredTunnelStatus> {
    const child = this.process;
    if (!child) return this.status();
    this.state = 'stopping';
    this.message = 'Stopping Cloudflare Tunnel…';
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process === child) child.kill('SIGKILL');
        resolve();
      }, 5_000);
      child.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    return this.status();
  }

  async autoStart(): Promise<void> {
    if (this.settings.getCloudflaredSettings().autoStart && this.settings.getCloudflaredSettings().configured) {
      try {
        await this.start();
      } catch (error) {
        this.state = 'error';
        this.message = error instanceof Error ? error.message : 'Could not start Cloudflare Tunnel.';
      }
    }
  }

  private readOutput(chunk: Buffer, token: string, stream: 'stdout' | 'stderr'): void {
    const parts = (this.pendingOutput[stream] + chunk.toString('utf8')).split(/\r?\n/);
    let partial = parts.pop() ?? '';
    if (partial.length > 8192) {
      parts.push(partial.slice(0, -4096));
      partial = partial.slice(-4096);
    }
    this.pendingOutput[stream] = partial;
    const lines = parts.map((line) => line.replaceAll(token, '[redacted]').replace(/\b[A-Za-z0-9_.-]{80,}\b/g, '[redacted]').trim()).filter(Boolean);
    for (const line of lines) {
      this.output.push(line.slice(0, 500));
      if (/registered tunnel connection|connection registered/i.test(line)) {
        this.state = 'connected';
        this.message = 'Connected to Cloudflare Tunnel.';
      } else if (/error|failed/i.test(line)) {
        this.message = line.slice(0, 300);
      }
    }
    this.output = this.output.slice(-12);
  }
}
