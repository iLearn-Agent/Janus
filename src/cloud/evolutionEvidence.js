import { DatabaseSync } from 'node:sqlite';

export function importCloudEvolutionEvidence({ cloudDbPath, runtimeDb } = {}) {
  const cloud = new DatabaseSync(cloudDbPath, { readOnly: true });
  const conversationRows = cloud.prepare(
    `SELECT user_id, device_id, id, title, department_id, agent_id, status, payload_json, created_at, updated_at
     FROM cloud_conversations_v2 ORDER BY created_at ASC`,
  ).all();
  const messageRows = cloud.prepare(
    `SELECT user_id, device_id, id, conversation_id, role, content, payload_json, created_at
     FROM cloud_messages_v2 ORDER BY created_at ASC`,
  ).all();
  const hasModelExecutions = cloud.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'cloud_model_executions_v2'").get()?.count;
  const executionRows = hasModelExecutions
    ? cloud.prepare('SELECT * FROM cloud_model_executions_v2 ORDER BY started_at ASC').all()
    : [];
  const identityRows = readIdentityRows(cloud);
  const identityAliasMap = new Map(identityRows.aliases.map((row) => [`${row.user_id}\0${row.alias_instance_id}`, row.canonical_instance_id]));
  cloud.close();

  const upsertSession = runtimeDb.prepare(
    `INSERT INTO sessions (
      id, user_id, title, department_id, agent_id, project_id, workspace_root,
      agent_instance_id, codex_thread_id, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, '', '', ?, '', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       department_id = excluded.department_id,
       agent_id = excluded.agent_id,
       agent_instance_id = excluded.agent_instance_id,
       status = excluded.status,
       updated_at = excluded.updated_at`,
  );
  const upsertMessage = runtimeDb.prepare(
    `INSERT INTO messages (
      id, session_id, role, content, agent_id, agent_instance_id, department_id, visible, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       content = excluded.content,
       agent_id = excluded.agent_id,
       agent_instance_id = excluded.agent_instance_id,
       department_id = excluded.department_id,
       visible = excluded.visible,
       metadata_json = excluded.metadata_json`,
  );
  const sessionMap = new Map();
  const upsertExecution = runtimeDb.prepare(
    `INSERT INTO model_executions (
      id, user_id, project_id, conversation_id, request_message_id, response_message_id,
      task_run_id, task_node_id, department_id, agent_id, agent_role, execution_kind,
      agent_instance_id, agent_version_id, personal_skill_version_id,
      provider_id, requested_model, effective_model, reasoning_effort, model_source,
      codex_thread_id, codex_turn_id, skill_hash, memory_hash, memory_manifest_hash, organization_version,
      status, error_text, metadata_json, started_at, completed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
      response_message_id = excluded.response_message_id,
      effective_model = excluded.effective_model,
      reasoning_effort = excluded.reasoning_effort,
      status = excluded.status,
      metadata_json = excluded.metadata_json,
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at`,
  );
  runtimeDb.exec('BEGIN IMMEDIATE');
  try {
    for (const row of conversationRows) {
      const id = cloudScopedId(row.user_id, row.device_id, row.id);
      const payload = safeJson(row.payload_json);
      const rawAgentInstanceId = payload.agentInstanceId || payload.agent_instance_id || '';
      const agentInstanceId = identityAliasMap.get(`${row.user_id}\0${rawAgentInstanceId}`) || rawAgentInstanceId;
      sessionMap.set(`${row.user_id}\0${row.device_id}\0${row.id}`, {
        id,
        agentId: row.agent_id || payload.agentId || '',
        agentInstanceId,
        departmentId: row.department_id || payload.departmentId || '',
      });
      upsertSession.run(
        id,
        row.user_id || 'cloud_user',
        row.title || payload.title || 'Cloud conversation',
        row.department_id || payload.departmentId || '',
        row.agent_id || payload.agentId || '',
        agentInstanceId,
        normalizeStatus(row.status),
        row.created_at || new Date().toISOString(),
        row.updated_at || row.created_at || new Date().toISOString(),
      );
    }
    let importedMessages = 0;
    for (const row of messageRows) {
      const session = sessionMap.get(`${row.user_id}\0${row.device_id}\0${row.conversation_id}`);
      if (!session) continue;
      const payload = safeJson(row.payload_json);
      const visible = payload.visible !== false && !payload.private && !payload.sensitive;
      upsertMessage.run(
        cloudScopedId(row.user_id, row.device_id, row.id),
        session.id,
        normalizeRole(row.role),
        String(row.content || ''),
        payload.agentId || session.agentId || '',
        identityAliasMap.get(`${row.user_id}\0${payload.agentInstanceId || payload.agent_instance_id || ''}`)
          || payload.agentInstanceId || payload.agent_instance_id || session.agentInstanceId || '',
        payload.departmentId || session.departmentId || '',
        visible ? 1 : 0,
        JSON.stringify({
          ...(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
          cloudEvidence: true,
          cloudUserId: row.user_id,
          cloudDeviceId: row.device_id,
          originalMessageId: row.id,
        }),
        row.created_at || new Date().toISOString(),
      );
      importedMessages += 1;
    }
    for (const row of executionRows) {
      const payload = safeJson(row.payload_json);
      const session = sessionMap.get(`${row.user_id}\0${row.device_id}\0${row.conversation_id}`);
      upsertExecution.run(
        cloudScopedId(row.user_id, row.device_id, row.id),
        row.user_id || 'cloud_user',
        payload.projectId || row.project_id || '',
        session?.id || '',
        payload.requestMessageId ? cloudScopedId(row.user_id, row.device_id, payload.requestMessageId) : '',
        payload.responseMessageId ? cloudScopedId(row.user_id, row.device_id, payload.responseMessageId) : '',
        payload.taskRunId || row.task_run_id || '',
        payload.taskNodeId || row.task_node_id || '',
        payload.departmentId || row.department_id || '',
        payload.agentId || row.agent_id || '',
        payload.agentRole || 'agent',
        payload.executionKind || row.execution_kind || '',
        identityAliasMap.get(`${row.user_id}\0${payload.agentInstanceId || payload.agent_instance_id || ''}`)
          || payload.agentInstanceId || payload.agent_instance_id || '',
        payload.agentVersionId || payload.agent_version_id || '',
        payload.personalSkillVersionId || payload.personal_skill_version_id || '',
        payload.providerId || row.provider_id || '',
        payload.requestedModel || '',
        payload.effectiveModel || row.effective_model || '',
        payload.reasoningEffort || row.reasoning_effort || '',
        payload.modelSource || '',
        payload.codexThreadId || '',
        payload.codexTurnId || '',
        payload.skillHash || '',
        payload.memoryHash || '',
        payload.memoryManifestHash || payload.memory_manifest_hash || '',
        payload.organizationVersion || '',
        payload.status || row.status || '',
        payload.errorText || '',
        JSON.stringify({ ...(payload.metadata || {}), cloudEvidence: true, cloudDeviceId: row.device_id }),
        payload.startedAt || row.started_at || '',
        payload.completedAt || row.completed_at || '',
        payload.updatedAt || row.updated_at || row.completed_at || row.started_at || '',
      );
    }
    importIdentityRows(runtimeDb, identityRows);
    runtimeDb.exec('COMMIT');
    return {
      importedSessions: conversationRows.length,
      importedMessages,
      importedModelExecutions: executionRows.length,
      importedUserAgentInstances: identityRows.instances.length,
      importedMemoryDocuments: identityRows.memoryDocuments.length,
      importedMemoryDocumentVersions: identityRows.memoryVersions.length,
    };
  } catch (error) {
    runtimeDb.exec('ROLLBACK');
    throw error;
  }
}

function readIdentityRows(cloud) {
  const tableExists = (name) => Boolean(cloud.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  return {
    families: tableExists('cloud_agent_families_v3') ? cloud.prepare('SELECT * FROM cloud_agent_families_v3').all() : [],
    versions: tableExists('cloud_agent_versions_v3') ? cloud.prepare('SELECT * FROM cloud_agent_versions_v3').all() : [],
    instances: tableExists('cloud_user_agent_instances_v3') ? cloud.prepare('SELECT * FROM cloud_user_agent_instances_v3').all() : [],
    skillVersions: tableExists('cloud_user_agent_skill_versions_v3') ? cloud.prepare('SELECT * FROM cloud_user_agent_skill_versions_v3').all() : [],
    aliases: tableExists('cloud_user_agent_instance_aliases_v3') ? cloud.prepare('SELECT * FROM cloud_user_agent_instance_aliases_v3').all() : [],
    memoryAliases: tableExists('cloud_memory_document_aliases_v3') ? cloud.prepare('SELECT * FROM cloud_memory_document_aliases_v3').all() : [],
    memoryDocuments: tableExists('cloud_memory_documents_v3') ? cloud.prepare('SELECT * FROM cloud_memory_documents_v3').all() : [],
    memoryVersions: tableExists('cloud_memory_document_versions_v3') ? cloud.prepare('SELECT * FROM cloud_memory_document_versions_v3').all() : [],
  };
}

function importIdentityRows(runtimeDb, rows) {
  for (const userId of [...new Set((rows.instances || []).map((row) => String(row.user_id || '')).filter(Boolean))]) {
    runtimeDb.prepare(`INSERT INTO auth_users (
      id, email, display_name, username, remote_id, remote_bound_at, auth_provider, email_verified, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'cloud', 1, ?)
    ON CONFLICT(id) DO NOTHING`).run(
      userId,
      `${userId.replace(/[^a-zA-Z0-9._-]/g, '_')}@cloud-evidence.janus.local`,
      userId,
      userId.slice(0, 32),
      userId,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  }
  for (const row of rows.aliases) {
    runtimeDb.prepare(
      `INSERT INTO user_agent_instance_aliases (
        alias_instance_id, canonical_instance_id, user_id, reason, created_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(alias_instance_id) DO UPDATE SET
        canonical_instance_id = excluded.canonical_instance_id,
        user_id = excluded.user_id,
        reason = excluded.reason`,
    ).run(row.alias_instance_id, row.canonical_instance_id, row.user_id, row.reason || '', row.created_at || '');
  }
  for (const row of rows.memoryAliases || []) {
    runtimeDb.prepare(
      `INSERT INTO memory_document_aliases (
        alias_document_id, canonical_document_id, user_id, reason, created_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(alias_document_id) DO UPDATE SET
        canonical_document_id = excluded.canonical_document_id,
        user_id = excluded.user_id,
        reason = excluded.reason`,
    ).run(row.alias_document_id, row.canonical_document_id, row.user_id, row.reason || '', row.created_at || '');
  }
  for (const row of rows.families) {
    const payload = safeJson(row.payload_json);
    runtimeDb.prepare(
      `INSERT INTO agent_families (
        id, department_id, name, role, status, routable, current_version_id, metadata_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      row.id,
      row.department_id || '',
      row.name || row.id,
      row.role || 'agent',
      row.status || 'active',
      Number(row.routable || 0),
      row.current_version_id || '',
      JSON.stringify(payload.metadata || {}),
      row.updated_at || '',
    );
  }
  for (const row of rows.versions) {
    const payload = safeJson(row.payload_json);
    runtimeDb.prepare(
      `INSERT INTO agent_versions (
        id, agent_family_id, version_label, agent_config_json, base_skill_content,
        base_skill_hash, memory_template_content, memory_template_hash,
        source_bundle_id, content_hash, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      row.id,
      row.agent_family_id,
      payload.version_label || payload.versionLabel || '',
      payload.agent_config_json || JSON.stringify(payload.agentConfig || {}),
      payload.base_skill_content || payload.baseSkillContent || '',
      payload.base_skill_hash || payload.baseSkillHash || '',
      payload.memory_template_content || payload.memoryTemplateContent || '',
      payload.memory_template_hash || payload.memoryTemplateHash || '',
      payload.source_bundle_id || payload.sourceBundleId || '',
      row.content_hash || payload.content_hash || '',
      payload.status || 'active',
      row.created_at || '',
    );
  }
  for (const row of rows.instances) {
    const payload = safeJson(row.payload_json);
    runtimeDb.prepare(
      `INSERT INTO user_agent_instances (
        id, user_id, agent_family_id, base_agent_version_id,
        active_personal_skill_version_id, status, instance_kind, employment_state, quota_exempt,
        recruited_at, deactivated_at, last_state_changed_at, state_revision, recruitment_source, policy_version,
        sync_enabled, personal_evolution_consent, cluster_contribution_consent, personal_skill_auto_activate,
        family_instance_seq, display_name, note, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        agent_family_id = excluded.agent_family_id,
        base_agent_version_id = excluded.base_agent_version_id,
        active_personal_skill_version_id = excluded.active_personal_skill_version_id,
        status = excluded.status,
        instance_kind = excluded.instance_kind,
        employment_state = excluded.employment_state,
        quota_exempt = excluded.quota_exempt,
        recruited_at = excluded.recruited_at,
        deactivated_at = excluded.deactivated_at,
        last_state_changed_at = excluded.last_state_changed_at,
        state_revision = excluded.state_revision,
        recruitment_source = excluded.recruitment_source,
        policy_version = excluded.policy_version,
        sync_enabled = excluded.sync_enabled,
        personal_evolution_consent = excluded.personal_evolution_consent,
        cluster_contribution_consent = excluded.cluster_contribution_consent,
        personal_skill_auto_activate = excluded.personal_skill_auto_activate,
        family_instance_seq = excluded.family_instance_seq,
        display_name = excluded.display_name,
        note = excluded.note,
        updated_at = excluded.updated_at`,
    ).run(
      row.id,
      row.user_id,
      row.agent_family_id,
      row.base_agent_version_id || '',
      row.active_personal_skill_version_id || '',
      row.status || 'active',
      row.instance_kind || payload.instanceKind || 'employee',
      row.employment_state || payload.employmentState || row.status || 'active',
      Number(row.quota_exempt ?? payload.quotaExempt ?? 0),
      row.recruited_at || payload.recruitedAt || row.created_at || '',
      row.deactivated_at || payload.deactivatedAt || '',
      row.last_state_changed_at || payload.lastStateChangedAt || row.updated_at || row.created_at || '',
      Number(row.state_revision ?? payload.stateRevision ?? 1),
      row.recruitment_source || payload.recruitmentSource || 'migration',
      row.policy_version || payload.policyVersion || 'employee_cloud_authority_v1',
      Number(row.sync_enabled ?? 1),
      Number(row.personal_evolution_consent || 0),
      Number(row.cluster_contribution_consent || 0),
      Number(row.personal_skill_auto_activate || 0),
      Number(payload.familyInstanceSeq || payload.family_instance_seq || 0),
      payload.displayName || payload.display_name || '',
      payload.note || '',
      row.created_at || '',
      row.updated_at || '',
    );
  }
  for (const row of rows.skillVersions) {
    const payload = safeJson(row.payload_json);
    runtimeDb.prepare(
      `INSERT INTO user_agent_skill_versions (
        id, user_agent_instance_id, base_agent_version_id, parent_version_id,
        overlay_text, effective_skill_content, effective_skill_hash, compiler_version, authority, status,
        source_evolution_run_id, activated_at, archived_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      row.id,
      row.user_agent_instance_id,
      row.base_agent_version_id || '',
      payload.parent_version_id || '',
      payload.overlay_text || '',
      payload.effective_skill_content || '',
      payload.effective_skill_hash || '',
      payload.compiler_version || 'overlay_concat_v1',
      row.authority || payload.authority || 'cloud',
      row.status || 'candidate',
      payload.source_evolution_run_id || '',
      row.activated_at || payload.activated_at || '',
      payload.archived_at || '',
      row.created_at || '',
      row.updated_at || payload.updated_at || row.created_at || '',
    );
  }
  for (const row of rows.memoryDocuments) {
    const payload = safeJson(row.payload_json);
    runtimeDb.prepare(
      `INSERT INTO memory_documents (
        id, user_id, user_agent_instance_id, scope, slot_no, display_name,
        task_run_id, project_id, relationship_id, context_space_id,
        work_scope_id,
        lifecycle_state, visibility, sync_enabled, allow_personal_evolution,
        allow_cluster_evolution, current_version_id, content_hash, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        current_version_id = excluded.current_version_id,
        content_hash = excluded.content_hash,
        lifecycle_state = excluded.lifecycle_state,
        sync_enabled = excluded.sync_enabled,
        allow_personal_evolution = excluded.allow_personal_evolution,
        allow_cluster_evolution = excluded.allow_cluster_evolution,
        updated_at = excluded.updated_at`,
    ).run(
      row.id,
      row.user_id,
      row.user_agent_instance_id,
      row.scope || 'general',
      Number(row.slot_no || 0),
      payload.display_name || payload.displayName || 'memory0',
      payload.task_run_id || '',
      payload.project_id || '',
      payload.relationship_id || '',
      payload.context_space_id || '',
      payload.work_scope_id || (row.scope === 'task' && payload.task_run_id ? `task:${payload.task_run_id}` : ''),
      row.lifecycle_state || 'active',
      payload.visibility || 'private',
      Number(row.sync_enabled ?? 1),
      Number(row.allow_personal_evolution || 0),
      Number(row.allow_cluster_evolution || 0),
      row.current_version_id || '',
      payload.content_hash || '',
      row.created_at || '',
      row.updated_at || '',
    );
  }
  for (const row of rows.memoryVersions) {
    const payload = safeJson(row.payload_json);
    runtimeDb.prepare(
      `INSERT INTO memory_document_versions (
        id, memory_document_id, version_no, content, content_hash, source_kind,
        source_id, privacy_level, review_status, created_by, origin_document_id,
        origin_version_no,encryption_algorithm,encryption_key_id,encryption_key_version,
        content_ciphertext,content_nonce,content_tag,content_aad,created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      row.id,
      row.memory_document_id,
      Number(row.version_no || 1),
      payload.content || '',
      row.content_hash || payload.content_hash || '',
      payload.source_kind || '',
      payload.source_id || '',
      payload.privacy_level || 'private',
      payload.review_status || 'unreviewed',
      payload.created_by || '',
      payload.origin_document_id || row.memory_document_id,
      Number(payload.origin_version_no || row.version_no || 1),
      payload.encryption_algorithm || '',
      payload.encryption_key_id || '',
      Number(payload.encryption_key_version || 0),
      payload.content_ciphertext || '',
      payload.content_nonce || '',
      payload.content_tag || '',
      payload.content_aad || '',
      row.created_at || '',
    );
  }
}

function cloudScopedId(userId, deviceId, id) {
  return `cloud:${userId || 'user'}:${deviceId || 'device'}:${id || 'unknown'}`;
}

function normalizeStatus(value) {
  return ['active', 'archived', 'deleted'].includes(value) ? value : 'active';
}

function normalizeRole(value) {
  return ['user', 'assistant', 'system', 'tool'].includes(value) ? value : 'user';
}

function safeJson(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}
