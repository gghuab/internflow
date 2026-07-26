import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { loadConfig } from '../core/config.js';
import { defaultConfigPath, expandHome } from '../core/paths.js';

export interface WebAuth {
  required: boolean;
  token: string | null;
}

function normalizedHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
}

export function isLoopbackHost(host: string): boolean {
  const value = normalizedHost(host).replace(/\.$/, '');
  if (value === 'localhost' || value === '::1') return true;
  if (isIP(value) === 4) return value.startsWith('127.');
  return value.startsWith('::ffff:127.');
}

function validToken(token: string | undefined): string | null {
  const value = token?.trim();
  if (!value) return null;
  if (value.length < 32 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error(
      'INTERNFLOW_WEB_TOKEN must contain at least 32 printable ASCII characters without spaces.',
    );
  }
  return value;
}

export async function resolveWebAuth(host: string, configPath?: string): Promise<WebAuth> {
  if (isLoopbackHost(host)) return { required: false, token: null };

  const environmentToken = validToken(process.env.INTERNFLOW_WEB_TOKEN);
  if (environmentToken) return { required: true, token: environmentToken };

  const path = expandHome(configPath || defaultConfigPath());
  let configToken: string | null = null;
  if (existsSync(path)) {
    const config = await loadConfig(path);
    configToken = validToken(config.web?.authToken);
    if (configToken) {
      const mode = (await stat(path)).mode & 0o777;
      if (mode !== 0o600) {
        throw new Error(`Web auth token config must have mode 0600: ${path}`);
      }
    }
  }

  if (!configToken) {
    throw new Error(
      'Refusing non-loopback Web binding without INTERNFLOW_WEB_TOKEN or web.authToken.',
    );
  }
  return { required: true, token: configToken };
}

function headerCount(req: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function equalSecret(actual: string, expected: string): boolean {
  const left = createHash('sha256').update(actual).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

export function isAuthorized(req: IncomingMessage, auth: WebAuth): boolean {
  if (!auth.required) return true;
  if (!auth.token || headerCount(req, 'authorization') !== 1) return false;
  const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '');
  return Boolean(match?.[1] && equalSecret(match[1], auth.token));
}
