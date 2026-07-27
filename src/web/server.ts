import { createServer, type ServerResponse } from 'node:http';
import {
  generateDailyReportPreview,
  generateDevLogPreview,
  getDailyReportStatus,
} from './preview.js';
import { isAuthorized, isLoopbackHost, resolveWebAuth } from './auth.js';
import {
  parseGenerationBody,
  readJsonBody,
  requestUrl,
  validateRequestOrigin,
  WebRequestError,
} from './request-guard.js';
import { renderUiPage } from './ui.js';
import { renderWorkspacePage } from './workspace-ui.js';
import { getWorkspaceViews } from './workspace.js';
import { getDecisionAudits } from './decision-audits.js';
import { isValidLocalDate } from '../core/calendar.js';

export interface WebServerOptions {
  host?: string;
  port?: number;
  configPath?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

function responseBody(body: unknown, remote: boolean): unknown {
  if (!remote || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  const result = { ...(body as Record<string, unknown>) };
  delete result.sessionsDir;
  delete result.decisionAuditPath;
  if (Array.isArray(result.activities)) {
    result.activities = result.activities.map((activity) => {
      const value = activity as Record<string, unknown>;
      return {
        title: value.title,
        activeMinutes: value.activeMinutes,
        userMessageCount: value.userMessageCount,
        commandCount: value.commandCount,
        changedFileCount: value.changedFileCount,
      };
    });
  }
  if (result.error) result.error = 'Request failed. Check InternFlow logs on the host.';
  if (Array.isArray(result.audits)) {
    result.audits = result.audits.map((audit) => {
      const value = audit as Record<string, unknown>;
      return {
        id: value.id,
        job: value.job,
        date: value.date,
        mode: value.mode,
        generatedAt: value.generatedAt,
        assessments: Array.isArray(value.assessments)
          ? value.assessments.map((assessment) => {
              const item = assessment as Record<string, unknown>;
              return {
                id: item.id,
                kind: item.kind,
                policyId: item.policyId,
                policyVersion: item.policyVersion,
                outcome: item.outcome,
                confidence: item.confidence,
                reasons: Array.isArray(item.reasons)
                  ? item.reasons.map((reason) => {
                      const detail = reason as Record<string, unknown>;
                      return { code: detail.code, message: detail.message };
                    })
                  : [],
              };
            })
          : [],
      };
    });
  }
  return result;
}

export async function startWebServer(options: WebServerOptions = {}): Promise<{
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}> {
  const host = options.host || '127.0.0.1';
  const port = options.port ?? 3927;
  const configPath = options.configPath;
  const auth = await resolveWebAuth(host, configPath);
  const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  // Only one generation at a time to avoid flooding Codex CLI.
  let generating = false;

  const server = createServer(async (req, res) => {
    try {
      const method = req.method || 'GET';
      const authority = validateRequestOrigin(req, host);
      const url = requestUrl(req, authority);

      if (url.pathname.startsWith('/api/') && !isAuthorized(req, auth)) {
        res.setHeader('www-authenticate', 'Bearer realm="InternFlow"');
        sendJson(res, 401, { ok: false, error: 'Unauthorized.' });
        return;
      }

      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        sendHtml(res, renderUiPage());
        return;
      }

      if (method === 'GET' && (url.pathname === '/workspace' || url.pathname === '/workspace/')) {
        sendHtml(res, renderWorkspacePage());
        return;
      }

      if (method === 'GET' && url.pathname === '/favicon.ico') {
        res.writeHead(204, { 'cache-control': 'public, max-age=86400' });
        res.end();
        return;
      }

      if (method === 'GET' && url.pathname === '/api/status') {
        const keys = [...url.searchParams.keys()];
        if (keys.some((key) => key !== 'date') || url.searchParams.getAll('date').length > 1) {
          throw new WebRequestError(400, 'Invalid status query.');
        }
        const { date } = parseGenerationBody(
          url.searchParams.has('date') ? { date: url.searchParams.get('date') } : {},
          'daily-report',
        );
        const status = await getDailyReportStatus({
          ...(date ? { date } : {}),
          ...(configPath ? { configPath } : {}),
        });
        sendJson(res, status.ok ? 200 : 500, responseBody(status, auth.required));
        return;
      }

      if (method === 'GET' && url.pathname === '/api/decision-audits') {
        const allowed = new Set(['date', 'job', 'policy', 'outcome']);
        if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) {
          throw new WebRequestError(400, 'Invalid decision audit query.');
        }
        for (const key of allowed) {
          if (url.searchParams.getAll(key).length > 1) throw new WebRequestError(400, `Duplicate ${key} query.`);
        }
        const date = url.searchParams.get('date') || '';
        const job = url.searchParams.get('job') || undefined;
        const policyId = url.searchParams.get('policy') || undefined;
        const outcome = url.searchParams.get('outcome') || undefined;
        if (!isValidLocalDate(date)) throw new WebRequestError(400, 'A valid date is required.');
        if (job && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(job)) throw new WebRequestError(400, 'Invalid job.');
        if (policyId && !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(policyId)) throw new WebRequestError(400, 'Invalid policy.');
        if (outcome && (outcome.length > 128 || /[\u0000-\u001f]/.test(outcome))) throw new WebRequestError(400, 'Invalid outcome.');
        const result = await getDecisionAudits({
          date,
          ...(job ? { job } : {}),
          ...(policyId ? { policyId } : {}),
          ...(outcome ? { outcome } : {}),
          ...(configPath ? { configPath } : {}),
        });
        sendJson(res, 200, responseBody(result, auth.required));
        return;
      }

      if (method === 'GET' && url.pathname === '/api/workspaces') {
        if (url.search) throw new WebRequestError(400, 'Query parameters are not allowed.');
        const result = await getWorkspaceViews({
          ...(configPath ? { configPath } : {}),
        });
        sendJson(res, 200, responseBody(result, auth.required));
        return;
      }

      if (method === 'POST' && url.pathname === '/api/generate') {
        if (url.search) throw new WebRequestError(400, 'Query parameters are not allowed.');
        if (generating) {
          sendJson(res, 409, {
            ok: false,
            error: 'A report generation is already in progress. Please wait.',
          });
          return;
        }
        generating = true;
        try {
          const body = parseGenerationBody(await readJsonBody(req), 'daily-report');
          const result = await generateDailyReportPreview({
            ...body,
            ...(configPath ? { configPath } : {}),
          });
          sendJson(res, result.ok ? 200 : 500, responseBody(result, auth.required));
        } finally {
          generating = false;
        }
        return;
      }

      if (method === 'POST' && url.pathname === '/api/generate-devlog') {
        if (url.search) throw new WebRequestError(400, 'Query parameters are not allowed.');
        // 与日报共用单飞锁：两个生成都调 Codex CLI，避免同时起两个进程。
        if (generating) {
          sendJson(res, 409, {
            ok: false,
            error: 'A report generation is already in progress. Please wait.',
          });
          return;
        }
        generating = true;
        try {
          const body = parseGenerationBody(await readJsonBody(req), 'dev-log');
          const result = await generateDevLogPreview({
            ...body,
            ...(configPath ? { configPath } : {}),
          });
          sendJson(res, result.ok ? 200 : 500, responseBody(result, auth.required));
        } finally {
          generating = false;
        }
        return;
      }

      if (method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { ok: false, error: `Not found: ${url.pathname}` });
    } catch (error) {
      const status = error instanceof WebRequestError ? error.status : 500;
      sendJson(res, status, {
        ok: false,
        error: status === 500 && auth.required
          ? 'Request failed. Check InternFlow logs on the host.'
          : error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Codex generation can take several minutes.
  server.requestTimeout = 20 * 60 * 1000;
  server.headersTimeout = 20 * 60 * 1000;
  server.timeout = 20 * 60 * 1000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        host,
        port: actualPort,
        url: `http://${displayHost}:${actualPort}/`,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => (error ? closeReject(error) : closeResolve()));
        }),
      });
    });
  });
}

export async function runWebCli(options: WebServerOptions = {}): Promise<void> {
  const server = await startWebServer(options);
  console.log(`InternFlow web UI: ${server.url}`);
  if (!isLoopbackHost(server.host)) {
    console.log('Remote API access requires the configured Bearer token.');
  }
  console.log('Open the URL in your browser, then click “生成今日 Codex 日报”.');
  console.log('Press Ctrl+C to stop.');
}
