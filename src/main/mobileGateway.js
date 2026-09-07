import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_KEY = 'mobile_gateway:tokens:v1';

export function createMobileGateway({ runtime, host = '0.0.0.0', port = 3210, logger = console } = {}) {
  if (!runtime) throw new Error('Mobile Gateway requires a runtime.');
  const server = http.createServer((req, res) => handleRequest(req, res));
  const runs = new Map();
  const eventClients = new Set();
  const pairingAttempts = new Map();
  let pairing = newPairing();
  let listening = false;

  function json(res, status, body) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  }
  function cors(res) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  }
  function tokenRows() {
    try { return JSON.parse(runtime.store.settingGet(TOKEN_KEY, '[]')) || []; } catch { return []; }
  }
  function saveToken(row) {
    runtime.store.settingSet(TOKEN_KEY, JSON.stringify([...tokenRows().filter((item) => item.id !== row.id), row].slice(-10)));
  }
  function authorized(req, tokenOverride = '') {
    const token = String(tokenOverride || req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return false;
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const currentUserId = String(runtime.currentUser?.()?.id || '');
    const row = tokenRows().find((item) => item.hash === hash && item.userId === currentUserId);
    if (row) { row.lastUsedAt = new Date().toISOString(); saveToken(row); return true; }
    return false;
  }
  async function body(req) {
    let value = '';
    for await (const chunk of req) { value += chunk; if (value.length > 1_000_000) throw new Error('请求过大。'); }
    if (!value) return {};
    return JSON.parse(value);
  }
  function publicSession(session) {
    return { id: session.id, title: session.title || '', departmentId: session.departmentId || '', agentId: session.agentId || '', updatedAt: session.updatedAt || session.updated_at || '', createdAt: session.createdAt || session.created_at || '' };
  }
  function publicMessage(message) {
    return { id: message.id, role: message.role, content: message.content || '', createdAt: message.createdAt || message.created_at || '' };
  }
  function runSnapshot(run) {
    return { id: run.id, status: run.status, sessionId: run.sessionId, answer: run.answer || '', error: run.error || '', events: run.events.slice(-100), updatedAt: run.updatedAt };
  }
  function publish(event) {
    const packet = `event: janus\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of [...eventClients]) { try { client.res.write(packet); } catch { eventClients.delete(client); } }
  }
  function streamToken(req) { return String(new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).searchParams.get('token') || ''); }
  async function handleRequest(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return json(res, 204, {});
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/mobile' || url.pathname === '/mobile/') {
        const html = fs.readFileSync(path.join(__dirname, '../mobile/index.html'), 'utf8');
        res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); return;
      }
      if (url.pathname === '/mobile/pairing' && req.method === 'GET') return json(res, 200, { ok: true, expiresAt: pairing.expiresAt });
      if (url.pathname === '/mobile/pair' && req.method === 'POST') {
        const currentUser = runtime.currentUser?.();
        if (!currentUser?.id) return json(res, 409, { ok: false, error: '请先在电脑端登录 Janus。' });
        const remoteAddress = String(req.socket.remoteAddress || 'unknown');
        const recentAttempts = (pairingAttempts.get(remoteAddress) || []).filter((time) => Date.now() - time < 60_000);
        if (recentAttempts.length >= 10) return json(res, 429, { ok: false, error: '配对尝试过于频繁，请一分钟后重试。' });
        const input = await body(req);
        if (String(input.code || '').trim() !== pairing.code || Date.now() > pairing.expiresAt) {
          pairingAttempts.set(remoteAddress, [...recentAttempts, Date.now()]);
          return json(res, 401, { ok: false, error: '配对码无效或已过期。' });
        }
        pairingAttempts.delete(remoteAddress);
        const token = `mgt_${crypto.randomBytes(32).toString('base64url')}`;
        saveToken({ id: crypto.randomUUID(), userId: currentUser.id, hash: crypto.createHash('sha256').update(token).digest('hex'), createdAt: new Date().toISOString(), deviceName: String(input.deviceName || '手机').slice(0, 80) });
        pairing = newPairing();
        return json(res, 201, { ok: true, token });
      }
      if (url.pathname === '/mobile/events' && req.method === 'GET') {
        if (!authorized(req, streamToken(req))) return json(res, 401, { ok: false, error: '手机尚未配对。' });
        res.statusCode = 200; res.setHeader('content-type', 'text/event-stream; charset=utf-8'); res.setHeader('cache-control', 'no-cache'); res.setHeader('connection', 'keep-alive'); res.write(': connected\n\n');
        const client = { res }; eventClients.add(client); const timer = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20_000); req.on('close', () => { clearInterval(timer); eventClients.delete(client); }); return;
      }
      if (!authorized(req)) return json(res, 401, { ok: false, error: '手机尚未配对。' });
      if (url.pathname === '/mobile/bootstrap' && req.method === 'GET') return json(res, 200, { ok: true, user: runtime.currentUser?.() || null, gateway: { port: server.address()?.port || port, addresses: localAddresses(port) } });
      if (url.pathname === '/mobile/sessions' && req.method === 'GET') {
        const listed = runtime.listSessions({ limit: Math.min(100, Number(url.searchParams.get('limit') || 30)) });
        const sessions = Array.isArray(listed) ? listed : (Array.isArray(listed?.sessions) ? listed.sessions : Array.isArray(listed?.items) ? listed.items : []);
        const secretarySessions = sessions.filter((session) => session.departmentId === 'secretary_department' || session.department_id === 'secretary_department');
        const visible = secretarySessions.length || sessions.some((session) => session.departmentId || session.department_id) ? secretarySessions : sessions;
        return json(res, 200, { ok: true, sessions: visible.map(publicSession) });
      }
      if (url.pathname === '/mobile/sessions/new' && req.method === 'POST') {
        const input = await body(req); const session = runtime.ensureSecretarySession({ title: String(input.title || 'uBuddy').slice(0, 120) });
        return json(res, 201, { ok: true, session: publicSession(session) });
      }
      const messagesMatch = url.pathname.match(/^\/mobile\/sessions\/([^/]+)\/messages$/);
      if (messagesMatch && req.method === 'GET') {
        const page = runtime.listMessagePage({ sessionId: decodeURIComponent(messagesMatch[1]), limit: Math.min(200, Number(url.searchParams.get('limit') || 100)) });
        return json(res, 200, { ok: true, messages: (page?.items || page?.messages || page || []).map(publicMessage), nextCursor: page?.nextCursor || '' });
      }
      if (url.pathname === '/mobile/chat/send' && req.method === 'POST') {
        const input = await body(req); const instruction = String(input.instruction || input.message || '').trim();
        if (!instruction) return json(res, 400, { ok: false, error: '请输入指令。' });
        const id = `mobile:${crypto.randomUUID()}`; const session = runSession(input.sessionId); const run = { id, status: 'queued', sessionId: session.id, answer: '', error: '', events: [], updatedAt: new Date().toISOString() }; runs.set(id, run); publish({ type: 'run.created', run: runSnapshot(run) });
        const chat = runtime.secretaryChat || runtime.sendChat;
        if (typeof chat !== 'function') throw new Error('移动端聊天服务不可用。');
        void chat.call(runtime, { sessionId: run.sessionId, message: instruction, instruction, sandboxPermission: 'request-approval', onEvent: (event) => { run.events.push({ ...event, receivedAt: new Date().toISOString() }); run.actualRunId = event.runId || run.actualRunId; run.sessionId = event.sessionId || run.sessionId; run.status = event.kind === 'done' ? 'completed' : event.kind === 'error' ? 'failed' : event.kind === 'cancelled' ? 'cancelled' : event.kind === 'approval-request' ? 'approval_denied' : 'running'; run.answer = event.answer || run.answer; run.updatedAt = new Date().toISOString(); publish({ type: 'run.updated', run: runSnapshot(run), event }); if (event.kind === 'approval-request' && event.runId && event.approvalId) void runtime.resolveChatApproval?.({ runId: event.runId, approvalId: event.approvalId, approved: false }); } }).then((result) => { run.status = result?.cancelled ? 'cancelled' : 'completed'; run.sessionId = result?.session?.id || run.sessionId; run.answer = result?.answer || run.answer; run.updatedAt = new Date().toISOString(); publish({ type: 'run.updated', run: runSnapshot(run) }); }).catch((error) => { run.status = 'failed'; run.error = String(error?.message || error); run.updatedAt = new Date().toISOString(); publish({ type: 'run.updated', run: runSnapshot(run) }); });
        return json(res, 202, { ok: true, run: runSnapshot(run) });
      }
      const runMatch = url.pathname.match(/^\/mobile\/runs\/([^/]+)$/);
      if (runMatch && req.method === 'GET') { const run = runs.get(decodeURIComponent(runMatch[1])); return run ? json(res, 200, { ok: true, run: runSnapshot(run) }) : json(res, 404, { ok: false, error: '运行记录不存在。' }); }
      if (runMatch && req.method === 'POST' && url.searchParams.get('action') === 'cancel') { const run = runs.get(decodeURIComponent(runMatch[1])); if (!run) return json(res, 404, { ok: false, error: '运行记录不存在。' }); const result = await runtime.cancelChat({ runId: run.actualRunId || '' }); run.status = 'cancelled'; publish({ type: 'run.updated', run: runSnapshot(run) }); return json(res, 200, { ok: true, result }); }
      return json(res, 404, { ok: false, error: '接口不存在。' });
    } catch (error) { logger.warn?.('mobile-gateway-request-failed', { error }); return json(res, 500, { ok: false, error: String(error?.message || error) }); }
  }
  function runSession(sessionId = '') {
    const requested = String(sessionId || '').trim();
    if (requested) {
      const existing = runtime.listSessions({ limit: 100, includeArchived: false }).find((session) => session.id === requested && session.departmentId === 'secretary_department');
      if (existing) return existing;
    }
    return runtime.ensureSecretarySession({});
  }
  return {
    start() { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { listening = true; logger.info?.(`Mobile Gateway listening on ${localAddresses(server.address()?.port || port).join(', ')}`); resolve(this.status()); }); }); },
    stop() { if (!listening) return Promise.resolve(); listening = false; return new Promise((resolve) => server.close(() => resolve())); },
    status() { if (Date.now() > pairing.expiresAt) pairing = newPairing(); return { listening, port: server.address()?.port || port, addresses: localAddresses(server.address()?.port || port), pairingCode: pairing.code, pairingExpiresAt: pairing.expiresAt }; },
  };
}

function newPairing() { return { code: String(Math.floor(100000 + Math.random() * 900000)), expiresAt: Date.now() + 5 * 60_000 }; }
function localAddresses(port) { const addresses = []; for (const values of Object.values(os.networkInterfaces())) for (const item of values || []) if (item.family === 'IPv4' && !item.internal) addresses.push(`http://${item.address}:${port}/mobile`); return addresses.length ? addresses : [`http://127.0.0.1:${port}/mobile`]; }
