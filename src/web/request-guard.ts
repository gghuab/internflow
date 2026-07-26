import type { IncomingMessage } from 'node:http';
import { isLoopbackHost } from './auth.js';

export const MAX_JSON_BODY_BYTES = 16 * 1024;

export class WebRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function rawHeaderCount(req: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function parseAuthority(authority: string): URL {
  try {
    const url = new URL(`http://${authority}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url;
  } catch {
    throw new WebRequestError(400, 'Invalid Host header.');
  }
}

function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

export function validateRequestOrigin(req: IncomingMessage, bindHost: string): string {
  if (rawHeaderCount(req, 'host') !== 1 || !req.headers.host) {
    throw new WebRequestError(400, 'Expected exactly one Host header.');
  }
  const host = parseAuthority(req.headers.host);
  if (isLoopbackHost(bindHost) && !isLoopbackHost(host.hostname)) {
    throw new WebRequestError(403, 'Host is not allowed for this listener.');
  }
  if (!isLoopbackHost(bindHost) && !isWildcardHost(bindHost)) {
    const requested = host.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (requested !== bindHost.replace(/^\[|\]$/g, '').toLowerCase()) {
      throw new WebRequestError(403, 'Host is not allowed for this listener.');
    }
  }

  if (rawHeaderCount(req, 'origin') > 1) {
    throw new WebRequestError(400, 'Expected at most one Origin header.');
  }
  const origin = req.headers.origin;
  if (origin) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new WebRequestError(403, 'Origin is not allowed.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host.toLowerCase() !== host.host.toLowerCase()) {
      throw new WebRequestError(403, 'Origin is not allowed.');
    }
  }
  return req.headers.host;
}

export function requestUrl(req: IncomingMessage, authority: string): URL {
  const target = req.url || '/';
  if (!target.startsWith('/') || target.startsWith('//')) {
    throw new WebRequestError(400, 'Invalid request target.');
  }
  return new URL(target, `http://${authority}`);
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new WebRequestError(415, 'Expected Content-Type: application/json.');
  }
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    throw new WebRequestError(413, 'JSON body is too large.');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) throw new WebRequestError(413, 'JSON body is too large.');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};

  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new WebRequestError(400, 'Expected a JSON object body.');
  }
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new WebRequestError(400, `Invalid ${key}.`);
  }
  return value.trim();
}

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

export function parseGenerationBody(
  body: Record<string, unknown>,
  expectedJob: 'daily-report' | 'dev-log',
): { date?: string; model?: string } {
  const allowed = new Set(['date', 'model', 'job']);
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) throw new WebRequestError(400, `Unknown field: ${unknown}.`);

  const job = optionalString(body, 'job');
  if (job && job !== expectedJob) throw new WebRequestError(400, `Unknown job: ${job}.`);
  const date = optionalString(body, 'date');
  if (date && !isRealDate(date)) throw new WebRequestError(400, `Invalid date: ${date}.`);
  const model = optionalString(body, 'model');
  if (model && (model.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model))) {
    throw new WebRequestError(400, 'Invalid model.');
  }
  return {
    ...(date ? { date } : {}),
    ...(model ? { model } : {}),
  };
}
