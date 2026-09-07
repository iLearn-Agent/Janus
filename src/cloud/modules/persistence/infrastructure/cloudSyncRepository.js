import crypto from 'node:crypto';
import path from 'node:path';

import { isLegacyChatDepartmentId } from '../../../../shared/departments.js';
import {
  cloudJsonObject,
} from '../../social/index.js';
import {
  privateDelegationMetadata as privateCloudDelegationMetadata,
  publicDelegationMetadata as publicCloudDelegationMetadata,
} from '../../collaboration/index.js';
import { normalizeCloudMemoryVisibility } from '../../../../shared/cloudContracts.js';
import {
  agentFamilyNameUsesCanonicalTemplate,
  canonicalAgentFamilyName,
  compactAgentInstanceProfiles,
  repairAgentInstanceProfiles,
} from '../../../../shared/agentInstanceNaming.js';
import { CLUSTER_COHORT_IDENTITY_VERSION, stableClusterCohortId } from '../../../../shared/evolution/contracts.js';

function ensureLegacyPrivateThreadRoutingColumns(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_delegation_workspace_messages'").get();
  if (!table) return;
  const columns = new Set(db.prepare('PRAGMA table_info(agent_delegation_workspace_messages)').all().map((row) => row.name));
  if (!columns.has('source_event_id')) db.exec("ALTER TABLE agent_delegation_workspace_messages ADD COLUMN source_event_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('source_group_message_id')) db.exec("ALTER TABLE agent_delegation_workspace_messages ADD COLUMN source_group_message_id TEXT NOT NULL DEFAULT ''");
}

function ensureLegacyCollaborationMessageSourceColumn(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'collaboration_group_messages'").get();
  if (!table) return;
  const columns = new Set(db.prepare('PRAGMA table_info(collaboration_group_messages)').all().map((row) => row.name));
  if (!columns.has('source_event_id')) db.exec("ALTER TABLE collaboration_group_messages ADD COLUMN source_event_id TEXT NOT NULL DEFAULT ''");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_collaboration_messages_source_event ON collaboration_group_messages(group_id,source_event_id) WHERE source_event_id <> ''");
}

function ensureDelegationClientRequestIdentity(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_delegations'").get();
  if (!table) return;
  const columns = new Set(db.prepare('PRAGMA table_info(agent_delegations)').all().map((row) => row.name));
  if (!columns.has('client_request_id')) db.exec("ALTER TABLE agent_delegations ADD COLUMN client_request_id TEXT NOT NULL DEFAULT ''");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_delegations_client_request
    ON agent_delegations(account_workspace_id,requester_user_id,client_request_id)
    WHERE client_request_id <> ''`);
}

function applySyncMigrations(db) {
  ensureLegacyCollaborationMessageSourceColumn(db);
  ensureDelegationClientRequestIdentity(db);
  applySyncMigration(db, 'collaboration_groups_v1', () => {
    const delegationColumns = db.prepare('PRAGMA table_info(agent_delegations)').all();
    if (!delegationColumns.some((column) => column.name === 'group_id')) {
      db.exec("ALTER TABLE agent_delegations ADD COLUMN group_id TEXT NOT NULL DEFAULT ''");
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cloud_agent_delegations_group ON agent_delegations(group_id, updated_at);
      CREATE TABLE IF NOT EXISTS collaboration_groups (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT 'uBuddy 任务群',
        status TEXT NOT NULL DEFAULT 'active',
        client_request_id TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        closed_at TEXT,
        UNIQUE(owner_user_id, client_request_id)
      );
      CREATE TABLE IF NOT EXISTS collaboration_group_members (
        group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        status TEXT NOT NULL DEFAULT 'active',
        joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        left_at TEXT,
        last_read_at TEXT,
        PRIMARY KEY (group_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_collaboration_members_user
        ON collaboration_group_members(user_id, status, joined_at);
      CREATE TABLE IF NOT EXISTS collaboration_group_messages (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
        sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sender_agent_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'friend',
        content TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        source_event_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_collaboration_messages_group
        ON collaboration_group_messages(group_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_collaboration_messages_source_event
        ON collaboration_group_messages(group_id, source_event_id) WHERE source_event_id <> '';
      CREATE TABLE IF NOT EXISTS task_node_result_versions (
        id TEXT PRIMARY KEY,task_run_id TEXT NOT NULL,task_node_id TEXT NOT NULL,graph_revision_id TEXT NOT NULL DEFAULT '',
        version_no INTEGER NOT NULL DEFAULT 1,result_text TEXT NOT NULL DEFAULT '',result_summary TEXT NOT NULL DEFAULT '',
        evidence_json TEXT NOT NULL DEFAULT '[]',decision TEXT NOT NULL DEFAULT 'pending',decision_reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),decided_at TEXT,
        UNIQUE(task_node_id,version_no)
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_task_node_result_versions_run
        ON task_node_result_versions(task_run_id,graph_revision_id,created_at);
      CREATE TABLE IF NOT EXISTS agent_delegation_revisions (
        id TEXT PRIMARY KEY,
        delegation_id TEXT NOT NULL REFERENCES agent_delegations(id) ON DELETE CASCADE,
        author_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        revision_no INTEGER NOT NULL DEFAULT 1,
        action TEXT NOT NULL DEFAULT 'draft',
        content TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(delegation_id, revision_no)
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_agent_delegation_revisions
        ON agent_delegation_revisions(delegation_id, revision_no);
    `);
  });
  applySyncMigration(db, 'delegation_private_workspaces_v1', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_delegation_workspaces (
        delegation_id TEXT NOT NULL REFERENCES agent_delegations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (delegation_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_agent_delegation_workspaces_user
        ON agent_delegation_workspaces(user_id, updated_at);
      CREATE TABLE IF NOT EXISTS agent_delegation_workspace_messages (
        id TEXT PRIMARY KEY,
        delegation_id TEXT NOT NULL REFERENCES agent_delegations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'user',
        content TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        source_event_id TEXT NOT NULL DEFAULT '',
        source_group_message_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(delegation_id, user_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_agent_delegation_workspace_messages_owner
        ON agent_delegation_workspace_messages(delegation_id, user_id, created_at);
      INSERT OR IGNORE INTO agent_delegation_workspaces (delegation_id, user_id, session_id, updated_at)
      SELECT id, recipient_user_id, session_id, updated_at FROM agent_delegations WHERE session_id <> '';
    `);
    const legacyDelegations = db.prepare('SELECT id, recipient_user_id, metadata_json, updated_at FROM agent_delegations').all();
    for (const delegation of legacyDelegations) {
      const metadata = cloudJsonObject(delegation.metadata_json);
      const privateMetadata = privateCloudDelegationMetadata(metadata);
      if (Object.keys(privateMetadata).length) {
        const workspace = db.prepare('SELECT metadata_json FROM agent_delegation_workspaces WHERE delegation_id = ? AND user_id = ?')
          .get(delegation.id, delegation.recipient_user_id);
        db.prepare(
          `INSERT INTO agent_delegation_workspaces (delegation_id, user_id, metadata_json, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(delegation_id, user_id) DO UPDATE SET metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`,
        ).run(
          delegation.id,
          delegation.recipient_user_id,
          JSON.stringify({ ...cloudJsonObject(workspace?.metadata_json), ...privateMetadata }),
          delegation.updated_at || new Date().toISOString(),
        );
      }
      db.prepare('UPDATE agent_delegations SET metadata_json = ? WHERE id = ?')
        .run(JSON.stringify(publicCloudDelegationMetadata(metadata)), delegation.id);
    }
  });
  applySyncMigration(db, 'collaboration_files_v1', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_files (
        id TEXT PRIMARY KEY,
        delegation_id TEXT NOT NULL REFERENCES agent_delegations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        filename TEXT NOT NULL DEFAULT 'file',
        content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL DEFAULT '',
        data BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(delegation_id, owner_user_id, sha256)
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_collaboration_files_group
        ON collaboration_files(group_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_cloud_collaboration_files_delegation
        ON collaboration_files(delegation_id, created_at);
    `);
  });
  applySyncMigration(db, 'collaboration_files_direct_delegation_v2', () => {
    const columns = db.prepare('PRAGMA table_info(collaboration_files)').all();
    const groupIdColumn = columns.find((column) => column.name === 'group_id');
    if (!groupIdColumn || Number(groupIdColumn.notnull || 0) === 0) return;
    const before = db.prepare(`SELECT id,delegation_id,group_id,owner_user_id,filename,content_type,size_bytes,sha256,data,created_at,updated_at
      FROM collaboration_files ORDER BY id`).all();
    db.exec(`
      CREATE TABLE collaboration_files_direct_v2 (
        id TEXT PRIMARY KEY,
        delegation_id TEXT NOT NULL REFERENCES agent_delegations(id) ON DELETE CASCADE,
        group_id TEXT REFERENCES collaboration_groups(id) ON DELETE CASCADE,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        filename TEXT NOT NULL DEFAULT 'file',
        content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL DEFAULT '',
        data BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(delegation_id, owner_user_id, sha256)
      );
      INSERT INTO collaboration_files_direct_v2(
        id,delegation_id,group_id,owner_user_id,filename,content_type,size_bytes,sha256,data,created_at,updated_at
      ) SELECT id,delegation_id,group_id,owner_user_id,filename,content_type,size_bytes,sha256,data,created_at,updated_at
        FROM collaboration_files;
      DROP TABLE collaboration_files;
      ALTER TABLE collaboration_files_direct_v2 RENAME TO collaboration_files;
      CREATE INDEX idx_cloud_collaboration_files_group ON collaboration_files(group_id, created_at);
      CREATE INDEX idx_cloud_collaboration_files_delegation ON collaboration_files(delegation_id, created_at);
    `);
    const after = db.prepare(`SELECT id,delegation_id,group_id,owner_user_id,filename,content_type,size_bytes,sha256,data,created_at,updated_at
      FROM collaboration_files ORDER BY id`).all();
    const rowFingerprint = (row) => crypto.createHash('sha256').update(JSON.stringify({
      ...row,
      data: Buffer.from(row.data || []).toString('base64'),
    })).digest('hex');
    if (before.length !== after.length || before.some((row, index) => rowFingerprint(row) !== rowFingerprint(after[index]))) {
      throw new Error('Direct delegation file migration did not preserve the collaboration file inventory.');
    }
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check(collaboration_files)').all();
    if (foreignKeyViolations.length) throw new Error('Direct delegation file migration introduced foreign-key violations.');
  }, { required: true });
  applySyncMigration(db, 'collaboration_group_shared_workspace_v1', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_group_workspaces (
        group_id TEXT PRIMARY KEY REFERENCES collaboration_groups(id) ON DELETE CASCADE,
        workspace_epoch TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS collaboration_group_workspace_files (
        id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        filename TEXT NOT NULL DEFAULT 'file',content_type TEXT NOT NULL DEFAULT 'application/octet-stream',size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL DEFAULT '',data BLOB NOT NULL DEFAULT X'',deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),UNIQUE(group_id,relative_path)
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_collaboration_group_workspace_files_revision
        ON collaboration_group_workspace_files(group_id,revision);
      INSERT OR IGNORE INTO collaboration_group_workspaces(group_id,workspace_epoch,revision,status,updated_at)
        SELECT id,'workspace_' || id,0,status,updated_at FROM collaboration_groups;
      INSERT OR IGNORE INTO collaboration_group_workspace_files(
        id,group_id,relative_path,revision,owner_user_id,filename,content_type,size_bytes,sha256,data,deleted,created_at,updated_at
      )
      SELECT 'group_workspace_' || id,group_id,'published/' || id || '-' || filename,
        row_number() OVER (PARTITION BY group_id ORDER BY created_at,id),owner_user_id,filename,content_type,size_bytes,sha256,data,0,created_at,updated_at
      FROM collaboration_files;
      UPDATE collaboration_group_workspaces
      SET revision=COALESCE((SELECT MAX(revision) FROM collaboration_group_workspace_files files WHERE files.group_id=collaboration_group_workspaces.group_id),revision);
    `);
  });
  applySyncMigration(db, 'private_thread_event_routing_v1', () => {
    const columns = new Set(db.prepare('PRAGMA table_info(agent_delegation_workspace_messages)').all().map((row) => row.name));
    if (!columns.has('source_event_id')) db.exec("ALTER TABLE agent_delegation_workspace_messages ADD COLUMN source_event_id TEXT NOT NULL DEFAULT ''");
    if (!columns.has('source_group_message_id')) db.exec("ALTER TABLE agent_delegation_workspace_messages ADD COLUMN source_group_message_id TEXT NOT NULL DEFAULT ''");
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_delegation_workspace_messages_source_event
        ON agent_delegation_workspace_messages(delegation_id, user_id, source_event_id)
        WHERE source_event_id <> '';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_delegation_workspace_messages_source_group
        ON agent_delegation_workspace_messages(delegation_id, user_id, source_group_message_id)
        WHERE source_group_message_id <> '';
    `);
  });
  applySyncMigration(db, 'sync_schema_v2_backfill', () => {
    const batches = db.prepare('SELECT payload_json, user_id, device_id FROM sync_batches ORDER BY created_at ASC').all();
    for (const batchRow of batches) backfillLegacyBatch(db, batchRow);
  });
  applySyncMigration(db, 'sync_schema_v2_file_ref_backfill', () => {
    backfillLegacyFileRefs(db);
  });
  applySyncMigration(db, 'legacy_department_chat_cleanup_v1', () => {
    cleanupLegacyDepartmentCloudData(db);
  });
  applySyncMigration(db, 'legacy_department_chat_cleanup_v2', () => {
    cleanupLegacyDepartmentCloudData(db);
  });
  applySyncMigration(db, 'sync_schema_v3_identity_merge_v2', () => {
    const skillColumns = new Set(db.prepare('PRAGMA table_info(cloud_user_agent_skill_versions_v3)').all().map((row) => row.name));
    if (!skillColumns.has('activated_at')) db.exec("ALTER TABLE cloud_user_agent_skill_versions_v3 ADD COLUMN activated_at TEXT NOT NULL DEFAULT ''");
    if (!skillColumns.has('updated_at')) db.exec("ALTER TABLE cloud_user_agent_skill_versions_v3 ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE cloud_user_agent_skill_versions_v3 SET updated_at = created_at WHERE updated_at = ''");
    db.exec(`CREATE TABLE IF NOT EXISTS cloud_memory_document_aliases_v3 (
      user_id TEXT NOT NULL,
      alias_document_id TEXT NOT NULL,
      canonical_document_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'cross_device_memory_conflict',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (user_id, alias_document_id)
    )`);
  });
  applySyncMigration(db, 'sync_schema_v4_personal_evolution_v1', () => {
    const instanceColumns = new Set(db.prepare('PRAGMA table_info(cloud_user_agent_instances_v3)').all().map((row) => row.name));
    if (!instanceColumns.has('personal_skill_auto_activate')) db.exec('ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN personal_skill_auto_activate INTEGER NOT NULL DEFAULT 0');
  });
  applySyncMigration(db, 'cloud_evolution_authority_phase3_v1', () => {
    const columns = new Set(db.prepare('PRAGMA table_info(cloud_user_agent_skill_versions_v3)').all().map((row) => row.name));
    const additions = [
      ['parent_version_id', "TEXT NOT NULL DEFAULT ''"],
      ['source_evolution_run_id', "TEXT NOT NULL DEFAULT ''"],
      ['authority', "TEXT NOT NULL DEFAULT 'legacy_imported'"],
      ['stability_status', "TEXT NOT NULL DEFAULT 'candidate'"],
      ['overlay_hash', "TEXT NOT NULL DEFAULT ''"],
      ['effective_skill_hash', "TEXT NOT NULL DEFAULT ''"],
      ['compiler_version', "TEXT NOT NULL DEFAULT 'overlay_concat_v1'"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) db.exec(`ALTER TABLE cloud_user_agent_skill_versions_v3 ADD COLUMN ${name} ${definition}`);
    }
  });
  applySyncMigration(db, 'personal_evolution_schedule_v1', () => {
    db.exec(`CREATE TABLE IF NOT EXISTS cloud_personal_evolution_schedule_states (
      user_agent_instance_id TEXT PRIMARY KEY,
      last_evaluated_at TEXT NOT NULL DEFAULT '',
      next_eligible_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_status TEXT NOT NULL DEFAULT 'never_evaluated',
      last_evidence_count INTEGER NOT NULL DEFAULT 0,
      last_run_id TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_personal_evolution_schedule_due
      ON cloud_personal_evolution_schedule_states(next_eligible_at, user_agent_instance_id);
    DROP INDEX IF EXISTS idx_cloud_evolution_active_personal_run;
    CREATE UNIQUE INDEX idx_cloud_evolution_active_personal_run
      ON cloud_evolution_runs(user_agent_instance_id)
      WHERE evolution_scope = 'personal'
        AND status IN ('queued','claimed','running','proposed','failed_retryable');`);
  });
  applySyncMigration(db, 'employee_cloud_authority_v1', () => {
    const familyColumns = new Set(db.prepare('PRAGMA table_info(cloud_agent_families_v3)').all().map((row) => row.name));
    for (const [name, definition] of [
      ['status', "TEXT NOT NULL DEFAULT 'active'"], ['routable', 'INTEGER NOT NULL DEFAULT 0'],
      ['instance_kind', "TEXT NOT NULL DEFAULT 'unavailable'"], ['recruitable', 'INTEGER NOT NULL DEFAULT 0'],
      ['default_for_new_user', 'INTEGER NOT NULL DEFAULT 0'], ['quota_cost', 'INTEGER NOT NULL DEFAULT 0'],
      ['current_version_id', "TEXT NOT NULL DEFAULT ''"],
    ]) if (!familyColumns.has(name)) db.exec(`ALTER TABLE cloud_agent_families_v3 ADD COLUMN ${name} ${definition}`);
    const instanceColumns = new Set(db.prepare('PRAGMA table_info(cloud_user_agent_instances_v3)').all().map((row) => row.name));
    for (const [name, definition] of [
      ['instance_kind', "TEXT NOT NULL DEFAULT 'employee'"], ['employment_state', "TEXT NOT NULL DEFAULT 'active'"],
      ['quota_exempt', 'INTEGER NOT NULL DEFAULT 0'], ['recruited_at', "TEXT NOT NULL DEFAULT ''"],
      ['deactivated_at', "TEXT NOT NULL DEFAULT ''"], ['last_state_changed_at', "TEXT NOT NULL DEFAULT ''"],
      ['state_revision', 'INTEGER NOT NULL DEFAULT 1'], ['recruitment_source', "TEXT NOT NULL DEFAULT 'migration'"],
      ['policy_version', "TEXT NOT NULL DEFAULT 'employee_cloud_authority_v1'"],
    ]) if (!instanceColumns.has(name)) db.exec(`ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN ${name} ${definition}`);
    db.exec(`CREATE TABLE IF NOT EXISTS cloud_user_agent_recruitment_events (
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL,user_agent_instance_id TEXT NOT NULL DEFAULT '',agent_family_id TEXT NOT NULL,
      event_type TEXT NOT NULL,previous_state TEXT NOT NULL DEFAULT '',next_state TEXT NOT NULL DEFAULT '',quota_before INTEGER NOT NULL DEFAULT 0,
      quota_after INTEGER NOT NULL DEFAULT 0,command_id TEXT NOT NULL,source_device_id TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT '',UNIQUE(user_id,command_id)
    )`);
    db.exec(`UPDATE cloud_agent_families_v3 SET
      instance_kind = CASE
        WHEN id='secretary_agent' THEN 'system'
        WHEN role IN ('hr','department_leader') THEN 'governance'
        WHEN routable=1 AND status NOT IN ('disabled','retired','archived') THEN 'employee'
        ELSE 'unavailable' END,
      recruitable = CASE WHEN id!='secretary_agent' AND role NOT IN ('hr','department_leader')
        AND routable=1 AND status NOT IN ('disabled','retired','archived') THEN 1 ELSE 0 END,
      default_for_new_user = CASE WHEN id='general_agent' AND status NOT IN ('disabled','retired','archived') THEN 1 ELSE 0 END,
      quota_cost = CASE WHEN id!='secretary_agent' AND role NOT IN ('hr','department_leader')
        AND routable=1 AND status NOT IN ('disabled','retired','archived') THEN 1 ELSE 0 END`);
    db.exec(`UPDATE cloud_user_agent_instances_v3 SET
      instance_kind=COALESCE((SELECT instance_kind FROM cloud_agent_families_v3 f WHERE f.id=cloud_user_agent_instances_v3.agent_family_id),'unavailable'),
      employment_state=CASE WHEN status='inactive' THEN 'inactive' ELSE 'active' END,
      quota_exempt=CASE WHEN COALESCE((SELECT instance_kind FROM cloud_agent_families_v3 f WHERE f.id=cloud_user_agent_instances_v3.agent_family_id),'unavailable')='employee' THEN 0 ELSE 1 END,
      recruited_at=CASE WHEN recruited_at='' THEN created_at ELSE recruited_at END,
      last_state_changed_at=CASE WHEN last_state_changed_at='' THEN updated_at ELSE last_state_changed_at END`);
  });
  applySyncMigration(db, 'employee_instance_profile_uniqueness_v1', () => {
    const instanceColumns = new Set(db.prepare('PRAGMA table_info(cloud_user_agent_instances_v3)').all().map((row) => row.name));
    if (!instanceColumns.has('family_instance_seq')) db.exec('ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN family_instance_seq INTEGER NOT NULL DEFAULT 0');
    if (!instanceColumns.has('display_name')) db.exec("ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
    if (!instanceColumns.has('note')) db.exec("ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN note TEXT NOT NULL DEFAULT ''");
    const rows = db.prepare(`SELECT i.id,i.user_id,i.agent_family_id,i.family_instance_seq,i.display_name,i.note,i.payload_json,i.created_at,
        COALESCE(f.name,i.agent_family_id,'Agent') AS family_name
      FROM cloud_user_agent_instances_v3 i LEFT JOIN cloud_agent_families_v3 f ON f.id=i.agent_family_id
      ORDER BY i.user_id,i.agent_family_id,i.created_at,i.id`).all();
    const repaired = repairAgentInstanceProfiles(rows.map((row) => {
      const payload = cloudJsonObject(row.payload_json);
      return {
        id: row.id, userId: row.user_id, agentFamilyId: row.agent_family_id,
        familyInstanceSeq: Number(row.family_instance_seq || payload.familyInstanceSeq || 0),
        displayName: row.display_name || payload.displayName || '', note: row.note || payload.note || '',
        familyName: row.family_name, createdAt: row.created_at, payload,
      };
    }));
    const update = db.prepare(`UPDATE cloud_user_agent_instances_v3 SET family_instance_seq=?,display_name=?,note=?,payload_json=?,
      state_revision=state_revision+?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND id=?`);
    const changedUsers = new Set();
    for (const profile of repaired) {
      const payload = { ...(profile.payload || {}), familyInstanceSeq: profile.familyInstanceSeq, displayName: profile.displayName, note: profile.note || '' };
      const payloadChanged = JSON.stringify(payload) !== JSON.stringify(profile.payload || {});
      if (!profile.profileChanged && !payloadChanged) continue;
      update.run(profile.familyInstanceSeq, profile.displayName, profile.note || '', JSON.stringify(payload), profile.profileChanged ? 1 : 0, profile.userId, profile.id);
      if (profile.profileChanged) changedUsers.add(profile.userId);
    }
    for (const userId of changedUsers) {
      db.prepare(`UPDATE cloud_employee_roster_states SET roster_revision=roster_revision+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?`).run(userId);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_user_agent_instances_unique_family_seq
      ON cloud_user_agent_instances_v3(user_id,agent_family_id,family_instance_seq) WHERE family_instance_seq>0`);
  });
  applySyncMigration(db, 'agent_family_display_names_v1', () => {
    for (const familyId of ['general_agent', 'ppt']) {
      const family = db.prepare('SELECT name,payload_json FROM cloud_agent_families_v3 WHERE id=?').get(familyId);
      if (!family) continue;
      const name = canonicalAgentFamilyName(familyId, family.name);
      const payload = { ...cloudJsonObject(family.payload_json), name };
      db.prepare(`UPDATE cloud_agent_families_v3 SET name=?,payload_json=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(name, JSON.stringify(payload), familyId);
    }
    const rows = db.prepare(`SELECT i.id,i.user_id,i.agent_family_id,i.family_instance_seq,i.display_name,i.note,i.payload_json,i.created_at,
        COALESCE(f.name,i.agent_family_id,'Agent') AS family_name
      FROM cloud_user_agent_instances_v3 i LEFT JOIN cloud_agent_families_v3 f ON f.id=i.agent_family_id
      WHERE i.agent_family_id IN ('general_agent','ppt') ORDER BY i.user_id,i.agent_family_id,i.created_at,i.id`).all();
    const repaired = repairAgentInstanceProfiles(rows.map((row) => ({
      id: row.id, userId: row.user_id, agentFamilyId: row.agent_family_id,
      familyInstanceSeq: row.family_instance_seq, displayName: row.display_name,
      note: row.note || '', familyName: row.family_name, createdAt: row.created_at,
      payload: cloudJsonObject(row.payload_json),
    })));
    const update = db.prepare(`UPDATE cloud_user_agent_instances_v3 SET display_name=?,payload_json=?,
      state_revision=state_revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND id=?`);
    const changedUsers = new Set();
    const currentById = new Map(rows.map((row) => [`${row.user_id}\u001f${row.id}`, row]));
    for (const profile of repaired) {
      const current = currentById.get(`${profile.userId}\u001f${profile.id}`);
      if (!current || profile.displayName === String(current.display_name || '').trim()) continue;
      const payload = { ...(profile.payload || {}), displayName: profile.displayName };
      update.run(profile.displayName, JSON.stringify(payload), profile.userId, profile.id);
      changedUsers.add(profile.userId);
    }
    for (const userId of changedUsers) {
      db.prepare(`UPDATE cloud_employee_roster_states SET roster_revision=roster_revision+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?`).run(userId);
    }
  });
  applySyncMigration(db, 'agent_family_name_alignment_v2', () => {
    const familyRows = db.prepare('SELECT id,name,payload_json FROM cloud_agent_families_v3 ORDER BY id').all();
    const alignedFamilyIds = [];
    for (const family of familyRows) {
      const name = canonicalAgentFamilyName(family.id, family.name);
      if (!agentFamilyNameUsesCanonicalTemplate(family.id, family.name)) continue;
      alignedFamilyIds.push(family.id);
      const payload = { ...cloudJsonObject(family.payload_json), name };
      db.prepare(`UPDATE cloud_agent_families_v3 SET name=?,payload_json=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(name, JSON.stringify(payload), family.id);
    }
    if (!alignedFamilyIds.length) return;
    const placeholders = alignedFamilyIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT i.id,i.user_id,i.agent_family_id,i.family_instance_seq,i.display_name,i.note,i.payload_json,i.created_at,
        f.name AS family_name
      FROM cloud_user_agent_instances_v3 i JOIN cloud_agent_families_v3 f ON f.id=i.agent_family_id
      WHERE i.agent_family_id IN (${placeholders}) ORDER BY i.user_id,i.agent_family_id,i.created_at,i.id`).all(...alignedFamilyIds);
    const repaired = repairAgentInstanceProfiles(rows.map((row) => ({
      id: row.id, userId: row.user_id, agentFamilyId: row.agent_family_id,
      familyInstanceSeq: row.family_instance_seq, displayName: row.display_name,
      note: row.note || '', familyName: row.family_name, createdAt: row.created_at,
      payload: cloudJsonObject(row.payload_json),
    })));
    const update = db.prepare(`UPDATE cloud_user_agent_instances_v3 SET display_name=?,payload_json=?,
      state_revision=state_revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND id=?`);
    const changedUsers = new Set();
    const currentById = new Map(rows.map((row) => [`${row.user_id}\u001f${row.id}`, row]));
    for (const profile of repaired) {
      const current = currentById.get(`${profile.userId}\u001f${profile.id}`);
      if (!current || profile.displayName === String(current.display_name || '').trim()) continue;
      const payload = { ...(profile.payload || {}), displayName: profile.displayName };
      update.run(profile.displayName, JSON.stringify(payload), profile.userId, profile.id);
      changedUsers.add(profile.userId);
    }
    for (const userId of changedUsers) {
      db.prepare(`UPDATE cloud_employee_roster_states SET roster_revision=roster_revision+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?`).run(userId);
    }
  });
  applySyncMigration(db, 'agent_instance_sequence_compaction_v3', () => {
    const rows = db.prepare(`SELECT i.id,i.user_id,i.agent_family_id,i.family_instance_seq,i.display_name,i.note,i.payload_json,
        i.recruited_at,i.created_at,COALESCE(f.name,i.agent_family_id,'Agent') AS family_name,
        EXISTS(SELECT 1 FROM cloud_user_agent_instance_aliases_v3 alias
          WHERE alias.user_id=i.user_id AND alias.alias_instance_id=i.id) AS is_alias
      FROM cloud_user_agent_instances_v3 i LEFT JOIN cloud_agent_families_v3 f ON f.id=i.agent_family_id
      WHERE i.instance_kind='employee' ORDER BY i.user_id,i.agent_family_id,i.recruited_at,i.created_at,i.id`).all();
    const compacted = compactAgentInstanceProfiles(rows.map((row) => ({
      id: row.id, userId: row.user_id, agentFamilyId: row.agent_family_id,
      familyInstanceSeq: row.family_instance_seq, displayName: row.display_name,
      note: row.note || '', familyName: row.family_name, recruitedAt: row.recruited_at,
      createdAt: row.created_at, isAlias: Boolean(row.is_alias), payload: cloudJsonObject(row.payload_json),
    })));
    db.exec('DROP INDEX IF EXISTS idx_cloud_user_agent_instances_unique_family_seq');
    const update = db.prepare(`UPDATE cloud_user_agent_instances_v3 SET family_instance_seq=?,display_name=?,payload_json=?,
      state_revision=state_revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND id=?`);
    const changedUsers = new Set();
    for (const profile of compacted) {
      if (!profile.profileChanged) continue;
      const payload = {
        ...(profile.payload || {}),
        familyInstanceSeq: profile.familyInstanceSeq,
        displayName: profile.displayName,
        note: profile.note || '',
      };
      update.run(profile.familyInstanceSeq, profile.displayName, JSON.stringify(payload), profile.userId, profile.id);
      changedUsers.add(profile.userId);
    }
    for (const userId of changedUsers) {
      db.prepare(`UPDATE cloud_employee_roster_states SET roster_revision=roster_revision+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?`).run(userId);
    }
    db.exec(`CREATE UNIQUE INDEX idx_cloud_user_agent_instances_unique_family_seq
      ON cloud_user_agent_instances_v3(user_id,agent_family_id,family_instance_seq) WHERE family_instance_seq>0`);
  });
  applySyncMigration(db, 'multi_memory_task_security_v5', () => {
    const memoryColumns = new Set(db.prepare('PRAGMA table_info(cloud_memory_documents_v3)').all().map((row) => row.name));
    for (const [name, definition] of [
      ['display_name', "TEXT NOT NULL DEFAULT 'memory0.md'"],
      ['task_run_id', "TEXT NOT NULL DEFAULT ''"],
      ['project_id', "TEXT NOT NULL DEFAULT ''"],
      ['relationship_id', "TEXT NOT NULL DEFAULT ''"],
      ['context_space_id', "TEXT NOT NULL DEFAULT ''"],
      ['visibility', "TEXT NOT NULL DEFAULT 'private'"],
      ['source_conversation_cursor', "TEXT NOT NULL DEFAULT ''"],
      ['encryption_key_id', "TEXT NOT NULL DEFAULT ''"],
      ['consent_scope_json', "TEXT NOT NULL DEFAULT '{}'"],
    ]) if (!memoryColumns.has(name)) db.exec(`ALTER TABLE cloud_memory_documents_v3 ADD COLUMN ${name} ${definition}`);
    db.exec(`CREATE TABLE IF NOT EXISTS cloud_task_security_contexts_v5 (
      user_id TEXT NOT NULL,task_run_id TEXT NOT NULL,owner_user_id TEXT NOT NULL DEFAULT '',
      local_key_id TEXT NOT NULL,cloud_key_id TEXT NOT NULL,key_version INTEGER NOT NULL DEFAULT 1,
      cloud_evolution_allowed INTEGER NOT NULL DEFAULT 0,local_envelope_state TEXT NOT NULL DEFAULT 'reference_only',
      cloud_envelope_state TEXT NOT NULL DEFAULT 'disabled',status TEXT NOT NULL DEFAULT 'active',
      payload_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(user_id,task_run_id)
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cloud_task_security_owner_v5
      ON cloud_task_security_contexts_v5(user_id,owner_user_id,status,updated_at)`);
  });
  applySyncMigration(db, 'task_memory_encryption_v6', () => {
    const columns = new Set(db.prepare('PRAGMA table_info(cloud_task_security_contexts_v5)').all().map((row) => row.name));
    if (!columns.has('cloud_collaboration_allowed')) {
      db.exec('ALTER TABLE cloud_task_security_contexts_v5 ADD COLUMN cloud_collaboration_allowed INTEGER NOT NULL DEFAULT 0');
    }
  });
  applySyncMigration(db, 'primary_context_memory_v7', () => {
    const memoryColumns = new Set(db.prepare('PRAGMA table_info(cloud_memory_documents_v3)').all().map((row) => row.name));
    for (const [name, definition] of [
      ['agent_family_id', "TEXT NOT NULL DEFAULT ''"], ['cloud_key', "TEXT NOT NULL DEFAULT ''"],
      ['delegation_id', "TEXT NOT NULL DEFAULT ''"], ['group_id', "TEXT NOT NULL DEFAULT ''"],
      ['relationship_user_id', "TEXT NOT NULL DEFAULT ''"],
    ]) if (!memoryColumns.has(name)) db.exec(`ALTER TABLE cloud_memory_documents_v3 ADD COLUMN ${name} ${definition}`);
    const versionColumns = new Set(db.prepare('PRAGMA table_info(cloud_memory_document_versions_v3)').all().map((row) => row.name));
    for (const [name, definition] of [
      ['base_version_id', "TEXT NOT NULL DEFAULT ''"], ['parent_version_id', "TEXT NOT NULL DEFAULT ''"],
      ['branch_id', "TEXT NOT NULL DEFAULT 'main'"], ['conflict_state', "TEXT NOT NULL DEFAULT 'none'"],
    ]) if (!versionColumns.has(name)) db.exec(`ALTER TABLE cloud_memory_document_versions_v3 ADD COLUMN ${name} ${definition}`);
    db.exec("UPDATE cloud_memory_documents_v3 SET cloud_key=id WHERE cloud_key=''");
    db.exec(`CREATE TABLE IF NOT EXISTS cloud_agent_context_spaces (
      user_id TEXT NOT NULL,id TEXT NOT NULL,user_agent_instance_id TEXT NOT NULL,context_kind TEXT NOT NULL,
      memory_cloud_key TEXT NOT NULL DEFAULT '',project_id TEXT NOT NULL DEFAULT '',task_run_id TEXT NOT NULL DEFAULT '',
      delegation_id TEXT NOT NULL DEFAULT '',group_id TEXT NOT NULL DEFAULT '',relationship_user_id TEXT NOT NULL DEFAULT '',
      legacy_session_id TEXT NOT NULL DEFAULT '',lifecycle_state TEXT NOT NULL DEFAULT 'active',payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',PRIMARY KEY(user_id,id),
      UNIQUE(user_id,user_agent_instance_id,context_kind,memory_cloud_key,project_id,task_run_id,delegation_id,group_id,relationship_user_id,legacy_session_id)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS cloud_memory_sync_mappings (
      owner_user_id TEXT NOT NULL,user_agent_instance_id TEXT NOT NULL,cloud_key TEXT NOT NULL,canonical_document_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(owner_user_id,user_agent_instance_id,cloud_key)
    )`);
  });
  applySyncMigration(db, 'cloud_context_memory_contract_v8', () => {
    hardenCloudContextMemoryContract(db);
  }, { required: true });
  applySyncMigration(db, 'cloud_evidence_contract_v9', () => {
    const columns = new Set(db.prepare('PRAGMA table_info(cloud_evolution_evidence_usage)').all().map((row) => row.name));
    for (const [name, definition] of [
      ['rejection_kind', "TEXT NOT NULL DEFAULT ''"],
      ['transition_reason', "TEXT NOT NULL DEFAULT ''"],
    ]) if (!columns.has(name)) db.exec(`ALTER TABLE cloud_evolution_evidence_usage ADD COLUMN ${name} ${definition}`);
    db.exec(`UPDATE cloud_evolution_evidence_usage SET rejection_kind='legacy_unknown'
      WHERE status='evaluated_rejected' AND rejection_kind=''`);
    // Older embedded-cloud databases can already have the v8 contract marker while
    // still using the pre-ledger cohort shape. The complete trigger installer below
    // references cohort_key, identity_version, and the global claim table, so ensure
    // that shape before installing the v9 triggers. The explicit v10 migration stays
    // idempotent and records that the ledger backfill completed.
    migrateClusterCohortLedgerContract(db);
    installCloudContractTriggers(db);
  }, { required: true });
  applySyncMigration(db, 'cluster_cohort_ledger_contract_v10', () => {
    migrateClusterCohortLedgerContract(db);
    installCloudContractTriggers(db);
  }, { required: true });
  applySyncMigration(db, 'evidence_usage_events_v11', () => {
    db.exec(`CREATE TABLE IF NOT EXISTS cloud_evolution_evidence_usage_events (
      id TEXT PRIMARY KEY,evidence_id TEXT NOT NULL,evolution_scope TEXT NOT NULL,consumer_id TEXT NOT NULL,
      from_status TEXT NOT NULL DEFAULT '',to_status TEXT NOT NULL,run_id TEXT NOT NULL DEFAULT '',
      algorithm_version TEXT NOT NULL DEFAULT '',rejection_kind TEXT NOT NULL DEFAULT '',transition_reason TEXT NOT NULL DEFAULT '',
      re_evaluation_basis_hash TEXT NOT NULL DEFAULT '',occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY(evidence_id) REFERENCES cloud_evolution_evidence(evidence_id) ON DELETE CASCADE
    ); CREATE INDEX IF NOT EXISTS idx_cloud_evolution_usage_events_subject
      ON cloud_evolution_evidence_usage_events(evolution_scope,consumer_id,occurred_at,id);`);
    for (const row of db.prepare('SELECT * FROM cloud_evolution_evidence_usage').all()) {
      const id = `usage_event_legacy_${crypto.createHash('sha256').update(`${row.evidence_id}\n${row.evolution_scope}\n${row.consumer_id}`).digest('hex').slice(0, 32)}`;
      db.prepare(`INSERT OR IGNORE INTO cloud_evolution_evidence_usage_events (
        id,evidence_id,evolution_scope,consumer_id,from_status,to_status,run_id,algorithm_version,rejection_kind,
        transition_reason,re_evaluation_basis_hash,occurred_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,row.evidence_id,row.evolution_scope,row.consumer_id,'',row.status,row.run_id || '',
        row.algorithm_version || '',row.rejection_kind || '',row.transition_reason || 'legacy_snapshot',row.re_evaluation_basis_hash || '',row.updated_at);
    }
  }, { required: true });
  applySyncMigration(db, 'cluster_market_lifecycle_v12', () => {
    migrateClusterMarketLifecycleContract(db);
    installCloudContractTriggers(db);
  }, { required: true });
  applySyncMigration(db, 'cluster_stage01_contract_v13', () => {
    migrateClusterCohortLedgerContract(db);
    migrateClusterMarketLifecycleContract(db);
    migrateClusterStage01Contract(db);
    installCloudContractTriggers(db);
  }, { required: true });
  applySyncMigration(db, 'evidence_collection_ledger_v14', () => {
    const columns = new Set(db.prepare('PRAGMA table_info(cloud_evolution_evidence)').all().map((row) => row.name));
    if (!columns.has('personal_threshold_eligible')) db.exec('ALTER TABLE cloud_evolution_evidence ADD COLUMN personal_threshold_eligible INTEGER NOT NULL DEFAULT 1');
    if (!columns.has('eligibility_policy_version')) db.exec("ALTER TABLE cloud_evolution_evidence ADD COLUMN eligibility_policy_version TEXT NOT NULL DEFAULT 'personal_threshold_v1'");
    db.exec(`UPDATE cloud_evolution_evidence SET personal_threshold_eligible=CASE WHEN source_kind IN (
      'message','conversation_segment','collaboration_message','memory_version','task_shared_summary',
      'task_result','task_acceptance','task_rework','task_failure','task_blocked','task_cancelled',
      'task_node_result','task_retrospective','model_execution','model_execution_metric') THEN 1 ELSE 0 END,
      eligibility_policy_version='personal_threshold_v1';
      CREATE INDEX IF NOT EXISTS idx_cloud_evidence_personal_threshold
      ON cloud_evolution_evidence(owner_user_id,user_agent_instance_id,personal_threshold_eligible,occurred_at,evidence_id)
      WHERE quarantine_reason='';`);
  }, { required: true });
  applySyncMigration(db, 'evidence_validation_lineage_v15', () => {
    const columns = new Set(db.prepare('PRAGMA table_info(cloud_evolution_evidence)').all().map((row) => row.name));
    for (const [name, definition] of [
      ['lineage_key', "TEXT NOT NULL DEFAULT ''"],
      ['validation_status', "TEXT NOT NULL DEFAULT 'validated'"],
      ['validation_policy_version', "TEXT NOT NULL DEFAULT 'legacy_backfill_v1'"],
      ['validation_json', "TEXT NOT NULL DEFAULT '{}'"],
      ['validated_at', "TEXT NOT NULL DEFAULT ''"],
      ['historical_inactive', 'INTEGER NOT NULL DEFAULT 0'],
    ]) if (!columns.has(name)) db.exec(`ALTER TABLE cloud_evolution_evidence ADD COLUMN ${name} ${definition}`);
    db.exec(`UPDATE cloud_evolution_evidence SET
      lineage_key=CASE WHEN lineage_key<>'' THEN lineage_key WHEN source_kind='conversation_segment'
        THEN 'conversation:'||source_id||':'||source_version_id ELSE source_kind||':'||source_id||':'||source_version_id END,
      validation_status=CASE WHEN quarantine_reason='' THEN 'validated' ELSE 'quarantined' END,
      validation_policy_version=CASE WHEN validation_policy_version='' THEN 'legacy_backfill_v1' ELSE validation_policy_version END,
      validated_at=CASE WHEN quarantine_reason='' AND validated_at='' THEN ingested_at ELSE validated_at END;
      CREATE INDEX IF NOT EXISTS idx_cloud_evidence_validation
        ON cloud_evolution_evidence(validation_status,ingested_at,evidence_id);
      CREATE INDEX IF NOT EXISTS idx_cloud_evidence_lineage
        ON cloud_evolution_evidence(owner_user_id,user_agent_instance_id,lineage_key,occurred_at,evidence_id);
      CREATE TABLE IF NOT EXISTS cloud_evolution_evidence_validation_jobs (
        evidence_id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'queued',attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,available_at TEXT NOT NULL DEFAULT '',claimed_by TEXT NOT NULL DEFAULT '',
        claimed_at TEXT NOT NULL DEFAULT '',lease_expires_at TEXT NOT NULL DEFAULT '',error_code TEXT NOT NULL DEFAULT '',
        error_text TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',completed_at TEXT NOT NULL DEFAULT '',
        CHECK(status IN ('queued','claimed','completed','failed_retryable','failed_terminal','quarantined')),
        FOREIGN KEY(evidence_id) REFERENCES cloud_evolution_evidence(evidence_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_evidence_validation_jobs_claim
        ON cloud_evolution_evidence_validation_jobs(status,available_at,lease_expires_at);
      CREATE TABLE IF NOT EXISTS cloud_evolution_evidence_quarantine (
        id TEXT PRIMARY KEY,evidence_id TEXT NOT NULL DEFAULT '',owner_user_id TEXT NOT NULL DEFAULT '',
        user_agent_instance_id TEXT NOT NULL DEFAULT '',source_kind TEXT NOT NULL DEFAULT '',source_id TEXT NOT NULL DEFAULT '',
        source_version_id TEXT NOT NULL DEFAULT '',reason_code TEXT NOT NULL,reason_text TEXT NOT NULL DEFAULT '',
        retryable INTEGER NOT NULL DEFAULT 0,resolution_status TEXT NOT NULL DEFAULT 'pending',resolution_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',resolved_at TEXT NOT NULL DEFAULT '',
        CHECK(resolution_status IN ('pending','released','rejected','resolved'))
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_evidence_quarantine_subject
        ON cloud_evolution_evidence_quarantine(owner_user_id,resolution_status,created_at,id);`);
  }, { required: true });
  applySyncMigration(db, 'evolution_worker_security_v16', () => {
    const columns = new Set(db.prepare('PRAGMA table_info(cloud_evolution_evidence)').all().map((row) => row.name));
    for (const [name, definition] of [
      ['wrapped_data_key', "TEXT NOT NULL DEFAULT ''"],['key_wrap_algorithm', "TEXT NOT NULL DEFAULT ''"],
      ['key_version', 'INTEGER NOT NULL DEFAULT 0'],['envelope_format', "TEXT NOT NULL DEFAULT 'legacy_symmetric'"],
    ]) if (!columns.has(name)) db.exec(`ALTER TABLE cloud_evolution_evidence ADD COLUMN ${name} ${definition}`);
    db.exec(`CREATE TABLE IF NOT EXISTS cloud_evolution_evidence_access_audits (
      id TEXT PRIMARY KEY,worker_identity TEXT NOT NULL,run_id TEXT NOT NULL DEFAULT '',evidence_id TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL,result TEXT NOT NULL,result_code TEXT NOT NULL DEFAULT '',key_id TEXT NOT NULL DEFAULT '',
      detail_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT '',
      CHECK(result IN ('allowed','denied','failed'))
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_evidence_access_audit_subject
      ON cloud_evolution_evidence_access_audits(evidence_id,created_at,id);
    CREATE INDEX IF NOT EXISTS idx_cloud_evidence_access_audit_run
      ON cloud_evolution_evidence_access_audits(run_id,created_at,id);`);
  }, { required: true });
  applySyncMigration(db, 'market_section_support_privacy_v17', () => {
    db.exec(`CREATE TABLE IF NOT EXISTS cloud_market_candidate_section_supports (
      candidate_id TEXT NOT NULL,agent_family_id TEXT NOT NULL,section_id TEXT NOT NULL,evidence_id TEXT NOT NULL,
      user_agent_instance_id TEXT NOT NULL,contributor_id TEXT NOT NULL,evidence_handle TEXT NOT NULL,
      support_confidence REAL NOT NULL,deterministic_pass INTEGER NOT NULL DEFAULT 0,reviewer_pass INTEGER NOT NULL DEFAULT 0,
      review_stage TEXT NOT NULL DEFAULT 'initial_gate',created_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(candidate_id,agent_family_id,section_id,evidence_id),CHECK(support_confidence>=0 AND support_confidence<=1)
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_market_candidate_support_section
      ON cloud_market_candidate_section_supports(candidate_id,agent_family_id,section_id,contributor_id);
    CREATE TABLE IF NOT EXISTS cloud_market_candidate_privacy_reviews (
      id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,agent_family_id TEXT NOT NULL DEFAULT '',review_stage TEXT NOT NULL,
      deterministic_status TEXT NOT NULL,reviewer_status TEXT NOT NULL,finding_codes_json TEXT NOT NULL DEFAULT '[]',
      review_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT '',
      UNIQUE(candidate_id,agent_family_id,review_stage)
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_market_candidate_privacy_review
      ON cloud_market_candidate_privacy_reviews(candidate_id,review_stage,agent_family_id);`);
  }, { required: true });
  applySyncMigration(db, 'cluster_contract_alignment_v18', () => {
    const columns = new Set(db.prepare('PRAGMA table_info(cloud_agent_cohorts)').all().map((row) => row.name));
    for (const [name, definition] of [
      ['minimum_user_count', 'INTEGER NOT NULL DEFAULT 7'],
      ['maximum_user_weight_share', 'REAL NOT NULL DEFAULT 0.15'],
      ['participation_policy_version', "TEXT NOT NULL DEFAULT 'cluster_active_synced_mandatory_v1'"],
    ]) if (!columns.has(name)) db.exec(`ALTER TABLE cloud_agent_cohorts ADD COLUMN ${name} ${definition}`);
    db.exec(`UPDATE cloud_agent_cohorts SET minimum_user_count=7,maximum_user_weight_share=0.15,
      participation_policy_version='cluster_active_synced_mandatory_v1';
    DROP TRIGGER IF EXISTS trg_cloud_cluster_alignment_insert;
    DROP TRIGGER IF EXISTS trg_cloud_cluster_alignment_update;
    CREATE TRIGGER trg_cloud_cluster_alignment_insert BEFORE INSERT ON cloud_agent_cohorts BEGIN
      SELECT CASE WHEN NEW.minimum_user_count<>7 OR NEW.maximum_user_weight_share<>0.15 OR
        NEW.participation_policy_version<>'cluster_active_synced_mandatory_v1' THEN RAISE(ABORT,'invalid cluster alignment contract') END;
    END;
    CREATE TRIGGER trg_cloud_cluster_alignment_update BEFORE UPDATE ON cloud_agent_cohorts BEGIN
      SELECT CASE WHEN NEW.minimum_user_count<>7 OR NEW.maximum_user_weight_share<>0.15 OR
        NEW.participation_policy_version<>'cluster_active_synced_mandatory_v1' THEN RAISE(ABORT,'invalid cluster alignment contract') END;
    END;`);
  }, { required: true });
  applySyncMigration(db, 'cluster_feedback_performance_v2_v19', () => {
    const taskRunColumns = new Set(db.prepare('PRAGMA table_info(cloud_task_runs)').all().map((row) => row.name));
    if (!taskRunColumns.has('owner_user_id')) db.exec("ALTER TABLE cloud_task_runs ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT ''");
    const taskNodeColumns = new Set(db.prepare('PRAGMA table_info(cloud_task_nodes)').all().map((row) => row.name));
    if (!taskNodeColumns.has('user_agent_instance_id')) db.exec("ALTER TABLE cloud_task_nodes ADD COLUMN user_agent_instance_id TEXT NOT NULL DEFAULT ''");
    const taskEventColumns = new Set(db.prepare('PRAGMA table_info(cloud_task_events)').all().map((row) => row.name));
    if (!taskEventColumns.has('privacy_level')) db.exec("ALTER TABLE cloud_task_events ADD COLUMN privacy_level TEXT NOT NULL DEFAULT 'owner_private'");
    if (!taskEventColumns.has('updated_at')) {
      db.exec("ALTER TABLE cloud_task_events ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
      db.exec("UPDATE cloud_task_events SET updated_at=created_at WHERE updated_at=''");
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_cloud_task_events_updated ON cloud_task_events(updated_at,id)');
    const columns = new Set(db.prepare('PRAGMA table_info(cloud_agent_performance_events)').all().map((row) => row.name));
    for (const [name, definition] of [
      ['source_kind', "TEXT NOT NULL DEFAULT 'legacy_client'"], ['source_id', "TEXT NOT NULL DEFAULT ''"],
      ['source_version_id', "TEXT NOT NULL DEFAULT ''"], ['source_hash', "TEXT NOT NULL DEFAULT ''"],
      ['authority', "TEXT NOT NULL DEFAULT 'legacy_client'"], ['validation_status', "TEXT NOT NULL DEFAULT 'legacy'"],
    ]) if (!columns.has(name)) db.exec(`ALTER TABLE cloud_agent_performance_events ADD COLUMN ${name} ${definition}`);
    db.exec(`UPDATE cloud_agent_performance_events SET
      source_kind=CASE WHEN source_kind='' THEN 'legacy_client' ELSE source_kind END,
      authority=CASE WHEN authority='' THEN 'legacy_client' ELSE authority END,
      validation_status=CASE WHEN validation_status='' THEN 'legacy' ELSE validation_status END;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_performance_authoritative_source
      ON cloud_agent_performance_events(owner_user_id,user_agent_instance_id,source_kind,source_id,source_version_id)
      WHERE source_id<>'' AND validation_status='validated';
    CREATE INDEX IF NOT EXISTS idx_cloud_performance_authoritative_window
      ON cloud_agent_performance_events(user_agent_instance_id,authority,validation_status,occurred_at);
    CREATE INDEX IF NOT EXISTS idx_cloud_performance_peer_baseline
      ON cloud_agent_performance_events(task_type_key,agent_family_id,authority,validation_status,occurred_at);
    CREATE TABLE IF NOT EXISTS cloud_performance_backfill_cursors (
      cursor_key TEXT PRIMARY KEY,last_updated_at TEXT NOT NULL DEFAULT '',last_source_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',updated_at TEXT NOT NULL DEFAULT '',CHECK(status IN ('active','completed'))
    );
    INSERT OR IGNORE INTO cloud_performance_backfill_cursors(cursor_key,status) VALUES('task_nodes','active');
    DROP TRIGGER IF EXISTS trg_cloud_performance_event_authority_insert;
    DROP TRIGGER IF EXISTS trg_cloud_performance_event_authority_update;
    CREATE TRIGGER trg_cloud_performance_event_authority_insert BEFORE INSERT ON cloud_agent_performance_events BEGIN
      SELECT CASE WHEN NEW.authority NOT IN ('cloud','legacy_client') OR NEW.validation_status NOT IN ('validated','deferred','rejected','legacy')
        THEN RAISE(ABORT,'invalid performance event authority') END;
    END;
    CREATE TRIGGER trg_cloud_performance_event_authority_update BEFORE UPDATE ON cloud_agent_performance_events BEGIN
      SELECT CASE WHEN NEW.authority NOT IN ('cloud','legacy_client') OR NEW.validation_status NOT IN ('validated','deferred','rejected','legacy')
        THEN RAISE(ABORT,'invalid performance event authority') END;
    END;`);
  }, { required: true });
  applySyncMigration(db, 'stage123_authority_closure_v20', () => {
    db.exec(`WITH ranked AS (
      SELECT user_id,id,ROW_NUMBER() OVER (
        PARTITION BY user_id,user_agent_instance_id ORDER BY updated_at DESC,slot_no DESC,id DESC
      ) AS row_no FROM cloud_memory_documents_v3
      WHERE scope='general' AND lifecycle_state='active'
    ) UPDATE cloud_memory_documents_v3 SET lifecycle_state='inactive'
      WHERE id IN (SELECT id FROM ranked WHERE row_no>1);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_one_active_general_memory
      ON cloud_memory_documents_v3(user_id,user_agent_instance_id)
      WHERE scope='general' AND lifecycle_state='active';
    CREATE TABLE IF NOT EXISTS cloud_agent_context_states (
      owner_user_id TEXT NOT NULL,user_agent_instance_id TEXT NOT NULL,
      primary_conversation_id TEXT NOT NULL DEFAULT '',active_context_space_id TEXT NOT NULL DEFAULT '',
      active_memory_document_id TEXT NOT NULL DEFAULT '',state_revision INTEGER NOT NULL DEFAULT 1 CHECK(state_revision>=1),
      last_command_id TEXT NOT NULL DEFAULT '',source_device_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY(owner_user_id,user_agent_instance_id),
      FOREIGN KEY(owner_user_id,user_agent_instance_id) REFERENCES cloud_user_agent_instances_v3(user_id,id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_agent_context_states_updated
      ON cloud_agent_context_states(owner_user_id,updated_at,user_agent_instance_id);
    INSERT OR IGNORE INTO cloud_agent_context_states(
      owner_user_id,user_agent_instance_id,active_context_space_id,active_memory_document_id,state_revision,last_command_id
    ) SELECT i.user_id,i.id,
      COALESCE((SELECT c.id FROM cloud_agent_context_spaces c JOIN cloud_memory_documents_v3 d
        ON d.user_id=c.user_id AND d.id=c.memory_document_id
        WHERE c.user_id=i.user_id AND c.user_agent_instance_id=i.id AND c.context_kind='general_memory'
          AND d.scope='general' AND d.lifecycle_state='active'
        ORDER BY d.updated_at DESC,d.slot_no DESC,d.id DESC LIMIT 1),''),
      COALESCE((SELECT d.id FROM cloud_memory_documents_v3 d
        WHERE d.user_id=i.user_id AND d.user_agent_instance_id=i.id AND d.scope='general' AND d.lifecycle_state='active'
        ORDER BY d.updated_at DESC,d.slot_no DESC,d.id DESC LIMIT 1),''),1,'migration_v20'
      FROM cloud_user_agent_instances_v3 i;
    UPDATE cloud_user_agent_instances_v3 SET cluster_contribution_consent=CASE
      WHEN sync_enabled=1 AND status='active' THEN 1 ELSE 0 END;
    UPDATE cloud_memory_documents_v3 SET
      allow_personal_evolution=COALESCE((SELECT personal_evolution_consent FROM cloud_user_agent_instances_v3 i
        WHERE i.user_id=cloud_memory_documents_v3.user_id AND i.id=cloud_memory_documents_v3.user_agent_instance_id),allow_personal_evolution),
      allow_cluster_evolution=COALESCE((SELECT CASE WHEN i.sync_enabled=1 AND i.status='active' THEN 1 ELSE 0 END
        FROM cloud_user_agent_instances_v3 i WHERE i.user_id=cloud_memory_documents_v3.user_id
          AND i.id=cloud_memory_documents_v3.user_agent_instance_id),allow_cluster_evolution),
      sync_enabled=COALESCE((SELECT sync_enabled FROM cloud_user_agent_instances_v3 i
        WHERE i.user_id=cloud_memory_documents_v3.user_id AND i.id=cloud_memory_documents_v3.user_agent_instance_id),sync_enabled);
    DROP TRIGGER IF EXISTS trg_cloud_cluster_participation_insert;
    DROP TRIGGER IF EXISTS trg_cloud_cluster_participation_update;
    CREATE TRIGGER trg_cloud_cluster_participation_insert AFTER INSERT ON cloud_user_agent_instances_v3
    WHEN NEW.cluster_contribution_consent<>CASE WHEN NEW.sync_enabled=1 AND NEW.status='active' THEN 1 ELSE 0 END BEGIN
      UPDATE cloud_user_agent_instances_v3 SET cluster_contribution_consent=CASE
        WHEN NEW.sync_enabled=1 AND NEW.status='active' THEN 1 ELSE 0 END
        WHERE user_id=NEW.user_id AND id=NEW.id;
    END;
    CREATE TRIGGER trg_cloud_cluster_participation_update AFTER UPDATE OF sync_enabled,status,cluster_contribution_consent
    ON cloud_user_agent_instances_v3
    WHEN NEW.cluster_contribution_consent<>CASE WHEN NEW.sync_enabled=1 AND NEW.status='active' THEN 1 ELSE 0 END BEGIN
      UPDATE cloud_user_agent_instances_v3 SET cluster_contribution_consent=CASE
        WHEN NEW.sync_enabled=1 AND NEW.status='active' THEN 1 ELSE 0 END
        WHERE user_id=NEW.user_id AND id=NEW.id;
    END;`);
  }, { required: true });
  applySyncMigration(db, 'chat_context_state_v21', () => {
    db.exec(`CREATE TABLE IF NOT EXISTS cloud_chat_context_states (
      id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,session_id TEXT NOT NULL,context_space_id TEXT NOT NULL DEFAULT '',
      context_epoch INTEGER NOT NULL DEFAULT 1,reset_after_message_id TEXT NOT NULL DEFAULT '',
      reset_after_created_at TEXT NOT NULL DEFAULT '',last_execution_id TEXT NOT NULL DEFAULT '',
      last_input_tokens INTEGER NOT NULL DEFAULT 0,context_window_tokens INTEGER NOT NULL DEFAULT 0,
      provider_compaction_detected INTEGER NOT NULL DEFAULT 0,state_revision INTEGER NOT NULL DEFAULT 1,
      last_command_id TEXT NOT NULL DEFAULT '',source_device_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(owner_user_id,session_id,context_space_id),CHECK(context_epoch>=1),CHECK(state_revision>=1)
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_chat_context_states_updated
      ON cloud_chat_context_states(owner_user_id,updated_at,id);
    CREATE INDEX IF NOT EXISTS idx_cloud_chat_context_states_session
      ON cloud_chat_context_states(owner_user_id,session_id,context_space_id);`);
  }, { required: true });
  applySyncMigration(db, 'evolution_default_on_manual_activation_v22', () => {
    relaxSqliteContract(db, 'cloud_evolution_runs', "'proposed','canary','applied'", "'proposed','available','canary','applied'");
    relaxSqliteContract(db, 'cloud_personal_evolution_schedule_states', "'queued','applied'", "'queued','available','applied'");
    db.exec(`CREATE TABLE IF NOT EXISTS cloud_user_evolution_preferences (
      user_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1,
      policy_version TEXT NOT NULL DEFAULT 'evolution_default_on_account_pause_v1',
      state_revision INTEGER NOT NULL DEFAULT 1,last_command_id TEXT NOT NULL DEFAULT '',paused_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),CHECK(state_revision>=1)
    );
    CREATE TABLE IF NOT EXISTS cloud_personal_version_commands (
      user_id TEXT NOT NULL,command_id TEXT NOT NULL,user_agent_instance_id TEXT NOT NULL,action TEXT NOT NULL,
      target_version_id TEXT NOT NULL DEFAULT '',expected_active_version_id TEXT NOT NULL DEFAULT '',
      previous_active_version_id TEXT NOT NULL DEFAULT '',result_active_version_id TEXT NOT NULL DEFAULT '',
      actor_device_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'confirmed',error_code TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      completed_at TEXT NOT NULL DEFAULT '',PRIMARY KEY(user_id,command_id),
      CHECK(action IN ('activate','rollback')),CHECK(status IN ('confirmed','rejected'))
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_personal_version_commands_instance
      ON cloud_personal_version_commands(user_id,user_agent_instance_id,created_at DESC);
    INSERT OR IGNORE INTO cloud_user_evolution_preferences(user_id,enabled)
      SELECT id,1 FROM users;
    UPDATE cloud_user_agent_instances_v3 SET
      personal_evolution_consent=CASE WHEN sync_enabled=1 AND status='active' THEN 1 ELSE 0 END,
      cluster_contribution_consent=CASE WHEN sync_enabled=1 AND status='active' THEN 1 ELSE 0 END,
      personal_skill_auto_activate=0;
    UPDATE cloud_memory_documents_v3 SET
      allow_personal_evolution=COALESCE((SELECT CASE WHEN i.sync_enabled=1 AND i.status='active' THEN 1 ELSE 0 END
        FROM cloud_user_agent_instances_v3 i WHERE i.user_id=cloud_memory_documents_v3.user_id
          AND i.id=cloud_memory_documents_v3.user_agent_instance_id),0),
      allow_cluster_evolution=COALESCE((SELECT CASE WHEN i.sync_enabled=1 AND i.status='active' THEN 1 ELSE 0 END
        FROM cloud_user_agent_instances_v3 i WHERE i.user_id=cloud_memory_documents_v3.user_id
          AND i.id=cloud_memory_documents_v3.user_agent_instance_id),0);
    DROP TRIGGER IF EXISTS trg_cloud_cluster_participation_insert;
    DROP TRIGGER IF EXISTS trg_cloud_cluster_participation_update;
    DROP TRIGGER IF EXISTS trg_cloud_evolution_preference_update;
    CREATE TRIGGER trg_cloud_cluster_participation_insert AFTER INSERT ON cloud_user_agent_instances_v3 BEGIN
      UPDATE cloud_user_agent_instances_v3 SET
        personal_evolution_consent=CASE WHEN NEW.sync_enabled=1 AND NEW.status='active'
          AND COALESCE((SELECT enabled FROM cloud_user_evolution_preferences WHERE user_id=NEW.user_id),1)=1 THEN 1 ELSE 0 END,
        cluster_contribution_consent=CASE WHEN NEW.sync_enabled=1 AND NEW.status='active'
          AND COALESCE((SELECT enabled FROM cloud_user_evolution_preferences WHERE user_id=NEW.user_id),1)=1 THEN 1 ELSE 0 END,
        personal_skill_auto_activate=0 WHERE user_id=NEW.user_id AND id=NEW.id;
    END;
    CREATE TRIGGER trg_cloud_cluster_participation_update AFTER UPDATE OF sync_enabled,status,personal_evolution_consent,cluster_contribution_consent,personal_skill_auto_activate
    ON cloud_user_agent_instances_v3 BEGIN
      UPDATE cloud_user_agent_instances_v3 SET
        personal_evolution_consent=CASE WHEN NEW.sync_enabled=1 AND NEW.status='active'
          AND COALESCE((SELECT enabled FROM cloud_user_evolution_preferences WHERE user_id=NEW.user_id),1)=1 THEN 1 ELSE 0 END,
        cluster_contribution_consent=CASE WHEN NEW.sync_enabled=1 AND NEW.status='active'
          AND COALESCE((SELECT enabled FROM cloud_user_evolution_preferences WHERE user_id=NEW.user_id),1)=1 THEN 1 ELSE 0 END,
        personal_skill_auto_activate=0 WHERE user_id=NEW.user_id AND id=NEW.id;
    END;
    CREATE TRIGGER trg_cloud_evolution_preference_update AFTER UPDATE OF enabled ON cloud_user_evolution_preferences BEGIN
      UPDATE cloud_user_agent_instances_v3 SET
        personal_evolution_consent=CASE WHEN NEW.enabled=1 AND sync_enabled=1 AND status='active' THEN 1 ELSE 0 END,
        cluster_contribution_consent=CASE WHEN NEW.enabled=1 AND sync_enabled=1 AND status='active' THEN 1 ELSE 0 END,
        personal_skill_auto_activate=0 WHERE user_id=NEW.user_id;
      UPDATE cloud_memory_documents_v3 SET
        allow_personal_evolution=CASE WHEN NEW.enabled=1 AND sync_enabled=1 AND lifecycle_state='active' THEN 1 ELSE 0 END,
        allow_cluster_evolution=CASE WHEN NEW.enabled=1 AND sync_enabled=1 AND lifecycle_state='active' THEN 1 ELSE 0 END
        WHERE user_id=NEW.user_id;
    END;`);
  }, { required: true });
  applySyncMigration(db, 'mandatory_evolution_upload_v24', () => {
    db.exec(`UPDATE cloud_user_evolution_preferences SET
      enabled=1,policy_version='evolution_mandatory_upload_v1',paused_at='',
      state_revision=state_revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE enabled<>1 OR policy_version<>'evolution_mandatory_upload_v1' OR paused_at<>'';
    UPDATE cloud_user_agent_instances_v3 SET
      personal_evolution_consent=CASE WHEN sync_enabled=1 AND status='active' THEN 1 ELSE 0 END,
      cluster_contribution_consent=CASE WHEN sync_enabled=1 AND status='active' THEN 1 ELSE 0 END,
      personal_skill_auto_activate=0;
    UPDATE cloud_memory_documents_v3 SET
      allow_personal_evolution=COALESCE((SELECT CASE WHEN i.sync_enabled=1 AND i.status='active'
        AND cloud_memory_documents_v3.lifecycle_state='active' THEN 1 ELSE 0 END
        FROM cloud_user_agent_instances_v3 i WHERE i.user_id=cloud_memory_documents_v3.user_id
          AND i.id=cloud_memory_documents_v3.user_agent_instance_id),0),
      allow_cluster_evolution=COALESCE((SELECT CASE WHEN i.sync_enabled=1 AND i.status='active'
        AND cloud_memory_documents_v3.lifecycle_state='active' THEN 1 ELSE 0 END
        FROM cloud_user_agent_instances_v3 i WHERE i.user_id=cloud_memory_documents_v3.user_id
          AND i.id=cloud_memory_documents_v3.user_agent_instance_id),0);
    DROP TRIGGER IF EXISTS trg_cloud_cluster_participation_insert;
    DROP TRIGGER IF EXISTS trg_cloud_cluster_participation_update;
    DROP TRIGGER IF EXISTS trg_cloud_evolution_preference_update;
    CREATE TRIGGER trg_cloud_cluster_participation_insert AFTER INSERT ON cloud_user_agent_instances_v3 BEGIN
      UPDATE cloud_user_agent_instances_v3 SET
        personal_evolution_consent=CASE WHEN NEW.sync_enabled=1 AND NEW.status='active' THEN 1 ELSE 0 END,
        cluster_contribution_consent=CASE WHEN NEW.sync_enabled=1 AND NEW.status='active' THEN 1 ELSE 0 END,
        personal_skill_auto_activate=0 WHERE user_id=NEW.user_id AND id=NEW.id;
    END;
    CREATE TRIGGER trg_cloud_cluster_participation_update AFTER UPDATE OF sync_enabled,status,personal_evolution_consent,cluster_contribution_consent,personal_skill_auto_activate
    ON cloud_user_agent_instances_v3 BEGIN
      UPDATE cloud_user_agent_instances_v3 SET
        personal_evolution_consent=CASE WHEN NEW.sync_enabled=1 AND NEW.status='active' THEN 1 ELSE 0 END,
        cluster_contribution_consent=CASE WHEN NEW.sync_enabled=1 AND NEW.status='active' THEN 1 ELSE 0 END,
        personal_skill_auto_activate=0 WHERE user_id=NEW.user_id AND id=NEW.id;
    END;
    CREATE TRIGGER trg_cloud_evolution_preference_update AFTER UPDATE OF enabled ON cloud_user_evolution_preferences
    WHEN NEW.enabled<>1 OR NEW.policy_version<>'evolution_mandatory_upload_v1' BEGIN
      UPDATE cloud_user_evolution_preferences SET enabled=1,policy_version='evolution_mandatory_upload_v1',paused_at=''
        WHERE user_id=NEW.user_id;
      UPDATE cloud_user_agent_instances_v3 SET
        personal_evolution_consent=CASE WHEN sync_enabled=1 AND status='active' THEN 1 ELSE 0 END,
        cluster_contribution_consent=CASE WHEN sync_enabled=1 AND status='active' THEN 1 ELSE 0 END,
        personal_skill_auto_activate=0 WHERE user_id=NEW.user_id;
      UPDATE cloud_memory_documents_v3 SET
        allow_personal_evolution=CASE WHEN sync_enabled=1 AND lifecycle_state='active' THEN 1 ELSE 0 END,
        allow_cluster_evolution=CASE WHEN sync_enabled=1 AND lifecycle_state='active' THEN 1 ELSE 0 END
        WHERE user_id=NEW.user_id;
    END;`);
  }, { required: true });
  applyAccountWorkspaceCloudMigration(db);
}

function applyAccountWorkspaceCloudMigration(db) {
  applySyncMigration(db, 'account_workspaces_v23', () => {
    db.exec(`CREATE TABLE IF NOT EXISTS account_workspaces(
        id TEXT PRIMARY KEY,workspace_kind TEXT NOT NULL,organization_id TEXT NOT NULL DEFAULT '',owner_user_id TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',avatar_url TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS account_workspace_memberships(
        workspace_id TEXT NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',status TEXT NOT NULL DEFAULT 'active',display_name TEXT NOT NULL DEFAULT '',avatar_url TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),PRIMARY KEY(workspace_id,user_id)
      );`);
    for (const table of ['social_messages','agent_delegations','collaboration_groups','collaboration_group_messages','cloud_task_runs']) {
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
      if (!columns.has('account_workspace_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal'`);
    }
    db.exec(`INSERT INTO account_workspaces(id,workspace_kind,name,status) VALUES('workspace_personal','personal','个人空间','active')
        ON CONFLICT(id) DO UPDATE SET status='active',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
      INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,display_name,avatar_url,joined_at,updated_at)
        SELECT 'workspace_personal',id,'owner','active',display_name,avatar_url,created_at,updated_at FROM users WHERE 1=1
        ON CONFLICT(workspace_id,user_id) DO UPDATE SET status='active',display_name=excluded.display_name,avatar_url=excluded.avatar_url,updated_at=excluded.updated_at;
      INSERT INTO account_workspaces(id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at)
        SELECT 'workspace_org_'||id,'organization',id,owner_user_id,name,'active',created_at,updated_at FROM contact_organizations WHERE 1=1
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,status='active',updated_at=excluded.updated_at;
      INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,joined_at,updated_at)
        SELECT 'workspace_org_'||organization_id,user_id,CASE WHEN role IN ('owner','admin') THEN role ELSE 'member' END,'active',joined_at,updated_at
        FROM contact_organization_members WHERE 1=1 ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active',updated_at=excluded.updated_at;
      UPDATE collaboration_group_messages SET account_workspace_id=COALESCE((SELECT account_workspace_id FROM collaboration_groups g WHERE g.id=collaboration_group_messages.group_id),'workspace_personal');
      CREATE INDEX IF NOT EXISTS idx_cloud_social_messages_workspace ON social_messages(account_workspace_id,recipient_user_id,updated_at);
      CREATE INDEX IF NOT EXISTS idx_cloud_agent_delegations_workspace ON agent_delegations(account_workspace_id,requester_user_id,recipient_user_id,updated_at);
      CREATE INDEX IF NOT EXISTS idx_cloud_collaboration_groups_workspace ON collaboration_groups(account_workspace_id,updated_at);
      CREATE INDEX IF NOT EXISTS idx_cloud_collaboration_messages_workspace ON collaboration_group_messages(account_workspace_id,group_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_cloud_task_runs_workspace ON cloud_task_runs(account_workspace_id,owner_user_id,updated_at);`);
  });
  applySyncMigration(db, 'account_workspace_tasks_v24', () => {
    const taskRunColumns = new Set(db.prepare('PRAGMA table_info(cloud_task_runs)').all().map((column) => column.name));
    if (!taskRunColumns.has('account_workspace_id')) {
      db.exec("ALTER TABLE cloud_task_runs ADD COLUMN account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal'");
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_cloud_task_runs_workspace ON cloud_task_runs(account_workspace_id,owner_user_id,updated_at)');
  }, { required: true });
  applySyncMigration(db, 'account_principal_isolation_v25', () => {
    db.exec(`CREATE TABLE IF NOT EXISTS accounts(
        id TEXT PRIMARY KEY,account_kind TEXT NOT NULL,owner_user_id TEXT NOT NULL DEFAULT '',organization_id TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK(account_kind IN ('personal','organization')),
        CHECK((account_kind='personal' AND owner_user_id!='' AND organization_id='') OR (account_kind='organization' AND organization_id!=''))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_accounts_personal_owner ON accounts(owner_user_id) WHERE account_kind='personal';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_accounts_organization ON accounts(organization_id) WHERE account_kind='organization';
      CREATE TABLE IF NOT EXISTS account_memberships_v8(
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',status TEXT NOT NULL DEFAULT 'active',joined_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(account_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS account_workspace_bindings_v8(
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,
        user_id_scope TEXT NOT NULL DEFAULT '',binding_kind TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(account_id,workspace_id,user_id_scope),UNIQUE(workspace_id,user_id_scope)
      );
      INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
        SELECT 'account_personal_'||id,'personal',id,'',display_name,'active',created_at,updated_at FROM users WHERE 1=1
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,status='active',updated_at=excluded.updated_at;
      INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
        SELECT 'account_personal_'||id,id,'owner','active',created_at,updated_at FROM users WHERE 1=1
        ON CONFLICT(account_id,user_id) DO UPDATE SET status='active',updated_at=excluded.updated_at;
      INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
        SELECT 'account_personal_'||id,'workspace_personal',id,'personal',created_at,updated_at FROM users WHERE 1=1
        ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,updated_at=excluded.updated_at;
      INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
        SELECT 'account_org_'||organization_id,'organization',owner_user_id,organization_id,name,
          CASE WHEN status='active' THEN 'active' ELSE 'archived' END,created_at,updated_at
        FROM account_workspaces WHERE workspace_kind='organization' AND organization_id!=''
        ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status=excluded.status,updated_at=excluded.updated_at;
      INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
        SELECT 'account_org_'||organization_id,id,'','organization',created_at,updated_at FROM account_workspaces
        WHERE workspace_kind='organization' AND organization_id!=''
        ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,updated_at=excluded.updated_at;
      INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
        SELECT 'account_org_'||workspace.organization_id,membership.user_id,membership.role,membership.status,membership.joined_at,membership.updated_at
        FROM account_workspace_memberships membership JOIN account_workspaces workspace ON workspace.id=membership.workspace_id
        WHERE workspace.workspace_kind='organization' AND workspace.organization_id!=''
        ON CONFLICT(account_id,user_id) DO UPDATE SET role=excluded.role,status=excluded.status,updated_at=excluded.updated_at;`);
  }, { required: true });
  db.exec(`DROP TRIGGER IF EXISTS trg_cloud_personal_account_v8_insert;
    DROP TRIGGER IF EXISTS trg_cloud_personal_account_v8_update;
    DROP TRIGGER IF EXISTS trg_cloud_organization_account_v8_insert;
    DROP TRIGGER IF EXISTS trg_cloud_organization_account_v8_update;
    DROP TRIGGER IF EXISTS trg_cloud_organization_account_v8_delete;
    DROP TRIGGER IF EXISTS trg_cloud_organization_account_membership_v8_insert;
    DROP TRIGGER IF EXISTS trg_cloud_organization_account_membership_v8_update;
    DROP TRIGGER IF EXISTS trg_cloud_organization_account_membership_v8_delete;
    CREATE TRIGGER trg_cloud_personal_account_v8_insert AFTER INSERT ON users BEGIN
      INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
      VALUES('account_personal_'||NEW.id,'personal',NEW.id,'',NEW.display_name,'active',NEW.created_at,NEW.updated_at)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,status='active',updated_at=excluded.updated_at;
      INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
      VALUES('account_personal_'||NEW.id,NEW.id,'owner','active',NEW.created_at,NEW.updated_at)
      ON CONFLICT(account_id,user_id) DO UPDATE SET role='owner',status='active',updated_at=excluded.updated_at;
      INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
      VALUES('account_personal_'||NEW.id,'workspace_personal',NEW.id,'personal',NEW.created_at,NEW.updated_at)
      ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,binding_kind='personal',updated_at=excluded.updated_at;
    END;
    CREATE TRIGGER trg_cloud_personal_account_v8_update AFTER UPDATE OF display_name,updated_at ON users BEGIN
      INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
      VALUES('account_personal_'||NEW.id,'personal',NEW.id,'',NEW.display_name,'active',NEW.created_at,NEW.updated_at)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,status='active',updated_at=excluded.updated_at;
      INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
      VALUES('account_personal_'||NEW.id,NEW.id,'owner','active',NEW.created_at,NEW.updated_at)
      ON CONFLICT(account_id,user_id) DO UPDATE SET role='owner',status='active',updated_at=excluded.updated_at;
      INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
      VALUES('account_personal_'||NEW.id,'workspace_personal',NEW.id,'personal',NEW.created_at,NEW.updated_at)
      ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,binding_kind='personal',updated_at=excluded.updated_at;
    END;
    CREATE TRIGGER trg_cloud_organization_account_v8_insert AFTER INSERT ON contact_organizations BEGIN
      INSERT INTO account_workspaces(id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at)
      VALUES('workspace_org_'||NEW.id,'organization',NEW.id,NEW.owner_user_id,NEW.name,'active',NEW.created_at,NEW.updated_at)
      ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
      INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
      VALUES('account_org_'||NEW.id,'organization',NEW.owner_user_id,NEW.id,NEW.name,'active',NEW.created_at,NEW.updated_at)
      ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
      INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
      VALUES('account_org_'||NEW.id,'workspace_org_'||NEW.id,'','organization',NEW.created_at,NEW.updated_at)
      ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,binding_kind='organization',updated_at=excluded.updated_at;
    END;
    CREATE TRIGGER trg_cloud_organization_account_v8_update AFTER UPDATE OF owner_user_id,name,updated_at ON contact_organizations BEGIN
      INSERT INTO account_workspaces(id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at)
      VALUES('workspace_org_'||NEW.id,'organization',NEW.id,NEW.owner_user_id,NEW.name,'active',NEW.created_at,NEW.updated_at)
      ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
      INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
      VALUES('account_org_'||NEW.id,'organization',NEW.owner_user_id,NEW.id,NEW.name,'active',NEW.created_at,NEW.updated_at)
      ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
      INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
      VALUES('account_org_'||NEW.id,'workspace_org_'||NEW.id,'','organization',NEW.created_at,NEW.updated_at)
      ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,binding_kind='organization',updated_at=excluded.updated_at;
    END;
    CREATE TRIGGER trg_cloud_organization_account_v8_delete AFTER DELETE ON contact_organizations BEGIN
      UPDATE accounts SET status='archived',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='account_org_'||OLD.id;
      UPDATE account_memberships_v8 SET status='removed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE account_id='account_org_'||OLD.id;
    END;
    CREATE TRIGGER trg_cloud_organization_account_membership_v8_insert AFTER INSERT ON contact_organization_members BEGIN
      INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
      VALUES('account_org_'||NEW.organization_id,NEW.user_id,CASE WHEN NEW.role IN ('owner','admin') THEN NEW.role ELSE 'member' END,'active',NEW.joined_at,NEW.updated_at)
      ON CONFLICT(account_id,user_id) DO UPDATE SET role=excluded.role,status='active',updated_at=excluded.updated_at;
    END;
    CREATE TRIGGER trg_cloud_organization_account_membership_v8_update AFTER UPDATE ON contact_organization_members BEGIN
      INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
      VALUES('account_org_'||NEW.organization_id,NEW.user_id,CASE WHEN NEW.role IN ('owner','admin') THEN NEW.role ELSE 'member' END,'active',NEW.joined_at,NEW.updated_at)
      ON CONFLICT(account_id,user_id) DO UPDATE SET role=excluded.role,status='active',updated_at=excluded.updated_at;
    END;
    CREATE TRIGGER trg_cloud_organization_account_membership_v8_delete AFTER DELETE ON contact_organization_members BEGIN
      UPDATE account_memberships_v8 SET status='left',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE account_id='account_org_'||OLD.organization_id AND user_id=OLD.user_id;
    END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_cloud_account_workspace_organization_insert AFTER INSERT ON contact_organizations BEGIN
      INSERT INTO account_workspaces(id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at)
      VALUES('workspace_org_'||NEW.id,'organization',NEW.id,NEW.owner_user_id,NEW.name,'active',NEW.created_at,NEW.updated_at)
      ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_cloud_account_workspace_organization_update AFTER UPDATE OF owner_user_id,name,updated_at ON contact_organizations BEGIN
      INSERT INTO account_workspaces(id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at)
      VALUES('workspace_org_'||NEW.id,'organization',NEW.id,NEW.owner_user_id,NEW.name,'active',NEW.created_at,NEW.updated_at)
      ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_cloud_account_workspace_organization_delete AFTER DELETE ON contact_organizations BEGIN
      UPDATE account_workspaces SET status='inactive',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id='workspace_org_'||OLD.id;
      UPDATE account_workspace_memberships SET status='removed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE workspace_id='workspace_org_'||OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_cloud_account_workspace_membership_insert AFTER INSERT ON contact_organization_members BEGIN
      INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,joined_at,updated_at)
      VALUES('workspace_org_'||NEW.organization_id,NEW.user_id,CASE WHEN NEW.role IN ('owner','admin') THEN NEW.role ELSE 'member' END,'active',NEW.joined_at,NEW.updated_at)
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active',updated_at=excluded.updated_at;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_cloud_account_workspace_membership_update AFTER UPDATE ON contact_organization_members BEGIN
      INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,joined_at,updated_at)
      VALUES('workspace_org_'||NEW.organization_id,NEW.user_id,CASE WHEN NEW.role IN ('owner','admin') THEN NEW.role ELSE 'member' END,'active',NEW.joined_at,NEW.updated_at)
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active',updated_at=excluded.updated_at;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_cloud_account_workspace_membership_delete AFTER DELETE ON contact_organization_members BEGIN
      UPDATE account_workspace_memberships SET status='left',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE workspace_id='workspace_org_'||OLD.organization_id AND user_id=OLD.user_id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_cloud_personal_account_workspace_membership_insert AFTER INSERT ON users BEGIN
      INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,display_name,avatar_url,joined_at,updated_at)
      VALUES('workspace_personal',NEW.id,'owner','active',NEW.display_name,NEW.avatar_url,NEW.created_at,NEW.updated_at)
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET status='active',display_name=excluded.display_name,avatar_url=excluded.avatar_url,updated_at=excluded.updated_at;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_cloud_personal_account_workspace_membership_update AFTER UPDATE OF display_name,avatar_url,updated_at ON users BEGIN
      INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,display_name,avatar_url,joined_at,updated_at)
      VALUES('workspace_personal',NEW.id,'owner','active',NEW.display_name,NEW.avatar_url,NEW.created_at,NEW.updated_at)
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET status='active',display_name=excluded.display_name,avatar_url=excluded.avatar_url,updated_at=excluded.updated_at;
    END;`);
}

function migrateClusterMarketLifecycleContract(db) {
  const addColumns = (table, additions) => {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    for (const [name, definition] of additions) if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  addColumns('cloud_evolution_run_snapshots', [
    ['canary_cases_ciphertext', "TEXT NOT NULL DEFAULT ''"], ['canary_cases_nonce', "TEXT NOT NULL DEFAULT ''"],
    ['canary_cases_tag', "TEXT NOT NULL DEFAULT ''"], ['canary_cases_algorithm', "TEXT NOT NULL DEFAULT ''"],
    ['canary_cases_key_id', "TEXT NOT NULL DEFAULT ''"],
    ['shadow_cases_ciphertext', "TEXT NOT NULL DEFAULT ''"], ['shadow_cases_nonce', "TEXT NOT NULL DEFAULT ''"],
    ['shadow_cases_tag', "TEXT NOT NULL DEFAULT ''"], ['shadow_cases_algorithm', "TEXT NOT NULL DEFAULT ''"],
    ['shadow_cases_key_id', "TEXT NOT NULL DEFAULT ''"],
  ]);
  addColumns('cloud_market_agent_candidates', [
    ['run_id', "TEXT NOT NULL DEFAULT ''"], ['revision_no', 'INTEGER NOT NULL DEFAULT 0'],
    ['diagnosis_json', "TEXT NOT NULL DEFAULT '{}'"], ['gate_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['governance_json', "TEXT NOT NULL DEFAULT '[]'"], ['canary_started_at', "TEXT NOT NULL DEFAULT ''"],
    ['canary_deadline_at', "TEXT NOT NULL DEFAULT ''"], ['released_at', "TEXT NOT NULL DEFAULT ''"],
    ['shadow_started_at', "TEXT NOT NULL DEFAULT ''"], ['shadow_completed_at', "TEXT NOT NULL DEFAULT ''"],
    ['suspended_at', "TEXT NOT NULL DEFAULT ''"], ['status_reason', "TEXT NOT NULL DEFAULT ''"],
  ]);
  addColumns('cloud_market_agent_versions', [
    ['suspended_at', "TEXT NOT NULL DEFAULT ''"], ['status_reason', "TEXT NOT NULL DEFAULT ''"],
    ['health_baseline_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['version_kind', "TEXT NOT NULL DEFAULT 'legacy_sections'"], ['base_agent_version_id', "TEXT NOT NULL DEFAULT ''"],
  ]);
  addColumns('cloud_user_market_adoptions', [['adoption_mode', "TEXT NOT NULL DEFAULT 'sections'"]]);
  addColumns('cloud_market_adoption_actions', [
    ['command_id', "TEXT NOT NULL DEFAULT ''"], ['payload_json', "TEXT NOT NULL DEFAULT '{}'"],
  ]);
  db.exec(`CREATE TABLE IF NOT EXISTS cloud_market_candidate_family_sections (
    candidate_id TEXT NOT NULL,agent_family_id TEXT NOT NULL,section_id TEXT NOT NULL,title TEXT NOT NULL,
    content_hash TEXT NOT NULL,content_json TEXT NOT NULL DEFAULT '{}',support_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'canary',created_at TEXT NOT NULL DEFAULT '',PRIMARY KEY(candidate_id,agent_family_id,section_id));
  CREATE TABLE IF NOT EXISTS cloud_market_version_health (
    market_version_id TEXT PRIMARY KEY,user_count INTEGER NOT NULL DEFAULT 0,observed_task_count INTEGER NOT NULL DEFAULT 0,
    baseline_score REAL NOT NULL DEFAULT 0,latest_score REAL NOT NULL DEFAULT 0,baseline_failure_rate REAL NOT NULL DEFAULT 0,
    latest_failure_rate REAL NOT NULL DEFAULT 0,consecutive_regression_windows INTEGER NOT NULL DEFAULT 0,
    last_input_hash TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'collecting',status_reason TEXT NOT NULL DEFAULT '',
    evaluated_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '');
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_market_adoption_command
    ON cloud_market_adoption_actions(user_id,command_id,section_id) WHERE command_id<>'';
  DROP INDEX IF EXISTS idx_cloud_evolution_active_cluster_run;
  CREATE UNIQUE INDEX idx_cloud_evolution_active_cluster_run ON cloud_evolution_runs(cohort_id)
    WHERE evolution_scope='cluster' AND status IN ('queued','claimed','running','proposed','canary');`);
  relaxSqliteContract(db, 'cloud_evolution_runs', "'proposed','applied'", "'proposed','canary','applied'");
  relaxSqliteContract(db, 'cloud_evolution_jobs', "'personal_evolution','cluster_evolution'", "'personal_evolution','cluster_evolution','cluster_canary','market_health'");
  relaxSqliteContract(db, 'cloud_market_agent_candidates', "'draft','released','rejected','archived'", "'draft','canary','released','rejected','archived'");
  relaxSqliteContract(db, 'cloud_market_agent_versions', "'draft','released','rejected','archived'", "'draft','released','suspended','rejected','archived'");
}

function migrateClusterStage01Contract(db) {
  const now = new Date().toISOString();
  relaxSqliteContract(db, 'cloud_evolution_jobs', "'personal_evolution','cluster_evolution','cluster_canary','market_health'",
    "'personal_evolution','cluster_evolution','cluster_shadow','cluster_canary','market_health'");
  relaxSqliteContract(db, 'cloud_evolution_jobs', "'queued','claimed','running','completed','failed_retryable','failed_terminal','cancelled'",
    "'queued','claimed','running','waiting_canary','completed','failed_retryable','failed_terminal','cancelled'");
  relaxSqliteContract(db, 'cloud_market_agent_candidates', "'draft','canary','released','rejected','archived'",
    "'draft','gated','governance_approved','shadow_passed','canary_running','canary_passed','released','gate_rejected','governance_rejected','regression_rejected','privacy_rejected','canary_rejected','rolled_back','archived'");
  relaxSqliteContract(db, 'cloud_market_agent_versions', "'draft','released','suspended','rejected','archived'",
    "'draft','released','suspended','rolled_back','rejected','archived'");
  relaxSqliteContract(db, 'cloud_evolution_evidence_usage', "'','gate','hr_review','regression','privacy','user_rejected','invalid_source','legacy_unknown'",
    "'','gate','hr_review','regression','privacy','mixed','user_rejected','invalid_source','legacy_unknown'");
  db.prepare(`UPDATE cloud_evolution_run_snapshots SET
    shadow_cases_ciphertext=canary_cases_ciphertext,shadow_cases_nonce=canary_cases_nonce,
    shadow_cases_tag=canary_cases_tag,shadow_cases_algorithm=canary_cases_algorithm,
    shadow_cases_key_id=canary_cases_key_id
    WHERE shadow_cases_ciphertext='' AND canary_cases_ciphertext<>''`).run();
  const candidates = db.prepare("SELECT * FROM cloud_market_agent_candidates WHERE status IN ('canary','rejected')").all();
  for (const candidate of candidates) {
    let status = candidate.status === 'rejected' ? 'regression_rejected' : 'governance_approved';
    if (candidate.status === 'canary') {
      const evaluations = db.prepare("SELECT * FROM cloud_market_evaluations WHERE candidate_id=? AND evaluation_kind='async_shadow_canary'").all(candidate.id);
      if (evaluations.length && evaluations.every((row) => !row.regression && !row.privacy_violation && !row.role_violation)) status = 'shadow_passed';
    }
    db.prepare(`UPDATE cloud_market_agent_candidates SET status=?,shadow_started_at=CASE WHEN shadow_started_at='' THEN canary_started_at ELSE shadow_started_at END,
      shadow_completed_at=CASE WHEN ?='shadow_passed' AND shadow_completed_at='' THEN updated_at ELSE shadow_completed_at END,updated_at=? WHERE id=?`)
      .run(status,status,now,candidate.id);
    db.prepare('UPDATE cloud_market_candidate_family_sections SET status=? WHERE candidate_id=?').run(status,candidate.id);
  }
  db.prepare("UPDATE cloud_evolution_runs SET status='proposed',updated_at=? WHERE evolution_scope='cluster' AND status='canary'").run(now);
  db.prepare(`UPDATE cloud_evolution_jobs SET job_kind='cluster_shadow',status='queued',updated_at=?
    WHERE job_kind='cluster_canary' AND run_id IN (SELECT run_id FROM cloud_market_agent_candidates WHERE status='governance_approved')`).run(now);
  db.prepare(`UPDATE cloud_evolution_jobs SET job_kind='cluster_canary',status='waiting_canary',claimed_by='',lease_expires_at='',updated_at=?
    WHERE run_id IN (SELECT run_id FROM cloud_market_agent_candidates WHERE status='shadow_passed')`).run(now);
  db.prepare(`UPDATE cloud_evolution_evidence_usage SET lease_expires_at='',updated_at=? WHERE evolution_scope='cluster' AND status='reserved'
    AND run_id IN (SELECT run_id FROM cloud_market_agent_candidates WHERE status='shadow_passed')`).run(now);
}

function relaxSqliteContract(db, table, from, to) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!row?.sql || row.sql.includes(to)) return;
  if (!row.sql.includes('CHECK')) return;
  if (row.sql.includes('shadow_passed') || row.sql.includes('cluster_shadow') || row.sql.includes('waiting_canary') || row.sql.includes("'mixed'")
    || (table === 'cloud_market_agent_versions' && row.sql.includes('version_kind'))) return;
  if (!row.sql.includes(from)) return;
  db.exec('PRAGMA writable_schema=ON');
  try {
    db.prepare("UPDATE sqlite_master SET sql=replace(sql,?,?) WHERE type='table' AND name=?").run(from, to, table);
    const version = Number(db.prepare('PRAGMA schema_version').get()?.schema_version || 0);
    db.exec(`PRAGMA schema_version=${version + 1}`);
  } finally {
    db.exec('PRAGMA writable_schema=OFF');
  }
}

function migrateClusterCohortLedgerContract(db) {
  db.exec('DROP TRIGGER IF EXISTS trg_cloud_evidence_usage_transition');
  db.exec('DROP TRIGGER IF EXISTS trg_cloud_evidence_usage_contract_update');
  db.exec('DROP TRIGGER IF EXISTS trg_cloud_cluster_claim_contract_update');
  const cohortColumns = new Set(db.prepare('PRAGMA table_info(cloud_agent_cohorts)').all().map((row) => row.name));
  if (!cohortColumns.has('cohort_key')) db.exec("ALTER TABLE cloud_agent_cohorts ADD COLUMN cohort_key TEXT NOT NULL DEFAULT ''");
  if (!cohortColumns.has('identity_version')) db.exec(`ALTER TABLE cloud_agent_cohorts ADD COLUMN identity_version TEXT NOT NULL DEFAULT '${CLUSTER_COHORT_IDENTITY_VERSION}'`);
  const snapshotColumns = new Set(db.prepare('PRAGMA table_info(cloud_evolution_run_snapshots)').all().map((row) => row.name));
  if (!snapshotColumns.has('cohort_snapshot_json')) db.exec("ALTER TABLE cloud_evolution_run_snapshots ADD COLUMN cohort_snapshot_json TEXT NOT NULL DEFAULT '{}'");

  const cohorts = db.prepare('SELECT * FROM cloud_agent_cohorts ORDER BY updated_at DESC,id').all();
  const byKey = new Map();
  for (const row of cohorts) {
    const payload = cloudJsonObject(row.payload_json);
    const key = String(row.cohort_key || payload.cohortKey || (row.agent_family_id ? `family:${row.agent_family_id}` : `legacy:${row.id}`));
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  for (const [key, rows] of byKey) {
    const activeRuns = db.prepare(`SELECT cohort_id FROM cloud_evolution_runs WHERE evolution_scope='cluster'
      AND cohort_id IN (${rows.map(() => '?').join(',')}) AND status IN ('queued','claimed','running','proposed')`).all(...rows.map((row) => row.id));
    const activeIds = new Set(activeRuns.map((row) => row.cohort_id));
    if (activeIds.size > 1) throw new Error(`Multiple active legacy cluster runs share cohort key ${key}.`);
    const canonical = rows.find((row) => activeIds.has(row.id))
      || [...rows].sort((left, right) => cohortStatusRank(left.status) - cohortStatusRank(right.status)
        || String(right.updated_at).localeCompare(String(left.updated_at)) || String(left.id).localeCompare(String(right.id)))[0];
    db.prepare('UPDATE cloud_agent_cohorts SET cohort_key=?,identity_version=? WHERE id=?')
      .run(key, CLUSTER_COHORT_IDENTITY_VERSION, canonical.id);
    for (const row of rows) {
      if (row.id === canonical.id) continue;
      db.prepare("UPDATE cloud_agent_cohorts SET cohort_key='legacy:'||id,identity_version=?,status='inactive' WHERE id=?")
        .run(CLUSTER_COHORT_IDENTITY_VERSION, row.id);
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_cohorts_key ON cloud_agent_cohorts(cohort_key)');
  const canonicalCohorts = db.prepare("SELECT * FROM cloud_agent_cohorts WHERE cohort_key<>'' AND cohort_key NOT LIKE 'legacy:%'").all();
  for (const cohort of canonicalCohorts) {
    const targetId = stableClusterCohortId(cohort.cohort_key);
    const payload = cloudJsonObject(cohort.payload_json);
    delete payload.algorithmVersion;
    payload.id = targetId;
    if (cohort.id === targetId) {
      db.prepare('UPDATE cloud_agent_cohorts SET payload_json=? WHERE id=?').run(JSON.stringify(payload), cohort.id);
      continue;
    }
    const existing = db.prepare('SELECT id FROM cloud_agent_cohorts WHERE id=?').get(targetId);
    if (existing) throw new Error(`Canonical cohort ID collision for ${cohort.cohort_key}.`);
    db.prepare('UPDATE cloud_agent_cohort_members SET cohort_id=? WHERE cohort_id=?').run(targetId, cohort.id);
    for (const usage of db.prepare("SELECT * FROM cloud_evolution_evidence_usage WHERE evolution_scope='cluster' AND consumer_id=?").all(cohort.id)) {
      const target = db.prepare("SELECT * FROM cloud_evolution_evidence_usage WHERE evidence_id=? AND evolution_scope='cluster' AND consumer_id=?")
        .get(usage.evidence_id,targetId);
      if (!target) {
        db.prepare("UPDATE cloud_evolution_evidence_usage SET consumer_id=? WHERE evidence_id=? AND evolution_scope='cluster' AND consumer_id=?")
          .run(targetId,usage.evidence_id,cohort.id);
        continue;
      }
      const preferred = evidenceUsageStatusRank(usage.status) < evidenceUsageStatusRank(target.status) ? usage : target;
      db.prepare(`UPDATE cloud_evolution_evidence_usage SET status=?,run_id=?,algorithm_version=?,re_evaluation_basis_hash=?,
        rejection_kind=?,transition_reason=?,reserved_at=?,lease_expires_at=?,terminal_at=?,updated_at=?
        WHERE evidence_id=? AND evolution_scope='cluster' AND consumer_id=?`).run(preferred.status,preferred.run_id,
        preferred.algorithm_version,preferred.re_evaluation_basis_hash,preferred.rejection_kind,preferred.transition_reason,
        preferred.reserved_at,preferred.lease_expires_at,preferred.terminal_at,preferred.updated_at,usage.evidence_id,targetId);
      db.prepare("DELETE FROM cloud_evolution_evidence_usage WHERE evidence_id=? AND evolution_scope='cluster' AND consumer_id=?")
        .run(usage.evidence_id,cohort.id);
    }
    db.prepare('UPDATE cloud_cluster_evidence_claims SET consumer_id=? WHERE consumer_id=?').run(targetId, cohort.id);
    db.prepare("UPDATE cloud_evolution_runs SET cohort_id=?,consumer_id=? WHERE evolution_scope='cluster' AND cohort_id=?").run(targetId,targetId,cohort.id);
    db.prepare('UPDATE cloud_market_agent_candidates SET cohort_id=? WHERE cohort_id=?').run(targetId,cohort.id);
    for (const snapshot of db.prepare(`SELECT s.* FROM cloud_evolution_run_snapshots s JOIN cloud_evolution_runs r ON r.id=s.run_id
      WHERE r.evolution_scope='cluster' AND r.cohort_id=?`).all(targetId)) {
      const cohortSnapshot = cloudJsonObject(snapshot.cohort_snapshot_json);
      delete cohortSnapshot.algorithmVersion;
      cohortSnapshot.cohortId = targetId;
      db.prepare('UPDATE cloud_evolution_run_snapshots SET cohort_snapshot_json=? WHERE run_id=?').run(JSON.stringify(cohortSnapshot),snapshot.run_id);
    }
    db.prepare('UPDATE cloud_agent_cohorts SET id=?,payload_json=? WHERE id=?').run(targetId,JSON.stringify(payload),cohort.id);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS cloud_cluster_evidence_claims (
    evidence_id TEXT PRIMARY KEY,consumer_id TEXT NOT NULL,run_id TEXT NOT NULL,
    claim_state TEXT NOT NULL CHECK(claim_state IN ('reserved','consumed')),
    claimed_at TEXT NOT NULL DEFAULT '',terminal_at TEXT NOT NULL DEFAULT '',payload_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT '',FOREIGN KEY(evidence_id) REFERENCES cloud_evolution_evidence(evidence_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_cloud_cluster_claims_consumer
    ON cloud_cluster_evidence_claims(consumer_id,claim_state,updated_at);`);

  const consumed = db.prepare(`SELECT * FROM cloud_evolution_evidence_usage
    WHERE evolution_scope='cluster' AND status='consumed'
    ORDER BY evidence_id,CASE WHEN terminal_at='' THEN updated_at ELSE terminal_at END,updated_at,consumer_id`).all();
  const claimed = new Set();
  for (const row of consumed) {
    if (claimed.has(row.evidence_id)) continue;
    claimed.add(row.evidence_id);
    db.prepare(`INSERT OR IGNORE INTO cloud_cluster_evidence_claims
      (evidence_id,consumer_id,run_id,claim_state,claimed_at,terminal_at,payload_json,updated_at)
      VALUES (?,?,?,'consumed',?,?,?,?)`).run(row.evidence_id, row.consumer_id, row.run_id,
      row.reserved_at || row.updated_at, row.terminal_at || row.updated_at, JSON.stringify({ backfilled: true }), row.updated_at);
  }
  const reserved = db.prepare(`SELECT u.* FROM cloud_evolution_evidence_usage u
    JOIN cloud_evolution_runs r ON r.id=u.run_id JOIN cloud_evolution_jobs j ON j.run_id=u.run_id
    WHERE u.evolution_scope='cluster' AND u.status='reserved'
      AND r.status IN ('queued','claimed','running','proposed')
      AND j.status IN ('queued','claimed','running','failed_retryable')
    ORDER BY u.evidence_id,u.updated_at DESC,u.consumer_id`).all();
  for (const row of reserved) {
    if (claimed.has(row.evidence_id)) continue;
    claimed.add(row.evidence_id);
    db.prepare(`INSERT OR IGNORE INTO cloud_cluster_evidence_claims
      (evidence_id,consumer_id,run_id,claim_state,claimed_at,payload_json,updated_at)
      VALUES (?,?,?,'reserved',?,?,?)`).run(row.evidence_id, row.consumer_id, row.run_id,
      row.reserved_at || row.updated_at, JSON.stringify({ backfilled: true }), row.updated_at);
  }
  db.prepare(`UPDATE cloud_evolution_evidence_usage SET status='released',run_id='',rejection_kind='',
    transition_reason='legacy_cohort_reconciliation',lease_expires_at='',terminal_at='',updated_at=?
    WHERE evolution_scope='cluster' AND status='reserved' AND NOT EXISTS (
      SELECT 1 FROM cloud_cluster_evidence_claims c WHERE c.evidence_id=cloud_evolution_evidence_usage.evidence_id
        AND c.run_id=cloud_evolution_evidence_usage.run_id AND c.claim_state='reserved')`).run(new Date().toISOString());
}

function cohortStatusRank(status) {
  if (status === 'active') return 0;
  if (status === 'ineligible') return 1;
  return 2;
}

function evidenceUsageStatusRank(status) {
  return ({ consumed: 0, reserved: 1, evaluated_rejected: 2, released: 3, available: 4 })[status] ?? 5;
}

function hardenCloudContextMemoryContract(db) {
  db.exec("UPDATE cloud_memory_documents_v3 SET visibility='agent_private' WHERE visibility='private'");
  db.exec("UPDATE cloud_agent_cohorts SET status='inactive' WHERE status='disabled'");
  db.exec("UPDATE cloud_market_agent_candidates SET status='archived' WHERE status='disabled'");
  db.exec("UPDATE cloud_market_agent_versions SET status='archived' WHERE status='disabled'");
  db.exec("UPDATE cloud_user_market_adoptions SET status='ignored' WHERE status='disabled'");
  db.exec("UPDATE cloud_personal_evolution_proposals_v4 SET status='legacy_proposal_stale' WHERE status IN ('running','proposed')");
  db.exec("UPDATE cloud_evolution_runs SET trigger_kind='scheduled' WHERE trigger_kind IN ('auto','automatic')");
  const documents = db.prepare(`SELECT * FROM cloud_memory_documents_v3
    ORDER BY user_id,user_agent_instance_id,scope,slot_no,task_run_id,project_id,relationship_id,created_at,id`).all();
  const groups = new Map();
  for (const row of documents) {
    const key = [row.user_id,row.user_agent_instance_id,row.scope,row.slot_no,row.task_run_id,row.project_id,row.relationship_id].join('\0');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const mergedMappings = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const target = rows[0];
    for (const source of rows.slice(1)) {
      mergedMappings.push({
        userId: source.user_id,
        instanceId: source.user_agent_instance_id,
        cloudKey: source.cloud_key || source.id,
        canonicalId: target.id,
  });
      mergeCloudMemoryDocumentRows(db, source, target);
    }
    resequenceCloudMemoryVersions(db, target.user_id, target.id);
    const latest = db.prepare(`SELECT id FROM cloud_memory_document_versions_v3
      WHERE user_id=? AND memory_document_id=? ORDER BY created_at DESC,version_no DESC,id DESC LIMIT 1`).get(target.user_id, target.id);
    db.prepare('UPDATE cloud_memory_documents_v3 SET current_version_id=? WHERE user_id=? AND id=?')
      .run(latest?.id || target.current_version_id || '', target.user_id, target.id);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_memory_documents_slot_identity_v3
    ON cloud_memory_documents_v3(user_id,user_agent_instance_id,scope,slot_no,task_run_id,project_id,relationship_id)`);

  db.exec(`
    DROP INDEX IF EXISTS idx_cloud_agent_context_spaces_identity;
    DROP INDEX IF EXISTS idx_cloud_agent_context_spaces_instance;
    DROP INDEX IF EXISTS idx_cloud_memory_sync_mapping_active_document;
    DROP INDEX IF EXISTS idx_cloud_memory_sync_mapping_document;
    ALTER TABLE cloud_agent_context_spaces RENAME TO cloud_agent_context_spaces_legacy_v7;
    ALTER TABLE cloud_memory_sync_mappings RENAME TO cloud_memory_sync_mappings_legacy_v7;
  `);
  createCloudContextSpaceTable(db);
  createCloudMemoryMappingTable(db);

  const legacyContexts = tableExistsInCloudDb(db, 'cloud_agent_context_spaces_legacy_v7')
    ? db.prepare('SELECT * FROM cloud_agent_context_spaces_legacy_v7').all() : [];
  const legacyMappings = tableExistsInCloudDb(db, 'cloud_memory_sync_mappings_legacy_v7')
    ? db.prepare('SELECT * FROM cloud_memory_sync_mappings_legacy_v7').all() : [];
  const currentDocuments = db.prepare('SELECT * FROM cloud_memory_documents_v3 ORDER BY created_at,id').all();
  const documentById = new Map(currentDocuments.map((row) => [`${row.user_id}\0${row.id}`, row]));
  const contextByIdentity = new Map(legacyContexts.map((row) => {
    const document = row.memory_document_id ? documentById.get(`${row.user_id}\0${row.memory_document_id}`) : null;
    return [[
      row.user_id,row.user_agent_instance_id,row.context_kind,
      row.memory_cloud_key || document?.cloud_key || document?.id || '',row.project_id || '',row.task_run_id || '',
      row.delegation_id || '',row.group_id || '',row.relationship_user_id || '',
    ].join('\0'), row];
  }));
  for (const document of currentDocuments) {
    const contextKind = document.scope === 'general' ? 'general_memory' : document.scope;
    const identity = [document.user_id,document.user_agent_instance_id,contextKind,
      contextKind === 'general_memory' ? (document.cloud_key || document.id) : '',
      contextKind === 'project' ? document.project_id : '',contextKind === 'task' ? document.task_run_id : '',
      document.delegation_id || '',document.group_id || '',contextKind === 'relationship' ? (document.relationship_user_id || document.relationship_id) : '',
    ].join('\0');
    const legacy = contextByIdentity.get(identity);
    const contextId = legacy?.id || document.context_space_id || stableCloudContextId(document);
    db.prepare(`INSERT OR IGNORE INTO cloud_agent_context_spaces(
      user_id,id,user_agent_instance_id,context_kind,memory_document_id,project_id,task_run_id,delegation_id,group_id,
      relationship_user_id,lifecycle_state,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      document.user_id,contextId,document.user_agent_instance_id,contextKind,
      contextKind === 'general_memory' ? document.id : null,
      contextKind === 'project' ? document.project_id : '',contextKind === 'task' ? document.task_run_id : '',
      document.delegation_id || '',document.group_id || '',
      contextKind === 'relationship' ? (document.relationship_user_id || document.relationship_id) : '',
      document.lifecycle_state === 'archived' ? 'archived' : document.lifecycle_state || 'active',
      legacy?.created_at || document.created_at || new Date().toISOString(),
      legacy?.updated_at || document.updated_at || new Date().toISOString(),
    );
    const canonical = db.prepare(`SELECT id FROM cloud_agent_context_spaces WHERE user_id=? AND user_agent_instance_id=?
      AND context_kind=? AND IFNULL(memory_document_id,'')=? AND project_id=? AND task_run_id=? AND delegation_id=?
      AND group_id=? AND relationship_user_id=?`).get(
      document.user_id,document.user_agent_instance_id,contextKind,
      contextKind === 'general_memory' ? document.id : '',contextKind === 'project' ? document.project_id : '',
      contextKind === 'task' ? document.task_run_id : '',document.delegation_id || '',document.group_id || '',
      contextKind === 'relationship' ? (document.relationship_user_id || document.relationship_id) : '',
    );
    db.prepare('UPDATE cloud_memory_documents_v3 SET context_space_id=? WHERE user_id=? AND id=?')
      .run(canonical?.id || contextId, document.user_id, document.id);

    const legacyMapping = legacyMappings.find((row) => row.owner_user_id === document.user_id
      && row.user_agent_instance_id === document.user_agent_instance_id
      && (row.memory_document_id === document.id || row.canonical_document_id === document.id || row.cloud_key === document.cloud_key)
      && (!row.status || row.status === 'active'));
    const activeCloudKey = legacyMapping?.cloud_key || document.cloud_key || document.id;
    db.prepare(`INSERT OR IGNORE INTO cloud_memory_sync_mappings(
      owner_user_id,user_agent_instance_id,cloud_key,memory_document_id,status,created_at,updated_at
    ) VALUES(?,?,?,?, 'active',?,?)`).run(
      document.user_id,document.user_agent_instance_id,activeCloudKey,document.id,
      legacyMapping?.created_at || document.created_at || new Date().toISOString(),
      legacyMapping?.updated_at || document.updated_at || new Date().toISOString(),
    );
    db.prepare('UPDATE cloud_memory_documents_v3 SET cloud_key=? WHERE user_id=? AND id=?')
      .run(activeCloudKey, document.user_id, document.id);
  }
  for (const mapping of mergedMappings) {
    const active = db.prepare(`SELECT cloud_key FROM cloud_memory_sync_mappings
      WHERE owner_user_id=? AND memory_document_id=? AND status='active'`).get(mapping.userId, mapping.canonicalId);
    if (active?.cloud_key && active.cloud_key !== mapping.cloudKey) {
      db.prepare(`INSERT OR IGNORE INTO cloud_memory_sync_mappings(
        owner_user_id,user_agent_instance_id,cloud_key,memory_document_id,status
      ) VALUES(?,?,?,?, 'superseded')`).run(mapping.userId,mapping.instanceId,mapping.cloudKey,mapping.canonicalId);
    }
  }
  for (const mapping of legacyMappings) {
    const aliasId = mapping.memory_document_id || mapping.canonical_document_id || '';
    const canonicalId = db.prepare(`SELECT canonical_document_id FROM cloud_memory_document_aliases_v3
      WHERE user_id=? AND alias_document_id=?`).get(mapping.owner_user_id,aliasId)?.canonical_document_id || aliasId;
    const document = documentById.get(`${mapping.owner_user_id}\0${canonicalId}`)
      || db.prepare('SELECT * FROM cloud_memory_documents_v3 WHERE user_id=? AND id=?').get(mapping.owner_user_id,canonicalId);
    if (!document || !mapping.cloud_key) continue;
    const active = db.prepare(`SELECT cloud_key FROM cloud_memory_sync_mappings
      WHERE owner_user_id=? AND memory_document_id=? AND status='active'`).get(mapping.owner_user_id,canonicalId);
    const requestedStatus = ['active','superseded','revoked'].includes(mapping.status) ? mapping.status : 'superseded';
    const status = requestedStatus === 'active' && active?.cloud_key && active.cloud_key !== mapping.cloud_key
      ? 'superseded' : requestedStatus;
    db.prepare(`INSERT OR IGNORE INTO cloud_memory_sync_mappings(
      owner_user_id,user_agent_instance_id,cloud_key,memory_document_id,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?)`).run(
      mapping.owner_user_id,document.user_agent_instance_id,mapping.cloud_key,canonicalId,status,
      mapping.created_at || document.created_at || new Date().toISOString(),
      mapping.updated_at || document.updated_at || new Date().toISOString(),
    );
  }
  if (tableExistsInCloudDb(db, 'cloud_agent_context_spaces_legacy_v7')) db.exec('DROP TABLE cloud_agent_context_spaces_legacy_v7');
  if (tableExistsInCloudDb(db, 'cloud_memory_sync_mappings_legacy_v7')) db.exec('DROP TABLE cloud_memory_sync_mappings_legacy_v7');
  installCloudContractTriggers(db);
}

function mergeCloudMemoryDocumentRows(db, source, target) {
  const sourceVersions = db.prepare(`SELECT * FROM cloud_memory_document_versions_v3
    WHERE user_id=? AND memory_document_id=? ORDER BY created_at,id`).all(source.user_id,source.id);
  let next = Number(db.prepare(`SELECT COALESCE(MAX(version_no),0) AS value FROM cloud_memory_document_versions_v3
    WHERE user_id=? AND memory_document_id=?`).get(target.user_id,target.id)?.value || 0);
  for (const version of sourceVersions) {
    next += 1;
    db.prepare(`UPDATE cloud_memory_document_versions_v3 SET memory_document_id=?,version_no=?
      WHERE user_id=? AND id=?`).run(target.id,next,source.user_id,version.id);
  }
  for (const table of ['cloud_personal_evolution_memory_operations_v4','cloud_work_memory_versions','cloud_memory_access_audits']) {
    if (!tableExistsInCloudDb(db, table)) continue;
    const userColumn = table === 'cloud_personal_evolution_memory_operations_v4' ? 'user_id' : 'owner_user_id';
    db.prepare(`UPDATE ${table} SET memory_document_id=? WHERE ${userColumn}=? AND memory_document_id=?`)
      .run(target.id,source.user_id,source.id);
  }
  db.prepare(`INSERT INTO cloud_memory_document_aliases_v3(user_id,alias_document_id,canonical_document_id,reason)
    VALUES(?,?,?,'migration_slot_identity_conflict') ON CONFLICT(user_id,alias_document_id) DO UPDATE SET
    canonical_document_id=excluded.canonical_document_id,reason=excluded.reason`).run(source.user_id,source.id,target.id);
  db.prepare('DELETE FROM cloud_memory_documents_v3 WHERE user_id=? AND id=?').run(source.user_id,source.id);
}

function resequenceCloudMemoryVersions(db, userId, documentId) {
  const versions = db.prepare(`SELECT id FROM cloud_memory_document_versions_v3
    WHERE user_id=? AND memory_document_id=? ORDER BY created_at,id`).all(userId,documentId);
  versions.forEach((row,index) => db.prepare('UPDATE cloud_memory_document_versions_v3 SET version_no=? WHERE user_id=? AND id=?')
    .run(-(index + 1),userId,row.id));
  versions.forEach((row,index) => db.prepare('UPDATE cloud_memory_document_versions_v3 SET version_no=? WHERE user_id=? AND id=?')
    .run(index + 1,userId,row.id));
}

function createCloudContextSpaceTable(db) {
  db.exec(`CREATE TABLE cloud_agent_context_spaces (
    user_id TEXT NOT NULL,id TEXT NOT NULL,user_agent_instance_id TEXT NOT NULL,
    context_kind TEXT NOT NULL CHECK(context_kind IN ('general_memory','project','task','relationship')),
    memory_document_id TEXT,project_id TEXT NOT NULL DEFAULT '',task_run_id TEXT NOT NULL DEFAULT '',
    delegation_id TEXT NOT NULL DEFAULT '',group_id TEXT NOT NULL DEFAULT '',relationship_user_id TEXT NOT NULL DEFAULT '',
    lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle_state IN ('active','inactive','archived')),
    created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',PRIMARY KEY(user_id,id),
    FOREIGN KEY(user_id,user_agent_instance_id) REFERENCES cloud_user_agent_instances_v3(user_id,id) ON DELETE CASCADE,
    FOREIGN KEY(user_id,memory_document_id) REFERENCES cloud_memory_documents_v3(user_id,id) ON DELETE CASCADE,
    CHECK((context_kind='general_memory' AND memory_document_id IS NOT NULL AND project_id='' AND task_run_id='' AND relationship_user_id='') OR
      (context_kind='project' AND memory_document_id IS NULL AND project_id<>'' AND task_run_id='' AND relationship_user_id='') OR
      (context_kind='task' AND memory_document_id IS NULL AND task_run_id<>'' AND project_id='' AND relationship_user_id='') OR
      (context_kind='relationship' AND memory_document_id IS NULL AND relationship_user_id<>'' AND project_id='' AND task_run_id=''))
  );
  CREATE UNIQUE INDEX idx_cloud_agent_context_spaces_identity ON cloud_agent_context_spaces(
    user_id,user_agent_instance_id,context_kind,IFNULL(memory_document_id,''),project_id,task_run_id,delegation_id,group_id,relationship_user_id);
  CREATE INDEX idx_cloud_agent_context_spaces_instance ON cloud_agent_context_spaces(user_id,user_agent_instance_id,lifecycle_state,updated_at);`);
}

function createCloudMemoryMappingTable(db) {
  db.exec(`CREATE TABLE cloud_memory_sync_mappings (
    owner_user_id TEXT NOT NULL,user_agent_instance_id TEXT NOT NULL,cloud_key TEXT NOT NULL,memory_document_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','revoked')),
    created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(owner_user_id,user_agent_instance_id,cloud_key),
    FOREIGN KEY(owner_user_id,user_agent_instance_id) REFERENCES cloud_user_agent_instances_v3(user_id,id) ON DELETE CASCADE,
    FOREIGN KEY(owner_user_id,memory_document_id) REFERENCES cloud_memory_documents_v3(user_id,id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX idx_cloud_memory_sync_mapping_active_document ON cloud_memory_sync_mappings(owner_user_id,memory_document_id) WHERE status='active';
  CREATE INDEX idx_cloud_memory_sync_mapping_document ON cloud_memory_sync_mappings(owner_user_id,memory_document_id,status,updated_at);`);
}

function installCloudContractTriggers(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_cloud_memory_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_memory_contract_update;
    CREATE TRIGGER trg_cloud_memory_contract_insert BEFORE INSERT ON cloud_memory_documents_v3 BEGIN
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cloud_user_agent_instances_v3 i WHERE i.user_id=NEW.user_id AND i.id=NEW.user_agent_instance_id)
        THEN RAISE(ABORT,'cloud Memory Agent instance missing') END;
      SELECT CASE WHEN NEW.scope NOT IN ('general','task','project','relationship') THEN RAISE(ABORT,'invalid cloud Memory scope') END;
      SELECT CASE WHEN NEW.lifecycle_state NOT IN ('active','inactive','archived') THEN RAISE(ABORT,'invalid cloud Memory lifecycle') END;
      SELECT CASE WHEN NEW.visibility NOT IN ('agent_private','owner_private','work_collaborators','work_leadership','work_participants','work_summary') THEN RAISE(ABORT,'invalid cloud Memory visibility') END;
      SELECT CASE WHEN NEW.slot_no<0 THEN RAISE(ABORT,'invalid cloud Memory slot') END;
    END;
    CREATE TRIGGER trg_cloud_memory_contract_update BEFORE UPDATE ON cloud_memory_documents_v3 BEGIN
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cloud_user_agent_instances_v3 i WHERE i.user_id=NEW.user_id AND i.id=NEW.user_agent_instance_id)
        THEN RAISE(ABORT,'cloud Memory Agent instance missing') END;
      SELECT CASE WHEN NEW.scope NOT IN ('general','task','project','relationship') THEN RAISE(ABORT,'invalid cloud Memory scope') END;
      SELECT CASE WHEN NEW.lifecycle_state NOT IN ('active','inactive','archived') THEN RAISE(ABORT,'invalid cloud Memory lifecycle') END;
      SELECT CASE WHEN OLD.lifecycle_state='archived' AND NEW.lifecycle_state<>OLD.lifecycle_state THEN RAISE(ABORT,'invalid cloud Memory lifecycle transition') END;
      SELECT CASE WHEN NEW.visibility NOT IN ('agent_private','owner_private','work_collaborators','work_leadership','work_participants','work_summary') THEN RAISE(ABORT,'invalid cloud Memory visibility') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_memory_version_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_memory_version_contract_update;
    CREATE TRIGGER trg_cloud_memory_version_contract_insert BEFORE INSERT ON cloud_memory_document_versions_v3 BEGIN
      SELECT CASE WHEN NEW.version_no<1 THEN RAISE(ABORT,'invalid cloud Memory version') END;
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cloud_memory_documents_v3 d WHERE d.user_id=NEW.user_id AND d.id=NEW.memory_document_id)
        THEN RAISE(ABORT,'cloud Memory document missing') END;
    END;
    CREATE TRIGGER trg_cloud_memory_version_contract_update BEFORE UPDATE ON cloud_memory_document_versions_v3 BEGIN
      SELECT CASE WHEN NEW.version_no<1 THEN RAISE(ABORT,'invalid cloud Memory version') END;
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cloud_memory_documents_v3 d WHERE d.user_id=NEW.user_id AND d.id=NEW.memory_document_id)
        THEN RAISE(ABORT,'cloud Memory document missing') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_agent_instance_memory_cascade;
    CREATE TRIGGER trg_cloud_agent_instance_memory_cascade AFTER DELETE ON cloud_user_agent_instances_v3 BEGIN
      DELETE FROM cloud_memory_documents_v3 WHERE user_id=OLD.user_id AND user_agent_instance_id=OLD.id;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_memory_document_version_cascade;
    CREATE TRIGGER trg_cloud_memory_document_version_cascade AFTER DELETE ON cloud_memory_documents_v3 BEGIN
      DELETE FROM cloud_memory_document_versions_v3 WHERE user_id=OLD.user_id AND memory_document_id=OLD.id;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_evidence_usage_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_evidence_usage_contract_update;
    CREATE TRIGGER trg_cloud_evidence_usage_contract_insert BEFORE INSERT ON cloud_evolution_evidence_usage BEGIN
      SELECT CASE WHEN NEW.evolution_scope NOT IN ('personal','cluster') OR NEW.status NOT IN ('available','reserved','consumed','evaluated_rejected','released')
        THEN RAISE(ABORT,'invalid evidence usage contract') END;
      SELECT CASE WHEN NEW.rejection_kind NOT IN ('','gate','hr_review','regression','privacy','mixed','user_rejected','invalid_source','legacy_unknown')
        OR (NEW.status='evaluated_rejected' AND NEW.rejection_kind='')
        OR (NEW.status<>'evaluated_rejected' AND NEW.rejection_kind<>'')
        THEN RAISE(ABORT,'invalid evidence rejection contract') END;
    END;
    CREATE TRIGGER trg_cloud_evidence_usage_contract_update BEFORE UPDATE ON cloud_evolution_evidence_usage BEGIN
      SELECT CASE WHEN NEW.status NOT IN ('available','reserved','consumed','evaluated_rejected','released') THEN RAISE(ABORT,'invalid evidence usage state') END;
      SELECT CASE WHEN NEW.evidence_id<>OLD.evidence_id OR NEW.evolution_scope<>OLD.evolution_scope OR NEW.consumer_id<>OLD.consumer_id
        THEN RAISE(ABORT,'invalid evidence usage transition') END;
      SELECT CASE WHEN NEW.rejection_kind NOT IN ('','gate','hr_review','regression','privacy','mixed','user_rejected','invalid_source','legacy_unknown')
        OR (NEW.status='evaluated_rejected' AND NEW.rejection_kind='')
        OR (NEW.status<>'evaluated_rejected' AND NEW.rejection_kind<>'')
        THEN RAISE(ABORT,'invalid evidence rejection contract') END;
      SELECT CASE WHEN NEW.status<>OLD.status AND NOT ((OLD.status IN ('available','released') AND NEW.status='reserved') OR
        (OLD.status='reserved' AND NEW.status IN ('consumed','evaluated_rejected','released')) OR
        (OLD.status='evaluated_rejected' AND NEW.status='reserved' AND NEW.run_id<>'' AND NEW.run_id<>OLD.run_id
          AND NEW.re_evaluation_basis_hash<>'' AND NEW.re_evaluation_basis_hash<>OLD.re_evaluation_basis_hash))
        THEN RAISE(ABORT,'invalid evidence usage transition') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_run_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_run_contract_update;
    CREATE TRIGGER trg_cloud_run_contract_insert BEFORE INSERT ON cloud_evolution_runs BEGIN
      SELECT CASE WHEN NEW.evolution_scope NOT IN ('personal','cluster') OR NEW.trigger_kind NOT IN ('manual','scheduled') OR
        NEW.status NOT IN ('queued','claimed','running','proposed','available','canary','applied','failed_retryable','failed_terminal','evaluated_rejected','rolled_back','skipped','insufficient_evidence')
        THEN RAISE(ABORT,'invalid evolution run contract') END;
    END;
    CREATE TRIGGER trg_cloud_run_contract_update BEFORE UPDATE ON cloud_evolution_runs BEGIN
      SELECT CASE WHEN NEW.evolution_scope NOT IN ('personal','cluster') OR NEW.trigger_kind NOT IN ('manual','scheduled') OR
        NEW.status NOT IN ('queued','claimed','running','proposed','available','canary','applied','failed_retryable','failed_terminal','evaluated_rejected','rolled_back','skipped','insufficient_evidence') OR NEW.evidence_count<0
        THEN RAISE(ABORT,'invalid evolution run state') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_job_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_job_contract_update;
    CREATE TRIGGER trg_cloud_job_contract_insert BEFORE INSERT ON cloud_evolution_jobs BEGIN
      SELECT CASE WHEN NEW.job_kind NOT IN ('personal_evolution','cluster_evolution','cluster_shadow','cluster_canary','market_health') OR
        NEW.status NOT IN ('queued','claimed','running','waiting_canary','completed','failed_retryable','failed_terminal','cancelled') OR
        NEW.attempt_count<0 OR NEW.max_attempts<1 THEN RAISE(ABORT,'invalid evolution job contract') END;
    END;
    CREATE TRIGGER trg_cloud_job_contract_update BEFORE UPDATE ON cloud_evolution_jobs BEGIN
      SELECT CASE WHEN NEW.job_kind NOT IN ('personal_evolution','cluster_evolution','cluster_shadow','cluster_canary','market_health') OR
        NEW.status NOT IN ('queued','claimed','running','waiting_canary','completed','failed_retryable','failed_terminal','cancelled') OR
        NEW.attempt_count<0 OR NEW.max_attempts<1 THEN RAISE(ABORT,'invalid evolution job contract') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_agent_instance_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_agent_instance_contract_update;
    CREATE TRIGGER trg_cloud_agent_instance_contract_insert BEFORE INSERT ON cloud_user_agent_instances_v3 BEGIN
      SELECT CASE WHEN NEW.status NOT IN ('active','inactive') OR NEW.employment_state NOT IN ('active','inactive') OR
        NEW.status<>NEW.employment_state OR NEW.instance_kind NOT IN ('employee','system','governance','unavailable') OR NEW.state_revision<1
        THEN RAISE(ABORT,'invalid cloud Agent instance contract') END;
    END;
    CREATE TRIGGER trg_cloud_agent_instance_contract_update BEFORE UPDATE ON cloud_user_agent_instances_v3 BEGIN
      SELECT CASE WHEN NEW.status NOT IN ('active','inactive') OR NEW.employment_state NOT IN ('active','inactive') OR
        NEW.status<>NEW.employment_state OR NEW.instance_kind NOT IN ('employee','system','governance','unavailable') OR NEW.state_revision<1
        THEN RAISE(ABORT,'invalid cloud Agent instance contract') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_schedule_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_schedule_contract_update;
    CREATE TRIGGER trg_cloud_schedule_contract_insert BEFORE INSERT ON cloud_personal_evolution_schedule_states BEGIN
      SELECT CASE WHEN NEW.last_status NOT IN ('never_evaluated','insufficient_evidence','queued','available','applied','evaluated_rejected','failed_retryable','failed_terminal','legacy_proposal_stale') OR NEW.last_evidence_count<0
        THEN RAISE(ABORT,'invalid personal schedule contract') END;
    END;
    CREATE TRIGGER trg_cloud_schedule_contract_update BEFORE UPDATE ON cloud_personal_evolution_schedule_states BEGIN
      SELECT CASE WHEN NEW.last_status NOT IN ('never_evaluated','insufficient_evidence','queued','available','applied','evaluated_rejected','failed_retryable','failed_terminal','legacy_proposal_stale') OR NEW.last_evidence_count<0
        THEN RAISE(ABORT,'invalid personal schedule contract') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_performance_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_performance_contract_update;
    CREATE TRIGGER trg_cloud_performance_contract_insert BEFORE INSERT ON cloud_agent_performance_levels BEGIN
      SELECT CASE WHEN NEW.level NOT IN ('P1','P2','P3','P4','P5','P6','P7','P8','P9','P10') OR NEW.score<0 OR NEW.score>100 OR NEW.completed_task_count<0
        THEN RAISE(ABORT,'invalid performance contract') END;
    END;
    CREATE TRIGGER trg_cloud_performance_contract_update BEFORE UPDATE ON cloud_agent_performance_levels BEGIN
      SELECT CASE WHEN NEW.level NOT IN ('P1','P2','P3','P4','P5','P6','P7','P8','P9','P10') OR NEW.score<0 OR NEW.score>100 OR NEW.completed_task_count<0
        THEN RAISE(ABORT,'invalid performance contract') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_performance_history_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_performance_history_contract_update;
    CREATE TRIGGER trg_cloud_performance_history_contract_insert BEFORE INSERT ON cloud_agent_performance_history BEGIN
      SELECT CASE WHEN NEW.level NOT IN ('P1','P2','P3','P4','P5','P6','P7','P8','P9','P10') OR NEW.score<0 OR NEW.score>100
        THEN RAISE(ABORT,'invalid performance history contract') END;
    END;
    CREATE TRIGGER trg_cloud_performance_history_contract_update BEFORE UPDATE ON cloud_agent_performance_history BEGIN
      SELECT CASE WHEN NEW.level NOT IN ('P1','P2','P3','P4','P5','P6','P7','P8','P9','P10') OR NEW.score<0 OR NEW.score>100
        THEN RAISE(ABORT,'invalid performance history contract') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_cohort_member_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_cohort_member_contract_update;
    CREATE TRIGGER trg_cloud_cohort_member_contract_insert BEFORE INSERT ON cloud_agent_cohort_members BEGIN
      SELECT CASE WHEN NEW.performance_level NOT IN ('P1','P2','P3','P4','P5','P6','P7','P8','P9','P10')
        THEN RAISE(ABORT,'invalid cohort member contract') END;
    END;
    CREATE TRIGGER trg_cloud_cohort_member_contract_update BEFORE UPDATE ON cloud_agent_cohort_members BEGIN
      SELECT CASE WHEN NEW.performance_level NOT IN ('P1','P2','P3','P4','P5','P6','P7','P8','P9','P10')
        THEN RAISE(ABORT,'invalid cohort member contract') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_skill_version_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_skill_version_contract_update;
    CREATE TRIGGER trg_cloud_skill_version_contract_insert BEFORE INSERT ON cloud_user_agent_skill_versions_v3 BEGIN
      SELECT CASE WHEN NEW.authority NOT IN ('cloud','legacy_imported') OR NEW.stability_status NOT IN ('candidate','stable') OR
        NEW.status NOT IN ('candidate','active','archived','rejected') THEN RAISE(ABORT,'invalid Skill version contract') END;
    END;
    CREATE TRIGGER trg_cloud_skill_version_contract_update BEFORE UPDATE ON cloud_user_agent_skill_versions_v3 BEGIN
      SELECT CASE WHEN NEW.authority NOT IN ('cloud','legacy_imported') OR NEW.stability_status NOT IN ('candidate','stable') OR
        NEW.status NOT IN ('candidate','active','archived','rejected') THEN RAISE(ABORT,'invalid Skill version contract') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_proposal_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_proposal_contract_update;
    CREATE TRIGGER trg_cloud_proposal_contract_insert BEFORE INSERT ON cloud_personal_evolution_proposals_v4 BEGIN
      SELECT CASE WHEN NEW.status NOT IN ('ready','partially_applied','applied','rejected','legacy_proposal_stale')
        THEN RAISE(ABORT,'invalid personal proposal contract') END;
    END;
    CREATE TRIGGER trg_cloud_proposal_contract_update BEFORE UPDATE ON cloud_personal_evolution_proposals_v4 BEGIN
      SELECT CASE WHEN NEW.status NOT IN ('ready','partially_applied','applied','rejected','legacy_proposal_stale')
        THEN RAISE(ABORT,'invalid personal proposal contract') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_memory_operation_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_memory_operation_contract_update;
    CREATE TRIGGER trg_cloud_memory_operation_contract_insert BEFORE INSERT ON cloud_personal_evolution_memory_operations_v4 BEGIN
      SELECT CASE WHEN NEW.status NOT IN ('pending','applied','rejected') THEN RAISE(ABORT,'invalid Memory operation contract') END;
    END;
    CREATE TRIGGER trg_cloud_memory_operation_contract_update BEFORE UPDATE ON cloud_personal_evolution_memory_operations_v4 BEGIN
      SELECT CASE WHEN NEW.status NOT IN ('pending','applied','rejected') THEN RAISE(ABORT,'invalid Memory operation contract') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_health_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_health_contract_update;
    CREATE TRIGGER trg_cloud_health_contract_insert BEFORE INSERT ON cloud_personal_version_health BEGIN
      SELECT CASE WHEN NEW.status NOT IN ('collecting','healthy','regressing','rollback_required','rolled_back') OR
        NEW.observed_task_count<0 OR NEW.consecutive_regression_windows<0 THEN RAISE(ABORT,'invalid version health contract') END;
    END;
    CREATE TRIGGER trg_cloud_health_contract_update BEFORE UPDATE ON cloud_personal_version_health BEGIN
      SELECT CASE WHEN NEW.status NOT IN ('collecting','healthy','regressing','rollback_required','rolled_back') OR
        NEW.observed_task_count<0 OR NEW.consecutive_regression_windows<0 THEN RAISE(ABORT,'invalid version health contract') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_cohort_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_cohort_contract_update;
    CREATE TRIGGER trg_cloud_cohort_contract_insert BEFORE INSERT ON cloud_agent_cohorts BEGIN
      SELECT CASE WHEN NEW.status NOT IN ('active','ineligible','inactive') OR NEW.cohort_key='' OR NEW.identity_version=''
        THEN RAISE(ABORT,'invalid cohort contract') END;
    END;
    CREATE TRIGGER trg_cloud_cohort_contract_update BEFORE UPDATE ON cloud_agent_cohorts BEGIN
      SELECT CASE WHEN NEW.status NOT IN ('active','ineligible','inactive') OR NEW.cohort_key='' OR NEW.identity_version=''
        THEN RAISE(ABORT,'invalid cohort contract') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_cluster_claim_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_cluster_claim_contract_update;
    CREATE TRIGGER trg_cloud_cluster_claim_contract_insert BEFORE INSERT ON cloud_cluster_evidence_claims BEGIN
      SELECT CASE WHEN NEW.claim_state NOT IN ('reserved','consumed') OR NEW.consumer_id='' OR NEW.run_id=''
        THEN RAISE(ABORT,'invalid cluster evidence claim') END;
    END;
    CREATE TRIGGER trg_cloud_cluster_claim_contract_update BEFORE UPDATE ON cloud_cluster_evidence_claims BEGIN
      SELECT CASE WHEN NEW.claim_state NOT IN ('reserved','consumed') OR NEW.consumer_id='' OR NEW.run_id=''
        OR NEW.evidence_id<>OLD.evidence_id
        OR (OLD.claim_state='consumed' AND (NEW.claim_state<>OLD.claim_state OR NEW.consumer_id<>OLD.consumer_id OR NEW.run_id<>OLD.run_id))
        OR (OLD.claim_state='reserved' AND NEW.claim_state='reserved' AND (NEW.consumer_id<>OLD.consumer_id OR NEW.run_id<>OLD.run_id))
        THEN RAISE(ABORT,'invalid cluster evidence claim transition') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_market_candidate_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_market_candidate_contract_update;
    CREATE TRIGGER trg_cloud_market_candidate_contract_insert BEFORE INSERT ON cloud_market_agent_candidates BEGIN
      SELECT CASE WHEN NEW.status NOT IN ('draft','gated','governance_approved','shadow_passed','canary_running','canary_passed','released','gate_rejected','governance_rejected','regression_rejected','privacy_rejected','canary_rejected','rolled_back','archived') THEN RAISE(ABORT,'invalid market candidate contract') END;
    END;
    CREATE TRIGGER trg_cloud_market_candidate_contract_update BEFORE UPDATE ON cloud_market_agent_candidates BEGIN
      SELECT CASE WHEN NEW.status NOT IN ('draft','gated','governance_approved','shadow_passed','canary_running','canary_passed','released','gate_rejected','governance_rejected','regression_rejected','privacy_rejected','canary_rejected','rolled_back','archived') THEN RAISE(ABORT,'invalid market candidate contract') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_market_version_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_market_version_contract_update;
    CREATE TRIGGER trg_cloud_market_version_contract_insert BEFORE INSERT ON cloud_market_agent_versions BEGIN
      SELECT CASE WHEN NEW.status NOT IN ('draft','released','suspended','rolled_back','rejected','archived') OR NEW.version_kind NOT IN ('market_base','legacy_sections') THEN RAISE(ABORT,'invalid market version contract') END;
    END;
    CREATE TRIGGER trg_cloud_market_version_contract_update BEFORE UPDATE ON cloud_market_agent_versions BEGIN
      SELECT CASE WHEN NEW.status NOT IN ('draft','released','suspended','rolled_back','rejected','archived') OR NEW.version_kind NOT IN ('market_base','legacy_sections') THEN RAISE(ABORT,'invalid market version contract') END;
    END;
    DROP TRIGGER IF EXISTS trg_cloud_market_adoption_contract_insert;
    DROP TRIGGER IF EXISTS trg_cloud_market_adoption_contract_update;
    CREATE TRIGGER trg_cloud_market_adoption_contract_insert BEFORE INSERT ON cloud_user_market_adoptions BEGIN
      SELECT CASE WHEN NEW.status NOT IN ('adopted','superseded','rolled_back','ignored') THEN RAISE(ABORT,'invalid market adoption contract') END;
    END;
    CREATE TRIGGER trg_cloud_market_adoption_contract_update BEFORE UPDATE ON cloud_user_market_adoptions BEGIN
      SELECT CASE WHEN NEW.status NOT IN ('adopted','superseded','rolled_back','ignored') THEN RAISE(ABORT,'invalid market adoption contract') END;
    END;
  `);
}

function stableCloudContextId(document = {}) {
  const kind = document.scope === 'general' ? 'general_memory' : document.scope;
  const identity = [document.user_id,document.user_agent_instance_id,kind,
    kind === 'general_memory' ? document.id : '',kind === 'project' ? document.project_id : '',
    kind === 'task' ? document.task_run_id : '',document.delegation_id || '',document.group_id || '',
    kind === 'relationship' ? (document.relationship_user_id || document.relationship_id) : '',
  ].join('\x1f');
  return `ctx_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

function tableExistsInCloudDb(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function cleanupLegacyDepartmentCloudData(db) {
  const conversationKeys = new Map();
  const rememberConversation = (row = {}) => {
    const userId = String(row.user_id || '');
    const deviceId = String(row.device_id || '');
    const conversationId = String(row.conversation_id || row.id || '');
    if (!conversationId) return;
    conversationKeys.set(`${userId}\0${deviceId}\0${conversationId}`, { userId, deviceId, conversationId });
  };
  for (const conversation of db.prepare('SELECT user_id, device_id, id, department_id, payload_json FROM cloud_conversations_v2').all()) {
    if (isLegacyChatDepartmentId(conversation.department_id || payloadDepartmentId(conversation.payload_json))) rememberConversation(conversation);
  }
  for (const table of ['cloud_messages_v2', 'cloud_transcripts_v2', 'cloud_file_refs_v2']) {
    for (const row of db.prepare(`SELECT user_id, device_id, conversation_id, payload_json FROM ${table}`).all()) {
      if (payloadContainsLegacyDepartment(row.payload_json)) rememberConversation(row);
    }
  }
  for (const row of db.prepare('SELECT user_id, device_id, conversation_id, department_id, payload_json FROM cloud_model_executions_v2').all()) {
    if (isLegacyChatDepartmentId(row.department_id) || payloadContainsLegacyDepartment(row.payload_json)) rememberConversation(row);
  }
  for (const key of conversationKeys.values()) {
    purgeCloudConversationData(db, key.userId, key.deviceId, key.conversationId);
  }

  const legacyPayloadWhere = legacyPayloadSql('payload_json');
  db.prepare(`DELETE FROM cloud_messages_v2 WHERE ${legacyPayloadWhere}`).run();
  db.prepare(`DELETE FROM cloud_transcripts_v2 WHERE ${legacyPayloadWhere}`).run();
  db.prepare(`DELETE FROM cloud_file_refs_v2 WHERE ${legacyPayloadWhere}`).run();
  db.prepare(`DELETE FROM cloud_model_executions_v2 WHERE department_id IN ('research_department', 'project_department', 'paper_department', 'grant_proposal_department', 'test_department') OR ${legacyPayloadWhere}`).run();
  db.prepare(`DELETE FROM cloud_conversations_v2 WHERE department_id IN ('research_department', 'project_department', 'paper_department', 'grant_proposal_department', 'test_department') OR ${legacyPayloadWhere}`).run();

  const sessions = db.prepare('SELECT id, payload_json FROM cloud_sessions').all();
  for (const session of sessions) {
    if (!isLegacyChatDepartmentId(payloadDepartmentId(session.payload_json))) continue;
    db.prepare('DELETE FROM cloud_messages WHERE session_id = ?').run(session.id);
    db.prepare('DELETE FROM cloud_sessions WHERE id = ?').run(session.id);
  }

  const legacyBatches = db.prepare('SELECT id FROM sync_batches WHERE payload_json LIKE ? OR payload_json LIKE ? OR payload_json LIKE ? OR payload_json LIKE ? OR payload_json LIKE ?').all(
    '%research_department%',
    '%project_department%',
    '%paper_department%',
    '%grant_proposal_department%',
    '%test_department%',
  );
  for (const batch of legacyBatches) {
    db.prepare('DELETE FROM file_links WHERE batch_id = ?').run(batch.id);
    db.prepare('DELETE FROM sync_batches WHERE id = ?').run(batch.id);
  }
}

function payloadDepartmentId(payloadJson = '') {
  try {
    const payload = JSON.parse(payloadJson || '{}');
    return payload.departmentId || payload.department_id || '';
  } catch {
    return '';
  }
}

function payloadContainsLegacyDepartment(payloadJson = '') {
  return /(?:research|project|paper|grant_proposal|test)_department/.test(String(payloadJson || ''));
}

function legacyPayloadSql(column) {
  return `${column} LIKE '%research_department%'
    OR ${column} LIKE '%project_department%'
    OR ${column} LIKE '%paper_department%'
    OR ${column} LIKE '%grant_proposal_department%'
    OR ${column} LIKE '%test_department%'`;
}

function applySyncMigration(db, migrationId, migrate, { required = false } = {}) {
  if (db.prepare('SELECT id FROM sync_migrations WHERE id = ?').get(migrationId)) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    migrate();
    db.prepare('INSERT INTO sync_migrations (id) VALUES (?)').run(migrationId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (required) throw error;
    console.warn(`[janus-cloud] migration ${migrationId} skipped: ${error.message || error}`);
  }
}

function backfillLegacyFileRefs(db) {
  const rows = db.prepare('SELECT payload_json, user_id, device_id FROM sync_batches ORDER BY created_at ASC').all();
  const groups = new Map();
  for (const row of rows) {
    let payload;
    try {
      payload = JSON.parse(row.payload_json || '{}');
    } catch {
      continue;
    }
    if (!payload?.data || Number(payload.schemaVersion || 1) >= 2) continue;
    const syncUserId = String(payload.device?.userId || row.user_id || '').trim();
    const deviceId = String(payload.device?.deviceId || row.device_id || '').trim();
    if (!syncUserId || !deviceId) continue;
    const key = `${syncUserId}\0${deviceId}`;
    if (!groups.has(key)) groups.set(key, { syncUserId, deviceId, rows: [], files: [], sessions: new Map() });
    const group = groups.get(key);
    group.rows.push(row);
    group.files.push(...(Array.isArray(payload.files) ? payload.files : []));
    for (const session of Array.isArray(payload.data.sessions) ? payload.data.sessions : []) {
      if (session?.id) group.sessions.set(session.id, session);
    }
  }
  for (const group of groups.values()) {
    const fileIndex = buildLegacyFileIndex(group.files);
    for (const row of group.rows) {
      backfillLegacyBatch(db, row, { fileIndex, sessionById: group.sessions, fileRefsOnly: true });
    }
  }
}

function backfillLegacyBatch(db, batchRow = {}, { fileIndex: providedFileIndex = null, sessionById: providedSessionById = null, fileRefsOnly = false } = {}) {
  let payload;
  try {
    payload = JSON.parse(batchRow.payload_json || '{}');
  } catch {
    return;
  }
  if (!payload?.data || Number(payload.schemaVersion || 1) >= 2) return;
  const data = payload.data || {};
  const device = payload.device || {};
  const syncUserId = String(device.userId || batchRow.user_id || '').trim();
  const deviceId = String(device.deviceId || batchRow.device_id || '').trim();
  if (!syncUserId || !deviceId) return;
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const transcripts = Array.isArray(data.codexTranscripts) ? data.codexTranscripts : [];
  const files = Array.isArray(payload.files) ? payload.files : [];
  const sessionById = providedSessionById || new Map(sessions.map((item) => [item.id, item]));
  const fileIndex = providedFileIndex || buildLegacyFileIndex(files);

  for (const row of fileRefsOnly ? [] : projects) {
    upsertProjectV2(db, {
      id: row.id,
      userId: row.user_id || row.userId || syncUserId,
      title: row.title || '',
      status: row.status || 'active',
      createdAt: row.created_at || row.createdAt || '',
      updatedAt: row.updated_at || row.updatedAt || '',
    }, { syncUserId, deviceId });
  }
  for (const row of fileRefsOnly ? [] : sessions) {
    const projectId = row.project_id || row.projectId || '';
    upsertConversationV2(db, {
      id: row.id,
      userId: row.user_id || row.userId || syncUserId,
      conversationType: projectId ? 'project' : 'ordinary',
      projectId,
      title: row.title || '',
      departmentId: row.department_id || row.departmentId || '',
      agentId: row.agent_id || row.agentId || '',
      codexThreadId: row.codex_thread_id || row.codexThreadId || '',
      status: row.status || 'active',
      createdAt: row.created_at || row.createdAt || '',
      updatedAt: row.updated_at || row.updatedAt || '',
    }, { syncUserId, deviceId });
  }
  for (const row of messages) {
    const session = sessionById.get(row.session_id || row.conversationId || '') || {};
    const userId = session.user_id || session.userId || syncUserId;
    const normalized = {
      id: row.id,
      userId,
      conversationId: row.conversation_id || row.conversationId || row.session_id || '',
      taskRunId: row.task_run_id || row.taskRunId || '',
      taskNodeId: row.task_node_id || row.taskNodeId || '',
      role: row.role || '',
      content: sanitizeLegacyMessageContent(row.content),
      agentId: row.agent_id || row.agentId || '',
      departmentId: row.department_id || row.departmentId || '',
      visible: row.visible !== false && row.visible !== 0,
      metadata: sanitizeLegacyCloudValue(row.metadata || {}),
      createdAt: row.created_at || row.createdAt || '',
    };
    if (!fileRefsOnly) upsertMessageV2(db, normalized, { syncUserId, deviceId });
    const attachments = Array.isArray(row.metadata?.attachments) ? row.metadata.attachments : [];
    for (const attachment of attachments) {
      const file = legacyFileForAttachment(fileIndex, attachment);
      if (file) upsertLegacyFileRef(db, { file, attachment, message: normalized, session }, { syncUserId, deviceId, sourceKind: 'attachment' });
    }
    const artifact = parseLegacyArtifact(row.content);
    if (artifact?.data) {
      for (const item of legacyArtifactFileAttachments(artifact.data)) {
        const file = legacyFileForAttachment(fileIndex, item.attachment);
        if (file) upsertLegacyFileRef(db, { file, attachment: item.attachment, message: normalized, session }, {
          syncUserId,
          deviceId,
          sourceKind: `artifact:${artifact.kind}:${item.kind}`,
          relationType: 'output',
        });
      }
    }
  }
  for (const row of fileRefsOnly ? [] : transcripts) {
    const conversationId = row.conversationId || row.session_id || '';
    const session = sessionById.get(conversationId) || {};
    const role = row.role || '';
    const content = String(row.content || '');
    const createdAt = row.createdAt || row.created_at || '';
    upsertTranscriptV2(db, {
      id: row.id || stableServerId('transcript', conversationId, role, createdAt, content),
      userId: session.user_id || session.userId || syncUserId,
      conversationId,
      role,
      content,
      createdAt,
    }, { syncUserId, deviceId });
  }
}

function upsertLegacyFileRef(db, { file, attachment, message, session }, { syncUserId, deviceId, sourceKind, relationType = '' }) {
  const localPath = normalizeUploadedLocalPath(file.localPath || file.local_path || '');
  const relation = relationType || (message.role === 'user' ? 'input' : 'output');
  upsertFileRefV2(db, {
    id: stableServerId('file_ref', localPath, file.sha256 || '', message.conversationId, message.id, relation, sourceKind),
    sha256: file.sha256 || '',
    userId: session.user_id || session.userId || message.userId || syncUserId,
    projectId: session.project_id || session.projectId || '',
    conversationId: message.conversationId,
    messageId: message.id,
    taskRunId: message.taskRunId,
    taskNodeId: message.taskNodeId,
    relationType: relation,
    sourceKind,
    originalName: attachment.name || attachment.filename || path.basename(localPath),
    contentType: attachment.content_type || attachment.contentType || attachment.type || '',
    localPath,
    sizeBytes: Number(file.sizeBytes || file.size_bytes || attachment.size || 0),
    createdAt: message.createdAt || '',
  }, { syncUserId, deviceId });
}

function buildLegacyFileIndex(files = []) {
  const byPath = new Map();
  const byBasename = new Map();
  const byBasenameSize = new Map();
  const all = [];
  for (const file of files) {
    const localPath = normalizeUploadedLocalPath(file.localPath || file.local_path || '');
    if (!localPath || !file.sha256) continue;
    const key = `${file.sha256}\0${localPath}`;
    if (all.some((item) => item.key === key)) continue;
    const indexed = { key, file, localPath };
    all.push(indexed);
    byPath.set(localPath, file);
    appendLegacyIndex(byBasename, path.basename(localPath), file, localPath);
    appendLegacyIndex(byBasenameSize, `${path.basename(localPath)}\0${Number(file.sizeBytes || file.size_bytes || 0)}`, file, localPath);
  }
  return { all, byPath, byBasename, byBasenameSize };
}

function appendLegacyIndex(index, key, file, localPath) {
  if (!key) return;
  const rows = index.get(key) || [];
  if (!rows.some((item) => item.sha256 === file.sha256 && item.localPath === localPath)) {
    rows.push({ ...file, localPath });
  }
  index.set(key, rows);
}

function legacyFileForAttachment(fileIndex, attachment = {}) {
  const candidates = [
    attachment.workspace_relative_path,
    attachment.workspaceRelativePath,
    attachment.relative_path,
    attachment.relativePath,
    attachment.path,
  ].filter(Boolean).map(normalizeUploadedLocalPath);
  for (const candidate of candidates) {
    const variants = [
      candidate,
      candidate.startsWith('data/') ? candidate.slice('data/'.length) : `data/${candidate}`,
      candidate.startsWith('outputs/') ? candidate : `outputs/${candidate}`,
    ];
    for (const variant of variants) {
      if (fileIndex.byPath.has(variant)) return fileIndex.byPath.get(variant);
    }
  }
  const attachmentId = String(attachment.id || '').trim();
  if (attachmentId) {
    const matches = fileIndex.all.filter((item) => item.localPath.split('/').includes(attachmentId));
    if (matches.length === 1) return matches[0].file;
  }
  const names = [
    attachment.name,
    attachment.filename,
    ...candidates.map((candidate) => path.basename(candidate)),
  ].filter(Boolean).map((value) => path.basename(String(value)));
  const size = Number(attachment.size || attachment.sizeBytes || attachment.size_bytes || 0);
  if (size) {
    const matches = uniqueLegacyFiles(names.flatMap((name) => fileIndex.byBasenameSize.get(`${name}\0${size}`) || []));
    if (matches.length === 1) return matches[0];
  }
  const matches = uniqueLegacyFiles(names.flatMap((name) => fileIndex.byBasename.get(name) || []));
  if (matches.length === 1) return matches[0];
  return null;
}

function uniqueLegacyFiles(files = []) {
  return [...new Map(files.map((file) => [`${file.sha256}\0${file.localPath || file.local_path || ''}`, file])).values()];
}

function legacyArtifactFileAttachments(data = {}) {
  if (!data || typeof data !== 'object') return [];
  const result = [];
  for (const [kind, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && (kind.endsWith('_file') || kind === 'file' || kind === 'attachment')) {
      result.push({ kind, attachment: value });
    }
    if (Array.isArray(value) && (kind.endsWith('_files') || kind === 'files')) {
      for (const attachment of value) {
        if (attachment && typeof attachment === 'object') result.push({ kind, attachment });
      }
    }
  }
  if (!result.length && [data.path, data.relative_path, data.workspace_relative_path].some(Boolean)) {
    result.push({ kind: 'file', attachment: data });
  }
  return result;
}

function sanitizeLegacyMessageContent(content = '') {
  const artifact = parseLegacyArtifact(content);
  if (!artifact) return String(content || '');
  return `__JANUS_ARTIFACT__${JSON.stringify({ kind: artifact.kind, data: sanitizeLegacyCloudValue(artifact.data) })}`;
}

function parseLegacyArtifact(content = '') {
  const text = String(content || '');
  if (!text.startsWith('__JANUS_ARTIFACT__')) return null;
  try {
    return JSON.parse(text.slice('__JANUS_ARTIFACT__'.length));
  } catch {
    return null;
  }
}

function sanitizeLegacyCloudValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeLegacyCloudValue);
  if (!value || typeof value !== 'object') return value;
  const excluded = new Set([
    'path', 'preview_url', 'previewUrl', 'download_url', 'downloadUrl', 'file_url', 'fileUrl',
    'render_url', 'renderUrl', 'office_pdf_url', 'officePdfUrl', 'workspace_root', 'workspaceRoot',
    'source_path', 'sourcePath',
  ]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !excluded.has(key))
    .map(([key, item]) => [key, sanitizeLegacyCloudValue(item)]));
}


function recordBatch(db, payload) {
  const schemaVersion = Number(payload.schemaVersion || 1);
  if (![1, 2, 3, 4, 5].includes(schemaVersion)) throw new Error(`unsupported sync schema version: ${schemaVersion}`);
  const batch = payload.batch || {};
  const device = payload.device || {};
  const data = payload.data || {};
  const files = Array.isArray(payload.files) ? payload.files : [];
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const conversations = Array.isArray(data.conversations) ? data.conversations : Array.isArray(data.sessions) ? data.sessions : [];
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const transcripts = Array.isArray(data.codexTranscripts) ? data.codexTranscripts : [];
  const modelExecutions = Array.isArray(data.modelExecutions) ? data.modelExecutions : [];
  const fileRefs = Array.isArray(data.fileRefs) ? data.fileRefs : [];
  const agentFamilies = Array.isArray(data.agentFamilies) ? data.agentFamilies : [];
  const agentVersions = Array.isArray(data.agentVersions) ? data.agentVersions : [];
  const userAgentInstances = Array.isArray(data.userAgentInstances) ? data.userAgentInstances : [];
  const userAgentSkillVersions = Array.isArray(data.userAgentSkillVersions) ? data.userAgentSkillVersions : [];
  const userAgentInstanceAliases = Array.isArray(data.userAgentInstanceAliases) ? data.userAgentInstanceAliases : [];
  const memoryDocuments = Array.isArray(data.memoryDocuments) ? data.memoryDocuments : [];
  const memoryDocumentVersions = Array.isArray(data.memoryDocumentVersions) ? data.memoryDocumentVersions : [];
  const memoryDocumentAliases = Array.isArray(data.memoryDocumentAliases) ? data.memoryDocumentAliases : [];
  const agentContextSpaces = Array.isArray(data.agentContextSpaces) ? data.agentContextSpaces : [];
  const agentContextStates = Array.isArray(data.agentContextStates) ? data.agentContextStates : [];
  const chatContextStates = Array.isArray(data.chatContextStates) ? data.chatContextStates : [];
  const memorySyncMappings = Array.isArray(data.memorySyncMappings) ? data.memorySyncMappings : [];
  const taskSecurityContexts = Array.isArray(data.taskSecurityContexts) ? data.taskSecurityContexts : [];
  const personalEvolutionProposals = Array.isArray(data.personalEvolutionProposals) ? data.personalEvolutionProposals : [];
  const personalEvolutionMemoryOperations = Array.isArray(data.personalEvolutionMemoryOperations) ? data.personalEvolutionMemoryOperations : [];
  const batchId = batch.id || `batch_${crypto.randomUUID()}`;
  const syncUserId = String(device.userId || '').trim();
  const deviceId = String(device.deviceId || '').trim();
  if (!syncUserId || !deviceId) throw new Error('sync device userId and deviceId are required');

  let committed = false;
  let applyingStage='begin';
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO devices (device_id, user_id, hostname, platform, arch, updated_at)
       VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(device_id) DO UPDATE SET
         user_id = excluded.user_id,
         hostname = excluded.hostname,
         platform = excluded.platform,
         arch = excluded.arch,
         updated_at = excluded.updated_at`,
    ).run(deviceId, syncUserId, device.hostname || '', device.platform || '', device.arch || '');
    const summary = {
      schemaVersion,
      batch: { id: batchId, generatedAt: batch.generatedAt || '', cursorFrom: batch.cursorFrom || '', cursorTo: batch.cursorTo || '' },
      device: { userId: syncUserId, deviceId },
      counts: {
        projects: projects.length,
        conversations: conversations.length,
        messages: messages.length,
        transcripts: transcripts.length,
        modelExecutions: modelExecutions.length,
        agentFamilies: agentFamilies.length,
        agentVersions: agentVersions.length,
        userAgentInstances: userAgentInstances.length,
        userAgentSkillVersions: userAgentSkillVersions.length,
        userAgentInstanceAliases: userAgentInstanceAliases.length,
        memoryDocuments: memoryDocuments.length,
        memoryDocumentVersions: memoryDocumentVersions.length,
        memoryDocumentAliases: memoryDocumentAliases.length,
        agentContextSpaces: agentContextSpaces.length,
        agentContextStates: agentContextStates.length,
        chatContextStates: chatContextStates.length,
        memorySyncMappings: memorySyncMappings.length,
        taskSecurityContexts: taskSecurityContexts.length,
        personalEvolutionProposals: personalEvolutionProposals.length,
        personalEvolutionMemoryOperations: personalEvolutionMemoryOperations.length,
        fileRefs: fileRefs.length,
        files: files.length,
      },
    };
    db.prepare(
      `INSERT INTO sync_batches (
        id, user_id, device_id, cursor_from, cursor_to, item_count, file_count, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json`,
    ).run(
      batchId,
      syncUserId,
      deviceId,
      batch.cursorFrom || '',
      batch.cursorTo || '',
      Number(batch.itemCount || 0),
      files.length,
      JSON.stringify(summary),
    );

    if (schemaVersion >= 2) {
      for (const project of projects) upsertProjectV2(db, project, { syncUserId, deviceId });
      for (const conversation of conversations) upsertConversationV2(db, conversation, { syncUserId, deviceId });
      for (const message of messages) upsertMessageV2(db, message, { syncUserId, deviceId });
      for (const transcript of transcripts) upsertTranscriptV2(db, transcript, { syncUserId, deviceId });
      for (const execution of modelExecutions) upsertModelExecutionV2(db, execution, { syncUserId, deviceId });
      for (const fileRef of fileRefs) upsertFileRefV2(db, fileRef, { syncUserId, deviceId });
      if (schemaVersion >= 3) {
        applyingStage='agent_families';
        for (const family of agentFamilies) upsertAgentFamilyV3(db, family);
        applyingStage='agent_versions';
        for (const version of agentVersions) upsertAgentVersionV3(db, version);
        applyingStage='agent_instances';
        for (const instance of userAgentInstances) upsertUserAgentInstanceV3(db, instance, { syncUserId, deviceId });
        applyingStage='agent_instance_aliases';
        for (const alias of userAgentInstanceAliases) upsertUserAgentInstanceAliasV3(db, alias, { syncUserId });
        applyingStage='agent_skill_versions';
        for (const skillVersion of userAgentSkillVersions) upsertUserAgentSkillVersionV3(db, skillVersion, { syncUserId });
        applyingStage='memory_documents';
        for (const document of memoryDocuments) upsertMemoryDocumentV3(db, document, { syncUserId });
        applyingStage='memory_document_aliases';
        for (const alias of memoryDocumentAliases) upsertMemoryDocumentAliasV3(db, alias, { syncUserId });
        applyingStage='memory_document_versions';
        for (const version of memoryDocumentVersions) upsertMemoryDocumentVersionV3(db, version, { syncUserId });
        applyingStage='agent_context_spaces';
        for (const contextSpace of agentContextSpaces) upsertAgentContextSpaceV7(db, contextSpace, { syncUserId });
        applyingStage='agent_context_states';
        for (const contextState of agentContextStates) upsertAgentContextStateV8(db, contextState, { syncUserId, deviceId });
        applyingStage='chat_context_states';
        for (const contextState of chatContextStates) upsertChatContextStateV9(db, contextState, { syncUserId, deviceId });
        applyingStage='memory_sync_mappings';
        for (const mapping of memorySyncMappings) upsertCloudMemorySyncMapping(db, mapping, { syncUserId });
        applyingStage='task_security_contexts';
        for (const context of taskSecurityContexts) upsertTaskSecurityContextV5(db, context, { syncUserId });
        reconcileCloudActiveSkillVersions(db, syncUserId);
        if (schemaVersion >= 4) {
          for (const proposal of personalEvolutionProposals) upsertPersonalEvolutionProposalV4(db, proposal, { syncUserId, deviceId });
          for (const operation of personalEvolutionMemoryOperations) upsertPersonalEvolutionMemoryOperationV4(db, operation, { syncUserId });
        }
      }
    } else {
      const legacySessionIds = new Set((data.sessions || [])
        .filter((session) => isLegacyChatDepartmentId(session.departmentId || session.department_id))
        .map((session) => String(session.id || ''))
        .filter(Boolean));
      for (const sessionId of legacySessionIds) {
        db.prepare('DELETE FROM cloud_messages WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM cloud_sessions WHERE id = ?').run(sessionId);
      }
      upsertRows(
        db,
        'cloud_sessions',
        (data.sessions || []).filter((session) => !legacySessionIds.has(String(session.id || ''))),
        'updated_at',
      );
      upsertRows(
        db,
        'cloud_messages',
        messages.filter((message) => (
          !legacySessionIds.has(String(message.sessionId || message.session_id || '')) &&
          !isLegacyChatDepartmentId(message.departmentId || message.department_id)
        )),
        'created_at',
        'session_id',
      );
      backfillLegacyBatch(db, { payload_json: JSON.stringify(payload), user_id: syncUserId, device_id: deviceId });
    }
    for (const row of data.taskRuns || []) if (row?.id) db.prepare(`INSERT INTO cloud_task_runs(id,account_workspace_id,owner_user_id,payload_json,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET account_workspace_id=excluded.account_workspace_id,
      owner_user_id=excluded.owner_user_id,payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run(
        row.id,row.account_workspace_id||row.accountWorkspaceId||row.workspace_id||row.workspaceId||'workspace_personal',
        row.owner_user_id||row.ownerUserId||syncUserId,JSON.stringify(row),row.updated_at||row.updatedAt||'',
      );
    for (const row of data.taskNodes || []) if (row?.id) db.prepare(`INSERT INTO cloud_task_nodes(id,task_run_id,user_agent_instance_id,payload_json,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET task_run_id=excluded.task_run_id,user_agent_instance_id=excluded.user_agent_instance_id,
      payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run(row.id,row.task_run_id||row.taskRunId||'',
      row.agent_instance_id||row.agentInstanceId||row.user_agent_instance_id||row.userAgentInstanceId||'',JSON.stringify(row),row.updated_at||row.updatedAt||'');
    for (const row of data.taskEvents || []) if (row?.id) db.prepare(`INSERT INTO cloud_task_events(
      id,task_run_id,task_node_id,event_type,privacy_level,payload_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      task_run_id=excluded.task_run_id,task_node_id=excluded.task_node_id,event_type=excluded.event_type,
      privacy_level=excluded.privacy_level,payload_json=excluded.payload_json,updated_at=excluded.updated_at
    WHERE excluded.updated_at>=cloud_task_events.updated_at`).run(
      row.id, row.task_run_id || row.taskRunId || '', row.task_node_id || row.taskNodeId || '', row.event_type || row.eventType || '',
      row.privacy_level || row.privacyLevel || 'owner_private', JSON.stringify(row), row.created_at || row.createdAt || '',
      row.updated_at || row.updatedAt || row.created_at || row.createdAt || '',
    );
    upsertRows(db, 'cloud_communications', data.communications || [], 'resolved_at', 'task_run_id');
    for (const file of files) {
      const localPath = normalizeUploadedLocalPath(file.localPath);
      const linkId = stableServerId('file_link', syncUserId, deviceId, file.sha256 || '', localPath);
      db.prepare(
        `INSERT INTO file_links (id, sha256, batch_id, local_path, size_bytes)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET batch_id = excluded.batch_id, size_bytes = excluded.size_bytes`,
      ).run(linkId, file.sha256 || '', batchId, localPath, Number(file.sizeBytes || 0));
    }
    db.exec('COMMIT');
    committed = true;
    for (const conversation of conversations) {
      if ((conversation.status || 'active') === 'deleted') {
        purgeConversationFiles(db, String(conversation.userId || conversation.user_id || syncUserId), deviceId, conversation.id);
      }
    }
  } catch (error) {
    if (!committed) db.exec('ROLLBACK');
    error.message=`${applyingStage}: ${error.message}`;
    throw error;
  }
  return {
    status: 'accepted',
    schemaVersion,
    batchId,
    projectCount: projects.length,
    conversationCount: conversations.length,
    sessionCount: conversations.length,
    messageCount: messages.length,
    transcriptCount: transcripts.length,
    modelExecutionCount: modelExecutions.length,
    userAgentInstanceCount: userAgentInstances.length,
    memoryDocumentCount: memoryDocuments.length,
    memoryDocumentVersionCount: memoryDocumentVersions.length,
    fileRefCount: fileRefs.length,
    fileCount: files.length,
    identityCursor: identityCursorForUser(db, syncUserId),
    personalEvolutionCursor: personalEvolutionCursorForUser(db, syncUserId),
  };
}

function upsertPersonalEvolutionProposalV4(db, row = {}, { syncUserId, deviceId }) {
  const instanceId = canonicalCloudAgentInstanceId(db, syncUserId, row.user_agent_instance_id || row.agentInstanceId || '');
  if (!row.id || !instanceId) return;
  db.prepare(`INSERT INTO cloud_personal_evolution_proposals_v4 (
    user_id, id, user_agent_instance_id, agent_family_id, status, proposal_hash,
    origin_device_id, payload_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, id) DO UPDATE SET
    status = CASE
      WHEN cloud_personal_evolution_proposals_v4.proposal_hash = ''
        OR cloud_personal_evolution_proposals_v4.proposal_hash = excluded.proposal_hash
      THEN excluded.status ELSE cloud_personal_evolution_proposals_v4.status END,
    proposal_hash = CASE
      WHEN cloud_personal_evolution_proposals_v4.proposal_hash = '' THEN excluded.proposal_hash
      ELSE cloud_personal_evolution_proposals_v4.proposal_hash END,
    payload_json = CASE
      WHEN cloud_personal_evolution_proposals_v4.proposal_hash = ''
        OR cloud_personal_evolution_proposals_v4.proposal_hash = excluded.proposal_hash
      THEN excluded.payload_json ELSE cloud_personal_evolution_proposals_v4.payload_json END,
    updated_at = CASE
      WHEN cloud_personal_evolution_proposals_v4.proposal_hash = ''
        OR cloud_personal_evolution_proposals_v4.proposal_hash = excluded.proposal_hash
      THEN MAX(cloud_personal_evolution_proposals_v4.updated_at, excluded.updated_at)
      ELSE cloud_personal_evolution_proposals_v4.updated_at END`).run(
    syncUserId, row.id, instanceId, row.agent_family_id || row.agentFamilyId || '', normalizeCloudProposalStatus(row.status),
    row.proposal_hash || row.proposalHash || '', row.origin_device_id || row.originDeviceId || deviceId,
    JSON.stringify(row), row.created_at || row.createdAt || '', row.updated_at || row.updatedAt || '',
  );
}

function normalizeCloudProposalStatus(value = '') {
  const status = String(value || 'running').trim().toLowerCase();
  if (status === 'running' || status === 'proposed') return 'legacy_proposal_stale';
  return status;
}

function upsertPersonalEvolutionMemoryOperationV4(db, row = {}, { syncUserId }) {
  const documentId = canonicalCloudMemoryDocumentId(db, syncUserId, row.memory_document_id || row.memoryDocumentId || '');
  if (!row.id || !row.proposal_id && !row.proposalId || !documentId) return;
  const proposalId = row.proposal_id || row.proposalId;
  const canonicalAction = db.prepare(`SELECT decision FROM cloud_personal_evolution_actions_v4
    WHERE user_id = ? AND proposal_id = ? AND target_kind = 'memory_operation' AND target_id = ?`)
    .get(syncUserId, proposalId, row.id);
  const status = canonicalAction ? (canonicalAction.decision === 'accept' ? 'applied' : 'rejected') : row.status || 'pending';
  db.prepare(`INSERT INTO cloud_personal_evolution_memory_operations_v4 (
    user_id, id, proposal_id, memory_document_id, status, payload_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, id) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json,
    updated_at = MAX(cloud_personal_evolution_memory_operations_v4.updated_at, excluded.updated_at)`).run(
    syncUserId, row.id, proposalId, documentId, status, JSON.stringify(row),
    row.created_at || row.createdAt || '', row.updated_at || row.updatedAt || '',
  );
}

function personalEvolutionCursorForUser(db, userId) {
  const values = [];
  for (const [table, column] of [
    ['cloud_personal_evolution_proposals_v4', 'updated_at'],
    ['cloud_personal_evolution_memory_operations_v4', 'updated_at'],
    ['cloud_personal_evolution_actions_v4', 'received_at'],
  ]) {
    const row = db.prepare(`SELECT MAX(${column}) AS value FROM ${table} WHERE user_id = ?`).get(userId);
    if (row?.value) values.push(row.value);
  }
  return values.sort().at(-1) || new Date().toISOString();
}

function personalEvolutionSnapshot(db, { userId = '', cursor = '' } = {}) {
  const cleanUserId = String(userId || '').trim();
  if (!cleanUserId) throw new Error('personal evolution sync userId is required');
  const changed = (table, column) => db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND (? = '' OR ${column} > ?)`).all(cleanUserId, cursor, cursor);
  return {
    status: 'ok', cursor: personalEvolutionCursorForUser(db, cleanUserId),
    data: {
      proposals: changed('cloud_personal_evolution_proposals_v4', 'updated_at').map(identityPayload),
      memoryOperations: changed('cloud_personal_evolution_memory_operations_v4', 'updated_at').map(identityPayload),
      actions: changed('cloud_personal_evolution_actions_v4', 'received_at').map(identityPayload),
    },
  };
}

function decidePersonalEvolution(db, { userId = '', proposalId = '', decisions = [], actorDeviceId = '' } = {}) {
  const cleanUserId = String(userId || '').trim();
  if (!cleanUserId || !proposalId || !Array.isArray(decisions) || !decisions.length) throw new Error('personal evolution decision is incomplete');
  const proposal = db.prepare('SELECT * FROM cloud_personal_evolution_proposals_v4 WHERE user_id = ? AND id = ?').get(cleanUserId, proposalId);
  if (!proposal) throw new Error('personal evolution Proposal not found');
  if (!['ready', 'partially_applied'].includes(proposal.status)) throw new Error(`personal evolution Proposal is not reviewable from status ${proposal.status}`);
  const proposalPayload = identityPayload(proposal);
  const results = [];
  let conflict = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const decision of decisions) {
      const targetKind = String(decision.targetKind || decision.target_kind || '');
      const targetId = String(decision.targetId || decision.target_id || '');
      const value = String(decision.decision || '');
      if (!['skill', 'memory_operation'].includes(targetKind) || !['accept', 'reject'].includes(value)) throw new Error('invalid personal evolution decision target');
      if (targetKind === 'skill') {
        const candidateId = String(proposalPayload.candidate_personal_skill_version_id || proposalPayload.candidatePersonalSkillVersionId || '');
        if (!targetId || targetId !== candidateId) throw new Error('personal evolution Skill target does not belong to the Proposal');
      }
      if (targetKind === 'memory_operation') {
        const operation = db.prepare(`SELECT id FROM cloud_personal_evolution_memory_operations_v4
          WHERE user_id = ? AND proposal_id = ? AND id = ?`).get(cleanUserId, proposalId, targetId);
        if (!operation) throw new Error('personal evolution Memory target does not belong to the Proposal');
      }
      const existing = db.prepare(`SELECT * FROM cloud_personal_evolution_actions_v4
        WHERE user_id = ? AND proposal_id = ? AND target_kind = ? AND target_id = ?`).get(cleanUserId, proposalId, targetKind, targetId);
      if (existing) {
        if (existing.decision !== value) conflict = true;
        if (targetKind === 'skill' && existing.decision === 'accept') {
          activateAcceptedLegacyPersonalSkill(db, {
            userId: cleanUserId,
            proposal: proposalPayload,
            candidateId: targetId,
          });
        }
        if (targetKind === 'memory_operation') updateCloudPersonalMemoryOperationStatus(db, cleanUserId, proposalId, targetId, existing.decision);
        results.push(identityPayload(existing));
        continue;
      }
      const id = decision.id || `peaction_${crypto.randomUUID()}`;
      const receivedAt = new Date().toISOString();
      const payload = { id, proposalId, targetKind, targetId, decision: value, revision: 1, actorDeviceId, receivedAt };
      db.prepare(`INSERT INTO cloud_personal_evolution_actions_v4 (
        user_id, id, proposal_id, target_kind, target_id, decision, revision,
        actor_device_id, payload_json, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(
        cleanUserId, id, proposalId, targetKind, targetId, value, actorDeviceId, JSON.stringify(payload), receivedAt,
      );
      if (targetKind === 'skill' && value === 'accept') {
        activateAcceptedLegacyPersonalSkill(db, {
          userId: cleanUserId,
          proposal: proposalPayload,
          candidateId: targetId,
          activatedAt: receivedAt,
        });
      }
      if (targetKind === 'memory_operation') updateCloudPersonalMemoryOperationStatus(db, cleanUserId, proposalId, targetId, value);
      results.push(payload);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { status: conflict ? 'conflict' : 'accepted', proposalId, actions: results, cursor: personalEvolutionCursorForUser(db, cleanUserId) };
}

function activateAcceptedLegacyPersonalSkill(db, { userId = '', proposal = {}, candidateId = '', activatedAt = '' } = {}) {
  const instanceId = String(proposal.user_agent_instance_id || proposal.agentInstanceId || '').trim();
  const cleanCandidateId = String(candidateId || '').trim();
  if (!instanceId || !cleanCandidateId) throw new Error('personal evolution Skill activation target is incomplete');
  const candidate = db.prepare(`SELECT * FROM cloud_user_agent_skill_versions_v3
    WHERE user_id = ? AND id = ? AND user_agent_instance_id = ?`).get(userId, cleanCandidateId, instanceId);
  if (!candidate) throw new Error('personal evolution Skill candidate has not synchronized');
  const instance = db.prepare(`SELECT active_personal_skill_version_id FROM cloud_user_agent_instances_v3
    WHERE user_id = ? AND id = ?`).get(userId, instanceId);
  if (!instance) throw new Error('personal evolution Agent instance has not synchronized');
  if (instance.active_personal_skill_version_id === cleanCandidateId && candidate.status === 'active') return;
  const now = activatedAt || new Date().toISOString();
  db.prepare(`UPDATE cloud_user_agent_skill_versions_v3
    SET status = 'archived', updated_at = ?
    WHERE user_id = ? AND user_agent_instance_id = ? AND status = 'active' AND id <> ?`).run(
    now, userId, instanceId, cleanCandidateId,
  );
  db.prepare(`UPDATE cloud_user_agent_skill_versions_v3
    SET status = 'active', stability_status = 'stable', activated_at = CASE WHEN activated_at = '' THEN ? ELSE activated_at END,
      updated_at = ? WHERE user_id = ? AND id = ? AND user_agent_instance_id = ?`).run(
    now, now, userId, cleanCandidateId, instanceId,
  );
  db.prepare(`UPDATE cloud_user_agent_instances_v3
    SET active_personal_skill_version_id = ?, updated_at = ? WHERE user_id = ? AND id = ?`).run(
    cleanCandidateId, now, userId, instanceId,
  );
}

function updateCloudPersonalMemoryOperationStatus(db, userId, proposalId, operationId, decision) {
  db.prepare(`UPDATE cloud_personal_evolution_memory_operations_v4 SET status = ?, updated_at = ?
    WHERE user_id = ? AND proposal_id = ? AND id = ?`).run(
    decision === 'accept' ? 'applied' : 'rejected', new Date().toISOString(), userId, proposalId, operationId,
  );
}

function upsertUserAgentInstanceAliasV3(db, row = {}, { syncUserId }) {
  const aliasId = row.alias_instance_id || row.aliasInstanceId || '';
  const canonicalId = row.canonical_instance_id || row.canonicalInstanceId || '';
  if (!aliasId || !canonicalId) return;
  db.prepare(`INSERT INTO cloud_user_agent_instance_aliases_v3 (
    user_id, alias_instance_id, canonical_instance_id, reason, created_at
  ) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_id, alias_instance_id) DO UPDATE SET canonical_instance_id = excluded.canonical_instance_id, reason = excluded.reason`)
    .run(syncUserId, aliasId, canonicalId, row.reason || 'client_alias', row.created_at || row.createdAt || new Date().toISOString());
}

function upsertAgentFamilyV3(db, row = {}) {
  if (!row.id) return;
  const familyName = canonicalAgentFamilyName(row.id, row.name || row.id);
  const payload = { ...row, name: familyName };
  db.prepare(
    `INSERT INTO cloud_agent_families_v3 (
      id, department_id, name, role, status, routable, instance_kind, recruitable, default_for_new_user, quota_cost,
      current_version_id, payload_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
      department_id = excluded.department_id,
      name = excluded.name,
      role = excluded.role,
      status = excluded.status,
      routable = excluded.routable,
      instance_kind = excluded.instance_kind,
      recruitable = excluded.recruitable,
      default_for_new_user = excluded.default_for_new_user,
      quota_cost = excluded.quota_cost,
      current_version_id = excluded.current_version_id,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at`,
  ).run(
    row.id,
    row.department_id || row.departmentId || '',
    familyName,
    row.role || 'agent',
    row.status || 'active',
    row.routable ? 1 : 0,
    row.instance_kind || row.instanceKind || 'unavailable',
    row.recruitable || row.recruitable === 1 ? 1 : 0,
    row.default_for_new_user || row.defaultForNewUser ? 1 : 0,
    Number(row.quota_cost ?? row.quotaCost ?? 0),
    row.current_version_id || row.currentVersionId || '',
    JSON.stringify(payload),
    row.updated_at || row.updatedAt || '',
  );
}

function upsertAgentVersionV3(db, row = {}) {
  if (!row.id || !(row.agent_family_id || row.agentFamilyId)) return;
  db.prepare(
    `INSERT INTO cloud_agent_versions_v3 (
      id, agent_family_id, content_hash, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    row.id,
    row.agent_family_id || row.agentFamilyId,
    row.content_hash || row.contentHash || '',
    JSON.stringify(row),
    row.created_at || row.createdAt || '',
  );
}

function upsertUserAgentInstanceV3(db, row = {}, { syncUserId, deviceId }) {
  if (!row.id || !(row.agent_family_id || row.agentFamilyId)) return;
  const agentFamilyId = row.agent_family_id || row.agentFamilyId;
  const existingInstance = db.prepare(
    'SELECT id,status,family_instance_seq,display_name,note FROM cloud_user_agent_instances_v3 WHERE user_id = ? AND id = ?',
  ).get(syncUserId, row.id);
  const requestedKind = row.instance_kind || row.instanceKind || 'employee';
  if (!existingInstance?.id && requestedKind === 'employee') return;
  db.prepare(
    `INSERT INTO cloud_user_agent_instances_v3 (
      user_id, id, agent_family_id, base_agent_version_id,
      active_personal_skill_version_id, status, instance_kind, employment_state, quota_exempt,
      recruited_at, deactivated_at, last_state_changed_at, state_revision, recruitment_source, policy_version, sync_enabled,
      personal_evolution_consent, cluster_contribution_consent, personal_skill_auto_activate,
      source_device_id, family_instance_seq, display_name, note, payload_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET
      agent_family_id = cloud_user_agent_instances_v3.agent_family_id,
      base_agent_version_id = excluded.base_agent_version_id,
      active_personal_skill_version_id = CASE
        WHEN EXISTS (SELECT 1 FROM cloud_user_agent_skill_versions_v3 v
          WHERE v.user_id = cloud_user_agent_instances_v3.user_id
            AND v.id = cloud_user_agent_instances_v3.active_personal_skill_version_id
            AND v.authority = 'cloud')
        THEN cloud_user_agent_instances_v3.active_personal_skill_version_id
        ELSE excluded.active_personal_skill_version_id END,
      status = cloud_user_agent_instances_v3.status,
      instance_kind = cloud_user_agent_instances_v3.instance_kind,
      employment_state = cloud_user_agent_instances_v3.employment_state,
      quota_exempt = cloud_user_agent_instances_v3.quota_exempt,
      recruited_at = cloud_user_agent_instances_v3.recruited_at,
      deactivated_at = cloud_user_agent_instances_v3.deactivated_at,
      last_state_changed_at = cloud_user_agent_instances_v3.last_state_changed_at,
      state_revision = cloud_user_agent_instances_v3.state_revision,
      recruitment_source = cloud_user_agent_instances_v3.recruitment_source,
      policy_version = cloud_user_agent_instances_v3.policy_version,
      sync_enabled = excluded.sync_enabled,
      personal_evolution_consent = excluded.personal_evolution_consent,
      cluster_contribution_consent = excluded.cluster_contribution_consent,
      personal_skill_auto_activate = excluded.personal_skill_auto_activate,
      source_device_id = cloud_user_agent_instances_v3.source_device_id,
      family_instance_seq = cloud_user_agent_instances_v3.family_instance_seq,
      display_name = cloud_user_agent_instances_v3.display_name,
      note = cloud_user_agent_instances_v3.note,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at`,
    ).run(
    syncUserId,
    row.id,
    agentFamilyId,
    row.base_agent_version_id || row.baseAgentVersionId || '',
    row.active_personal_skill_version_id || row.activePersonalSkillVersionId || '',
    row.status || 'active',
    row.instance_kind || row.instanceKind || 'employee',
    row.employment_state || row.employmentState || (row.status === 'inactive' ? 'inactive' : 'active'),
    row.quota_exempt || row.quotaExempt ? 1 : 0,
    row.recruited_at || row.recruitedAt || row.created_at || row.createdAt || '',
    row.deactivated_at || row.deactivatedAt || '',
    row.last_state_changed_at || row.lastStateChangedAt || row.updated_at || row.updatedAt || '',
    Number(row.state_revision ?? row.stateRevision ?? 1),
    row.recruitment_source || row.recruitmentSource || 'migration',
    row.policy_version || row.policyVersion || 'employee_recruitment_phase_a_v1',
    row.sync_enabled === 0 || row.syncEnabled === false ? 0 : 1,
    row.personal_evolution_consent || row.personalEvolutionConsent ? 1 : 0,
    (row.sync_enabled !== 0 && row.syncEnabled !== false)
      && (existingInstance?.status || row.status || 'active') === 'active' ? 1 : 0,
    row.personal_skill_auto_activate || row.personalSkillAutoActivate ? 1 : 0,
    deviceId,
    existingInstance?.family_instance_seq || 0,
    existingInstance?.display_name || '',
    existingInstance?.note || '',
    JSON.stringify({
      ...row,
      ...(existingInstance?.id ? {
        familyInstanceSeq: Number(existingInstance.family_instance_seq || 0),
        displayName: existingInstance.display_name || '',
        note: existingInstance.note || '',
      } : {}),
    }),
    row.created_at || row.createdAt || '',
    row.updated_at || row.updatedAt || '',
  );
}

function upsertUserAgentSkillVersionV3(db, row = {}, { syncUserId }) {
  if (!row.id || !(row.user_agent_instance_id || row.userAgentInstanceId)) return;
  const userAgentInstanceId = canonicalCloudAgentInstanceId(
    db,
    syncUserId,
    row.user_agent_instance_id || row.userAgentInstanceId,
  );
  if(!db.prepare('SELECT 1 FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(syncUserId,userAgentInstanceId)){
    throw new Error(`Memory document Agent instance is unavailable: ${syncUserId}/${userAgentInstanceId}`);
  }
  db.prepare(
    `INSERT INTO cloud_user_agent_skill_versions_v3 (
      user_id, id, user_agent_instance_id, base_agent_version_id, parent_version_id, source_evolution_run_id,
      authority, stability_status, overlay_hash, effective_skill_hash, compiler_version, status,
      activated_at, updated_at, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET
      user_agent_instance_id = excluded.user_agent_instance_id,
      base_agent_version_id = excluded.base_agent_version_id,
      parent_version_id = CASE WHEN cloud_user_agent_skill_versions_v3.authority = 'cloud' THEN cloud_user_agent_skill_versions_v3.parent_version_id ELSE excluded.parent_version_id END,
      source_evolution_run_id = CASE WHEN cloud_user_agent_skill_versions_v3.authority = 'cloud' THEN cloud_user_agent_skill_versions_v3.source_evolution_run_id ELSE excluded.source_evolution_run_id END,
      status = CASE WHEN cloud_user_agent_skill_versions_v3.authority = 'cloud' THEN cloud_user_agent_skill_versions_v3.status ELSE excluded.status END,
      activated_at = excluded.activated_at,
      updated_at = excluded.updated_at,
      payload_json = CASE WHEN cloud_user_agent_skill_versions_v3.authority = 'cloud' THEN cloud_user_agent_skill_versions_v3.payload_json ELSE excluded.payload_json END`,
  ).run(
    syncUserId,
    row.id,
    userAgentInstanceId,
    row.base_agent_version_id || row.baseAgentVersionId || '',
    row.parent_version_id || row.parentVersionId || '',
    row.source_evolution_run_id || row.sourceEvolutionRunId || '',
    row.authority === 'cloud' ? 'cloud' : 'legacy_imported',
    row.stability_status || row.stabilityStatus || (row.status === 'active' ? 'stable' : 'candidate'),
    row.overlay_hash || row.overlayHash || '',
    row.effective_skill_hash || row.effectiveSkillHash || '',
    row.compiler_version || row.compilerVersion || 'overlay_concat_v1',
    row.status || 'candidate',
    row.activated_at || row.activatedAt || '',
    row.updated_at || row.updatedAt || row.created_at || row.createdAt || '',
    JSON.stringify(row),
    row.created_at || row.createdAt || '',
  );
}

function upsertMemoryDocumentV3(db, row = {}, { syncUserId }) {
  if (!row.id || !(row.user_agent_instance_id || row.userAgentInstanceId)) return;
  const requestedInstanceId = row.user_agent_instance_id || row.userAgentInstanceId;
  let userAgentInstanceId = canonicalCloudAgentInstanceId(
    db,
    syncUserId,
    requestedInstanceId,
  );
  if (!db.prepare('SELECT id FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(syncUserId, userAgentInstanceId)) {
    throw new Error(`Memory Agent instance missing: ${requestedInstanceId}`);
  }
  const scope = row.scope || 'general';
  const slotNo = Number(row.slot_no ?? row.slotNo ?? 0);
  const taskRunId = row.task_run_id || row.taskRunId || '';
  const projectId = row.project_id || row.projectId || '';
  const relationshipId = row.relationship_id || row.relationshipId || '';
  const cloudKey = row.cloud_key || row.cloudKey || row.id;
  const consentScopeValue = row.consent_scope_json ?? row.consentScope ?? {};
  const consentScopeJson = typeof consentScopeValue === 'string' ? consentScopeValue : JSON.stringify(consentScopeValue);
  const existing = (cloudKey ? db.prepare(`SELECT id FROM cloud_memory_documents_v3 WHERE user_id=? AND user_agent_instance_id=? AND cloud_key=?`).get(syncUserId,userAgentInstanceId,cloudKey) : null)
    || db.prepare(`SELECT id FROM cloud_memory_documents_v3
    WHERE user_id = ? AND user_agent_instance_id = ? AND scope = ? AND slot_no = ?
      AND task_run_id = ? AND project_id = ? AND relationship_id = ?
    ORDER BY created_at, id LIMIT 1`).get(syncUserId, userAgentInstanceId, scope, slotNo, taskRunId, projectId, relationshipId);
  let documentId = existing?.id || cloudKey || row.id;
  if (existing?.id && existing.id !== row.id) {
    upsertMemoryDocumentAliasV3(db, {
      aliasDocumentId: row.id,
      canonicalDocumentId: existing.id,
      reason: 'cross_device_memory_conflict',
    }, { syncUserId });
    documentId = existing.id;
  }
  const lifecycleState = row.lifecycle_state || row.lifecycleState || 'active';
  if (scope === 'general' && lifecycleState === 'active') {
    db.prepare(`UPDATE cloud_memory_documents_v3 SET lifecycle_state='inactive'
      WHERE user_id=? AND user_agent_instance_id=? AND scope='general' AND lifecycle_state='active' AND id<>?`)
      .run(syncUserId, userAgentInstanceId, documentId);
  }
  db.prepare(
    `INSERT INTO cloud_memory_documents_v3 (
      user_id,id,user_agent_instance_id,agent_family_id,cloud_key,scope,slot_no,display_name,task_run_id,project_id,
      relationship_id,delegation_id,group_id,relationship_user_id,context_space_id,visibility,source_conversation_cursor,encryption_key_id,consent_scope_json,current_version_id,
      lifecycle_state, sync_enabled, allow_personal_evolution, allow_cluster_evolution,
      payload_json, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, id) DO UPDATE SET
      user_agent_instance_id = excluded.user_agent_instance_id,
      agent_family_id=excluded.agent_family_id,cloud_key=CASE WHEN cloud_memory_documents_v3.cloud_key='' THEN excluded.cloud_key ELSE cloud_memory_documents_v3.cloud_key END,
      scope = excluded.scope,
      slot_no = excluded.slot_no,
      display_name = excluded.display_name,
      task_run_id = excluded.task_run_id,
      project_id = excluded.project_id,
      relationship_id = excluded.relationship_id,
      context_space_id = excluded.context_space_id,
      visibility = excluded.visibility,
      source_conversation_cursor = excluded.source_conversation_cursor,
      encryption_key_id = excluded.encryption_key_id,
      consent_scope_json = excluded.consent_scope_json,
      current_version_id = cloud_memory_documents_v3.current_version_id,
      lifecycle_state = excluded.lifecycle_state,
      sync_enabled = excluded.sync_enabled,
      allow_personal_evolution = excluded.allow_personal_evolution,
      allow_cluster_evolution = excluded.allow_cluster_evolution,
      payload_json = CASE WHEN excluded.updated_at >= cloud_memory_documents_v3.updated_at THEN excluded.payload_json ELSE cloud_memory_documents_v3.payload_json END,
      updated_at = MAX(cloud_memory_documents_v3.updated_at, excluded.updated_at)`,
  ).run(
    syncUserId,
    documentId,
    userAgentInstanceId,
    row.agent_family_id || row.agentFamilyId || '',
    cloudKey,
    scope,
    slotNo,
    row.display_name || row.displayName || (scope === 'general' ? `memory${slotNo}.md` : `${scope}.md`),
    taskRunId,
    projectId,
    relationshipId,
    row.delegation_id || row.delegationId || '',
    row.group_id || row.groupId || '',
    row.relationship_user_id || row.relationshipUserId || '',
    row.context_space_id || row.contextSpaceId || '',
    normalizeCloudMemoryVisibility(row.visibility),
    row.source_conversation_cursor || row.sourceConversationCursor || '',
    row.encryption_key_id || row.encryptionKeyId || '',
    consentScopeJson,
    '',
    lifecycleState,
    row.sync_enabled === 0 || row.syncEnabled === false ? 0 : 1,
    row.allow_personal_evolution || row.allowPersonalEvolution ? 1 : 0,
    row.allow_cluster_evolution || row.allowClusterEvolution ? 1 : 0,
    JSON.stringify(row),
    row.created_at || row.createdAt || '',
    row.updated_at || row.updatedAt || '',
  );
  upsertCloudMemorySyncMapping(db, {
    userAgentInstanceId,cloudKey,memoryDocumentId: documentId,status: 'active',
    createdAt: row.created_at || row.createdAt || '',updatedAt: row.updated_at || row.updatedAt || '',
  }, { syncUserId });
}

function upsertMemoryDocumentAliasV3(db, row = {}, { syncUserId }) {
  const aliasId = row.alias_document_id || row.aliasDocumentId || '';
  const canonicalId = row.canonical_document_id || row.canonicalDocumentId || '';
  if (!aliasId || !canonicalId) return;
  db.prepare(`INSERT INTO cloud_memory_document_aliases_v3 (
    user_id, alias_document_id, canonical_document_id, reason, created_at
  ) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_id, alias_document_id) DO UPDATE SET canonical_document_id = excluded.canonical_document_id, reason = excluded.reason`)
    .run(syncUserId, aliasId, canonicalId, row.reason || 'client_alias', row.created_at || row.createdAt || new Date().toISOString());
}

function upsertMemoryDocumentVersionV3(db, row = {}, { syncUserId }) {
  if (!row.id || !(row.memory_document_id || row.memoryDocumentId)) return;
  const rawDocumentId = row.memory_document_id || row.memoryDocumentId;
  const memoryDocumentId = canonicalCloudMemoryDocumentId(db, syncUserId, rawDocumentId);
  const conflictingVersion = db.prepare(`SELECT id FROM cloud_memory_document_versions_v3
    WHERE user_id = ? AND memory_document_id = ? AND version_no = ? AND id <> ?`).get(
    syncUserId, memoryDocumentId, Number(row.version_no ?? row.versionNo ?? 1), row.id,
  );
  const versionNo = conflictingVersion
    ? Number(db.prepare('SELECT COALESCE(MAX(version_no), 0) + 1 AS value FROM cloud_memory_document_versions_v3 WHERE user_id = ? AND memory_document_id = ?').get(syncUserId, memoryDocumentId)?.value || 1)
    : Number(row.version_no ?? row.versionNo ?? 1);
  const document = db.prepare('SELECT current_version_id FROM cloud_memory_documents_v3 WHERE user_id=? AND id=?')
    .get(syncUserId, memoryDocumentId);
  const baseVersionId = row.base_version_id || row.baseVersionId || '';
  const isConflict = Boolean(baseVersionId && document?.current_version_id && baseVersionId !== document.current_version_id);
  const conflictState = isConflict ? 'unresolved' : (row.conflict_state || row.conflictState || 'none');
  const branchId = isConflict && (!row.branch_id && !row.branchId || (row.branch_id || row.branchId) === 'main')
    ? `branch_${row.id}`
    : row.branch_id || row.branchId || 'main';
  db.prepare(
    `INSERT INTO cloud_memory_document_versions_v3 (
      user_id,id,memory_document_id,version_no,content_hash,base_version_id,parent_version_id,branch_id,conflict_state,payload_json,created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, id) DO UPDATE SET
      memory_document_id = excluded.memory_document_id,
      version_no = excluded.version_no,
      content_hash = excluded.content_hash,
      base_version_id=excluded.base_version_id,parent_version_id=excluded.parent_version_id,
      branch_id=excluded.branch_id,conflict_state=excluded.conflict_state,
      payload_json = excluded.payload_json`,
  ).run(
    syncUserId,
    row.id,
    memoryDocumentId,
    versionNo,
    row.content_hash || row.contentHash || '',
    baseVersionId,row.parent_version_id || row.parentVersionId || '',
    branchId,conflictState,
    JSON.stringify(row),
    row.created_at || row.createdAt || '',
  );
  if (conflictState !== 'unresolved') {
    db.prepare('UPDATE cloud_memory_documents_v3 SET current_version_id=?,updated_at=MAX(updated_at,?) WHERE user_id=? AND id=?')
      .run(row.id,row.created_at || row.createdAt || '',syncUserId,memoryDocumentId);
  }
}

function upsertAgentContextSpaceV7(db, row = {}, { syncUserId }) {
  const instanceId = canonicalCloudAgentInstanceId(db,syncUserId,row.user_agent_instance_id || row.userAgentInstanceId || '');
  if (!row.id || !instanceId) return;
  const rawDocumentId = row.memory_document_id || row.memoryDocumentId || '';
  const memoryDocumentId = rawDocumentId ? canonicalCloudMemoryDocumentId(db,syncUserId,rawDocumentId) : '';
  const contextKind = row.context_kind || row.contextKind || 'general_memory';
  const identity = [instanceId,contextKind,memoryDocumentId,row.project_id || row.projectId || '',row.task_run_id || row.taskRunId || '',
    row.delegation_id || row.delegationId || '',row.group_id || row.groupId || '',row.relationship_user_id || row.relationshipUserId || ''];
  const existing = db.prepare(`SELECT id FROM cloud_agent_context_spaces WHERE user_id=? AND user_agent_instance_id=? AND context_kind=?
    AND IFNULL(memory_document_id,'')=? AND project_id=? AND task_run_id=? AND delegation_id=? AND group_id=? AND relationship_user_id=?`)
    .get(syncUserId,...identity);
  const contextId = existing?.id || row.id;
  db.prepare(`INSERT INTO cloud_agent_context_spaces (
    user_id,id,user_agent_instance_id,context_kind,memory_document_id,project_id,task_run_id,delegation_id,group_id,
    relationship_user_id,lifecycle_state,created_at,updated_at
  ) VALUES (?,?,?,?,NULLIF(?,''),?,?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET lifecycle_state=excluded.lifecycle_state,
    updated_at=excluded.updated_at`).run(
    syncUserId,contextId,instanceId,contextKind,memoryDocumentId,
    row.project_id || row.projectId || '',row.task_run_id || row.taskRunId || '',row.delegation_id || row.delegationId || '',
    row.group_id || row.groupId || '',row.relationship_user_id || row.relationshipUserId || '',
    row.lifecycle_state || row.lifecycleState || 'active',row.created_at || row.createdAt || '',row.updated_at || row.updatedAt || '',
  );
}

function upsertAgentContextStateV8(db, row = {}, { syncUserId, deviceId = '' }) {
  const instanceId = canonicalCloudAgentInstanceId(db, syncUserId,
    row.user_agent_instance_id || row.userAgentInstanceId || row.id || '');
  if (!instanceId) return;
  if(!db.prepare('SELECT 1 FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(syncUserId,instanceId))return;
  const rawMemoryId = row.active_memory_document_id || row.activeMemoryDocumentId
    || row.active_memory_cloud_key || row.activeMemoryCloudKey || '';
  const memoryDocumentId = rawMemoryId ? canonicalCloudMemoryDocumentId(db, syncUserId, rawMemoryId) : '';
  const current = db.prepare(`SELECT * FROM cloud_agent_context_states
    WHERE owner_user_id=? AND user_agent_instance_id=?`).get(syncUserId, instanceId);
  const expected = Number(row.base_state_revision ?? row.baseStateRevision ?? 0);
  if (current && expected !== Number(current.state_revision || 0)) return;
  if (memoryDocumentId) {
    const memory = db.prepare(`SELECT lifecycle_state FROM cloud_memory_documents_v3
      WHERE user_id=? AND id=? AND user_agent_instance_id=? AND scope='general'`).get(syncUserId, memoryDocumentId, instanceId);
    if (!memory || memory.lifecycle_state === 'archived') return;
    db.prepare(`UPDATE cloud_memory_documents_v3 SET lifecycle_state=CASE WHEN id=? THEN 'active' ELSE 'inactive' END,
      updated_at=CASE WHEN id=? THEN ? ELSE updated_at END
      WHERE user_id=? AND user_agent_instance_id=? AND scope='general' AND lifecycle_state<>'archived'`)
      .run(memoryDocumentId, memoryDocumentId, row.updated_at || row.updatedAt || new Date().toISOString(), syncUserId, instanceId);
    db.prepare(`UPDATE cloud_agent_context_spaces SET lifecycle_state=CASE WHEN memory_document_id=? THEN 'active' ELSE 'inactive' END,
      updated_at=CASE WHEN memory_document_id=? THEN ? ELSE updated_at END
      WHERE user_id=? AND user_agent_instance_id=? AND context_kind='general_memory' AND lifecycle_state<>'archived'`)
      .run(memoryDocumentId, memoryDocumentId, row.updated_at || row.updatedAt || new Date().toISOString(), syncUserId, instanceId);
  }
  const now = row.updated_at || row.updatedAt || new Date().toISOString();
  const stateRevision = Number(current?.state_revision || 0) + 1;
  db.prepare(`INSERT INTO cloud_agent_context_states(
    owner_user_id,user_agent_instance_id,primary_conversation_id,active_context_space_id,active_memory_document_id,
    state_revision,last_command_id,source_device_id,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,user_agent_instance_id) DO UPDATE SET
    primary_conversation_id=excluded.primary_conversation_id,active_context_space_id=excluded.active_context_space_id,
    active_memory_document_id=excluded.active_memory_document_id,state_revision=excluded.state_revision,
    last_command_id=excluded.last_command_id,source_device_id=excluded.source_device_id,updated_at=excluded.updated_at`).run(
    syncUserId, instanceId, row.primary_conversation_id || row.primaryConversationId || row.primary_session_id || row.primarySessionId || '',
    row.active_context_space_id || row.activeContextSpaceId || '', memoryDocumentId, stateRevision,
    row.last_command_id || row.lastCommandId || '', deviceId || row.source_device_id || row.sourceDeviceId || '',
    current?.created_at || row.created_at || row.createdAt || now, now,
  );
}

function upsertChatContextStateV9(db, row = {}, { syncUserId, deviceId = '' }) {
  const incomingId = String(row.id || '').trim();
  const sessionId = String(row.session_id || row.sessionId || '').trim();
  let contextSpaceId = String(row.context_space_id || row.contextSpaceId || '').trim();
  if (!incomingId || !sessionId) return;
  const conversation = db.prepare(`SELECT payload_json FROM cloud_conversations_v2
    WHERE user_id=? AND id=? ORDER BY updated_at DESC,device_id DESC LIMIT 1`).get(syncUserId, sessionId);
  if (!conversation) return;
  if (contextSpaceId) {
    let context = db.prepare(`SELECT id,user_agent_instance_id FROM cloud_agent_context_spaces
      WHERE user_id=? AND id=? AND lifecycle_state<>'archived'`).get(syncUserId, contextSpaceId);
    if (!context && (row.context_kind || row.contextKind)) {
      const instanceId = canonicalCloudAgentInstanceId(db, syncUserId, row.user_agent_instance_id || row.userAgentInstanceId || '');
      const memoryDocumentId = canonicalCloudMemoryDocumentId(db, syncUserId, row.memory_document_id || row.memoryDocumentId || '');
      context = db.prepare(`SELECT id,user_agent_instance_id FROM cloud_agent_context_spaces
        WHERE user_id=? AND user_agent_instance_id=? AND context_kind=? AND IFNULL(memory_document_id,'')=?
          AND project_id=? AND task_run_id=? AND delegation_id=? AND group_id=? AND relationship_user_id=?
          AND lifecycle_state<>'archived' LIMIT 1`).get(
        syncUserId,instanceId,row.context_kind || row.contextKind,memoryDocumentId,row.project_id || row.projectId || '',
        row.task_run_id || row.taskRunId || '',row.delegation_id || row.delegationId || '',row.group_id || row.groupId || '',
        row.relationship_user_id || row.relationshipUserId || '',
      );
      if (context) contextSpaceId = context.id;
    }
    if (!context) return;
    let conversationPayload = {};
    try { conversationPayload = JSON.parse(conversation.payload_json || '{}'); } catch { conversationPayload = {}; }
    const conversationInstanceId = conversationPayload.agentInstanceId || conversationPayload.agent_instance_id || '';
    if (conversationInstanceId && conversationInstanceId !== context.user_agent_instance_id) return;
  }
  const current = db.prepare(`SELECT * FROM cloud_chat_context_states
    WHERE owner_user_id=? AND session_id=? AND context_space_id=?`).get(syncUserId, sessionId, contextSpaceId);
  const id = current?.id || incomingId;
  const expected = Number(row.base_state_revision ?? row.baseStateRevision ?? 0);
  if (current && expected !== Number(current.state_revision || 0)) return;
  const now = row.updated_at || row.updatedAt || new Date().toISOString();
  const revision = Number(current?.state_revision || 0) + 1;
  db.prepare(`INSERT INTO cloud_chat_context_states(
    id,owner_user_id,session_id,context_space_id,context_epoch,reset_after_message_id,reset_after_created_at,
    last_execution_id,last_input_tokens,context_window_tokens,provider_compaction_detected,state_revision,
    last_command_id,source_device_id,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    session_id=excluded.session_id,context_space_id=excluded.context_space_id,context_epoch=excluded.context_epoch,
    reset_after_message_id=excluded.reset_after_message_id,reset_after_created_at=excluded.reset_after_created_at,
    last_execution_id=excluded.last_execution_id,last_input_tokens=excluded.last_input_tokens,
    context_window_tokens=excluded.context_window_tokens,provider_compaction_detected=excluded.provider_compaction_detected,
    state_revision=excluded.state_revision,last_command_id=excluded.last_command_id,
    source_device_id=excluded.source_device_id,updated_at=excluded.updated_at`).run(
    id,syncUserId,sessionId,contextSpaceId,Math.max(1,Number(row.context_epoch ?? row.contextEpoch ?? 1)),
    row.reset_after_message_id || row.resetAfterMessageId || '',row.reset_after_created_at || row.resetAfterCreatedAt || '',
    row.last_execution_id || row.lastExecutionId || '',Math.max(0,Number(row.last_input_tokens ?? row.lastInputTokens ?? 0)),
    Math.max(0,Number(row.context_window_tokens ?? row.contextWindowTokens ?? 0)),
    row.provider_compaction_detected || row.providerCompactionDetected ? 1 : 0,revision,
    row.last_command_id || row.lastCommandId || '',deviceId || row.source_device_id || row.sourceDeviceId || '',
    current?.created_at || row.created_at || row.createdAt || now,now,
  );
}

function upsertCloudMemorySyncMapping(db, row = {}, { syncUserId }) {
  const instanceId = canonicalCloudAgentInstanceId(db,syncUserId,row.user_agent_instance_id || row.userAgentInstanceId || '');
  const documentId = canonicalCloudMemoryDocumentId(db,syncUserId,row.memory_document_id || row.memoryDocumentId || '');
  const cloudKey = row.cloud_key || row.cloudKey || '';
  if (!instanceId || !documentId || !cloudKey) return;
  const instanceExists=db.prepare('SELECT 1 FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(syncUserId,instanceId);
  const documentExists=db.prepare('SELECT 1 FROM cloud_memory_documents_v3 WHERE user_id=? AND id=?').get(syncUserId,documentId);
  if(!instanceExists||!documentExists)throw new Error(`Memory mapping owner is unavailable: instance=${Boolean(instanceExists)} document=${Boolean(documentExists)} user=${syncUserId} instanceId=${instanceId} documentId=${documentId}`);
  const active = db.prepare(`SELECT cloud_key FROM cloud_memory_sync_mappings
    WHERE owner_user_id=? AND memory_document_id=? AND status='active'`).get(syncUserId,documentId);
  const status = active && active.cloud_key !== cloudKey ? 'superseded' : (row.status || 'active');
  db.prepare(`INSERT INTO cloud_memory_sync_mappings(owner_user_id,user_agent_instance_id,cloud_key,memory_document_id,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,user_agent_instance_id,cloud_key) DO UPDATE SET
    memory_document_id=excluded.memory_document_id,status=excluded.status,updated_at=excluded.updated_at`).run(
    syncUserId,instanceId,cloudKey,documentId,status,row.created_at || row.createdAt || '',row.updated_at || row.updatedAt || '',
  );
}

function upsertTaskSecurityContextV5(db, row = {}, { syncUserId }) {
  const taskRunId = row.task_run_id || row.taskRunId || '';
  if (!taskRunId || !(row.local_key_id || row.localKeyId) || !(row.cloud_key_id || row.cloudKeyId)) return;
  db.prepare(`INSERT INTO cloud_task_security_contexts_v5 (
    user_id,task_run_id,owner_user_id,local_key_id,cloud_key_id,key_version,cloud_evolution_allowed,cloud_collaboration_allowed,
    local_envelope_state,cloud_envelope_state,status,payload_json,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(user_id,task_run_id) DO UPDATE SET
    owner_user_id=excluded.owner_user_id,
    local_key_id=excluded.local_key_id,
    cloud_key_id=excluded.cloud_key_id,
    key_version=MAX(cloud_task_security_contexts_v5.key_version,excluded.key_version),
    cloud_evolution_allowed=excluded.cloud_evolution_allowed,
    cloud_collaboration_allowed=excluded.cloud_collaboration_allowed,
    local_envelope_state=excluded.local_envelope_state,
    cloud_envelope_state=excluded.cloud_envelope_state,
    status=excluded.status,
    payload_json=excluded.payload_json,
    updated_at=MAX(cloud_task_security_contexts_v5.updated_at,excluded.updated_at)`).run(
    syncUserId,
    taskRunId,
    row.owner_user_id || row.ownerUserId || syncUserId,
    row.local_key_id || row.localKeyId,
    row.cloud_key_id || row.cloudKeyId,
    Number(row.key_version ?? row.keyVersion ?? 1),
    row.cloud_evolution_allowed || row.cloudEvolutionAllowed ? 1 : 0,
    row.cloud_collaboration_allowed || row.cloudCollaborationAllowed ? 1 : 0,
    row.local_envelope_state || row.localEnvelopeState || 'reference_only',
    row.cloud_envelope_state || row.cloudEnvelopeState || 'disabled',
    row.status || 'active',
    JSON.stringify(row),
    row.created_at || row.createdAt || '',
    row.updated_at || row.updatedAt || '',
  );
}

function canonicalCloudAgentInstanceId(db, userId, instanceId) {
  const alias=db.prepare(`SELECT a.canonical_instance_id FROM cloud_user_agent_instance_aliases_v3 a
    JOIN cloud_user_agent_instances_v3 i ON i.user_id=a.user_id AND i.id=a.canonical_instance_id
    WHERE a.user_id=? AND a.alias_instance_id=?`).get(userId,instanceId);
  return alias?.canonical_instance_id || instanceId;
}

function canonicalCloudMemoryDocumentId(db, userId, documentId) {
  const alias=db.prepare(`SELECT a.canonical_document_id FROM cloud_memory_document_aliases_v3 a
    JOIN cloud_memory_documents_v3 d ON d.user_id=a.user_id AND d.id=a.canonical_document_id
    WHERE a.user_id=? AND a.alias_document_id=?`).get(userId,documentId);
  return alias?.canonical_document_id || documentId;
}

function reconcileCloudActiveSkillVersions(db, userId) {
  const instances = db.prepare('SELECT id FROM cloud_user_agent_instances_v3 WHERE user_id = ?').all(userId);
  for (const instance of instances) {
    const versions = db.prepare(`SELECT id, activated_at, updated_at FROM cloud_user_agent_skill_versions_v3
      WHERE user_id = ? AND user_agent_instance_id = ? AND activated_at != ''
      ORDER BY activated_at DESC, updated_at DESC, id DESC`).all(userId, instance.id);
    const winner = versions[0];
    if (winner) {
      db.prepare(`UPDATE cloud_user_agent_skill_versions_v3 SET status = CASE WHEN id = ? THEN 'active' ELSE 'archived' END
        WHERE user_id = ? AND user_agent_instance_id = ? AND activated_at != ''`).run(winner.id, userId, instance.id);
      db.prepare('UPDATE cloud_user_agent_instances_v3 SET active_personal_skill_version_id = ?, updated_at = MAX(updated_at, ?) WHERE user_id = ? AND id = ?')
        .run(winner.id, winner.updated_at || winner.activated_at || '', userId, instance.id);
    }
  }
}

function identityCursorForUser(db, userId) {
  const values = [];
  for (const [table, column, userColumn = 'user_id'] of [
    ['cloud_user_agent_instances_v3', 'updated_at'],
    ['cloud_user_agent_skill_versions_v3', 'updated_at'],
    ['cloud_memory_documents_v3', 'updated_at'],
    ['cloud_user_agent_instance_aliases_v3', 'created_at'],
    ['cloud_memory_document_aliases_v3', 'created_at'],
    ['cloud_agent_context_spaces', 'updated_at'],
    ['cloud_agent_context_states', 'updated_at', 'owner_user_id'],
    ['cloud_chat_context_states', 'updated_at', 'owner_user_id'],
    ['cloud_memory_sync_mappings', 'updated_at', 'owner_user_id'],
    ['cloud_task_security_contexts_v5', 'updated_at'],
  ]) {
    const row = db.prepare(`SELECT MAX(${column}) AS value FROM ${table} WHERE ${userColumn} = ?`).get(userId);
    if (row?.value) values.push(row.value);
  }
  return values.sort().at(-1) || new Date().toISOString();
}

function identitySnapshot(db, { userId = '', cursor = '' } = {}) {
  const cleanUserId = String(userId || '').trim();
  if (!cleanUserId) throw new Error('identity sync userId is required');
  const changed = (table, column, userColumn = 'user_id') => db.prepare(`SELECT * FROM ${table} WHERE ${userColumn} = ? AND (? = '' OR ${column} > ?)`).all(cleanUserId, cursor, cursor);
  const instances = changed('cloud_user_agent_instances_v3', 'updated_at');
  const familyIds = [...new Set(instances.map((item) => item.agent_family_id))];
  const versionIds = [...new Set(instances.map((item) => item.base_agent_version_id).filter(Boolean))];
  const rowsByIds = (table, ids) => ids.map((id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)).filter(Boolean);
  return {
    status: 'ok',
    cursor: identityCursorForUser(db, cleanUserId),
    data: {
      agentFamilies: rowsByIds('cloud_agent_families_v3', familyIds).map(identityPayload),
      agentVersions: rowsByIds('cloud_agent_versions_v3', versionIds).map(identityPayload),
      userAgentInstances: instances.map(identityPayload),
      userAgentSkillVersions: changed('cloud_user_agent_skill_versions_v3', 'updated_at').map(identityPayload),
      userAgentInstanceAliases: changed('cloud_user_agent_instance_aliases_v3', 'created_at').map(identityPayload),
      memoryDocuments: changed('cloud_memory_documents_v3', 'updated_at').map(identityPayload),
      memoryDocumentVersions: db.prepare(`SELECT mdv.* FROM cloud_memory_document_versions_v3 mdv
        JOIN cloud_memory_documents_v3 md ON md.user_id = mdv.user_id AND md.id = mdv.memory_document_id
        WHERE mdv.user_id = ? AND (? = '' OR md.updated_at > ? OR mdv.created_at > ?)`).all(cleanUserId, cursor, cursor, cursor).map(identityPayload),
      memoryDocumentAliases: changed('cloud_memory_document_aliases_v3', 'created_at').map(identityPayload),
      agentContextSpaces: changed('cloud_agent_context_spaces', 'updated_at').map(identityPayload),
      agentContextStates: changed('cloud_agent_context_states', 'updated_at', 'owner_user_id').map(identityPayload),
      chatContextStates: changed('cloud_chat_context_states', 'updated_at', 'owner_user_id').map(identityPayload),
      memorySyncMappings: changed('cloud_memory_sync_mappings', 'updated_at', 'owner_user_id').map(identityPayload),
      taskSecurityContexts: changed('cloud_task_security_contexts_v5', 'updated_at').map(identityPayload),
    },
  };
}

function identityPayload(row = {}) {
  let payload = {};
  try { payload = JSON.parse(row.payload_json || '{}'); } catch { payload = {}; }
  return { ...payload, ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'payload_json')) };
}

function upsertProjectV2(db, row = {}, { syncUserId, deviceId }) {
  if (!row.id) return;
  const userId = String(row.userId || row.user_id || syncUserId);
  db.prepare(
    `INSERT INTO cloud_projects_v2 (user_id, device_id, id, title, status, payload_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, device_id, id) DO UPDATE SET
      title = excluded.title,
      status = excluded.status,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at`,
  ).run(userId, deviceId, row.id, row.title || '', row.status || 'active', JSON.stringify(row), row.updatedAt || row.updated_at || '');
}

function upsertConversationV2(db, row = {}, { syncUserId, deviceId }) {
  if (!row.id) return;
  const userId = String(row.userId || row.user_id || syncUserId);
  const departmentId = String(row.departmentId || row.department_id || '');
  if (isLegacyChatDepartmentId(departmentId)) {
    purgeCloudConversationData(db, userId, deviceId, row.id);
    return;
  }
  const projectId = String(row.projectId || row.project_id || '');
  const conversationType = row.conversationType || row.conversation_type || (projectId ? 'project' : 'ordinary');
  db.prepare(
    `INSERT INTO cloud_conversations_v2 (
      user_id, device_id, id, conversation_type, project_id, title, department_id,
      agent_id, status, payload_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, device_id, id) DO UPDATE SET
      conversation_type = excluded.conversation_type,
      project_id = excluded.project_id,
      title = excluded.title,
      department_id = excluded.department_id,
      agent_id = excluded.agent_id,
      status = excluded.status,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at`,
  ).run(
    userId, deviceId, row.id, conversationType, projectId, row.title || '', departmentId,
    row.agentId || row.agent_id || '', row.status || 'active', JSON.stringify(row), row.createdAt || row.created_at || '', row.updatedAt || row.updated_at || '',
  );
}

function purgeConversationFiles(db, userId, deviceId, conversationId) {
  const hashes = db.prepare(
    'SELECT DISTINCT sha256 FROM cloud_file_refs_v2 WHERE user_id = ? AND device_id = ? AND conversation_id = ?',
  ).all(userId, deviceId, conversationId).map((row) => row.sha256).filter(Boolean);
  db.prepare('DELETE FROM cloud_file_refs_v2 WHERE user_id = ? AND device_id = ? AND conversation_id = ?')
    .run(userId, deviceId, conversationId);
  for (const sha256 of hashes) {
    const remaining = db.prepare('SELECT COUNT(*) AS count FROM cloud_file_refs_v2 WHERE sha256 = ?').get(sha256)?.count || 0;
    if (Number(remaining) > 0) continue;
    const object = db.prepare('SELECT storage_path FROM file_objects WHERE sha256 = ?').get(sha256);
    if (object?.storage_path) {
      try {
        fs.rmSync(object.storage_path, { force: true });
      } catch {
        // Object metadata must not outlive its final lineage reference. A stale
        // or temporarily inaccessible file is best-effort filesystem cleanup;
        // keeping the database row would expose an object that no user owns.
      }
    }
    db.prepare('DELETE FROM file_links WHERE sha256 = ?').run(sha256);
    db.prepare('DELETE FROM file_objects WHERE sha256 = ?').run(sha256);
  }
}

function purgeCloudConversationData(db, userId, deviceId, conversationId) {
  purgeConversationFiles(db, userId, deviceId, conversationId);
  db.prepare('DELETE FROM cloud_messages_v2 WHERE user_id = ? AND device_id = ? AND conversation_id = ?')
    .run(userId, deviceId, conversationId);
  db.prepare('DELETE FROM cloud_transcripts_v2 WHERE user_id = ? AND device_id = ? AND conversation_id = ?')
    .run(userId, deviceId, conversationId);
  db.prepare('DELETE FROM cloud_model_executions_v2 WHERE user_id = ? AND device_id = ? AND conversation_id = ?')
    .run(userId, deviceId, conversationId);
  db.prepare('DELETE FROM cloud_conversations_v2 WHERE user_id = ? AND device_id = ? AND id = ?')
    .run(userId, deviceId, conversationId);
}

function cloudConversationExists(db, userId, deviceId, conversationId) {
  if (!conversationId) return true;
  return Boolean(db.prepare(
    'SELECT 1 FROM cloud_conversations_v2 WHERE user_id = ? AND device_id = ? AND id = ?',
  ).get(userId, deviceId, conversationId));
}

function upsertMessageV2(db, row = {}, { syncUserId, deviceId }) {
  if (!row.id) return;
  const userId = String(row.userId || row.user_id || syncUserId);
  const conversationId = String(row.conversationId || row.session_id || '');
  if (!cloudConversationExists(db, userId, deviceId, conversationId)) return;
  db.prepare(
    `INSERT INTO cloud_messages_v2 (user_id, device_id, id, conversation_id, role, content, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, device_id, id) DO UPDATE SET
      conversation_id = excluded.conversation_id,
      role = excluded.role,
      content = excluded.content,
      payload_json = excluded.payload_json,
      created_at = excluded.created_at`,
  ).run(userId, deviceId, row.id, conversationId, row.role || '', row.content || '', JSON.stringify(row), row.createdAt || row.created_at || '');
}

function upsertTranscriptV2(db, row = {}, { syncUserId, deviceId }) {
  if (!row.id) return;
  const userId = String(row.userId || row.user_id || syncUserId);
  const conversationId = String(row.conversationId || row.conversation_id || row.session_id || '');
  if (!cloudConversationExists(db, userId, deviceId, conversationId)) return;
  db.prepare(
    `INSERT INTO cloud_transcripts_v2 (user_id, device_id, id, conversation_id, role, content, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, device_id, id) DO UPDATE SET
      conversation_id = excluded.conversation_id,
      role = excluded.role,
      content = excluded.content,
      payload_json = excluded.payload_json,
      created_at = excluded.created_at`,
  ).run(userId, deviceId, row.id, conversationId, row.role || '', row.content || '', JSON.stringify(row), row.createdAt || row.created_at || '');
}

function upsertModelExecutionV2(db, row = {}, { syncUserId, deviceId }) {
  if (!row.id) return;
  const userId = String(row.userId || row.user_id || syncUserId);
  const conversationId = String(row.conversationId || row.conversation_id || '');
  if (isLegacyChatDepartmentId(row.departmentId || row.department_id)) return;
  if (!cloudConversationExists(db, userId, deviceId, conversationId)) return;
  db.prepare(
    `INSERT INTO cloud_model_executions_v2 (
      user_id, device_id, id, project_id, conversation_id, request_message_id,
      response_message_id, task_run_id, task_node_id, department_id, agent_id,
      execution_kind, provider_id, effective_model, reasoning_effort, status,
      payload_json, started_at, completed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, device_id, id) DO UPDATE SET
      project_id = excluded.project_id,
      conversation_id = excluded.conversation_id,
      request_message_id = excluded.request_message_id,
      response_message_id = excluded.response_message_id,
      task_run_id = excluded.task_run_id,
      task_node_id = excluded.task_node_id,
      department_id = excluded.department_id,
      agent_id = excluded.agent_id,
      execution_kind = excluded.execution_kind,
      provider_id = excluded.provider_id,
      effective_model = excluded.effective_model,
      reasoning_effort = excluded.reasoning_effort,
      status = excluded.status,
      payload_json = excluded.payload_json,
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at`,
  ).run(
    userId, deviceId, row.id, row.projectId || row.project_id || '', conversationId,
    row.requestMessageId || row.request_message_id || '', row.responseMessageId || row.response_message_id || '',
    row.taskRunId || row.task_run_id || '', row.taskNodeId || row.task_node_id || '',
    row.departmentId || row.department_id || '', row.agentId || row.agent_id || '', row.executionKind || row.execution_kind || '',
    row.providerId || row.provider_id || '', row.effectiveModel || row.effective_model || '', row.reasoningEffort || row.reasoning_effort || '',
    row.status || '', JSON.stringify(row), row.startedAt || row.started_at || '', row.completedAt || row.completed_at || '',
    row.updatedAt || row.updated_at || row.completedAt || row.completed_at || row.startedAt || row.started_at || '',
  );
}

function upsertFileRefV2(db, row = {}, { syncUserId, deviceId }) {
  if (!row.id || !/^[a-f0-9]{64}$/i.test(String(row.sha256 || ''))) return;
  const userId = String(row.userId || row.user_id || syncUserId);
  const conversationId = String(row.conversationId || row.conversation_id || row.session_id || '');
  if (!cloudConversationExists(db, userId, deviceId, conversationId)) return;
  const localPath = normalizeUploadedLocalPath(row.localPath || row.local_path || '');
  db.prepare(
    `INSERT INTO cloud_file_refs_v2 (
      user_id, device_id, id, sha256, project_id, conversation_id, message_id,
      task_run_id, task_node_id, relation_type, source_kind, original_name,
      content_type, local_path, size_bytes, payload_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, device_id, id) DO UPDATE SET
      sha256 = excluded.sha256,
      project_id = excluded.project_id,
      conversation_id = excluded.conversation_id,
      message_id = excluded.message_id,
      task_run_id = excluded.task_run_id,
      task_node_id = excluded.task_node_id,
      relation_type = excluded.relation_type,
      source_kind = excluded.source_kind,
      original_name = excluded.original_name,
      content_type = excluded.content_type,
      local_path = excluded.local_path,
      size_bytes = excluded.size_bytes,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at`,
  ).run(
    userId, deviceId, row.id, row.sha256, row.projectId || row.project_id || '', conversationId,
    row.messageId || row.message_id || '', row.taskRunId || row.task_run_id || '', row.taskNodeId || row.task_node_id || '',
    row.relationType || row.relation_type || 'intermediate', row.sourceKind || row.source_kind || '', row.originalName || row.original_name || '',
    row.contentType || row.content_type || '', localPath, Number(row.sizeBytes || row.size_bytes || 0), JSON.stringify(row),
    row.createdAt || row.created_at || '', new Date().toISOString(),
  );
}

function upsertRows(db, table, rows, timestampKey, secondaryKey = '', timestampColumn = 'updated_at') {
  for (const row of rows) {
    if (!row?.id) continue;
    const columns = secondaryKey ? `(id, ${secondaryKey}, payload_json, ${timestampColumn})` : `(id, payload_json, ${timestampColumn})`;
    const values = secondaryKey ? '(?, ?, ?, ?)' : '(?, ?, ?)';
    const params = secondaryKey
      ? [row.id, row[secondaryKey] || '', JSON.stringify(row), row[timestampKey] || row.updated_at || row.created_at || '']
      : [row.id, JSON.stringify(row), row[timestampKey] || row.updated_at || row.created_at || ''];
    db.prepare(
      `INSERT INTO ${table} ${columns}
       VALUES ${values}
       ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, ${timestampColumn} = excluded.${timestampColumn}`,
    ).run(...params);
  }
}

function traceFile(db, sha256, params) {
  const userId = String(params.get('userId') || '').trim();
  const deviceId = String(params.get('deviceId') || '').trim();
  if ((!userId && !deviceId) || !/^[a-f0-9]{64}$/i.test(String(sha256 || ''))) {
    return { status: 'invalid', error: 'userId or deviceId and a valid sha256 are required' };
  }
  const refs = userId && deviceId
    ? db.prepare('SELECT * FROM cloud_file_refs_v2 WHERE user_id = ? AND device_id = ? AND sha256 = ? ORDER BY created_at ASC').all(userId, deviceId, sha256)
    : userId
      ? db.prepare('SELECT * FROM cloud_file_refs_v2 WHERE user_id = ? AND sha256 = ? ORDER BY created_at ASC').all(userId, sha256)
      : db.prepare('SELECT * FROM cloud_file_refs_v2 WHERE device_id = ? AND sha256 = ? ORDER BY created_at ASC').all(deviceId, sha256);
  if (!refs.length) return { status: 'not_found', sha256 };
  const object = db.prepare('SELECT sha256, size_bytes, created_at FROM file_objects WHERE sha256 = ?').get(sha256) || null;
  const contexts = [];
  const seen = new Set();
  for (const ref of refs) {
    if (!ref.conversation_id) continue;
    const key = `${ref.user_id}\n${ref.device_id}\n${ref.conversation_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const conversation = db.prepare(
      'SELECT * FROM cloud_conversations_v2 WHERE user_id = ? AND device_id = ? AND id = ?',
    ).get(ref.user_id, ref.device_id, ref.conversation_id);
    if (conversation) contexts.push(conversationContext(db, conversation));
  }
  return {
    status: 'ok',
    file: object,
    refs: refs.map(fileRefPayload),
    contexts,
  };
}

function traceConversation(db, conversationId, params) {
  const userId = String(params.get('userId') || '').trim();
  const deviceId = String(params.get('deviceId') || '').trim();
  if ((!userId && !deviceId) || !conversationId) return { status: 'invalid', error: 'userId or deviceId and conversationId are required' };
  const rows = userId && deviceId
    ? db.prepare('SELECT * FROM cloud_conversations_v2 WHERE user_id = ? AND device_id = ? AND id = ?').all(userId, deviceId, conversationId)
    : userId
      ? db.prepare('SELECT * FROM cloud_conversations_v2 WHERE user_id = ? AND id = ? ORDER BY updated_at DESC').all(userId, conversationId)
      : db.prepare('SELECT * FROM cloud_conversations_v2 WHERE device_id = ? AND id = ? ORDER BY updated_at DESC').all(deviceId, conversationId);
  if (!rows.length) return { status: 'not_found', conversationId };
  return { status: 'ok', contexts: rows.map((row) => conversationContext(db, row)) };
}

function conversationContext(db, conversationRow) {
  const messages = db.prepare(
    `SELECT * FROM cloud_messages_v2
     WHERE user_id = ? AND device_id = ? AND conversation_id = ?
     ORDER BY created_at ASC, id ASC`,
  ).all(conversationRow.user_id, conversationRow.device_id, conversationRow.id);
  const fileRefs = db.prepare(
    `SELECT * FROM cloud_file_refs_v2
     WHERE user_id = ? AND device_id = ? AND conversation_id = ?
     ORDER BY created_at ASC, id ASC`,
  ).all(conversationRow.user_id, conversationRow.device_id, conversationRow.id);
  const transcripts = db.prepare(
    `SELECT * FROM cloud_transcripts_v2
     WHERE user_id = ? AND device_id = ? AND conversation_id = ?
     ORDER BY created_at ASC, id ASC`,
  ).all(conversationRow.user_id, conversationRow.device_id, conversationRow.id);
  const modelExecutions = db.prepare(
    `SELECT * FROM cloud_model_executions_v2
     WHERE user_id = ? AND device_id = ? AND conversation_id = ?
     ORDER BY started_at ASC, id ASC`,
  ).all(conversationRow.user_id, conversationRow.device_id, conversationRow.id);
  const project = conversationRow.project_id
    ? db.prepare(
      'SELECT * FROM cloud_projects_v2 WHERE user_id = ? AND device_id = ? AND id = ?',
    ).get(conversationRow.user_id, conversationRow.device_id, conversationRow.project_id)
    : null;
  return {
    conversation: payloadFromRow(conversationRow),
    project: project ? payloadFromRow(project) : null,
    messages: messages.map(payloadFromRow),
    codexTranscripts: transcripts.map(payloadFromRow),
    modelExecutions: modelExecutions.map(payloadFromRow),
    fileRefs: fileRefs.map(fileRefPayload),
  };
}

function storedFileForUser(db, sha256, params) {
  const userId = String(params.get('userId') || '').trim();
  const deviceId = String(params.get('deviceId') || '').trim();
  if ((!userId && !deviceId) || !/^[a-f0-9]{64}$/i.test(String(sha256 || ''))) {
    return { status: 'invalid', error: 'userId or deviceId and a valid sha256 are required' };
  }
  const ref = userId && deviceId
    ? db.prepare('SELECT * FROM cloud_file_refs_v2 WHERE user_id = ? AND device_id = ? AND sha256 = ? LIMIT 1').get(userId, deviceId, sha256)
    : userId
      ? db.prepare('SELECT * FROM cloud_file_refs_v2 WHERE user_id = ? AND sha256 = ? LIMIT 1').get(userId, sha256)
      : db.prepare('SELECT * FROM cloud_file_refs_v2 WHERE device_id = ? AND sha256 = ? LIMIT 1').get(deviceId, sha256);
  const object = ref ? db.prepare('SELECT * FROM file_objects WHERE sha256 = ?').get(sha256) : null;
  if (!ref || !object || !fs.existsSync(object.storage_path)) return { status: 'not_found', sha256 };
  return { status: 'ok', storagePath: object.storage_path, filename: ref.original_name || sha256 };
}

function payloadFromRow(row = {}) {
  try {
    return JSON.parse(row.payload_json || '{}');
  } catch {
    return {};
  }
}

function fileRefPayload(row = {}) {
  const payload = payloadFromRow(row);
  return {
    ...payload,
    id: payload.id || row.id,
    sha256: payload.sha256 || row.sha256,
    userId: payload.userId || row.user_id,
    deviceId: row.device_id,
    projectId: payload.projectId || row.project_id,
    conversationId: payload.conversationId || row.conversation_id,
    messageId: payload.messageId || row.message_id,
    relationType: payload.relationType || row.relation_type,
    sourceKind: payload.sourceKind || row.source_kind,
    originalName: payload.originalName || row.original_name,
    contentType: payload.contentType || row.content_type,
    sizeBytes: Number(payload.sizeBytes || row.size_bytes || 0),
  };
}

function normalizeUploadedLocalPath(value) {
  const text = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!text || text.startsWith('/') || /^[A-Za-z]:\//.test(text)) return '';
  const normalized = path.posix.normalize(text);
  return normalized === '..' || normalized.startsWith('../') ? '' : normalized;
}

function stableServerId(prefix, ...parts) {
  const digest = crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
  return `${prefix}_${digest.slice(0, 40)}`;
}


export {
  ensureLegacyPrivateThreadRoutingColumns,
  ensureLegacyCollaborationMessageSourceColumn,
  applySyncMigrations,
  cleanupLegacyDepartmentCloudData,
  payloadDepartmentId,
  payloadContainsLegacyDepartment,
  legacyPayloadSql,
  applySyncMigration,
  backfillLegacyFileRefs,
  backfillLegacyBatch,
  upsertLegacyFileRef,
  buildLegacyFileIndex,
  appendLegacyIndex,
  legacyFileForAttachment,
  uniqueLegacyFiles,
  legacyArtifactFileAttachments,
  sanitizeLegacyMessageContent,
  parseLegacyArtifact,
  sanitizeLegacyCloudValue,
  recordBatch,
  identitySnapshot,
  personalEvolutionSnapshot,
  decidePersonalEvolution,
  upsertProjectV2,
  upsertConversationV2,
  purgeConversationFiles,
  purgeCloudConversationData,
  cloudConversationExists,
  upsertMessageV2,
  upsertTranscriptV2,
  upsertModelExecutionV2,
  upsertFileRefV2,
  upsertRows,
  traceFile,
  traceConversation,
  conversationContext,
  storedFileForUser,
  payloadFromRow,
  fileRefPayload,
  normalizeUploadedLocalPath,
  stableServerId,
};
