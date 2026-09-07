import fs from 'node:fs';
import path from 'node:path';

import { all } from './db.js';
import { codexHomeForSession } from './paths.js';
import { safeJsonParse } from './utils.js';

export function codexSessionJsonlPaths(root, sessionId, threadId = '') {
  const codexHome = codexHomeForSession(root, sessionId);
  if (!fs.existsSync(codexHome)) return [];
  const sessionsDir = path.join(codexHome, 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];
  const result = [];
  walkJsonl(sessionsDir, result);
  result.sort();
  if (!threadId) return result;
  const matching = result.filter((item) => path.basename(item).includes(threadId));
  return matching.length ? matching : result;
}

function walkJsonl(dir, result) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, result);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(full);
  }
}

export function readCodexVisibleMessages(root, sessionId, threadId = '') {
  const messages = [];
  for (const file of codexSessionJsonlPaths(root, sessionId, threadId)) {
    let turnContext = {};
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = safeJsonParse(line, null);
      if (!event) continue;
      if (event.type === 'turn_context' && event.payload && typeof event.payload === 'object') {
        turnContext = {
          model_id: String(event.payload.model || ''),
          reasoning_effort: String(event.payload.effort || event.payload.collaboration_mode?.settings?.reasoning_effort || ''),
          turn_id: String(event.payload.turn_id || ''),
        };
        continue;
      }
      const extracted = extractVisibleMessage(event);
      if (extracted) messages.push({ ...extracted, ...turnContext, session_id: sessionId, source_path: file });
    }
  }
  return dedupeMessages(messages);
}

function extractVisibleMessage(event) {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const createdAt = event.created_at || event.timestamp || payload.created_at || payload.timestamp || '';
  if (event.type === 'event_msg') {
    if (payload.type === 'user_message') {
      const content = payload.message || payload.content || payload.text || '';
      if (content) return { role: 'user', content: String(content), created_at: createdAt };
    }
    if (payload.type === 'agent_message') {
      const content = payload.message || payload.content || payload.text || '';
      if (content) return { role: 'assistant', content: String(content), created_at: createdAt };
    }
    if (payload.type === 'task_complete') {
      const content = payload.last_agent_message || '';
      if (content) return { role: 'assistant', content: String(content), created_at: createdAt };
    }
  }
  if (event.type === 'response_item') {
    if (payload.type === 'message' && payload.role === 'assistant') {
      const content = responseItemText(payload);
      if (content) return { role: 'assistant', content, created_at: createdAt };
    }
    if (payload.type === 'message' && payload.role === 'user') {
      const content = responseItemText(payload);
      if (content) return { role: 'user', content, created_at: createdAt };
    }
  }
  return null;
}

function responseItemText(payload) {
  const parts = [];
  for (const item of payload.content || []) {
    if (!item || typeof item !== 'object') continue;
    if ((item.type === 'output_text' || item.type === 'text' || item.type === 'input_text') && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  return parts.join('').trim();
}

function dedupeMessages(messages) {
  const seen = new Set();
  const result = [];
  for (const item of messages) {
    const key = `${item.role}\n${item.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function codexEvidenceForAgent({ db, store, root, agentId, limit = 40 }) {
  const sessions = all(
    db,
    `SELECT id, codex_thread_id, updated_at
     FROM sessions
     WHERE agent_id = ? AND status != 'deleted'
     ORDER BY updated_at DESC LIMIT 80`,
    [agentId],
  );
  const evidence = [];
  for (const session of sessions) {
    evidence.push(...readCodexVisibleMessages(root, session.id, session.codex_thread_id));
    if (evidence.length >= limit * 2) break;
  }
  if (store) evidence.push(...store.evidenceForAgent(agentId, limit));
  evidence.sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || '')));
  return dedupeMessages(evidence).slice(-limit);
}
