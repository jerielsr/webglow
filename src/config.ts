import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_STATIC_ROOT = fileURLToPath(new URL('./public', import.meta.url));

export interface WebglowConfig {
  host: string;
  port: number;
  httpsEnabled: boolean;
  httpsPort: number;
  httpsPublicPort: number;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  tlsHosts: string[];
  dataFile: string;
  settingsFile: string;
  scenesFile: string;
  dmxProfilesFile: string;
  historyFile: string;
  mediaDirectory: string;
  staticRoot: string;
  apiToken?: string;
  passwordResetToken?: string;
  publicBaseUrl?: string;
  timecodeFile: string;
  corsOrigin: string;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') {
    return 1828;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }

  return port;
}

function parseBoolean(value: string | undefined, name: string, defaultValue = false): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be true or false.`);
}

export function getConfig(environment: NodeJS.ProcessEnv = process.env): WebglowConfig {
  const dataDirectory = resolve(environment.DATA_DIR ?? 'data');
  const configuredToken = environment.WEBGLOW_API_TOKEN?.trim();
  const passwordResetToken = environment.WEBGLOW_PASSWORD_RESET_TOKEN?.trim();
  const publicBaseUrl = environment.WEBGLOW_PUBLIC_URL?.trim();
  const httpsEnabled = parseBoolean(environment.WEBGLOW_HTTPS_ENABLED, 'WEBGLOW_HTTPS_ENABLED');
  const tlsCertFile = environment.WEBGLOW_TLS_CERT_FILE?.trim();
  const tlsKeyFile = environment.WEBGLOW_TLS_KEY_FILE?.trim();
  if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
    throw new Error('Set both WEBGLOW_TLS_CERT_FILE and WEBGLOW_TLS_KEY_FILE to use a custom HTTPS certificate.');
  }
  const port = parsePort(environment.PORT);
  const httpsPort = parsePort(environment.WEBGLOW_HTTPS_PORT ?? '18443');
  const httpsPublicPort = parsePort(environment.WEBGLOW_HTTPS_PUBLIC_PORT ?? environment.WEBGLOW_HTTPS_HOST_PORT ?? String(httpsPort));
  if (httpsEnabled && port === httpsPort) {
    throw new Error('WEBGLOW_HTTPS_PORT must differ from PORT so WebGlow can keep HTTP and HTTPS available together.');
  }

  return {
    host: environment.HOST?.trim() || '0.0.0.0',
    port,
    httpsEnabled,
    httpsPort,
    httpsPublicPort,
    ...(tlsCertFile && tlsKeyFile ? { tlsCertFile: resolve(tlsCertFile), tlsKeyFile: resolve(tlsKeyFile) } : {}),
    tlsHosts: (environment.WEBGLOW_TLS_HOSTS ?? '').split(/[\s,]+/).map((host) => host.trim()).filter(Boolean),
    dataFile: resolve(dataDirectory, 'lights.json'),
    settingsFile: resolve(dataDirectory, 'settings.json'),
    scenesFile: resolve(dataDirectory, 'scenes.json'),
    dmxProfilesFile: resolve(dataDirectory, 'dmx-profiles.json'),
    timecodeFile: resolve(dataDirectory, 'timecode.json'),
    historyFile: resolve(dataDirectory, 'history.json'),
    mediaDirectory: resolve(dataDirectory, 'media'),
    staticRoot: DEFAULT_STATIC_ROOT,
    apiToken: configuredToken || undefined,
    passwordResetToken: passwordResetToken || undefined,
    publicBaseUrl: publicBaseUrl || undefined,
    corsOrigin: environment.WEBGLOW_CORS_ORIGIN?.trim() || '*',
  };
}
