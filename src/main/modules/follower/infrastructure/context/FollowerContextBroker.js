import crypto from 'node:crypto';

import { browseProjectFileReferences, buildProjectFileReferenceContext, canonicalProjectWorkspace } from '../../../projects/index.js';
import { redactFollowerSecrets } from '../../domain/privacy.js';

export class FollowerContextBroker {
  constructor({ store, org = null, maxItems = 500, maxTextBytes = 160 * 1024 } = {}) {
    this.store = store;
    this.org = org;
    this.maxItems = maxItems;
    this.maxTextBytes = maxTextBytes;
  }

  collect({ ownerUserId = '', workspaceId = '', window = {}, grants = {}, runId = '', authorizationEpoch = 0, currentAuthorizationEpoch = () => authorizationEpoch } = {}) {
    this.assertAuthorization(authorizationEpoch, currentAuthorizationEpoch);
    const sources = [];
    const coverage = [];
    let remainingItems = this.maxItems;
    let remainingBytes = this.maxTextBytes;
    const categoryBudgets = { conversation: 96 * 1024, projectContent: 36 * 1024 };
    const append = (category, items, { budget = '' } = {}) => {
      const accepted = [];
      let truncated = false;
      for (const item of items) {
        if (remainingItems <= 0) { truncated = true; break; }
        const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
        if (bytes > remainingBytes || (budget && bytes > categoryBudgets[budget])) { truncated = true; break; }
        remainingItems -= 1;
        remainingBytes -= bytes;
        if (budget) categoryBudgets[budget] -= bytes;
        accepted.push(item);
        sources.push(item);
      }
      coverage.push({ category, itemCount: accepted.length, truncated, warningCode: truncated ? 'context_budget_reached' : '' });
    };

    if (grants.task_activity) append('task_activity', this.collectTasks({ ownerUserId, workspaceId, window }));
    if (grants.agent_conversations) append('agent_conversations', this.collectConversations({ ownerUserId, workspaceId, window }), { budget: 'conversation' });
    if (grants.project_change_metadata || grants.project_file_content) {
      const projects = this.collectProjectChanges({ ownerUserId, workspaceId, window, includeContent: Boolean(grants.project_file_content) });
      if (grants.project_change_metadata) append('project_change_metadata', projects.metadata);
      if (grants.project_file_content) append('project_file_content', projects.content, { budget: 'projectContent' });
    }
    this.assertAuthorization(authorizationEpoch, currentAuthorizationEpoch);
    this.recordAccess({ ownerUserId, workspaceId, runId, coverage });
    return { sources, coverage, budget: { remainingItems, remainingBytes } };
  }

  resolveSources({ ownerUserId = '', workspaceId = '', reportSources = [], grants = {}, reportId = '', followupId = '' } = {}) {
    const resolved = (Array.isArray(reportSources) ? reportSources : []).map((source) => {
      if (!sourceGrantAllowed(source.sourceKind, grants)) return sourceResolution(source, 'permission_changed');
      const reference = source.localReference || {};
      if (reference.type === 'task_run') return this.resolveTaskSource(source, { ownerUserId, workspaceId, reference });
      if (reference.type === 'session_message') return this.resolveSessionSource(source, { ownerUserId, workspaceId, reference });
      if (reference.type === 'social_direct') return this.resolveDirectSource(source, { ownerUserId, workspaceId, reference });
      if (reference.type === 'social_group') return this.resolveGroupSource(source, { ownerUserId, workspaceId, reference });
      if (reference.type === 'project_file') return this.resolveProjectSource(source, { ownerUserId, workspaceId, reference });
      return sourceResolution(source, 'local_unavailable');
    });
    this.recordResolutionAccess({ ownerUserId, workspaceId, reportId, followupId, resolved });
    return resolved;
  }

  resolveTaskSource(source, { ownerUserId, workspaceId, reference }) {
    const row = this.store.db.prepare(`SELECT id,owner_user_id,account_workspace_id,title,status,created_at,updated_at
      FROM task_runs WHERE id=? AND owner_user_id=? AND account_workspace_id=?`).get(reference.id, ownerUserId, workspaceId);
    if (!row) return sourceResolution(source, 'deleted');
    return sourceResolution(source, sourceChanged(source, row.updated_at || row.created_at || row.id) ? 'changed' : 'available', {
      title: safeText(row.title || 'Task', 300), currentStatus: safeStatus(row.status), target: { type: 'task_run', id: row.id },
    });
  }

  resolveSessionSource(source, { ownerUserId, workspaceId, reference }) {
    const row = this.store.db.prepare(`SELECT m.id,m.role,m.updated_at,m.created_at,m.visible,s.id AS session_id,s.title,s.status,s.department_id,
      s.agent_id,s.agent_instance_id
      FROM messages m JOIN sessions s ON s.id=m.session_id
      WHERE m.id=? AND s.id=? AND s.user_id=? AND s.account_workspace_id=?`).get(reference.messageId, reference.sessionId, ownerUserId, workspaceId);
    if (!row || row.status === 'deleted') return sourceResolution(source, 'deleted');
    if (!Number(row.visible)) return sourceResolution(source, 'withdrawn');
    const privateSource = source.sourceKind === 'private_assistant_message';
    if (privateSource !== (row.department_id === 'private_assistant')) return sourceResolution(source, 'permission_changed');
    const instance = row.agent_instance_id ? this.store.getUserAgentInstance?.(row.agent_instance_id) : null;
    const familyId = instance?.agentFamilyId || row.agent_id || '';
    const family = familyId ? this.store.getAgentFamily?.(familyId) : null;
    const agentLabel = safeText(instance?.displayName || family?.name || this.org?.agent?.(familyId)?.name || '', 120);
    return sourceResolution(source, sourceChanged(source, row.updated_at || row.created_at || row.id) ? 'changed' : 'available', {
      title: safeText(row.title || (privateSource ? 'Private Assistant' : 'Agent conversation'), 300),
      agentLabel,
      role: ['user', 'assistant'].includes(row.role) ? row.role : '',
      groupKey: `session:${row.session_id}`,
      target: { type: 'session_message', sessionId: row.session_id, messageId: row.id },
    });
  }

  resolveDirectSource(source, { ownerUserId, workspaceId, reference }) {
    const row = this.store.db.prepare(`SELECT message.id,message.updated_at,message.created_at,message.metadata_json
      FROM social_messages message
      WHERE message.id=? AND message.conversation_id=? AND message.account_workspace_id=?
        AND (message.sender_user_id=? OR message.recipient_user_id=?)
        AND EXISTS (SELECT 1 FROM conversation_account_bindings binding JOIN accounts account ON account.id=binding.account_id
          WHERE binding.conversation_id=message.conversation_id AND binding.access_status='active'
            AND account.owner_user_id=? AND account.status IN ('active','external'))`).get(
      reference.messageId, reference.conversationId, workspaceId, ownerUserId, ownerUserId, ownerUserId,
    );
    if (!row) return sourceResolution(source, 'permission_changed');
    if (jsonFlag(row.metadata_json, 'withdrawn')) return sourceResolution(source, 'withdrawn');
    return sourceResolution(source, sourceChanged(source, row.updated_at || row.created_at || row.id) ? 'changed' : 'available', {
      title: 'Direct message', target: { type: 'social_direct', conversationId: reference.conversationId, messageId: row.id },
    });
  }

  resolveGroupSource(source, { ownerUserId, workspaceId, reference }) {
    const row = this.store.db.prepare(`SELECT message.id,message.updated_at,message.created_at,message.metadata_json,groups.title
      FROM chat_group_messages message JOIN chat_groups groups ON groups.id=message.group_id
      JOIN chat_group_members member ON member.group_id=message.group_id AND member.user_id=? AND member.status='active'
      WHERE message.id=? AND message.group_id=? AND message.account_workspace_id=? AND groups.status<>'dissolved'`).get(
      ownerUserId, reference.messageId, reference.groupId, workspaceId,
    );
    if (!row) return sourceResolution(source, 'permission_changed');
    if (jsonFlag(row.metadata_json, 'withdrawn')) return sourceResolution(source, 'withdrawn');
    return sourceResolution(source, sourceChanged(source, row.updated_at || row.created_at || row.id) ? 'changed' : 'available', {
      title: safeText(row.title || 'Group conversation', 300), target: { type: 'social_group', groupId: reference.groupId, messageId: row.id },
    });
  }

  resolveProjectSource(source, { ownerUserId, workspaceId, reference }) {
    const user = { id: ownerUserId };
    try {
      const project = (this.store.listProjects?.({ user, accountWorkspaceId: workspaceId, limit: 500 }) || [])
        .find((item) => item.id === reference.projectId);
      if (!project) return sourceResolution(source, 'permission_changed');
      const entries = browseProjectFileReferences({ store: this.store, user, projectId: project.id, limit: 1000,
        canonicalizeWorkspace: canonicalProjectWorkspace }).entries || [];
      const entry = entries.find((item) => item.kind === 'file' && item.relativePath === reference.relativePath);
      if (!entry) return sourceResolution(source, 'deleted');
      const currentVersion = entry.modifiedAt || String(entry.sizeBytes || '');
      return sourceResolution(source, sourceChanged(source, currentVersion) ? 'changed' : 'available', {
        title: safeText(`${project.title || 'Project'} · ${entry.relativePath}`, 300),
        target: { type: 'project_file', projectId: project.id, relativePath: entry.relativePath },
      });
    } catch {
      return sourceResolution(source, 'local_unavailable');
    }
  }

  collectTasks({ ownerUserId = '', workspaceId = '', window = {} } = {}) {
    const start = Date.parse(window.startAt || 0);
    const end = Date.parse(window.endAt || Date.now());
    return (this.store.listTaskRuns?.({ userId: ownerUserId, workspaceId, limit: 500 }) || [])
      .filter((task) => withinWindow(task.updatedAt || task.createdAt, start, end) || taskActive(task.status))
      .slice(0, 300)
      .map((summary) => {
        const task = this.store.getTaskRun?.(summary.id) || summary;
        const nodes = Array.isArray(task.nodes) ? task.nodes : [];
        const completed = nodes.filter((node) => node.status === 'completed').slice(-5).map((node) => safeText(node.resultSummary || node.title, 500));
        const blocked = nodes.filter((node) => ['waiting', 'blocked', 'retry_wait', 'failed'].includes(String(node.status || '')))
          .slice(0, 5).map((node) => safeText(node.waitReason || node.errorText || node.title, 300));
        return sourceRecord({
          sourceKind: 'task_run', sourceId: task.id, sourceVersion: task.updatedAt || task.createdAt || task.id,
          occurredAt: task.updatedAt || task.createdAt || '', title: safeText(task.title || 'Task', 300), status: safeStatus(task.status),
          text: safeText(completed.join('；') || task.summary || task.title, 1200), blocker: safeText(blocked.join('；'), 600),
          localReference: { type: 'task_run', id: task.id },
        });
      });
  }

  collectConversations({ ownerUserId = '', workspaceId = '', window = {} } = {}) {
    const params = [ownerUserId, workspaceId, window.startAt, window.endAt];
    const rows = this.store.db.prepare(`SELECT m.id,m.session_id,m.role,m.content,m.created_at,m.updated_at,
      s.title AS session_title,s.department_id,s.agent_id
      FROM messages m JOIN sessions s ON s.id=m.session_id
      WHERE s.user_id=? AND s.account_workspace_id=? AND s.status<>'deleted' AND m.visible=1
        AND m.created_at>=? AND m.created_at<=? AND s.department_id<>'private_assistant'
        AND m.role IN ('user','assistant') ORDER BY m.created_at DESC,m.id DESC LIMIT 240`).all(...params);
    return rows.reverse().map((row) => sourceRecord({
      sourceKind: 'agent_message',
      sourceId: row.id, sourceVersion: row.updated_at || row.created_at || row.id, occurredAt: row.created_at,
      title: safeText(row.session_title || 'Agent conversation', 200),
      status: row.role === 'assistant' ? 'assistant_reply' : 'user_message', text: safeText(row.content, 1000),
      localReference: { type: 'session_message', sessionId: row.session_id, messageId: row.id },
    }));
  }

  collectProjectChanges({ ownerUserId = '', workspaceId = '', window = {}, includeContent = false } = {}) {
    const user = { id: ownerUserId };
    const projects = this.store.listProjects?.({ user, accountWorkspaceId: workspaceId, limit: 24 }) || [];
    const metadata = [];
    const content = [];
    const start = Date.parse(window.startAt || 0);
    const end = Date.parse(window.endAt || Date.now());
    for (const project of projects) {
      let entries = [];
      try {
        entries = browseProjectFileReferences({ store: this.store, user, projectId: project.id, limit: 160, canonicalizeWorkspace: canonicalProjectWorkspace }).entries || [];
      } catch {
        continue;
      }
      const recentFiles = entries.filter((entry) => entry.kind === 'file' && withinWindow(entry.modifiedAt, start, end)).slice(0, 40);
      for (const entry of recentFiles) {
        metadata.push(sourceRecord({ sourceKind: 'project_change', sourceId: `${project.id}:${entry.relativePath}`,
          sourceVersion: entry.modifiedAt || `${entry.sizeBytes}`, occurredAt: entry.modifiedAt,
          title: `${project.title || 'Project'} · ${entry.relativePath}`, status: 'modified',
          text: `type=file; size=${Number(entry.sizeBytes || 0)} bytes; modified=${entry.modifiedAt || ''}`,
          localReference: { type: 'project_file', projectId: project.id, relativePath: entry.relativePath } }));
      }
      if (!includeContent) continue;
      for (const entry of recentFiles.slice(0, 3)) {
        try {
          const reference = { referenceId: `follower:${project.id}:${entry.relativePath}`, referenceKind: 'file', projectId: project.id,
            relativePath: entry.relativePath, name: entry.name, source: 'picker' };
          const built = buildProjectFileReferenceContext({ store: this.store, user, projectId: project.id, references: [reference], canonicalizeWorkspace: canonicalProjectWorkspace });
          if (!built.context) continue;
          content.push(sourceRecord({ sourceKind: 'project_file_excerpt', sourceId: `${project.id}:${entry.relativePath}`,
            sourceVersion: built.references[0]?.contentHash || entry.modifiedAt, occurredAt: entry.modifiedAt,
            title: `${project.title || 'Project'} · ${entry.relativePath}`, status: 'excerpt', text: safeTextBytes(built.context, 12 * 1024),
            localReference: { type: 'project_file', projectId: project.id, relativePath: entry.relativePath } }));
        } catch {}
      }
    }
    return { metadata, content };
  }

  assertAuthorization(expected, provider) {
    if (Number(provider?.() || 0) !== Number(expected || 0)) {
      const error = new Error('Follower authorization changed during collection.');
      error.code = 'follower_authorization_changed';
      throw error;
    }
  }

  recordAccess({ ownerUserId, workspaceId, runId, coverage }) {
    const now = new Date().toISOString();
    const statement = this.store.db.prepare(`INSERT INTO follower_access_events(
      id,owner_user_id,account_workspace_id,run_id,followup_id,category,operation,outcome,source_hash,item_count,reason_code,created_at
    ) VALUES(?,?,?,?, '',?,'collect','allowed','',?,'',?)`);
    for (const item of coverage) {
      statement.run(`follower_access_${crypto.randomUUID()}`, ownerUserId, workspaceId, runId, item.category, Number(item.itemCount || 0), now);
    }
  }

  recordResolutionAccess({ ownerUserId, workspaceId, reportId, followupId, resolved }) {
    const counts = new Map();
    for (const item of resolved) counts.set(item.sourceKind, (counts.get(item.sourceKind) || 0) + 1);
    const now = new Date().toISOString();
    const statement = this.store.db.prepare(`INSERT INTO follower_access_events(
      id,owner_user_id,account_workspace_id,run_id,followup_id,category,operation,outcome,source_hash,item_count,reason_code,created_at
    ) VALUES(?,?,?,'',?,?,?,?,?,?,?,?)`);
    for (const [category, itemCount] of counts) statement.run(`follower_access_${crypto.randomUUID()}`, ownerUserId, workspaceId,
      followupId || '', category, 'resolve_source', 'allowed', reportId ? hash(reportId) : '', itemCount, '', now);
  }
}

export { redactFollowerSecrets } from '../../domain/privacy.js';

function sourceRecord(value = {}) {
  const content = [value.title, value.status, value.text, value.blocker].filter(Boolean).join('\n');
  const contentHash = crypto.createHash('sha256').update(content).digest('hex');
  return {
    refId: `source_${crypto.createHash('sha256').update(`${value.sourceKind}:${value.sourceId}:${value.sourceVersion}`).digest('hex').slice(0, 32)}`,
    sourceKind: value.sourceKind, sourceId: String(value.sourceId || ''), sourceVersion: String(value.sourceVersion || ''),
    contentHash, occurredAt: String(value.occurredAt || ''), observedAt: new Date().toISOString(),
    title: value.title || '', status: value.status || '', text: value.text || '', blocker: value.blocker || '',
    localReference: value.localReference || {}, availabilityState: 'available',
  };
}

function taskActive(status = '') {
  return ['pending', 'ready', 'queued', 'running', 'verifying', 'waiting', 'blocked', 'retry_wait'].includes(String(status || ''));
}

function withinWindow(value, start, end) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) && time >= start && time <= end;
}

function safeStatus(value = '') {
  return String(value || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 80) || 'unknown';
}

function safeText(value = '', maximum = 800) {
  return redactFollowerSecrets(String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum)).text;
}

function safeTextBytes(value = '', maximumBytes = 12 * 1024) {
  const redacted = redactFollowerSecrets(String(value || '').replace(/\s+/g, ' ').trim()).text;
  if (Buffer.byteLength(redacted, 'utf8') <= maximumBytes) return redacted;
  let low = 0; let high = redacted.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(redacted.slice(0, middle), 'utf8') <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return redacted.slice(0, low);
}

function sourceGrantAllowed(sourceKind = '', grants = {}) {
  if (sourceKind === 'task_run') return Boolean(grants.task_activity);
  if (sourceKind === 'agent_message') return Boolean(grants.agent_conversations);
  if (sourceKind === 'project_change') return Boolean(grants.project_change_metadata);
  if (sourceKind === 'project_file_excerpt') return Boolean(grants.project_file_content);
  return false;
}

function sourceResolution(source, availabilityState, extra = {}) {
  return { refId: source.refId || '', sourceKind: source.sourceKind || '', sourceVersion: source.sourceVersion || '',
    occurredAt: source.occurredAt || '', observedAt: source.observedAt || '', availabilityState, title: extra.title || source.sourceKind || '',
    currentStatus: extra.currentStatus || '', agentLabel: extra.agentLabel || '', role: extra.role || '', groupKey: extra.groupKey || '',
    target: extra.target || null };
}

function sourceChanged(source, currentVersion) {
  return Boolean(source.sourceVersion && currentVersion && String(source.sourceVersion) !== String(currentVersion));
}

function jsonFlag(value, key) {
  try { return JSON.parse(String(value || '{}'))?.[key] === true; } catch { return false; }
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}
