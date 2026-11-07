import { timingSafeEqual } from 'node:crypto';

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { getConfig, type WebglowConfig } from './config.js';
import { ApiError } from './errors.js';
import { LightStore } from './light-store.js';
import { PATTERNS, type LightResource } from './types.js';
import { validateCreateLight, validateLightId, validateLightPatch } from './validation.js';

export interface BuildAppOptions {
  config?: Partial<WebglowConfig>;
  logger?: boolean | FastifyBaseLogger;
  store?: LightStore;
}

function mergeConfig(overrides: Partial<WebglowConfig> = {}): WebglowConfig {
  return { ...getConfig(), ...overrides };
}

function hasValidToken(value: string | undefined, expected: string): boolean {
  if (!value) {
    return false;
  }

  const received = Buffer.from(value);
  const configured = Buffer.from(expected);
  return received.length === configured.length && timingSafeEqual(received, configured);
}

function requireControllerAccess(authorization: string | undefined, config: WebglowConfig): void {
  if (!config.apiToken) {
    return;
  }

  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!hasValidToken(token, config.apiToken)) {
    throw new ApiError(401, 'unauthorized', 'A valid Bearer token is required to control lights.');
  }
}

function displayPath(lightId: string): string {
  return `/display/${encodeURIComponent(lightId)}`;
}

function websocketMessage(type: 'state.snapshot' | 'state.changed', light: LightResource): string {
  return JSON.stringify({ type, light });
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = mergeConfig(options.config);
  const store = options.store ?? new LightStore(config.dataFile);
  await store.initialize();

  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: true,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.statusCode === 401) {
        reply.header('WWW-Authenticate', 'Bearer');
      }
      void reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
      return;
    }

    request.log.error(error);
    void reply.status(500).send({
      error: {
        code: 'internal_error',
        message: 'The server could not complete this request.',
      },
    });
  });

  app.addHook('onClose', async () => {
    await store.close();
  });

  await app.register(cors, {
    origin: config.corsOrigin,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  });
  await app.register(websocket);
  await app.register(fastifyStatic, {
    root: config.staticRoot,
    prefix: '/',
    index: false,
  });

  app.get('/', async () => ({
    name: 'webglow',
    apiVersion: 'v1',
    lightsPath: '/api/v1/lights',
    displayPathTemplate: '/display/:lightId',
  }));

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/api/v1/info', async () => ({
    name: 'webglow',
    apiVersion: 'v1',
    capabilities: {
      patterns: [...PATTERNS],
      brightness: { minimum: 0, maximum: 100, unit: 'rendered-percent' },
      realtime: 'websocket',
      persistence: 'file',
    },
  }));

  app.get('/api/v1/lights', async () => ({ lights: await store.list() }));

  app.post<{ Body: unknown }>('/api/v1/lights', async (request, reply) => {
    requireControllerAccess(request.headers.authorization, config);
    const input = validateCreateLight(request.body);
    const light = await store.create(input);

    return reply.status(201).send({
      light,
      displayPath: displayPath(light.id),
    });
  });

  app.get<{ Params: { lightId: string } }>('/api/v1/lights/:lightId', async (request) => {
    const id = validateLightId(request.params.lightId);
    return store.ensure(id);
  });

  app.patch<{ Params: { lightId: string }; Body: unknown }>(
    '/api/v1/lights/:lightId',
    async (request) => {
      requireControllerAccess(request.headers.authorization, config);
      const id = validateLightId(request.params.lightId);
      const patch = validateLightPatch(request.body);
      const light = await store.update(id, patch);

      if (!light) {
        throw new ApiError(404, 'light_not_found', `No light exists with ID "${id}".`);
      }

      return light;
    },
  );

  app.get<{ Params: { lightId: string } }>('/display/:lightId', async (request, reply) => {
    validateLightId(request.params.lightId);
    return reply.type('text/html; charset=utf-8').sendFile('display.html');
  });

  app.get('/api/v1/ws', { websocket: true }, (socket, request) => {
    const requestUrl = new URL(request.raw.url ?? '/api/v1/ws', 'http://webglow.local');
    const lightId = requestUrl.searchParams.get('lightId');
    const role = requestUrl.searchParams.get('role');

    if (role !== 'display' || !lightId) {
      socket.close(1008, 'A display role and lightId are required.');
      return;
    }

    try {
      validateLightId(lightId);
    } catch {
      socket.close(1008, 'Invalid light ID.');
      return;
    }

    let unsubscribe: (() => void) | undefined;
    let closed = false;
    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      unsubscribe?.();
      unsubscribe = undefined;
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);

    void store
      .ensure(lightId)
      .then((light) => {
        if (closed) {
          return;
        }

        socket.send(websocketMessage('state.snapshot', light));
        unsubscribe = store.onChange((changedLight) => {
          if (!closed && changedLight.id === lightId && socket.readyState === 1) {
            socket.send(websocketMessage('state.changed', changedLight));
          }
        });
      })
      .catch((error: unknown) => {
        app.log.error(error, 'Unable to initialize display websocket.');
        socket.close(1011, 'Unable to load light state.');
      });
  });

  return app;
}
