import type { IncomingMessage } from 'node:http';
import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStarterConfig, writeConfig } from '../src/core/config.js';

const mocks = vi.hoisted(() => ({
  daily: vi.fn(),
  devLog: vi.fn(),
  status: vi.fn(),
  audits: vi.fn(),
}));

vi.mock('../src/web/preview.js', () => ({
  generateDailyReportPreview: mocks.daily,
  generateDevLogPreview: mocks.devLog,
  getDailyReportStatus: mocks.status,
}));

vi.mock('../src/web/decision-audits.js', () => ({
  getDecisionAudits: mocks.audits,
}));

import { isAuthorized } from '../src/web/auth.js';
import { MAX_JSON_BODY_BYTES } from '../src/web/request-guard.js';
import { startWebServer } from '../src/web/server.js';

const TOKEN = 'test-token-with-at-least-thirty-two-characters';

async function configPath(token?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'internflow-web-'));
  const path = join(directory, 'config.yaml');
  const config = createStarterConfig();
  if (token) config.web = { authToken: token };
  await writeConfig(config, path);
  return path;
}

function endpoint(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

function authHeaders(port: number): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    origin: `http://127.0.0.1:${port}`,
  };
}

describe.sequential('web security', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('keeps loopback generation token-free', async () => {
    mocks.daily.mockResolvedValue({ ok: true, markdown: '# report', activities: [] });
    const server = await startWebServer({ host: '127.0.0.1', port: 0 });
    try {
      const response = await fetch(endpoint(server.port, '/api/generate'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ job: 'daily-report', date: '2026-07-16' }),
      });
      expect(response.status).toBe(200);
      expect(mocks.daily).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it('filters decision audits through a validated local endpoint', async () => {
    mocks.audits.mockResolvedValue({ ok: true, date: '2026-07-16', audits: [] });
    const server = await startWebServer({ host: '127.0.0.1', port: 0 });
    try {
      const response = await fetch(endpoint(
        server.port,
        '/api/decision-audits?date=2026-07-16&job=daily-report&policy=daily.visual-need&outcome=flowchart',
      ));
      expect(response.status).toBe(200);
      expect(mocks.audits).toHaveBeenCalledWith(expect.objectContaining({
        date: '2026-07-16', job: 'daily-report', policyId: 'daily.visual-need', outcome: 'flowchart',
      }));
      expect((await fetch(endpoint(server.port, '/api/decision-audits?date=2026-02-31'))).status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('refuses a non-loopback listener without a token', async () => {
    vi.stubEnv('INTERNFLOW_WEB_TOKEN', '');
    await expect(startWebServer({
      host: '0.0.0.0',
      port: 0,
      configPath: await configPath(),
    })).rejects.toThrow('Refusing non-loopback Web binding');
  });

  it('refuses a config token when the config is not mode 0600', async () => {
    vi.stubEnv('INTERNFLOW_WEB_TOKEN', '');
    const path = await configPath(TOKEN);
    await chmod(path, 0o644);
    await expect(startWebServer({ host: '0.0.0.0', port: 0, configPath: path }))
      .rejects.toThrow('must have mode 0600');
  });

  it('requires one correct Bearer token and a same-origin request', async () => {
    vi.stubEnv('INTERNFLOW_WEB_TOKEN', '');
    const server = await startWebServer({
      host: '0.0.0.0',
      port: 0,
      configPath: await configPath(TOKEN),
    });
    try {
      const url = endpoint(server.port, '/api/health');
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: { authorization: 'Bearer wrong-token' } })).status).toBe(401);
      expect((await fetch(url, { headers: {
        ...authHeaders(server.port),
        origin: 'http://attacker.invalid',
      } })).status).toBe(403);
      expect((await fetch(url, { headers: authHeaders(server.port) })).status).toBe(200);

      const duplicate = {
        rawHeaders: ['Authorization', `Bearer ${TOKEN}`, 'Authorization', `Bearer ${TOKEN}`],
        headers: { authorization: `Bearer ${TOKEN}` },
      } as IncomingMessage;
      expect(isAuthorized(duplicate, { required: true, token: TOKEN })).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('rejects oversized, malformed, and out-of-contract generation input', async () => {
    vi.stubEnv('INTERNFLOW_WEB_TOKEN', TOKEN);
    const server = await startWebServer({ host: '0.0.0.0', port: 0 });
    const url = endpoint(server.port, '/api/generate');
    const headers = {
      ...authHeaders(server.port),
      'content-type': 'application/json',
    };
    try {
      const oversized = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: `g${'x'.repeat(MAX_JSON_BODY_BYTES)}` }),
      });
      expect(oversized.status).toBe(413);

      const unknownJob = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ job: 'shell' }),
      });
      expect(unknownJob.status).toBe(400);

      const invalidDate = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ date: '2026-02-31' }),
      });
      expect(invalidDate.status).toBe(400);

      const wrongType = await fetch(url, {
        method: 'POST',
        headers: authHeaders(server.port),
        body: '{}',
      });
      expect(wrongType.status).toBe(415);
      expect(mocks.daily).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('admits only one Codex generation at a time', async () => {
    let release: ((value: { ok: true; markdown: string; activities: never[] }) => void) | undefined;
    mocks.daily.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const server = await startWebServer({ host: '127.0.0.1', port: 0 });
    const request = () => fetch(endpoint(server.port, '/api/generate'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    try {
      const first = request();
      await vi.waitFor(() => expect(mocks.daily).toHaveBeenCalledOnce());
      const second = await request();
      expect(second.status).toBe(409);
      release?.({ ok: true, markdown: '# report', activities: [] });
      expect((await first).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('does not echo tokens or host paths in remote responses', async () => {
    vi.stubEnv('INTERNFLOW_WEB_TOKEN', TOKEN);
    mocks.status.mockResolvedValue({
      ok: true,
      date: '2026-07-16',
      sessionsDir: '/Users/private/.codex/sessions',
      activities: [{ title: 'work', cwd: '/Users/private/project', activeMinutes: 1 }],
    });
    mocks.daily.mockRejectedValue(new Error(`secret=${TOKEN}`));
    mocks.audits.mockResolvedValue({
      ok: true,
      date: '2026-07-16',
      audits: [{
        id: 'audit', job: 'daily-report', date: '2026-07-16', mode: 'enforced', generatedAt: '2026-07-16T10:00:00Z',
        inputFingerprint: '/Users/private/fingerprint', snapshotId: '/Users/private/snapshot',
        assessments: [{
          id: 'assessment', kind: 'assessment', policyId: 'daily.visual-need', policyVersion: '1.0.0',
          outcome: 'flowchart', confidence: 'high', evidence: [{ kind: 'work-item', id: '/Users/private/item' }],
          reasons: [{ code: 'daily.visual-need.flowchart', message: '值得画图', evidence: [{ kind: 'work-item', id: '/Users/private/item' }] }],
        }],
      }],
    });
    const server = await startWebServer({ host: '0.0.0.0', port: 0 });
    try {
      const status = await fetch(endpoint(server.port, '/api/status'), {
        headers: authHeaders(server.port),
      });
      const statusText = await status.text();
      expect(statusText).not.toContain('/Users/private');

      const generated = await fetch(endpoint(server.port, '/api/generate'), {
        method: 'POST',
        headers: { ...authHeaders(server.port), 'content-type': 'application/json' },
        body: '{}',
      });
      const generatedText = await generated.text();
      expect(generated.status).toBe(500);
      expect(generatedText).not.toContain(TOKEN);
      expect(generatedText).toContain('Check InternFlow logs');

      const audits = await fetch(endpoint(server.port, '/api/decision-audits?date=2026-07-16'), {
        headers: authHeaders(server.port),
      });
      const auditText = await audits.text();
      expect(auditText).toContain('daily.visual-need');
      expect(auditText).toContain('值得画图');
      expect(auditText).not.toContain('/Users/private');
      expect(auditText).not.toContain('evidence');
    } finally {
      await server.close();
    }
  });
});
