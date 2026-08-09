import crypto from 'node:crypto';
import express from 'express';

import {
  appendDiagnosticEvent,
  diagnosticContext,
  diagnosticsEnabled,
  redactDiagnosticText,
  testDiagnosticFile,
} from '../../src/shared/diagnostics.js';

export function route(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

export function createExpressNetworkMiddleware({
  apiError,
  errorResponse,
  mapError = null,
  jsonLimit = '64kb',
  logger = console,
  env = process.env,
} = {}) {
  const testDiagnostics = diagnosticsEnabled(env);
  const accessLogEnabled = testDiagnostics || ['1', 'true', 'yes', 'on'].includes(String(env.JANUS_HTTP_ACCESS_LOG || '').trim().toLowerCase());
  const diagnosticFile = testDiagnosticFile('cloud-http.jsonl', env);
  return {
    jsonBody: express.json({ limit: jsonLimit }),
    requestDiagnostics(req, res, next) {
      const started = process.hrtime.bigint();
      const requestId = `req_${crypto.randomUUID()}`;
      const context = diagnosticContext(env);
      const headerRunId = testDiagnostics ? cleanDiagnosticId(req.get('x-janus-test-run-id')) : '';
      const headerCaseId = testDiagnostics ? cleanDiagnosticId(req.get('x-janus-test-case-id')) : '';
      req.requestId = requestId;
      req.diagnosticRunId = headerRunId || context.runId;
      req.diagnosticCaseId = headerCaseId || context.caseId;
      res.setHeader('x-request-id', requestId);
      res.once('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        const diagnosticPath = normalizeDiagnosticPath(req.path || req.url || '');
        const event = {
          source: 'http',
          runId: req.diagnosticRunId,
          caseId: req.diagnosticCaseId,
          level: res.statusCode >= 500 ? 'error' : 'info',
          event: 'request_complete',
          message: `${req.method} ${diagnosticPath} ${res.statusCode}`,
          durationMs,
          data: { requestId, method: req.method, path: diagnosticPath, statusCode: res.statusCode },
        };
        if (accessLogEnabled || res.statusCode >= 500) logger.info?.(`[janus-http] ${JSON.stringify(event)}`);
        if (diagnosticFile) appendDiagnosticEvent(diagnosticFile, event, { env });
      });
      next();
    },
    notFound(_req, _res, next) {
      next(apiError('not_found', '接口不存在。', 404));
    },
    errorHandler(error, req, res, _next) {
      const mapped = mapError?.(error);
      const { status, body } = errorResponse(mapped || error);
      if (status >= 500) {
        logger.error('[janus-cloud] unhandled error', {
          requestId: req?.requestId || '',
          error: {
            name: redactDiagnosticText(error?.name || 'Error'),
            code: redactDiagnosticText(error?.code || ''),
            message: redactDiagnosticText(error?.message || String(error)),
          },
        });
        if (diagnosticFile) appendDiagnosticEvent(diagnosticFile, {
          source: 'http', runId: req?.diagnosticRunId, caseId: req?.diagnosticCaseId,
          level: 'error', event: 'request_error', message: body?.error?.code || 'unhandled_error',
          data: { requestId: req?.requestId || '', statusCode: status }, error,
        }, { env });
      }
      res.status(status).json(body);
    },
  };
}

function cleanDiagnosticId(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 160);
}

function normalizeDiagnosticPath(value) {
  const pathname = String(value || '').split('?')[0];
  const normalized = pathname.split('/').map((segment) => {
    if (/^[A-Fa-f0-9]{32,}$/.test(segment)) return ':hash';
    if (segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment)) return ':id';
    return segment;
  }).join('/');
  return redactDiagnosticText(normalized, { maxLength: 2_000 });
}
