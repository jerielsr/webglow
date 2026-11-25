import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { get } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { randomBytes } from 'node:crypto';

import { buildApp } from '../dist/app.js';
import { getConfig } from '../dist/config.js';
import { prepareHttpsListener } from '../dist/https.js';

test('generated HTTPS certificate covers loopback and configured DNS hosts and serves WebGlow routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'webglow-https-'));
  const config = {
    ...getConfig({ DATA_DIR: join(directory, 'data'), HOST: '127.0.0.1', PORT: '1828', WEBGLOW_TLS_HOSTS: 'lights.example.test' }),
    httpsEnabled: true,
    httpsPort: 0,
  };
  const app = await buildApp({ config, logger: false });
  let websocketSocket;

  try {
    const secureListener = await prepareHttpsListener(app, config);
    assert.equal(secureListener.status.certificateMode, 'local-ca');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const httpsPort = await secureListener.start();
    const certificate = new X509Certificate(await readFile(join(directory, 'data', 'tls', 'server.crt')));

    assert.ok(certificate.checkIP('127.0.0.1'));
    assert.ok(certificate.checkHost('lights.example.test'));
    assert.ok(new X509Certificate(await readFile(join(directory, 'data', 'tls', 'ca.crt'))).ca);

    const settings = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: { host: '192.168.1.20:1828' } });
    assert.equal(settings.json().publicBaseUrl, 'https://192.168.1.20:18443');
    const refreshedCertificate = new X509Certificate(await readFile(join(directory, 'data', 'tls', 'server.crt')));
    assert.ok(refreshedCertificate.checkIP('192.168.1.20'));
    const caDownload = await app.inject({ method: 'GET', url: '/api/v1/https/ca' });
    assert.equal(caDownload.statusCode, 200);
    assert.match(caDownload.body, /BEGIN CERTIFICATE/);

    const response = await new Promise((resolve, reject) => {
      get(`https://127.0.0.1:${httpsPort}/healthz`, { rejectUnauthorized: false }, (incoming) => {
        let body = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => { body += chunk; });
        incoming.on('end', () => resolve({ status: incoming.statusCode, body }));
      }).on('error', reject);
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { status: 'ok' });

    const light = await app.inject({ method: 'POST', url: '/api/v1/lights', payload: { id: 'tls-display' } });
    assert.equal(light.statusCode, 201);
    websocketSocket = tlsConnect({ host: '127.0.0.1', port: httpsPort, rejectUnauthorized: false });
    const upgradeResponse = await new Promise((resolve, reject) => {
      let received = '';
      const timeout = setTimeout(() => reject(new Error('HTTPS WebSocket upgrade timed out.')), 3_000);
      websocketSocket.once('secureConnect', () => {
        websocketSocket.write([
          'GET /api/v1/ws?role=display&lightId=tls-display HTTP/1.1',
          `Host: 127.0.0.1:${httpsPort}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
          'Sec-WebSocket-Version: 13',
          `Origin: https://127.0.0.1:${httpsPort}`,
          '',
          '',
        ].join('\r\n'));
      });
      websocketSocket.on('data', (chunk) => {
        received += chunk.toString('latin1');
        if (received.includes('\r\n\r\n')) {
          clearTimeout(timeout);
          resolve(received);
        }
      });
      websocketSocket.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    assert.match(upgradeResponse, /^HTTP\/1\.1 101 Switching Protocols/);
  } finally {
    websocketSocket?.destroy();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

