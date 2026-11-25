import { execFile as execFileCallback } from 'node:child_process';
import { createServer, type Server as HttpsServer, type ServerOptions } from 'node:https';
import { isIP as nodeIsIP } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID, X509Certificate } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { FastifyInstance } from 'fastify';

import type { WebglowConfig } from './config.js';

const execFile = promisify(execFileCallback);
const AUTO_TLS_DIRECTORY = 'tls';
const LEAF_VALID_DAYS = 397;
const CA_VALID_DAYS = 3650;

export interface HttpsRuntimeStatus {
  enabled: boolean;
  port: number;
  certificateMode: 'disabled' | 'custom' | 'local-ca';
  certificateHosts: string[];
  trustNote: string;
}

interface CertificateNames {
  dns: string[];
  ips: string[];
}

function parseCertificateNames(config: WebglowConfig, configuredHosts: string[] = []): CertificateNames {
  const dns = new Set(['localhost']);
  const ips = new Set(['127.0.0.1', '::1']);

  for (const interfaces of Object.values(networkInterfaces())) {
    for (const networkAddress of interfaces ?? []) {
      if (networkAddress.internal) continue;
      const address = networkAddress.address.split('%')[0];
      if (networkAddress.family === 'IPv4') {
        if (address !== '0.0.0.0' && !address.startsWith('169.254.')) ips.add(address);
      } else if (networkAddress.family === 'IPv6' && !address.toLowerCase().startsWith('fe80:')) {
        ips.add(address);
      }
    }
  }

  const machineHostname = hostname();
  if (isDnsName(machineHostname)) dns.add(machineHostname.toLowerCase());

  for (const host of [...config.tlsHosts, ...configuredHosts]) {
    if (isIP(host)) ips.add(host);
    else if (isDnsName(host)) dns.add(host.toLowerCase());
    else throw new Error(`WEBGLOW_TLS_HOSTS contains an invalid IP address or DNS name: "${host}".`);
  }

  return { dns: [...dns].sort(), ips: [...ips].sort() };
}

function isIP(value: string): boolean {
  return nodeIsIP(value) !== 0;
}

function isDnsName(value: string): boolean {
  if (value.length > 253 || value.includes('://') || value.includes('/') || value.includes(':')) return false;
  const name = value.startsWith('*.') ? value.slice(2) : value;
  return name.split('.').every((label) =>
    label.length > 0 && label.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label),
  );
}

function createOpenSslConfig(names: CertificateNames, kind: 'ca' | 'server'): string {
  if (kind === 'ca') {
    return [
      '[req]',
      'prompt = no',
      'distinguished_name = subject',
      'x509_extensions = ca_extensions',
      '[subject]',
      'CN = WebGlow Local HTTPS CA',
      '[ca_extensions]',
      'subjectKeyIdentifier = hash',
      'authorityKeyIdentifier = keyid:always,issuer',
      'basicConstraints = critical,CA:TRUE,pathlen:0',
      'keyUsage = critical,keyCertSign,cRLSign',
      '',
    ].join('\n');
  }

  const alternateNames = [
    ...names.dns.map((host, index) => `DNS.${index + 1} = ${host}`),
    ...names.ips.map((address, index) => `IP.${index + 1} = ${address}`),
  ];
  return [
    '[req]',
    'prompt = no',
    'distinguished_name = subject',
    'req_extensions = server_extensions',
    '[subject]',
    'CN = WebGlow HTTPS Server',
    '[server_extensions]',
    'subjectAltName = @alternate_names',
    '[server_certificate]',
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid,issuer',
    'basicConstraints = critical,CA:FALSE',
    'keyUsage = critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage = serverAuth',
    'subjectAltName = @alternate_names',
    '[alternate_names]',
    ...alternateNames,
    '',
  ].join('\n');
}

async function runOpenSsl(args: string[]): Promise<void> {
  try {
    await execFile('openssl', args, { timeout: 60_000, windowsHide: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not generate WebGlow's local HTTPS certificate with OpenSSL. Install OpenSSL or provide a custom certificate and key. ${detail}`);
  }
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
}

async function configuredHosts(config: WebglowConfig): Promise<string[]> {
  const hosts: string[] = [];
  const addUrlHost = (value: unknown) => {
    if (typeof value !== 'string' || value.trim() === '') return;
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') hosts.push(url.hostname.replace(/^\[|\]$/g, ''));
    } catch {
      // Invalid saved addresses are rejected by the settings API and are not SAN entries.
    }
  };

  addUrlHost(config.publicBaseUrl);
  try {
    const settings = JSON.parse(await readFile(config.settingsFile, 'utf8')) as { publicBaseUrl?: unknown };
    addUrlHost(settings.publicBaseUrl);
  } catch {
    // The settings file is optional before first startup.
  }
  return hosts;
}

async function generateLocalCertificate(config: WebglowConfig, requestedHosts: string[] = []): Promise<{ cert: Buffer; key: Buffer; caFile: string; names: CertificateNames }> {
  const tlsDirectory = join(dirname(config.dataFile), AUTO_TLS_DIRECTORY);
  await mkdir(tlsDirectory, { recursive: true, mode: 0o700 });
  await chmod(tlsDirectory, 0o700);

  const caKeyFile = join(tlsDirectory, 'ca.key');
  const caFile = join(tlsDirectory, 'ca.crt');
  const keyFile = join(tlsDirectory, 'server.key');
  const certFile = join(tlsDirectory, 'server.crt');
  const manifestFile = join(tlsDirectory, 'server.json');
  let previousHosts: string[] = [];
  try {
    const previousManifest = JSON.parse(await readFile(manifestFile, 'utf8')) as { names?: unknown };
    if (Array.isArray(previousManifest.names)) {
      previousHosts = previousManifest.names.flatMap((name) => {
        if (typeof name !== 'string') return [];
        const host = name.replace(/^(?:DNS|IP):/, '');
        return /^(?:DNS|IP):/.test(name) ? [host] : [];
      });
    }
  } catch {
    // No generated leaf certificate exists yet.
  }
  const names = parseCertificateNames(config, [...await configuredHosts(config), ...previousHosts, ...requestedHosts]);
  const canonicalNames = [...names.dns.map((name) => `DNS:${name}`), ...names.ips.map((name) => `IP:${name}`)].sort();

  let caExists = false;
  try {
    const caKey = await readFile(caKeyFile);
    const caCert = new X509Certificate(await readFile(caFile));
    caExists = Boolean(caKey.length) && caCert.ca && Date.parse(caCert.validTo) > Date.now() + 30 * 24 * 60 * 60 * 1000;
  } catch {
    caExists = false;
  }
  if (!caExists) {
    const caTempKey = join(tlsDirectory, `ca-${randomUUID()}.key.tmp`);
    const caTempCert = join(tlsDirectory, `ca-${randomUUID()}.crt.tmp`);
    const caConfig = join(tlsDirectory, `ca-${randomUUID()}.cnf.tmp`);
    try {
      await writePrivateFile(caConfig, createOpenSslConfig(names, 'ca'));
      await runOpenSsl(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', String(CA_VALID_DAYS), '-keyout', caTempKey, '-out', caTempCert, '-config', caConfig]);
      await chmod(caTempKey, 0o600);
      await rename(caTempKey, caKeyFile);
      await rename(caTempCert, caFile);
    } finally {
      await Promise.all([caTempKey, caTempCert, caConfig].map((path) => rm(path, { force: true })));
    }
  }

  const caCertificate = new X509Certificate(await readFile(caFile));
  let reuseLeaf = false;
  try {
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as { names?: string[]; fingerprint?: string };
    const existingCertificate = new X509Certificate(await readFile(certFile));
    const existingKey = await readFile(keyFile);
    reuseLeaf = Boolean(existingKey.length) &&
      manifest.fingerprint === existingCertificate.fingerprint256 &&
      JSON.stringify(manifest.names) === JSON.stringify(canonicalNames) &&
      Date.parse(existingCertificate.validTo) > Date.now() + 30 * 24 * 60 * 60 * 1000 &&
      existingCertificate.verify(caCertificate.publicKey) &&
      [...names.dns, ...names.ips].every((name) => existingCertificate.checkHost(name) !== undefined || existingCertificate.checkIP(name) !== undefined);
  } catch {
    reuseLeaf = false;
  }

  if (!reuseLeaf) {
    const tempToken = randomUUID();
    const keyTemp = join(tlsDirectory, `server-${tempToken}.key.tmp`);
    const csrTemp = join(tlsDirectory, `server-${tempToken}.csr.tmp`);
    const certTemp = join(tlsDirectory, `server-${tempToken}.crt.tmp`);
    const configTemp = join(tlsDirectory, `server-${tempToken}.cnf.tmp`);
    const serialFile = join(tlsDirectory, 'ca.srl');
    try {
      await writePrivateFile(configTemp, createOpenSslConfig(names, 'server'));
      await runOpenSsl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', keyTemp, '-out', csrTemp, '-config', configTemp]);
      await runOpenSsl(['x509', '-req', '-in', csrTemp, '-CA', caFile, '-CAkey', caKeyFile, '-CAserial', serialFile, '-CAcreateserial', '-out', certTemp, '-days', String(LEAF_VALID_DAYS), '-sha256', '-extfile', configTemp, '-extensions', 'server_certificate']);
      const certificate = new X509Certificate(await readFile(certTemp));
      await chmod(keyTemp, 0o600);
      await rename(keyTemp, keyFile);
      await rename(certTemp, certFile);
      await writeFile(manifestFile, JSON.stringify({ names: canonicalNames, fingerprint: certificate.fingerprint256 }, null, 2), { encoding: 'utf8', mode: 0o600 });
    } finally {
      await Promise.all([keyTemp, csrTemp, certTemp, configTemp].map((path) => rm(path, { force: true })));
    }
  }

  return { cert: await readFile(certFile), key: await readFile(keyFile), caFile, names };
}

async function resolveCertificate(config: WebglowConfig): Promise<{ options: ServerOptions; status: HttpsRuntimeStatus }> {
  if (config.tlsCertFile && config.tlsKeyFile) {
    const [cert, key] = await Promise.all([readFile(config.tlsCertFile), readFile(config.tlsKeyFile)]);
    const certificate = new X509Certificate(cert);
    if (Date.parse(certificate.validTo) <= Date.now()) throw new Error(`The custom HTTPS certificate at ${config.tlsCertFile} has expired.`);
    const names = parseCertificateNames(config);
    return {
      options: { cert, key, minVersion: 'TLSv1.2' },
      status: {
        enabled: true,
        port: config.httpsPort,
        certificateMode: 'custom',
        certificateHosts: [...names.dns, ...names.ips],
        trustNote: 'Custom certificate. Verify its subject names cover the public URL configured for WebGlow.',
      },
    };
  }

  const generated = await generateLocalCertificate(config);
  return {
    options: { cert: generated.cert, key: generated.key, minVersion: 'TLSv1.2' },
    status: {
      enabled: true,
      port: config.httpsPort,
      certificateMode: 'local-ca',
      certificateHosts: [...generated.names.dns, ...generated.names.ips],
      trustNote: 'Generated by WebGlow. Install and trust the WebGlow CA on each client device to avoid certificate warnings.',
    },
  };
}

function listen(server: HttpsServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function prepareHttpsListener(app: FastifyInstance, config: WebglowConfig): Promise<{ status: HttpsRuntimeStatus; start: () => Promise<number> }> {
  if (!config.httpsEnabled) {
    return {
      status: { enabled: false, port: config.httpsPort, certificateMode: 'disabled', certificateHosts: [], trustNote: 'HTTPS is disabled.' },
      start: async () => config.httpsPort,
    };
  }

  const { options, status } = await resolveCertificate(config);
  const secureServer = createServer(options, (request, response) => app.routing(request, response));
  secureServer.keepAliveTimeout = app.server.keepAliveTimeout;
  secureServer.requestTimeout = app.server.requestTimeout;
  secureServer.on('upgrade', (request, socket, head) => {
    app.server.emit('upgrade', request, socket, head);
  });
  let knownHosts = new Set(status.certificateHosts.map((host) => host.toLowerCase()));
  let refreshQueue = Promise.resolve();
  if (!config.tlsCertFile) {
    app.addHook('onRequest', async (request) => {
      if (request.protocol === 'https') return;
      const hostHeader = request.headers.host;
      if (!hostHeader) return;
      let host: string;
      try {
        host = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '');
      } catch {
        return;
      }
      if (nodeIsIP(host) === 0 && !isDnsName(host)) return;
      if (knownHosts.has(host.toLowerCase())) return;
      refreshQueue = refreshQueue.then(async () => {
        if (knownHosts.has(host.toLowerCase())) return;
        if (knownHosts.size >= 100) {
          app.log.warn({ host }, 'Ignoring an HTTPS certificate name because the 100-name limit has been reached.');
          return;
        }
        try {
          const updated = await generateLocalCertificate(config, [host]);
          secureServer.setSecureContext({ cert: updated.cert, key: updated.key, minVersion: 'TLSv1.2' });
          knownHosts = new Set([...updated.names.dns, ...updated.names.ips].map((name) => name.toLowerCase()));
          app.log.info({ host }, 'Added the HTTP request host to the generated HTTPS certificate.');
        } catch (error) {
          app.log.warn({ err: error, host }, 'Could not add the HTTP request host to the generated HTTPS certificate.');
        }
      });
      await refreshQueue;
    });
  }
  app.addHook('onClose', async () => {
    if (!secureServer.listening) return;
    await new Promise<void>((resolve, reject) => {
      secureServer.close((error) => error ? reject(error) : resolve());
    });
  });

  return {
    status,
    start: async () => {
      await listen(secureServer, config.host, config.httpsPort);
      app.log.info({ host: config.host, port: config.httpsPort, certificateMode: status.certificateMode }, 'HTTPS listener started.');
      const address = secureServer.address();
      return typeof address === 'object' && address ? address.port : config.httpsPort;
    },
  };
}
