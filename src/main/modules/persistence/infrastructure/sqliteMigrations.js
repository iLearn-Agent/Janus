import crypto from 'node:crypto';
import { legacySessionUniqueIndexes } from './databaseHealth.js';
import {
  PERSONAL_ACCOUNT_WORKSPACE_ID,
  organizationAccountId,
  organizationAccountWorkspaceId,
  personalAccountId,
} from '../../../../shared/accountWorkspaces.js';
import {
  agentFamilyNameUsesCanonicalTemplate,
  canonicalAgentFamilyName,
  canonicalAgentInstanceDisplayName,
  compactAgentInstanceProfiles,
  repairAgentInstanceProfiles,
} from '../../../../shared/agentInstanceNaming.js';

export { DATABASE_MIGRATIONS, DATABASE_MIGRATION_IDS, databaseMigrationIdsForVersion } from './databaseMigrationRegistry.js';

export function ensureLegacyAuthUserColumns(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_users'").get();
  if (!table) return;
  const columns = new Set(db.prepare('PRAGMA table_info(auth_users)').all().map((row) => row.name));
  if (!columns.has('remote_id')) db.exec("ALTER TABLE auth_users ADD COLUMN remote_id TEXT NOT NULL DEFAULT ''");
}

export function ensureLegacyContactOrganizationColumns(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contact_organizations'").get();
  if (!table) return;
  const columns = new Set(db.prepare('PRAGMA table_info(contact_organizations)').all().map((row) => row.name));
  if (columns.has('secret_salt') && !columns.has('verification_code_salt')) {
    db.exec('ALTER TABLE contact_organizations RENAME COLUMN secret_salt TO verification_code_salt');
  }
  if (columns.has('secret_hash') && !columns.has('verification_code_hash')) {
    db.exec('ALTER TABLE contact_organizations RENAME COLUMN secret_hash TO verification_code_hash');
  }
}

export function ensureLegacyDelegationWorkspaceRoutingColumns(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_delegation_workspace_messages'").get();
  if (!table) return;
  const columns = new Set(db.prepare('PRAGMA table_info(agent_delegation_workspace_messages)').all().map((row) => row.name));
  if (!columns.has('source_event_id')) db.exec("ALTER TABLE agent_delegation_workspace_messages ADD COLUMN source_event_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('source_group_message_id')) db.exec("ALTER TABLE agent_delegation_workspace_messages ADD COLUMN source_group_message_id TEXT NOT NULL DEFAULT ''");
}

export function ensureLegacyCollaborationGroupMessageColumns(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'collaboration_group_messages'").get();
  if (!table) return;
  const columns = new Set(db.prepare('PRAGMA table_info(collaboration_group_messages)').all().map((row) => row.name));
  if (!columns.has('source_event_id')) db.exec("ALTER TABLE collaboration_group_messages ADD COLUMN source_event_id TEXT NOT NULL DEFAULT ''");
}

export function ensureLegacyWorkScopeFederationColumns(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_scopes'").get();
  if (!table) return;
  const columns = new Set(db.prepare('PRAGMA table_info(work_scopes)').all().map((row) => row.name));
  if (!columns.has('federation_type')) db.exec("ALTER TABLE work_scopes ADD COLUMN federation_type TEXT NOT NULL DEFAULT ''");
  if (!columns.has('federation_id')) db.exec("ALTER TABLE work_scopes ADD COLUMN federation_id TEXT NOT NULL DEFAULT ''");
}


export function ensureLegacySessionColumns(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
  if (!table) return;
  const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name));
  if (!columns.has('user_id')) db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local_admin'");
  if (!columns.has('conversation_id')) db.exec("ALTER TABLE sessions ADD COLUMN conversation_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('account_workspace_id')) db.exec(`ALTER TABLE sessions ADD COLUMN account_workspace_id TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}'`);
  if (!columns.has('agent_instance_id')) db.exec("ALTER TABLE sessions ADD COLUMN agent_instance_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('project_id')) db.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('workspace_root')) db.exec("ALTER TABLE sessions ADD COLUMN workspace_root TEXT NOT NULL DEFAULT ''");
  if (!columns.has('interaction_mode')) db.exec("ALTER TABLE sessions ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT ''");
  if (!columns.has('memory_use_enabled')) db.exec('ALTER TABLE sessions ADD COLUMN memory_use_enabled INTEGER NOT NULL DEFAULT 1');
  if (!columns.has('memory_generate_enabled')) db.exec('ALTER TABLE sessions ADD COLUMN memory_generate_enabled INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('goal_objective')) db.exec("ALTER TABLE sessions ADD COLUMN goal_objective TEXT NOT NULL DEFAULT ''");
  if (!columns.has('goal_status')) db.exec("ALTER TABLE sessions ADD COLUMN goal_status TEXT NOT NULL DEFAULT ''");
  if (!columns.has('goal_tokens_used')) db.exec('ALTER TABLE sessions ADD COLUMN goal_tokens_used INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('goal_token_budget')) db.exec('ALTER TABLE sessions ADD COLUMN goal_token_budget INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('goal_time_used_seconds')) db.exec('ALTER TABLE sessions ADD COLUMN goal_time_used_seconds INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('codex_thread_id')) db.exec("ALTER TABLE sessions ADD COLUMN codex_thread_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('conversation_role')) db.exec("ALTER TABLE sessions ADD COLUMN conversation_role TEXT NOT NULL DEFAULT 'standard'");
  if (!columns.has('write_state')) db.exec("ALTER TABLE sessions ADD COLUMN write_state TEXT NOT NULL DEFAULT 'writable'");
  if (!columns.has('superseded_by_session_id')) db.exec("ALTER TABLE sessions ADD COLUMN superseded_by_session_id TEXT NOT NULL DEFAULT ''");
}

export function repairPrimaryAgentSessionUniqueness(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get()) {
    return { duplicateGroups: 0, repairedSessions: 0, reboundReferences: 0 };
  }
  const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((row) => String(row.name || '')));
  const required = ['id', 'user_id', 'account_workspace_id', 'agent_instance_id', 'conversation_role', 'write_state', 'status'];
  if (!required.every((column) => columns.has(column))) {
    return { duplicateGroups: 0, repairedSessions: 0, reboundReferences: 0 };
  }
  const canonicalIndex = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_sessions_one_primary_agent'").get();
  if (canonicalIndex) db.exec('DROP INDEX IF EXISTS idx_sessions_one_primary_agent');
  normalizeNonDirectWritableSessionRoles(db);
  db.prepare("UPDATE sessions SET account_workspace_id=? WHERE account_workspace_id IS NULL OR account_workspace_id=''")
    .run(PERSONAL_ACCOUNT_WORKSPACE_ID);
  const rows = db.prepare(`SELECT id,user_id,account_workspace_id,agent_instance_id,status,created_at,updated_at
    FROM sessions WHERE agent_instance_id!='' AND conversation_role='primary' AND write_state='writable' AND status!='deleted'
    ORDER BY user_id,account_workspace_id,agent_instance_id,updated_at DESC,created_at DESC,id DESC`).all();
  const referenceTables = ['agent_context_state', 'agent_device_context_state'].filter((tableName) => (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName)
      && db.prepare(`PRAGMA table_info("${tableName}")`).all().some((row) => row.name === 'primary_session_id')
  ));
  const referencedSessionIds = new Set();
  for (const tableName of referenceTables) {
    for (const row of db.prepare(`SELECT primary_session_id FROM "${tableName}" WHERE primary_session_id!=''`).all()) {
      referencedSessionIds.add(String(row.primary_session_id || ''));
    }
  }
  const groups = new Map();
  for (const row of rows) {
    const key = [row.user_id, row.account_workspace_id, row.agent_instance_id].join('\u001f');
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  let duplicateGroups = 0;
  let repairedSessions = 0;
  let reboundReferences = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    duplicateGroups += 1;
    group.sort((left, right) => {
      const referenceDelta = Number(referencedSessionIds.has(right.id)) - Number(referencedSessionIds.has(left.id));
      if (referenceDelta) return referenceDelta;
      const activeDelta = Number(right.status === 'active') - Number(left.status === 'active');
      if (activeDelta) return activeDelta;
      const updatedDelta = String(right.updated_at || '').localeCompare(String(left.updated_at || ''));
      if (updatedDelta) return updatedDelta;
      const createdDelta = String(right.created_at || '').localeCompare(String(left.created_at || ''));
      return createdDelta || String(right.id || '').localeCompare(String(left.id || ''));
    });
    const winner = group[0];
    for (const loser of group.slice(1)) {
      if (columns.has('superseded_by_session_id')) {
        db.prepare(`UPDATE sessions SET conversation_role='history',write_state='read_only',superseded_by_session_id=? WHERE id=?`)
          .run(winner.id, loser.id);
      } else {
        db.prepare(`UPDATE sessions SET conversation_role='history',write_state='read_only' WHERE id=?`).run(loser.id);
      }
      repairedSessions += 1;
      for (const tableName of referenceTables) {
        reboundReferences += Number(db.prepare(`UPDATE "${tableName}" SET primary_session_id=? WHERE primary_session_id=?`)
          .run(winner.id, loser.id).changes || 0);
      }
    }
  }
  if (canonicalIndex) {
    db.exec(`CREATE UNIQUE INDEX idx_sessions_one_primary_agent ON sessions(user_id,account_workspace_id,agent_instance_id)
      WHERE agent_instance_id!='' AND conversation_role='primary' AND write_state='writable' AND status!='deleted'`);
  }
  return { duplicateGroups, repairedSessions, reboundReferences };
}

function normalizeNonDirectWritableSessionRoles(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get()) return 0;
  const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((row) => String(row.name || '')));
  if (!['id', 'conversation_id', 'department_id', 'agent_instance_id', 'conversation_role', 'write_state', 'status']
    .every((column) => columns.has(column))) return 0;
  const hasConversations = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversations'").get());
  const conversationKind = hasConversations
    ? `COALESCE((SELECT conversation_kind FROM conversations conversation
        WHERE conversation.id=COALESCE(NULLIF(sessions.conversation_id,''),sessions.id)), '')`
    : "''";
  return Number(db.prepare(`UPDATE sessions SET
      conversation_role=CASE
        WHEN ${conversationKind}!='' AND ${conversationKind}!='direct' THEN ${conversationKind}
        WHEN department_id='agent_delegation' THEN 'task_workspace'
        WHEN department_id='collaboration' THEN 'collaboration'
        ELSE conversation_role
      END,
      superseded_by_session_id=''
    WHERE agent_instance_id!='' AND conversation_role='primary' AND write_state='writable' AND status!='deleted'
      AND (department_id IN ('agent_delegation','collaboration')
        OR (${conversationKind}!='' AND ${conversationKind}!='direct'))`).run().changes || 0);
}

export function repairAccountWorkspaceContextConsistency(db) {
  const hasColumns = (tableName, required = []) => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName)) return false;
    const columns = new Set(db.prepare(`PRAGMA table_info("${String(tableName).replaceAll('"', '""')}")`).all().map((row) => String(row.name || '')));
    return required.every((column) => columns.has(column));
  };
  const result = {
    recoveredWorkspaces: 0,
    repairedSessions: 0,
    repairedContextSpaces: 0,
    detachedContextMemories: 0,
    repairedMessages: 0,
    repairedAccountContextStates: 0,
    repairedDeviceContextStates: 0,
    removedChatContextStates: 0,
  };
  const hasWorkspaces = hasColumns('account_workspaces', ['id', 'workspace_kind', 'name', 'status']);
  const hasMemberships = hasColumns('account_workspace_memberships', ['workspace_id', 'user_id', 'role', 'status']);
  const hasSessions = hasColumns('sessions', ['id', 'user_id', 'account_workspace_id', 'agent_id', 'agent_instance_id']);
  const hasAgentInstances = hasColumns('user_agent_instances', ['id', 'user_id', 'agent_family_id']);
  const hasMessages = hasColumns('messages', ['id', 'account_workspace_id', 'session_id', 'agent_id', 'agent_instance_id', 'context_space_id']);
  const hasMessageMemoryId = hasColumns('messages', ['memory_id']);
  const hasMemories = hasColumns('memory_documents', ['id', 'user_id', 'account_workspace_id', 'user_agent_instance_id', 'context_space_id']);
  const hasContexts = hasColumns('agent_context_spaces', ['id', 'user_id', 'account_workspace_id', 'user_agent_instance_id', 'memory_document_id']);
  const hasAccountState = hasColumns('agent_context_state', ['user_id', 'account_workspace_id', 'user_agent_instance_id', 'primary_session_id', 'active_context_space_id', 'active_memory_document_id']);
  const hasDeviceState = hasColumns('agent_device_context_state', ['user_id', 'account_workspace_id', 'user_agent_instance_id', 'primary_session_id', 'active_context_space_id', 'active_memory_document_id']);

  if (hasWorkspaces && hasSessions) {
    const missing = db.prepare(`SELECT DISTINCT s.account_workspace_id AS workspace_id,s.user_id
      FROM sessions s LEFT JOIN account_workspaces workspace ON workspace.id=s.account_workspace_id
      WHERE s.account_workspace_id!='' AND workspace.id IS NULL ORDER BY s.account_workspace_id,s.user_id`).all();
    const insertWorkspace = db.prepare(`INSERT OR IGNORE INTO account_workspaces(id,workspace_kind,name,status)
      VALUES(?,'personal','恢复的本地空间','active')`);
    const insertMembership = hasMemberships
      ? db.prepare(`INSERT OR IGNORE INTO account_workspace_memberships(workspace_id,user_id,role,status)
        VALUES(?,?,'owner','active')`)
      : null;
    for (const row of missing) {
      result.recoveredWorkspaces += Number(insertWorkspace.run(row.workspace_id).changes || 0);
      if (row.user_id && insertMembership) insertMembership.run(row.workspace_id, row.user_id);
    }
  }

  if (hasSessions && hasAgentInstances) {
    result.repairedSessions += Number(db.prepare(`UPDATE sessions SET agent_id=(SELECT instance.agent_family_id
      FROM user_agent_instances instance WHERE instance.id=sessions.agent_instance_id AND instance.user_id=sessions.user_id),
      updated_at=MAX(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE agent_instance_id!=''
      AND EXISTS (SELECT 1 FROM user_agent_instances instance WHERE instance.id=sessions.agent_instance_id
        AND instance.user_id=sessions.user_id AND (sessions.agent_id='' OR sessions.agent_id!=instance.agent_family_id))`).run().changes || 0);
    result.repairedSessions += Number(db.prepare(`UPDATE sessions SET agent_instance_id='',
      updated_at=MAX(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE agent_instance_id!=''
      AND NOT EXISTS (SELECT 1 FROM user_agent_instances instance
        WHERE instance.id=sessions.agent_instance_id AND instance.user_id=sessions.user_id)
      AND NOT EXISTS (SELECT 1 FROM user_agent_instance_aliases alias
        JOIN user_agent_instances canonical ON canonical.id=alias.canonical_instance_id AND canonical.user_id=alias.user_id
        WHERE alias.alias_instance_id=sessions.agent_instance_id AND alias.user_id=sessions.user_id)`).run().changes || 0);
  }

  if (hasContexts && hasMemories) {
    const mismatches = db.prepare(`SELECT context.*,memory.account_workspace_id AS memory_workspace_id,
        memory.user_id AS memory_user_id,memory.user_agent_instance_id AS memory_instance_id
      FROM agent_context_spaces context JOIN memory_documents memory ON memory.id=context.memory_document_id
      WHERE context.memory_document_id!='' AND (
        context.account_workspace_id!=memory.account_workspace_id OR context.user_id!=memory.user_id OR (
          context.user_agent_instance_id!=memory.user_agent_instance_id AND NOT EXISTS (
            SELECT 1 FROM user_agent_instance_aliases alias WHERE alias.user_id=context.user_id AND (
              (alias.alias_instance_id=context.user_agent_instance_id AND alias.canonical_instance_id=memory.user_agent_instance_id)
              OR (alias.alias_instance_id=memory.user_agent_instance_id AND alias.canonical_instance_id=context.user_agent_instance_id)
            )
          )
        )
      ) ORDER BY context.id`).all();
    const findEquivalent = db.prepare(`SELECT id,user_id FROM agent_context_spaces WHERE id!=? AND account_workspace_id=?
      AND user_agent_instance_id=? AND context_kind=? AND memory_document_id=? AND project_id=?
      AND task_run_id=? AND delegation_id=? AND group_id=? AND relationship_user_id=? AND legacy_session_id=? LIMIT 1`);
    for (const row of mismatches) {
      const identityCompatible = row.user_id === row.memory_user_id && (
        row.user_agent_instance_id === row.memory_instance_id
        || Boolean(db.prepare(`SELECT 1 FROM user_agent_instance_aliases WHERE user_id=? AND (
          (alias_instance_id=? AND canonical_instance_id=?) OR (alias_instance_id=? AND canonical_instance_id=?)) LIMIT 1`)
          .get(row.user_id, row.user_agent_instance_id, row.memory_instance_id, row.memory_instance_id, row.user_agent_instance_id))
      );
      if (!identityCompatible) {
        result.detachedContextMemories += Number(db.prepare("UPDATE agent_context_spaces SET memory_document_id='',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run(row.id).changes || 0);
        db.prepare("UPDATE memory_documents SET context_space_id='',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND context_space_id=?")
          .run(row.memory_document_id, row.id);
        continue;
      }
      const equivalent = findEquivalent.get(
        row.id, row.memory_workspace_id, row.user_agent_instance_id, row.context_kind,
        row.memory_document_id, row.project_id, row.task_run_id, row.delegation_id, row.group_id,
        row.relationship_user_id, row.legacy_session_id,
      );
      if (equivalent?.id && equivalent.user_id !== row.user_id) {
        result.detachedContextMemories += Number(db.prepare("UPDATE agent_context_spaces SET memory_document_id='',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run(row.id).changes || 0);
        db.prepare("UPDATE memory_documents SET context_space_id='',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND context_space_id=?")
          .run(row.memory_document_id, row.id);
      } else if (equivalent?.id) {
        if (hasMessages) db.prepare('UPDATE messages SET context_space_id=? WHERE context_space_id=? AND account_workspace_id=?')
          .run(equivalent.id, row.id, row.memory_workspace_id);
        if (hasAccountState) db.prepare('UPDATE agent_context_state SET active_context_space_id=? WHERE active_context_space_id=? AND account_workspace_id=?')
          .run(equivalent.id, row.id, row.memory_workspace_id);
        if (hasDeviceState) db.prepare('UPDATE agent_device_context_state SET active_context_space_id=? WHERE active_context_space_id=? AND account_workspace_id=?')
          .run(equivalent.id, row.id, row.memory_workspace_id);
        if (hasColumns('chat_context_states', ['context_space_id'])) db.prepare('UPDATE chat_context_states SET context_space_id=? WHERE context_space_id=?')
          .run(equivalent.id, row.id);
        db.prepare('UPDATE memory_documents SET context_space_id=? WHERE id=? AND (context_space_id=? OR context_space_id=\'\')')
          .run(equivalent.id, row.memory_document_id, row.id);
        result.repairedContextSpaces += Number(db.prepare('DELETE FROM agent_context_spaces WHERE id=?').run(row.id).changes || 0);
      } else {
        result.repairedContextSpaces += Number(db.prepare(`UPDATE agent_context_spaces SET account_workspace_id=?,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(row.memory_workspace_id, row.id).changes || 0);
        db.prepare('UPDATE memory_documents SET context_space_id=? WHERE id=? AND (context_space_id=? OR context_space_id=\'\')')
          .run(row.id, row.memory_document_id, row.id);
      }
    }
    db.exec(`UPDATE memory_documents SET context_space_id='',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE context_space_id!='' AND NOT EXISTS (SELECT 1 FROM agent_context_spaces context
        WHERE context.id=memory_documents.context_space_id AND context.account_workspace_id=memory_documents.account_workspace_id
          AND context.user_id=memory_documents.user_id)`);
  }

  if (hasMessages && hasSessions) {
    result.repairedMessages += Number(db.prepare(`UPDATE messages SET
      account_workspace_id=(SELECT session.account_workspace_id FROM sessions session WHERE session.id=messages.session_id),
      agent_instance_id=CASE WHEN COALESCE((SELECT session.agent_instance_id FROM sessions session WHERE session.id=messages.session_id),'')!=''
        THEN (SELECT session.agent_instance_id FROM sessions session WHERE session.id=messages.session_id) ELSE agent_instance_id END,
      agent_id=CASE WHEN COALESCE((SELECT session.agent_instance_id FROM sessions session WHERE session.id=messages.session_id),'')!=''
        THEN COALESCE(NULLIF((SELECT session.agent_id FROM sessions session WHERE session.id=messages.session_id),''),agent_id) ELSE agent_id END,
      context_space_id=CASE WHEN context_space_id!='' AND EXISTS (
        SELECT 1 FROM agent_context_spaces context JOIN sessions session ON session.id=messages.session_id
        WHERE context.id=messages.context_space_id AND context.account_workspace_id=session.account_workspace_id
          AND (session.agent_instance_id='' OR context.user_agent_instance_id=session.agent_instance_id)
      ) THEN context_space_id ELSE '' END,
      updated_at=MAX(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      WHERE session_id!='' AND EXISTS (SELECT 1 FROM sessions session WHERE session.id=messages.session_id)
      AND NOT EXISTS (
        SELECT 1 FROM agent_context_spaces context WHERE context.id=messages.context_space_id
          AND messages.context_space_id!='' AND messages.agent_instance_id!=''
          AND context.user_agent_instance_id!=messages.agent_instance_id
          AND NOT EXISTS (SELECT 1 FROM user_agent_instance_aliases alias WHERE alias.user_id=context.user_id AND (
            (alias.alias_instance_id=messages.agent_instance_id AND alias.canonical_instance_id=context.user_agent_instance_id)
            OR (alias.alias_instance_id=context.user_agent_instance_id AND alias.canonical_instance_id=messages.agent_instance_id)
          ))
      ) AND (
        account_workspace_id!=(SELECT session.account_workspace_id FROM sessions session WHERE session.id=messages.session_id)
        OR (SELECT session.agent_instance_id FROM sessions session WHERE session.id=messages.session_id)!=''
          AND agent_instance_id!=(SELECT session.agent_instance_id FROM sessions session WHERE session.id=messages.session_id)
        OR context_space_id!='' AND NOT EXISTS (
          SELECT 1 FROM agent_context_spaces context JOIN sessions session ON session.id=messages.session_id
          WHERE context.id=messages.context_space_id AND context.account_workspace_id=session.account_workspace_id
            AND (session.agent_instance_id='' OR context.user_agent_instance_id=session.agent_instance_id)
        )
      )`).run().changes || 0);
    if (hasContexts) result.repairedMessages += Number(db.prepare(`UPDATE messages SET context_space_id='',
      updated_at=MAX(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE context_space_id!=''
      AND NOT EXISTS (SELECT 1 FROM agent_context_spaces context WHERE context.id=messages.context_space_id
        AND context.account_workspace_id=messages.account_workspace_id)`).run().changes || 0);
    if (hasMessageMemoryId && hasMemories) result.repairedMessages += Number(db.prepare(`UPDATE messages SET memory_id='',
      updated_at=MAX(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE memory_id!='' AND EXISTS (
        SELECT 1 FROM memory_documents memory WHERE memory.id=messages.memory_id
          AND memory.account_workspace_id!=messages.account_workspace_id)`).run().changes || 0);
  }
  if (hasMessages && hasAgentInstances) {
    result.repairedMessages += Number(db.prepare(`UPDATE messages SET agent_id=(SELECT instance.agent_family_id
      FROM user_agent_instances instance WHERE instance.id=messages.agent_instance_id),
      updated_at=MAX(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE agent_instance_id!=''
      AND EXISTS (SELECT 1 FROM user_agent_instances instance WHERE instance.id=messages.agent_instance_id
        AND (messages.agent_id='' OR messages.agent_id!=instance.agent_family_id))`).run().changes || 0);
    result.repairedMessages += Number(db.prepare(`UPDATE messages SET agent_instance_id='',context_space_id='',
      updated_at=MAX(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE agent_instance_id!=''
      AND NOT EXISTS (SELECT 1 FROM user_agent_instances instance WHERE instance.id=messages.agent_instance_id)
      AND NOT EXISTS (SELECT 1 FROM user_agent_instance_aliases alias
        JOIN user_agent_instances canonical ON canonical.id=alias.canonical_instance_id AND canonical.user_id=alias.user_id
        LEFT JOIN sessions session ON session.id=messages.session_id
        WHERE alias.alias_instance_id=messages.agent_instance_id
          AND (messages.session_id='' OR session.user_id=alias.user_id))`).run().changes || 0);
  }

  const repairStateTable = (tableName) => Number(db.prepare(`UPDATE "${tableName}" SET
    primary_session_id=CASE WHEN primary_session_id!='' AND EXISTS (SELECT 1 FROM sessions session
      WHERE session.id="${tableName}".primary_session_id AND session.user_id="${tableName}".user_id
        AND session.account_workspace_id="${tableName}".account_workspace_id
        AND session.agent_instance_id="${tableName}".user_agent_instance_id)
      THEN primary_session_id ELSE '' END,
    active_context_space_id=CASE WHEN active_context_space_id!='' AND EXISTS (SELECT 1 FROM agent_context_spaces context
      WHERE context.id="${tableName}".active_context_space_id AND context.user_id="${tableName}".user_id
        AND context.account_workspace_id="${tableName}".account_workspace_id
        AND context.user_agent_instance_id="${tableName}".user_agent_instance_id)
      THEN active_context_space_id ELSE '' END,
    active_memory_document_id=CASE WHEN active_memory_document_id!='' AND EXISTS (SELECT 1 FROM memory_documents memory
      WHERE memory.id="${tableName}".active_memory_document_id AND memory.user_id="${tableName}".user_id
        AND memory.account_workspace_id="${tableName}".account_workspace_id
        AND memory.user_agent_instance_id="${tableName}".user_agent_instance_id)
      THEN active_memory_document_id ELSE '' END,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE (primary_session_id!='' AND NOT EXISTS (SELECT 1 FROM sessions session
        WHERE session.id="${tableName}".primary_session_id AND session.user_id="${tableName}".user_id
          AND session.account_workspace_id="${tableName}".account_workspace_id
          AND session.agent_instance_id="${tableName}".user_agent_instance_id))
      OR (active_context_space_id!='' AND NOT EXISTS (SELECT 1 FROM agent_context_spaces context
        WHERE context.id="${tableName}".active_context_space_id AND context.user_id="${tableName}".user_id
          AND context.account_workspace_id="${tableName}".account_workspace_id
          AND context.user_agent_instance_id="${tableName}".user_agent_instance_id))
      OR (active_memory_document_id!='' AND NOT EXISTS (SELECT 1 FROM memory_documents memory
        WHERE memory.id="${tableName}".active_memory_document_id AND memory.user_id="${tableName}".user_id
          AND memory.account_workspace_id="${tableName}".account_workspace_id
          AND memory.user_agent_instance_id="${tableName}".user_agent_instance_id))`)
    .run().changes || 0);
  if (hasAccountState && hasSessions && hasContexts && hasMemories) result.repairedAccountContextStates += repairStateTable('agent_context_state');
  if (hasDeviceState && hasSessions && hasContexts && hasMemories) result.repairedDeviceContextStates += repairStateTable('agent_device_context_state');

  if (hasColumns('chat_context_states', ['session_id', 'context_space_id']) && hasSessions && hasContexts) {
    result.removedChatContextStates += Number(db.prepare(`DELETE FROM chat_context_states WHERE context_space_id!='' AND EXISTS (
      SELECT 1 FROM sessions session JOIN agent_context_spaces context ON context.id=chat_context_states.context_space_id
      WHERE session.id=chat_context_states.session_id AND session.account_workspace_id!=context.account_workspace_id
    )`).run().changes || 0);
  }
  return result;
}

export function ensureLegacySessionCanonicalStructure(db) {
  const legacyIndexes = legacySessionUniqueIndexes(db);
  if (!legacyIndexes.length) return false;
  if (!legacyIndexes.some((index) => index.tableConstraint)) {
    for (const index of legacyIndexes) {
      const quoted = `"${String(index.name).replaceAll('"', '""')}"`;
      db.exec(`DROP INDEX IF EXISTS ${quoted}`);
    }
    return true;
  }
  db.exec(`DROP TRIGGER IF EXISTS trg_sessions_agent_identity_insert;
    DROP TRIGGER IF EXISTS trg_sessions_agent_identity_update;
    DROP TRIGGER IF EXISTS trg_messages_agent_identity_insert;
    DROP TRIGGER IF EXISTS trg_messages_agent_identity_update;
    DROP TRIGGER IF EXISTS trg_agent_device_context_state_identity_insert;
    DROP TRIGGER IF EXISTS trg_agent_device_context_state_identity_update;
    DROP TRIGGER IF EXISTS trg_agent_context_state_identity_insert;
    DROP TRIGGER IF EXISTS trg_agent_context_state_identity_update;
    ALTER TABLE sessions RENAME TO sessions_legacy_unique_v1;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT 'local_admin',
      account_workspace_id TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}',
      title TEXT NOT NULL DEFAULT 'Untitled',
      department_id TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL DEFAULT '',
      agent_instance_id TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      workspace_root TEXT NOT NULL DEFAULT '',
      interaction_mode TEXT NOT NULL DEFAULT '',
      memory_use_enabled INTEGER NOT NULL DEFAULT 1,
      memory_generate_enabled INTEGER NOT NULL DEFAULT 0,
      goal_objective TEXT NOT NULL DEFAULT '',
      goal_status TEXT NOT NULL DEFAULT '',
      goal_tokens_used INTEGER NOT NULL DEFAULT 0,
      goal_token_budget INTEGER NOT NULL DEFAULT 0,
      goal_time_used_seconds INTEGER NOT NULL DEFAULT 0,
      codex_thread_id TEXT NOT NULL DEFAULT '',
      conversation_role TEXT NOT NULL DEFAULT 'standard',
      write_state TEXT NOT NULL DEFAULT 'writable',
      superseded_by_session_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      pinned_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    INSERT INTO sessions (
      id,conversation_id,user_id,account_workspace_id,title,department_id,agent_id,agent_instance_id,project_id,workspace_root,interaction_mode,
      memory_use_enabled,memory_generate_enabled,goal_objective,goal_status,goal_tokens_used,goal_token_budget,goal_time_used_seconds,
      codex_thread_id,conversation_role,write_state,superseded_by_session_id,status,pinned_at,created_at,updated_at
    ) SELECT
      id,conversation_id,user_id,account_workspace_id,title,department_id,agent_id,agent_instance_id,project_id,workspace_root,interaction_mode,
      memory_use_enabled,memory_generate_enabled,goal_objective,goal_status,goal_tokens_used,goal_token_budget,goal_time_used_seconds,
      codex_thread_id,conversation_role,write_state,superseded_by_session_id,status,pinned_at,created_at,updated_at
    FROM sessions_legacy_unique_v1;
    DROP TABLE sessions_legacy_unique_v1;`);
  return true;
}

export function ensureLegacyAccountWorkspaceColumns(db) {
  const definitions = {
    projects: `TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}'`,
    sessions: `TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}'`,
    messages: `TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}'`,
    model_executions: `TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}'`,
    memory_documents: `TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}'`,
    agent_context_spaces: `TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}'`,
    agent_context_state: `TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}'`,
    agent_device_context_state: `TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}'`,
    social_messages: `TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}'`,
    agent_delegations: `TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}'`,
    collaboration_groups: `TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}'`,
    collaboration_group_messages: `TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}'`,
    task_runs: `TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}'`,
    agent_work_queue: `TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}'`,
    agent_delivery_receipts: `TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}'`,
  };
  for (const [tableName, sql] of Object.entries(definitions)) {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
    if (!table) continue;
    const columns = new Set(db.prepare(`PRAGMA table_info("${tableName}")`).all().map((row) => row.name));
    if (!columns.has('account_workspace_id')) db.exec(`ALTER TABLE "${tableName}" ADD COLUMN account_workspace_id ${sql}`);
  }
}

export function ensureLegacyMessageContextColumns(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get();
  if (!table) return;
  const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map((row) => row.name));
  if (!columns.has('task_run_id')) db.exec("ALTER TABLE messages ADD COLUMN task_run_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('conversation_id')) db.exec("ALTER TABLE messages ADD COLUMN conversation_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('memory_id')) db.exec("ALTER TABLE messages ADD COLUMN memory_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('task_workspace_id')) db.exec("ALTER TABLE messages ADD COLUMN task_workspace_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('sender_user_id')) db.exec("ALTER TABLE messages ADD COLUMN sender_user_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('source_event_id')) db.exec("ALTER TABLE messages ADD COLUMN source_event_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('source_message_id')) db.exec("ALTER TABLE messages ADD COLUMN source_message_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('task_node_id')) db.exec("ALTER TABLE messages ADD COLUMN task_node_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('agent_id')) db.exec("ALTER TABLE messages ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('agent_instance_id')) db.exec("ALTER TABLE messages ADD COLUMN agent_instance_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('department_id')) db.exec("ALTER TABLE messages ADD COLUMN department_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('context_space_id')) db.exec("ALTER TABLE messages ADD COLUMN context_space_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('visible')) db.exec('ALTER TABLE messages ADD COLUMN visible INTEGER NOT NULL DEFAULT 1');
  if (!columns.has('metadata_json')) db.exec("ALTER TABLE messages ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
  if (!columns.has('updated_at')) db.exec("ALTER TABLE messages ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
}

export function ensureLegacyUserAgentInstanceColumns(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_agent_instances'").get();
  if (!table) return;
  const columns = new Set(db.prepare('PRAGMA table_info(user_agent_instances)').all().map((row) => row.name));
  if (!columns.has('family_instance_seq')) db.exec('ALTER TABLE user_agent_instances ADD COLUMN family_instance_seq INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('display_name')) db.exec("ALTER TABLE user_agent_instances ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  if (!columns.has('note')) db.exec("ALTER TABLE user_agent_instances ADD COLUMN note TEXT NOT NULL DEFAULT ''");
}

export function migrateDatabase(db) {
  const addColumn = (table, name, sql) => {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${sql}`);
  };

  migrateAgentAliasContextStateRepairV4(db);
  db.exec(`DROP TRIGGER IF EXISTS trg_sessions_agent_identity_insert;
  DROP TRIGGER IF EXISTS trg_sessions_agent_identity_update;
  DROP TRIGGER IF EXISTS trg_messages_agent_identity_insert;
  DROP TRIGGER IF EXISTS trg_messages_agent_identity_update;
  DROP TRIGGER IF EXISTS trg_agent_context_spaces_identity_insert;
  DROP TRIGGER IF EXISTS trg_agent_context_spaces_identity_update;
  DROP TRIGGER IF EXISTS trg_agent_device_context_state_identity_insert;
  DROP TRIGGER IF EXISTS trg_agent_device_context_state_identity_update;
  DROP TRIGGER IF EXISTS trg_agent_context_state_identity_insert;
  DROP TRIGGER IF EXISTS trg_agent_context_state_identity_update`);
  db.exec(`CREATE TABLE IF NOT EXISTS cloud_sync_entity_revisions (
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', PRIMARY KEY(entity_type,entity_id)
  )`);
  ensureProfileUpdateOutboxSchema(db);
  ensureSocialChatGroupSchema(db);
  ensureSocialDirectoryV2Schema(db);
  ensureSocialConversationArchiveSchema(db);
  ensureSocialInboxPreferenceSchema(db);
  ensureSocialChatReceiptSchema(db);
  ensureEmojiFavoritesSchema(db);
  migrateEmojiFavoriteUnicodeIdentityV2(db);
  ensureUBuddyCapabilityProfileSocialSchema(db);
  ensureUBuddyCapabilityProfileHistorySchema(db);
  ensureUBuddyDispatchCommandV3Schema(db);
  ensureUBuddyPresenceGatedDispatchSchema(db);
  ensureAttachedSkillRegistrySchema(db);
  ensureUBuddyContinuousPlanningSchema(db);
  ensureDatabaseWriterFloor100(db);
  ensureUBuddySleepWakeSchema(db);
  ensureUBuddyAgentAllocationSchema(db);
  ensureUBuddyCoordinationContractV2(db);
  ensureBoundedDeliveryReviewSchema(db);
  ensureAgentSingleWindowSchema(db);
  ensureManagedProviderUsageSchema(db);
  ensureRecentWorkReportingSchema(db);
  ensureJanusDatabaseIdentity(db);
  ensureOrganizationMessageResearchSchema(db);
  ensureFollowerLocalServiceSchema(db);
  ensureFollowerCloudEvolutionSchema(db);
  ensureFollowerIntegrityHardeningSchema(db);
  migrateFollowerDefaultCloudEvolutionV1(db);
  migrateFollowerDefaultWorkSourcesV1(db);
  db.exec(`CREATE TABLE IF NOT EXISTS social_contact_remarks (
    owner_user_id TEXT NOT NULL,target_user_id TEXT NOT NULL,remark TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(owner_user_id,target_user_id),CHECK(owner_user_id<>target_user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_social_contact_remarks_target
    ON social_contact_remarks(target_user_id,updated_at)`);
  addColumn('contact_organization_members', 'display_name_override', "TEXT NOT NULL DEFAULT ''");
  addColumn('chat_group_members', 'display_name_override', "TEXT NOT NULL DEFAULT ''");
  addColumn('chat_group_members', 'remark', "TEXT NOT NULL DEFAULT ''");
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('chat_group_remarks_v1')").run();
  addColumn('collaboration_group_members', 'display_name_override', "TEXT NOT NULL DEFAULT ''");
  db.exec(`CREATE TABLE IF NOT EXISTS agent_delivery_receipts (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,source_session_id TEXT NOT NULL,target_session_id TEXT NOT NULL,
    target_agent_instance_id TEXT NOT NULL,request_message_id TEXT NOT NULL DEFAULT '',target_message_id TEXT NOT NULL DEFAULT '',
    source_notification_message_id TEXT NOT NULL DEFAULT '',work_id TEXT NOT NULL UNIQUE,
    delivery_status TEXT NOT NULL DEFAULT 'queued',read_status TEXT NOT NULL DEFAULT 'read',metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),delivered_at TEXT NOT NULL DEFAULT '',read_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_agent_delivery_receipts_unread
    ON agent_delivery_receipts(user_id,target_session_id,read_status,updated_at)`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_delivery_events (
    id TEXT PRIMARY KEY,work_id TEXT NOT NULL,sequence_no INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'progress',stage TEXT NOT NULL DEFAULT 'working',message TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(work_id,sequence_no)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_delivery_events_work_sequence
    ON agent_delivery_events(work_id,sequence_no)`);
  db.exec(`CREATE TABLE IF NOT EXISTS collaboration_group_workspaces (
    group_id TEXT PRIMARY KEY,workspace_epoch TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS collaboration_group_workspace_mirrors (
    group_id TEXT NOT NULL,user_id TEXT NOT NULL,workspace_root TEXT NOT NULL DEFAULT '',workspace_epoch TEXT NOT NULL DEFAULT '',
    last_synced_revision INTEGER NOT NULL DEFAULT 0,sync_status TEXT NOT NULL DEFAULT 'idle',last_error TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),PRIMARY KEY(group_id,user_id)
  );
  CREATE TABLE IF NOT EXISTS collaboration_group_workspace_file_state (
    group_id TEXT NOT NULL,user_id TEXT NOT NULL,relative_path TEXT NOT NULL,remote_file_id TEXT NOT NULL DEFAULT '',remote_revision INTEGER NOT NULL DEFAULT 0,
    remote_sha256 TEXT NOT NULL DEFAULT '',local_sha256 TEXT NOT NULL DEFAULT '',deleted INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),PRIMARY KEY(group_id,user_id,relative_path)
  );
  CREATE INDEX IF NOT EXISTS idx_collaboration_group_workspace_file_state_revision
    ON collaboration_group_workspace_file_state(group_id,user_id,remote_revision);
  INSERT OR IGNORE INTO collaboration_group_workspaces(group_id,workspace_epoch,revision,status,updated_at)
    SELECT id,'workspace_' || id,0,status,updated_at FROM collaboration_groups`);
  const groupWorkspaceFileStateColumns = new Set(db.prepare('PRAGMA table_info(collaboration_group_workspace_file_state)').all().map((row) => row.name));
  if (!groupWorkspaceFileStateColumns.has('remote_file_id')) db.exec("ALTER TABLE collaboration_group_workspace_file_state ADD COLUMN remote_file_id TEXT NOT NULL DEFAULT ''");
  db.exec(`CREATE TABLE IF NOT EXISTS cloud_sync_v6_outbox (
    id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,payload_hash TEXT NOT NULL,server_url TEXT NOT NULL,user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,cursor_to TEXT NOT NULL DEFAULT '',payload_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',
    response_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',
    completed_at TEXT NOT NULL DEFAULT '',UNIQUE(server_url,user_id,device_id,payload_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_cloud_sync_v6_outbox_due
    ON cloud_sync_v6_outbox(server_url,user_id,device_id,status,next_attempt_at,created_at)`);
  db.exec(`CREATE TABLE IF NOT EXISTS cloud_sync_v6_deferred_changes (
    remote_user_id TEXT NOT NULL,local_user_id TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,operation TEXT NOT NULL DEFAULT 'upsert',content_hash TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',reason_code TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',
    first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),last_attempt_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),resolved_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(remote_user_id,entity_type,entity_id,revision)
  );
  CREATE INDEX IF NOT EXISTS idx_cloud_sync_v6_deferred_due
    ON cloud_sync_v6_deferred_changes(remote_user_id,status,updated_at,entity_type,entity_id)`);
  db.exec(`CREATE TABLE IF NOT EXISTS evolution_evidence_legacy_backfills (
    owner_user_id TEXT NOT NULL,source_kind TEXT NOT NULL,upper_bound_at TEXT NOT NULL DEFAULT '',upper_bound_id TEXT NOT NULL DEFAULT '',
    cursor_at TEXT NOT NULL DEFAULT '',cursor_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(owner_user_id,source_kind),CHECK(status IN ('pending','running','completed')))`);
  const evidenceOutboxColumns = new Set(db.prepare('PRAGMA table_info(evolution_evidence_outbox)').all().map((row) => row.name));
  if (evidenceOutboxColumns.size && !evidenceOutboxColumns.has('lineage_key')) {
    db.exec("ALTER TABLE evolution_evidence_outbox ADD COLUMN lineage_key TEXT NOT NULL DEFAULT ''");
  }
  if (evidenceOutboxColumns.size && !evidenceOutboxColumns.has('next_attempt_at')) {
    db.exec("ALTER TABLE evolution_evidence_outbox ADD COLUMN next_attempt_at TEXT NOT NULL DEFAULT ''");
  }
  if (evidenceOutboxColumns.size && !evidenceOutboxColumns.has('defer_reason')) {
    db.exec("ALTER TABLE evolution_evidence_outbox ADD COLUMN defer_reason TEXT NOT NULL DEFAULT ''");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_evolution_evidence_outbox_lineage
    ON evolution_evidence_outbox(local_user_id,user_agent_instance_id,lineage_key,created_at,outbox_id);
  CREATE INDEX IF NOT EXISTS idx_evolution_evidence_outbox_account_due
    ON evolution_evidence_outbox(local_user_id,status,next_attempt_at,lease_expires_at,created_at);
  CREATE TABLE IF NOT EXISTS evolution_evidence_quarantine (
    id TEXT PRIMARY KEY,outbox_id TEXT NOT NULL DEFAULT '',local_user_id TEXT NOT NULL DEFAULT '',
    user_agent_instance_id TEXT NOT NULL DEFAULT '',source_kind TEXT NOT NULL DEFAULT '',source_id TEXT NOT NULL DEFAULT '',
    source_version_id TEXT NOT NULL DEFAULT '',reason_code TEXT NOT NULL,reason_text TEXT NOT NULL DEFAULT '',
    retryable INTEGER NOT NULL DEFAULT 0,resolution_status TEXT NOT NULL DEFAULT 'pending',resolution_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),resolved_at TEXT NOT NULL DEFAULT '',
    CHECK(resolution_status IN ('pending','released','rejected','resolved'))
  );
  CREATE INDEX IF NOT EXISTS idx_evolution_evidence_quarantine_subject
    ON evolution_evidence_quarantine(local_user_id,resolution_status,created_at,id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS chat_context_states (
    id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,session_id TEXT NOT NULL,context_space_id TEXT NOT NULL DEFAULT '',
    context_epoch INTEGER NOT NULL DEFAULT 1,reset_after_message_id TEXT NOT NULL DEFAULT '',
    reset_after_created_at TEXT NOT NULL DEFAULT '',last_execution_id TEXT NOT NULL DEFAULT '',
    last_input_tokens INTEGER NOT NULL DEFAULT 0,context_window_tokens INTEGER NOT NULL DEFAULT 0,
    provider_compaction_detected INTEGER NOT NULL DEFAULT 0,state_revision INTEGER NOT NULL DEFAULT 1,
    base_state_revision INTEGER NOT NULL DEFAULT 0,last_command_id TEXT NOT NULL DEFAULT '',
    source_device_id TEXT NOT NULL DEFAULT '',sync_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(owner_user_id,session_id,context_space_id),CHECK(context_epoch>=1),CHECK(state_revision>=1),
    CHECK(base_state_revision>=0),CHECK(sync_status IN ('pending','synced','conflict'))
  );
  CREATE INDEX IF NOT EXISTS idx_chat_context_states_sync
    ON chat_context_states(owner_user_id,sync_status,updated_at);`);

  addColumn('evolution_runs', 'source_kind', "TEXT NOT NULL DEFAULT 'runtime_real'");
  addColumn('evolution_runs', 'agent_family_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('evolution_runs', 'evolution_scope', "TEXT NOT NULL DEFAULT 'legacy'");
  addColumn('evolution_runs', 'user_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('evolution_runs', 'user_agent_instance_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('evolution_runs', 'cohort_key', "TEXT NOT NULL DEFAULT ''");
  addColumn('evolution_runs', 'algorithm_version', "TEXT NOT NULL DEFAULT 'legacy_v1'");
  addColumn('evolution_runs', 'evidence_cursor_from', "TEXT NOT NULL DEFAULT ''");
  addColumn('evolution_runs', 'evidence_cursor_to', "TEXT NOT NULL DEFAULT ''");
  addColumn('evolution_runs', 'consent_snapshot_json', "TEXT NOT NULL DEFAULT '{}'");
  addColumn('evolution_archives', 'source_kind', "TEXT NOT NULL DEFAULT 'runtime_real'");
  addColumn('evolution_archives', 'agent_family_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('evolution_archives', 'evolution_scope', "TEXT NOT NULL DEFAULT 'legacy'");
  addColumn('evolution_archives', 'user_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('evolution_archives', 'user_agent_instance_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('hr_reviews', 'source_kind', "TEXT NOT NULL DEFAULT 'runtime_real'");
  addColumn('agent_governance_events', 'source_kind', "TEXT NOT NULL DEFAULT 'runtime_real'");
  addColumn('agent_performance_reviews', 'source_kind', "TEXT NOT NULL DEFAULT 'runtime_real'");
  addColumn('cloud_auth_state', 'last_social_message_cursor', "TEXT NOT NULL DEFAULT ''");
  addColumn('cloud_auth_state', 'last_social_message_cursors_json', "TEXT NOT NULL DEFAULT '{}'");
  addColumn('cloud_auth_state', 'last_delegation_cursor', "TEXT NOT NULL DEFAULT ''");
  addColumn('friendships', 'user_a_remark', "TEXT NOT NULL DEFAULT ''");
  addColumn('friendships', 'user_b_remark', "TEXT NOT NULL DEFAULT ''");
  addColumn('cloud_sync_state', 'evolution_grant', "TEXT NOT NULL DEFAULT ''");
  addColumn('cloud_sync_state', 'device_grant', "TEXT NOT NULL DEFAULT ''");
  addColumn('cloud_sync_state', 'sync_schema_version', 'INTEGER NOT NULL DEFAULT 5');
  addColumn('cloud_sync_state', 'sync_capabilities_json', "TEXT NOT NULL DEFAULT '{}'");
  addColumn('cloud_sync_state', 'last_v6_cursor', "TEXT NOT NULL DEFAULT ''");
  addColumn('evolution_apply_journal', 'skill_before_snapshot_path', "TEXT NOT NULL DEFAULT ''");
  addColumn('evolution_apply_journal', 'memory_before_snapshot_path', "TEXT NOT NULL DEFAULT ''");
  const typedMemoryColumns = new Set(db.prepare("PRAGMA table_info(typed_memories)").all().map((row) => row.name));
  if (typedMemoryColumns.has('content_embedding_json')) {
    db.exec('ALTER TABLE typed_memories DROP COLUMN content_embedding_json');
  }

  const sessionColumns = new Set(db.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name));
  if (!sessionColumns.has('user_id')) {
    db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local_admin'");
  }
  if (!sessionColumns.has('agent_instance_id')) {
    db.exec("ALTER TABLE sessions ADD COLUMN agent_instance_id TEXT NOT NULL DEFAULT ''");
  }
  if (!sessionColumns.has('pinned_at')) {
    db.exec("ALTER TABLE sessions ADD COLUMN pinned_at TEXT NOT NULL DEFAULT ''");
  }
  if (!sessionColumns.has('project_id')) {
    db.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT ''");
  }
  if (!sessionColumns.has('workspace_root')) {
    db.exec("ALTER TABLE sessions ADD COLUMN workspace_root TEXT NOT NULL DEFAULT ''");
  }
  if (!sessionColumns.has('goal_objective')) {
    db.exec("ALTER TABLE sessions ADD COLUMN goal_objective TEXT NOT NULL DEFAULT ''");
  }
  if (!sessionColumns.has('goal_status')) {
    db.exec("ALTER TABLE sessions ADD COLUMN goal_status TEXT NOT NULL DEFAULT ''");
  }
  if (!sessionColumns.has('goal_tokens_used')) {
    db.exec('ALTER TABLE sessions ADD COLUMN goal_tokens_used INTEGER NOT NULL DEFAULT 0');
  }
  if (!sessionColumns.has('goal_token_budget')) {
    db.exec('ALTER TABLE sessions ADD COLUMN goal_token_budget INTEGER NOT NULL DEFAULT 0');
  }
  if (!sessionColumns.has('goal_time_used_seconds')) {
    db.exec('ALTER TABLE sessions ADD COLUMN goal_time_used_seconds INTEGER NOT NULL DEFAULT 0');
  }
  if (!sessionColumns.has('interaction_mode')) {
    db.exec("ALTER TABLE sessions ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT ''");
  }
  if (!sessionColumns.has('memory_use_enabled')) {
    db.exec('ALTER TABLE sessions ADD COLUMN memory_use_enabled INTEGER NOT NULL DEFAULT 1');
  }
  if (!sessionColumns.has('memory_generate_enabled')) {
    db.exec('ALTER TABLE sessions ADD COLUMN memory_generate_enabled INTEGER NOT NULL DEFAULT 0');
  }
  if (!sessionColumns.has('conversation_role')) db.exec("ALTER TABLE sessions ADD COLUMN conversation_role TEXT NOT NULL DEFAULT 'standard'");
  if (!sessionColumns.has('write_state')) db.exec("ALTER TABLE sessions ADD COLUMN write_state TEXT NOT NULL DEFAULT 'writable'");
  if (!sessionColumns.has('superseded_by_session_id')) db.exec("ALTER TABLE sessions ADD COLUMN superseded_by_session_id TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_status_pinned_updated ON sessions(status, pinned_at, updated_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project_status_updated ON sessions(project_id, status, updated_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_user_status_updated ON projects(user_id, status, updated_at)');

  addColumn('messages', 'agent_instance_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('messages', 'context_space_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('model_executions', 'agent_instance_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('model_executions', 'agent_version_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('model_executions', 'personal_skill_version_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('model_executions', 'memory_manifest_hash', "TEXT NOT NULL DEFAULT ''");
  addColumn('task_runs', 'owner_user_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('task_runs', 'lead_agent_instance_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('task_security_contexts', 'cloud_sync_recovery_allowed', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('task_nodes', 'agent_instance_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_entries', 'user_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_entries', 'agent_instance_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_entries', 'memory_document_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('typed_memories', 'user_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('typed_memories', 'agent_instance_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('typed_memories', 'memory_document_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('typed_memories', 'task_run_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('typed_memories', 'relationship_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('agent_performance_reviews', 'user_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('agent_performance_reviews', 'agent_family_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('agent_performance_reviews', 'user_agent_instance_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('skill_versions', 'user_agent_instance_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('cloud_sync_state', 'last_identity_cursor', "TEXT NOT NULL DEFAULT ''");
  addColumn('cloud_sync_state', 'last_personal_evolution_cursor', "TEXT NOT NULL DEFAULT ''");
  addColumn('auth_users', 'remote_bound_at', "TEXT NOT NULL DEFAULT ''");
  addColumn('social_messages', 'conversation_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('user_agent_skill_versions', 'compiler_version', "TEXT NOT NULL DEFAULT 'overlay_concat_v1'");
  addColumn('user_agent_skill_versions', 'authority', "TEXT NOT NULL DEFAULT 'legacy_local'");
  addColumn('user_agent_skill_versions', 'activated_at', "TEXT NOT NULL DEFAULT ''");
  addColumn('user_agent_skill_versions', 'archived_at', "TEXT NOT NULL DEFAULT ''");
  addColumn('user_agent_skill_versions', 'updated_at', "TEXT NOT NULL DEFAULT ''");
  addColumn('user_agent_instances', 'personal_skill_auto_activate', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('agent_families', 'instance_kind', "TEXT NOT NULL DEFAULT 'unavailable'");
  addColumn('agent_families', 'recruitable', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('agent_families', 'default_for_new_user', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('agent_families', 'quota_cost', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('agent_families', 'classification_version', "TEXT NOT NULL DEFAULT 'employee_recruitment_phase_a_v1'");
  addColumn('user_agent_instances', 'instance_kind', "TEXT NOT NULL DEFAULT 'employee'");
  addColumn('user_agent_instances', 'employment_state', "TEXT NOT NULL DEFAULT 'active'");
  addColumn('user_agent_instances', 'quota_exempt', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('user_agent_instances', 'recruited_at', "TEXT NOT NULL DEFAULT ''");
  addColumn('user_agent_instances', 'deactivated_at', "TEXT NOT NULL DEFAULT ''");
  addColumn('user_agent_instances', 'last_state_changed_at', "TEXT NOT NULL DEFAULT ''");
  addColumn('user_agent_instances', 'state_revision', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('user_agent_instances', 'recruitment_source', "TEXT NOT NULL DEFAULT 'legacy'");
  addColumn('user_agent_instances', 'policy_version', "TEXT NOT NULL DEFAULT 'employee_recruitment_phase_a_v1'");
  addColumn('user_agent_instances', 'pending_target_state', "TEXT NOT NULL DEFAULT ''");
  addColumn('user_agent_instances', 'authority_state', "TEXT NOT NULL DEFAULT 'local_confirmed'");
  addColumn('user_agent_instances', 'last_employee_command_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('personal_evolution_proposals', 'candidate_personal_skill_version_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_document_versions', 'origin_document_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_document_versions', 'origin_version_no', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('memory_documents', 'source_conversation_cursor', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_documents', 'encryption_key_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_documents', 'consent_scope_json', "TEXT NOT NULL DEFAULT '{}'");
  addColumn('memory_documents', 'work_scope_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_documents', 'agent_family_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_documents', 'cloud_key', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_documents', 'delegation_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_documents', 'group_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_documents', 'relationship_user_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_document_versions', 'base_version_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_document_versions', 'parent_version_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_document_versions', 'branch_id', "TEXT NOT NULL DEFAULT 'main'");
  addColumn('memory_document_versions', 'conflict_state', "TEXT NOT NULL DEFAULT 'none'");
  addColumn('memory_document_versions', 'visibility', "TEXT NOT NULL DEFAULT 'agent_private'");
  addColumn('memory_document_versions', 'published_at', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_document_versions', 'published_by_agent_instance_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_document_versions', 'source_cursor', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_document_versions', 'encryption_algorithm', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_document_versions', 'encryption_key_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_document_versions', 'encryption_key_version', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('memory_document_versions', 'content_ciphertext', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_document_versions', 'content_nonce', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_document_versions', 'content_tag', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_document_versions', 'content_aad', "TEXT NOT NULL DEFAULT ''");

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  migrateEmployeeInstancesToMultiInstance(db);
  migrateLegacyGeneralAgentFamilies(db);
  migrateEmployeeInstanceProfileUniqueness(db);
  migrateAgentFamilyDisplayNamesV1(db);
  migrateAgentFamilyNameAlignmentV2(db);
  migrateAgentInstanceSequenceCompactionV3(db);
  migrateLegacyGeneralAgentCatalogRepairV2(db);
  migrateOrganizationMemberFriendships(db);
  migrateContactOrganizationGovernance(db);
  migrateAccountWorkspaces(db);
  migrateAccountWorkspaceMembershipDomain(db);
  migrateAccountWorkspaceContextIsolation(db);
  migrateAccountPrincipalIsolationV1(db);
  db.exec(`CREATE TABLE IF NOT EXISTS memory_document_aliases (
    alias_document_id TEXT PRIMARY KEY,
    canonical_document_id TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS user_agent_recruitment_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_agent_instance_id TEXT NOT NULL DEFAULT '',
    agent_family_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    previous_state TEXT NOT NULL DEFAULT '',
    next_state TEXT NOT NULL DEFAULT '',
    quota_before INTEGER NOT NULL DEFAULT 0,
    quota_after INTEGER NOT NULL DEFAULT 0,
    command_id TEXT NOT NULL,
    source_device_id TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(user_id, command_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_agent_instances_roster
    ON user_agent_instances(user_id, instance_kind, employment_state, quota_exempt, updated_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_agent_recruitment_events_user
    ON user_agent_recruitment_events(user_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_agent_recruitment_events_instance
    ON user_agent_recruitment_events(user_agent_instance_id, created_at)`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_work_queue (
    sequence_no INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    agent_instance_id TEXT NOT NULL,
    work_kind TEXT NOT NULL,
    work_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    payload_json TEXT NOT NULL DEFAULT '{}',
    error_text TEXT NOT NULL DEFAULT '',
    enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    started_at TEXT NOT NULL DEFAULT '',
    completed_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(work_kind, work_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_work_queue_instance_status
    ON agent_work_queue(agent_instance_id, status, sequence_no)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_work_queue_one_running
    ON agent_work_queue(agent_instance_id) WHERE status = 'running'`);
  db.exec(`CREATE TABLE IF NOT EXISTS employee_command_outbox (
    command_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    remote_user_id TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    agent_family_id TEXT NOT NULL DEFAULT '',
    local_agent_instance_id TEXT NOT NULL DEFAULT '',
    proposed_instance_id TEXT NOT NULL DEFAULT '',
    expected_state_revision INTEGER NOT NULL DEFAULT 0,
    previous_employment_state TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    completed_at TEXT NOT NULL DEFAULT ''
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_employee_command_outbox_status
    ON employee_command_outbox(status, created_at)`);
  db.exec(`CREATE TABLE IF NOT EXISTS task_security_contexts (
    task_run_id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL DEFAULT '',
    local_key_id TEXT NOT NULL,
    cloud_key_id TEXT NOT NULL,
    key_version INTEGER NOT NULL DEFAULT 1,
    cloud_evolution_allowed INTEGER NOT NULL DEFAULT 0,
    cloud_collaboration_allowed INTEGER NOT NULL DEFAULT 0,
    local_envelope_state TEXT NOT NULL DEFAULT 'reference_only',
    cloud_envelope_state TEXT NOT NULL DEFAULT 'disabled',
    local_wrap_algorithm TEXT NOT NULL DEFAULT '',
    local_wrapping_key_id TEXT NOT NULL DEFAULT '',
    local_wrapped_key TEXT NOT NULL DEFAULT '',
    local_wrap_nonce TEXT NOT NULL DEFAULT '',
    local_wrap_tag TEXT NOT NULL DEFAULT '',
    cloud_wrap_algorithm TEXT NOT NULL DEFAULT '',
    cloud_wrapping_key_id TEXT NOT NULL DEFAULT '',
    cloud_wrapped_key TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_security_owner
    ON task_security_contexts(owner_user_id, status, updated_at)`);
  addColumn('task_security_contexts', 'local_wrap_algorithm', "TEXT NOT NULL DEFAULT ''");
  addColumn('task_security_contexts', 'local_wrapping_key_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('task_security_contexts', 'local_wrapped_key', "TEXT NOT NULL DEFAULT ''");
  addColumn('task_security_contexts', 'local_wrap_nonce', "TEXT NOT NULL DEFAULT ''");
  addColumn('task_security_contexts', 'local_wrap_tag', "TEXT NOT NULL DEFAULT ''");
  addColumn('task_security_contexts', 'cloud_wrap_algorithm', "TEXT NOT NULL DEFAULT ''");
  addColumn('task_security_contexts', 'cloud_wrapping_key_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('task_security_contexts', 'cloud_wrapped_key', "TEXT NOT NULL DEFAULT ''");
  addColumn('task_security_contexts', 'cloud_collaboration_allowed', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS agent_identity_migration_quarantine (
    id TEXT PRIMARY KEY,
    source_table TEXT NOT NULL,
    source_id TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    agent_family_id TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(source_table, source_id, reason)
  )`);
  db.exec("UPDATE user_agent_skill_versions SET updated_at = created_at WHERE updated_at = ''");

  db.exec("UPDATE evolution_runs SET agent_family_id = agent_id WHERE agent_family_id = ''");
  db.exec("UPDATE evolution_archives SET agent_family_id = agent_id WHERE agent_family_id = ''");
  db.exec("UPDATE agent_performance_reviews SET agent_family_id = agent_id WHERE agent_family_id = ''");
  db.exec(`UPDATE agent_families SET
    instance_kind = CASE
      WHEN id = 'secretary_agent' THEN 'system'
      WHEN role IN ('hr', 'department_leader') THEN 'governance'
      WHEN id = 'general_agent' AND status NOT IN ('disabled', 'retired', 'archived') THEN 'employee'
      WHEN routable = 1 AND status NOT IN ('disabled', 'retired', 'archived') THEN 'employee'
      ELSE 'unavailable'
    END,
    recruitable = CASE
      WHEN id = 'general_agent' AND status NOT IN ('disabled', 'retired', 'archived') THEN 1
      WHEN routable = 1 AND role NOT IN ('hr', 'department_leader') AND id != 'secretary_agent'
        AND status NOT IN ('disabled', 'retired', 'archived') THEN 1
      ELSE 0
    END,
    default_for_new_user = CASE WHEN id = 'general_agent' AND status NOT IN ('disabled', 'retired', 'archived') THEN 1 ELSE 0 END,
    quota_cost = CASE
      WHEN (id = 'general_agent' OR routable = 1) AND role NOT IN ('hr', 'department_leader') AND id != 'secretary_agent'
        AND status NOT IN ('disabled', 'retired', 'archived') THEN 1
      ELSE 0
    END,
    classification_version = 'employee_recruitment_phase_a_v1'`);
  db.exec(`UPDATE user_agent_instances SET
    instance_kind = COALESCE((SELECT instance_kind FROM agent_families WHERE id = user_agent_instances.agent_family_id), 'unavailable'),
    employment_state = CASE WHEN status = 'inactive' THEN 'inactive' ELSE 'active' END,
    quota_exempt = CASE
      WHEN COALESCE((SELECT instance_kind FROM agent_families WHERE id = user_agent_instances.agent_family_id), 'unavailable') = 'employee' THEN 0
      ELSE 1
    END,
    recruited_at = CASE WHEN recruited_at = '' THEN created_at ELSE recruited_at END,
    last_state_changed_at = CASE WHEN last_state_changed_at = '' THEN updated_at ELSE last_state_changed_at END,
    recruitment_source = CASE WHEN recruitment_source IN ('', 'legacy') THEN 'migration' ELSE recruitment_source END,
    policy_version = 'employee_recruitment_phase_a_v1'`);
  db.exec(`UPDATE user_agent_instances SET
    authority_state=CASE WHEN recruitment_source='migration' THEN 'migration_grandfathered' ELSE authority_state END`);

  const authUserColumns = new Set(db.prepare("PRAGMA table_info(auth_users)").all().map((row) => row.name));
  const addAuthUserColumn = (name, sql) => {
    if (!authUserColumns.has(name)) db.exec(`ALTER TABLE auth_users ADD COLUMN ${name} ${sql}`);
  };
  const hadEmailVerified = authUserColumns.has('email_verified');
  addAuthUserColumn('username', "TEXT NOT NULL DEFAULT ''");
  addAuthUserColumn('phone', "TEXT NOT NULL DEFAULT ''");
  addAuthUserColumn('avatar_url', "TEXT NOT NULL DEFAULT ''");
  addAuthUserColumn('remote_id', "TEXT NOT NULL DEFAULT ''");
  addAuthUserColumn('auth_provider', "TEXT NOT NULL DEFAULT 'local_mock'");
  addAuthUserColumn('email_verified', "INTEGER NOT NULL DEFAULT 1");
  addAuthUserColumn('phone_verified', "INTEGER NOT NULL DEFAULT 0");
  addAuthUserColumn('role', "TEXT NOT NULL DEFAULT 'member'");
  addAuthUserColumn('password_hash', "TEXT NOT NULL DEFAULT ''");
  addAuthUserColumn('updated_at', "TEXT NOT NULL DEFAULT ''");
  if (!hadEmailVerified) db.exec("UPDATE auth_users SET email_verified = 1 WHERE email_verified IS NULL OR email_verified = 0");
  db.exec("UPDATE auth_users SET updated_at = created_at WHERE updated_at = ''");
  db.exec("CREATE INDEX IF NOT EXISTS idx_auth_users_role ON auth_users(role, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_auth_users_username ON auth_users(username)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_remote_id_unique ON auth_users(remote_id) WHERE remote_id <> ''");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_phone_unique ON auth_users(phone) WHERE phone <> ''");
  db.exec("UPDATE auth_users SET remote_id = '', remote_bound_at = '' WHERE auth_provider = 'local_mock' AND remote_id LIKE 'local:%'");

  db.exec('DROP TRIGGER IF EXISTS trg_evolution_runs_scope_insert');
  db.exec('DROP TRIGGER IF EXISTS trg_evolution_runs_scope_update');
  const evolutionScopeValidation = `
    SELECT CASE
      WHEN NEW.evolution_scope NOT IN ('legacy', 'personal', 'cluster')
        THEN RAISE(ABORT, 'invalid evolution scope')
      WHEN NEW.evolution_scope = 'personal'
        AND (NEW.user_id = '' OR NEW.user_agent_instance_id = '' OR NEW.agent_family_id = '' OR NEW.cohort_key != '')
        THEN RAISE(ABORT, 'invalid personal evolution identity')
      WHEN NEW.evolution_scope = 'personal'
        AND NOT EXISTS (SELECT 1 FROM user_agent_instances
          WHERE id = NEW.user_agent_instance_id AND user_id = NEW.user_id AND agent_family_id = NEW.agent_family_id)
        THEN RAISE(ABORT, 'personal evolution identity mismatch')
      WHEN NEW.evolution_scope = 'cluster'
        AND (NEW.agent_family_id = '' OR NEW.cohort_key = '' OR NEW.user_id != '' OR NEW.user_agent_instance_id != '')
        THEN RAISE(ABORT, 'invalid cluster evolution identity')
      WHEN NEW.evolution_scope = 'cluster'
        AND NOT EXISTS (SELECT 1 FROM agent_families WHERE id = NEW.agent_family_id)
        THEN RAISE(ABORT, 'cluster evolution family does not exist')
    END;`;
  db.exec(`CREATE TRIGGER trg_evolution_runs_scope_insert BEFORE INSERT ON evolution_runs BEGIN ${evolutionScopeValidation} END`);
  db.exec(`CREATE TRIGGER trg_evolution_runs_scope_update BEFORE UPDATE OF evolution_scope, user_id, user_agent_instance_id, agent_family_id, cohort_key ON evolution_runs BEGIN ${evolutionScopeValidation} END`);
  db.exec('DROP TRIGGER IF EXISTS trg_user_agent_instances_identity_insert');
  db.exec(`CREATE TRIGGER trg_user_agent_instances_identity_insert BEFORE INSERT ON user_agent_instances BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM auth_users WHERE id = NEW.user_id)
      THEN RAISE(ABORT, 'user Agent instance user does not exist') END;
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM agent_families WHERE id = NEW.agent_family_id)
      THEN RAISE(ABORT, 'user Agent instance family does not exist') END;
  END`);
  db.exec('DROP TRIGGER IF EXISTS trg_user_agent_instances_employment_insert');
  db.exec(`CREATE TRIGGER trg_user_agent_instances_employment_insert BEFORE INSERT ON user_agent_instances BEGIN
    SELECT CASE WHEN NEW.instance_kind NOT IN ('employee', 'system', 'governance', 'unavailable')
      THEN RAISE(ABORT, 'invalid Agent instance kind') END;
    SELECT CASE WHEN NEW.employment_state NOT IN ('active', 'inactive', 'pending_cloud_confirmation', 'conflict')
      THEN RAISE(ABORT, 'invalid Agent employment state') END;
    SELECT CASE WHEN NEW.quota_exempt NOT IN (0, 1)
      THEN RAISE(ABORT, 'invalid Agent quota exemption') END;
    SELECT CASE WHEN NEW.instance_kind = 'employee' AND NEW.employment_state = 'active' AND NEW.quota_exempt = 0
      AND NEW.authority_state NOT IN ('cloud_confirmed','migration_grandfathered')
      AND (SELECT COUNT(*) FROM user_agent_instances
        WHERE user_id = NEW.user_id AND instance_kind = 'employee' AND employment_state = 'active' AND quota_exempt = 0) >= 10
      THEN RAISE(ABORT, 'employee quota exceeded') END;
  END`);
  db.exec('DROP TRIGGER IF EXISTS trg_user_agent_instances_employment_update');
  db.exec(`CREATE TRIGGER trg_user_agent_instances_employment_update BEFORE UPDATE OF user_id, instance_kind, employment_state, quota_exempt ON user_agent_instances BEGIN
    SELECT CASE WHEN NEW.instance_kind NOT IN ('employee', 'system', 'governance', 'unavailable')
      THEN RAISE(ABORT, 'invalid Agent instance kind') END;
    SELECT CASE WHEN NEW.employment_state NOT IN ('active', 'inactive', 'pending_cloud_confirmation', 'conflict')
      THEN RAISE(ABORT, 'invalid Agent employment state') END;
    SELECT CASE WHEN NEW.quota_exempt NOT IN (0, 1)
      THEN RAISE(ABORT, 'invalid Agent quota exemption') END;
    SELECT CASE WHEN NEW.instance_kind = 'employee' AND NEW.employment_state = 'active' AND NEW.quota_exempt = 0
      AND NEW.authority_state NOT IN ('cloud_confirmed','migration_grandfathered')
      AND (OLD.user_id != NEW.user_id OR OLD.instance_kind != 'employee' OR OLD.employment_state != 'active' OR OLD.quota_exempt != 0)
      AND (SELECT COUNT(*) FROM user_agent_instances
        WHERE user_id = NEW.user_id AND id != NEW.id AND instance_kind = 'employee' AND employment_state = 'active' AND quota_exempt = 0) >= 10
      THEN RAISE(ABORT, 'employee quota exceeded') END;
  END`);
  db.exec('DROP TRIGGER IF EXISTS trg_agent_versions_immutable_update');
  db.exec(`CREATE TRIGGER trg_agent_versions_immutable_update BEFORE UPDATE OF
    agent_family_id, version_label, agent_config_json, base_skill_content, base_skill_hash,
    memory_template_content, memory_template_hash, source_bundle_id, content_hash, created_at
    ON agent_versions BEGIN
      SELECT RAISE(ABORT, 'Agent versions are immutable');
    END`);
  db.exec('DROP TRIGGER IF EXISTS trg_user_agent_instances_identity_update');
  db.exec(`CREATE TRIGGER trg_user_agent_instances_identity_update BEFORE UPDATE OF user_id, agent_family_id ON user_agent_instances BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM auth_users WHERE id = NEW.user_id)
      THEN RAISE(ABORT, 'user Agent instance user does not exist') END;
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM agent_families WHERE id = NEW.agent_family_id)
      THEN RAISE(ABORT, 'user Agent instance family does not exist') END;
  END`);
  db.exec('DROP TRIGGER IF EXISTS trg_user_agent_skill_versions_identity_insert');
  db.exec(`CREATE TRIGGER trg_user_agent_skill_versions_identity_insert BEFORE INSERT ON user_agent_skill_versions BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM user_agent_instances WHERE id = NEW.user_agent_instance_id)
      THEN RAISE(ABORT, 'personal Skill Agent instance does not exist') END;
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM agent_versions WHERE id = NEW.base_agent_version_id)
      THEN RAISE(ABORT, 'personal Skill base Agent version does not exist') END;
  END`);
  db.exec('DROP TRIGGER IF EXISTS trg_user_agent_skill_versions_identity_update');
  db.exec(`CREATE TRIGGER trg_user_agent_skill_versions_identity_update BEFORE UPDATE OF user_agent_instance_id, base_agent_version_id ON user_agent_skill_versions BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM user_agent_instances WHERE id = NEW.user_agent_instance_id)
      THEN RAISE(ABORT, 'personal Skill Agent instance does not exist') END;
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM agent_versions WHERE id = NEW.base_agent_version_id)
      THEN RAISE(ABORT, 'personal Skill base Agent version does not exist') END;
  END`);
  db.exec('DROP TRIGGER IF EXISTS trg_memory_documents_identity_insert');
  db.exec(`CREATE TRIGGER trg_memory_documents_identity_insert BEFORE INSERT ON memory_documents BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM user_agent_instances WHERE id = NEW.user_agent_instance_id AND user_id = NEW.user_id)
      THEN RAISE(ABORT, 'Memory document Agent identity does not exist') END;
  END`);
  db.exec('DROP TRIGGER IF EXISTS trg_memory_documents_identity_update');
  db.exec(`CREATE TRIGGER trg_memory_documents_identity_update BEFORE UPDATE OF user_id, user_agent_instance_id ON memory_documents BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM user_agent_instances WHERE id = NEW.user_agent_instance_id AND user_id = NEW.user_id)
      THEN RAISE(ABORT, 'Memory document Agent identity does not exist') END;
  END`);
  db.exec('DROP TRIGGER IF EXISTS trg_memory_document_versions_identity_insert');
  db.exec(`CREATE TRIGGER trg_memory_document_versions_identity_insert BEFORE INSERT ON memory_document_versions BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM memory_documents WHERE id = NEW.memory_document_id)
      THEN RAISE(ABORT, 'Memory document version owner does not exist') END;
  END`);
  db.exec('DROP TRIGGER IF EXISTS trg_memory_document_versions_identity_update');
  db.exec(`CREATE TRIGGER trg_memory_document_versions_identity_update BEFORE UPDATE OF memory_document_id ON memory_document_versions BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM memory_documents WHERE id = NEW.memory_document_id)
      THEN RAISE(ABORT, 'Memory document version owner does not exist') END;
  END`);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('user_agent_identity_phase1_v2')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('personal_evolution_phase2_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('cloud_evolution_authority_phase3_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('stage8_cluster_market_v1')").run();
  const cloudEvolutionCompatApplied = db.prepare("SELECT id FROM schema_migrations WHERE id = 'cloud_evolution_authority_phase3_compat_v2'").get();
  if (!cloudEvolutionCompatApplied) {
    const repairedAt = new Date().toISOString();
    db.prepare(`UPDATE personal_evolution_proposals SET status = 'ready', expires_reason = '', expires_at = '', updated_at = ?
      WHERE status = 'expired' AND expires_reason = 'expired_migration'`).run(repairedAt);
    db.prepare(`UPDATE evolution_runs SET source_kind = 'runtime_real', updated_at = ?
      WHERE evolution_scope = 'personal' AND source_kind = 'legacy_read_only'`).run(repairedAt);
    db.prepare("DELETE FROM app_settings WHERE key = 'evolution:cloud_cutover_at'").run();
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('cloud_evolution_authority_phase3_compat_v2')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('employee_recruitment_phase_a_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('employee_execution_queue_phase_b_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('employee_cloud_authority_phase_c_v1')").run();
  const localDeactivationOutboxApplied = db.prepare("SELECT id FROM schema_migrations WHERE id = 'employee_local_deactivation_outbox_v1'").get();
  if (!localDeactivationOutboxApplied) {
    db.prepare(`UPDATE user_agent_instances
      SET status='inactive',employment_state='inactive',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE instance_kind='employee' AND employment_state='pending_cloud_confirmation'
        AND pending_target_state='inactive' AND authority_state='pending'`).run();
    db.prepare("INSERT INTO schema_migrations (id) VALUES ('employee_local_deactivation_outbox_v1')").run();
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('multi_memory_task_security_phase_d_v1')").run();
  db.exec(`CREATE TABLE IF NOT EXISTS work_scopes (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    parent_work_scope_id TEXT NOT NULL DEFAULT '',
    revision_id TEXT NOT NULL DEFAULT '',
    owner_user_id TEXT NOT NULL DEFAULT '',
    federation_type TEXT NOT NULL DEFAULT '',
    federation_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(scope_type, source_id)
  )`);
  addColumn('work_scopes', 'federation_type', "TEXT NOT NULL DEFAULT ''");
  addColumn('work_scopes', 'federation_id', "TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_scopes_owner_status ON work_scopes(owner_user_id, status, updated_at)');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_work_scopes_federation
    ON work_scopes(federation_type, federation_id)
    WHERE federation_type != '' AND federation_id != ''`);
  db.exec(`CREATE TABLE IF NOT EXISTS work_participants (
    id TEXT PRIMARY KEY,
    work_scope_id TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT '',
    agent_instance_id TEXT NOT NULL,
    agent_family_id TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'executor',
    collaboration_edges_json TEXT NOT NULL DEFAULT '[]',
    valid_from TEXT NOT NULL,
    valid_until TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(work_scope_id, agent_instance_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_participants_scope_status ON work_participants(work_scope_id, status, agent_instance_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS leadership_assignments (
    id TEXT PRIMARY KEY,
    work_scope_id TEXT NOT NULL,
    agent_instance_id TEXT NOT NULL,
    role TEXT NOT NULL,
    leadership_level_snapshot TEXT NOT NULL DEFAULT '',
    assignment_mode TEXT NOT NULL DEFAULT 'normal',
    limit_snapshot_json TEXT NOT NULL DEFAULT '{}',
    permission_snapshot_json TEXT NOT NULL DEFAULT '{}',
    appointed_by TEXT NOT NULL DEFAULT '',
    valid_from TEXT NOT NULL,
    valid_until TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  addColumn('leadership_assignments', 'assignment_mode', "TEXT NOT NULL DEFAULT 'normal'");
  addColumn('leadership_assignments', 'limit_snapshot_json', "TEXT NOT NULL DEFAULT '{}'");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_leadership_assignments_scope_agent
    ON leadership_assignments(work_scope_id, agent_instance_id, status, valid_from, valid_until)`);
  db.exec(`CREATE TABLE IF NOT EXISTS work_memory_access_audits (
    id TEXT PRIMARY KEY,
    requester_user_id TEXT NOT NULL DEFAULT '',
    requester_agent_instance_id TEXT NOT NULL DEFAULT '',
    target_user_id TEXT NOT NULL DEFAULT '',
    target_agent_instance_id TEXT NOT NULL DEFAULT '',
    work_scope_id TEXT NOT NULL DEFAULT '',
    memory_document_id TEXT NOT NULL DEFAULT '',
    memory_document_version_id TEXT NOT NULL DEFAULT '',
    requested_reason TEXT NOT NULL DEFAULT '',
    requester_role_snapshot TEXT NOT NULL DEFAULT '',
    leadership_assignment_snapshot_json TEXT NOT NULL DEFAULT '{}',
    result TEXT NOT NULL,
    result_code TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_work_memory_access_audits_scope_created
    ON work_memory_access_audits(work_scope_id, created_at)`);
  db.exec(`CREATE TABLE IF NOT EXISTS work_memory_publication_outbox (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT '',
    work_scope_id TEXT NOT NULL,
    memory_document_version_id TEXT NOT NULL,
    federation_type TEXT NOT NULL,
    federation_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    next_attempt_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    published_at TEXT NOT NULL DEFAULT '',
    UNIQUE(memory_document_version_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_work_memory_publication_outbox_due
    ON work_memory_publication_outbox(user_id, status, next_attempt_at, created_at)`);
  db.exec('DROP TRIGGER IF EXISTS trg_work_memory_publication_outbox_policy_insert');
  db.exec('DROP TRIGGER IF EXISTS trg_work_memory_publication_outbox_policy_update');
  const workMemoryPublicationOutboxPolicy = `
    SELECT CASE WHEN NEW.status NOT IN ('pending','sending','published','failed')
      THEN RAISE(ABORT, 'invalid work Memory publication status') END;
    SELECT CASE WHEN NEW.federation_type NOT IN ('delegation','collaboration_group') OR NEW.federation_id=''
      THEN RAISE(ABORT, 'invalid work Memory publication federation') END;
    SELECT CASE WHEN NEW.attempt_count < 0
      THEN RAISE(ABORT, 'invalid work Memory publication attempt count') END;
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM work_scopes ws
      WHERE ws.id=NEW.work_scope_id AND ws.federation_type=NEW.federation_type AND ws.federation_id=NEW.federation_id)
      THEN RAISE(ABORT, 'work Memory publication scope mismatch') END;
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM memory_document_versions mdv
      JOIN memory_documents md ON md.id=mdv.memory_document_id
      WHERE mdv.id=NEW.memory_document_version_id AND md.work_scope_id=NEW.work_scope_id
        AND md.user_id=NEW.user_id)
      THEN RAISE(ABORT, 'work Memory publication version mismatch') END;
    SELECT CASE WHEN NEW.status='published' AND NEW.published_at=''
      THEN RAISE(ABORT, 'published work Memory publication requires timestamp') END;
    SELECT CASE WHEN NEW.status!='published' AND NEW.published_at!=''
      THEN RAISE(ABORT, 'unfinished work Memory publication cannot have published timestamp') END;`;
  db.exec(`CREATE TRIGGER trg_work_memory_publication_outbox_policy_insert BEFORE INSERT ON work_memory_publication_outbox BEGIN ${workMemoryPublicationOutboxPolicy} END`);
  db.exec(`CREATE TRIGGER trg_work_memory_publication_outbox_policy_update BEFORE UPDATE OF user_id,work_scope_id,memory_document_version_id,federation_type,federation_id,status,attempt_count,published_at ON work_memory_publication_outbox BEGIN ${workMemoryPublicationOutboxPolicy} END`);
  db.exec("UPDATE memory_documents SET work_scope_id = 'task:' || task_run_id WHERE scope = 'task' AND task_run_id != '' AND work_scope_id = ''");
  db.exec("UPDATE memory_documents SET visibility = 'agent_private' WHERE visibility = 'private'");
  db.exec("UPDATE memory_document_versions SET visibility = 'agent_private' WHERE visibility = '' OR visibility = 'private'");
  db.exec('DROP TRIGGER IF EXISTS trg_work_scopes_policy_insert');
  db.exec('DROP TRIGGER IF EXISTS trg_work_scopes_policy_update');
  const workScopePolicy = `
    SELECT CASE WHEN NEW.scope_type NOT IN ('task_run','delegation','collaboration_group')
      THEN RAISE(ABORT, 'invalid work scope type') END;
    SELECT CASE WHEN NEW.federation_type NOT IN ('','delegation','collaboration_group')
      THEN RAISE(ABORT, 'invalid work federation type') END;
    SELECT CASE WHEN (NEW.federation_type='' AND NEW.federation_id!='') OR (NEW.federation_type!='' AND NEW.federation_id='')
      THEN RAISE(ABORT, 'incomplete work federation key') END;
    SELECT CASE WHEN NEW.status NOT IN ('active','closed','archived')
      THEN RAISE(ABORT, 'invalid work scope status') END;`;
  db.exec(`CREATE TRIGGER trg_work_scopes_policy_insert BEFORE INSERT ON work_scopes BEGIN ${workScopePolicy} END`);
  db.exec(`CREATE TRIGGER trg_work_scopes_policy_update BEFORE UPDATE OF scope_type,status ON work_scopes BEGIN ${workScopePolicy} END`);
  db.exec('DROP TRIGGER IF EXISTS trg_work_participants_policy_insert');
  db.exec('DROP TRIGGER IF EXISTS trg_work_participants_policy_update');
  const workParticipantPolicy = `
    SELECT CASE WHEN NEW.role NOT IN ('executor','task_lead','team_lead','cross_team_lead','observer','auditor')
      THEN RAISE(ABORT, 'invalid work participant role') END;
    SELECT CASE WHEN NEW.status NOT IN ('active','removed')
      THEN RAISE(ABORT, 'invalid work participant status') END;
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM work_scopes WHERE id=NEW.work_scope_id)
      THEN RAISE(ABORT, 'work participant scope does not exist') END;
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM user_agent_instances WHERE id=NEW.agent_instance_id AND user_id=NEW.user_id)
      THEN RAISE(ABORT, 'work participant Agent identity mismatch') END;`;
  db.exec(`CREATE TRIGGER trg_work_participants_policy_insert BEFORE INSERT ON work_participants BEGIN ${workParticipantPolicy} END`);
  db.exec(`CREATE TRIGGER trg_work_participants_policy_update BEFORE UPDATE OF work_scope_id,user_id,agent_instance_id,role,status ON work_participants BEGIN ${workParticipantPolicy} END`);
  db.exec('DROP TRIGGER IF EXISTS trg_leadership_assignments_policy_insert');
  db.exec('DROP TRIGGER IF EXISTS trg_leadership_assignments_policy_update');
  const leadershipAssignmentPolicy = `
    SELECT CASE WHEN NEW.role NOT IN ('task_lead','team_lead','cross_team_lead')
      THEN RAISE(ABORT, 'invalid leadership assignment role') END;
    SELECT CASE WHEN NEW.status NOT IN ('active','draining','revoked')
      THEN RAISE(ABORT, 'invalid leadership assignment status') END;
    SELECT CASE WHEN NEW.assignment_mode NOT IN ('normal','trial')
      THEN RAISE(ABORT, 'invalid leadership assignment mode') END;
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM work_participants
      WHERE work_scope_id=NEW.work_scope_id AND agent_instance_id=NEW.agent_instance_id)
      THEN RAISE(ABORT, 'leadership assignment requires work participant') END;`;
  db.exec(`CREATE TRIGGER trg_leadership_assignments_policy_insert BEFORE INSERT ON leadership_assignments BEGIN ${leadershipAssignmentPolicy} END`);
  db.exec(`CREATE TRIGGER trg_leadership_assignments_policy_update BEFORE UPDATE OF work_scope_id,agent_instance_id,role,status,assignment_mode ON leadership_assignments BEGIN ${leadershipAssignmentPolicy} END`);
  db.exec('DROP TRIGGER IF EXISTS trg_memory_documents_work_visibility_insert');
  db.exec('DROP TRIGGER IF EXISTS trg_memory_documents_work_visibility_update');
  const memoryDocumentVisibilityPolicy = `
    SELECT CASE WHEN NEW.visibility NOT IN ('agent_private','work_collaborators','work_leadership','work_participants','work_summary','owner_private')
      THEN RAISE(ABORT, 'invalid Memory document visibility') END;
    SELECT CASE WHEN NEW.scope='task' AND NEW.task_run_id!='' AND NEW.work_scope_id!='task:' || NEW.task_run_id
      THEN RAISE(ABORT, 'task Memory work scope mismatch') END;`;
  db.exec(`CREATE TRIGGER trg_memory_documents_work_visibility_insert BEFORE INSERT ON memory_documents BEGIN ${memoryDocumentVisibilityPolicy} END`);
  db.exec(`CREATE TRIGGER trg_memory_documents_work_visibility_update BEFORE UPDATE OF scope,task_run_id,work_scope_id,visibility ON memory_documents BEGIN ${memoryDocumentVisibilityPolicy} END`);
  db.exec('DROP TRIGGER IF EXISTS trg_memory_versions_work_visibility_insert');
  db.exec('DROP TRIGGER IF EXISTS trg_memory_versions_work_visibility_update');
  const memoryVersionVisibilityPolicy = `
    SELECT CASE WHEN NEW.visibility NOT IN ('agent_private','work_collaborators','work_leadership','work_participants','work_summary','owner_private')
      THEN RAISE(ABORT, 'invalid Memory version visibility') END;
    SELECT CASE WHEN NEW.visibility IN ('work_collaborators','work_leadership','work_participants','work_summary')
      AND (NEW.published_at='' OR NEW.published_by_agent_instance_id='')
      THEN RAISE(ABORT, 'work Memory version requires publication metadata') END;
    SELECT CASE WHEN NEW.published_by_agent_instance_id!='' AND NOT EXISTS (
      SELECT 1 FROM memory_documents WHERE id=NEW.memory_document_id
        AND user_agent_instance_id=NEW.published_by_agent_instance_id)
      THEN RAISE(ABORT, 'Memory publisher must own document') END;`;
  db.exec(`CREATE TRIGGER trg_memory_versions_work_visibility_insert BEFORE INSERT ON memory_document_versions BEGIN ${memoryVersionVisibilityPolicy} END`);
  db.exec(`CREATE TRIGGER trg_memory_versions_work_visibility_update BEFORE UPDATE OF memory_document_id,visibility,published_at,published_by_agent_instance_id ON memory_document_versions BEGIN ${memoryVersionVisibilityPolicy} END`);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('work_memory_access_phase_e_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('task_memory_encryption_phase_f_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('work_memory_federation_phase_g_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('work_memory_operations_phase_h_v1')").run();

  const taskNodeColumns = new Set(db.prepare("PRAGMA table_info(task_nodes)").all().map((row) => row.name));
  const addTaskNodeColumn = (name, sql) => {
    if (!taskNodeColumns.has(name)) db.exec(`ALTER TABLE task_nodes ADD COLUMN ${name} ${sql}`);
  };
  addTaskNodeColumn('estimated_minutes', "INTEGER NOT NULL DEFAULT 0");
  addTaskNodeColumn('wait_reason', "TEXT NOT NULL DEFAULT ''");
  addTaskNodeColumn('timeout_policy', "TEXT NOT NULL DEFAULT ''");
  addTaskNodeColumn('attempt_count', 'INTEGER NOT NULL DEFAULT 0');
  addTaskNodeColumn('max_attempts', 'INTEGER NOT NULL DEFAULT 3');
  addTaskNodeColumn('next_retry_at', "TEXT NOT NULL DEFAULT ''");
  addTaskNodeColumn('last_error_code', "TEXT NOT NULL DEFAULT ''");
  addTaskNodeColumn('retry_strategy', "TEXT NOT NULL DEFAULT 'automatic'");
  addTaskNodeColumn('recovery_actions_json', "TEXT NOT NULL DEFAULT '[]'");
  addTaskNodeColumn('result_summary', "TEXT NOT NULL DEFAULT ''");
  addTaskNodeColumn('evidence_json', "TEXT NOT NULL DEFAULT '[]'");

  const taskEventColumns = new Set(db.prepare('PRAGMA table_info(task_events)').all().map((row) => row.name));
  if (!taskEventColumns.has('privacy_level')) db.exec("ALTER TABLE task_events ADD COLUMN privacy_level TEXT NOT NULL DEFAULT 'owner_private'");
  if (!taskEventColumns.has('updated_at')) {
    db.exec("ALTER TABLE task_events ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE task_events SET updated_at=created_at WHERE updated_at=''");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_events_updated ON task_events(updated_at,id)');

  const performanceReviewColumns = new Set(db.prepare("PRAGMA table_info(agent_performance_reviews)").all().map((row) => row.name));
  const addPerformanceReviewColumn = (name, sql) => {
    if (!performanceReviewColumns.has(name)) db.exec(`ALTER TABLE agent_performance_reviews ADD COLUMN ${name} ${sql}`);
  };
  addPerformanceReviewColumn('score', 'REAL NOT NULL DEFAULT 0.0');
  addPerformanceReviewColumn('scenario_metrics_json', "TEXT NOT NULL DEFAULT '{}'");
  addPerformanceReviewColumn('skill_version_id', "TEXT NOT NULL DEFAULT ''");
  addPerformanceReviewColumn('skill_hash', "TEXT NOT NULL DEFAULT ''");

  let specialistColumns = new Set(db.prepare("PRAGMA table_info(specialist_experiments)").all().map((row) => row.name));
  if (specialistColumns.has('canary_task_run_id') && !specialistColumns.has('candidate_task_run_id')) {
    db.exec('ALTER TABLE specialist_experiments RENAME COLUMN canary_task_run_id TO candidate_task_run_id');
    specialistColumns = new Set(db.prepare("PRAGMA table_info(specialist_experiments)").all().map((row) => row.name));
  }
  const addSpecialistColumn = (name, sql) => {
    if (!specialistColumns.has(name)) db.exec(`ALTER TABLE specialist_experiments ADD COLUMN ${name} ${sql}`);
  };
  addSpecialistColumn('baseline_agent_id', "TEXT NOT NULL DEFAULT ''");
  addSpecialistColumn('started_by_review_id', "TEXT NOT NULL DEFAULT ''");
  addSpecialistColumn('state', "TEXT NOT NULL DEFAULT 'assessment_pending'");
  addSpecialistColumn('metrics_json', "TEXT NOT NULL DEFAULT '{}'");
  addSpecialistColumn('decision_notes', "TEXT NOT NULL DEFAULT ''");
  addSpecialistColumn('candidate_task_run_id', "TEXT NOT NULL DEFAULT ''");
  db.exec("UPDATE specialist_experiments SET state = 'assessment_pending' WHERE state IN ('canary', 'candidate')");
  db.exec("UPDATE specialist_experiments SET status = 'assessment_pending' WHERE status IN ('canary', 'candidate')");

  const cloudStateColumns = new Set(db.prepare("PRAGMA table_info(cloud_sync_state)").all().map((row) => row.name));
  const addCloudStateColumn = (name, sql) => {
    if (!cloudStateColumns.has(name)) db.exec(`ALTER TABLE cloud_sync_state ADD COLUMN ${name} ${sql}`);
  };
  addCloudStateColumn('server_url', "TEXT NOT NULL DEFAULT ''");
  addCloudStateColumn('token', "TEXT NOT NULL DEFAULT ''");
  addCloudStateColumn('auto_sync', 'INTEGER NOT NULL DEFAULT 1');
  addCloudStateColumn('evolution_enabled', 'INTEGER NOT NULL DEFAULT 1');
  addCloudStateColumn('evolution_policy_version', "TEXT NOT NULL DEFAULT 'evolution_default_on_account_pause_v1'");
  addCloudStateColumn('evolution_state_revision', 'INTEGER NOT NULL DEFAULT 1');
  addCloudStateColumn('evolution_last_command_id', "TEXT NOT NULL DEFAULT ''");
  addCloudStateColumn('evolution_last_checked_at', "TEXT NOT NULL DEFAULT ''");
  addCloudStateColumn('evolution_last_check_error', "TEXT NOT NULL DEFAULT ''");
  addCloudStateColumn('last_sync_cursor', "TEXT NOT NULL DEFAULT ''");
  addCloudStateColumn('last_success_at', "TEXT NOT NULL DEFAULT ''");
  addCloudStateColumn('last_error', "TEXT NOT NULL DEFAULT ''");

  const cloudBatchColumns = new Set(db.prepare("PRAGMA table_info(cloud_sync_batches)").all().map((row) => row.name));
  const addCloudBatchColumn = (name, sql) => {
    if (!cloudBatchColumns.has(name)) db.exec(`ALTER TABLE cloud_sync_batches ADD COLUMN ${name} ${sql}`);
  };
  addCloudBatchColumn('reason', "TEXT NOT NULL DEFAULT ''");
  addCloudBatchColumn('item_count', 'INTEGER NOT NULL DEFAULT 0');
  addCloudBatchColumn('file_count', 'INTEGER NOT NULL DEFAULT 0');

  const socialMessageColumns = new Set(db.prepare("PRAGMA table_info(social_messages)").all().map((row) => row.name));
  const addSocialMessageColumn = (name, sql) => {
    if (!socialMessageColumns.has(name)) db.exec(`ALTER TABLE social_messages ADD COLUMN ${name} ${sql}`);
  };
  addSocialMessageColumn('recipient_agent_id', "TEXT NOT NULL DEFAULT ''");
  addSocialMessageColumn('delivery_status', "TEXT NOT NULL DEFAULT 'local'");
  addSocialMessageColumn('remote_id', "TEXT NOT NULL DEFAULT ''");
  addSocialMessageColumn('updated_at', "TEXT NOT NULL DEFAULT ''");
  db.exec("UPDATE social_messages SET updated_at = created_at WHERE updated_at = ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_social_messages_remote ON social_messages(remote_id)');
  const delegationColumns = new Set(db.prepare("PRAGMA table_info(agent_delegations)").all().map((row) => row.name));
  if (!delegationColumns.has('group_id')) db.exec("ALTER TABLE agent_delegations ADD COLUMN group_id TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_delegations_group ON agent_delegations(group_id, updated_at)');
  const collaborationMessageColumns = new Set(db.prepare('PRAGMA table_info(collaboration_group_messages)').all().map((row) => row.name));
  if (!collaborationMessageColumns.has('source_event_id')) db.exec("ALTER TABLE collaboration_group_messages ADD COLUMN source_event_id TEXT NOT NULL DEFAULT ''");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_messages_source_event
    ON collaboration_group_messages(group_id, source_event_id) WHERE source_event_id <> ''`);
  db.exec(`CREATE TABLE IF NOT EXISTS task_node_result_versions (
    id TEXT PRIMARY KEY,task_run_id TEXT NOT NULL,task_node_id TEXT NOT NULL,graph_revision_id TEXT NOT NULL DEFAULT '',
    version_no INTEGER NOT NULL DEFAULT 1,result_text TEXT NOT NULL DEFAULT '',result_summary TEXT NOT NULL DEFAULT '',
    evidence_json TEXT NOT NULL DEFAULT '[]',decision TEXT NOT NULL DEFAULT 'pending'
      CHECK(decision IN ('pending','adopted','superseded','rejected')),
    decision_reason TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    decided_at TEXT,UNIQUE(task_node_id,version_no)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_node_result_versions_run
    ON task_node_result_versions(task_run_id,graph_revision_id,created_at)`);
  const workspaceMessageColumns = new Set(db.prepare('PRAGMA table_info(agent_delegation_workspace_messages)').all().map((row) => row.name));
  if (!workspaceMessageColumns.has('source_event_id')) db.exec("ALTER TABLE agent_delegation_workspace_messages ADD COLUMN source_event_id TEXT NOT NULL DEFAULT ''");
  if (!workspaceMessageColumns.has('source_group_message_id')) db.exec("ALTER TABLE agent_delegation_workspace_messages ADD COLUMN source_group_message_id TEXT NOT NULL DEFAULT ''");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_delegation_workspace_messages_source_event
    ON agent_delegation_workspace_messages(delegation_id, user_id, source_event_id) WHERE source_event_id <> ''`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_delegation_workspace_messages_source_group
    ON agent_delegation_workspace_messages(delegation_id, user_id, source_group_message_id) WHERE source_group_message_id <> ''`);
  db.exec(`UPDATE sessions
    SET department_id = 'agent_delegation', agent_id = CASE WHEN agent_id = '' THEN 'secretary_agent' ELSE agent_id END
    WHERE department_id = 'general'
      AND id IN (SELECT session_id FROM agent_delegations WHERE session_id != '')
      AND NOT EXISTS (SELECT 1 FROM conversations conversation
        WHERE conversation.id=COALESCE(NULLIF(sessions.conversation_id,''),sessions.id)
          AND conversation.conversation_kind='direct')`);
  db.exec(`INSERT OR IGNORE INTO agent_delegation_workspaces (delegation_id, user_id, session_id, metadata_json, updated_at)
    SELECT id, recipient_user_id, session_id, '{}', updated_at
    FROM agent_delegations
    WHERE session_id != ''`);
  const privateDelegationKeys = new Set([
    'preliminaryResult', 'intakeSummary', 'threadId', 'answerMessageId', 'sessionId', 'workspaceSessionId',
    'taskWorkspaceRoot', 'generatedTaskFiles', 'ownerConfirmationRequired', 'safePreparationOnly',
    'specializedExecutionError', 'recoveryExecutionError', 'deterministicRecovery',
    'workspaceUpdatedAt', 'workspaceExecutionError', 'workspaceExecutionFailedAt', 'workspaceRevisionRecovered',
    'ubuddyTeamCoordination', 'workspaceEpoch', 'workspaceRepairedAt', 'previousWorkspaceSessionId',
    'activeTaskRunId', 'attemptTaskRunIds', 'executionFailureDetail', 'syncState', 'syncError', 'pendingRemoteUpdate', 'pendingWorkspaceSync',
    'pendingSharedWorkspaceSync', 'sharedWorkspaceSyncError',
  ]);
  for (const delegation of db.prepare('SELECT id, recipient_user_id, metadata_json, updated_at FROM agent_delegations').all()) {
    let metadata = {};
    try { metadata = JSON.parse(String(delegation.metadata_json || '{}')); } catch { metadata = {}; }
    const privateMetadata = Object.fromEntries(Object.entries(metadata).filter(([key]) => privateDelegationKeys.has(key)));
    if (!Object.keys(privateMetadata).length) continue;
    const workspace = db.prepare('SELECT metadata_json FROM agent_delegation_workspaces WHERE delegation_id = ? AND user_id = ?').get(delegation.id, delegation.recipient_user_id);
    let existingPrivate = {};
    try { existingPrivate = JSON.parse(String(workspace?.metadata_json || '{}')); } catch { existingPrivate = {}; }
    const nextWorkspaceMetadata = { ...existingPrivate };
    const nextDelegationMetadata = { ...metadata };
    for (const [key, value] of Object.entries(privateMetadata)) {
      const workspaceHasKey = Object.hasOwn(existingPrivate, key);
      const workspaceMatches = workspaceHasKey && JSON.stringify(existingPrivate[key]) === JSON.stringify(value);
      if (!workspaceHasKey) nextWorkspaceMetadata[key] = value;
      if (!workspaceHasKey || workspaceMatches) delete nextDelegationMetadata[key];
    }
    db.prepare(`INSERT INTO agent_delegation_workspaces (delegation_id, user_id, metadata_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(delegation_id, user_id) DO UPDATE SET metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`)
      .run(delegation.id, delegation.recipient_user_id, JSON.stringify(nextWorkspaceMetadata), delegation.updated_at || new Date().toISOString());
    db.prepare('UPDATE agent_delegations SET metadata_json = ? WHERE id = ?')
      .run(JSON.stringify(nextDelegationMetadata), delegation.id);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS agent_context_spaces (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,user_agent_instance_id TEXT NOT NULL,context_kind TEXT NOT NULL,
    memory_document_id TEXT NOT NULL DEFAULT '',project_id TEXT NOT NULL DEFAULT '',task_run_id TEXT NOT NULL DEFAULT '',
    delegation_id TEXT NOT NULL DEFAULT '',group_id TEXT NOT NULL DEFAULT '',relationship_user_id TEXT NOT NULL DEFAULT '',
    legacy_session_id TEXT NOT NULL DEFAULT '',lifecycle_state TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(user_agent_instance_id,context_kind,memory_document_id,project_id,task_run_id,delegation_id,group_id,relationship_user_id,legacy_session_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_device_context_state (
    device_id TEXT NOT NULL,user_id TEXT NOT NULL,user_agent_instance_id TEXT NOT NULL,
    primary_session_id TEXT NOT NULL DEFAULT '',active_context_space_id TEXT NOT NULL DEFAULT '',
    active_memory_document_id TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(device_id,user_agent_instance_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_context_state (
    user_id TEXT NOT NULL,user_agent_instance_id TEXT NOT NULL,
    primary_session_id TEXT NOT NULL DEFAULT '',active_context_space_id TEXT NOT NULL DEFAULT '',
    active_memory_document_id TEXT NOT NULL DEFAULT '',state_revision INTEGER NOT NULL DEFAULT 1,
    base_state_revision INTEGER NOT NULL DEFAULT 0,last_command_id TEXT NOT NULL DEFAULT '',
    source_device_id TEXT NOT NULL DEFAULT '',sync_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(user_id,user_agent_instance_id),CHECK(state_revision>=1),CHECK(base_state_revision>=0),
    CHECK(sync_status IN ('pending','synced','conflict'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS memory_sync_mappings (
    device_id TEXT NOT NULL,private_key TEXT NOT NULL,cloud_key TEXT NOT NULL,owner_user_id TEXT NOT NULL,
    user_agent_instance_id TEXT NOT NULL,memory_document_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(device_id,private_key),UNIQUE(device_id,memory_document_id),UNIQUE(owner_user_id,user_agent_instance_id,cloud_key)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS memory_access_audits (
    id TEXT PRIMARY KEY,requester_user_id TEXT NOT NULL DEFAULT '',requester_agent_instance_id TEXT NOT NULL DEFAULT '',
    target_user_id TEXT NOT NULL DEFAULT '',target_agent_instance_id TEXT NOT NULL DEFAULT '',context_space_id TEXT NOT NULL DEFAULT '',
    task_run_id TEXT NOT NULL DEFAULT '',memory_document_id TEXT NOT NULL DEFAULT '',memory_cloud_key TEXT NOT NULL DEFAULT '',
    memory_document_version_id TEXT NOT NULL DEFAULT '',action TEXT NOT NULL,requested_reason TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL,result_code TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_context_spaces_instance ON agent_context_spaces(user_agent_instance_id,lifecycle_state,updated_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_access_audits_target ON memory_access_audits(target_user_id,target_agent_instance_id,created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_context_created ON messages(context_space_id,created_at)');
  db.exec(`UPDATE memory_documents SET agent_family_id=COALESCE((SELECT agent_family_id FROM user_agent_instances WHERE id=memory_documents.user_agent_instance_id),'') WHERE agent_family_id=''`);
  db.exec("UPDATE memory_documents SET cloud_key=id WHERE cloud_key=''");
  db.exec('DROP INDEX IF EXISTS idx_sessions_one_primary_agent');
  // Agent alias identity must not be rewritten one table at a time here. The
  // v3 repair performs Session, Memory, Context and Message rebinding in a
  // trigger-safe order after flattening and validating the complete alias graph.
  db.exec(`UPDATE sessions SET agent_id=COALESCE((SELECT i.agent_family_id FROM user_agent_instances i
    WHERE i.id=sessions.agent_instance_id AND i.user_id=sessions.user_id),agent_id)
    WHERE agent_instance_id!='' AND EXISTS (SELECT 1 FROM user_agent_instances i
      WHERE i.id=sessions.agent_instance_id AND i.user_id=sessions.user_id)`);
  db.exec(`UPDATE memory_document_versions SET base_version_id=CASE WHEN base_version_id='' THEN parent_version_id ELSE base_version_id END,
    parent_version_id=CASE WHEN parent_version_id='' AND version_no>1 THEN COALESCE((SELECT p.id FROM memory_document_versions p WHERE p.memory_document_id=memory_document_versions.memory_document_id AND p.version_no=memory_document_versions.version_no-1),'') ELSE parent_version_id END`);
  db.exec(`DROP TRIGGER IF EXISTS trg_sessions_agent_identity_insert;
  DROP TRIGGER IF EXISTS trg_sessions_agent_identity_update;
  DROP TRIGGER IF EXISTS trg_messages_agent_identity_insert;
  DROP TRIGGER IF EXISTS trg_messages_agent_identity_update;
  DROP TRIGGER IF EXISTS trg_agent_context_spaces_identity_insert;
  DROP TRIGGER IF EXISTS trg_agent_context_spaces_identity_update;
  DROP TRIGGER IF EXISTS trg_agent_device_context_state_identity_insert;
  DROP TRIGGER IF EXISTS trg_agent_device_context_state_identity_update;
  DROP TRIGGER IF EXISTS trg_agent_context_state_identity_insert;
  DROP TRIGGER IF EXISTS trg_agent_context_state_identity_update`);
  db.exec(`WITH ranked AS (
    SELECT id,FIRST_VALUE(id) OVER (PARTITION BY user_id,account_workspace_id,agent_instance_id ORDER BY
      CASE WHEN conversation_role='primary' AND write_state='writable' THEN 0 ELSE 1 END,
      updated_at DESC,created_at DESC,id DESC) winner
    FROM sessions WHERE agent_instance_id!='' AND status!='deleted'
      AND department_id NOT IN ('agent_delegation','collaboration')
      AND NOT EXISTS (SELECT 1 FROM conversations conversation
        WHERE conversation.id=COALESCE(NULLIF(sessions.conversation_id,''),sessions.id)
          AND conversation.conversation_kind!='direct')
  ) UPDATE sessions SET conversation_role=CASE WHEN id=(SELECT winner FROM ranked WHERE ranked.id=sessions.id) THEN 'primary' ELSE 'history' END,
    write_state=CASE WHEN id=(SELECT winner FROM ranked WHERE ranked.id=sessions.id) THEN 'writable' ELSE 'read_only' END,
    superseded_by_session_id=CASE WHEN id=(SELECT winner FROM ranked WHERE ranked.id=sessions.id) THEN '' ELSE (SELECT winner FROM ranked WHERE ranked.id=sessions.id) END
    WHERE id IN (SELECT id FROM ranked)`);
  db.exec(`UPDATE memory_documents SET lifecycle_state='inactive' WHERE scope='general' AND lifecycle_state='active'`);
  db.exec(`WITH ranked AS (
    SELECT id,ROW_NUMBER() OVER (PARTITION BY account_workspace_id,user_id,user_agent_instance_id
      ORDER BY updated_at DESC,slot_no DESC,id DESC) rn
    FROM memory_documents WHERE scope='general' AND lifecycle_state!='archived'
  ) UPDATE memory_documents SET lifecycle_state='active' WHERE id IN (SELECT id FROM ranked WHERE rn=1)`);
  db.exec(`INSERT OR IGNORE INTO agent_context_spaces(id,user_id,account_workspace_id,user_agent_instance_id,context_kind,memory_document_id,lifecycle_state,created_at,updated_at)
    SELECT 'ctx_memory_'||id,user_id,account_workspace_id,user_agent_instance_id,'general_memory',id,
      CASE WHEN lifecycle_state='archived' THEN 'archived' ELSE 'active' END,created_at,updated_at FROM memory_documents WHERE scope='general'`);
  db.exec(`INSERT OR IGNORE INTO agent_context_spaces(id,user_id,account_workspace_id,user_agent_instance_id,context_kind,project_id,lifecycle_state,created_at,updated_at)
    SELECT 'ctx_project_'||account_workspace_id||'_'||user_agent_instance_id||'_'||project_id,user_id,account_workspace_id,user_agent_instance_id,'project',project_id,'active',MIN(created_at),MAX(updated_at)
    FROM memory_documents WHERE project_id!='' GROUP BY user_id,account_workspace_id,user_agent_instance_id,project_id`);
  db.exec(`INSERT OR IGNORE INTO agent_context_spaces(id,user_id,account_workspace_id,user_agent_instance_id,context_kind,task_run_id,delegation_id,group_id,lifecycle_state,created_at,updated_at)
    SELECT 'ctx_task_'||account_workspace_id||'_'||user_agent_instance_id||'_'||task_run_id,user_id,account_workspace_id,user_agent_instance_id,'task',task_run_id,delegation_id,group_id,'active',MIN(created_at),MAX(updated_at)
    FROM memory_documents WHERE scope='task' AND task_run_id!=''
    GROUP BY user_id,account_workspace_id,user_agent_instance_id,task_run_id,delegation_id,group_id`);
  db.exec(`INSERT OR IGNORE INTO agent_context_spaces(id,user_id,account_workspace_id,user_agent_instance_id,context_kind,relationship_user_id,legacy_session_id,lifecycle_state,created_at,updated_at)
    SELECT 'ctx_legacy_'||id,user_id,account_workspace_id,agent_instance_id,'legacy_history','',id,'archived',created_at,updated_at
    FROM sessions WHERE agent_instance_id!='' AND conversation_role='history'`);
  db.exec(`UPDATE messages SET context_space_id=COALESCE((SELECT CASE
      WHEN s.conversation_role='history' THEN 'ctx_legacy_'||s.id
      WHEN s.project_id!='' THEN COALESCE((SELECT c.id FROM agent_context_spaces c WHERE c.account_workspace_id=s.account_workspace_id
        AND c.user_agent_instance_id=s.agent_instance_id AND c.context_kind='project' AND c.project_id=s.project_id
        ORDER BY c.updated_at DESC,c.id DESC LIMIT 1),'')
      ELSE (SELECT 'ctx_memory_'||md.id FROM memory_documents md WHERE md.account_workspace_id=s.account_workspace_id
        AND md.user_id=s.user_id AND md.user_agent_instance_id=s.agent_instance_id AND md.scope='general'
        AND md.lifecycle_state='active' ORDER BY md.updated_at DESC,md.slot_no DESC,md.id DESC LIMIT 1)
    END FROM sessions s WHERE s.id=messages.session_id),'') WHERE context_space_id=''
      AND NOT (json_valid(metadata_json)
        AND json_type(metadata_json,'$.databaseRecovery.orphanedMemoryId') IS NOT NULL)`);
  repairPrimaryAgentSessionUniqueness(db);
  db.exec(`CREATE UNIQUE INDEX idx_sessions_one_primary_agent ON sessions(user_id,account_workspace_id,agent_instance_id)
    WHERE agent_instance_id!='' AND conversation_role='primary' AND write_state='writable' AND status!='deleted'`);
  db.exec(`INSERT OR IGNORE INTO agent_context_state(
    user_id,account_workspace_id,user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id,
    state_revision,base_state_revision,last_command_id,source_device_id,sync_status,created_at,updated_at
  ) SELECT i.user_id,scope.account_workspace_id,i.id,
    COALESCE((SELECT s.id FROM sessions s WHERE s.user_id=i.user_id AND s.agent_instance_id=i.id
      AND s.account_workspace_id=scope.account_workspace_id
      AND s.conversation_role='primary' AND s.write_state='writable' AND s.status!='deleted'
      ORDER BY s.updated_at DESC,s.id DESC LIMIT 1),''),
    COALESCE((SELECT c.id FROM agent_context_spaces c JOIN memory_documents d ON d.id=c.memory_document_id
      WHERE c.user_id=i.user_id AND c.account_workspace_id=scope.account_workspace_id
        AND c.user_agent_instance_id=i.id AND c.context_kind='general_memory'
        AND d.scope='general' AND d.lifecycle_state='active'
      ORDER BY d.updated_at DESC,d.slot_no DESC,d.id DESC LIMIT 1),''),
    COALESCE((SELECT d.id FROM memory_documents d WHERE d.user_id=i.user_id AND d.user_agent_instance_id=i.id
      AND d.account_workspace_id=scope.account_workspace_id AND d.scope='general' AND d.lifecycle_state='active'
      ORDER BY d.updated_at DESC,d.slot_no DESC,d.id DESC LIMIT 1),''),
    1,0,'migration_primary_context','local','pending',i.created_at,i.updated_at
    FROM user_agent_instances i JOIN (
      SELECT user_id,account_workspace_id,agent_instance_id AS user_agent_instance_id FROM sessions WHERE agent_instance_id!=''
      UNION SELECT user_id,account_workspace_id,user_agent_instance_id FROM memory_documents
      UNION SELECT owner_user_id AS user_id,workspace_id AS account_workspace_id,agent_instance_id AS user_agent_instance_id
        FROM workspace_agent_bindings WHERE owner_user_id!=''
    ) scope ON scope.user_id=i.user_id AND scope.user_agent_instance_id=i.id`);
  db.exec(`INSERT OR IGNORE INTO agent_device_context_state(
    device_id,user_id,account_workspace_id,user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id,updated_at
  ) SELECT 'local',user_id,account_workspace_id,user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id,updated_at
    FROM agent_context_state`);
  const evolutionDefaultMigrationApplied = db.prepare(
    "SELECT id FROM schema_migrations WHERE id = 'evolution_default_on_manual_activation_v1'",
  ).get();
  if (!evolutionDefaultMigrationApplied) {
    db.exec(`UPDATE user_agent_instances SET
      personal_evolution_consent=CASE WHEN sync_enabled=1 AND status='active' THEN 1 ELSE 0 END,
      cluster_contribution_consent=CASE WHEN sync_enabled=1 AND status='active' THEN 1 ELSE 0 END,
      personal_skill_auto_activate=0`);
    db.exec(`UPDATE memory_documents SET
      allow_personal_evolution=COALESCE((SELECT personal_evolution_consent FROM user_agent_instances i
        WHERE i.id=memory_documents.user_agent_instance_id),allow_personal_evolution),
      allow_cluster_evolution=COALESCE((SELECT CASE WHEN i.sync_enabled=1 AND i.status='active' THEN 1 ELSE 0 END
        FROM user_agent_instances i WHERE i.id=memory_documents.user_agent_instance_id),allow_cluster_evolution),
      sync_enabled=COALESCE((SELECT sync_enabled FROM user_agent_instances i
        WHERE i.id=memory_documents.user_agent_instance_id),sync_enabled)`);
    db.prepare("INSERT INTO schema_migrations (id) VALUES ('evolution_default_on_manual_activation_v1')").run();
  }
  db.exec(`UPDATE user_agent_instances SET
    personal_evolution_consent=CASE WHEN COALESCE((SELECT evolution_enabled FROM cloud_sync_state WHERE id='default'),1)=1
      AND sync_enabled=1 AND status='active' THEN 1 ELSE 0 END,
    cluster_contribution_consent=CASE WHEN COALESCE((SELECT evolution_enabled FROM cloud_sync_state WHERE id='default'),1)=1
      AND sync_enabled=1 AND status='active' THEN 1 ELSE 0 END,
    personal_skill_auto_activate=0`);
  db.exec(`UPDATE memory_documents SET
    allow_personal_evolution=CASE WHEN COALESCE((SELECT evolution_enabled FROM cloud_sync_state WHERE id='default'),1)=1
      AND lifecycle_state='active' AND COALESCE((SELECT sync_enabled FROM user_agent_instances i
        WHERE i.id=memory_documents.user_agent_instance_id),0)=1
      AND COALESCE((SELECT status FROM user_agent_instances i
        WHERE i.id=memory_documents.user_agent_instance_id),'inactive')='active' THEN 1 ELSE 0 END,
    allow_cluster_evolution=CASE WHEN COALESCE((SELECT evolution_enabled FROM cloud_sync_state WHERE id='default'),1)=1
      AND lifecycle_state='active' AND COALESCE((SELECT sync_enabled FROM user_agent_instances i
        WHERE i.id=memory_documents.user_agent_instance_id),0)=1
      AND COALESCE((SELECT status FROM user_agent_instances i
        WHERE i.id=memory_documents.user_agent_instance_id),'inactive')='active' THEN 1 ELSE 0 END`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_context_state_sync
    ON agent_context_state(user_id,account_workspace_id,sync_status,updated_at)`);
  db.exec(`DROP INDEX IF EXISTS idx_one_active_general_memory;
  CREATE UNIQUE INDEX idx_one_active_general_memory
    ON memory_documents(account_workspace_id,user_id,user_agent_instance_id)
    WHERE scope='general' AND lifecycle_state='active'`);
  const agentIsolationMigrationApplied = db.prepare(
    "SELECT id FROM schema_migrations WHERE id = 'agent_conversation_memory_isolation_v1'",
  ).get();
  const messageSessionAgentConsistencyRepairApplied = db.prepare(
    "SELECT id FROM schema_migrations WHERE id='message_session_agent_consistency_repair_v2'",
  ).get();
  const databaseCoreConsistencyRepairApplied = db.prepare(
    "SELECT id FROM schema_migrations WHERE id='database_core_consistency_repair_v1'",
  ).get();
  if (!agentIsolationMigrationApplied || !messageSessionAgentConsistencyRepairApplied || !databaseCoreConsistencyRepairApplied) {
    const mixedMessages = db.prepare(`SELECT m.id,m.session_id,m.agent_id,m.agent_instance_id,m.context_space_id,
        s.user_id AS session_user_id,s.account_workspace_id AS session_account_workspace_id,
        s.agent_instance_id AS session_agent_instance_id
      FROM messages m JOIN sessions s ON s.id=m.session_id
      WHERE s.agent_instance_id!='' AND NOT EXISTS (
        SELECT 1 FROM agent_context_spaces context WHERE context.id=m.context_space_id
          AND m.context_space_id!='' AND m.agent_instance_id!=''
          AND context.user_agent_instance_id!=m.agent_instance_id
          AND NOT EXISTS (SELECT 1 FROM user_agent_instance_aliases alias WHERE alias.user_id=context.user_id AND (
            (alias.alias_instance_id=m.agent_instance_id AND alias.canonical_instance_id=context.user_agent_instance_id)
            OR (alias.alias_instance_id=context.user_agent_instance_id AND alias.canonical_instance_id=m.agent_instance_id)
          ))
      ) AND (
        m.agent_instance_id!=s.agent_instance_id
        OR (m.agent_id!='' AND m.agent_id!=COALESCE((
          SELECT i.agent_family_id FROM user_agent_instances i WHERE i.id=s.agent_instance_id
        ),'') AND NOT EXISTS (
          SELECT 1 FROM user_agent_instance_aliases alias
          JOIN user_agent_instances canonical ON canonical.id=alias.canonical_instance_id AND canonical.user_id=alias.user_id
          WHERE alias.alias_instance_id=s.agent_instance_id AND alias.user_id=s.user_id
            AND m.agent_instance_id=s.agent_instance_id
        ))
        OR EXISTS (
          SELECT 1 FROM evolution_evidence_outbox e
          WHERE e.local_user_id=s.user_id AND e.source_kind='message' AND e.source_id=m.id
            AND e.user_agent_instance_id!='' AND e.user_agent_instance_id!=s.agent_instance_id
        )
      ) ORDER BY m.created_at,m.id`).all();
    const touchedSessionIds = new Set();
    const targetSessionByInstance = new Map();
    const ensureTargetSession = (instance, accountWorkspaceId = PERSONAL_ACCOUNT_WORKSPACE_ID) => {
      const targetKey = `${accountWorkspaceId}\u001f${instance.id}`;
      if (targetSessionByInstance.has(targetKey)) return targetSessionByInstance.get(targetKey).sessionId;
      let target = db.prepare(`SELECT id FROM sessions WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?
        AND conversation_role='primary' AND write_state='writable' AND status!='deleted'
        ORDER BY updated_at DESC,created_at DESC,id DESC LIMIT 1`).get(instance.user_id, accountWorkspaceId, instance.id);
      if (!target) {
        target = db.prepare(`SELECT id FROM sessions WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?
          ORDER BY CASE WHEN status='deleted' THEN 1 ELSE 0 END,updated_at DESC,created_at DESC,id DESC LIMIT 1`)
          .get(instance.user_id, accountWorkspaceId, instance.id);
        if (target) {
          db.prepare(`UPDATE sessions SET conversation_role='primary',write_state='writable',superseded_by_session_id='',
            agent_id=?,department_id=?,status='active',pinned_at='',codex_thread_id='',
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
            .run(instance.agent_family_id, instance.department_id || '', target.id);
        } else {
          const baseId = `session_recovered_${instance.id}`;
          let sessionId = baseId;
          let suffix = 1;
          while (db.prepare('SELECT 1 FROM sessions WHERE id=?').get(sessionId)) sessionId = `${baseId}_${suffix++}`;
          db.prepare(`INSERT INTO sessions(
            id,user_id,account_workspace_id,title,department_id,agent_id,agent_instance_id,conversation_role,write_state,status
          ) VALUES(?,?,?,?,?,?,?,'primary','writable','active')`).run(
            sessionId, instance.user_id, accountWorkspaceId, 'Recovered Agent conversation', instance.department_id || '', instance.agent_family_id, instance.id,
          );
          target = { id: sessionId };
        }
      }
      targetSessionByInstance.set(targetKey, { instanceId: instance.id, sessionId: target.id, accountWorkspaceId });
      return target.id;
    };
    for (const message of mixedMessages) {
      const evidenceInstance = db.prepare(`SELECT i.*,COALESCE(f.department_id,'') AS department_id
        FROM evolution_evidence_outbox e
        JOIN user_agent_instances i ON i.id=e.user_agent_instance_id AND i.user_id=e.local_user_id
        LEFT JOIN agent_families f ON f.id=i.agent_family_id
        WHERE e.local_user_id=? AND e.source_kind='message' AND e.source_id=?
        ORDER BY e.created_at DESC,e.outbox_id DESC LIMIT 1`).get(message.session_user_id, message.id);
      const sessionInstance = db.prepare(`SELECT i.*,COALESCE(f.department_id,'') AS department_id
        FROM user_agent_instances i LEFT JOIN agent_families f ON f.id=i.agent_family_id
        WHERE i.user_id=? AND i.id=? LIMIT 1`).get(message.session_user_id, message.session_agent_instance_id);
      const recordedInstance = message.agent_instance_id
        ? db.prepare(`SELECT i.*,COALESCE(f.department_id,'') AS department_id
          FROM user_agent_instances i LEFT JOIN agent_families f ON f.id=i.agent_family_id
          WHERE i.user_id=? AND i.id=? LIMIT 1`).get(message.session_user_id, message.agent_instance_id)
        : null;
      const aliasedInstance = message.agent_instance_id
        ? db.prepare(`SELECT i.*,COALESCE(f.department_id,'') AS department_id
          FROM user_agent_instance_aliases a
          JOIN user_agent_instances i ON i.id=a.canonical_instance_id AND i.user_id=a.user_id
          LEFT JOIN agent_families f ON f.id=i.agent_family_id
          WHERE a.user_id=? AND a.alias_instance_id=? LIMIT 1`).get(message.session_user_id, message.agent_instance_id)
        : null;
      const familyInstances = !recordedInstance && !aliasedInstance && message.agent_id
        ? db.prepare(`SELECT i.*,COALESCE(f.department_id,'') AS department_id
          FROM user_agent_instances i LEFT JOIN agent_families f ON f.id=i.agent_family_id
          WHERE i.user_id=? AND i.agent_family_id=? ORDER BY i.updated_at DESC,i.id DESC LIMIT 2`)
          .all(message.session_user_id, message.agent_id)
        : [];
      const familyInstance = familyInstances.length === 1 ? familyInstances[0] : null;
      const instance = aliasedInstance || evidenceInstance || recordedInstance || familyInstance || sessionInstance;
      if (!instance) continue;
      const targetSessionId = instance.id === message.session_agent_instance_id
        ? message.session_id
        : ensureTargetSession(instance, message.session_account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID);
      const activeContext = db.prepare(`SELECT active_context_space_id FROM agent_context_state
        WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`).get(
        instance.user_id, message.session_account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID, instance.id,
      )?.active_context_space_id || '';
      const contextOwned = message.context_space_id && db.prepare(`SELECT 1 FROM agent_context_spaces
        WHERE id=? AND user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`).get(
        message.context_space_id, instance.user_id, message.session_account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID, instance.id,
      );
      db.prepare(`UPDATE messages SET session_id=?,agent_id=?,agent_instance_id=?,department_id=?,context_space_id=? WHERE id=?`).run(
        targetSessionId, instance.agent_family_id, instance.id, instance.department_id || '', contextOwned ? message.context_space_id : activeContext, message.id,
      );
      db.prepare(`UPDATE model_executions SET conversation_id=?,agent_id=?,agent_instance_id=?
        WHERE request_message_id=? OR response_message_id=?`).run(
        targetSessionId, instance.agent_family_id, instance.id, message.id, message.id,
      );
      touchedSessionIds.add(message.session_id);
      touchedSessionIds.add(targetSessionId);
    }
    for (const sessionId of touchedSessionIds) {
      db.prepare("UPDATE sessions SET codex_thread_id='',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(sessionId);
      db.prepare('DELETE FROM chat_context_states WHERE session_id=?').run(sessionId);
    }
    for (const { instanceId, sessionId, accountWorkspaceId } of targetSessionByInstance.values()) {
      db.prepare(`UPDATE agent_context_state SET primary_session_id=?,state_revision=state_revision+1,
        last_command_id='agent_conversation_memory_isolation_v1',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE account_workspace_id=? AND user_agent_instance_id=?`).run(sessionId, accountWorkspaceId, instanceId);
      db.prepare(`UPDATE agent_device_context_state SET primary_session_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE account_workspace_id=? AND user_agent_instance_id=?`).run(sessionId, accountWorkspaceId, instanceId);
    }
    db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('agent_conversation_memory_isolation_v1')").run();
    db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('message_session_agent_consistency_repair_v2')").run();
    db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('database_core_consistency_repair_v1')").run();
  }
  const legacyMessageSessionAgentBackfillApplied = db.prepare(
    "SELECT id FROM schema_migrations WHERE id='legacy_message_session_agent_backfill_v1'",
  ).get();
  if (!legacyMessageSessionAgentBackfillApplied) {
    db.exec(`UPDATE messages SET
      agent_instance_id=(SELECT s.agent_instance_id FROM sessions s WHERE s.id=messages.session_id),
      agent_id=COALESCE(NULLIF(agent_id,''),(SELECT i.agent_family_id
        FROM sessions s JOIN user_agent_instances i ON i.id=s.agent_instance_id
        WHERE s.id=messages.session_id)),
      department_id=COALESCE(NULLIF(department_id,''),(SELECT COALESCE(f.department_id,'')
        FROM sessions s JOIN user_agent_instances i ON i.id=s.agent_instance_id
        LEFT JOIN agent_families f ON f.id=i.agent_family_id WHERE s.id=messages.session_id))
      WHERE agent_instance_id='' AND EXISTS (
        SELECT 1 FROM sessions s JOIN user_agent_instances i ON i.id=s.agent_instance_id
        WHERE s.id=messages.session_id AND s.agent_instance_id!=''
          AND (messages.agent_id='' OR messages.agent_id=i.agent_family_id)
      )`);
    db.prepare("INSERT INTO schema_migrations(id) VALUES('legacy_message_session_agent_backfill_v1')").run();
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_agent_instance_updated
    ON sessions(user_id,agent_instance_id,status,updated_at);
  CREATE INDEX IF NOT EXISTS idx_messages_agent_instance_session_created
    ON messages(agent_instance_id,session_id,created_at)`);
  db.exec(`DROP TRIGGER IF EXISTS trg_sessions_agent_identity_insert;
  DROP TRIGGER IF EXISTS trg_sessions_agent_identity_update;
  DROP TRIGGER IF EXISTS trg_messages_agent_identity_insert;
  DROP TRIGGER IF EXISTS trg_messages_agent_identity_update;
  DROP TRIGGER IF EXISTS trg_agent_context_spaces_identity_insert;
  DROP TRIGGER IF EXISTS trg_agent_context_spaces_identity_update;
  DROP TRIGGER IF EXISTS trg_agent_device_context_state_identity_insert;
  DROP TRIGGER IF EXISTS trg_agent_device_context_state_identity_update;
  DROP TRIGGER IF EXISTS trg_agent_context_state_identity_insert;
  DROP TRIGGER IF EXISTS trg_agent_context_state_identity_update`);
  repairAccountWorkspaceContextConsistency(db);
  const sessionAgentIdentityPolicy = `
    SELECT CASE WHEN NEW.agent_instance_id!='' AND NOT EXISTS (
      SELECT 1 FROM user_agent_instances i WHERE i.id=NEW.agent_instance_id AND i.user_id=NEW.user_id
        AND (NEW.agent_id='' OR i.agent_family_id=NEW.agent_id)
    ) THEN RAISE(ABORT,'session_agent_identity_mismatch') END;`;
  db.exec(`CREATE TRIGGER trg_sessions_agent_identity_insert BEFORE INSERT ON sessions BEGIN
    ${sessionAgentIdentityPolicy} END;
  CREATE TRIGGER trg_sessions_agent_identity_update BEFORE UPDATE OF user_id,agent_id,agent_instance_id ON sessions BEGIN
    ${sessionAgentIdentityPolicy} END;`);
  const messageAgentIdentityPolicy = `
    SELECT CASE WHEN NEW.session_id!='' AND NOT EXISTS (SELECT 1 FROM sessions WHERE id=NEW.session_id)
      THEN RAISE(ABORT,'message_session_not_found') END;
    SELECT CASE WHEN NEW.agent_instance_id!='' AND NOT EXISTS (
      SELECT 1 FROM user_agent_instances i WHERE i.id=NEW.agent_instance_id
        AND (NEW.agent_id='' OR i.agent_family_id=NEW.agent_id)
    ) THEN RAISE(ABORT,'message_agent_identity_mismatch') END;
    SELECT CASE WHEN NEW.session_id!='' AND EXISTS (
      SELECT 1 FROM sessions s WHERE s.id=NEW.session_id AND s.agent_instance_id!=''
        AND NEW.agent_instance_id!=s.agent_instance_id
    ) THEN RAISE(ABORT,'message_session_agent_mismatch') END;
    SELECT CASE WHEN NEW.session_id!='' AND EXISTS (
      SELECT 1 FROM sessions s WHERE s.id=NEW.session_id AND s.account_workspace_id!=NEW.account_workspace_id
    ) THEN RAISE(ABORT,'message_session_workspace_mismatch') END;
    SELECT CASE WHEN NEW.context_space_id!='' AND NEW.agent_instance_id!='' AND NOT EXISTS (
      SELECT 1 FROM agent_context_spaces c WHERE c.id=NEW.context_space_id
        AND c.account_workspace_id=NEW.account_workspace_id AND c.user_agent_instance_id=NEW.agent_instance_id
    ) THEN RAISE(ABORT,'message_context_agent_mismatch') END;`;
  db.exec(`CREATE TRIGGER trg_messages_agent_identity_insert BEFORE INSERT ON messages BEGIN
    ${messageAgentIdentityPolicy} END;
  CREATE TRIGGER trg_messages_agent_identity_update BEFORE UPDATE OF account_workspace_id,session_id,agent_id,agent_instance_id,context_space_id ON messages BEGIN
    ${messageAgentIdentityPolicy} END;`);
  const contextSpaceIdentityPolicy = `
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM user_agent_instances i
      WHERE i.id=NEW.user_agent_instance_id AND i.user_id=NEW.user_id)
      THEN RAISE(ABORT,'context_space_agent_identity_mismatch') END;
    SELECT CASE WHEN NEW.memory_document_id!='' AND NOT EXISTS (SELECT 1 FROM memory_documents d
      WHERE d.id=NEW.memory_document_id AND d.user_id=NEW.user_id AND d.account_workspace_id=NEW.account_workspace_id
        AND (d.user_agent_instance_id=NEW.user_agent_instance_id OR EXISTS (
          SELECT 1 FROM user_agent_instance_aliases a WHERE a.user_id=NEW.user_id
            AND ((a.alias_instance_id=d.user_agent_instance_id AND a.canonical_instance_id=NEW.user_agent_instance_id)
              OR (a.alias_instance_id=NEW.user_agent_instance_id AND a.canonical_instance_id=d.user_agent_instance_id))
        )))
      THEN RAISE(ABORT,'context_space_memory_agent_mismatch') END;`;
  db.exec(`CREATE TRIGGER trg_agent_context_spaces_identity_insert BEFORE INSERT ON agent_context_spaces BEGIN
    ${contextSpaceIdentityPolicy} END;
  CREATE TRIGGER trg_agent_context_spaces_identity_update BEFORE UPDATE OF account_workspace_id,user_id,user_agent_instance_id,memory_document_id ON agent_context_spaces BEGIN
    ${contextSpaceIdentityPolicy} END;`);
  const deviceContextIdentityPolicy = `
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM user_agent_instances i
      WHERE i.id=NEW.user_agent_instance_id AND i.user_id=NEW.user_id)
      THEN RAISE(ABORT,'device_context_agent_identity_mismatch') END;
    SELECT CASE WHEN NEW.primary_session_id!='' AND NOT EXISTS (SELECT 1 FROM sessions s
      WHERE s.id=NEW.primary_session_id AND s.user_id=NEW.user_id AND s.account_workspace_id=NEW.account_workspace_id
        AND (s.agent_instance_id=NEW.user_agent_instance_id OR EXISTS (
          SELECT 1 FROM user_agent_instance_aliases a WHERE a.user_id=NEW.user_id
            AND ((a.alias_instance_id=s.agent_instance_id AND a.canonical_instance_id=NEW.user_agent_instance_id)
              OR (a.alias_instance_id=NEW.user_agent_instance_id AND a.canonical_instance_id=s.agent_instance_id))
        )))
      THEN RAISE(ABORT,'device_context_session_agent_mismatch') END;
    SELECT CASE WHEN NEW.active_context_space_id!='' AND NOT EXISTS (SELECT 1 FROM agent_context_spaces c
      WHERE c.id=NEW.active_context_space_id AND c.user_id=NEW.user_id AND c.account_workspace_id=NEW.account_workspace_id
        AND (c.user_agent_instance_id=NEW.user_agent_instance_id OR EXISTS (
          SELECT 1 FROM user_agent_instance_aliases a WHERE a.user_id=NEW.user_id
            AND ((a.alias_instance_id=c.user_agent_instance_id AND a.canonical_instance_id=NEW.user_agent_instance_id)
              OR (a.alias_instance_id=NEW.user_agent_instance_id AND a.canonical_instance_id=c.user_agent_instance_id))
        )))
      THEN RAISE(ABORT,'device_context_space_agent_mismatch') END;
    SELECT CASE WHEN NEW.active_memory_document_id!='' AND NOT EXISTS (SELECT 1 FROM memory_documents d
      WHERE d.id=NEW.active_memory_document_id AND d.user_id=NEW.user_id AND d.account_workspace_id=NEW.account_workspace_id
        AND (d.user_agent_instance_id=NEW.user_agent_instance_id OR EXISTS (
          SELECT 1 FROM user_agent_instance_aliases a WHERE a.user_id=NEW.user_id
            AND ((a.alias_instance_id=d.user_agent_instance_id AND a.canonical_instance_id=NEW.user_agent_instance_id)
              OR (a.alias_instance_id=NEW.user_agent_instance_id AND a.canonical_instance_id=d.user_agent_instance_id))
        )))
      THEN RAISE(ABORT,'device_context_memory_agent_mismatch') END;`;
  db.exec(`CREATE TRIGGER trg_agent_device_context_state_identity_insert BEFORE INSERT ON agent_device_context_state BEGIN
    ${deviceContextIdentityPolicy} END;
  CREATE TRIGGER trg_agent_device_context_state_identity_update BEFORE UPDATE OF account_workspace_id,user_id,user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id ON agent_device_context_state BEGIN
    ${deviceContextIdentityPolicy} END;
  CREATE TRIGGER trg_agent_context_state_identity_insert BEFORE INSERT ON agent_context_state BEGIN
    ${deviceContextIdentityPolicy} END;
  CREATE TRIGGER trg_agent_context_state_identity_update BEFORE UPDATE OF account_workspace_id,user_id,user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id ON agent_context_state BEGIN
    ${deviceContextIdentityPolicy} END;`);
  const redirectedPrimaryRepairApplied = db.prepare("SELECT id FROM schema_migrations WHERE id='redirected_primary_conversation_rebind_v1'").get();
  if (!redirectedPrimaryRepairApplied) {
    const redirectedConversationSql = `SELECT h.id AS history_id,p.id AS primary_id,h.updated_at AS history_updated_at
      FROM sessions h JOIN sessions p ON p.id=h.superseded_by_session_id
      WHERE h.conversation_role='history' AND h.write_state='read_only'
        AND h.agent_instance_id!='' AND h.agent_instance_id=p.agent_instance_id
        AND h.created_at>p.created_at AND p.conversation_role='primary' AND p.write_state='writable'
        AND h.status!='deleted' AND p.status!='deleted'`;
    for (const [table, column] of [
      ['messages', 'session_id'], ['model_executions', 'conversation_id'],
      ['cloud_file_refs', 'session_id'], ['cloud_file_manifest', 'session_id'],
    ]) {
      db.exec(`WITH redirected AS (${redirectedConversationSql})
        UPDATE ${table} SET ${column}=(SELECT primary_id FROM redirected WHERE history_id=${table}.${column})
        WHERE ${column} IN (SELECT history_id FROM redirected)`);
    }
    db.exec(`WITH redirected AS (${redirectedConversationSql})
      UPDATE sessions SET updated_at=MAX(updated_at,(SELECT history_updated_at FROM redirected WHERE primary_id=sessions.id))
      WHERE id IN (SELECT primary_id FROM redirected)`);
    db.prepare("INSERT INTO schema_migrations(id) VALUES('redirected_primary_conversation_rebind_v1')").run();
  }
  const workspaceConversationContinuityApplied = db.prepare(
    "SELECT id FROM schema_migrations WHERE id='workspace_context_conversation_continuity_v1'",
  ).get();
  if (!workspaceConversationContinuityApplied) {
    const primarySessions = db.prepare(`SELECT s.id,s.conversation_id,s.user_id,s.account_workspace_id,s.agent_instance_id,s.updated_at,
        COALESCE(state.active_memory_document_id,'') AS active_memory_document_id,
        COALESCE(cs.id,'') AS conversation_context_space_id
      FROM sessions s
      LEFT JOIN agent_context_state state ON state.user_id=s.user_id AND state.account_workspace_id=s.account_workspace_id
        AND state.user_agent_instance_id=s.agent_instance_id
      LEFT JOIN agent_context_spaces cs ON cs.user_id=s.user_id AND cs.account_workspace_id=s.account_workspace_id
        AND cs.user_agent_instance_id=s.agent_instance_id
        AND cs.context_kind='general_memory' AND cs.memory_document_id=state.active_memory_document_id
      WHERE s.agent_instance_id!='' AND s.conversation_role='primary'
        AND s.write_state='writable' AND s.status!='deleted'`).all();
    for (const primary of primarySessions) {
      const historyIds = db.prepare(`SELECT id FROM sessions WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=? AND id<>?
        AND conversation_role='history' AND status!='deleted'`).all(
        primary.user_id, primary.account_workspace_id, primary.agent_instance_id, primary.id,
      ).map((row) => row.id);
      const sourceSessionIds = [primary.id, ...historyIds];
      const placeholders = sourceSessionIds.map(() => '?').join(',');
      const contextSpaceId = primary.conversation_context_space_id || '';
      if (contextSpaceId) {
        db.prepare(`UPDATE messages SET context_space_id=? WHERE session_id IN (${placeholders})
          AND (context_space_id='' OR EXISTS (
            SELECT 1 FROM agent_context_spaces c
            WHERE c.id=messages.context_space_id AND c.context_kind!='general_memory'
          ))`).run(contextSpaceId, ...sourceSessionIds);
      }
      if (historyIds.length) {
        const historyPlaceholders = historyIds.map(() => '?').join(',');
        db.prepare(`UPDATE messages SET session_id=?,conversation_id=?,memory_id=COALESCE(NULLIF(?,''),memory_id)
          WHERE session_id IN (${historyPlaceholders})`).run(
          primary.id, primary.conversation_id || primary.id, primary.active_memory_document_id || '', ...historyIds,
        );
        db.prepare(`UPDATE model_executions SET conversation_id=? WHERE conversation_id IN (${historyPlaceholders})`).run(primary.id, ...historyIds);
        db.prepare(`UPDATE cloud_file_refs SET session_id=? WHERE session_id IN (${historyPlaceholders})`).run(primary.id, ...historyIds);
        db.prepare(`UPDATE cloud_file_manifest SET session_id=? WHERE session_id IN (${historyPlaceholders})`).run(primary.id, ...historyIds);
        db.prepare(`UPDATE agent_delegations SET session_id=? WHERE session_id IN (${historyPlaceholders})`).run(primary.id, ...historyIds);
        db.prepare(`UPDATE agent_delegation_workspaces SET session_id=? WHERE session_id IN (${historyPlaceholders})`).run(primary.id, ...historyIds);
        db.prepare(`UPDATE agent_delivery_receipts SET source_session_id=? WHERE source_session_id IN (${historyPlaceholders})`).run(primary.id, ...historyIds);
        db.prepare(`UPDATE agent_delivery_receipts SET target_session_id=? WHERE target_session_id IN (${historyPlaceholders})`).run(primary.id, ...historyIds);
        db.prepare(`DELETE FROM chat_context_states WHERE session_id IN (${historyPlaceholders})`).run(...historyIds);
        db.prepare(`UPDATE sessions SET status='deleted',pinned_at='',superseded_by_session_id=?,codex_thread_id='',
          updated_at=MAX(updated_at,?) WHERE id IN (${historyPlaceholders})`).run(primary.id, primary.updated_at || '', ...historyIds);
      }
      if (contextSpaceId) {
        db.prepare(`DELETE FROM chat_context_states WHERE session_id=? AND context_space_id!='' AND context_space_id!=?`).run(
          primary.id, contextSpaceId,
        );
      }
      db.prepare(`UPDATE sessions SET codex_thread_id='',updated_at=COALESCE((
        SELECT MAX(created_at) FROM messages WHERE session_id=?
      ),updated_at) WHERE id=?`).run(primary.id, primary.id);
    }
    db.prepare("INSERT INTO schema_migrations(id) VALUES('workspace_context_conversation_continuity_v1')").run();
  }
  migratePhase6ConversationIdentity(db);
  migrateAgentSingleWindowContinuity(db);
  migrateAgentInstanceAliasCycleRepairV2(db);
  migrateAgentAliasContextReferenceRepairV3(db);
  repairAgentConversationBranchConsistency(db);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('primary_context_memory_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('friend_remarks_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('evolution_evidence_outbox_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('ubuddy_task_graph_summary_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('evolution_evidence_legacy_backfill_v2')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('evolution_evidence_lineage_quarantine_v3')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('evolution_evidence_outbox_scheduling_v4')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('chat_context_state_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('agent_delivery_receipts_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('agent_delivery_progress_v2')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('collaboration_group_shared_workspace_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('task_node_recovery_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('cloud_sync_v6_deferred_changes_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('contact_organizations_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('organization_member_friendships_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('employee_multi_instance_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('general_agent_family_consolidation_v1')").run();
  db.prepare("INSERT OR IGNORE INTO app_settings(key,value) VALUES('ubuddy:feature_flags:v1','{}')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('ubuddy_rollout_flags_v1')").run();
  const leadershipTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='leadership_assignments'").get();
  const leadershipColumns = leadershipTable
    ? new Set(db.prepare('PRAGMA table_info(leadership_assignments)').all().map((row) => row.name))
    : new Set();
  const leadershipIndex = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_leadership_assignments_scope_agent'").get();
  const leadershipInsertTrigger = db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_leadership_assignments_policy_insert'").get();
  const leadershipUpdateTrigger = db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_leadership_assignments_policy_update'").get();
  if (!leadershipTable || !leadershipColumns.has('leadership_level_snapshot') || !leadershipColumns.has('assignment_mode')
    || !leadershipIndex || !leadershipInsertTrigger || !leadershipUpdateTrigger) {
    throw new Error('agent_leadership_levels_v1 structure verification failed');
  }
  if (legacySessionUniqueIndexes(db).length) {
    throw new Error('sessions_canonical_primary_uniqueness_v1 structure verification failed');
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('agent_leadership_levels_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('database_maintenance_framework_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('sessions_canonical_primary_uniqueness_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('database_writer_guard_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('database_evolution_contract_v1')").run();
  const coordinationTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ubuddy_coordination_states'").get();
  const wakeOutboxTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ubuddy_wake_outbox'").get();
  const wakeIdentityIndex = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_ubuddy_wake_task_generation_unique'").get();
  if (!coordinationTable || !wakeOutboxTable || !wakeIdentityIndex) {
    throw new Error('ubuddy_sleep_wake_coordination_v1 structure verification failed');
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('ubuddy_sleep_wake_coordination_v1')").run();
  const chatGroupTables = ['chat_groups', 'chat_group_members', 'chat_group_messages', 'chat_group_outbox'];
  if (chatGroupTables.some((table) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))) {
    throw new Error('social_chat_groups_v1 structure verification failed');
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('social_chat_groups_v1')").run();
  const startupPreferenceTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_workspace_startup_preferences'").get();
  const chatGroupColumns = new Set(db.prepare('PRAGMA table_info(chat_groups)').all().map((row) => String(row.name || '')));
  if (!startupPreferenceTable || !chatGroupColumns.has('audience_scope')) {
    throw new Error('social_directory_v2 structure verification failed');
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('social_directory_v2')").run();
  const conversationArchiveTables = ['social_conversation_preferences', 'social_conversation_preference_outbox', 'social_inbox_preferences', 'social_inbox_preference_outbox'];
  if (conversationArchiveTables.some((table) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))) {
    throw new Error('social_conversation_archive_v1 structure verification failed');
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('social_conversation_archive_v1')").run();
  const allocationTables = ['agent_work_reservations', 'ubuddy_agent_wait_requests'];
  const activeReservationIndex = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_agent_work_reservations_one_active'").get();
  if (allocationTables.some((table) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
    || !activeReservationIndex) {
    throw new Error('ubuddy_agent_allocation_v1 structure verification failed');
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('ubuddy_agent_allocation_v1')").run();
  const reservationV2Columns = new Set(db.prepare('PRAGMA table_info(agent_work_reservations)').all().map((row) => String(row.name || '')));
  const waitV2Columns = new Set(db.prepare('PRAGMA table_info(ubuddy_agent_wait_requests)').all().map((row) => String(row.name || '')));
  const planningJobsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ubuddy_planning_jobs'").get();
  if (!['lease_owner', 'lease_expires_at', 'heartbeat_at'].every((column) => reservationV2Columns.has(column))
    || !waitV2Columns.has('binding_policy') || !planningJobsTable) {
    throw new Error('ubuddy_coordination_contract_v2 structure verification failed');
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('ubuddy_coordination_contract_v2')").run();
  const recoveryWakeSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ubuddy_wake_outbox'").get()?.sql || '');
  if (!/recovery_required/.test(recoveryWakeSql)) {
    throw new Error('ubuddy_failure_recovery_v1 structure verification failed');
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('ubuddy_failure_recovery_v1')").run();
  const contactRemarkTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='social_contact_remarks'").get();
  const organizationMemberColumns = new Set(db.prepare('PRAGMA table_info(contact_organization_members)').all().map((row) => String(row.name || '')));
  const naturalGroupMemberColumns = new Set(db.prepare('PRAGMA table_info(chat_group_members)').all().map((row) => String(row.name || '')));
  const workGroupMemberColumns = new Set(db.prepare('PRAGMA table_info(collaboration_group_members)').all().map((row) => String(row.name || '')));
  if (!contactRemarkTable || !organizationMemberColumns.has('display_name_override')
    || !naturalGroupMemberColumns.has('display_name_override') || !workGroupMemberColumns.has('display_name_override')) {
    throw new Error('social_contact_labels_v1 structure verification failed');
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('social_contact_labels_v1')").run();
  const profileSocialTables = ['ubuddy_capability_profile_cache', 'ubuddy_capability_profile_publication_outbox'];
  if (profileSocialTables.some((table) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))) {
    throw new Error('ubuddy_capability_profile_social_v1 structure verification failed');
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('ubuddy_capability_profile_social_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('agent_single_window_continuity_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('agent_instance_alias_cycle_repair_v2')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('agent_alias_context_reference_repair_v3')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('agent_alias_context_state_repair_v4')").run();
  const profileHistoryTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ubuddy_capability_profiles'").get();
  const profileActiveIndex = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_ubuddy_capability_profiles_one_active'").get();
  if (!profileHistoryTable || !profileActiveIndex) throw new Error('ubuddy_profile_history_v1 structure verification failed');
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('ubuddy_profile_history_v1')").run();
  const profileUpdateOutboxTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='profile_update_outbox'").get();
  const profileUpdateOutboxIndex = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_profile_update_outbox_due'").get();
  if (!profileUpdateOutboxTable || !profileUpdateOutboxIndex) throw new Error('profile_update_outbox_v1 structure verification failed');
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('profile_update_outbox_v1')").run();
  const deliveryReviewTables = [
    'task_delivery_reviews', 'task_delivery_submissions', 'task_delivery_review_events', 'task_delivery_review_jobs',
  ];
  if (deliveryReviewTables.some((table) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))) {
    throw new Error('bounded_delivery_rework_v1 structure verification failed');
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('bounded_delivery_rework_v1')").run();
  const accountPrincipalTables = [
    'accounts', 'auth_principals', 'account_memberships', 'account_workspace_bindings',
    'conversation_account_bindings', 'social_direct_conversations', 'account_agent_instances',
  ];
  if (accountPrincipalTables.some((table) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
    || !new Set(db.prepare('PRAGMA table_info(social_messages)').all().map((row) => row.name)).has('conversation_id')) {
    throw new Error('account_principal_isolation_v1 structure verification failed');
  }
  db.exec(`DROP TRIGGER IF EXISTS trg_social_messages_security_domain_insert;
  CREATE TRIGGER trg_social_messages_security_domain_insert BEFORE INSERT ON social_messages
  WHEN NEW.conversation_id='' OR NOT EXISTS (
    SELECT 1 FROM conversation_account_bindings binding WHERE binding.conversation_id=NEW.conversation_id
  ) BEGIN SELECT RAISE(ABORT,'social message security domain is required'); END;
  DROP TRIGGER IF EXISTS trg_social_messages_security_domain_update;
  CREATE TRIGGER trg_social_messages_security_domain_update BEFORE UPDATE OF conversation_id ON social_messages
  WHEN NEW.conversation_id='' OR NOT EXISTS (
    SELECT 1 FROM conversation_account_bindings binding WHERE binding.conversation_id=NEW.conversation_id
  ) BEGIN SELECT RAISE(ABORT,'social message security domain is required'); END;`);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('account_principal_isolation_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('managed_provider_usage_ledger_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('recent_work_reporting_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('janus_clean_slate_identity_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('organization_message_research_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('follower_local_service_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('follower_cloud_evolution_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('follower_integrity_hardening_v1')").run();
  migrateFollowerDefaultCloudEvolutionV1(db);
  migrateFollowerDefaultWorkSourcesV1(db);
  recoverOrphanedMemoryMessageReferencesV1(db);
  migrateMemoryContextPointerRepairV1(db);
  migrateMessageMemoryTurnBindingRepairV2(db);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('attached_skill_registry_v1')").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('workspace_scoped_social_message_cursors_v1')").run();
  if (!databaseCoreConsistencyRepairApplied) repairMemoryContextPointersV1(db);
}

function ensureUBuddyContinuousPlanningSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ubuddy_planning_sessions (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    account_workspace_id TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL DEFAULT '',
    codex_thread_id TEXT NOT NULL DEFAULT '',
    thread_epoch INTEGER NOT NULL DEFAULT 1 CHECK(thread_epoch>=1),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
    status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN (
      'planning','awaiting_clarification','awaiting_confirmation','ready_to_dispatch','dispatching',
      'dispatched','retryable_failure','cancelled','superseded'
    )),
    engine_version TEXT NOT NULL DEFAULT 'continuous_v1',
    model_config_json TEXT NOT NULL DEFAULT '{}',
    plan_json TEXT NOT NULL DEFAULT '{}',
    dispatch_json TEXT NOT NULL DEFAULT '{}',
    last_error_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ubuddy_planning_sessions_scope
    ON ubuddy_planning_sessions(owner_user_id,account_workspace_id,source_session_id,status,updated_at);
  CREATE TABLE IF NOT EXISTS ubuddy_planning_session_events (
    id TEXT PRIMARY KEY,
    planning_session_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    base_revision INTEGER NOT NULL DEFAULT 0,
    result_revision INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(planning_session_id,idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_ubuddy_planning_session_events_revision
    ON ubuddy_planning_session_events(planning_session_id,result_revision,created_at);
  INSERT OR IGNORE INTO schema_migrations(id) VALUES('ubuddy_continuous_planning_v1')`);
}

export function ensureAttachedSkillRegistrySchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS attached_skill_packages (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'local',
    source_uri TEXT NOT NULL DEFAULT '',
    source_revision TEXT NOT NULL DEFAULT '',
    install_root TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'installed',
    content_hash TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CHECK(source_type IN ('local','github','builtin')),
    CHECK(status IN ('installed','invalid','disabled'))
  );
  CREATE INDEX IF NOT EXISTS idx_attached_skill_packages_owner
    ON attached_skill_packages(owner_user_id,status,updated_at);
  CREATE TABLE IF NOT EXISTS attached_skills (
    id TEXT PRIMARY KEY,
    package_id TEXT NOT NULL,
    skill_key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    relative_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(package_id,skill_key),
    CHECK(status IN ('ready','invalid','disabled')),
    FOREIGN KEY(package_id) REFERENCES attached_skill_packages(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_attached_skills_package
    ON attached_skills(package_id,status,name);
  CREATE TABLE IF NOT EXISTS attached_skill_assignments (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(owner_user_id,skill_id,scope_type,scope_id),
    CHECK(scope_type IN ('department','agent_family','agent_instance')),
    CHECK(enabled IN (0,1)),
    FOREIGN KEY(skill_id) REFERENCES attached_skills(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_attached_skill_assignments_scope
    ON attached_skill_assignments(owner_user_id,scope_type,scope_id,enabled);
  CREATE INDEX IF NOT EXISTS idx_attached_skill_assignments_skill
    ON attached_skill_assignments(skill_id,owner_user_id,enabled);`);
}

function recoverOrphanedMemoryMessageReferencesV1(db) {
  const requiredTables = ['messages', 'memory_documents', 'agent_context_spaces'];
  if (requiredTables.some((table) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))) return;
  const messageColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map((row) => String(row.name || '')));
  if (!['memory_id', 'context_space_id', 'metadata_json', 'account_workspace_id', 'agent_instance_id']
    .every((column) => messageColumns.has(column))) return;

  const orphanedMessages = db.prepare(`SELECT message.id,message.memory_id,message.context_space_id,
      message.metadata_json,message.account_workspace_id,message.agent_instance_id,COALESCE(session.user_id,'') AS user_id
    FROM messages message
    LEFT JOIN sessions session ON session.id=message.session_id
    WHERE message.memory_id!=''
      AND NOT EXISTS (SELECT 1 FROM memory_documents memory WHERE memory.id=message.memory_id)
    ORDER BY message.id`).all();
  const contextTarget = db.prepare(`SELECT memory.id
    FROM agent_context_spaces context
    JOIN memory_documents memory ON memory.id=context.memory_document_id AND memory.scope='general'
    WHERE context.id=? AND context.account_workspace_id=? AND memory.account_workspace_id=?
      AND (?='' OR context.user_id=?) AND (?='' OR context.user_agent_instance_id=?)
      AND context.user_id=memory.user_id AND context.user_agent_instance_id=memory.user_agent_instance_id
      AND context.context_kind='general_memory'
    ORDER BY memory.id LIMIT 2`);
  const updateMessage = db.prepare('UPDATE messages SET memory_id=?,context_space_id=?,metadata_json=? WHERE id=?');

  for (const message of orphanedMessages) {
    let metadata = {};
    try {
      const parsed = JSON.parse(String(message.metadata_json || '{}'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
    } catch {
      metadata = {};
    }
    const previousRecovery = metadata.databaseRecovery && typeof metadata.databaseRecovery === 'object'
      && !Array.isArray(metadata.databaseRecovery) ? metadata.databaseRecovery : {};
    metadata.databaseRecovery = {
      ...previousRecovery,
      orphanedMemoryId: String(message.memory_id),
      reason: 'missing_memory_document',
      migration: 'memory_context_pointer_repair_v1',
    };
    const targets = message.context_space_id ? contextTarget.all(
      message.context_space_id,
      message.account_workspace_id,
      message.account_workspace_id,
      message.user_id,
      message.user_id,
      message.agent_instance_id,
      message.agent_instance_id,
    ) : [];
    const recoveredMemoryId = targets.length === 1 ? String(targets[0].id || '') : '';
    updateMessage.run(recoveredMemoryId, recoveredMemoryId ? message.context_space_id : '', JSON.stringify(metadata), message.id);
  }
}

function migrateMemoryContextPointerRepairV1(db) {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE id='memory_context_pointer_repair_v1'").get()) return;
  repairMemoryContextPointersV1(db);
  db.prepare("INSERT INTO schema_migrations(id) VALUES('memory_context_pointer_repair_v1')").run();
}

function migrateMessageMemoryTurnBindingRepairV2(db) {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE id='message_memory_turn_binding_repair_v2'").get()) return;
  const required = [
    'messages', 'memory_documents', 'agent_context_spaces', 'sessions',
    'agent_context_state', 'agent_device_context_state', 'model_executions',
  ];
  if (required.some((table) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))) return;

  const contextMemory = db.prepare(`SELECT memory.id AS memory_id,context.id AS context_id
    FROM agent_context_spaces context
    JOIN memory_documents memory ON memory.id=context.memory_document_id
      AND memory.account_workspace_id=context.account_workspace_id
      AND memory.user_id=context.user_id
      AND memory.user_agent_instance_id=context.user_agent_instance_id
    WHERE context.id=? AND context.context_kind='general_memory'
      AND context.account_workspace_id=?
      AND (?='' OR context.user_agent_instance_id=?)
    ORDER BY memory.id LIMIT 2`);
  const updateMessage = db.prepare('UPDATE messages SET memory_id=?,context_space_id=?,metadata_json=? WHERE id=?');
  const candidates = db.prepare(`SELECT message.* FROM messages message
    WHERE (message.memory_id!='' AND NOT EXISTS (
        SELECT 1 FROM memory_documents memory WHERE memory.id=message.memory_id
      )) OR (message.memory_id='' AND json_valid(message.metadata_json)
        AND json_type(message.metadata_json,'$.databaseRecovery.orphanedMemoryId') IS NOT NULL)
    ORDER BY message.id`).all();
  for (const message of candidates) {
    const targets = message.context_space_id
      ? contextMemory.all(message.context_space_id, message.account_workspace_id || 'workspace_personal',
        message.agent_instance_id || '', message.agent_instance_id || '')
      : [];
    if (targets.length !== 1) continue;
    const metadata = parseMigrationJson(message.metadata_json);
    metadata.databaseRecovery = {
      ...(metadata.databaseRecovery && typeof metadata.databaseRecovery === 'object' ? metadata.databaseRecovery : {}),
      orphanedMemoryId: metadata.databaseRecovery?.orphanedMemoryId || message.memory_id || '',
      repairedMemoryId: targets[0].memory_id,
      migration: 'message_memory_turn_binding_repair_v2',
      reason: 'context_owned_memory_rebind',
    };
    updateMessage.run(targets[0].memory_id, targets[0].context_id, JSON.stringify(metadata), message.id);
  }

  const turnPairs = db.prepare(`SELECT execution.id AS execution_id,
      request.id AS request_id,request.memory_id AS request_memory_id,request.context_space_id AS request_context_id,
      response.id AS response_id,response.memory_id AS response_memory_id,response.context_space_id AS response_context_id,
      request.account_workspace_id,request.agent_instance_id
    FROM model_executions execution
    JOIN messages request ON request.id=execution.request_message_id AND request.role='user'
    JOIN messages response ON response.id=execution.response_message_id AND response.role='assistant'
    WHERE request.memory_id!='' AND request.context_space_id!=''
      AND (response.memory_id!=request.memory_id OR response.context_space_id!=request.context_space_id)
      AND request.account_workspace_id=response.account_workspace_id
      AND request.agent_instance_id=response.agent_instance_id
    ORDER BY execution.id`).all();
  for (const pair of turnPairs) {
    const target = contextMemory.all(pair.request_context_id, pair.account_workspace_id || 'workspace_personal',
      pair.agent_instance_id || '', pair.agent_instance_id || '');
    if (target.length !== 1 || target[0].memory_id !== pair.request_memory_id) continue;
    const response = db.prepare('SELECT metadata_json FROM messages WHERE id=?').get(pair.response_id);
    const metadata = parseMigrationJson(response?.metadata_json);
    metadata.databaseRecovery = {
      ...(metadata.databaseRecovery && typeof metadata.databaseRecovery === 'object' ? metadata.databaseRecovery : {}),
      previousMemoryId: pair.response_memory_id || '',
      previousContextSpaceId: pair.response_context_id || '',
      sourceRequestMessageId: pair.request_id,
      modelExecutionId: pair.execution_id,
      migration: 'message_memory_turn_binding_repair_v2',
      reason: 'turn_local_memory_binding',
    };
    updateMessage.run(pair.request_memory_id, pair.request_context_id, JSON.stringify(metadata), pair.response_id);
  }

  const primaryGroups = db.prepare(`SELECT user_id,account_workspace_id,agent_instance_id,MIN(id) AS primary_id,COUNT(*) AS count
    FROM sessions WHERE agent_instance_id!='' AND conversation_role='primary' AND write_state='writable' AND status!='deleted'
    GROUP BY user_id,account_workspace_id,agent_instance_id HAVING COUNT(*)=1`).all();
  for (const group of primaryGroups) {
    db.prepare(`UPDATE sessions SET superseded_by_session_id=?
      WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?
        AND conversation_role='history' AND write_state='read_only'
        AND superseded_by_session_id!=?`).run(
      group.primary_id, group.user_id, group.account_workspace_id, group.agent_instance_id, group.primary_id,
    );
    for (const table of ['agent_context_state', 'agent_device_context_state']) {
      db.prepare(`UPDATE ${table} SET primary_session_id=?
        WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?
          AND (primary_session_id='' OR NOT EXISTS (
            SELECT 1 FROM sessions session WHERE session.id=${table}.primary_session_id
              AND session.conversation_role='primary' AND session.write_state='writable' AND session.status!='deleted'
          ))`).run(group.primary_id, group.user_id, group.account_workspace_id, group.agent_instance_id);
    }
  }
  db.prepare("INSERT INTO schema_migrations(id) VALUES('message_memory_turn_binding_repair_v2')").run();
}

function parseMigrationJson(value = '') {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function repairMemoryContextPointersV1(db) {
  const required = ['memory_documents', 'agent_context_spaces', 'messages', 'agent_context_state', 'agent_device_context_state'];
  if (required.some((table) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))) return;
  const generalMemories = db.prepare(`SELECT memory.* FROM memory_documents memory
    WHERE memory.scope='general'
    ORDER BY memory.account_workspace_id,memory.user_agent_instance_id,memory.slot_no,memory.id`).all();
  const contextById = db.prepare('SELECT * FROM agent_context_spaces WHERE id=?');
  const exactContexts = db.prepare(`SELECT * FROM agent_context_spaces
    WHERE account_workspace_id=? AND user_id=? AND user_agent_instance_id=?
      AND context_kind='general_memory' AND memory_document_id=?
    ORDER BY lifecycle_state='active' DESC,updated_at DESC,id LIMIT 2`);
  const insertContext = db.prepare(`INSERT INTO agent_context_spaces(
    id,user_id,account_workspace_id,user_agent_instance_id,context_kind,memory_document_id,
    lifecycle_state,created_at,updated_at
  ) VALUES(?,?,?,?, 'general_memory',?,?,?,?)`);
  for (const memory of generalMemories) {
    const exact = exactContexts.all(
      memory.account_workspace_id, memory.user_id, memory.user_agent_instance_id, memory.id,
    );
    if (exact.length > 1) throw new Error(`memory_context_pointer_repair_v1:ambiguous:${memory.id}`);
    if (exact.length === 1) continue;
    const baseId = `ctx_memory_${memory.id}`;
    let contextId = baseId;
    let suffix = 0;
    while (contextById.get(contextId)) {
      suffix += 1;
      contextId = `${baseId}_${suffix}`;
    }
    insertContext.run(
      contextId,
      memory.user_id,
      memory.account_workspace_id,
      memory.user_agent_instance_id,
      memory.id,
      memory.lifecycle_state === 'archived' ? 'archived' : memory.lifecycle_state === 'active' ? 'active' : 'inactive',
      memory.created_at,
      memory.updated_at,
    );
  }
  const misroutedMessages = db.prepare(`SELECT message.id,message.memory_id,message.account_workspace_id,message.agent_instance_id,
      COALESCE(session.user_id,'') AS user_id,memory.account_workspace_id AS memory_workspace_id,
      memory.user_id AS memory_user_id,memory.user_agent_instance_id AS memory_instance_id
    FROM messages message
    JOIN memory_documents memory ON memory.id=message.memory_id AND memory.scope='general'
    LEFT JOIN sessions session ON session.id=message.session_id
    LEFT JOIN agent_context_spaces context ON context.id=message.context_space_id
    WHERE message.memory_id!='' AND (context.id IS NULL
      OR context.account_workspace_id!=memory.account_workspace_id OR context.user_id!=memory.user_id
      OR context.user_agent_instance_id!=memory.user_agent_instance_id
      OR context.context_kind!='general_memory' OR context.memory_document_id!=memory.id)
    ORDER BY message.id`).all();
  for (const message of misroutedMessages) {
    if (message.account_workspace_id !== message.memory_workspace_id
      || (message.user_id && message.user_id !== message.memory_user_id)
      || (message.agent_instance_id && message.agent_instance_id !== message.memory_instance_id)) {
      throw new Error(`memory_context_pointer_repair_v1:message-memory-identity-conflict:${message.id}`);
    }
    const targets = exactContexts.all(
      message.memory_workspace_id, message.memory_user_id, message.memory_instance_id, message.memory_id,
    );
    if (targets.length !== 1) throw new Error(`memory_context_pointer_repair_v1:message-memory-ambiguous:${message.id}`);
    db.prepare('UPDATE messages SET context_space_id=? WHERE id=?').run(targets[0].id, message.id);
  }
  const candidates = db.prepare(`SELECT memory.* FROM memory_documents memory
    WHERE memory.scope='general' AND NOT EXISTS (
      SELECT 1 FROM agent_context_spaces pointed WHERE pointed.id=memory.context_space_id
        AND pointed.account_workspace_id=memory.account_workspace_id AND pointed.user_id=memory.user_id
        AND pointed.user_agent_instance_id=memory.user_agent_instance_id
        AND pointed.context_kind='general_memory' AND pointed.memory_document_id=memory.id
    ) ORDER BY memory.account_workspace_id,memory.user_agent_instance_id,memory.slot_no,memory.id`).all();
  const replacedContextIds = new Set();
  for (const memory of candidates) {
    const exact = exactContexts.all(
      memory.account_workspace_id, memory.user_id, memory.user_agent_instance_id, memory.id,
    );
    if (exact.length !== 1) throw new Error(`memory_context_pointer_repair_v1:ambiguous:${memory.id}`);
    const canonical = exact[0];
    const previousContextId = String(memory.context_space_id || '');
    const previous = previousContextId
      ? db.prepare(`SELECT * FROM agent_context_spaces WHERE id=? AND account_workspace_id=? AND user_id=?
        AND user_agent_instance_id=? AND context_kind='general_memory'`).get(
        previousContextId, memory.account_workspace_id, memory.user_id, memory.user_agent_instance_id,
      )
      : null;
    if (previous && previous.memory_document_id && previous.memory_document_id !== memory.id) {
      throw new Error(`memory_context_pointer_repair_v1:conflicting-pointer:${memory.id}`);
    }
    if (previous && previous.id !== canonical.id) replacedContextIds.add(previous.id);
    const now = new Date().toISOString();
    db.prepare('UPDATE memory_documents SET context_space_id=?,updated_at=MAX(updated_at,?) WHERE id=?')
      .run(canonical.id, now, memory.id);
    db.prepare(`UPDATE agent_context_spaces SET lifecycle_state=?,updated_at=MAX(updated_at,?) WHERE id=?`).run(
      memory.lifecycle_state === 'active' ? 'active' : 'inactive', now, canonical.id,
    );
    if (!previous || previous.id === canonical.id) continue;
    const conflictingMessages = db.prepare(`SELECT message.id,message.memory_id,message.account_workspace_id,message.agent_instance_id,
      COALESCE(session.user_id,'') AS user_id FROM messages message LEFT JOIN sessions session ON session.id=message.session_id
      WHERE message.context_space_id=? AND message.memory_id!='' AND message.memory_id!=? ORDER BY message.id`).all(previous.id, memory.id);
    for (const message of conflictingMessages) {
      const messageMemory = db.prepare(`SELECT account_workspace_id,user_id,user_agent_instance_id
        FROM memory_documents WHERE id=?`).get(message.memory_id);
      if (!messageMemory) throw new Error(`memory_context_pointer_repair_v1:message-memory-missing:${message.id}`);
      if (message.account_workspace_id !== messageMemory.account_workspace_id
        || (message.user_id && message.user_id !== messageMemory.user_id)
        || (message.agent_instance_id && message.agent_instance_id !== messageMemory.user_agent_instance_id)) {
        throw new Error(`memory_context_pointer_repair_v1:message-memory-identity-conflict:${message.id}`);
      }
      const messageTargets = db.prepare(`SELECT id FROM agent_context_spaces
        WHERE account_workspace_id=? AND user_id=? AND user_agent_instance_id=?
          AND context_kind='general_memory' AND memory_document_id=?
        ORDER BY lifecycle_state='active' DESC,updated_at DESC,id LIMIT 2`).all(
        messageMemory.account_workspace_id, messageMemory.user_id, messageMemory.user_agent_instance_id, message.memory_id,
      );
      if (messageTargets.length !== 1) throw new Error(`memory_context_pointer_repair_v1:message-memory-ambiguous:${message.id}`);
      db.prepare('UPDATE messages SET context_space_id=? WHERE id=?').run(messageTargets[0].id, message.id);
    }
    const blankMessage = db.prepare("SELECT id FROM messages WHERE context_space_id=? AND memory_id='' LIMIT 1").get(previous.id);
    if (blankMessage) {
      const candidateOwners = db.prepare(`SELECT COUNT(*) count FROM memory_documents owner
        WHERE owner.scope='general' AND (owner.id=? OR owner.context_space_id=?) AND EXISTS (
          SELECT 1 FROM agent_context_spaces target WHERE target.account_workspace_id=owner.account_workspace_id
            AND target.user_id=owner.user_id AND target.user_agent_instance_id=owner.user_agent_instance_id
            AND target.context_kind='general_memory' AND target.memory_document_id=owner.id
        )`).get(memory.id, previous.id);
      if (Number(candidateOwners?.count || 0) !== 1) {
        throw new Error(`memory_context_pointer_repair_v1:blank-message-ambiguous:${blankMessage.id}`);
      }
    }
    db.prepare(`UPDATE messages SET context_space_id=?,memory_id=CASE WHEN memory_id='' THEN ? ELSE memory_id END
      WHERE context_space_id=? AND (memory_id='' OR memory_id=?)`).run(canonical.id, memory.id, previous.id, memory.id);
    const accountStates = db.prepare(`SELECT primary_session_id FROM agent_context_state
      WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=? AND active_context_space_id=?
        AND (active_memory_document_id='' OR active_memory_document_id=?)`).all(
      memory.user_id, memory.account_workspace_id, memory.user_agent_instance_id, previous.id, memory.id,
    );
    db.prepare(`UPDATE agent_context_state SET active_context_space_id=?,active_memory_document_id=?,
      base_state_revision=CASE WHEN sync_status='synced' THEN state_revision ELSE base_state_revision END,
      state_revision=state_revision+1,last_command_id='memory_context_pointer_repair_v1',sync_status='pending',updated_at=?
      WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=? AND active_context_space_id=?
        AND (active_memory_document_id='' OR active_memory_document_id=?)`).run(
      canonical.id, memory.id, now, memory.user_id, memory.account_workspace_id,
      memory.user_agent_instance_id, previous.id, memory.id,
    );
    db.prepare(`UPDATE agent_device_context_state SET active_context_space_id=?,active_memory_document_id=?,updated_at=?
      WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=? AND active_context_space_id=?
        AND (active_memory_document_id='' OR active_memory_document_id=?)`).run(
      canonical.id, memory.id, now, memory.user_id, memory.account_workspace_id,
      memory.user_agent_instance_id, previous.id, memory.id,
    );
    for (const state of accountStates) {
      if (state.primary_session_id) db.prepare("UPDATE sessions SET codex_thread_id='',updated_at=MAX(updated_at,?) WHERE id=?")
        .run(now, state.primary_session_id);
    }
    db.prepare("UPDATE agent_context_spaces SET lifecycle_state='inactive',updated_at=MAX(updated_at,?) WHERE id=?")
      .run(now, previous.id);
  }
  const finalizedAt = new Date().toISOString();
  for (const contextId of replacedContextIds) {
    db.prepare("UPDATE agent_context_spaces SET lifecycle_state='inactive',updated_at=MAX(updated_at,?) WHERE id=?")
      .run(finalizedAt, contextId);
  }
  db.prepare(`UPDATE agent_context_spaces SET lifecycle_state='inactive',updated_at=MAX(updated_at,?)
    WHERE context_kind='general_memory' AND memory_document_id='' AND lifecycle_state='active'
      AND NOT EXISTS (SELECT 1 FROM memory_documents pointed WHERE pointed.context_space_id=agent_context_spaces.id)
      AND EXISTS (SELECT 1 FROM memory_documents memory
        WHERE memory.account_workspace_id=agent_context_spaces.account_workspace_id
          AND memory.user_id=agent_context_spaces.user_id
          AND memory.user_agent_instance_id=agent_context_spaces.user_agent_instance_id
          AND memory.scope='general')`).run(finalizedAt);
}

function ensureJanusDatabaseIdentity(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(database_meta)').all().map((row) => String(row.name || '')));
  if (!columns.has('product_namespace')) {
    db.exec("ALTER TABLE database_meta ADD COLUMN product_namespace TEXT NOT NULL DEFAULT 'janus'");
  }
  if (!columns.has('data_generation')) {
    db.exec('ALTER TABLE database_meta ADD COLUMN data_generation INTEGER NOT NULL DEFAULT 1');
  }
  db.prepare("UPDATE database_meta SET product_namespace='janus',data_generation=1 WHERE id='default'").run();
}

function ensureOrganizationMessageResearchSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS organization_research_cache_state (
    organization_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,device_id TEXT NOT NULL,
    cursor INTEGER NOT NULL DEFAULT 0,wrapped_data_key TEXT NOT NULL DEFAULT '',wrapped_lease_token TEXT NOT NULL DEFAULT '',
    lease_id TEXT NOT NULL DEFAULT '',lease_expires_at TEXT NOT NULL DEFAULT '',encrypted_shard_path TEXT NOT NULL DEFAULT '',
    cache_status TEXT NOT NULL DEFAULT 'empty',last_synced_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CHECK(cache_status IN ('empty','ready','locked','destroyed','error'))
  );
  CREATE TABLE IF NOT EXISTS organization_research_contexts (
    id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,user_id TEXT NOT NULL,topic_hash TEXT NOT NULL,
    encrypted_result TEXT NOT NULL DEFAULT '',citation_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',
    CHECK(status IN ('active','expired','locked'))
  );
  CREATE INDEX IF NOT EXISTS idx_organization_research_context_active
    ON organization_research_contexts(organization_id,user_id,status,expires_at);
  CREATE TABLE IF NOT EXISTS organization_research_audit_outbox (
    id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,organization_id TEXT NOT NULL,user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,encrypted_payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT NOT NULL DEFAULT '',
    CHECK(status IN ('pending','sending','completed','failed'))
  );
  CREATE INDEX IF NOT EXISTS idx_organization_research_audit_outbox_due
    ON organization_research_audit_outbox(organization_id,user_id,status,next_attempt_at,created_at);`);
  db.prepare("UPDATE organization_research_contexts SET citation_ids_json='[]' WHERE citation_ids_json<>'[]'").run();
}

function ensureFollowerLocalServiceSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS follower_workspace_state (
    owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,authorization_epoch INTEGER NOT NULL DEFAULT 1,
    disclosure_confirmed INTEGER NOT NULL DEFAULT 1,disclosure_version TEXT NOT NULL DEFAULT 'follower_default_work_sources_v1',provider_snapshot_json TEXT NOT NULL DEFAULT '{}',
    preferences_json TEXT NOT NULL DEFAULT '{}',preference_revision INTEGER NOT NULL DEFAULT 1,preference_hash TEXT NOT NULL DEFAULT '',
    report_sync_enabled INTEGER NOT NULL DEFAULT 1,evolution_enabled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_user_id,account_workspace_id),CHECK(authorization_epoch>=1),CHECK(preference_revision>=1)
  );
  CREATE TABLE IF NOT EXISTS follower_access_grants (
    id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,category TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,
    scope_version INTEGER NOT NULL DEFAULT 1,granted_at TEXT NOT NULL DEFAULT '',revoked_at TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(owner_user_id,account_workspace_id,category),CHECK(enabled IN (0,1)),CHECK(scope_version>=1)
  );
  CREATE TABLE IF NOT EXISTS follower_access_events (
    id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,run_id TEXT NOT NULL DEFAULT '',followup_id TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,operation TEXT NOT NULL,outcome TEXT NOT NULL,source_hash TEXT NOT NULL DEFAULT '',item_count INTEGER NOT NULL DEFAULT 0,
    reason_code TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_follower_access_events_owner ON follower_access_events(owner_user_id,account_workspace_id,created_at);
  CREATE TABLE IF NOT EXISTS follower_schedules (
    id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,kind TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,
    timezone TEXT NOT NULL,frequency TEXT NOT NULL,days_json TEXT NOT NULL DEFAULT '[]',local_time TEXT NOT NULL,missed_run_policy TEXT NOT NULL DEFAULT 'coalesce_once',
    revision INTEGER NOT NULL DEFAULT 1,next_occurrence_at TEXT NOT NULL DEFAULT '',last_run_at TEXT NOT NULL DEFAULT '',last_success_window_end TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(owner_user_id,account_workspace_id,kind),CHECK(enabled IN (0,1)),CHECK(revision>=1)
  );
  CREATE TABLE IF NOT EXISTS follower_runs (
    id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL DEFAULT '',owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,kind TEXT NOT NULL,trigger TEXT NOT NULL,
    client_request_id TEXT NOT NULL DEFAULT '',occurrence_key TEXT NOT NULL DEFAULT '',window_start TEXT NOT NULL,window_end TEXT NOT NULL,timezone TEXT NOT NULL,
    authorization_epoch INTEGER NOT NULL,grant_snapshot_json TEXT NOT NULL DEFAULT '{}',source_inventory_json TEXT NOT NULL DEFAULT '[]',coverage_json TEXT NOT NULL DEFAULT '[]',
    follower_asset_version TEXT NOT NULL,base_skill_version TEXT NOT NULL,cluster_skill_version TEXT NOT NULL DEFAULT '',personal_overlay_version TEXT NOT NULL DEFAULT '',
    effective_skill_hash TEXT NOT NULL DEFAULT '',preference_memory_version TEXT NOT NULL DEFAULT '',preference_memory_hash TEXT NOT NULL DEFAULT '',
    report_contract_version TEXT NOT NULL,privacy_validator_version TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempt INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT NOT NULL DEFAULT '',lease_expires_at TEXT NOT NULL DEFAULT '',lease_generation INTEGER NOT NULL DEFAULT 0,error_code TEXT NOT NULL DEFAULT '',
    error_text TEXT NOT NULL DEFAULT '',report_id TEXT NOT NULL DEFAULT '',origin_device_id TEXT NOT NULL DEFAULT 'local',started_at TEXT NOT NULL DEFAULT '',
    completed_at TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,CHECK(authorization_epoch>=1),CHECK(attempt>=0),CHECK(lease_generation>=0)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_follower_runs_occurrence ON follower_runs(occurrence_key) WHERE occurrence_key<>'';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_follower_runs_manual_request ON follower_runs(owner_user_id,account_workspace_id,kind,client_request_id) WHERE client_request_id<>'';
  CREATE INDEX IF NOT EXISTS idx_follower_runs_due ON follower_runs(status,lease_expires_at,created_at);
  CREATE TABLE IF NOT EXISTS follower_reports (
    id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,kind TEXT NOT NULL,
    window_start TEXT NOT NULL,window_end TEXT NOT NULL,timezone TEXT NOT NULL,report_json TEXT NOT NULL DEFAULT '{}',rendered_body TEXT NOT NULL DEFAULT '',
    sync_body TEXT NOT NULL DEFAULT '',privacy_state TEXT NOT NULL DEFAULT 'pending',privacy_validator_version TEXT NOT NULL,validated_content_hash TEXT NOT NULL DEFAULT '',
    redaction_count INTEGER NOT NULL DEFAULT 0,validation_errors_json TEXT NOT NULL DEFAULT '[]',read_at TEXT NOT NULL DEFAULT '',deleted_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(run_id) REFERENCES follower_runs(id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_follower_reports_inbox ON follower_reports(owner_user_id,account_workspace_id,deleted_at,read_at,created_at);
  CREATE TABLE IF NOT EXISTS follower_report_sources (
    report_id TEXT NOT NULL,ref_id TEXT NOT NULL DEFAULT '',source_kind TEXT NOT NULL,source_id TEXT NOT NULL,source_version TEXT NOT NULL,content_hash TEXT NOT NULL DEFAULT '',
    occurred_at TEXT NOT NULL DEFAULT '',observed_at TEXT NOT NULL,local_reference_json TEXT NOT NULL DEFAULT '{}',availability_state TEXT NOT NULL DEFAULT 'available',
    PRIMARY KEY(report_id,source_kind,source_id,source_version),FOREIGN KEY(report_id) REFERENCES follower_reports(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS follower_followup_threads (
    id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,report_id TEXT NOT NULL,authorization_epoch INTEGER NOT NULL,
    deleted_at TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(report_id) REFERENCES follower_reports(id) ON DELETE RESTRICT
  );
  CREATE TABLE IF NOT EXISTS follower_followup_messages (
    id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,source_refs_json TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,
    FOREIGN KEY(thread_id) REFERENCES follower_followup_threads(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS follower_sync_outbox (
    id TEXT PRIMARY KEY,report_id TEXT NOT NULL,operation TEXT NOT NULL,projection_session_id TEXT NOT NULL DEFAULT '',projection_message_id TEXT NOT NULL DEFAULT '',
    validated_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempt_count INTEGER NOT NULL DEFAULT 0,lease_owner TEXT NOT NULL DEFAULT '',
    lease_expires_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT NOT NULL DEFAULT '',
    UNIQUE(report_id,operation,validated_hash),FOREIGN KEY(report_id) REFERENCES follower_reports(id) ON DELETE RESTRICT
  );
  CREATE TABLE IF NOT EXISTS follower_preference_signals (
    id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,source_version TEXT NOT NULL DEFAULT '',
    signal_kind TEXT NOT NULL,normalized_json TEXT NOT NULL DEFAULT '{}',signal_hash TEXT NOT NULL,lineage_key TEXT NOT NULL,explicit INTEGER NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 1,personal_eligible INTEGER NOT NULL DEFAULT 0,cluster_eligible INTEGER NOT NULL DEFAULT 0,validation_state TEXT NOT NULL DEFAULT 'pending',
    evolution_outbox_id TEXT NOT NULL DEFAULT '',evidence_id TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(owner_user_id,account_workspace_id,lineage_key,signal_hash)
  );
  CREATE TABLE IF NOT EXISTS work_notification_intents (
    id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,category TEXT NOT NULL,correlation_id TEXT NOT NULL,
    episode_revision INTEGER NOT NULL DEFAULT 1,target_type TEXT NOT NULL,target_id TEXT NOT NULL,title_key TEXT NOT NULL,body_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',attempt_count INTEGER NOT NULL DEFAULT 0,lease_owner TEXT NOT NULL DEFAULT '',lease_expires_at TEXT NOT NULL DEFAULT '',
    shown_at TEXT NOT NULL DEFAULT '',suppressed_at TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(owner_user_id,category,correlation_id,episode_revision)
  );`);
}

function ensureFollowerIntegrityHardeningSchema(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(follower_report_sources)').all().map((row) => String(row.name || '')));
  if (!columns.has('ref_id')) db.exec("ALTER TABLE follower_report_sources ADD COLUMN ref_id TEXT NOT NULL DEFAULT ''");
  db.exec(`UPDATE follower_report_sources AS source SET ref_id=COALESCE((
      SELECT json_extract(inventory.value,'$.refId')
      FROM follower_reports report JOIN follower_runs run ON run.id=report.run_id, json_each(run.source_inventory_json) inventory
      WHERE report.id=source.report_id
        AND json_extract(inventory.value,'$.sourceKind')=source.source_kind
        AND json_extract(inventory.value,'$.sourceId')=source.source_id
        AND json_extract(inventory.value,'$.sourceVersion')=source.source_version
      LIMIT 1
    ),'legacy_source_'||substr(lower(hex(source.report_id||':'||source.source_kind||':'||source.source_id||':'||source.source_version)),1,32))
    WHERE ref_id='';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_follower_report_source_ref ON follower_report_sources(report_id,ref_id) WHERE ref_id<>'';
    CREATE TABLE IF NOT EXISTS follower_quarantine_events (
      id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,entity_kind TEXT NOT NULL,
      identity_key TEXT NOT NULL,reason_code TEXT NOT NULL,expected_hash TEXT NOT NULL DEFAULT '',observed_hash TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_follower_quarantine_owner
      ON follower_quarantine_events(owner_user_id,account_workspace_id,created_at);`);
}

function ensureFollowerCloudEvolutionSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS follower_evolution_bindings (
    owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,remote_user_id TEXT NOT NULL DEFAULT '',
    canonical_service_instance_id TEXT NOT NULL DEFAULT '',subject_kind TEXT NOT NULL DEFAULT 'system_service',
    state TEXT NOT NULL DEFAULT 'enable_pending',state_revision INTEGER NOT NULL DEFAULT 1,report_sync_enabled INTEGER NOT NULL DEFAULT 1,
    evolution_enabled INTEGER NOT NULL DEFAULT 0,personal_overlay_version TEXT NOT NULL DEFAULT '',personal_overlay_text TEXT NOT NULL DEFAULT '',
    personal_overlay_hash TEXT NOT NULL DEFAULT '',preference_memory_version TEXT NOT NULL DEFAULT '',
    preference_memory_json TEXT NOT NULL DEFAULT '{}',preference_memory_hash TEXT NOT NULL DEFAULT '',
    cluster_bundle_id TEXT NOT NULL DEFAULT '',cluster_skill_version TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_user_id,account_workspace_id),CHECK(subject_kind='system_service'),CHECK(state_revision>=1),
    CHECK(report_sync_enabled IN (0,1)),CHECK(evolution_enabled IN (0,1))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_follower_evolution_binding_remote
    ON follower_evolution_bindings(canonical_service_instance_id) WHERE canonical_service_instance_id<>'';
  CREATE TABLE IF NOT EXISTS follower_report_projections (
    owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,projection_id TEXT NOT NULL,origin_device_id TEXT NOT NULL DEFAULT '',
    report_kind TEXT NOT NULL,window_start TEXT NOT NULL DEFAULT '',window_end TEXT NOT NULL DEFAULT '',timezone TEXT NOT NULL DEFAULT '',
    projection_json TEXT NOT NULL DEFAULT '{}',sync_body TEXT NOT NULL DEFAULT '',validated_hash TEXT NOT NULL,
    privacy_validator_version TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1,read_at TEXT NOT NULL DEFAULT '',
    deleted_at TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_user_id,account_workspace_id,projection_id),CHECK(revision>=1)
  );
  CREATE INDEX IF NOT EXISTS idx_follower_projection_inbox
    ON follower_report_projections(owner_user_id,account_workspace_id,deleted_at,read_at,updated_at);`);
}

function migrateFollowerDefaultCloudEvolutionV1(db) {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE id='follower_default_cloud_evolution_v1'").get()) return;
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const now = new Date().toISOString();
    db.prepare(`UPDATE follower_workspace_state SET report_sync_enabled=1,
      evolution_enabled=CASE WHEN account_workspace_id='workspace_personal' THEN 1 ELSE 0 END,updated_at=MAX(updated_at,?)`).run(now);
    db.prepare(`INSERT INTO follower_access_grants(
      id,owner_user_id,account_workspace_id,category,enabled,scope_version,granted_at,revoked_at,created_at,updated_at
    ) SELECT 'follower_default_sync_'||lower(hex(owner_user_id||':'||account_workspace_id)),owner_user_id,account_workspace_id,
      'sync_sanitized_reports',1,1,?,'',?,? FROM follower_workspace_state WHERE 1
    ON CONFLICT(owner_user_id,account_workspace_id,category) DO UPDATE SET enabled=1,
      granted_at=CASE WHEN follower_access_grants.enabled=0 THEN excluded.updated_at ELSE follower_access_grants.granted_at END,
      revoked_at='',updated_at=CASE WHEN follower_access_grants.enabled=0 THEN excluded.updated_at ELSE follower_access_grants.updated_at END`).run(now, now, now);
    db.prepare(`UPDATE follower_evolution_bindings SET report_sync_enabled=1,
      evolution_enabled=CASE WHEN account_workspace_id='workspace_personal' THEN 1 ELSE 0 END,
      state=CASE WHEN account_workspace_id='workspace_personal' AND state='disabled' THEN 'enable_pending' ELSE state END,
      state_revision=state_revision+CASE WHEN report_sync_enabled=0 OR (account_workspace_id='workspace_personal' AND evolution_enabled=0) THEN 1 ELSE 0 END,
      updated_at=MAX(updated_at,?)`).run(now);
    db.prepare(`INSERT INTO follower_sync_outbox(id,report_id,operation,validated_hash,status,created_at,updated_at)
      SELECT 'follower_default_sync_'||lower(hex(report.id)),report.id,'upsert',report.validated_content_hash,'pending',?,?
      FROM follower_reports report WHERE report.privacy_state='passed' AND report.validated_content_hash<>'' AND report.deleted_at='' AND 1
      ON CONFLICT(report_id,operation,validated_hash) DO NOTHING`).run(now, now);
    db.prepare("INSERT INTO schema_migrations(id) VALUES('follower_default_cloud_evolution_v1')").run();
    if (ownsTransaction) db.exec('COMMIT');
  } catch (error) {
    if (ownsTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function migrateFollowerDefaultWorkSourcesV1(db) {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE id='follower_default_work_sources_v1'").get()) return;
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const now = new Date().toISOString();
    db.prepare(`UPDATE follower_workspace_state SET authorization_epoch=authorization_epoch+1,
      disclosure_confirmed=1,disclosure_version='follower_default_work_sources_v1',updated_at=MAX(updated_at,?)
      WHERE disclosure_confirmed=0 OR disclosure_version<>'follower_default_work_sources_v1' OR EXISTS (
        SELECT 1 FROM (SELECT 'agent_conversations' category UNION ALL SELECT 'task_activity'
          UNION ALL SELECT 'project_change_metadata' UNION ALL SELECT 'project_file_content') policy
        WHERE NOT EXISTS (SELECT 1 FROM follower_access_grants grant_row
          WHERE grant_row.owner_user_id=follower_workspace_state.owner_user_id
            AND grant_row.account_workspace_id=follower_workspace_state.account_workspace_id
            AND grant_row.category=policy.category AND grant_row.enabled=1)
      )`).run(now);
    const insertGrant = db.prepare(`INSERT INTO follower_access_grants(
      id,owner_user_id,account_workspace_id,category,enabled,scope_version,granted_at,revoked_at,created_at,updated_at
    ) SELECT 'follower_default_source_'||lower(hex(owner_user_id||':'||account_workspace_id||':'||?)),
      owner_user_id,account_workspace_id,?,1,1,?,'',?,? FROM follower_workspace_state WHERE 1
    ON CONFLICT(owner_user_id,account_workspace_id,category) DO UPDATE SET enabled=1,
      scope_version=follower_access_grants.scope_version+CASE WHEN follower_access_grants.enabled=0 THEN 1 ELSE 0 END,
      granted_at=CASE WHEN follower_access_grants.enabled=0 THEN excluded.updated_at ELSE follower_access_grants.granted_at END,
      revoked_at='',updated_at=CASE WHEN follower_access_grants.enabled=0 THEN excluded.updated_at ELSE follower_access_grants.updated_at END`);
    for (const category of ['agent_conversations', 'task_activity', 'project_change_metadata', 'project_file_content']) {
      insertGrant.run(category, category, now, now, now);
    }
    db.prepare("INSERT INTO schema_migrations(id) VALUES('follower_default_work_sources_v1')").run();
    if (ownsTransaction) db.exec('COMMIT');
  } catch (error) {
    if (ownsTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function ensureManagedProviderUsageSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS managed_provider_usage_events (
    id TEXT PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL DEFAULT '',
    account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',provider_scope_id TEXT NOT NULL,
    device_id TEXT NOT NULL DEFAULT 'local',execution_id TEXT NOT NULL DEFAULT '',session_id TEXT NOT NULL DEFAULT '',
    thread_id TEXT NOT NULL DEFAULT '',turn_id TEXT NOT NULL DEFAULT '',agent_id TEXT NOT NULL DEFAULT '',
    agent_instance_id TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',reasoning_effort TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0,cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
    raw_total_tokens INTEGER NOT NULL DEFAULT 0,charged_tokens INTEGER NOT NULL DEFAULT 0,
    usage_source TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'completed',private_assistant INTEGER NOT NULL DEFAULT 0,
    quota_day TEXT NOT NULL,occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_managed_provider_usage_daily
    ON managed_provider_usage_events(user_id,provider_scope_id,quota_day,occurred_at);
  CREATE INDEX IF NOT EXISTS idx_managed_provider_usage_execution
    ON managed_provider_usage_events(execution_id,thread_id,turn_id);
  CREATE INDEX IF NOT EXISTS idx_managed_provider_usage_private
    ON managed_provider_usage_events(user_id,private_assistant,occurred_at);
  CREATE TABLE IF NOT EXISTS managed_provider_thread_cursors (
    user_id TEXT NOT NULL,provider_scope_id TEXT NOT NULL,device_id TEXT NOT NULL DEFAULT 'local',thread_id TEXT NOT NULL,
    last_total_tokens INTEGER NOT NULL DEFAULT 0,last_turn_id TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(user_id,provider_scope_id,device_id,thread_id)
  )`);
}

function ensureRecentWorkReportingSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS work_digest_jobs (
    id TEXT PRIMARY KEY,delegation_id TEXT NOT NULL UNIQUE,owner_user_id TEXT NOT NULL,
    account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',status TEXT NOT NULL DEFAULT 'collecting',
    spec_json TEXT NOT NULL DEFAULT '{}',coverage_json TEXT NOT NULL DEFAULT '{}',expires_at TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,published_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_work_digest_jobs_due ON work_digest_jobs(owner_user_id,status,expires_at);
  CREATE TABLE IF NOT EXISTS work_digest_versions (
    id TEXT PRIMARY KEY,job_id TEXT NOT NULL,revision_no INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'draft',
    body TEXT NOT NULL DEFAULT '',evidence_hash TEXT NOT NULL DEFAULT '',coverage_json TEXT NOT NULL DEFAULT '{}',
    source_kind TEXT NOT NULL DEFAULT 'codex',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,published_at TEXT NOT NULL DEFAULT '',
    UNIQUE(job_id,revision_no),FOREIGN KEY(job_id) REFERENCES work_digest_jobs(id) ON DELETE RESTRICT
  );
  CREATE TABLE IF NOT EXISTS work_digest_evidence_refs (
    id TEXT PRIMARY KEY,version_id TEXT NOT NULL,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,
    source_revision TEXT NOT NULL DEFAULT '',included INTEGER NOT NULL DEFAULT 1,position INTEGER NOT NULL DEFAULT 0,
    evidence_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,
    UNIQUE(version_id,source_kind,source_id,source_revision),
    FOREIGN KEY(version_id) REFERENCES work_digest_versions(id) ON DELETE RESTRICT
  )`);
}

function ensureProfileUpdateOutboxSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS profile_update_outbox (
    user_id TEXT PRIMARY KEY,command_id TEXT NOT NULL UNIQUE,payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'pending',attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),completed_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(user_id) REFERENCES auth_users(id) ON DELETE CASCADE,
    CHECK(status IN ('pending','sending','completed','failed'))
  );
  CREATE INDEX IF NOT EXISTS idx_profile_update_outbox_due
    ON profile_update_outbox(status,next_attempt_at,updated_at)`);
}

function ensureBoundedDeliveryReviewSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_delivery_reviews (
    task_run_id TEXT PRIMARY KEY,account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',owner_user_id TEXT NOT NULL DEFAULT '',
    policy_version TEXT NOT NULL DEFAULT 'delivery_review_policy_v1',state TEXT NOT NULL DEFAULT 'submitted',
    quality_revision_count INTEGER NOT NULL DEFAULT 0,quality_revision_limit INTEGER NOT NULL DEFAULT 2,
    execution_attempt_count INTEGER NOT NULL DEFAULT 0,latest_submission_id TEXT NOT NULL DEFAULT '',
    latest_feedback_json TEXT NOT NULL DEFAULT '{}',last_review_event_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),terminal_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
    CHECK(state IN ('submitted','verifying','revision_requested','reworking','accepted','action_required','revision_exhausted','failed')),
    CHECK(quality_revision_count>=0),CHECK(quality_revision_limit BETWEEN 1 AND 20),
    CHECK(quality_revision_count<=quality_revision_limit),CHECK(execution_attempt_count>=0)
  );
  CREATE INDEX IF NOT EXISTS idx_task_delivery_reviews_state ON task_delivery_reviews(state,updated_at,task_run_id);
  CREATE INDEX IF NOT EXISTS idx_task_delivery_reviews_owner ON task_delivery_reviews(account_workspace_id,owner_user_id,state,updated_at);
  CREATE TABLE IF NOT EXISTS task_delivery_submissions (
    id TEXT PRIMARY KEY,task_run_id TEXT NOT NULL,task_node_id TEXT NOT NULL DEFAULT '',result_version_id TEXT NOT NULL DEFAULT '',
    submission_key TEXT NOT NULL UNIQUE,submission_no INTEGER NOT NULL,body_snapshot TEXT NOT NULL DEFAULT '',
    evidence_json TEXT NOT NULL DEFAULT '{}',artifact_manifest_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,UNIQUE(task_run_id,submission_no),CHECK(submission_no>=1)
  );
  CREATE INDEX IF NOT EXISTS idx_task_delivery_submissions_run ON task_delivery_submissions(task_run_id,submission_no,created_at);
  CREATE TABLE IF NOT EXISTS task_delivery_review_events (
    event_id TEXT PRIMARY KEY,task_run_id TEXT NOT NULL,submission_id TEXT NOT NULL DEFAULT '',event_type TEXT NOT NULL,
    from_state TEXT NOT NULL DEFAULT '',to_state TEXT NOT NULL DEFAULT '',payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,UNIQUE(task_run_id,event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_delivery_review_events_run ON task_delivery_review_events(task_run_id,created_at,event_id);
  CREATE TABLE IF NOT EXISTS task_delivery_review_jobs (
    id TEXT PRIMARY KEY,task_run_id TEXT NOT NULL,submission_id TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',payload_json TEXT NOT NULL DEFAULT '{}',attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,claimed_by TEXT NOT NULL DEFAULT '',claimed_at TEXT NOT NULL DEFAULT '',
    lease_expires_at TEXT NOT NULL DEFAULT '',next_attempt_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),completed_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(submission_id) REFERENCES task_delivery_submissions(id) ON DELETE CASCADE,UNIQUE(submission_id),
    CHECK(status IN ('pending','claimed','retry_wait','completed','action_required','cancelled')),
    CHECK(attempt_count>=0),CHECK(max_attempts BETWEEN 1 AND 10)
  );
  CREATE INDEX IF NOT EXISTS idx_task_delivery_review_jobs_due
    ON task_delivery_review_jobs(status,next_attempt_at,lease_expires_at,created_at)`);
}

function ensureAgentSingleWindowSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_conversation_branch_state (
    user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',agent_instance_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL DEFAULT '',primary_session_id TEXT NOT NULL DEFAULT '',thread_generation INTEGER NOT NULL DEFAULT 1,
    rebuild_required INTEGER NOT NULL DEFAULT 0,last_injected_timeline_sequence INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(user_id,account_workspace_id,agent_instance_id),CHECK(thread_generation>=1),CHECK(rebuild_required IN (0,1)),
    CHECK(last_injected_timeline_sequence>=0)
  );
  CREATE TABLE IF NOT EXISTS agent_conversation_thread_lineage (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',agent_instance_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,source_session_id TEXT NOT NULL DEFAULT '',codex_thread_id TEXT NOT NULL,
    lineage_role TEXT NOT NULL DEFAULT 'merged',reason TEXT NOT NULL DEFAULT 'agent_single_window_merge',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(conversation_id,codex_thread_id),CHECK(lineage_role IN ('winner','merged','replaced'))
  );
  CREATE TABLE IF NOT EXISTS agent_conversation_timeline_refs (
    sequence_no INTEGER PRIMARY KEY AUTOINCREMENT,ref_id TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL,
    account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',agent_instance_id TEXT NOT NULL,source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,source_conversation_id TEXT NOT NULL DEFAULT '',source_message_id TEXT NOT NULL DEFAULT '',
    occurred_at TEXT NOT NULL DEFAULT '',metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(agent_instance_id,source_kind,source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_conversation_branch_conversation ON agent_conversation_branch_state(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_agent_conversation_timeline_agent_order
    ON agent_conversation_timeline_refs(user_id,agent_instance_id,occurred_at,sequence_no);
  CREATE INDEX IF NOT EXISTS idx_agent_conversation_timeline_workspace_sequence
    ON agent_conversation_timeline_refs(user_id,account_workspace_id,agent_instance_id,sequence_no)`);
}

function repairAgentConversationBranchConsistency(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_conversation_branch_state'").get()) return 0;
  const candidates = db.prepare(`SELECT session.id AS primary_session_id,session.conversation_id,
      session.user_id,session.account_workspace_id,session.agent_instance_id
    FROM sessions session
    JOIN user_agent_instances instance ON instance.id=session.agent_instance_id AND instance.user_id=session.user_id
    JOIN conversations conversation ON conversation.id=session.conversation_id
    WHERE session.agent_instance_id!='' AND session.conversation_role='primary'
      AND session.write_state='writable' AND session.status!='deleted'
      AND conversation.owner_user_id=session.user_id
      AND conversation.account_workspace_id=session.account_workspace_id
      AND conversation.agent_instance_id=session.agent_instance_id
      AND conversation.conversation_kind='direct'
    ORDER BY session.user_id,session.account_workspace_id,session.agent_instance_id,
      session.updated_at DESC,session.created_at DESC,session.id DESC`).all();
  const byBranch = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.user_id}\u001f${candidate.account_workspace_id}\u001f${candidate.agent_instance_id}`;
    byBranch.set(key, [...(byBranch.get(key) || []), candidate]);
  }
  const update = db.prepare(`UPDATE agent_conversation_branch_state SET
    conversation_id=?,primary_session_id=?,thread_generation=thread_generation+1,rebuild_required=1,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?
      AND (conversation_id!=? OR primary_session_id!=?)`);
  let repaired = 0;
  for (const branch of db.prepare(`SELECT user_id,account_workspace_id,agent_instance_id
    FROM agent_conversation_branch_state`).all()) {
    const key = `${branch.user_id}\u001f${branch.account_workspace_id}\u001f${branch.agent_instance_id}`;
    const matches = byBranch.get(key) || [];
    if (matches.length !== 1) continue;
    const candidate = matches[0];
    repaired += Number(update.run(
      candidate.conversation_id, candidate.primary_session_id,
      branch.user_id, branch.account_workspace_id, branch.agent_instance_id,
      candidate.conversation_id, candidate.primary_session_id,
    ).changes || 0);
  }
  return repaired;
}

function migrateAgentSingleWindowContinuity(db) {
  ensureAgentSingleWindowSchema(db);
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE id='agent_single_window_continuity_v1'").get()) return;
  db.exec('DROP INDEX IF EXISTS idx_sessions_one_primary_agent');
  const canonicalAliases = flattenAgentInstanceAliasGraph(db);
  canonicalizeAgentConversationAliasReferences(db, canonicalAliases);
  normalizeNonDirectWritableSessionRoles(db);
  const sessionRows = db.prepare(`SELECT s.*,COALESCE(c.conversation_kind,'direct') AS resolved_conversation_kind
    FROM sessions s LEFT JOIN conversations c ON c.id=COALESCE(NULLIF(s.conversation_id,''),s.id)
    WHERE s.agent_instance_id!='' AND s.status!='deleted'
      AND COALESCE(c.conversation_kind,'direct')='direct'
      AND s.department_id NOT IN ('agent_delegation','collaboration')
    ORDER BY s.user_id,s.account_workspace_id,s.agent_instance_id,s.updated_at DESC,s.created_at DESC,s.id DESC`).all();
  const referenced = new Set();
  for (const table of ['agent_context_state', 'agent_device_context_state']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    for (const row of db.prepare(`SELECT primary_session_id FROM ${table} WHERE primary_session_id!=''`).all()) {
      referenced.add(String(row.primary_session_id || ''));
    }
  }
  const groups = new Map();
  for (const row of sessionRows) {
    const key = `${row.user_id}\u001f${row.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID}\u001f${row.agent_instance_id}`;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const upsertAlias = db.prepare(`INSERT INTO conversation_aliases(alias_id,conversation_id,alias_kind,reason)
    VALUES(?,?,'agent_single_window','agent_single_window_continuity_v1') ON CONFLICT(alias_id) DO UPDATE SET
    conversation_id=excluded.conversation_id,alias_kind=excluded.alias_kind,reason=excluded.reason`);
  const upsertBranch = db.prepare(`INSERT INTO agent_conversation_branch_state(
    user_id,account_workspace_id,agent_instance_id,conversation_id,primary_session_id,thread_generation,rebuild_required,updated_at
  ) VALUES(?,?,?,?,?,1,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(user_id,account_workspace_id,agent_instance_id) DO UPDATE SET
    conversation_id=excluded.conversation_id,primary_session_id=excluded.primary_session_id,
    thread_generation=agent_conversation_branch_state.thread_generation+CASE WHEN excluded.rebuild_required=1 THEN 1 ELSE 0 END,
    rebuild_required=MAX(agent_conversation_branch_state.rebuild_required,excluded.rebuild_required),updated_at=excluded.updated_at`);
  const archiveThread = db.prepare(`INSERT INTO agent_conversation_thread_lineage(
    id,user_id,account_workspace_id,agent_instance_id,conversation_id,source_session_id,codex_thread_id,lineage_role,reason
  ) VALUES(?,?,?,?,?,?,?,?,'agent_single_window_continuity_v1') ON CONFLICT(conversation_id,codex_thread_id) DO UPDATE SET
    source_session_id=excluded.source_session_id,lineage_role=excluded.lineage_role,reason=excluded.reason`);
  for (const group of groups.values()) {
    group.sort((left, right) => {
      const referenceDelta = Number(referenced.has(right.id)) - Number(referenced.has(left.id));
      if (referenceDelta) return referenceDelta;
      const activeDelta = Number(right.status === 'active') - Number(left.status === 'active');
      if (activeDelta) return activeDelta;
      const writableDelta = Number(right.write_state === 'writable') - Number(left.write_state === 'writable');
      if (writableDelta) return writableDelta;
      return String(right.updated_at || '').localeCompare(String(left.updated_at || ''))
        || String(right.created_at || '').localeCompare(String(left.created_at || ''))
        || String(right.id || '').localeCompare(String(left.id || ''));
    });
    const winner = group[0];
    const workspaceId = winner.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID;
    const canonicalConversationId = String(winner.conversation_id || winner.id);
    db.prepare(`INSERT INTO conversations(
      id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,project_id,workspace_root,status,created_at,updated_at
    ) VALUES(?,?,'direct',?,?,?,?,?,?,'active',?,?) ON CONFLICT(id) DO UPDATE SET
      account_workspace_id=excluded.account_workspace_id,conversation_kind='direct',owner_user_id=excluded.owner_user_id,
      agent_id=excluded.agent_id,agent_instance_id=excluded.agent_instance_id,status='active',updated_at=MAX(conversations.updated_at,excluded.updated_at)`).run(
      canonicalConversationId, workspaceId, winner.user_id, winner.title || 'Untitled', winner.agent_id || '', winner.agent_instance_id,
      winner.project_id || '', winner.workspace_root || '', winner.created_at || '', winner.updated_at || winner.created_at || '',
    );
    let requiresRebuild = group.length > 1;
    for (const [index, row] of group.entries()) {
      const oldConversationId = String(row.conversation_id || row.id);
      if (row.codex_thread_id) {
        archiveThread.run(
          `thread_lineage:${row.id}:${row.codex_thread_id}`, row.user_id, workspaceId, row.agent_instance_id,
          canonicalConversationId, row.id, row.codex_thread_id, index === 0 ? 'winner' : 'merged',
        );
        requiresRebuild = true;
      }
      if (oldConversationId !== canonicalConversationId) {
        db.prepare('UPDATE messages SET conversation_id=? WHERE conversation_id=? OR session_id=?').run(
          canonicalConversationId, oldConversationId, row.id,
        );
        db.prepare('UPDATE message_attachments SET conversation_id=? WHERE conversation_id=?').run(canonicalConversationId, oldConversationId);
        db.prepare('UPDATE model_executions SET conversation_id=? WHERE conversation_id=?').run(canonicalConversationId, oldConversationId);
        upsertAlias.run(oldConversationId, canonicalConversationId);
        db.prepare("UPDATE conversations SET status='deleted',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run(oldConversationId);
      }
      if (row.id !== canonicalConversationId) upsertAlias.run(row.id, canonicalConversationId);
      db.prepare(`UPDATE sessions SET conversation_id=?,conversation_role=?,write_state=?,superseded_by_session_id=?,codex_thread_id='',updated_at=MAX(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        WHERE id=?`).run(
        canonicalConversationId, index === 0 ? 'primary' : 'history', index === 0 ? 'writable' : 'read_only',
        index === 0 ? '' : winner.id, row.id,
      );
    }
    for (const table of ['agent_context_state', 'agent_device_context_state']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      db.prepare(`UPDATE ${table} SET primary_session_id=? WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`)
        .run(winner.id, winner.user_id, workspaceId, winner.agent_instance_id);
    }
    upsertBranch.run(winner.user_id, workspaceId, winner.agent_instance_id, canonicalConversationId, winner.id, requiresRebuild ? 1 : 0);
    db.prepare(`INSERT INTO agent_conversation_timeline_refs(
      ref_id,user_id,account_workspace_id,agent_instance_id,source_kind,source_id,source_conversation_id,source_message_id,occurred_at,metadata_json
    ) SELECT 'direct:'||m.id,s.user_id,s.account_workspace_id,s.agent_instance_id,'direct',m.id,?,m.id,m.created_at,
      json_object('sourceSessionId',m.session_id,'role',m.role)
      FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.conversation_id=? AND m.visible=1
      ON CONFLICT(agent_instance_id,source_kind,source_id) DO UPDATE SET
      source_conversation_id=excluded.source_conversation_id,source_message_id=excluded.source_message_id,
      account_workspace_id=excluded.account_workspace_id,occurred_at=excluded.occurred_at,metadata_json=excluded.metadata_json`).run(
      canonicalConversationId, canonicalConversationId,
    );
  }
  repairPrimaryAgentSessionUniqueness(db);
  db.exec(`CREATE UNIQUE INDEX idx_sessions_one_primary_agent ON sessions(user_id,account_workspace_id,agent_instance_id)
    WHERE agent_instance_id!='' AND conversation_role='primary' AND write_state='writable' AND status!='deleted'`);
  db.prepare("INSERT INTO schema_migrations(id) VALUES('agent_single_window_continuity_v1')").run();
}

function migrateAgentInstanceAliasCycleRepairV2(db) {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE id='agent_instance_alias_cycle_repair_v2'").get()) return;
  if (!agentInstanceAliasCycleCount(db)) {
    db.prepare("INSERT INTO schema_migrations(id) VALUES('agent_instance_alias_cycle_repair_v2')").run();
    return;
  }
  db.prepare("DELETE FROM schema_migrations WHERE id='agent_single_window_continuity_v1'").run();
  migrateAgentSingleWindowContinuity(db);
  db.prepare("INSERT INTO schema_migrations(id) VALUES('agent_instance_alias_cycle_repair_v2')").run();
}

const AGENT_IDENTITY_TRIGGER_NAMES = Object.freeze([
  'trg_sessions_agent_identity_insert', 'trg_sessions_agent_identity_update',
  'trg_messages_agent_identity_insert', 'trg_messages_agent_identity_update',
  'trg_agent_context_spaces_identity_insert', 'trg_agent_context_spaces_identity_update',
  'trg_agent_device_context_state_identity_insert', 'trg_agent_device_context_state_identity_update',
  'trg_agent_context_state_identity_insert', 'trg_agent_context_state_identity_update',
]);

function migrateAgentAliasContextStateRepairV4(db) {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE id='agent_alias_context_state_repair_v4'").get()) return;
  let stage = 'projection';
  let objectId = '';
  const triggerSql = AGENT_IDENTITY_TRIGGER_NAMES.map((name) => db.prepare(
    "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name=?",
  ).get(name)).filter((row) => row?.sql);
  let triggersDropped = false;
  try {
    const projection = projectAgentAliasContextStateRepairV4(db);
    if (!projection.hasCycles) {
      db.prepare("INSERT INTO schema_migrations(id) VALUES('agent_alias_context_state_repair_v4')").run();
      return;
    }
    stage = 'trigger_suspend';
    db.exec(AGENT_IDENTITY_TRIGGER_NAMES.map((name) => `DROP TRIGGER IF EXISTS ${name};`).join('\n'));
    triggersDropped = true;
    stage = 'agent_alias';
    db.exec('DROP INDEX IF EXISTS idx_sessions_one_primary_agent');
    const mappings = flattenAgentInstanceAliasGraph(db);
    stage = 'session_memory_context_message_state';
    canonicalizeAgentConversationAliasReferences(db, mappings);
    repairPrimaryAgentSessionUniqueness(db);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_primary_agent ON sessions(user_id,account_workspace_id,agent_instance_id)
      WHERE agent_instance_id!='' AND conversation_role='primary' AND write_state='writable' AND status!='deleted'`);
    stage = 'validation';
    objectId = assertAgentAliasContextStateRepairV4Invariants(db);
    stage = 'trigger_restore';
    restoreAgentIdentityTriggers(db, triggerSql);
    triggersDropped = false;
    db.prepare("INSERT INTO schema_migrations(id) VALUES('agent_alias_context_state_repair_v4')").run();
  } catch (error) {
    if (triggersDropped) {
      try { restoreAgentIdentityTriggers(db, triggerSql); } catch {}
    }
    const detail = objectId ? `:${objectId}` : '';
    throw new Error(`agent_alias_context_state_repair_v4:${stage}${detail}: ${error?.message || error}`);
  }
}

function restoreAgentIdentityTriggers(db, triggerSql = []) {
  for (const row of triggerSql) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(row.name)) db.exec(row.sql);
  }
}

function projectAgentAliasContextStateRepairV4(db) {
  if (!migrationTableHasColumn(db, 'user_agent_instance_aliases', 'canonical_instance_id')
    || !migrationTableHasColumn(db, 'user_agent_instances', 'agent_family_id')) return { hasCycles: false };
  const aliasRows = db.prepare('SELECT alias_instance_id,canonical_instance_id,user_id FROM user_agent_instance_aliases').all();
  const aliases = new Map(aliasRows.map((row) => [String(row.alias_instance_id || ''), { ...row }]));
  const instanceColumns = new Set(db.prepare('PRAGMA table_info(user_agent_instances)').all().map((row) => String(row.name || '')));
  const projectedColumn = (column, fallback) => instanceColumns.has(column) ? column : `${fallback} AS ${column}`;
  const instances = new Map(db.prepare(`SELECT id,user_id,agent_family_id,
    ${projectedColumn('employment_state', "'active'")},${projectedColumn('authority_state', "'local_confirmed'")},
    ${projectedColumn('state_revision', '0')},${projectedColumn('created_at', "''")}
    FROM user_agent_instances`).all().map((row) => [String(row.id || ''), { ...row }]));
  const resolved = new Map();
  const cycles = new Map();
  const chooseWinner = (ids) => {
    const candidates = ids.map((id) => instances.get(id)).filter(Boolean);
    if (!candidates.length) throw new Error(`Agent alias cycle has no live canonical instance: ${ids.join(',')}`);
    const aliasUsers = new Set(ids.map((id) => aliases.get(id)?.user_id).filter(Boolean));
    const users = new Set(candidates.map((item) => item.user_id));
    const families = new Set(candidates.map((item) => item.agent_family_id));
    if (users.size !== 1 || families.size !== 1 || aliasUsers.size !== 1 || !aliasUsers.has(candidates[0].user_id)) {
      throw new Error(`Agent alias cycle crosses user or Agent family boundaries: ${ids.join(',')}`);
    }
    candidates.sort(compareProjectedCanonicalAgents);
    return String(candidates[0].id || '');
  };
  const resolve = (startId) => {
    if (resolved.has(startId)) return resolved.get(startId);
    const order = [];
    const positions = new Map();
    let current = startId;
    let terminal = '';
    while (aliases.has(current)) {
      if (positions.has(current)) {
        const ids = order.slice(positions.get(current));
        const cycleKey = [...ids].sort().join('\u001f');
        const winner = cycles.get(cycleKey)?.winner || chooseWinner(ids);
        cycles.set(cycleKey, { ids, winner });
        for (const id of ids) resolved.set(id, winner);
        terminal = winner;
        break;
      }
      positions.set(current, order.length);
      order.push(current);
      const next = String(aliases.get(current)?.canonical_instance_id || '');
      if (!next || next === current) {
        terminal = next || current;
        break;
      }
      current = next;
      if (resolved.has(current)) {
        terminal = resolved.get(current);
        break;
      }
    }
    if (!terminal) terminal = current;
    if (!instances.has(terminal)) throw new Error(`Agent instance alias target is missing: ${startId}->${terminal}`);
    for (const id of order) resolved.set(id, terminal);
    return terminal;
  };
  for (const alias of aliasRows) resolve(String(alias.alias_instance_id || ''));
  for (const [aliasId, canonicalId] of resolved) {
    if (aliasId === canonicalId) continue;
    const alias = aliases.get(aliasId);
    const source = instances.get(aliasId);
    const canonical = instances.get(canonicalId);
    if (!canonical || (alias?.user_id && alias.user_id !== canonical.user_id)
      || (source && (source.user_id !== canonical.user_id || source.agent_family_id !== canonical.agent_family_id))) {
      throw new Error(`Agent instance alias crosses user or Agent family boundaries: ${aliasId}->${canonicalId}`);
    }
  }
  if (!cycles.size) return { hasCycles: false };
  const canonicalFor = (id) => resolved.get(String(id || '')) || String(id || '');
  const sessionProjection = projectCanonicalRecordMap(db, 'sessions', (row) => [
    row.user_id, row.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID, canonicalFor(row.agent_instance_id),
    row.conversation_role === 'primary' && row.write_state === 'writable' && row.status !== 'deleted' ? 'primary' : row.id,
  ], (left, right) => compareProjectedSessionWinners(db, left, right, canonicalFor));
  const memoryProjection = projectCanonicalRecordMap(db, 'memory_documents', (row) => [
    row.user_id, row.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID, canonicalFor(row.user_agent_instance_id),
    row.scope, row.slot_no, row.task_run_id, row.project_id, row.relationship_id,
  ], (left, right) => compareProjectedOwnedRecords(left, right, canonicalFor, 'user_agent_instance_id'));
  const memoryFor = (id) => memoryProjection.get(String(id || '')) || String(id || '');
  const contextProjection = projectCanonicalRecordMap(db, 'agent_context_spaces', (row) => [
    row.user_id, row.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID, canonicalFor(row.user_agent_instance_id),
    row.context_kind, memoryFor(row.memory_document_id), row.project_id, row.task_run_id, row.delegation_id,
    row.group_id, row.relationship_user_id, row.legacy_session_id,
  ], (left, right) => compareProjectedOwnedRecords(left, right, canonicalFor, 'user_agent_instance_id'));
  const contextFor = (id) => contextProjection.get(String(id || '')) || String(id || '');
  const sessionFor = (id) => sessionProjection.get(String(id || '')) || String(id || '');
  validateProjectedMessages(db, { canonicalFor, contextFor });
  validateProjectedContextStates(db, { canonicalFor, sessionFor, memoryFor, contextFor });
  return { hasCycles: true, resolved, sessionProjection, memoryProjection, contextProjection };
}

function compareProjectedCanonicalAgents(left, right) {
  return Number(right.authority_state === 'cloud_confirmed') - Number(left.authority_state === 'cloud_confirmed')
    || Number(right.employment_state === 'active') - Number(left.employment_state === 'active')
    || Number(right.state_revision || 0) - Number(left.state_revision || 0)
    || String(left.created_at || '').localeCompare(String(right.created_at || ''))
    || String(left.id || '').localeCompare(String(right.id || ''));
}

function projectCanonicalRecordMap(db, table, keyFor, compare) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return new Map();
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row).map((value) => String(value ?? '')).join('\u001f');
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const result = new Map();
  for (const group of groups.values()) {
    group.sort(compare);
    const winnerId = String(group[0]?.id || '');
    for (const row of group) if (row.id && winnerId) result.set(String(row.id), winnerId);
  }
  return result;
}

function compareProjectedOwnedRecords(left, right, canonicalFor, agentColumn) {
  const leftCanonical = canonicalFor(left[agentColumn]);
  const rightCanonical = canonicalFor(right[agentColumn]);
  return Number(right[agentColumn] === rightCanonical) - Number(left[agentColumn] === leftCanonical)
    || Number(right.lifecycle_state === 'active') - Number(left.lifecycle_state === 'active')
    || String(right.updated_at || '').localeCompare(String(left.updated_at || ''))
    || String(left.created_at || '').localeCompare(String(right.created_at || ''))
    || String(left.id || '').localeCompare(String(right.id || ''));
}

function compareProjectedSessionWinners(db, left, right, canonicalFor) {
  const referenced = (id) => ['agent_context_state', 'agent_device_context_state'].some((table) => (
    migrationTableHasColumn(db, table, 'primary_session_id')
      && db.prepare(`SELECT 1 FROM ${table} WHERE primary_session_id=? LIMIT 1`).get(id)
  ));
  return Number(referenced(right.id)) - Number(referenced(left.id))
    || Number(right.status === 'active') - Number(left.status === 'active')
    || String(right.updated_at || '').localeCompare(String(left.updated_at || ''))
    || String(right.created_at || '').localeCompare(String(left.created_at || ''))
    || String(right.id || '').localeCompare(String(left.id || ''))
    || String(canonicalFor(left.agent_instance_id)).localeCompare(String(canonicalFor(right.agent_instance_id)));
}

function validateProjectedMessages(db, { canonicalFor, contextFor }) {
  if (!migrationTableHasColumn(db, 'messages', 'context_space_id')
    || !migrationTableHasColumn(db, 'agent_context_spaces', 'user_agent_instance_id')) return;
  const contexts = new Map(db.prepare('SELECT * FROM agent_context_spaces').all().map((row) => [String(row.id || ''), row]));
  for (const message of db.prepare("SELECT id,account_workspace_id,agent_instance_id,context_space_id FROM messages WHERE context_space_id!=''").all()) {
    const source = contexts.get(String(message.context_space_id || ''));
    const target = contexts.get(contextFor(message.context_space_id));
    if (!source || !target || String(target.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID)
      !== String(message.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID)
      || (message.agent_instance_id && canonicalFor(message.agent_instance_id) !== canonicalFor(target.user_agent_instance_id))) {
      throw new Error(`message_context_agent_mismatch:${message.id}`);
    }
  }
}

function validateProjectedContextStates(db, projection) {
  const sessions = migrationTableHasColumn(db, 'sessions', 'agent_instance_id')
    ? new Map(db.prepare('SELECT id,user_id,account_workspace_id,agent_instance_id FROM sessions').all().map((row) => [String(row.id || ''), row])) : new Map();
  const memories = migrationTableHasColumn(db, 'memory_documents', 'user_agent_instance_id')
    ? new Map(db.prepare('SELECT id,user_id,account_workspace_id,user_agent_instance_id FROM memory_documents').all().map((row) => [String(row.id || ''), row])) : new Map();
  const contexts = migrationTableHasColumn(db, 'agent_context_spaces', 'user_agent_instance_id')
    ? new Map(db.prepare('SELECT id,user_id,account_workspace_id,user_agent_instance_id FROM agent_context_spaces').all().map((row) => [String(row.id || ''), row])) : new Map();
  for (const table of ['agent_context_state', 'agent_device_context_state']) {
    if (!migrationTableHasColumn(db, table, 'active_memory_document_id')) continue;
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
      const targetAgent = projection.canonicalFor(row.user_agent_instance_id);
      validateProjectedStateReference(row, sessions.get(projection.sessionFor(row.primary_session_id)), targetAgent, 'session', projection.canonicalFor);
      validateProjectedStateReference(row, contexts.get(projection.contextFor(row.active_context_space_id)), targetAgent, 'context', projection.canonicalFor);
      validateProjectedStateReference(row, memories.get(projection.memoryFor(row.active_memory_document_id)), targetAgent, 'memory', projection.canonicalFor);
    }
  }
}

function validateProjectedStateReference(state, target, targetAgent, kind, canonicalFor) {
  const sourceId = kind === 'session' ? state.primary_session_id
    : kind === 'context' ? state.active_context_space_id : state.active_memory_document_id;
  if (!sourceId) return;
  const ownerAgent = kind === 'session' ? target?.agent_instance_id : target?.user_agent_instance_id;
  if (!target || String(target.user_id || '') !== String(state.user_id || '')
    || String(target.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID) !== String(state.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID)
    || String(canonicalFor(ownerAgent) || '') !== String(targetAgent || '')) {
    throw new Error(`${kind}_context_state_agent_mismatch:${sourceId}`);
  }
}

function assertAgentAliasContextStateRepairV4Invariants(db) {
  if (agentInstanceAliasCycleCount(db)) throw new Error('agent_alias_cycle');
  const checks = [
    ['session_agent_identity_mismatch', `SELECT s.id FROM sessions s LEFT JOIN user_agent_instances i
      ON i.id=s.agent_instance_id AND i.user_id=s.user_id WHERE s.agent_instance_id!=''
      AND (i.id IS NULL OR (s.agent_id!='' AND s.agent_id!=i.agent_family_id)) LIMIT 1`],
    ['message_session_agent_mismatch', `SELECT m.id FROM messages m JOIN sessions s ON s.id=m.session_id
      WHERE s.agent_instance_id!='' AND m.agent_instance_id!=s.agent_instance_id LIMIT 1`],
    ['message_context_agent_mismatch', `SELECT m.id FROM messages m JOIN agent_context_spaces c ON c.id=m.context_space_id
      WHERE m.context_space_id!='' AND m.agent_instance_id!='' AND (c.user_agent_instance_id!=m.agent_instance_id
        OR c.account_workspace_id!=m.account_workspace_id) LIMIT 1`],
    ['context_memory_agent_mismatch', `SELECT c.id FROM agent_context_spaces c JOIN memory_documents d ON d.id=c.memory_document_id
      WHERE c.memory_document_id!='' AND (c.user_id!=d.user_id OR c.account_workspace_id!=d.account_workspace_id
        OR c.user_agent_instance_id!=d.user_agent_instance_id) LIMIT 1`],
  ];
  for (const table of ['agent_context_state', 'agent_device_context_state']) {
    checks.push([`${table}_session_agent_mismatch`, `SELECT state.rowid id FROM ${table} state JOIN sessions s ON s.id=state.primary_session_id
      WHERE state.primary_session_id!='' AND (state.user_id!=s.user_id OR state.account_workspace_id!=s.account_workspace_id
        OR state.user_agent_instance_id!=s.agent_instance_id) LIMIT 1`]);
    checks.push([`${table}_context_agent_mismatch`, `SELECT state.rowid id FROM ${table} state JOIN agent_context_spaces c ON c.id=state.active_context_space_id
      WHERE state.active_context_space_id!='' AND (state.user_id!=c.user_id OR state.account_workspace_id!=c.account_workspace_id
        OR state.user_agent_instance_id!=c.user_agent_instance_id) LIMIT 1`]);
    checks.push([`${table}_memory_agent_mismatch`, `SELECT state.rowid id FROM ${table} state JOIN memory_documents d ON d.id=state.active_memory_document_id
      WHERE state.active_memory_document_id!='' AND (state.user_id!=d.user_id OR state.account_workspace_id!=d.account_workspace_id
        OR state.user_agent_instance_id!=d.user_agent_instance_id) LIMIT 1`]);
  }
  for (const [rule, sql] of checks) {
    const failure = db.prepare(sql).get();
    if (failure) throw new Error(`${rule}:${failure.id || failure.rowid || 'unknown'}`);
  }
  return '';
}

function migrateAgentAliasContextReferenceRepairV3(db) {
  db.exec('DROP INDEX IF EXISTS idx_sessions_one_primary_agent');
  const mappings = flattenAgentInstanceAliasGraph(db);
  canonicalizeAgentConversationAliasReferences(db, mappings);
  repairPrimaryAgentSessionUniqueness(db);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_primary_agent ON sessions(user_id,account_workspace_id,agent_instance_id)
    WHERE agent_instance_id!='' AND conversation_role='primary' AND write_state='writable' AND status!='deleted'`);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('agent_alias_context_reference_repair_v3')").run();
}

function agentInstanceAliasCycleCount(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_agent_instance_aliases'").get()) return 0;
  return Number(db.prepare(`WITH RECURSIVE walk(start_id,current_id,path,depth,cycle) AS (
    SELECT alias_instance_id,canonical_instance_id,'|'||alias_instance_id||'|',1,
      CASE WHEN canonical_instance_id=alias_instance_id THEN 1 ELSE 0 END FROM user_agent_instance_aliases
    UNION ALL
    SELECT walk.start_id,alias.canonical_instance_id,walk.path||walk.current_id||'|',walk.depth+1,
      CASE WHEN instr(walk.path,'|'||alias.canonical_instance_id||'|')>0 THEN 1 ELSE 0 END
    FROM walk JOIN user_agent_instance_aliases alias ON alias.alias_instance_id=walk.current_id
    WHERE walk.cycle=0 AND walk.depth<128
  ) SELECT COUNT(DISTINCT start_id) count FROM walk WHERE cycle=1`).get()?.count || 0);
}

function migrationTableHasColumn(db, table, column) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return false;
  return db.prepare(`PRAGMA table_info("${String(table).replaceAll('"', '""')}")`).all().some((row) => row.name === column);
}

export function resequenceMemoryDocumentVersions(db, memoryDocumentId) {
  const versions = db.prepare(`SELECT id FROM memory_document_versions
    WHERE memory_document_id=? ORDER BY created_at,id`).all(memoryDocumentId);
  if (!versions.length) return 0;
  const minimumVersion = Number(db.prepare(`SELECT MIN(version_no) AS value FROM memory_document_versions
    WHERE memory_document_id=?`).get(memoryDocumentId)?.value || 0);
  let temporaryVersion = Math.min(-1, minimumVersion - 1);
  const updateVersion = db.prepare('UPDATE memory_document_versions SET version_no=? WHERE id=?');
  for (const version of versions) {
    updateVersion.run(temporaryVersion, version.id);
    temporaryVersion -= 1;
  }
  versions.forEach((version, index) => updateVersion.run(index + 1, version.id));
  return versions.length;
}

function mergeAgentAliasCycleMemory(db, source, canonical) {
  if (!migrationTableHasColumn(db, 'memory_documents', 'user_agent_instance_id')) return;
  const documents = db.prepare('SELECT * FROM memory_documents WHERE user_agent_instance_id=? ORDER BY created_at,id').all(source.id);
  for (const document of documents) {
    const target = db.prepare(`SELECT * FROM memory_documents WHERE account_workspace_id=? AND user_agent_instance_id=?
      AND scope=? AND slot_no=? AND task_run_id=? AND project_id=? AND relationship_id=?`).get(
      document.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID, canonical.id, document.scope, document.slot_no,
      document.task_run_id, document.project_id, document.relationship_id,
    );
    if (!target) {
      db.prepare(`UPDATE memory_documents SET user_agent_instance_id=?,agent_family_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=?`).run(canonical.id, canonical.agent_family_id, document.id);
      continue;
    }
    const sourceVersions = db.prepare('SELECT * FROM memory_document_versions WHERE memory_document_id=? ORDER BY created_at,id').all(document.id);
    let offset = 1000000 + Number(db.prepare(`SELECT COALESCE(MAX(version_no),0) value FROM memory_document_versions
      WHERE memory_document_id=?`).get(target.id)?.value || 0);
    for (const version of sourceVersions) {
      offset += 1;
      db.prepare(`UPDATE memory_document_versions SET memory_document_id=?,version_no=?,
        origin_document_id=CASE WHEN origin_document_id='' THEN ? ELSE origin_document_id END,
        origin_version_no=CASE WHEN origin_version_no=0 THEN ? ELSE origin_version_no END WHERE id=?`).run(
        target.id, offset, document.id, version.version_no, version.id,
      );
    }
    resequenceMemoryDocumentVersions(db, target.id);
    const sourceWins = String(document.updated_at || '').localeCompare(String(target.updated_at || '')) > 0
      || (document.updated_at === target.updated_at && String(document.current_version_id || '').localeCompare(String(target.current_version_id || '')) > 0);
    const currentVersionId = sourceWins ? document.current_version_id : target.current_version_id;
    const currentVersion = db.prepare('SELECT content_hash FROM memory_document_versions WHERE id=?').get(currentVersionId);
    db.prepare(`UPDATE memory_documents SET current_version_id=?,content_hash=?,updated_at=MAX(updated_at,?) WHERE id=?`).run(
      currentVersionId || target.current_version_id || '', currentVersion?.content_hash || target.content_hash || '',
      document.updated_at || target.updated_at || '', target.id,
    );
    for (const [table, column] of [
      ['memory_entries', 'memory_document_id'], ['typed_memories', 'memory_document_id'], ['messages', 'memory_id'],
      ['agent_context_state', 'active_memory_document_id'], ['agent_device_context_state', 'active_memory_document_id'],
      ['memory_access_audits', 'memory_document_id'],
    ]) {
      if (migrationTableHasColumn(db, table, column)) db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`).run(target.id, document.id);
    }
    if (migrationTableHasColumn(db, 'agent_context_spaces', 'memory_document_id')) {
      db.prepare('UPDATE agent_context_spaces SET memory_document_id=? WHERE memory_document_id=?').run(target.id, document.id);
    }
    if (migrationTableHasColumn(db, 'memory_sync_mappings', 'memory_document_id')) {
      for (const mapping of db.prepare('SELECT * FROM memory_sync_mappings WHERE memory_document_id=?').all(document.id)) {
        const collision = db.prepare('SELECT 1 FROM memory_sync_mappings WHERE device_id=? AND memory_document_id=?').get(mapping.device_id, target.id);
        if (collision) db.prepare('DELETE FROM memory_sync_mappings WHERE device_id=? AND private_key=?').run(mapping.device_id, mapping.private_key);
        else db.prepare('UPDATE memory_sync_mappings SET memory_document_id=?,user_agent_instance_id=? WHERE device_id=? AND private_key=?')
          .run(target.id, canonical.id, mapping.device_id, mapping.private_key);
      }
    }
    db.prepare(`INSERT INTO memory_document_aliases(alias_document_id,canonical_document_id,user_id,reason)
      VALUES(?,?,?,'agent_alias_cycle_repair_v2') ON CONFLICT(alias_document_id) DO UPDATE SET
      canonical_document_id=excluded.canonical_document_id,user_id=excluded.user_id,reason=excluded.reason`).run(document.id, target.id, canonical.user_id);
    db.prepare(`UPDATE memory_documents SET lifecycle_state='archived',sync_enabled=0,allow_personal_evolution=0,
      allow_cluster_evolution=0,current_version_id='',content_hash='',context_space_id='',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=?`).run(document.id);
  }
}

function mergeAgentAliasCycleContexts(db, sourceId, canonicalId, canonicalFamilyId = '') {
  if (!migrationTableHasColumn(db, 'agent_context_spaces', 'user_agent_instance_id')) return;
  const canonical = db.prepare('SELECT user_id,agent_family_id FROM user_agent_instances WHERE id=?').get(canonicalId);
  if (!canonical) throw new Error('Canonical Agent instance is missing during Context repair.');
  const familyId = canonicalFamilyId || canonical.agent_family_id || '';
  if (migrationTableHasColumn(db, 'sessions', 'agent_instance_id')) {
    db.prepare(`UPDATE sessions SET agent_instance_id=?,agent_id=? WHERE agent_instance_id=? AND user_id=?`)
      .run(canonicalId, familyId, sourceId, canonical.user_id);
  }
  const contexts = db.prepare('SELECT * FROM agent_context_spaces WHERE user_agent_instance_id=? ORDER BY created_at,id').all(sourceId);
  for (const context of contexts) {
    const incompatibleMessages = Number(db.prepare(`SELECT COUNT(*) count FROM messages WHERE context_space_id=?
      AND agent_instance_id!='' AND agent_instance_id NOT IN (?,?) AND NOT EXISTS (
        SELECT 1 FROM user_agent_instance_aliases alias WHERE alias.alias_instance_id=messages.agent_instance_id
          AND alias.canonical_instance_id=?
      )`).get(context.id, sourceId, canonicalId, canonicalId)?.count || 0);
    if (incompatibleMessages) throw new Error('message_context_agent_mismatch');
    const target = db.prepare(`SELECT * FROM agent_context_spaces WHERE id!=? AND user_id=? AND account_workspace_id=?
      AND user_agent_instance_id=? AND context_kind=? AND memory_document_id=? AND project_id=? AND task_run_id=?
      AND delegation_id=? AND group_id=? AND relationship_user_id=? AND legacy_session_id=? LIMIT 1`).get(
      context.id, context.user_id, context.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID, canonicalId,
      context.context_kind, context.memory_document_id, context.project_id, context.task_run_id, context.delegation_id,
      context.group_id, context.relationship_user_id, context.legacy_session_id,
    );
    if (!target) {
      db.prepare(`UPDATE agent_context_spaces SET user_agent_instance_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(canonicalId, context.id);
      db.prepare(`UPDATE messages SET
        agent_instance_id=CASE WHEN agent_instance_id='' THEN '' ELSE ? END,
        agent_id=CASE WHEN agent_instance_id='' THEN agent_id ELSE ? END
        WHERE context_space_id=?`).run(canonicalId, familyId, context.id);
      continue;
    }
    db.prepare(`UPDATE messages SET context_space_id=?,
      agent_instance_id=CASE WHEN agent_instance_id='' THEN '' ELSE ? END,
      agent_id=CASE WHEN agent_instance_id='' THEN agent_id ELSE ? END
      WHERE context_space_id=?`).run(target.id, canonicalId, familyId, context.id);
    for (const [table, column] of [
      ['memory_documents', 'context_space_id'],
      ['agent_context_state', 'active_context_space_id'], ['agent_device_context_state', 'active_context_space_id'],
    ]) {
      if (migrationTableHasColumn(db, table, column)) db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`).run(target.id, context.id);
    }
    if (migrationTableHasColumn(db, 'chat_context_states', 'context_space_id')) {
      const chatStates = db.prepare('SELECT * FROM chat_context_states WHERE context_space_id=? ORDER BY updated_at,id').all(context.id);
      for (const state of chatStates) {
        const collision = db.prepare(`SELECT * FROM chat_context_states WHERE owner_user_id=? AND session_id=? AND context_space_id=?`)
          .get(state.owner_user_id, state.session_id, target.id);
        if (!collision) db.prepare(`UPDATE chat_context_states SET context_space_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
          .run(target.id, state.id);
        else db.prepare('DELETE FROM chat_context_states WHERE id=?').run(state.id);
      }
    }
    db.prepare('DELETE FROM agent_context_spaces WHERE id=?').run(context.id);
  }
}

function mergeAgentAliasCycleContextState(db, table, sourceId, canonicalId) {
  if (!migrationTableHasColumn(db, table, 'user_agent_instance_id')) return;
  const identityColumns = table === 'agent_device_context_state'
    ? ['device_id', 'account_workspace_id'] : ['user_id', 'account_workspace_id'];
  const sourceRows = db.prepare(`SELECT * FROM ${table} WHERE user_agent_instance_id=?`).all(sourceId);
  for (const source of sourceRows) {
    const target = db.prepare(`SELECT * FROM ${table} WHERE ${identityColumns[0]}=? AND ${identityColumns[1]}=? AND user_agent_instance_id=?`).get(
      source[identityColumns[0]], source[identityColumns[1]] || PERSONAL_ACCOUNT_WORKSPACE_ID, canonicalId,
    );
    if (!target) {
      db.prepare(`UPDATE ${table} SET user_agent_instance_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE ${identityColumns[0]}=? AND ${identityColumns[1]}=? AND user_agent_instance_id=?`).run(
        canonicalId, source[identityColumns[0]], source[identityColumns[1]] || PERSONAL_ACCOUNT_WORKSPACE_ID, sourceId,
      );
      continue;
    }
    db.prepare(`UPDATE ${table} SET
      primary_session_id=CASE WHEN primary_session_id='' THEN ? ELSE primary_session_id END,
      active_context_space_id=CASE WHEN active_context_space_id='' THEN ? ELSE active_context_space_id END,
      active_memory_document_id=CASE WHEN active_memory_document_id='' THEN ? ELSE active_memory_document_id END,
      updated_at=MAX(updated_at,?) WHERE ${identityColumns[0]}=? AND ${identityColumns[1]}=? AND user_agent_instance_id=?`).run(
      source.primary_session_id || '', source.active_context_space_id || '', source.active_memory_document_id || '', source.updated_at || '',
      target[identityColumns[0]], target[identityColumns[1]] || PERSONAL_ACCOUNT_WORKSPACE_ID, canonicalId,
    );
    db.prepare(`DELETE FROM ${table} WHERE ${identityColumns[0]}=? AND ${identityColumns[1]}=? AND user_agent_instance_id=?`).run(
      source[identityColumns[0]], source[identityColumns[1]] || PERSONAL_ACCOUNT_WORKSPACE_ID, sourceId,
    );
  }
}

function mergeAgentAliasCycleBindings(db, sourceId, canonicalId) {
  if (migrationTableHasColumn(db, 'workspace_agent_bindings', 'agent_instance_id')) {
    for (const source of db.prepare('SELECT * FROM workspace_agent_bindings WHERE agent_instance_id=?').all(sourceId)) {
      const target = db.prepare('SELECT * FROM workspace_agent_bindings WHERE workspace_id=? AND agent_instance_id=?').get(source.workspace_id, canonicalId);
      if (!target) db.prepare(`UPDATE workspace_agent_bindings SET agent_instance_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE workspace_id=? AND agent_instance_id=?`).run(canonicalId, source.workspace_id, sourceId);
      else {
        db.prepare(`UPDATE workspace_agent_bindings SET visibility=CASE WHEN visibility='represented' OR ?='represented' THEN 'represented' ELSE 'private' END,
          can_receive_mentions=MAX(can_receive_mentions,?),can_receive_delegations=MAX(can_receive_delegations,?),
          can_read_workspace_files=MAX(can_read_workspace_files,?),can_write_workspace_memory=MAX(can_write_workspace_memory,?),
          status=CASE WHEN status='active' OR ?='active' THEN 'active' ELSE 'disabled' END,updated_at=MAX(updated_at,?)
          WHERE workspace_id=? AND agent_instance_id=?`).run(
          source.visibility, source.can_receive_mentions, source.can_receive_delegations, source.can_read_workspace_files,
          source.can_write_workspace_memory, source.status, source.updated_at || '', source.workspace_id, canonicalId,
        );
        db.prepare('DELETE FROM workspace_agent_bindings WHERE workspace_id=? AND agent_instance_id=?').run(source.workspace_id, sourceId);
      }
    }
  }
  if (migrationTableHasColumn(db, 'work_participants', 'agent_instance_id')) {
    for (const source of db.prepare('SELECT * FROM work_participants WHERE agent_instance_id=?').all(sourceId)) {
      const target = db.prepare('SELECT * FROM work_participants WHERE work_scope_id=? AND agent_instance_id=?').get(source.work_scope_id, canonicalId);
      if (!target) db.prepare(`UPDATE work_participants SET agent_instance_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(canonicalId, source.id);
      else {
        db.prepare(`UPDATE work_participants SET status=CASE WHEN status='active' OR ?='active' THEN 'active' ELSE 'removed' END,
          updated_at=MAX(updated_at,?) WHERE id=?`).run(source.status, source.updated_at || '', target.id);
        db.prepare('DELETE FROM work_participants WHERE id=?').run(source.id);
      }
    }
    for (const participant of db.prepare("SELECT id,collaboration_edges_json FROM work_participants WHERE collaboration_edges_json LIKE '%'||?||'%'").all(sourceId)) {
      let edges = [];
      try { edges = JSON.parse(participant.collaboration_edges_json || '[]'); } catch {}
      if (!Array.isArray(edges) || !edges.includes(sourceId)) continue;
      db.prepare(`UPDATE work_participants SET collaboration_edges_json=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(JSON.stringify([...new Set(edges.map((id) => id === sourceId ? canonicalId : id))].sort()), participant.id);
    }
  }
  if (migrationTableHasColumn(db, 'agent_work_queue', 'agent_instance_id')) {
    const running = db.prepare(`SELECT id FROM agent_work_queue WHERE agent_instance_id IN (?,?) AND status='running'
      ORDER BY CASE WHEN started_at='' THEN 1 ELSE 0 END,started_at,enqueued_at,sequence_no,id`).all(sourceId, canonicalId);
    for (const row of running.slice(1)) db.prepare(`UPDATE agent_work_queue SET status='queued',started_at='',completed_at='',
      error_text=CASE WHEN error_text='' THEN 'identity_merge_requeued' ELSE error_text END,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(row.id);
    db.prepare(`UPDATE agent_work_queue SET agent_instance_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE agent_instance_id=?`)
      .run(canonicalId, sourceId);
  }
}

function mergeAgentAliasCycleConversationState(db, sourceId, canonicalId) {
  if (migrationTableHasColumn(db, 'agent_conversation_branch_state', 'agent_instance_id')) {
    for (const source of db.prepare('SELECT * FROM agent_conversation_branch_state WHERE agent_instance_id=?').all(sourceId)) {
      const target = db.prepare(`SELECT * FROM agent_conversation_branch_state WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?`)
        .get(source.user_id, source.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID, canonicalId);
      if (!target) db.prepare(`UPDATE agent_conversation_branch_state SET agent_instance_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?`).run(
        canonicalId, source.user_id, source.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID, sourceId,
      );
      else {
        db.prepare(`UPDATE agent_conversation_branch_state SET rebuild_required=MAX(rebuild_required,?),
          thread_generation=MAX(thread_generation,?),last_injected_timeline_sequence=MAX(last_injected_timeline_sequence,?),
          updated_at=MAX(updated_at,?) WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?`).run(
          source.rebuild_required, source.thread_generation, source.last_injected_timeline_sequence, source.updated_at || '',
          source.user_id, source.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID, canonicalId,
        );
        db.prepare(`DELETE FROM agent_conversation_branch_state WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?`)
          .run(source.user_id, source.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID, sourceId);
      }
    }
  }
  if (migrationTableHasColumn(db, 'agent_conversation_thread_lineage', 'agent_instance_id')) {
    db.prepare('UPDATE agent_conversation_thread_lineage SET agent_instance_id=? WHERE agent_instance_id=?').run(canonicalId, sourceId);
  }
  if (migrationTableHasColumn(db, 'agent_conversation_timeline_refs', 'agent_instance_id')) {
    for (const source of db.prepare('SELECT * FROM agent_conversation_timeline_refs WHERE agent_instance_id=?').all(sourceId)) {
      const target = db.prepare(`SELECT sequence_no FROM agent_conversation_timeline_refs WHERE agent_instance_id=? AND source_kind=? AND source_id=?`)
        .get(canonicalId, source.source_kind, source.source_id);
      if (target) db.prepare('DELETE FROM agent_conversation_timeline_refs WHERE sequence_no=?').run(source.sequence_no);
      else db.prepare('UPDATE agent_conversation_timeline_refs SET ref_id=?,agent_instance_id=? WHERE sequence_no=?')
        .run(`${source.source_kind}:${source.source_id}:${canonicalId}`, canonicalId, source.sequence_no);
    }
  }
}

function mergeAgentAliasCycleInstance(db, source, canonical) {
  db.prepare(`INSERT INTO agent_identity_migration_quarantine(id,source_table,source_id,user_id,agent_family_id,reason,payload_json)
    VALUES(?, 'user_agent_instances', ?, ?, ?, 'agent_alias_cycle_canonicalized', ?)
    ON CONFLICT(source_table,source_id,reason) DO UPDATE SET payload_json=excluded.payload_json`).run(
    `identity_alias_cycle_${source.id}`, source.id, source.user_id, source.agent_family_id, JSON.stringify(source),
  );
  mergeAgentAliasCycleMemory(db, source, canonical);
  mergeAgentAliasCycleContexts(db, source.id, canonical.id, canonical.agent_family_id);
  mergeAgentAliasCycleContextState(db, 'agent_context_state', source.id, canonical.id);
  mergeAgentAliasCycleContextState(db, 'agent_device_context_state', source.id, canonical.id);
  mergeAgentAliasCycleBindings(db, source.id, canonical.id);
  mergeAgentAliasCycleConversationState(db, source.id, canonical.id);
  for (const [table, column] of [
    ['sessions', 'agent_instance_id'], ['messages', 'agent_instance_id'], ['conversations', 'agent_instance_id'],
    ['model_executions', 'agent_instance_id'], ['task_runs', 'lead_agent_instance_id'], ['task_nodes', 'agent_instance_id'],
    ['memory_entries', 'agent_instance_id'], ['typed_memories', 'agent_instance_id'],
    ['evolution_runs', 'user_agent_instance_id'], ['evolution_archives', 'user_agent_instance_id'],
    ['agent_performance_reviews', 'user_agent_instance_id'], ['skill_versions', 'user_agent_instance_id'],
    ['user_agent_recruitment_events', 'user_agent_instance_id'], ['agent_delivery_receipts', 'target_agent_instance_id'],
    ['cloud_stage8_projections', 'user_agent_instance_id'], ['leadership_assignments', 'agent_instance_id'],
    ['ubuddy_coordination_states', 'leader_agent_instance_id'], ['ubuddy_wake_outbox', 'leader_agent_instance_id'],
    ['work_memory_access_audits', 'requester_agent_instance_id'], ['work_memory_access_audits', 'target_agent_instance_id'],
  ]) {
    if (migrationTableHasColumn(db, table, column)) db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`).run(canonical.id, source.id);
  }
  if (migrationTableHasColumn(db, 'user_agent_skill_versions', 'user_agent_instance_id')) {
    db.prepare(`UPDATE user_agent_skill_versions SET user_agent_instance_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_agent_instance_id=?`).run(canonical.id, source.id);
    const versions = db.prepare(`SELECT id,activated_at,updated_at FROM user_agent_skill_versions WHERE user_agent_instance_id=?
      ORDER BY activated_at DESC,updated_at DESC,id DESC`).all(canonical.id);
    const active = versions.find((row) => row.activated_at)?.id || '';
    for (const version of versions.filter((row) => row.activated_at)) {
      db.prepare(`UPDATE user_agent_skill_versions SET status=?,archived_at=CASE WHEN ?='archived' AND archived_at='' THEN
        strftime('%Y-%m-%dT%H:%M:%fZ','now') WHEN ?='active' THEN '' ELSE archived_at END WHERE id=?`).run(
        version.id === active ? 'active' : 'archived', version.id === active ? 'active' : 'archived', version.id === active ? 'active' : 'archived', version.id,
      );
    }
    db.prepare('UPDATE user_agent_instances SET active_personal_skill_version_id=? WHERE id=?').run(active, canonical.id);
  }
  if (migrationTableHasColumn(db, 'employee_command_outbox', 'local_agent_instance_id')) {
    db.prepare(`UPDATE employee_command_outbox SET local_agent_instance_id=?,proposed_instance_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE local_agent_instance_id=? OR proposed_instance_id=?`).run(canonical.id, canonical.id, source.id, source.id);
  }
  db.prepare(`UPDATE user_agent_instances SET status='inactive',employment_state='inactive',sync_enabled=0,
    personal_evolution_consent=0,cluster_contribution_consent=0,personal_skill_auto_activate=0,
    active_personal_skill_version_id='',pending_target_state='',deactivated_at=CASE WHEN deactivated_at='' THEN
    strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE deactivated_at END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(source.id);
}

function flattenAgentInstanceAliasGraph(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_agent_instance_aliases'").get()) return [];
  const rows = db.prepare('SELECT alias_instance_id,canonical_instance_id,user_id FROM user_agent_instance_aliases').all();
  const aliases = new Map(rows.map((row) => [String(row.alias_instance_id || ''), row]));
  const instances = new Map(db.prepare(`SELECT id,user_id,agent_family_id,employment_state,authority_state,state_revision,created_at
    FROM user_agent_instances`).all().map((row) => [String(row.id || ''), row]));
  const resolved = new Map();
  const chooseCycleWinner = (ids) => {
    const candidates = ids.map((id) => instances.get(id)).filter(Boolean);
    if (!candidates.length) throw new Error('Agent instance alias cycle has no live canonical instance.');
    const aliasUsers = new Set(ids.map((id) => aliases.get(id)?.user_id).filter(Boolean));
    const users = new Set(candidates.map((item) => item.user_id));
    const families = new Set(candidates.map((item) => item.agent_family_id));
    if (users.size !== 1 || families.size !== 1 || aliasUsers.size !== 1 || !aliasUsers.has(candidates[0].user_id)) {
      throw new Error('Agent instance alias cycle crosses user or Agent family boundaries.');
    }
    candidates.sort((left, right) => Number(right.authority_state === 'cloud_confirmed') - Number(left.authority_state === 'cloud_confirmed')
      || Number(right.employment_state === 'active') - Number(left.employment_state === 'active')
      || Number(right.state_revision || 0) - Number(left.state_revision || 0)
      || String(left.created_at || '').localeCompare(String(right.created_at || ''))
      || String(left.id || '').localeCompare(String(right.id || '')));
    const winner = candidates[0];
    const rebindAlias = db.prepare(`UPDATE user_agent_instance_aliases
      SET canonical_instance_id=?,user_id=? WHERE alias_instance_id=?`);
    for (const id of ids) {
      if (id === winner.id) {
        db.prepare('DELETE FROM user_agent_instance_aliases WHERE alias_instance_id=?').run(id);
        aliases.delete(id);
        continue;
      }
      rebindAlias.run(winner.id, winner.user_id, id);
      aliases.set(id, { ...(aliases.get(id) || {}), alias_instance_id: id, canonical_instance_id: winner.id, user_id: winner.user_id });
    }
    for (const loser of candidates.slice(1)) mergeAgentAliasCycleInstance(db, loser, winner);
    return String(winner.id || '');
  };
  const resolve = (startId) => {
    if (resolved.has(startId)) return resolved.get(startId);
    const order = [];
    const positions = new Map();
    let current = startId;
    while (aliases.has(current)) {
      if (positions.has(current)) {
        const cycle = order.slice(positions.get(current));
        const winner = chooseCycleWinner(cycle);
        for (const id of cycle) resolved.set(id, winner);
        current = winner;
        break;
      }
      positions.set(current, order.length);
      order.push(current);
      const next = String(aliases.get(current)?.canonical_instance_id || '');
      if (!next || next === current) break;
      current = next;
    }
    const terminal = resolved.get(current) || current;
    if (!instances.has(terminal)) throw new Error('Agent instance alias target is missing.');
    for (const id of order) resolved.set(id, terminal);
    return terminal;
  };
  for (const row of rows) resolve(String(row.alias_instance_id || ''));
  for (const [aliasId, canonicalId] of resolved) {
    if (!aliasId || !canonicalId || aliasId === canonicalId) continue;
    const alias = aliases.get(aliasId);
    const source = instances.get(aliasId);
    const canonical = instances.get(canonicalId);
    if (!canonical) throw new Error('Agent instance alias target is missing.');
    if ((alias?.user_id && alias.user_id !== canonical.user_id)
      || (source && (source.user_id !== canonical.user_id || source.agent_family_id !== canonical.agent_family_id))
      || (source && alias?.user_id && alias.user_id !== source.user_id)) {
      throw new Error('Agent instance alias crosses user or Agent family boundaries.');
    }
  }
  const update = db.prepare(`UPDATE user_agent_instance_aliases SET canonical_instance_id=? WHERE alias_instance_id=?`);
  for (const [aliasId, canonicalId] of resolved) {
    if (aliasId === canonicalId) db.prepare('DELETE FROM user_agent_instance_aliases WHERE alias_instance_id=?').run(aliasId);
    else update.run(canonicalId, aliasId);
  }
  return [...resolved.entries()].filter(([aliasId, canonicalId]) => aliasId && canonicalId && aliasId !== canonicalId);
}

function canonicalizeAgentConversationAliasReferences(db, mappings = []) {
  for (const [aliasId, canonicalId] of mappings) {
    const canonical = db.prepare('SELECT user_id,agent_family_id FROM user_agent_instances WHERE id=?').get(canonicalId);
    if (!canonical) throw new Error('Canonical Agent instance is missing during conversation alias repair.');
    db.prepare(`UPDATE sessions SET agent_instance_id=?,agent_id=?
      WHERE agent_instance_id=? AND user_id=?`).run(canonicalId, canonical.agent_family_id, aliasId, canonical.user_id);
  }
  for (const [aliasId, canonicalId] of mappings) {
    const canonical = db.prepare('SELECT user_id,agent_family_id FROM user_agent_instances WHERE id=?').get(canonicalId);
    if (!canonical) throw new Error('Canonical Agent instance is missing during conversation alias repair.');
    const canonicalInstance = { id: canonicalId, ...canonical };
    mergeAgentAliasCycleMemory(db, { id: aliasId }, canonicalInstance);
    mergeAgentAliasCycleContexts(db, aliasId, canonicalId, canonical.agent_family_id);
    mergeAgentAliasCycleContextState(db, 'agent_context_state', aliasId, canonicalId);
    mergeAgentAliasCycleContextState(db, 'agent_device_context_state', aliasId, canonicalId);
    mergeAgentAliasCycleBindings(db, aliasId, canonicalId);
    mergeAgentAliasCycleConversationState(db, aliasId, canonicalId);
    db.prepare(`UPDATE conversations SET agent_instance_id=?,agent_id=?
      WHERE agent_instance_id=? AND owner_user_id=?`).run(canonicalId, canonical.agent_family_id, aliasId, canonical.user_id);
    db.prepare(`UPDATE messages SET agent_instance_id=?,agent_id=?
      WHERE agent_instance_id=?`).run(canonicalId, canonical.agent_family_id, aliasId);
    db.prepare(`UPDATE model_executions SET agent_instance_id=?,agent_id=?
      WHERE agent_instance_id=? AND (user_id='' OR user_id=?)`).run(canonicalId, canonical.agent_family_id, aliasId, canonical.user_id);
  }
}

function ensureSocialChatGroupSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_groups (
    id TEXT PRIMARY KEY,account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',organization_id TEXT NOT NULL DEFAULT '',
    owner_user_id TEXT NOT NULL,title TEXT NOT NULL DEFAULT '新群聊',scope_type TEXT NOT NULL DEFAULT 'external',
    chat_mode TEXT NOT NULL DEFAULT 'conversation',binding_type TEXT NOT NULL DEFAULT 'manual',binding_id TEXT NOT NULL DEFAULT '',
    history_visibility TEXT NOT NULL DEFAULT 'from_join',status TEXT NOT NULL DEFAULT 'active',client_request_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),dissolved_at TEXT,
    UNIQUE(account_workspace_id,owner_user_id,client_request_id),CHECK(scope_type IN ('internal','external')),
    CHECK(chat_mode IN ('conversation','topic')),CHECK(binding_type IN ('manual','organization','department')),
    CHECK(history_visibility IN ('from_join','full')),CHECK(status IN ('active','dissolved'))
  );
  CREATE TABLE IF NOT EXISTS chat_group_members (
    group_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member',status TEXT NOT NULL DEFAULT 'active',
    invited_by_user_id TEXT NOT NULL DEFAULT '',joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    left_at TEXT,last_read_at TEXT,PRIMARY KEY(group_id,user_id),FOREIGN KEY(group_id) REFERENCES chat_groups(id) ON DELETE CASCADE,
    CHECK(role IN ('owner','admin','member')),CHECK(status IN ('invited','active','left','removed','declined'))
  );
  CREATE TABLE IF NOT EXISTS chat_group_messages (
    id TEXT PRIMARY KEY,account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',group_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,sender_agent_id TEXT NOT NULL DEFAULT '',kind TEXT NOT NULL DEFAULT 'friend',content TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',source_event_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),FOREIGN KEY(group_id) REFERENCES chat_groups(id) ON DELETE CASCADE,
    CHECK(kind IN ('friend','agent','system'))
  );
  CREATE TABLE IF NOT EXISTS chat_group_outbox (
    id TEXT PRIMARY KEY,account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',operation_kind TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),completed_at TEXT NOT NULL DEFAULT '',
    CHECK(operation_kind IN ('create_group','send_message','update_group')),CHECK(status IN ('pending','sending','completed','failed'))
  );
  CREATE INDEX IF NOT EXISTS idx_chat_groups_workspace ON chat_groups(account_workspace_id,status,updated_at);
  CREATE INDEX IF NOT EXISTS idx_chat_group_members_user ON chat_group_members(user_id,status,joined_at);
  CREATE INDEX IF NOT EXISTS idx_chat_group_messages_group ON chat_group_messages(group_id,created_at,id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_group_messages_source_event
    ON chat_group_messages(group_id,source_event_id) WHERE source_event_id<>'';
  CREATE INDEX IF NOT EXISTS idx_chat_group_outbox_due ON chat_group_outbox(account_workspace_id,status,next_attempt_at,created_at)`);
}

function ensureSocialDirectoryV2Schema(db) {
  const chatGroupColumns = new Set(db.prepare('PRAGMA table_info(chat_groups)').all().map((row) => String(row.name || '')));
  if (!chatGroupColumns.has('audience_scope')) {
    db.exec("ALTER TABLE chat_groups ADD COLUMN audience_scope TEXT NOT NULL DEFAULT 'account_social' CHECK(audience_scope IN ('account_social','workspace_legacy'))");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS account_workspace_startup_preferences (
    user_id TEXT NOT NULL,device_id TEXT NOT NULL DEFAULT 'local',
    startup_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(user_id,device_id),FOREIGN KEY(startup_workspace_id) REFERENCES account_workspaces(id)
  );
  CREATE INDEX IF NOT EXISTS idx_chat_groups_audience_member
    ON chat_groups(audience_scope,status,updated_at)`);
}

function ensureSocialConversationArchiveSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS social_conversation_preferences (
    account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',user_id TEXT NOT NULL,
    conversation_kind TEXT NOT NULL,conversation_id TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,
    state_revision INTEGER NOT NULL DEFAULT 1,base_state_revision INTEGER NOT NULL DEFAULT 0,
    last_command_id TEXT NOT NULL DEFAULT '',source_device_id TEXT NOT NULL DEFAULT '',sync_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(account_workspace_id,user_id,conversation_kind,conversation_id),
    CHECK(conversation_kind IN ('chat_group','collaboration_group')),CHECK(archived IN (0,1)),
    CHECK(state_revision>=1),CHECK(sync_status IN ('pending','synced','conflict'))
  );
  CREATE TABLE IF NOT EXISTS social_conversation_preference_outbox (
    id TEXT PRIMARY KEY,account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',user_id TEXT NOT NULL,
    conversation_kind TEXT NOT NULL,conversation_id TEXT NOT NULL,command_id TEXT NOT NULL UNIQUE,
    payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),completed_at TEXT NOT NULL DEFAULT '',
    CHECK(conversation_kind IN ('chat_group','collaboration_group')),CHECK(status IN ('pending','sending','completed','failed'))
  );
  CREATE INDEX IF NOT EXISTS idx_social_conversation_preferences_user
    ON social_conversation_preferences(user_id,archived,updated_at);
  CREATE INDEX IF NOT EXISTS idx_social_conversation_preference_outbox_due
    ON social_conversation_preference_outbox(user_id,status,next_attempt_at,created_at)`);
}

function ensureSocialInboxPreferenceSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS social_inbox_preferences (
    account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',user_id TEXT NOT NULL,
    conversation_kind TEXT NOT NULL,conversation_id TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,
    state_revision INTEGER NOT NULL DEFAULT 1,last_command_id TEXT NOT NULL DEFAULT '',source_device_id TEXT NOT NULL DEFAULT '',
    sync_status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(account_workspace_id,user_id,conversation_kind,conversation_id),
    CHECK(conversation_kind IN ('social_direct','agent_session')),CHECK(archived IN (0,1)),
    CHECK(state_revision>=1),CHECK(sync_status IN ('pending','synced','conflict'))
  );
  CREATE TABLE IF NOT EXISTS social_inbox_preference_outbox (
    id TEXT PRIMARY KEY,account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',user_id TEXT NOT NULL,
    conversation_kind TEXT NOT NULL,conversation_id TEXT NOT NULL,command_id TEXT NOT NULL UNIQUE,payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'pending',attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),completed_at TEXT NOT NULL DEFAULT '',
    CHECK(conversation_kind IN ('social_direct','agent_session')),CHECK(status IN ('pending','sending','completed','failed'))
  );
  CREATE INDEX IF NOT EXISTS idx_social_inbox_preferences_user ON social_inbox_preferences(user_id,archived,updated_at);
  CREATE INDEX IF NOT EXISTS idx_social_inbox_preference_outbox_due ON social_inbox_preference_outbox(user_id,status,next_attempt_at,created_at)`);
}

function ensureSocialChatReceiptSchema(db) {
  const preferenceColumns = new Set(db.prepare('PRAGMA table_info(social_conversation_preferences)').all()
    .map((row) => String(row.name || '')));
  if (!preferenceColumns.has('removed_at')) {
    db.exec("ALTER TABLE social_conversation_preferences ADD COLUMN removed_at TEXT NOT NULL DEFAULT ''");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS chat_group_message_receipts (
    message_id TEXT NOT NULL,group_id TEXT NOT NULL,recipient_user_id TEXT NOT NULL,read_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(message_id,recipient_user_id),
    FOREIGN KEY(message_id) REFERENCES chat_group_messages(id) ON DELETE CASCADE,
    FOREIGN KEY(group_id) REFERENCES chat_groups(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_chat_group_receipts_reader
    ON chat_group_message_receipts(group_id,recipient_user_id,read_at,created_at);
  INSERT OR IGNORE INTO schema_migrations(id) VALUES('social_chat_receipts_v1')`);
}

function ensureEmojiFavoritesSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS emoji_favorites (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'image',value TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL DEFAULT '',content_type TEXT NOT NULL DEFAULT '',size_bytes INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL DEFAULT '',local_path TEXT NOT NULL DEFAULT '',remote_file_id TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(user_id,kind,sha256),CHECK(kind IN ('unicode','image')),CHECK(size_bytes>=0)
  );
  CREATE INDEX IF NOT EXISTS idx_emoji_favorites_user_order ON emoji_favorites(user_id,sort_order,created_at);
  CREATE TABLE IF NOT EXISTS emoji_favorite_outbox (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,operation_kind TEXT NOT NULL,payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',attempt_count INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_emoji_favorite_outbox_pending ON emoji_favorite_outbox(user_id,status,created_at);
  INSERT OR IGNORE INTO schema_migrations(id) VALUES('emoji_favorites_v1')`);
}

function migrateEmojiFavoriteUnicodeIdentityV2(db) {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE id='emoji_favorites_unicode_identity_v2'").get()) return;
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='emoji_favorites'").get();
  if (!table) return;
  const update = db.prepare("UPDATE emoji_favorites SET sha256=?,updated_at=? WHERE id=? AND kind='unicode' AND sha256=''");
  for (const row of db.prepare("SELECT id,value FROM emoji_favorites WHERE kind='unicode' AND sha256='' ORDER BY id").all()) {
    update.run(crypto.createHash('sha256').update(String(row.value || '')).digest('hex'), new Date().toISOString(), row.id);
  }
  db.prepare("INSERT INTO schema_migrations(id) VALUES('emoji_favorites_unicode_identity_v2')").run();
}

function ensureUBuddyCapabilityProfileSocialSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ubuddy_capability_profile_cache (
    viewer_user_id TEXT NOT NULL,server_origin_hash TEXT NOT NULL,owner_remote_user_id TEXT NOT NULL,
    owner_local_user_id TEXT NOT NULL DEFAULT '',ubuddy_agent_instance_id TEXT NOT NULL DEFAULT '',
    profile_revision INTEGER NOT NULL DEFAULT 0,profile_version TEXT NOT NULL DEFAULT 'ubuddy_capability_profile_v1',
    visibility TEXT NOT NULL DEFAULT 'friends',content_hash TEXT NOT NULL DEFAULT '',profile_json TEXT NOT NULL DEFAULT '{}',
    access_scope TEXT NOT NULL DEFAULT 'friends',fetched_at TEXT NOT NULL DEFAULT '',expires_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(viewer_user_id,server_origin_hash,owner_remote_user_id),
    CHECK(visibility IN ('friends','organization')),CHECK(access_scope IN ('owner','friends','organization')),
    CHECK(profile_revision>=0)
  );
  CREATE INDEX IF NOT EXISTS idx_ubuddy_capability_profile_cache_local
    ON ubuddy_capability_profile_cache(viewer_user_id,owner_local_user_id,expires_at);
  CREATE TABLE IF NOT EXISTS ubuddy_capability_profile_publication_outbox (
    id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,profile_revision INTEGER NOT NULL DEFAULT 0,
    command_id TEXT NOT NULL UNIQUE,operation_kind TEXT NOT NULL,expected_cloud_state_revision INTEGER NOT NULL DEFAULT 0,
    payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),completed_at TEXT NOT NULL DEFAULT '',
    CHECK(operation_kind IN ('publish','unpublish')),
    CHECK(status IN ('pending','sending','completed','failed','blocked_capability')),
    CHECK(profile_revision>=0),CHECK(expected_cloud_state_revision>=0)
  );
  CREATE INDEX IF NOT EXISTS idx_ubuddy_capability_profile_outbox_due
    ON ubuddy_capability_profile_publication_outbox(owner_user_id,status,next_attempt_at,created_at)`);
}

function ensureUBuddyCapabilityProfileHistorySchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ubuddy_capability_profiles (
    owner_user_id TEXT NOT NULL,ubuddy_agent_instance_id TEXT NOT NULL,profile_revision INTEGER NOT NULL,
    source_effective_skill_hash TEXT NOT NULL,profile_version TEXT NOT NULL DEFAULT 'ubuddy_capability_profile_v1',
    publication_state TEXT NOT NULL DEFAULT 'draft',generation_status TEXT NOT NULL DEFAULT 'pending',
    generation_trigger TEXT NOT NULL DEFAULT 'skill_changed',profile_json TEXT NOT NULL DEFAULT '{}',
    content_hash TEXT NOT NULL DEFAULT '',validation_json TEXT NOT NULL DEFAULT '{}',
    capability_scope_json TEXT NOT NULL DEFAULT '{}',capability_scope_hash TEXT NOT NULL DEFAULT '',
    privacy_risk_json TEXT NOT NULL DEFAULT '[]',requires_user_confirmation INTEGER NOT NULL DEFAULT 0,
    confirmation_reason TEXT NOT NULL DEFAULT '',user_confirmed_at TEXT NOT NULL DEFAULT '',
    generation_error TEXT NOT NULL DEFAULT '',generated_at TEXT NOT NULL DEFAULT '',validated_at TEXT NOT NULL DEFAULT '',
    activated_at TEXT NOT NULL DEFAULT '',archived_at TEXT NOT NULL DEFAULT '',rejected_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(owner_user_id,ubuddy_agent_instance_id,profile_revision),
    UNIQUE(owner_user_id,ubuddy_agent_instance_id,source_effective_skill_hash),
    CHECK(profile_revision>=1),CHECK(publication_state IN ('draft','validated','active','archived','rejected')),
    CHECK(generation_status IN ('pending','generating','completed','failed')),CHECK(requires_user_confirmation IN (0,1))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ubuddy_capability_profiles_one_active
    ON ubuddy_capability_profiles(owner_user_id,ubuddy_agent_instance_id) WHERE publication_state='active';
  CREATE INDEX IF NOT EXISTS idx_ubuddy_capability_profiles_history
    ON ubuddy_capability_profiles(owner_user_id,ubuddy_agent_instance_id,profile_revision DESC)`);
}

function ensureUBuddyDispatchCommandV3Schema(db) {
  const delegationColumns = new Set(db.prepare('PRAGMA table_info(agent_delegations)').all()
    .map((row) => String(row.name || '')));
  if (!delegationColumns.has('client_request_id')) {
    db.exec("ALTER TABLE agent_delegations ADD COLUMN client_request_id TEXT NOT NULL DEFAULT ''");
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_delegations_client_request
    ON agent_delegations(account_workspace_id,requester_user_id,client_request_id)
    WHERE client_request_id <> '';
  CREATE TABLE IF NOT EXISTS ubuddy_dispatch_commands (
    command_id TEXT PRIMARY KEY,account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',owner_user_id TEXT NOT NULL,
    source_session_id TEXT NOT NULL DEFAULT '',source_message_id TEXT NOT NULL DEFAULT '',command_version INTEGER NOT NULL DEFAULT 3,
    status TEXT NOT NULL DEFAULT 'selection_saved',payload_hash TEXT NOT NULL,command_json TEXT NOT NULL DEFAULT '{}',result_json TEXT NOT NULL DEFAULT '{}',
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 10),
    claimed_at TEXT NOT NULL DEFAULT '',lease_expires_at TEXT NOT NULL DEFAULT '',next_attempt_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),completed_at TEXT NOT NULL DEFAULT '',
    CHECK(command_version>=3),CHECK(status IN ('selection_saved','dispatching','published','clarification','retry_wait','failed','cancelled'))
  );
  CREATE INDEX IF NOT EXISTS idx_ubuddy_dispatch_commands_due
    ON ubuddy_dispatch_commands(status,next_attempt_at,lease_expires_at,created_at);
  CREATE INDEX IF NOT EXISTS idx_ubuddy_dispatch_commands_source
    ON ubuddy_dispatch_commands(owner_user_id,source_session_id,source_message_id,created_at)`);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('ubuddy_dispatch_command_v3')").run();
}

function ensureUBuddyPresenceGatedDispatchSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ubuddy_pending_dispatch_assignments (
    command_id TEXT NOT NULL,assignment_id TEXT NOT NULL,recipient_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting_presence',delegation_id TEXT NOT NULL DEFAULT '',group_id TEXT NOT NULL DEFAULT '',
    last_seen_at TEXT NOT NULL DEFAULT '',published_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(command_id,assignment_id),UNIQUE(command_id,recipient_user_id),
    CHECK(status IN ('awaiting_presence','publishing','published','cancelled','failed'))
  );
  CREATE INDEX IF NOT EXISTS idx_ubuddy_pending_dispatch_due
    ON ubuddy_pending_dispatch_assignments(status,updated_at,command_id)`);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('ubuddy_presence_gated_dispatch_v1')").run();
}

function ensureDatabaseWriterFloor100(db) {
  db.prepare("INSERT OR IGNORE INTO schema_migrations(id) VALUES('database_writer_floor_1_0_0_v1')").run();
}

function ensureUBuddySleepWakeSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ubuddy_coordination_states (
    task_run_id TEXT PRIMARY KEY,
    account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
    owner_user_id TEXT NOT NULL DEFAULT '',
    source_session_id TEXT NOT NULL DEFAULT '',
    leader_agent_id TEXT NOT NULL DEFAULT '',
    leader_agent_instance_id TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'planning',
    generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
    current_wake_event_id TEXT NOT NULL DEFAULT '',
    sleep_reason TEXT NOT NULL DEFAULT '',
    state_revision INTEGER NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    waiting_at TEXT NOT NULL DEFAULT '',
    sleeping_at TEXT NOT NULL DEFAULT '',
    awakened_at TEXT NOT NULL DEFAULT '',
    delivering_at TEXT NOT NULL DEFAULT '',
    terminal_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
    CHECK(state IN ('planning','waiting_for_agents','sleeping','awakened','delivering','completed','failed','cancelled'))
  );
  CREATE INDEX IF NOT EXISTS idx_ubuddy_coordination_state
    ON ubuddy_coordination_states(state, updated_at, task_run_id);
  CREATE INDEX IF NOT EXISTS idx_ubuddy_coordination_workspace
    ON ubuddy_coordination_states(account_workspace_id, owner_user_id, state, updated_at);
  CREATE TABLE IF NOT EXISTS ubuddy_wake_outbox (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL,
    coordination_generation INTEGER NOT NULL CHECK (coordination_generation >= 0),
    idempotency_key TEXT NOT NULL UNIQUE,
    account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
    owner_user_id TEXT NOT NULL DEFAULT '',
    source_session_id TEXT NOT NULL DEFAULT '',
    leader_agent_id TEXT NOT NULL DEFAULT '',
    leader_agent_instance_id TEXT NOT NULL DEFAULT '',
    reason_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payload_json TEXT NOT NULL DEFAULT '{}',
    source_task_event_id TEXT NOT NULL DEFAULT '',
    claimed_by TEXT NOT NULL DEFAULT '',
    claimed_at TEXT NOT NULL DEFAULT '',
    lease_expires_at TEXT NOT NULL DEFAULT '',
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    delivery_message_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    delivered_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
    CHECK(reason_code IN ('completion','recovery_required','recovery_exhausted','user_action_required','cancelled','planning_failed')),
    CHECK(status IN ('pending','claimed','failed_retryable','delivered','failed_terminal','cancelled'))
  );
  CREATE INDEX IF NOT EXISTS idx_ubuddy_wake_due
    ON ubuddy_wake_outbox(status, next_attempt_at, lease_expires_at, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ubuddy_wake_task_generation_unique
    ON ubuddy_wake_outbox(task_run_id, coordination_generation);
  CREATE INDEX IF NOT EXISTS idx_ubuddy_wake_task
    ON ubuddy_wake_outbox(task_run_id, coordination_generation, status)`);
  migrateUBuddyFailureRecoveryWakeV1(db);
}

function migrateUBuddyFailureRecoveryWakeV1(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ubuddy_wake_outbox'").get();
  if (!table || /recovery_required/.test(String(table.sql || ''))) return;
  db.exec(`ALTER TABLE ubuddy_wake_outbox RENAME TO ubuddy_wake_outbox_recovery_legacy;
    CREATE TABLE ubuddy_wake_outbox (
      id TEXT PRIMARY KEY,
      task_run_id TEXT NOT NULL,
      coordination_generation INTEGER NOT NULL CHECK (coordination_generation >= 0),
      idempotency_key TEXT NOT NULL UNIQUE,
      account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
      owner_user_id TEXT NOT NULL DEFAULT '',
      source_session_id TEXT NOT NULL DEFAULT '',
      leader_agent_id TEXT NOT NULL DEFAULT '',
      leader_agent_instance_id TEXT NOT NULL DEFAULT '',
      reason_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload_json TEXT NOT NULL DEFAULT '{}',
      source_task_event_id TEXT NOT NULL DEFAULT '',
      claimed_by TEXT NOT NULL DEFAULT '',
      claimed_at TEXT NOT NULL DEFAULT '',
      lease_expires_at TEXT NOT NULL DEFAULT '',
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      delivery_message_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      delivered_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
      CHECK(reason_code IN ('completion','recovery_required','recovery_exhausted','user_action_required','cancelled','planning_failed')),
      CHECK(status IN ('pending','claimed','failed_retryable','delivered','failed_terminal','cancelled'))
    );
    INSERT INTO ubuddy_wake_outbox(
      id,task_run_id,coordination_generation,idempotency_key,account_workspace_id,owner_user_id,source_session_id,
      leader_agent_id,leader_agent_instance_id,reason_code,status,payload_json,source_task_event_id,claimed_by,claimed_at,
      lease_expires_at,attempt_count,next_attempt_at,last_error,delivery_message_id,created_at,updated_at,delivered_at
    ) SELECT id,task_run_id,coordination_generation,idempotency_key,account_workspace_id,owner_user_id,source_session_id,
      leader_agent_id,leader_agent_instance_id,reason_code,status,payload_json,source_task_event_id,claimed_by,claimed_at,
      lease_expires_at,attempt_count,next_attempt_at,last_error,delivery_message_id,created_at,updated_at,delivered_at
      FROM ubuddy_wake_outbox_recovery_legacy;
    DROP TABLE ubuddy_wake_outbox_recovery_legacy;
    CREATE INDEX idx_ubuddy_wake_due
      ON ubuddy_wake_outbox(status, next_attempt_at, lease_expires_at, created_at);
    CREATE UNIQUE INDEX idx_ubuddy_wake_task_generation_unique
      ON ubuddy_wake_outbox(task_run_id, coordination_generation);
    CREATE INDEX idx_ubuddy_wake_task
      ON ubuddy_wake_outbox(task_run_id, coordination_generation, status);`);
}

function ensureUBuddyAgentAllocationSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_work_reservations (
    id TEXT PRIMARY KEY,account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',owner_user_id TEXT NOT NULL DEFAULT '',
    task_run_id TEXT NOT NULL,agent_instance_id TEXT NOT NULL,agent_family_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',metadata_json TEXT NOT NULL DEFAULT '{}',
    reserved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    released_at TEXT NOT NULL DEFAULT '',release_reason TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
    CHECK(status IN ('active','released','cancelled')),UNIQUE(task_run_id,agent_instance_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_work_reservations_one_active
    ON agent_work_reservations(agent_instance_id) WHERE status='active';
  CREATE INDEX IF NOT EXISTS idx_agent_work_reservations_task
    ON agent_work_reservations(task_run_id,status,reserved_at);
  CREATE INDEX IF NOT EXISTS idx_agent_work_reservations_workspace
    ON agent_work_reservations(account_workspace_id,owner_user_id,status,reserved_at);
  CREATE TABLE IF NOT EXISTS ubuddy_agent_wait_requests (
    id TEXT PRIMARY KEY,account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',owner_user_id TEXT NOT NULL DEFAULT '',
    task_run_id TEXT NOT NULL,allocation_key TEXT NOT NULL,agent_family_id TEXT NOT NULL,department_id TEXT NOT NULL DEFAULT '',
    preferred_agent_instance_id TEXT NOT NULL DEFAULT '',candidate_instance_ids_json TEXT NOT NULL DEFAULT '[]',
    task_node_ids_json TEXT NOT NULL DEFAULT '[]',requirements_json TEXT NOT NULL DEFAULT '{}',leader_slot INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 50,status TEXT NOT NULL DEFAULT 'waiting',reservation_id TEXT NOT NULL DEFAULT '',
    matched_agent_instance_id TEXT NOT NULL DEFAULT '',wait_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),matched_at TEXT NOT NULL DEFAULT '',cancelled_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
    CHECK(status IN ('waiting','matched','cancelled')),CHECK(leader_slot IN (0,1)),UNIQUE(task_run_id,allocation_key)
  );
  CREATE INDEX IF NOT EXISTS idx_ubuddy_agent_wait_due
    ON ubuddy_agent_wait_requests(status,created_at,priority,task_run_id);
  CREATE INDEX IF NOT EXISTS idx_ubuddy_agent_wait_task
    ON ubuddy_agent_wait_requests(task_run_id,status,allocation_key)`);
}

function ensureUBuddyCoordinationContractV2(db) {
  const reservationColumns = new Set(db.prepare('PRAGMA table_info(agent_work_reservations)').all().map((row) => String(row.name || '')));
  if (!reservationColumns.has('lease_owner')) db.exec("ALTER TABLE agent_work_reservations ADD COLUMN lease_owner TEXT NOT NULL DEFAULT ''");
  if (!reservationColumns.has('lease_expires_at')) db.exec("ALTER TABLE agent_work_reservations ADD COLUMN lease_expires_at TEXT NOT NULL DEFAULT ''");
  if (!reservationColumns.has('heartbeat_at')) db.exec("ALTER TABLE agent_work_reservations ADD COLUMN heartbeat_at TEXT NOT NULL DEFAULT ''");
  const waitColumns = new Set(db.prepare('PRAGMA table_info(ubuddy_agent_wait_requests)').all().map((row) => String(row.name || '')));
  if (!waitColumns.has('binding_policy')) db.exec("ALTER TABLE ubuddy_agent_wait_requests ADD COLUMN binding_policy TEXT NOT NULL DEFAULT 'family'");
  db.exec(`DROP INDEX IF EXISTS idx_ubuddy_agent_wait_due;
  CREATE INDEX IF NOT EXISTS idx_ubuddy_agent_wait_due
    ON ubuddy_agent_wait_requests(status,priority,created_at,task_run_id);
  CREATE TABLE IF NOT EXISTS ubuddy_planning_jobs (
    id TEXT PRIMARY KEY,task_run_id TEXT NOT NULL UNIQUE,
    account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',owner_user_id TEXT NOT NULL DEFAULT '',
    source_session_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',idempotency_key TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL DEFAULT '{}',result_json TEXT NOT NULL DEFAULT '{}',
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 10),
    claimed_by TEXT NOT NULL DEFAULT '',claimed_at TEXT NOT NULL DEFAULT '',lease_expires_at TEXT NOT NULL DEFAULT '',
    next_attempt_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),completed_at TEXT NOT NULL DEFAULT '',cancelled_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
    CHECK(status IN ('pending','claimed','retry_wait','completed','failed','cancelled'))
  );
  CREATE INDEX IF NOT EXISTS idx_ubuddy_planning_jobs_due
    ON ubuddy_planning_jobs(status,next_attempt_at,lease_expires_at,created_at)`);
  db.prepare("UPDATE sessions SET interaction_mode='',updated_at=MAX(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE lower(trim(interaction_mode))='plan'").run();
  db.prepare(`UPDATE messages SET metadata_json=json_remove(
      json_set(metadata_json,'$.dispatchCommandId',json_extract(metadata_json,'$.dispatchDraftId')),
      '$.dispatchDraftId'
    ),updated_at=MAX(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE json_valid(metadata_json) AND json_type(metadata_json,'$.dispatchDraftId') IS NOT NULL
      AND json_type(metadata_json,'$.dispatchCommandId') IS NULL`).run();
}

function migrateOrganizationMemberFriendships(db) {
  if (db.prepare("SELECT id FROM schema_migrations WHERE id='organization_member_friendships_v1'").get()) return;
  const organizationTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contact_organization_members'").get();
  const friendshipTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='friendships'").get();
  if (!organizationTable || !friendshipTable) return;
  const pairs = db.prepare(
    `SELECT left_member.user_id AS left_id, right_member.user_id AS right_id
     FROM contact_organization_members left_member
     JOIN contact_organization_members right_member
       ON right_member.organization_id = left_member.organization_id
      AND left_member.user_id < right_member.user_id
     GROUP BY left_member.user_id, right_member.user_id`,
  ).all();
  const blocked = db.prepare(
    `SELECT 1 FROM user_blocks
     WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)
     LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT INTO friendships (id,user_a_id,user_b_id,status,updated_at)
     VALUES ('friendship_org_' || lower(hex(randomblob(16))),?,?,'accepted',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(user_a_id,user_b_id) DO UPDATE SET status='accepted',updated_at=excluded.updated_at`,
  );
  for (const pair of pairs) {
    if (!blocked.get(pair.left_id, pair.right_id, pair.right_id, pair.left_id)) insert.run(pair.left_id, pair.right_id);
  }
  db.prepare("INSERT INTO schema_migrations(id) VALUES('organization_member_friendships_v1')").run();
}

function migrateContactOrganizationGovernance(db) {
  if (db.prepare("SELECT id FROM schema_migrations WHERE id='contact_organization_governance_v1'").get()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS contact_organization_exit_requests (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      requester_user_id TEXT NOT NULL,
      requester_role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_by_user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      resolved_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (organization_id) REFERENCES contact_organizations(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_organization_exit_requests_pending
      ON contact_organization_exit_requests(organization_id,requester_user_id) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS idx_contact_organization_exit_requests_org
      ON contact_organization_exit_requests(organization_id,status,created_at);
    CREATE TABLE IF NOT EXISTS contact_organization_notices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      organization_id TEXT NOT NULL DEFAULT '',
      organization_name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      read_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_contact_organization_notices_user
      ON contact_organization_notices(user_id,read_at,created_at);`);
  db.prepare("INSERT INTO schema_migrations(id) VALUES('contact_organization_governance_v1')").run();
}

function migrateAccountPrincipalIsolationV1(db) {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE id='account_principal_isolation_v1'").get()) return;
  const now = new Date().toISOString();
  const activeUserId = String(db.prepare("SELECT value FROM app_settings WHERE key='auth:active_user_id'").get()?.value || '');
  const users = db.prepare('SELECT * FROM auth_users ORDER BY created_at,id').all();
  const principalUserIds = new Set(users.filter((user) => (
    user.id === activeUserId || user.id === 'local_admin' || String(user.password_hash || '') !== ''
  )).map((user) => String(user.id || '')));

  for (const user of users) {
    const userId = String(user.id || '');
    const accountId = personalAccountId(userId);
    if (!accountId) continue;
    const principal = principalUserIds.has(userId);
    db.prepare(`INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
      VALUES(?,'personal',?,'',?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      owner_user_id=excluded.owner_user_id,name=excluded.name,
      status=CASE WHEN accounts.status='deleted' THEN accounts.status ELSE excluded.status END,updated_at=excluded.updated_at`).run(
      accountId, userId, user.display_name || '个人账号', principal ? 'active' : 'external', user.created_at || now, user.updated_at || now,
    );
    db.prepare(`INSERT INTO account_memberships(account_id,user_id,role,status,joined_at,updated_at)
      VALUES(?,?,'owner','active',?,?) ON CONFLICT(account_id,user_id) DO UPDATE SET
      role='owner',status='active',updated_at=excluded.updated_at`).run(accountId, userId, user.created_at || now, user.updated_at || now);
    db.prepare(`INSERT INTO account_workspace_bindings(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
      VALUES(?,?,?,'personal',?,?) ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET
      account_id=excluded.account_id,binding_kind='personal',updated_at=excluded.updated_at`).run(
      accountId, PERSONAL_ACCOUNT_WORKSPACE_ID, userId, user.created_at || now, user.updated_at || now,
    );
    if (principal) {
      const principalKind = user.auth_provider === 'cloud' && user.password_hash
        ? 'hybrid' : user.auth_provider === 'cloud' ? 'cloud' : 'local';
      db.prepare(`INSERT INTO auth_principals(id,user_id,principal_kind,status,created_at,updated_at)
        VALUES(?,?,?,'active',?,?) ON CONFLICT(user_id) DO UPDATE SET
        principal_kind=excluded.principal_kind,status='active',updated_at=excluded.updated_at`).run(
        `principal_${userId}`, userId, principalKind, user.created_at || now, user.updated_at || now,
      );
    }
  }

  for (const workspace of db.prepare("SELECT * FROM account_workspaces WHERE workspace_kind='organization' ORDER BY id").all()) {
    const organizationId = String(workspace.organization_id || '').trim();
    const accountId = organizationAccountId(organizationId);
    if (!accountId) {
      quarantineAccountProjection(db, 'account_workspaces', workspace.id, 'organization_account_missing_organization_id', { workspace });
      continue;
    }
    db.prepare(`INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
      VALUES(?,'organization',?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      owner_user_id=excluded.owner_user_id,organization_id=excluded.organization_id,name=excluded.name,
      status=excluded.status,updated_at=excluded.updated_at`).run(
      accountId, workspace.owner_user_id || '', organizationId, workspace.name || '未命名组织',
      workspace.status === 'active' ? 'active' : 'archived', workspace.created_at || now, workspace.updated_at || now,
    );
    db.prepare(`INSERT INTO account_workspace_bindings(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
      VALUES(?,?,'','organization',?,?) ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET
      account_id=excluded.account_id,binding_kind='organization',updated_at=excluded.updated_at`).run(
      accountId, workspace.id, workspace.created_at || now, workspace.updated_at || now,
    );
    for (const member of db.prepare('SELECT * FROM account_workspace_memberships WHERE workspace_id=?').all(workspace.id)) {
      db.prepare(`INSERT INTO account_memberships(account_id,user_id,role,status,joined_at,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,user_id) DO UPDATE SET
        role=excluded.role,status=excluded.status,updated_at=excluded.updated_at`).run(
        accountId, member.user_id, member.role || 'member', member.status || 'active', member.joined_at || now, member.updated_at || now,
      );
    }
  }

  for (const conversation of db.prepare('SELECT * FROM conversations ORDER BY created_at,id').all()) {
    const userId = String(conversation.owner_user_id || db.prepare(
      "SELECT user_id FROM sessions WHERE conversation_id=? AND user_id!='' ORDER BY created_at,id LIMIT 1",
    ).get(conversation.id)?.user_id || '');
    const accountId = accountIdForLegacyWorkspace(db, conversation.account_workspace_id, userId);
    if (!accountId) {
      quarantineAccountProjection(db, 'conversations', conversation.id, 'conversation_account_ambiguous', { conversation, candidateUserId: userId });
      continue;
    }
    bindConversationAccount(db, conversation.id, accountId, 'anchor', now);
  }

  for (const message of db.prepare('SELECT * FROM social_messages ORDER BY created_at,id').all()) {
    const userA = [String(message.sender_user_id || ''), String(message.recipient_user_id || '')].sort()[0] || '';
    const userB = [String(message.sender_user_id || ''), String(message.recipient_user_id || '')].sort()[1] || userA;
    if (!userA || !userB) {
      quarantineAccountProjection(db, 'social_messages', message.id, 'direct_message_participant_missing', { messageId: message.id });
      continue;
    }
    const workspace = db.prepare('SELECT * FROM account_workspaces WHERE id=?').get(message.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID);
    const organizationDirect = workspace?.workspace_kind === 'organization';
    const anchorAccountId = organizationDirect ? organizationAccountId(workspace.organization_id) : '';
    if (organizationDirect && !anchorAccountId) {
      quarantineAccountProjection(db, 'social_messages', message.id, 'organization_direct_account_missing', { workspaceId: message.account_workspace_id });
      continue;
    }
    const kind = organizationDirect ? 'organization_direct' : 'personal_direct';
    const conversationId = socialDirectConversationId(kind, anchorAccountId, userA, userB);
    db.prepare(`INSERT INTO social_direct_conversations(
        id,conversation_kind,anchor_account_id,user_a_id,user_b_id,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,'active',?,?) ON CONFLICT(conversation_kind,anchor_account_id,user_a_id,user_b_id) DO UPDATE SET
      updated_at=MAX(social_direct_conversations.updated_at,excluded.updated_at)`).run(
      conversationId, kind, anchorAccountId, userA, userB, message.created_at || now, message.updated_at || message.created_at || now,
    );
    db.prepare("UPDATE social_messages SET conversation_id=? WHERE id=? AND conversation_id=''").run(conversationId, message.id);
    if (organizationDirect) {
      bindConversationAccount(db, conversationId, anchorAccountId, 'anchor', message.updated_at || now);
    } else {
      bindConversationAccount(db, conversationId, personalAccountId(userA), 'participant', message.updated_at || now);
      bindConversationAccount(db, conversationId, personalAccountId(userB), 'participant', message.updated_at || now);
    }
  }

  for (const [table, prefix] of [['chat_groups', 'chat_group'], ['collaboration_groups', 'group_conversation']]) {
    for (const group of db.prepare(`SELECT * FROM ${table} ORDER BY created_at,id`).all()) {
      const accountId = accountIdForLegacyWorkspace(db, group.account_workspace_id, group.owner_user_id);
      if (!accountId) {
        quarantineAccountProjection(db, table, group.id, 'group_account_ambiguous', { groupId: group.id });
        continue;
      }
      const conversationId = `${prefix}:${group.id}`;
      bindConversationAccount(db, conversationId, accountId, 'anchor', group.updated_at || now);
      if ((group.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID) === PERSONAL_ACCOUNT_WORKSPACE_ID) {
        const memberTable = table === 'chat_groups' ? 'chat_group_members' : 'collaboration_group_members';
        for (const member of db.prepare(`SELECT user_id FROM ${memberTable} WHERE group_id=?`).all(group.id)) {
          bindConversationAccount(db, conversationId, personalAccountId(member.user_id), 'participant', group.updated_at || now);
        }
      }
    }
  }

  for (const binding of db.prepare('SELECT * FROM workspace_agent_bindings ORDER BY workspace_id,agent_instance_id').all()) {
    const accountId = accountIdForLegacyWorkspace(db, binding.workspace_id, binding.owner_user_id);
    if (!accountId) {
      quarantineAccountProjection(db, 'workspace_agent_bindings', `${binding.workspace_id}:${binding.agent_instance_id}`, 'agent_account_ambiguous', binding);
      continue;
    }
    db.prepare(`INSERT INTO account_agent_instances(
        account_id,agent_instance_id,owner_user_id,visibility,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,agent_instance_id) DO UPDATE SET
      owner_user_id=excluded.owner_user_id,visibility=excluded.visibility,status=excluded.status,updated_at=excluded.updated_at`).run(
      accountId, binding.agent_instance_id, binding.owner_user_id,
      binding.visibility === 'represented' ? 'represented' : 'member_private',
      binding.status === 'active' ? 'active' : 'disabled', binding.created_at || now, binding.updated_at || now,
    );
  }
}

function accountIdForLegacyWorkspace(db, workspaceId = '', userId = '') {
  const workspace = db.prepare('SELECT * FROM account_workspaces WHERE id=?').get(workspaceId || PERSONAL_ACCOUNT_WORKSPACE_ID);
  if (!workspace) return '';
  if (workspace.workspace_kind === 'organization') return organizationAccountId(workspace.organization_id);
  return personalAccountId(userId);
}

function bindConversationAccount(db, conversationId, accountId, role, updatedAt) {
  if (!conversationId || !accountId || !db.prepare('SELECT 1 FROM accounts WHERE id=?').get(accountId)) return false;
  db.prepare(`INSERT INTO conversation_account_bindings(
      conversation_id,account_id,binding_role,access_status,created_at,updated_at
    ) VALUES(?,?,?,'active',?,?) ON CONFLICT(conversation_id,account_id) DO UPDATE SET
    binding_role=CASE WHEN conversation_account_bindings.binding_role='anchor' THEN 'anchor' ELSE excluded.binding_role END,
    access_status='active',updated_at=excluded.updated_at`).run(conversationId, accountId, role, updatedAt, updatedAt);
  return true;
}

function socialDirectConversationId(kind, anchorAccountId, userA, userB) {
  return `social_direct:${kind}:${encodeURIComponent(anchorAccountId || 'personal')}:${encodeURIComponent(userA)}:${encodeURIComponent(userB)}`;
}

function quarantineAccountProjection(db, sourceTable, sourceId, reasonCode, metadata = {}) {
  const ruleId = 'account_principal_isolation_v1';
  const id = `${ruleId}:${sourceTable}:${sourceId}:${reasonCode}`;
  db.prepare(`INSERT INTO database_quarantine_records(
      id,rule_id,source_table,source_id,reason_code,resolution_status,metadata_json
    ) VALUES(?,?,?,?,?,'pending',?) ON CONFLICT(rule_id,source_table,source_id,reason_code) DO UPDATE SET
    resolution_status='pending',metadata_json=excluded.metadata_json,resolved_at=''`).run(
    id, ruleId, sourceTable, String(sourceId || ''), reasonCode, JSON.stringify(metadata || {}),
  );
}

function migrateAccountWorkspaces(db) {
  if (db.prepare("SELECT id FROM schema_migrations WHERE id='account_workspaces_v1'").get()) return;
  ensureLegacyAccountWorkspaceColumns(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO account_workspaces(
      id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at
    ) VALUES(?,'personal','','','个人空间','active',?,?)
    ON CONFLICT(id) DO UPDATE SET status='active',updated_at=excluded.updated_at`).run(PERSONAL_ACCOUNT_WORKSPACE_ID, now, now);
  db.prepare(`INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,display_name,avatar_url,joined_at,updated_at)
    SELECT ?,id,'owner','active',display_name,avatar_url,created_at,? FROM auth_users
    WHERE 1=1
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET status='active',display_name=excluded.display_name,
      avatar_url=excluded.avatar_url,updated_at=excluded.updated_at`).run(PERSONAL_ACCOUNT_WORKSPACE_ID, now);

  const organizations = db.prepare('SELECT * FROM contact_organizations').all();
  const insertWorkspace = db.prepare(`INSERT INTO account_workspaces(
      id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at
    ) VALUES(?,'organization',?,?,?,'active',?,?)
    ON CONFLICT(id) DO UPDATE SET organization_id=excluded.organization_id,owner_user_id=excluded.owner_user_id,
      name=excluded.name,status='active',updated_at=excluded.updated_at`);
  const insertMembership = db.prepare(`INSERT INTO account_workspace_memberships(
      workspace_id,user_id,role,status,display_name,avatar_url,joined_at,updated_at
    ) VALUES(?,?,?,'active',?,?,?,?)
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active',display_name=excluded.display_name,
      avatar_url=excluded.avatar_url,updated_at=excluded.updated_at`);
  for (const organization of organizations) {
    const workspaceId = organizationAccountWorkspaceId(organization.id);
    insertWorkspace.run(workspaceId, organization.id, organization.owner_user_id || '', organization.name || '未命名组织',
      organization.created_at || now, organization.updated_at || now);
    const members = db.prepare(`SELECT membership.*,user.display_name,user.avatar_url
      FROM contact_organization_members membership LEFT JOIN auth_users user ON user.id=membership.user_id
      WHERE membership.organization_id=?`).all(organization.id);
    for (const member of members) insertMembership.run(workspaceId, member.user_id,
      ['owner', 'admin'].includes(member.role) ? member.role : 'member', member.display_name || '', member.avatar_url || '',
      member.joined_at || now, member.updated_at || now);
  }

  const scopedTables = [
    'projects','sessions','messages','model_executions','memory_documents','agent_context_spaces','social_messages',
    'agent_delegations','collaboration_groups','collaboration_group_messages','task_runs','agent_work_queue','agent_delivery_receipts',
  ];
  for (const table of scopedTables) db.exec(`UPDATE "${table}" SET account_workspace_id='${PERSONAL_ACCOUNT_WORKSPACE_ID}'
    WHERE account_workspace_id IS NULL OR account_workspace_id=''`);
  db.exec(`UPDATE messages SET account_workspace_id=COALESCE((SELECT account_workspace_id FROM sessions WHERE sessions.id=messages.session_id),'${PERSONAL_ACCOUNT_WORKSPACE_ID}')`);
  db.exec(`UPDATE collaboration_group_messages SET account_workspace_id=COALESCE((SELECT account_workspace_id FROM collaboration_groups WHERE collaboration_groups.id=collaboration_group_messages.group_id),'${PERSONAL_ACCOUNT_WORKSPACE_ID}')`);
  db.exec(`UPDATE agent_delivery_receipts SET account_workspace_id=COALESCE((SELECT account_workspace_id FROM sessions WHERE sessions.id=agent_delivery_receipts.target_session_id),'${PERSONAL_ACCOUNT_WORKSPACE_ID}')`);
  db.prepare(`INSERT INTO account_workspace_preferences(user_id,device_id,active_workspace_id,updated_at)
    SELECT id,'local',?,? FROM auth_users WHERE 1=1 ON CONFLICT(user_id,device_id) DO NOTHING`).run(PERSONAL_ACCOUNT_WORKSPACE_ID, now);
  db.prepare(`INSERT INTO workspace_agent_bindings(workspace_id,agent_instance_id,owner_user_id,visibility,status,created_at,updated_at)
    SELECT ?,id,user_id,'private','active',created_at,updated_at FROM user_agent_instances
    WHERE 1=1
    ON CONFLICT(workspace_id,agent_instance_id) DO NOTHING`).run(PERSONAL_ACCOUNT_WORKSPACE_ID);
  repairPrimaryAgentSessionUniqueness(db);
  db.exec('DROP INDEX IF EXISTS idx_sessions_one_primary_agent');
  db.exec(`CREATE UNIQUE INDEX idx_sessions_one_primary_agent ON sessions(user_id,account_workspace_id,agent_instance_id)
    WHERE agent_instance_id!='' AND conversation_role='primary' AND write_state='writable' AND status!='deleted'`);
  db.prepare("INSERT INTO schema_migrations(id) VALUES('account_workspaces_v1')").run();
}

function migrateAccountWorkspaceMembershipDomain(db) {
  if (db.prepare("SELECT id FROM schema_migrations WHERE id='account_workspace_membership_domain_v2'").get()) return;
  rebuildTableForAccountWorkspace(db, 'account_workspace_memberships', `CREATE TABLE account_workspace_memberships (
    workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member',status TEXT NOT NULL DEFAULT 'active',
    display_name TEXT NOT NULL DEFAULT '',avatar_url TEXT NOT NULL DEFAULT '',title TEXT NOT NULL DEFAULT '',
    joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(workspace_id,user_id),FOREIGN KEY(workspace_id) REFERENCES account_workspaces(id) ON DELETE CASCADE,
    CHECK(role IN ('owner','admin','member','guest')),CHECK(status IN ('active','suspended','left','removed'))
  )`, "CHECK(role IN ('owner','admin','member','guest')),CHECK(status IN ('active','suspended','left','removed'))");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_account_workspace_memberships_user
    ON account_workspace_memberships(user_id,status,updated_at)`);
  db.prepare("INSERT INTO schema_migrations(id) VALUES('account_workspace_membership_domain_v2')").run();
}

function migrateAccountWorkspaceContextIsolation(db) {
  repairDanglingAccountWorkspaceMigrationTriggers(db);
  if (db.prepare("SELECT id FROM schema_migrations WHERE id='account_workspace_context_isolation_v2'").get()) return;
  ensureLegacyAccountWorkspaceColumns(db);
  db.exec(`DROP TRIGGER IF EXISTS trg_memory_documents_identity_insert;
    DROP TRIGGER IF EXISTS trg_memory_documents_identity_update;
    DROP TRIGGER IF EXISTS trg_memory_document_versions_identity_insert;
    DROP TRIGGER IF EXISTS trg_memory_document_versions_identity_update;
    DROP TRIGGER IF EXISTS trg_memory_documents_work_visibility_insert;
    DROP TRIGGER IF EXISTS trg_memory_documents_work_visibility_update;
    DROP TRIGGER IF EXISTS trg_memory_versions_work_visibility_insert;
    DROP TRIGGER IF EXISTS trg_memory_versions_work_visibility_update;
    DROP TRIGGER IF EXISTS trg_agent_context_spaces_identity_insert;
    DROP TRIGGER IF EXISTS trg_agent_context_spaces_identity_update;
    DROP TRIGGER IF EXISTS trg_agent_device_context_state_identity_insert;
    DROP TRIGGER IF EXISTS trg_agent_device_context_state_identity_update;
    DROP TRIGGER IF EXISTS trg_agent_context_state_identity_insert;
    DROP TRIGGER IF EXISTS trg_agent_context_state_identity_update;`);

  rebuildTableForAccountWorkspace(db, 'memory_documents', `CREATE TABLE memory_documents (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}',
    user_agent_instance_id TEXT NOT NULL,agent_family_id TEXT NOT NULL DEFAULT '',cloud_key TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT 'general',slot_no INTEGER NOT NULL DEFAULT 0,display_name TEXT NOT NULL DEFAULT 'memory0',
    task_run_id TEXT NOT NULL DEFAULT '',project_id TEXT NOT NULL DEFAULT '',relationship_id TEXT NOT NULL DEFAULT '',
    delegation_id TEXT NOT NULL DEFAULT '',group_id TEXT NOT NULL DEFAULT '',relationship_user_id TEXT NOT NULL DEFAULT '',
    context_space_id TEXT NOT NULL DEFAULT '',work_scope_id TEXT NOT NULL DEFAULT '',lifecycle_state TEXT NOT NULL DEFAULT 'active',
    visibility TEXT NOT NULL DEFAULT 'agent_private',sync_enabled INTEGER NOT NULL DEFAULT 1,
    allow_personal_evolution INTEGER NOT NULL DEFAULT 1,allow_cluster_evolution INTEGER NOT NULL DEFAULT 0,
    source_conversation_cursor TEXT NOT NULL DEFAULT '',encryption_key_id TEXT NOT NULL DEFAULT '',
    consent_scope_json TEXT NOT NULL DEFAULT '{}',current_version_id TEXT NOT NULL DEFAULT '',content_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(account_workspace_id,user_agent_instance_id,scope,slot_no,task_run_id,project_id,relationship_id)
  )`, 'UNIQUE(account_workspace_id,user_agent_instance_id,scope,slot_no,task_run_id,project_id,relationship_id)');

  rebuildTableForAccountWorkspace(db, 'agent_context_spaces', `CREATE TABLE agent_context_spaces (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}',
    user_agent_instance_id TEXT NOT NULL,context_kind TEXT NOT NULL,memory_document_id TEXT NOT NULL DEFAULT '',
    project_id TEXT NOT NULL DEFAULT '',task_run_id TEXT NOT NULL DEFAULT '',delegation_id TEXT NOT NULL DEFAULT '',
    group_id TEXT NOT NULL DEFAULT '',relationship_user_id TEXT NOT NULL DEFAULT '',legacy_session_id TEXT NOT NULL DEFAULT '',
    lifecycle_state TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(account_workspace_id,user_agent_instance_id,context_kind,memory_document_id,project_id,task_run_id,delegation_id,group_id,relationship_user_id,legacy_session_id)
  )`, 'UNIQUE(account_workspace_id,user_agent_instance_id,context_kind,memory_document_id,project_id,task_run_id,delegation_id,group_id,relationship_user_id,legacy_session_id)');

  rebuildTableForAccountWorkspace(db, 'agent_context_state', `CREATE TABLE agent_context_state (
    user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}',
    user_agent_instance_id TEXT NOT NULL,primary_session_id TEXT NOT NULL DEFAULT '',active_context_space_id TEXT NOT NULL DEFAULT '',
    active_memory_document_id TEXT NOT NULL DEFAULT '',state_revision INTEGER NOT NULL DEFAULT 1,base_state_revision INTEGER NOT NULL DEFAULT 0,
    last_command_id TEXT NOT NULL DEFAULT '',source_device_id TEXT NOT NULL DEFAULT '',sync_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(user_id,account_workspace_id,user_agent_instance_id),CHECK(state_revision>=1),CHECK(base_state_revision>=0),
    CHECK(sync_status IN ('pending','synced','conflict'))
  )`, 'PRIMARY KEY(user_id,account_workspace_id,user_agent_instance_id)');

  rebuildTableForAccountWorkspace(db, 'agent_device_context_state', `CREATE TABLE agent_device_context_state (
    device_id TEXT NOT NULL,user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL DEFAULT '${PERSONAL_ACCOUNT_WORKSPACE_ID}',
    user_agent_instance_id TEXT NOT NULL,primary_session_id TEXT NOT NULL DEFAULT '',active_context_space_id TEXT NOT NULL DEFAULT '',
    active_memory_document_id TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(device_id,account_workspace_id,user_agent_instance_id)
  )`, 'PRIMARY KEY(device_id,account_workspace_id,user_agent_instance_id)');

  db.exec(`UPDATE agent_context_state SET account_workspace_id=COALESCE(NULLIF((
      SELECT account_workspace_id FROM sessions WHERE id=agent_context_state.primary_session_id
    ),''),NULLIF((SELECT account_workspace_id FROM agent_context_spaces WHERE id=agent_context_state.active_context_space_id),''),
      NULLIF((SELECT account_workspace_id FROM memory_documents WHERE id=agent_context_state.active_memory_document_id),''),'${PERSONAL_ACCOUNT_WORKSPACE_ID}');
    UPDATE agent_device_context_state SET account_workspace_id=COALESCE(NULLIF((
      SELECT account_workspace_id FROM sessions WHERE id=agent_device_context_state.primary_session_id
    ),''),NULLIF((SELECT account_workspace_id FROM agent_context_spaces WHERE id=agent_device_context_state.active_context_space_id),''),
      NULLIF((SELECT account_workspace_id FROM memory_documents WHERE id=agent_device_context_state.active_memory_document_id),''),'${PERSONAL_ACCOUNT_WORKSPACE_ID}');`);
  db.prepare("INSERT INTO schema_migrations(id) VALUES('account_workspace_context_isolation_v2')").run();
}

function rebuildTableForAccountWorkspace(db, tableName, createSql, canonicalFragment) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  if (!row || String(row.sql || '').replace(/\s+/g, '').includes(String(canonicalFragment || '').replace(/\s+/g, ''))) return false;
  const legacyName = `${tableName}_account_workspace_v1`;
  const quotedTable = `"${tableName.replaceAll('"', '""')}"`;
  const quotedLegacy = `"${legacyName.replaceAll('"', '""')}"`;
  const dependentTriggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL")
    .all().filter((trigger) => sqliteSqlReferencesIdentifier(trigger.sql, tableName));
  for (const trigger of dependentTriggers) {
    db.exec(`DROP TRIGGER IF EXISTS "${String(trigger.name || '').replaceAll('"', '""')}"`);
  }
  const columns = db.prepare(`PRAGMA table_info(${quotedTable})`).all().map((column) => String(column.name || ''));
  db.exec(`DROP TABLE IF EXISTS ${quotedLegacy}; ALTER TABLE ${quotedTable} RENAME TO ${quotedLegacy}; ${createSql};`);
  const targetColumns = db.prepare(`PRAGMA table_info(${quotedTable})`).all().map((column) => String(column.name || ''));
  const sharedColumns = targetColumns.filter((column) => columns.includes(column));
  const list = sharedColumns.map((column) => `"${column.replaceAll('"', '""')}"`).join(',');
  db.exec(`INSERT INTO ${quotedTable}(${list}) SELECT ${list} FROM ${quotedLegacy}; DROP TABLE ${quotedLegacy};`);
  for (const trigger of dependentTriggers) db.exec(trigger.sql);
  return true;
}

function repairDanglingAccountWorkspaceMigrationTriggers(db) {
  const temporaryTables = [
    'memory_documents_account_workspace_v1',
    'agent_context_spaces_account_workspace_v1',
    'agent_context_state_account_workspace_v1',
    'agent_device_context_state_account_workspace_v1',
  ];
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL")
    .all().filter((trigger) => temporaryTables.some((tableName) => sqliteSqlReferencesIdentifier(trigger.sql, tableName)));
  for (const trigger of triggers) {
    db.exec(`DROP TRIGGER IF EXISTS "${String(trigger.name || '').replaceAll('"', '""')}"`);
  }
  return triggers.length;
}

function sqliteSqlReferencesIdentifier(sql = '', identifier = '') {
  const escaped = String(identifier || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return false;
  return new RegExp(`(?:^|[^A-Za-z0-9_])(?:"${escaped}"|\\[${escaped}\\]|\`${escaped}\`|${escaped})(?=$|[^A-Za-z0-9_])`, 'i')
    .test(String(sql || ''));
}

function migrateEmployeeInstancesToMultiInstance(db) {
  if (db.prepare("SELECT id FROM schema_migrations WHERE id='employee_multi_instance_v1'").get()) return;
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='user_agent_instances'").get();
  if (!table) return;
  const columns = new Set(db.prepare('PRAGMA table_info(user_agent_instances)').all().map((row) => row.name));
  const singletonConstraint = /UNIQUE\s*\(\s*user_id\s*,\s*agent_family_id\s*\)/i.test(String(table.sql || ''));
  if (!singletonConstraint) {
    if (!columns.has('family_instance_seq')) db.exec('ALTER TABLE user_agent_instances ADD COLUMN family_instance_seq INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('display_name')) db.exec("ALTER TABLE user_agent_instances ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
    if (!columns.has('note')) db.exec("ALTER TABLE user_agent_instances ADD COLUMN note TEXT NOT NULL DEFAULT ''");
    backfillEmployeeInstanceProfiles(db);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_user_agent_instances_user_family
      ON user_agent_instances(user_id,agent_family_id,family_instance_seq,created_at)`);
    return;
  }

  const triggers = db.prepare(`SELECT name,sql FROM sqlite_master
    WHERE type='trigger' AND sql LIKE '%user_agent_instances%' AND sql IS NOT NULL`).all();
  for (const trigger of triggers) db.exec(`DROP TRIGGER IF EXISTS "${String(trigger.name).replaceAll('"', '""')}"`);
  db.exec(`ALTER TABLE user_agent_instances RENAME TO user_agent_instances_singleton_v1;
      CREATE TABLE user_agent_instances (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_family_id TEXT NOT NULL,
        base_agent_version_id TEXT NOT NULL DEFAULT '',
        active_personal_skill_version_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        instance_kind TEXT NOT NULL DEFAULT 'employee',
        employment_state TEXT NOT NULL DEFAULT 'active',
        quota_exempt INTEGER NOT NULL DEFAULT 0,
        recruited_at TEXT NOT NULL DEFAULT '',
        deactivated_at TEXT NOT NULL DEFAULT '',
        last_state_changed_at TEXT NOT NULL DEFAULT '',
        state_revision INTEGER NOT NULL DEFAULT 1,
        recruitment_source TEXT NOT NULL DEFAULT 'legacy',
        policy_version TEXT NOT NULL DEFAULT 'employee_recruitment_phase_a_v1',
        pending_target_state TEXT NOT NULL DEFAULT '',
        authority_state TEXT NOT NULL DEFAULT 'local_confirmed',
        last_employee_command_id TEXT NOT NULL DEFAULT '',
        sync_enabled INTEGER NOT NULL DEFAULT 1,
        personal_evolution_consent INTEGER NOT NULL DEFAULT 1,
        cluster_contribution_consent INTEGER NOT NULL DEFAULT 0,
        personal_skill_auto_activate INTEGER NOT NULL DEFAULT 0,
        family_instance_seq INTEGER NOT NULL DEFAULT 0,
        display_name TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      INSERT INTO user_agent_instances (
        id,user_id,agent_family_id,base_agent_version_id,active_personal_skill_version_id,status,
        instance_kind,employment_state,quota_exempt,recruited_at,deactivated_at,last_state_changed_at,
        state_revision,recruitment_source,policy_version,pending_target_state,authority_state,last_employee_command_id,
        sync_enabled,personal_evolution_consent,cluster_contribution_consent,personal_skill_auto_activate,created_at,updated_at
      ) SELECT id,user_id,agent_family_id,base_agent_version_id,active_personal_skill_version_id,status,
        instance_kind,employment_state,quota_exempt,recruited_at,deactivated_at,last_state_changed_at,
        state_revision,recruitment_source,policy_version,pending_target_state,authority_state,last_employee_command_id,
        sync_enabled,personal_evolution_consent,cluster_contribution_consent,personal_skill_auto_activate,created_at,updated_at
      FROM user_agent_instances_singleton_v1;
      DROP TABLE user_agent_instances_singleton_v1;
      CREATE INDEX idx_user_agent_instances_user_status ON user_agent_instances(user_id,status,updated_at);
      CREATE INDEX idx_user_agent_instances_family ON user_agent_instances(agent_family_id,status,updated_at);
      CREATE INDEX idx_user_agent_instances_user_family ON user_agent_instances(user_id,agent_family_id,family_instance_seq,created_at);`);
  backfillEmployeeInstanceProfiles(db);
  for (const trigger of triggers) db.exec(trigger.sql);
}

function backfillEmployeeInstanceProfiles(db) {
  const rows = db.prepare(`SELECT i.id,i.user_id,i.agent_family_id,i.family_instance_seq,i.display_name,
      COALESCE(f.name,i.agent_family_id,'Agent') AS family_name
    FROM user_agent_instances i LEFT JOIN agent_families f ON f.id=i.agent_family_id
    ORDER BY i.user_id,i.agent_family_id,i.created_at,i.id`).all();
  const counters = new Map();
  const label = (sequence) => {
    let value = Math.max(1, Number(sequence || 1));
    let result = '';
    while (value > 0) { value -= 1; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
    return result;
  };
  const update = db.prepare('UPDATE user_agent_instances SET family_instance_seq=?,display_name=? WHERE id=?');
  for (const row of rows) {
    const key = `${row.user_id}\u001f${row.agent_family_id}`;
    const sequence = Number(row.family_instance_seq || 0) || (Number(counters.get(key) || 0) + 1);
    counters.set(key, Math.max(Number(counters.get(key) || 0), sequence));
    update.run(sequence, row.display_name || `${row.family_name} ${label(sequence)}`, row.id);
  }
}

function migrateEmployeeInstanceProfileUniqueness(db) {
  if (db.prepare("SELECT id FROM schema_migrations WHERE id='employee_instance_profile_uniqueness_v1'").get()) return;
  const rows = db.prepare(`SELECT i.id,i.user_id,i.agent_family_id,i.family_instance_seq,i.display_name,i.created_at,
      COALESCE(f.name,i.agent_family_id,'Agent') AS family_name
    FROM user_agent_instances i
    LEFT JOIN agent_families f ON f.id=i.agent_family_id
    ORDER BY i.user_id,i.agent_family_id,i.created_at,i.id`).all();
  const repaired = repairAgentInstanceProfiles(rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    agentFamilyId: row.agent_family_id,
    familyInstanceSeq: row.family_instance_seq,
    displayName: row.display_name,
    familyName: row.family_name,
    createdAt: row.created_at,
  })));
  const update = db.prepare(`UPDATE user_agent_instances
    SET family_instance_seq=?,display_name=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`);
  for (const profile of repaired) {
    if (!profile.profileChanged) continue;
    update.run(profile.familyInstanceSeq, profile.displayName, profile.id);
  }
  repairPrimaryAgentSessionUniqueness(db);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_agent_instances_unique_family_seq
    ON user_agent_instances(user_id,agent_family_id,family_instance_seq)
    WHERE family_instance_seq>0;
    INSERT INTO schema_migrations(id) VALUES('employee_instance_profile_uniqueness_v1')`);
}

function migrateAgentFamilyDisplayNamesV1(db) {
  if (db.prepare("SELECT id FROM schema_migrations WHERE id='agent_family_display_names_v1'").get()) return;
  const familyIds = ['general_agent', 'ppt'];
  const updateFamily = db.prepare(`UPDATE agent_families SET name=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND name<>?`);
  for (const familyId of familyIds) {
    const family = db.prepare('SELECT name FROM agent_families WHERE id=?').get(familyId);
    if (!family) continue;
    const canonicalName = canonicalAgentFamilyName(familyId, family.name);
    updateFamily.run(canonicalName, familyId, canonicalName);
  }
  const rows = db.prepare(`SELECT i.id,i.agent_family_id,i.family_instance_seq,i.display_name,
      COALESCE(f.name,i.agent_family_id,'Agent') AS family_name
    FROM user_agent_instances i LEFT JOIN agent_families f ON f.id=i.agent_family_id
    WHERE i.agent_family_id IN ('general_agent','ppt') ORDER BY i.user_id,i.agent_family_id,i.family_instance_seq,i.id`).all();
  const updateInstance = db.prepare(`UPDATE user_agent_instances SET display_name=?,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`);
  for (const row of rows) {
    const displayName = canonicalAgentInstanceDisplayName({
      agentFamilyId: row.agent_family_id,
      familyName: row.family_name,
      displayName: row.display_name,
      sequence: row.family_instance_seq || 1,
    });
    if (displayName !== String(row.display_name || '').trim()) updateInstance.run(displayName, row.id);
  }
  db.prepare("INSERT INTO schema_migrations(id) VALUES('agent_family_display_names_v1')").run();
}

function migrateAgentFamilyNameAlignmentV2(db) {
  if (db.prepare("SELECT id FROM schema_migrations WHERE id='agent_family_name_alignment_v2'").get()) return;
  const families = db.prepare('SELECT id,name FROM agent_families ORDER BY id').all();
  const alignedFamilyIds = new Set();
  const updateFamily = db.prepare(`UPDATE agent_families SET name=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND name<>?`);
  for (const family of families) {
    const canonicalName = canonicalAgentFamilyName(family.id, family.name);
    if (!agentFamilyNameUsesCanonicalTemplate(family.id, family.name)) continue;
    alignedFamilyIds.add(family.id);
    updateFamily.run(canonicalName, family.id, canonicalName);
  }
  if (alignedFamilyIds.size) {
    const placeholders = [...alignedFamilyIds].map(() => '?').join(',');
    const rows = db.prepare(`SELECT i.id,i.agent_family_id,i.family_instance_seq,i.display_name,f.name AS family_name
      FROM user_agent_instances i JOIN agent_families f ON f.id=i.agent_family_id
      WHERE i.agent_family_id IN (${placeholders}) ORDER BY i.user_id,i.agent_family_id,i.family_instance_seq,i.id`).all(...alignedFamilyIds);
    const updateInstance = db.prepare(`UPDATE user_agent_instances SET display_name=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`);
    for (const row of rows) {
      const displayName = canonicalAgentInstanceDisplayName({
        agentFamilyId: row.agent_family_id,
        familyName: row.family_name,
        displayName: row.display_name,
        sequence: row.family_instance_seq || 1,
      });
      if (displayName !== String(row.display_name || '').trim()) updateInstance.run(displayName, row.id);
    }
  }
  db.prepare("INSERT INTO schema_migrations(id) VALUES('agent_family_name_alignment_v2')").run();
}

function migrateAgentInstanceSequenceCompactionV3(db) {
  if (db.prepare("SELECT id FROM schema_migrations WHERE id='agent_instance_sequence_compaction_v3'").get()) return;
  const rows = db.prepare(`SELECT i.id,i.user_id,i.agent_family_id,i.family_instance_seq,i.display_name,
      i.recruited_at,i.created_at,COALESCE(f.name,i.agent_family_id,'Agent') AS family_name,
      EXISTS(SELECT 1 FROM user_agent_instance_aliases alias WHERE alias.alias_instance_id=i.id) AS is_alias
    FROM user_agent_instances i LEFT JOIN agent_families f ON f.id=i.agent_family_id
    WHERE i.instance_kind='employee' ORDER BY i.user_id,i.agent_family_id,i.recruited_at,i.created_at,i.id`).all();
  const compacted = compactAgentInstanceProfiles(rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    agentFamilyId: row.agent_family_id,
    familyInstanceSeq: row.family_instance_seq,
    displayName: row.display_name,
    familyName: row.family_name,
    recruitedAt: row.recruited_at,
    createdAt: row.created_at,
    isAlias: Boolean(row.is_alias),
  })));
  db.exec('DROP INDEX IF EXISTS idx_user_agent_instances_unique_family_seq');
  const update = db.prepare(`UPDATE user_agent_instances SET family_instance_seq=?,display_name=?,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`);
  for (const profile of compacted) {
    if (!profile.profileChanged) continue;
    update.run(profile.familyInstanceSeq, profile.displayName, profile.id);
  }
  db.exec(`CREATE UNIQUE INDEX idx_user_agent_instances_unique_family_seq
    ON user_agent_instances(user_id,agent_family_id,family_instance_seq)
    WHERE family_instance_seq>0;
    INSERT INTO schema_migrations(id) VALUES('agent_instance_sequence_compaction_v3')`);
}

function migrateLegacyGeneralAgentFamilies(db) {
  if (db.prepare("SELECT id FROM schema_migrations WHERE id='general_agent_family_consolidation_v1'").get()) return;
  repairLegacyGeneralAgentFamilies(db);
}

function migrateLegacyGeneralAgentCatalogRepairV2(db) {
  if (db.prepare("SELECT id FROM schema_migrations WHERE id='general_agent_catalog_repair_v2'").get()) return;
  repairLegacyGeneralAgentFamilies(db);
  db.prepare("INSERT INTO schema_migrations(id) VALUES('general_agent_catalog_repair_v2')").run();
}

function repairLegacyGeneralAgentFamilies(db) {
  const legacyIds = db.prepare("SELECT id FROM agent_families WHERE id GLOB 'general_agent_[0-9]*'").all()
    .map((row) => row.id)
    .filter((id) => /^general_agent_[1-9][0-9]*$/u.test(id));
  if (!legacyIds.length) return;
  const placeholders = legacyIds.map(() => '?').join(',');
  const canonical = db.prepare("SELECT id,current_version_id FROM agent_families WHERE id='general_agent'").get();
  const legacyFamilies = db.prepare(`SELECT id FROM agent_families WHERE id IN (${placeholders})`).all(...legacyIds);
  if (!canonical || !legacyFamilies.length) return;

  const legacyInstances = db.prepare(`SELECT id,user_id,agent_family_id,family_instance_seq,display_name,created_at
    FROM user_agent_instances WHERE agent_family_id IN (${placeholders}) ORDER BY user_id,created_at,id`).all(...legacyIds);
  const nextByUser = new Map();
  const maxSequence = db.prepare(`SELECT COALESCE(MAX(family_instance_seq),0) AS value
    FROM user_agent_instances WHERE user_id=? AND agent_family_id='general_agent'`);
  const updateInstance = db.prepare(`UPDATE user_agent_instances SET agent_family_id='general_agent',
    base_agent_version_id=CASE WHEN ?<>'' THEN ? ELSE base_agent_version_id END,
    family_instance_seq=?,display_name=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`);
  for (const instance of legacyInstances) {
    let next = nextByUser.get(instance.user_id);
    if (!next) next = Number(maxSequence.get(instance.user_id)?.value || 0) + 1;
    nextByUser.set(instance.user_id, next + 1);
    const currentDisplayName = String(instance.display_name || '').trim();
    const defaultLike = !currentDisplayName
      || currentDisplayName === `Generalist ${agentInstanceSequenceLabelForMigration(instance.family_instance_seq || 1)}`
      || /^(?:General Agent|通用 Agent) [1-9][0-9]*(?: [A-Z]+)?$/u.test(currentDisplayName);
    updateInstance.run(canonical.current_version_id || '', canonical.current_version_id || '', next,
      defaultLike ? `Generalist ${agentInstanceSequenceLabelForMigration(next)}` : instance.display_name, instance.id);
  }

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const familyIdTablesToSkip = new Set(['agent_families', 'agent_versions', 'legacy_memory_candidates']);
  const directAgentColumns = new Set([
    'agent_id', 'lead_agent_id', 'from_agent_id', 'to_agent_id', 'sender_agent_id',
    'origin_agent_id', 'target_agent_id', 'reviewer_agent_id',
  ]);
  for (const { name } of tables) {
    const quotedTable = `"${String(name).replaceAll('"', '""')}"`;
    const columns = db.prepare(`PRAGMA table_info(${quotedTable})`).all().map((row) => row.name);
    if (columns.includes('agent_family_id') && !familyIdTablesToSkip.has(name)) {
      db.prepare(`UPDATE ${quotedTable} SET agent_family_id='general_agent' WHERE agent_family_id IN (${placeholders})`).run(...legacyIds);
    }
    for (const column of columns.filter((value) => directAgentColumns.has(value))) {
      const quotedColumn = `"${String(column).replaceAll('"', '""')}"`;
      db.prepare(`UPDATE ${quotedTable} SET ${quotedColumn}='general_agent' WHERE ${quotedColumn} IN (${placeholders})`).run(...legacyIds);
    }
  }

  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='legacy_memory_candidates'").get()) {
    db.prepare(`INSERT OR IGNORE INTO legacy_memory_candidates(
      id,agent_family_id,content,content_hash,template_hash,source_path,review_status,created_at
    ) SELECT id,'general_agent',content,content_hash,template_hash,source_path,review_status,created_at
      FROM legacy_memory_candidates WHERE agent_family_id IN (${placeholders})`).run(...legacyIds);
    db.prepare(`DELETE FROM legacy_memory_candidates WHERE agent_family_id IN (${placeholders})`).run(...legacyIds);
  }
  db.prepare(`UPDATE agent_families SET status='retired',routable=0,instance_kind='unavailable',
    recruitable=0,default_for_new_user=0,quota_cost=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id IN (${placeholders})`).run(...legacyIds);
}

function agentInstanceSequenceLabelForMigration(sequence = 1) {
  let value = Math.max(1, Math.floor(Number(sequence) || 1));
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function migratePhase6ConversationIdentity(db) {
  const requiredTables = ['conversations', 'conversation_aliases', 'task_workspaces', 'message_attachments'];
  if (requiredTables.some((name) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))) return;

  const identityApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE id='conversation_identity_phase6_v1'").get();
  if (!identityApplied) {
    const sessions = db.prepare(`SELECT * FROM sessions ORDER BY
      CASE conversation_role WHEN 'primary' THEN 0 WHEN 'standard' THEN 1 ELSE 2 END,created_at,id`).all();
    const byId = new Map(sessions.map((row) => [row.id, row]));
    const primaryByAgent = new Map();
    for (const row of sessions) {
      if (!row.agent_instance_id || row.conversation_role !== 'primary' || row.write_state !== 'writable' || row.status === 'deleted') continue;
      primaryByAgent.set(`${row.account_workspace_id || 'workspace_personal'}\u001f${row.user_id}\u001f${row.agent_instance_id}`, row);
    }
    const resolvedConversationId = new Map();
    const resolveConversationId = (row) => {
      if (resolvedConversationId.has(row.id)) return resolvedConversationId.get(row.id);
      let target = row;
      const superseded = row.superseded_by_session_id ? byId.get(row.superseded_by_session_id) : null;
      if (superseded) target = superseded;
      else if (row.agent_instance_id && row.conversation_role === 'history') {
        target = primaryByAgent.get(`${row.account_workspace_id || 'workspace_personal'}\u001f${row.user_id}\u001f${row.agent_instance_id}`) || row;
      }
      const id = String(target.conversation_id || target.id || row.id);
      resolvedConversationId.set(row.id, id);
      return id;
    };
    const upsertConversation = db.prepare(`INSERT INTO conversations(
      id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,project_id,workspace_root,status,created_at,updated_at
    ) VALUES(?,?,'direct',?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      account_workspace_id=excluded.account_workspace_id,owner_user_id=excluded.owner_user_id,
      title=CASE WHEN conversations.title='Untitled' THEN excluded.title ELSE conversations.title END,
      agent_id=COALESCE(NULLIF(conversations.agent_id,''),excluded.agent_id),
      agent_instance_id=COALESCE(NULLIF(conversations.agent_instance_id,''),excluded.agent_instance_id),
      project_id=excluded.project_id,workspace_root=excluded.workspace_root,status=excluded.status,
      updated_at=MAX(conversations.updated_at,excluded.updated_at)`);
    const updateSession = db.prepare('UPDATE sessions SET conversation_id=? WHERE id=?');
    const insertAlias = db.prepare(`INSERT INTO conversation_aliases(alias_id,conversation_id,alias_kind,reason)
      VALUES(?,?,'legacy_session','phase6_backfill') ON CONFLICT(alias_id) DO UPDATE SET
      conversation_id=excluded.conversation_id,alias_kind=excluded.alias_kind,reason=excluded.reason`);
    for (const row of sessions) {
      const conversationId = resolveConversationId(row);
      const canonical = byId.get(conversationId) || row;
      upsertConversation.run(
        conversationId, canonical.account_workspace_id || 'workspace_personal', canonical.user_id || '', canonical.title || 'Untitled',
        canonical.agent_id || '', canonical.agent_instance_id || '', canonical.project_id || '', canonical.workspace_root || '',
        canonical.status || 'active', canonical.created_at || '', canonical.updated_at || canonical.created_at || '',
      );
      updateSession.run(conversationId, row.id);
      insertAlias.run(row.id, conversationId);
    }
    db.exec(`UPDATE conversations SET status='deleted',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id IN (SELECT alias_id FROM conversation_aliases WHERE alias_id!=conversation_id)`);
    db.prepare("INSERT INTO schema_migrations(id) VALUES('conversation_identity_phase6_v1')").run();
  }

  const unifiedApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE id='unified_message_store_phase6_v1'").get();
  if (!unifiedApplied) {
    db.exec(`UPDATE messages SET conversation_id=COALESCE(NULLIF(conversation_id,''),(
        SELECT COALESCE(NULLIF(s.conversation_id,''),s.id) FROM sessions s WHERE s.id=messages.session_id
      ),session_id)
      WHERE conversation_id='';
      UPDATE messages SET memory_id=COALESCE(NULLIF(memory_id,''),(
        SELECT c.memory_document_id FROM agent_context_spaces c WHERE c.id=messages.context_space_id
      ),'') WHERE memory_id='' AND NOT (json_valid(metadata_json)
        AND json_type(metadata_json,'$.databaseRecovery.orphanedMemoryId') IS NOT NULL);
      UPDATE model_executions SET conversation_id=COALESCE((
        SELECT COALESCE(NULLIF(s.conversation_id,''),s.id) FROM sessions s WHERE s.id=model_executions.conversation_id
      ),conversation_id);`);
    const insertAttachment = db.prepare(`INSERT OR IGNORE INTO message_attachments(
      id,account_workspace_id,conversation_id,message_id,task_workspace_id,file_id,relation_type,name,
      content_type,size_bytes,sha256,local_path,remote_file_id,metadata_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,'attachment',?,?,?,?,?,?,?,?,?)`);
    for (const row of db.prepare(`SELECT id,account_workspace_id,conversation_id,task_workspace_id,metadata_json,created_at,updated_at
      FROM messages WHERE metadata_json LIKE '%attachments%'`).all()) {
      let metadata = {};
      try { metadata = JSON.parse(row.metadata_json || '{}'); } catch { metadata = {}; }
      for (const attachment of Array.isArray(metadata.attachments) ? metadata.attachments : []) {
        const name = String(attachment?.name || attachment?.filename || '').trim();
        const fileId = String(attachment?.fileId || attachment?.file_id || attachment?.id || '').trim();
        if (!name && !fileId) continue;
        const stableKey = Buffer.from(`${row.id}\nattachment\n${fileId}\n${name}`).toString('hex').slice(0, 80);
        insertAttachment.run(
          `message_attachment_${stableKey}`, row.account_workspace_id || 'workspace_personal', row.conversation_id || '', row.id,
          row.task_workspace_id || '', fileId, name,
          attachment?.contentType || attachment?.content_type || attachment?.type || '',
          Math.max(0, Number(attachment?.sizeBytes || attachment?.size_bytes || attachment?.size || 0) || 0),
          attachment?.sha256 || '', attachment?.path || attachment?.localPath || attachment?.local_path || '',
          attachment?.remoteFileId || attachment?.remote_file_id || '', JSON.stringify(attachment || {}),
          row.created_at || '', row.updated_at || row.created_at || '',
        );
      }
    }
    db.prepare("INSERT INTO schema_migrations(id) VALUES('unified_message_store_phase6_v1')").run();
  }

  const recoveryApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE id='workspace_split_recovery_phase6_v1'").get();
  if (!recoveryApplied) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_delegation_workspaces'").get()) {
      const claimedTaskWorkspaceConversations = new Map();
      for (const workspace of db.prepare(`SELECT delegation_id,owner_user_id,conversation_id FROM task_workspaces
        WHERE conversation_id!='' ORDER BY created_at,id`).all()) {
        const key = `${workspace.delegation_id}\u001f${workspace.owner_user_id}`;
        if (!claimedTaskWorkspaceConversations.has(workspace.conversation_id)) {
          claimedTaskWorkspaceConversations.set(workspace.conversation_id, key);
        }
      }
      const rows = db.prepare(`SELECT w.delegation_id,w.user_id,w.session_id,w.metadata_json,
          COALESCE(s.conversation_id,s.id,'') AS conversation_id,COALESCE(s.account_workspace_id,'workspace_personal') AS account_workspace_id,
          COALESCE(s.workspace_root,'') AS workspace_root,COALESCE(d.task_run_id,'') AS task_run_id,
          COALESCE(d.group_id,'') AS group_id,COALESCE(s.title,d.title,'uBuddy task workspace') AS title,
          COALESCE(s.created_at,w.created_at,'') AS created_at,COALESCE(s.updated_at,w.updated_at,'') AS updated_at
        FROM agent_delegation_workspaces w
        LEFT JOIN sessions s ON s.id=w.session_id
        LEFT JOIN agent_delegations d ON d.id=w.delegation_id
        WHERE w.session_id!='' ORDER BY w.created_at,w.delegation_id,w.user_id`).all();
      for (const row of rows) {
        if (!row.conversation_id) continue;
        const taskWorkspaceId = `task_workspace:${row.delegation_id}:${row.user_id}`;
        const workspaceKey = `${row.delegation_id}\u001f${row.user_id}`;
        const existingWorkspace = db.prepare(`SELECT conversation_id FROM task_workspaces
          WHERE delegation_id=? AND owner_user_id=?`).get(row.delegation_id, row.user_id);
        let conversationId = String(existingWorkspace?.conversation_id || row.conversation_id || '');
        const claimant = claimedTaskWorkspaceConversations.get(conversationId);
        if (claimant && claimant !== workspaceKey) {
          const recovered = ensureRecoveredTaskWorkspaceSession(db, row, taskWorkspaceId);
          conversationId = recovered.conversationId;
        }
        claimedTaskWorkspaceConversations.set(conversationId, workspaceKey);
        db.prepare(`INSERT INTO conversations(
          id,account_workspace_id,conversation_kind,owner_user_id,title,group_id,task_workspace_id,workspace_root,
          status,created_at,updated_at
        ) VALUES(?,?,'task_workspace',?,?,?,?,?,'active',?,?) ON CONFLICT(id) DO UPDATE SET
          account_workspace_id=excluded.account_workspace_id,conversation_kind='task_workspace',owner_user_id=excluded.owner_user_id,
          title=CASE WHEN conversations.title='Untitled' THEN excluded.title ELSE conversations.title END,
          group_id=excluded.group_id,task_workspace_id=excluded.task_workspace_id,workspace_root=excluded.workspace_root,
          status=CASE WHEN conversations.status='deleted' THEN 'active' ELSE conversations.status END,
          updated_at=MAX(conversations.updated_at,excluded.updated_at)`).run(
          conversationId, row.account_workspace_id, row.user_id, row.title || 'uBuddy task workspace', row.group_id || '',
          taskWorkspaceId, row.workspace_root, row.created_at || '', row.updated_at || '',
        );
        db.prepare(`INSERT INTO task_workspaces(
          id,account_workspace_id,delegation_id,task_run_id,group_id,owner_user_id,conversation_id,workspace_root,
          workspace_epoch,visibility,status,metadata_json,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,'private','active',?,?,?) ON CONFLICT(delegation_id,owner_user_id) DO UPDATE SET
          conversation_id=excluded.conversation_id,workspace_root=excluded.workspace_root,workspace_epoch=excluded.workspace_epoch,
          metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`).run(
          taskWorkspaceId, row.account_workspace_id, row.delegation_id, row.task_run_id, row.group_id, row.user_id,
          conversationId, row.workspace_root, taskWorkspaceEpochFromMetadata(row.metadata_json), row.metadata_json || '{}',
          row.created_at || '', row.updated_at || '',
        );
        db.prepare(`UPDATE messages SET task_workspace_id=? WHERE conversation_id=? AND task_workspace_id=''`).run(
          taskWorkspaceId, conversationId,
        );
      }
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collaboration_groups'").get()) {
      db.exec(`INSERT OR IGNORE INTO conversations(
        id,account_workspace_id,conversation_kind,owner_user_id,title,group_id,status,created_at,updated_at
      ) SELECT 'group_conversation:'||id,account_workspace_id,'group',owner_user_id,title,id,
        CASE WHEN status='closed' THEN 'archived' ELSE 'active' END,created_at,updated_at FROM collaboration_groups;
      INSERT OR IGNORE INTO conversation_aliases(alias_id,conversation_id,alias_kind,reason)
        SELECT id,'group_conversation:'||id,'group_id','phase6_group_binding' FROM collaboration_groups;
      INSERT OR IGNORE INTO messages(
        id,account_workspace_id,conversation_id,session_id,memory_id,task_workspace_id,sender_user_id,
        source_event_id,role,content,agent_id,department_id,visible,metadata_json,created_at,updated_at
      ) SELECT gm.id,gm.account_workspace_id,'group_conversation:'||gm.group_id,'','','',gm.sender_user_id,
        gm.source_event_id,CASE WHEN gm.kind='system' THEN 'system' WHEN gm.sender_agent_id!='' THEN 'assistant' ELSE 'user' END,
        gm.content,gm.sender_agent_id,'collaboration',1,gm.metadata_json,gm.created_at,gm.updated_at
      FROM collaboration_group_messages gm`);
    }
    db.prepare("INSERT INTO schema_migrations(id) VALUES('workspace_split_recovery_phase6_v1')").run();
  }
  repairPhase6UniqueIndexCollisions(db);
}

function ensureRecoveredTaskWorkspaceSession(db, row = {}, taskWorkspaceId = '') {
  const source = db.prepare('SELECT * FROM sessions WHERE id=?').get(row.session_id);
  const conversationId = `${taskWorkspaceId}:conversation`;
  const sessionId = `${taskWorkspaceId}:session`;
  const createdAt = source?.created_at || row.created_at || new Date().toISOString();
  const updatedAt = source?.updated_at || row.updated_at || createdAt;
  db.prepare(`INSERT INTO sessions(
      id,conversation_id,user_id,account_workspace_id,title,department_id,agent_id,agent_instance_id,
      project_id,workspace_root,interaction_mode,memory_use_enabled,memory_generate_enabled,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,'agent_delegation',?,?,?,?,?,?,?,'active',?,?) ON CONFLICT(id) DO UPDATE SET
      conversation_id=excluded.conversation_id,user_id=excluded.user_id,account_workspace_id=excluded.account_workspace_id,
      title=excluded.title,department_id='agent_delegation',agent_id=excluded.agent_id,agent_instance_id=excluded.agent_instance_id,
      project_id=excluded.project_id,workspace_root=excluded.workspace_root,interaction_mode=excluded.interaction_mode,
      memory_use_enabled=excluded.memory_use_enabled,memory_generate_enabled=excluded.memory_generate_enabled,
      status='active',updated_at=excluded.updated_at`).run(
    sessionId, conversationId, row.user_id || source?.user_id || '', row.account_workspace_id || source?.account_workspace_id || 'workspace_personal',
    row.title || source?.title || 'uBuddy task workspace', source?.agent_id || 'secretary_agent', source?.agent_instance_id || '',
    source?.project_id || '', row.workspace_root || source?.workspace_root || '', source?.interaction_mode || '',
    Number(source?.memory_use_enabled ?? 1), Number(source?.memory_generate_enabled ?? 0), createdAt, updatedAt,
  );
  db.prepare(`UPDATE agent_delegation_workspaces SET session_id=?,updated_at=MAX(updated_at,?)
    WHERE delegation_id=? AND user_id=?`).run(sessionId, updatedAt, row.delegation_id, row.user_id);
  db.prepare(`UPDATE agent_delegations SET session_id=?,updated_at=MAX(updated_at,?)
    WHERE id=? AND recipient_user_id=? AND session_id=?`).run(sessionId, updatedAt, row.delegation_id, row.user_id, row.session_id);
  return { conversationId, sessionId };
}

function repairPhase6UniqueIndexCollisions(db) {
  const groupDuplicates = db.prepare(`SELECT group_id FROM conversations
      WHERE conversation_kind='group' AND group_id!='' GROUP BY group_id HAVING COUNT(*)>1
      ORDER BY group_id`).all();
  const taskWorkspaceDuplicates = db.prepare(`SELECT task_workspace_id FROM conversations
      WHERE task_workspace_id!='' GROUP BY task_workspace_id HAVING COUNT(*)>1
      ORDER BY task_workspace_id`).all();
  const messageEventDuplicates = db.prepare(`SELECT 1 FROM messages WHERE source_event_id!=''
      GROUP BY conversation_id,source_event_id HAVING COUNT(*)>1 LIMIT 1`).get();
  const organizationDuplicates = db.prepare(`SELECT organization_id FROM account_workspaces
      WHERE organization_id!='' GROUP BY organization_id HAVING COUNT(*)>1 ORDER BY organization_id`).all();
  const groupIndexSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_conversations_group'").get()?.sql || '');
  if (!/conversation_kind\s*=\s*['"]group['"]/i.test(groupIndexSql) || groupDuplicates.length) {
    db.exec('DROP INDEX IF EXISTS idx_conversations_group');
  }
  if (taskWorkspaceDuplicates.length) db.exec('DROP INDEX IF EXISTS idx_conversations_task_workspace');
  if (messageEventDuplicates || groupDuplicates.length || taskWorkspaceDuplicates.length) {
    db.exec('DROP INDEX IF EXISTS idx_messages_conversation_source_event');
  }
  if (organizationDuplicates.length) db.exec('DROP INDEX IF EXISTS idx_account_workspaces_organization');

  for (const duplicate of groupDuplicates) {
    const rows = db.prepare(`SELECT id,status,created_at FROM conversations
      WHERE conversation_kind='group' AND group_id=?
      ORDER BY CASE WHEN id=? THEN 0 WHEN status='active' THEN 1 ELSE 2 END,created_at,id`).all(
      duplicate.group_id, `group_conversation:${duplicate.group_id}`,
    );
    const winner = rows[0];
    for (const loser of rows.slice(1)) {
      if (!rebindConversationReferences(db, loser.id, winner.id)) {
        db.prepare(`UPDATE conversations SET group_id='',conversation_kind=CASE
          WHEN task_workspace_id!='' THEN 'task_workspace' ELSE 'direct' END,
          updated_at=MAX(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?`).run(loser.id);
      }
    }
  }

  for (const duplicate of taskWorkspaceDuplicates) {
    const boundConversationId = db.prepare('SELECT conversation_id FROM task_workspaces WHERE id=?')
      .get(duplicate.task_workspace_id)?.conversation_id || '';
    const rows = db.prepare(`SELECT id,status,created_at FROM conversations WHERE task_workspace_id=?
      ORDER BY CASE WHEN id=? THEN 0 WHEN status='active' THEN 1 ELSE 2 END,created_at,id`).all(
      duplicate.task_workspace_id, boundConversationId,
    );
    const winner = rows[0];
    for (const loser of rows.slice(1)) {
      if (!rebindConversationReferences(db, loser.id, winner.id)) {
        db.prepare(`UPDATE conversations SET task_workspace_id='',conversation_kind=CASE
          WHEN group_id!='' THEN 'group' ELSE 'direct' END,
          updated_at=MAX(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?`).run(loser.id);
      }
    }
  }

  const seenMessageEvents = new Set();
  const clearMessageSourceEvent = db.prepare("UPDATE messages SET source_event_id='',updated_at=MAX(updated_at,created_at) WHERE id=?");
  for (const row of db.prepare(`SELECT id,conversation_id,source_event_id FROM messages
      WHERE source_event_id!='' ORDER BY conversation_id,source_event_id,created_at,id`).all()) {
    const key = `${row.conversation_id}\u001f${row.source_event_id}`;
    if (seenMessageEvents.has(key)) clearMessageSourceEvent.run(row.id);
    else seenMessageEvents.add(key);
  }

  for (const duplicate of organizationDuplicates) {
    const expectedId = organizationAccountWorkspaceId(duplicate.organization_id);
    const rows = db.prepare(`SELECT id,status,created_at FROM account_workspaces WHERE organization_id=?
      ORDER BY CASE WHEN id=? THEN 0 WHEN status='active' THEN 1 ELSE 2 END,created_at,id`).all(
      duplicate.organization_id, expectedId,
    );
    for (const loser of rows.slice(1)) {
      db.prepare(`UPDATE account_workspaces SET organization_id='',status='deleted',
        updated_at=MAX(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?`).run(loser.id);
    }
  }
}

function rebindConversationReferences(db, loserId = '', winnerId = '') {
  if (!loserId || !winnerId || loserId === winnerId) return true;
  const winnerTaskWorkspace = db.prepare('SELECT id FROM task_workspaces WHERE conversation_id=?').get(winnerId);
  const loserTaskWorkspaces = db.prepare('SELECT id FROM task_workspaces WHERE conversation_id=?').all(loserId);
  if (winnerTaskWorkspace && loserTaskWorkspaces.some((row) => row.id !== winnerTaskWorkspace.id)) return false;
  for (const [tableName, columnName] of [
    ['sessions', 'conversation_id'], ['messages', 'conversation_id'], ['model_executions', 'conversation_id'],
    ['message_attachments', 'conversation_id'], ['conversation_aliases', 'conversation_id'], ['task_workspaces', 'conversation_id'],
  ]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName)) continue;
    db.prepare(`UPDATE "${tableName}" SET "${columnName}"=? WHERE "${columnName}"=?`).run(winnerId, loserId);
  }
  db.prepare('DELETE FROM conversations WHERE id=?').run(loserId);
  db.prepare(`INSERT INTO conversation_aliases(alias_id,conversation_id,alias_kind,reason)
    VALUES(?,?,'recovered_conversation','phase6_unique_collision_repair') ON CONFLICT(alias_id) DO UPDATE SET
    conversation_id=excluded.conversation_id,alias_kind=excluded.alias_kind,reason=excluded.reason`).run(loserId, winnerId);
  return true;
}

function taskWorkspaceEpochFromMetadata(metadataJson = '') {
  try {
    const metadata = JSON.parse(metadataJson || '{}');
    return String(metadata.workspaceEpoch || metadata.workspace_epoch || '');
  } catch {
    return '';
  }
}
