import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_STATIC_ROOT = fileURLToPath(new URL('./public', import.meta.url));

export interface WebglowConfig {
  host: string;
  port: number;
  dataFile: string;
  settingsFile: string;
  scenesFile: string;
  staticRoot: string;
  apiToken?: string;
  passwordResetToken?: string;
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

export function getConfig(environment: NodeJS.ProcessEnv = process.env): WebglowConfig {
  const dataDirectory = resolve(environment.DATA_DIR ?? 'data');
  const configuredToken = environment.WEBGLOW_API_TOKEN?.trim();
  const passwordResetToken = environment.WEBGLOW_PASSWORD_RESET_TOKEN?.trim();

  return {
    host: environment.HOST?.trim() || '0.0.0.0',
    port: parsePort(environment.PORT),
    dataFile: resolve(dataDirectory, 'lights.json'),
    settingsFile: resolve(dataDirectory, 'settings.json'),
    scenesFile: resolve(dataDirectory, 'scenes.json'),
    staticRoot: DEFAULT_STATIC_ROOT,
    apiToken: configuredToken || undefined,
    passwordResetToken: passwordResetToken || undefined,
    corsOrigin: environment.WEBGLOW_CORS_ORIGIN?.trim() || '*',
  };
}
