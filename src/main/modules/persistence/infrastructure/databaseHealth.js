import crypto from 'node:crypto';

const requiredColumns = {
  schema_migrations: ['id', 'applied_at'],
  auth_users: ['id', 'remote_id', 'remote_bound_at'],
  account_workspaces: ['id', 'workspace_kind', 'status'],
  account_workspace_memberships: ['workspace_id', 'user_id', 'role', 'status'],
  accounts: ['id', 'account_kind', 'owner_user_id', 'organization_id', 'status'],
  auth_principals: ['id', 'user_id', 'principal_kind', 'status'],
  account_memberships: ['account_id', 'user_id', 'role', 'status'],
  account_workspace_bindings: ['account_id', 'workspace_id', 'user_id_scope', 'binding_kind'],
  conversation_account_bindings: ['conversation_id', 'account_id', 'binding_role', 'access_status'],
  social_direct_conversations: ['id', 'conversation_kind', 'anchor_account_id', 'user_a_id', 'user_b_id'],
  social_messages: ['id', 'account_workspace_id', 'conversation_id', 'sender_user_id', 'recipient_user_id'],
  account_agent_instances: ['account_id', 'agent_instance_id', 'owner_user_id', 'visibility', 'status'],
  user_agent_instances: ['id', 'user_id', 'agent_family_id', 'family_instance_seq'],
  sessions: ['id', 'user_id', 'account_workspace_id', 'agent_id', 'agent_instance_id', 'conversation_role', 'write_state', 'status'],
  messages: ['id', 'account_workspace_id', 'session_id', 'memory_id', 'agent_id', 'agent_instance_id', 'context_space_id'],
  agent_context_spaces: ['id', 'account_workspace_id', 'user_id', 'user_agent_instance_id', 'memory_document_id'],
  agent_context_state: ['user_id', 'account_workspace_id', 'user_agent_instance_id', 'primary_session_id', 'active_context_space_id', 'active_memory_document_id'],
  agent_device_context_state: ['device_id', 'user_id', 'account_workspace_id', 'user_agent_instance_id'],
  agent_conversation_branch_state: ['user_id', 'account_workspace_id', 'agent_instance_id', 'conversation_id', 'primary_session_id', 'rebuild_required'],
  agent_conversation_thread_lineage: ['id', 'user_id', 'account_workspace_id', 'agent_instance_id', 'conversation_id', 'codex_thread_id'],
  agent_conversation_timeline_refs: ['sequence_no', 'ref_id', 'user_id', 'account_workspace_id', 'agent_instance_id', 'source_kind', 'source_id'],
  memory_documents: ['id', 'account_workspace_id', 'user_id', 'user_agent_instance_id', 'scope', 'lifecycle_state', 'current_version_id'],
  memory_document_versions: ['id', 'memory_document_id', 'version_no'],
};

export function databaseTableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(String(table || '')));
}

export function databaseColumnNames(db, table) {
  if (!databaseTableExists(db, table)) return new Set();
  const quoted = `"${String(table).replaceAll('"', '""')}"`;
  return new Set(db.prepare(`PRAGMA table_info(${quoted})`).all().map((row) => String(row.name || '')));
}

export function legacySessionUniqueIndexes(db) {
  if (!databaseTableExists(db, 'sessions')) return [];
  return db.prepare('PRAGMA index_list(sessions)').all().flatMap((row) => {
    if (!Number(row.unique)) return [];
    const quoted = `"${String(row.name || '').replaceAll('"', '""')}"`;
    const columns = db.prepare(`PRAGMA index_info(${quoted})`).all().map((column) => String(column.name || ''));
    const legacyIdentity = columns.length === 2 && columns.includes('user_id') && columns.includes('agent_instance_id');
    const workspaceIdentity = columns.length === 3 && columns.includes('user_id') && columns.includes('account_workspace_id') && columns.includes('agent_instance_id');
    if (!legacyIdentity && !workspaceIdentity) return [];
    const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(String(row.name || ''))?.sql || '');
    const canonicalPrimaryIndex = workspaceIdentity && String(row.name || '') === 'idx_sessions_one_primary_agent'
      && Number(row.partial) === 1
      && /conversation_role\s*=\s*['"]primary['"]/i.test(sql)
      && /write_state\s*=\s*['"]writable['"]/i.test(sql)
      && /status\s*!=\s*['"]deleted['"]/i.test(sql);
    return canonicalPrimaryIndex ? [] : [{
      name: String(row.name || ''),
      origin: String(row.origin || ''),
      partial: Boolean(row.partial),
      tableConstraint: String(row.origin || '') === 'u' || String(row.name || '').startsWith('sqlite_autoindex_'),
    }];
  });
}

export function inspectDatabaseStructure(db) {
  const issues = [];
  for (const [table, columns] of Object.entries(requiredColumns)) {
    if (!databaseTableExists(db, table)) {
      issues.push({ code: 'missing_table', table, repairable: true });
      continue;
    }
    const existing = databaseColumnNames(db, table);
    for (const column of columns) if (!existing.has(column)) issues.push({ code: 'missing_column', table, column, repairable: true });
  }
  const legacySessionIndexes = legacySessionUniqueIndexes(db);
  if (legacySessionIndexes.length) {
    issues.push({ code: 'legacy_session_table_unique', table: 'sessions', repairable: true,
      indexes: legacySessionIndexes.map((index) => index.name) });
  }
  return issues;
}

export function databaseStructureFingerprint(db) {
  const objects = db.prepare(`SELECT type,name,tbl_name,COALESCE(sql,'') AS sql
    FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
  const snapshot = objects.map((object) => {
    const item = { type: object.type, name: object.name, table: object.tbl_name, sql: String(object.sql || '').replace(/\s+/g, ' ').trim() };
    if (object.type === 'table') {
      const quoted = `"${String(object.name).replaceAll('"', '""')}"`;
      item.columns = db.prepare(`PRAGMA table_info(${quoted})`).all().map((column) => ({
        cid: column.cid, name: column.name, type: column.type, notnull: column.notnull, defaultValue: column.dflt_value, pk: column.pk,
      }));
    }
    if (object.type === 'index') {
      const quoted = `"${String(object.name).replaceAll('"', '""')}"`;
      item.columns = db.prepare(`PRAGMA index_info(${quoted})`).all().map((column) => ({ seqno: column.seqno, cid: column.cid, name: column.name }));
    }
    return item;
  });
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export function inspectDatabaseHealth(db) {
  const structurePending = inspectDatabaseStructure(db)
    .some((issue) => issue.code === 'missing_table' || issue.code === 'missing_column');
  const checks = [];
  const count = (tables, sql) => {
    if (!tables.every((table) => databaseTableExists(db, table))) return 0;
    try { return Number(db.prepare(sql).get()?.count || 0); } catch { return 0; }
  };
  const add = (ruleId, value, severity = 'warning', repairMode = 'automatic') => checks.push({ ruleId, count: value, severity, repairMode });
  add('personal_account_owner_duplicate', count(['accounts'], `SELECT COUNT(*) count FROM (
    SELECT owner_user_id FROM accounts WHERE account_kind='personal' GROUP BY owner_user_id HAVING COUNT(*)>1
  )`), 'critical');
  add('organization_account_duplicate', count(['accounts'], `SELECT COUNT(*) count FROM (
    SELECT organization_id FROM accounts WHERE account_kind='organization' GROUP BY organization_id HAVING COUNT(*)>1
  )`), 'critical');
  add('account_workspace_binding_missing_account', count(['account_workspace_bindings', 'accounts'], `SELECT COUNT(*) count
    FROM account_workspace_bindings binding LEFT JOIN accounts account ON account.id=binding.account_id WHERE account.id IS NULL`), 'critical');
  add('social_message_security_domain_missing', count(['social_messages', 'social_direct_conversations'], `SELECT COUNT(*) count
    FROM social_messages message LEFT JOIN social_direct_conversations conversation ON conversation.id=message.conversation_id
    WHERE message.conversation_id='' OR conversation.id IS NULL`), 'critical');
  add('social_message_account_binding_missing', count(['social_messages', 'conversation_account_bindings'], `SELECT COUNT(*) count
    FROM social_messages message WHERE NOT EXISTS (
      SELECT 1 FROM conversation_account_bindings binding WHERE binding.conversation_id=message.conversation_id
    )`), 'critical');
  add('session_agent_identity_mismatch', count(['sessions', 'user_agent_instances'], `SELECT COUNT(*) count FROM sessions s
    LEFT JOIN user_agent_instances i ON i.id=s.agent_instance_id AND i.user_id=s.user_id
    WHERE s.agent_instance_id!='' AND (i.id IS NULL OR (s.agent_id!='' AND s.agent_id!=i.agent_family_id))`), 'critical');
  add('duplicate_primary_agent_session', count(['sessions'], `SELECT COUNT(*) count FROM (SELECT user_id,account_workspace_id,agent_instance_id FROM sessions
    WHERE agent_instance_id!='' AND conversation_role='primary' AND write_state='writable' AND status!='deleted'
    GROUP BY user_id,account_workspace_id,agent_instance_id HAVING COUNT(*)>1)`), 'critical');
  add('projected_primary_agent_identity_collision', count(['sessions', 'user_agent_instance_aliases'], `SELECT COUNT(*) count FROM (
    SELECT s.user_id,COALESCE(NULLIF(s.account_workspace_id,''),'workspace_personal') AS target_workspace_id,
      COALESCE((SELECT alias.canonical_instance_id FROM user_agent_instance_aliases alias
        WHERE alias.user_id=s.user_id AND alias.alias_instance_id=s.agent_instance_id),s.agent_instance_id) AS target_instance_id
    FROM sessions s WHERE s.agent_instance_id!='' AND s.conversation_role='primary'
      AND s.write_state='writable' AND s.status!='deleted'
    GROUP BY s.user_id,target_workspace_id,target_instance_id HAVING COUNT(*)>1
  )`), 'critical');
  add('duplicate_agent_family_sequence', count(['user_agent_instances'], `SELECT COUNT(*) count FROM (
    SELECT user_id,agent_family_id,family_instance_seq FROM user_agent_instances
    WHERE family_instance_seq>0 GROUP BY user_id,agent_family_id,family_instance_seq HAVING COUNT(*)>1
  )`), 'critical');
  add('session_workspace_missing', count(['sessions', 'account_workspaces'], `SELECT COUNT(*) count FROM sessions s
    LEFT JOIN account_workspaces w ON w.id=s.account_workspace_id WHERE w.id IS NULL`), 'critical');
  add('message_session_not_found', count(['messages', 'sessions'], `SELECT COUNT(*) count FROM messages m LEFT JOIN sessions s ON s.id=m.session_id
    WHERE m.session_id!='' AND s.id IS NULL`), 'warning', 'quarantine');
  add('message_session_agent_mismatch', count(['messages', 'sessions'], `SELECT COUNT(*) count FROM messages m JOIN sessions s ON s.id=m.session_id
    WHERE s.agent_instance_id!='' AND m.agent_instance_id!=s.agent_instance_id`), 'critical');
  add('message_session_workspace_mismatch', count(['messages', 'sessions'], `SELECT COUNT(*) count FROM messages m JOIN sessions s ON s.id=m.session_id
    WHERE m.account_workspace_id!=s.account_workspace_id`), 'critical');
  add('message_agent_identity_mismatch', count(['messages', 'user_agent_instances'], `SELECT COUNT(*) count FROM messages m
    LEFT JOIN user_agent_instances i ON i.id=m.agent_instance_id WHERE m.agent_instance_id!=''
      AND (i.id IS NULL OR (m.agent_id!='' AND m.agent_id!=i.agent_family_id))`), 'critical');
  add('message_context_agent_mismatch', count(['messages', 'agent_context_spaces'], `SELECT COUNT(*) count FROM messages m
    JOIN agent_context_spaces c ON c.id=m.context_space_id WHERE m.context_space_id!='' AND m.agent_instance_id!=''
      AND c.user_agent_instance_id!=m.agent_instance_id`));
  add('context_memory_workspace_mismatch', count(['agent_context_spaces', 'memory_documents'], `SELECT COUNT(*) count
    FROM agent_context_spaces context JOIN memory_documents memory ON memory.id=context.memory_document_id
    WHERE context.memory_document_id!='' AND context.account_workspace_id!=memory.account_workspace_id`), 'critical');
  add('context_memory_identity_mismatch', count(['agent_context_spaces', 'memory_documents', 'user_agent_instance_aliases'], `SELECT COUNT(*) count
    FROM agent_context_spaces context JOIN memory_documents memory ON memory.id=context.memory_document_id
    WHERE context.memory_document_id!='' AND (context.user_id!=memory.user_id OR (
      context.user_agent_instance_id!=memory.user_agent_instance_id AND NOT EXISTS (
        SELECT 1 FROM user_agent_instance_aliases alias WHERE alias.user_id=context.user_id AND (
          (alias.alias_instance_id=context.user_agent_instance_id AND alias.canonical_instance_id=memory.user_agent_instance_id)
          OR (alias.alias_instance_id=memory.user_agent_instance_id AND alias.canonical_instance_id=context.user_agent_instance_id)
        )
      )
    ))`), 'critical');
  add('memory_context_workspace_mismatch', count(['memory_documents', 'agent_context_spaces'], `SELECT COUNT(*) count
    FROM memory_documents memory JOIN agent_context_spaces context ON context.id=memory.context_space_id
    WHERE memory.context_space_id!='' AND (memory.account_workspace_id!=context.account_workspace_id OR memory.user_id!=context.user_id)`), 'critical');
  add('memory_context_reciprocal_mismatch', count(['memory_documents', 'agent_context_spaces'], `SELECT COUNT(*) count
    FROM memory_documents memory LEFT JOIN agent_context_spaces context ON context.id=memory.context_space_id
    WHERE memory.scope='general' AND (context.id IS NULL OR context.account_workspace_id!=memory.account_workspace_id
      OR context.user_id!=memory.user_id OR context.user_agent_instance_id!=memory.user_agent_instance_id
      OR context.context_kind!='general_memory' OR context.memory_document_id!=memory.id)`), 'critical');
  add('account_context_session_workspace_mismatch', count(['agent_context_state', 'sessions'], `SELECT COUNT(*) count
    FROM agent_context_state state JOIN sessions session ON session.id=state.primary_session_id
    WHERE state.primary_session_id!='' AND state.account_workspace_id!=session.account_workspace_id`), 'critical');
  add('account_context_space_workspace_mismatch', count(['agent_context_state', 'agent_context_spaces'], `SELECT COUNT(*) count
    FROM agent_context_state state JOIN agent_context_spaces context ON context.id=state.active_context_space_id
    WHERE state.active_context_space_id!='' AND state.account_workspace_id!=context.account_workspace_id`), 'critical');
  add('account_context_memory_workspace_mismatch', count(['agent_context_state', 'memory_documents'], `SELECT COUNT(*) count
    FROM agent_context_state state JOIN memory_documents memory ON memory.id=state.active_memory_document_id
    WHERE state.active_memory_document_id!='' AND state.account_workspace_id!=memory.account_workspace_id`), 'critical');
  add('account_context_session_agent_mismatch', count(['agent_context_state', 'sessions'], `SELECT COUNT(*) count
    FROM agent_context_state state LEFT JOIN sessions session ON session.id=state.primary_session_id
    WHERE state.primary_session_id!='' AND (session.id IS NULL OR state.user_id!=session.user_id
      OR state.account_workspace_id!=session.account_workspace_id OR state.user_agent_instance_id!=session.agent_instance_id)`), 'critical');
  add('account_context_space_agent_mismatch', count(['agent_context_state', 'agent_context_spaces'], `SELECT COUNT(*) count
    FROM agent_context_state state LEFT JOIN agent_context_spaces context ON context.id=state.active_context_space_id
    WHERE state.active_context_space_id!='' AND (context.id IS NULL OR state.user_id!=context.user_id
      OR state.account_workspace_id!=context.account_workspace_id OR state.user_agent_instance_id!=context.user_agent_instance_id)`), 'critical');
  add('account_context_memory_agent_mismatch', count(['agent_context_state', 'memory_documents'], `SELECT COUNT(*) count
    FROM agent_context_state state LEFT JOIN memory_documents memory ON memory.id=state.active_memory_document_id
    WHERE state.active_memory_document_id!='' AND (memory.id IS NULL OR state.user_id!=memory.user_id
      OR state.account_workspace_id!=memory.account_workspace_id OR state.user_agent_instance_id!=memory.user_agent_instance_id)`), 'critical');
  add('device_context_session_workspace_mismatch', count(['agent_device_context_state', 'sessions'], `SELECT COUNT(*) count
    FROM agent_device_context_state state JOIN sessions session ON session.id=state.primary_session_id
    WHERE state.primary_session_id!='' AND state.account_workspace_id!=session.account_workspace_id`), 'critical');
  add('device_context_space_workspace_mismatch', count(['agent_device_context_state', 'agent_context_spaces'], `SELECT COUNT(*) count
    FROM agent_device_context_state state JOIN agent_context_spaces context ON context.id=state.active_context_space_id
    WHERE state.active_context_space_id!='' AND state.account_workspace_id!=context.account_workspace_id`), 'critical');
  add('device_context_memory_workspace_mismatch', count(['agent_device_context_state', 'memory_documents'], `SELECT COUNT(*) count
    FROM agent_device_context_state state JOIN memory_documents memory ON memory.id=state.active_memory_document_id
    WHERE state.active_memory_document_id!='' AND state.account_workspace_id!=memory.account_workspace_id`), 'critical');
  add('device_context_session_agent_mismatch', count(['agent_device_context_state', 'sessions'], `SELECT COUNT(*) count
    FROM agent_device_context_state state LEFT JOIN sessions session ON session.id=state.primary_session_id
    WHERE state.primary_session_id!='' AND (session.id IS NULL OR state.user_id!=session.user_id
      OR state.account_workspace_id!=session.account_workspace_id OR state.user_agent_instance_id!=session.agent_instance_id)`), 'critical');
  add('device_context_space_agent_mismatch', count(['agent_device_context_state', 'agent_context_spaces'], `SELECT COUNT(*) count
    FROM agent_device_context_state state LEFT JOIN agent_context_spaces context ON context.id=state.active_context_space_id
    WHERE state.active_context_space_id!='' AND (context.id IS NULL OR state.user_id!=context.user_id
      OR state.account_workspace_id!=context.account_workspace_id OR state.user_agent_instance_id!=context.user_agent_instance_id)`), 'critical');
  add('device_context_memory_agent_mismatch', count(['agent_device_context_state', 'memory_documents'], `SELECT COUNT(*) count
    FROM agent_device_context_state state LEFT JOIN memory_documents memory ON memory.id=state.active_memory_document_id
    WHERE state.active_memory_document_id!='' AND (memory.id IS NULL OR state.user_id!=memory.user_id
      OR state.account_workspace_id!=memory.account_workspace_id OR state.user_agent_instance_id!=memory.user_agent_instance_id)`), 'critical');
  add('message_context_workspace_mismatch', count(['messages', 'agent_context_spaces'], `SELECT COUNT(*) count FROM messages m
    JOIN agent_context_spaces c ON c.id=m.context_space_id WHERE m.context_space_id!=''
      AND c.account_workspace_id!=m.account_workspace_id`), 'critical');
  add('message_memory_workspace_mismatch', count(['messages', 'memory_documents'], `SELECT COUNT(*) count FROM messages message
    JOIN memory_documents memory ON memory.id=message.memory_id WHERE message.memory_id!=''
      AND memory.account_workspace_id!=message.account_workspace_id`), 'critical');
  add('agent_context_state_session_workspace_mismatch', count(['agent_context_state', 'sessions'], `SELECT COUNT(*) count
    FROM agent_context_state state JOIN sessions session ON session.id=state.primary_session_id
    WHERE state.primary_session_id!='' AND state.account_workspace_id!=session.account_workspace_id`), 'critical');
  add('agent_context_state_space_workspace_mismatch', count(['agent_context_state', 'agent_context_spaces'], `SELECT COUNT(*) count
    FROM agent_context_state state JOIN agent_context_spaces context ON context.id=state.active_context_space_id
    WHERE state.active_context_space_id!='' AND state.account_workspace_id!=context.account_workspace_id`), 'critical');
  add('agent_context_state_memory_workspace_mismatch', count(['agent_context_state', 'memory_documents'], `SELECT COUNT(*) count
    FROM agent_context_state state JOIN memory_documents memory ON memory.id=state.active_memory_document_id
    WHERE state.active_memory_document_id!='' AND state.account_workspace_id!=memory.account_workspace_id`), 'critical');
  add('duplicate_active_general_memory', count(['memory_documents'], `SELECT COUNT(*) count FROM (SELECT account_workspace_id,user_id,user_agent_instance_id
    FROM memory_documents WHERE scope='general' AND lifecycle_state='active' GROUP BY account_workspace_id,user_id,user_agent_instance_id HAVING COUNT(*)>1)`), 'critical');
  add('memory_current_version_missing', count(['memory_documents', 'memory_document_versions'], `SELECT COUNT(*) count FROM memory_documents d
    LEFT JOIN memory_document_versions v ON v.id=d.current_version_id WHERE d.current_version_id!='' AND (v.id IS NULL OR v.memory_document_id!=d.id)`), 'warning', 'quarantine');
  add('agent_alias_target_invalid', count(['user_agent_instance_aliases', 'user_agent_instances'], `SELECT COUNT(*) count FROM user_agent_instance_aliases a
    LEFT JOIN user_agent_instances i ON i.id=a.canonical_instance_id WHERE i.id IS NULL OR i.user_id!=a.user_id OR a.alias_instance_id=a.canonical_instance_id`), 'warning', 'quarantine');
  add('agent_alias_cycle', count(['user_agent_instance_aliases'], `WITH RECURSIVE walk(start_id,current_id,path,depth,cycle) AS (
    SELECT alias_instance_id,canonical_instance_id,'|'||alias_instance_id||'|',1,
      CASE WHEN canonical_instance_id=alias_instance_id THEN 1 ELSE 0 END FROM user_agent_instance_aliases
    UNION ALL
    SELECT walk.start_id,alias.canonical_instance_id,walk.path||walk.current_id||'|',walk.depth+1,
      CASE WHEN instr(walk.path,'|'||alias.canonical_instance_id||'|')>0 THEN 1 ELSE 0 END
    FROM walk JOIN user_agent_instance_aliases alias ON alias.alias_instance_id=walk.current_id
    WHERE walk.cycle=0 AND walk.depth<128
  ) SELECT COUNT(DISTINCT start_id) count FROM walk WHERE cycle=1`), 'critical');
  add('agent_alias_boundary_cycle', agentAliasBoundaryCycleCount(db), 'critical', 'manual');
  add('agent_conversation_branch_invalid', count([
    'agent_conversation_branch_state', 'sessions', 'conversations', 'user_agent_instances',
  ], `SELECT COUNT(*) count FROM agent_conversation_branch_state branch
    LEFT JOIN user_agent_instances instance ON instance.id=branch.agent_instance_id AND instance.user_id=branch.user_id
    LEFT JOIN sessions session ON session.id=branch.primary_session_id
    LEFT JOIN conversations conversation ON conversation.id=branch.conversation_id
    WHERE instance.id IS NULL OR session.id IS NULL OR conversation.id IS NULL
      OR session.user_id!=branch.user_id OR session.account_workspace_id!=branch.account_workspace_id
      OR session.agent_instance_id!=branch.agent_instance_id OR session.conversation_id!=branch.conversation_id
      OR session.conversation_role!='primary' OR session.write_state!='writable' OR session.status='deleted'
      OR conversation.owner_user_id!=branch.user_id OR conversation.account_workspace_id!=branch.account_workspace_id
      OR conversation.agent_instance_id!=branch.agent_instance_id OR conversation.conversation_kind!='direct'`), 'critical');
  add('agent_timeline_reference_invalid', count([
    'agent_conversation_timeline_refs', 'user_agent_instances', 'account_workspaces',
  ], `SELECT COUNT(*) count FROM agent_conversation_timeline_refs ref
    LEFT JOIN user_agent_instances instance ON instance.id=ref.agent_instance_id AND instance.user_id=ref.user_id
    LEFT JOIN account_workspaces workspace ON workspace.id=ref.account_workspace_id
    WHERE instance.id IS NULL OR workspace.id IS NULL OR ref.source_id='' OR ref.source_kind=''`), 'warning', 'quarantine');
  const blocking = checks.filter((item) => item.severity === 'critical' && item.count > 0);
  const violationCount = checks.reduce((sum, item) => sum + item.count, 0);
  return { status: blocking.length ? 'critical' : structurePending ? 'structure_pending' : violationCount ? 'warning' : 'healthy',
    violationCount, blocking, checks };
}

function agentAliasBoundaryCycleCount(db) {
  if (!databaseTableExists(db, 'user_agent_instance_aliases') || !databaseTableExists(db, 'user_agent_instances')) return 0;
  const aliasColumns = databaseColumnNames(db, 'user_agent_instance_aliases');
  const instanceColumns = databaseColumnNames(db, 'user_agent_instances');
  if (!['alias_instance_id', 'canonical_instance_id', 'user_id'].every((column) => aliasColumns.has(column))
    || !['id', 'user_id', 'agent_family_id'].every((column) => instanceColumns.has(column))) return 0;
  const rows = db.prepare('SELECT alias_instance_id,canonical_instance_id,user_id FROM user_agent_instance_aliases').all();
  const aliases = new Map(rows.map((row) => [String(row.alias_instance_id || ''), row]));
  const instances = new Map(db.prepare('SELECT id,user_id,agent_family_id FROM user_agent_instances').all()
    .map((row) => [String(row.id || ''), row]));
  const cycles = new Map();
  for (const startId of aliases.keys()) {
    const order = [];
    const positions = new Map();
    let current = startId;
    while (aliases.has(current) && order.length < 128) {
      if (positions.has(current)) {
        const ids = order.slice(positions.get(current));
        cycles.set([...ids].sort().join('\u001f'), ids);
        break;
      }
      positions.set(current, order.length);
      order.push(current);
      current = String(aliases.get(current)?.canonical_instance_id || '');
    }
  }
  let count = 0;
  for (const ids of cycles.values()) {
    const candidates = ids.map((id) => instances.get(id)).filter(Boolean);
    const aliasUsers = new Set(ids.map((id) => aliases.get(id)?.user_id).filter(Boolean));
    const users = new Set(candidates.map((row) => row.user_id));
    const families = new Set(candidates.map((row) => row.agent_family_id));
    if (!candidates.length || aliasUsers.size !== 1 || users.size !== 1 || families.size !== 1
      || !aliasUsers.has(candidates[0]?.user_id)) count += 1;
  }
  return count;
}

export function assertDatabaseHealth(db) {
  const health = inspectDatabaseHealth(db);
  if (!health.blocking.length) return health;
  const error = new Error(`Database consistency validation failed: ${health.blocking.map((item) => `${item.ruleId}=${item.count}`).join(', ')}`);
  error.code = 'DB_INVARIANT_FAILED';
  error.health = health;
  throw error;
}
