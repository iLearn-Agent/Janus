import crypto from 'node:crypto';

export const DATABASE_PRESERVATION_COUNT_KEYS = Object.freeze([
  'sessions', 'messages', 'users', 'agentInstances', 'memoryDocuments', 'memoryVersions',
  'attachments', 'taskRuns', 'taskNodes', 'modelExecutions', 'fileRefs',
  'profileUpdateOutbox',
  'chatGroups', 'chatGroupMembers', 'chatGroupMessages', 'chatGroupMessageReceipts', 'chatGroupOutbox',
  'socialConversationPreferences', 'socialConversationPreferenceOutbox',
  'socialInboxPreferences', 'socialInboxPreferenceOutbox',
  'uBuddyCapabilityProfileCache', 'uBuddyCapabilityProfilePublicationOutbox',
  'uBuddyCapabilityProfiles',
  'workspaceStartupPreferences', 'agentWorkReservations', 'ubuddyAgentWaitRequests',
  'ubuddyPlanningJobs', 'ubuddyPlanningSessions', 'ubuddyPlanningSessionEvents', 'ubuddyDispatchCommands', 'agentDelegations',
  'taskDeliveryReviews', 'taskDeliverySubmissions', 'taskDeliveryReviewEvents', 'taskDeliveryReviewJobs',
  'accounts', 'accountMemberships', 'accountWorkspaceBindings', 'authPrincipals',
  'socialMessages', 'socialDirectConversations', 'conversationAccountBindings', 'accountAgentInstances',
]);

const countTables = Object.freeze({
  sessions: 'sessions',
  messages: 'messages',
  users: 'auth_users',
  agentInstances: 'user_agent_instances',
  memoryDocuments: 'memory_documents',
  memoryVersions: 'memory_document_versions',
  attachments: 'message_attachments',
  taskRuns: 'task_runs',
  taskNodes: 'task_nodes',
  modelExecutions: 'model_executions',
  fileRefs: 'cloud_file_refs',
  profileUpdateOutbox: 'profile_update_outbox',
  chatGroups: 'chat_groups',
  chatGroupMembers: 'chat_group_members',
  chatGroupMessages: 'chat_group_messages',
  chatGroupMessageReceipts: 'chat_group_message_receipts',
  chatGroupOutbox: 'chat_group_outbox',
  socialConversationPreferences: 'social_conversation_preferences',
  socialConversationPreferenceOutbox: 'social_conversation_preference_outbox',
  socialInboxPreferences: 'social_inbox_preferences',
  socialInboxPreferenceOutbox: 'social_inbox_preference_outbox',
  uBuddyCapabilityProfileCache: 'ubuddy_capability_profile_cache',
  uBuddyCapabilityProfilePublicationOutbox: 'ubuddy_capability_profile_publication_outbox',
  uBuddyCapabilityProfiles: 'ubuddy_capability_profiles',
  workspaceStartupPreferences: 'account_workspace_startup_preferences',
  agentWorkReservations: 'agent_work_reservations',
  ubuddyAgentWaitRequests: 'ubuddy_agent_wait_requests',
  ubuddyPlanningJobs: 'ubuddy_planning_jobs',
  ubuddyPlanningSessions: 'ubuddy_planning_sessions',
  ubuddyPlanningSessionEvents: 'ubuddy_planning_session_events',
  ubuddyDispatchCommands: 'ubuddy_dispatch_commands',
  agentDelegations: 'agent_delegations',
  taskDeliveryReviews: 'task_delivery_reviews',
  taskDeliverySubmissions: 'task_delivery_submissions',
  taskDeliveryReviewEvents: 'task_delivery_review_events',
  taskDeliveryReviewJobs: 'task_delivery_review_jobs',
  accounts: 'accounts',
  accountMemberships: 'account_memberships',
  accountWorkspaceBindings: 'account_workspace_bindings',
  authPrincipals: 'auth_principals',
  socialMessages: 'social_messages',
  socialDirectConversations: 'social_direct_conversations',
  conversationAccountBindings: 'conversation_account_bindings',
  accountAgentInstances: 'account_agent_instances',
});

const PRIVATE_AGENT_DELEGATION_METADATA_KEYS = new Set([
  'preliminaryResult', 'intakeSummary', 'threadId', 'answerMessageId', 'sessionId', 'workspaceSessionId',
  'taskWorkspaceRoot', 'generatedTaskFiles', 'ownerConfirmationRequired', 'safePreparationOnly',
  'specializedExecutionError', 'recoveryExecutionError', 'deterministicRecovery',
  'workspaceUpdatedAt', 'workspaceExecutionError', 'workspaceExecutionFailedAt', 'workspaceRevisionRecovered',
  'ubuddyTeamCoordination', 'workspaceEpoch', 'workspaceRepairedAt', 'previousWorkspaceSessionId',
  'activeTaskRunId', 'attemptTaskRunIds', 'executionFailureDetail', 'syncState', 'syncError',
  'pendingRemoteUpdate', 'pendingWorkspaceSync', 'pendingSharedWorkspaceSync', 'sharedWorkspaceSyncError',
]);

export function collectDatabaseInventory(db, { includeContentFingerprints = false } = {}) {
  const inventory = Object.fromEntries(Object.entries(countTables).map(([key, table]) => [key, tableCount(db, table)]));
  inventory.messageFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'messages', ['id', 'role', 'content', 'created_at']) : null;
  inventory.socialMessageFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'social_messages', [
      'id', 'account_workspace_id', 'sender_user_id', 'recipient_user_id', 'sender_agent_id', 'recipient_agent_id',
      'kind', 'title', 'content', 'status', 'delivery_status', 'remote_id', 'metadata_json', 'created_at', 'updated_at', 'read_at',
    ]) : null;
  inventory.attachmentFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'message_attachments', ['id', 'message_id', 'name', 'content_type', 'size_bytes', 'sha256']) : null;
  inventory.profileUpdateOutboxFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'profile_update_outbox', [
      'user_id', 'command_id', 'payload_hash', 'payload_json', 'status', 'attempt_count', 'next_attempt_at',
      'last_error', 'created_at', 'updated_at', 'completed_at',
    ], ['user_id']) : null;
  inventory.chatGroupFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'chat_groups', [
      'id', 'account_workspace_id', 'organization_id', 'owner_user_id', 'title', 'scope_type', 'chat_mode',
      'binding_type', 'binding_id', 'history_visibility', 'status', 'audience_scope', 'client_request_id', 'metadata_json',
      'created_at', 'updated_at', 'dissolved_at',
    ]) : null;
  inventory.chatGroupMemberFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'chat_group_members', [
      'group_id', 'user_id', 'role', 'status', 'invited_by_user_id', 'joined_at', 'left_at', 'last_read_at',
    ], ['group_id', 'user_id']) : null;
  inventory.chatGroupMessageFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'chat_group_messages', [
      'id', 'account_workspace_id', 'group_id', 'sender_user_id', 'sender_agent_id', 'kind', 'content',
      'metadata_json', 'source_event_id', 'created_at', 'updated_at',
    ]) : null;
  inventory.chatGroupMessageReceiptFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'chat_group_message_receipts', [
      'message_id', 'group_id', 'recipient_user_id', 'read_at', 'created_at', 'updated_at',
    ], ['message_id', 'recipient_user_id']) : null;
  inventory.chatGroupOutboxFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'chat_group_outbox', [
      'id', 'account_workspace_id', 'operation_kind', 'aggregate_id', 'idempotency_key', 'payload_hash',
      'payload_json', 'status', 'attempt_count', 'next_attempt_at', 'last_error', 'created_at', 'updated_at',
      'completed_at',
    ]) : null;
  inventory.socialConversationPreferenceFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'social_conversation_preferences', [
      'account_workspace_id', 'user_id', 'conversation_kind', 'conversation_id', 'archived', 'state_revision',
      'base_state_revision', 'last_command_id', 'source_device_id', 'sync_status', 'created_at', 'updated_at',
    ], ['account_workspace_id', 'user_id', 'conversation_kind', 'conversation_id']) : null;
  inventory.socialConversationPreferenceOutboxFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'social_conversation_preference_outbox', [
      'id', 'account_workspace_id', 'user_id', 'conversation_kind', 'conversation_id', 'command_id', 'payload_hash',
      'payload_json', 'status', 'attempt_count', 'next_attempt_at', 'last_error', 'created_at', 'updated_at', 'completed_at',
    ]) : null;
  inventory.uBuddyCapabilityProfileCacheFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'ubuddy_capability_profile_cache', [
      'viewer_user_id', 'server_origin_hash', 'owner_remote_user_id', 'owner_local_user_id',
      'ubuddy_agent_instance_id', 'profile_revision', 'profile_version', 'visibility', 'content_hash',
      'profile_json', 'access_scope', 'fetched_at', 'expires_at', 'updated_at',
    ], ['viewer_user_id', 'server_origin_hash', 'owner_remote_user_id']) : null;
  inventory.uBuddyCapabilityProfilePublicationOutboxFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'ubuddy_capability_profile_publication_outbox', [
      'id', 'owner_user_id', 'profile_revision', 'command_id', 'operation_kind',
      'expected_cloud_state_revision', 'payload_hash', 'payload_json', 'status', 'attempt_count',
      'next_attempt_at', 'last_error', 'created_at', 'updated_at', 'completed_at',
    ]) : null;
  inventory.uBuddyCapabilityProfileFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'ubuddy_capability_profiles', [
      'owner_user_id', 'ubuddy_agent_instance_id', 'profile_revision', 'source_effective_skill_hash',
      'profile_version', 'publication_state', 'generation_status', 'generation_trigger', 'profile_json',
      'content_hash', 'validation_json', 'capability_scope_json', 'capability_scope_hash', 'privacy_risk_json',
      'requires_user_confirmation', 'confirmation_reason', 'user_confirmed_at', 'generation_error',
      'generated_at', 'validated_at', 'activated_at', 'archived_at', 'rejected_at', 'created_at', 'updated_at',
    ], ['owner_user_id', 'ubuddy_agent_instance_id', 'profile_revision']) : null;
  inventory.workspaceStartupPreferenceFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'account_workspace_startup_preferences', [
      'user_id', 'device_id', 'startup_workspace_id', 'updated_at',
    ], ['user_id', 'device_id']) : null;
  inventory.agentWorkReservationFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'agent_work_reservations', [
      'id', 'account_workspace_id', 'owner_user_id', 'task_run_id', 'agent_instance_id', 'agent_family_id',
      'status', 'metadata_json', 'reserved_at', 'updated_at', 'released_at', 'release_reason',
    ]) : null;
  inventory.ubuddyAgentWaitRequestFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'ubuddy_agent_wait_requests', [
      'id', 'account_workspace_id', 'owner_user_id', 'task_run_id', 'allocation_key', 'agent_family_id',
      'department_id', 'preferred_agent_instance_id', 'candidate_instance_ids_json', 'task_node_ids_json',
      'requirements_json', 'leader_slot', 'priority', 'status', 'reservation_id', 'matched_agent_instance_id',
      'wait_reason', 'created_at', 'updated_at', 'matched_at', 'cancelled_at',
    ]) : null;
  inventory.ubuddyPlanningJobFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'ubuddy_planning_jobs', [
      'id', 'task_run_id', 'account_workspace_id', 'owner_user_id', 'source_session_id', 'status',
      'idempotency_key', 'payload_json', 'result_json', 'attempt_count', 'max_attempts', 'claimed_by',
      'claimed_at', 'lease_expires_at', 'next_attempt_at', 'last_error', 'created_at', 'updated_at',
      'completed_at', 'cancelled_at',
    ]) : null;
  inventory.ubuddyPlanningSessionFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'ubuddy_planning_sessions', [
      'id', 'owner_user_id', 'account_workspace_id', 'source_session_id', 'source_message_id',
      'codex_thread_id', 'thread_epoch', 'revision', 'status', 'engine_version', 'model_config_json',
      'plan_json', 'dispatch_json', 'last_error_json', 'created_at', 'updated_at',
    ]) : null;
  inventory.ubuddyPlanningSessionEventFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'ubuddy_planning_session_events', [
      'id', 'planning_session_id', 'idempotency_key', 'event_type', 'base_revision', 'result_revision',
      'payload_json', 'created_at',
    ]) : null;
  inventory.ubuddyDispatchCommandFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'ubuddy_dispatch_commands', [
      'command_id', 'account_workspace_id', 'owner_user_id', 'source_session_id', 'source_message_id',
      'command_version', 'status', 'payload_hash', 'command_json', 'result_json', 'attempt_count', 'max_attempts',
      'claimed_at', 'lease_expires_at', 'next_attempt_at', 'last_error', 'created_at', 'updated_at', 'completed_at',
    ], ['command_id']) : null;
  inventory.sessionReferenceRecords = includeContentFingerprints ? collectSessionReferenceRecords(db) : null;
  inventory.agentDelegationRecords = includeContentFingerprints ? collectAgentDelegationRecords(db) : null;
  inventory.taskDeliveryReviewFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'task_delivery_reviews', [
      'task_run_id', 'account_workspace_id', 'owner_user_id', 'policy_version', 'state',
      'quality_revision_count', 'quality_revision_limit', 'execution_attempt_count', 'latest_submission_id',
      'latest_feedback_json', 'last_review_event_id', 'created_at', 'updated_at', 'terminal_at',
    ], ['task_run_id']) : null;
  inventory.taskDeliverySubmissionFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'task_delivery_submissions', [
      'id', 'task_run_id', 'task_node_id', 'result_version_id', 'submission_key', 'submission_no',
      'body_snapshot', 'evidence_json', 'artifact_manifest_json', 'created_at',
    ]) : null;
  inventory.taskDeliveryReviewEventFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'task_delivery_review_events', [
      'event_id', 'task_run_id', 'submission_id', 'event_type', 'from_state', 'to_state',
      'payload_hash', 'payload_json', 'created_at',
    ], ['event_id']) : null;
  inventory.taskDeliveryReviewJobFingerprints = includeContentFingerprints
    ? recordFingerprints(db, 'task_delivery_review_jobs', [
      'id', 'task_run_id', 'submission_id', 'idempotency_key', 'status', 'payload_json', 'attempt_count',
      'max_attempts', 'claimed_by', 'claimed_at', 'lease_expires_at', 'next_attempt_at', 'last_error',
      'created_at', 'updated_at', 'completed_at',
    ]) : null;
  return inventory;
}

export function assertDatabaseInventoryPreserved(before = {}, after = {}) {
  for (const key of DATABASE_PRESERVATION_COUNT_KEYS) {
    if (Number(after[key] || 0) < Number(before[key] || 0)) {
      throw new Error(`Database migration validation detected data loss in ${key}.`);
    }
  }
  assertFingerprintMapPreserved(before.messageFingerprints, after.messageFingerprints, 'chat message');
  assertFingerprintMapPreserved(before.socialMessageFingerprints, after.socialMessageFingerprints, 'social direct message');
  assertFingerprintMapPreserved(before.attachmentFingerprints, after.attachmentFingerprints, 'message attachment');
  assertFingerprintMapPreserved(before.profileUpdateOutboxFingerprints, after.profileUpdateOutboxFingerprints, 'profile update outbox record');
  assertFingerprintMapPreserved(before.chatGroupFingerprints, after.chatGroupFingerprints, 'chat group');
  assertFingerprintMapPreserved(before.chatGroupMemberFingerprints, after.chatGroupMemberFingerprints, 'chat group member');
  assertFingerprintMapPreserved(before.chatGroupMessageFingerprints, after.chatGroupMessageFingerprints, 'chat group message');
  assertFingerprintMapPreserved(before.chatGroupMessageReceiptFingerprints, after.chatGroupMessageReceiptFingerprints, 'chat group message receipt');
  assertFingerprintMapPreserved(before.chatGroupOutboxFingerprints, after.chatGroupOutboxFingerprints, 'chat group outbox record');
  assertFingerprintMapPreserved(before.socialConversationPreferenceFingerprints, after.socialConversationPreferenceFingerprints, 'social conversation preference');
  assertFingerprintMapPreserved(before.socialConversationPreferenceOutboxFingerprints, after.socialConversationPreferenceOutboxFingerprints, 'social conversation preference outbox record');
  assertFingerprintMapPreserved(before.uBuddyCapabilityProfileCacheFingerprints, after.uBuddyCapabilityProfileCacheFingerprints, 'uBuddy capability Profile cache record');
  assertFingerprintMapPreserved(before.uBuddyCapabilityProfilePublicationOutboxFingerprints, after.uBuddyCapabilityProfilePublicationOutboxFingerprints, 'uBuddy capability Profile publication outbox record');
  assertFingerprintMapPreserved(before.uBuddyCapabilityProfileFingerprints, after.uBuddyCapabilityProfileFingerprints, 'owned uBuddy capability Profile revision');
  assertFingerprintMapPreserved(before.workspaceStartupPreferenceFingerprints, after.workspaceStartupPreferenceFingerprints, 'workspace startup preference');
  assertFingerprintMapPreserved(before.agentWorkReservationFingerprints, after.agentWorkReservationFingerprints, 'Agent work reservation');
  assertFingerprintMapPreserved(before.ubuddyAgentWaitRequestFingerprints, after.ubuddyAgentWaitRequestFingerprints, 'uBuddy Agent wait request');
  assertFingerprintMapPreserved(before.ubuddyPlanningJobFingerprints, after.ubuddyPlanningJobFingerprints, 'uBuddy planning job');
  assertFingerprintMapPreserved(before.ubuddyPlanningSessionFingerprints, after.ubuddyPlanningSessionFingerprints, 'uBuddy planning session');
  assertFingerprintMapPreserved(before.ubuddyPlanningSessionEventFingerprints, after.ubuddyPlanningSessionEventFingerprints, 'uBuddy planning session event');
  assertFingerprintMapPreserved(before.ubuddyDispatchCommandFingerprints, after.ubuddyDispatchCommandFingerprints, 'uBuddy dispatch command');
  assertAgentDelegationsPreserved(
    before.agentDelegationRecords,
    after.agentDelegationRecords,
    after.sessionReferenceRecords,
  );
  assertFingerprintMapPreserved(before.taskDeliveryReviewFingerprints, after.taskDeliveryReviewFingerprints, 'task delivery review');
  assertFingerprintMapPreserved(before.taskDeliverySubmissionFingerprints, after.taskDeliverySubmissionFingerprints, 'task delivery submission');
  assertFingerprintMapPreserved(before.taskDeliveryReviewEventFingerprints, after.taskDeliveryReviewEventFingerprints, 'task delivery review event');
  assertFingerprintMapPreserved(before.taskDeliveryReviewJobFingerprints, after.taskDeliveryReviewJobFingerprints, 'task delivery review job');
  return true;
}

export function publicDatabaseInventory(value = {}) {
  return Object.fromEntries(DATABASE_PRESERVATION_COUNT_KEYS.map((key) => [key, Number(value[key] || 0)]));
}

function tableCount(db, table) {
  if (!tableExists(db, table)) return 0;
  return Number(db.prepare(`SELECT COUNT(*) count FROM "${table}"`).get()?.count || 0);
}

function recordFingerprints(db, table, requestedColumns, requestedIdentityColumns = ['id']) {
  if (!tableExists(db, table)) return new Map();
  const columns = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => String(row.name || '')));
  const selected = requestedColumns.filter((column) => columns.has(column));
  const identityColumns = requestedIdentityColumns.filter((column) => columns.has(column));
  if (identityColumns.length !== requestedIdentityColumns.length) return new Map();
  const quoted = selected.map((column) => `"${column}"`).join(',');
  const orderBy = identityColumns.map((column) => `"${column}"`).join(',');
  const result = new Map();
  for (const row of db.prepare(`SELECT ${quoted} FROM "${table}" ORDER BY ${orderBy}`).iterate()) {
    const serialized = JSON.stringify(selected.map((column) => row[column]));
    const identity = JSON.stringify(identityColumns.map((column) => row[column]));
    result.set(identity, crypto.createHash('sha256').update(serialized).digest('hex'));
  }
  return result;
}

function collectAgentDelegationRecords(db) {
  if (!tableExists(db, 'agent_delegations')) return new Map();
  const requestedColumns = [
    'id', 'account_workspace_id', 'requester_user_id', 'recipient_user_id', 'sender_agent_id', 'recipient_agent_id',
    'title', 'instruction', 'status', 'session_id', 'task_run_id', 'group_id', 'metadata_json', 'last_error',
    'created_at', 'updated_at', 'started_at', 'completed_at',
  ];
  const columns = new Set(db.prepare('PRAGMA table_info(agent_delegations)').all().map((row) => String(row.name || '')));
  const selected = requestedColumns.filter((column) => columns.has(column));
  const rows = db.prepare(`SELECT ${selected.map((column) => `"${column}"`).join(',')} FROM agent_delegations ORDER BY id`).all();
  const hasWorkspaces = tableExists(db, 'agent_delegation_workspaces');
  const hasSessions = tableExists(db, 'sessions');
  const records = new Map();
  for (const row of rows) {
    const id = String(row.id || '');
    const recipientUserId = String(row.recipient_user_id || '');
    const workspace = hasWorkspaces
      ? db.prepare(`SELECT session_id,metadata_json FROM agent_delegation_workspaces
        WHERE delegation_id=? AND user_id=?`).get(id, recipientUserId)
      : null;
    const sessionId = String(row.session_id || '');
    const session = hasSessions && sessionId
      ? db.prepare(`SELECT id,user_id,account_workspace_id,agent_instance_id,conversation_id,department_id,
          superseded_by_session_id,status FROM sessions WHERE id=?`).get(sessionId)
      : null;
    records.set(id, {
      row: { ...row },
      metadata: safeJsonObject(row.metadata_json),
      workspace: workspace ? { ...workspace, metadata: safeJsonObject(workspace.metadata_json) } : null,
      session: session ? { ...session } : null,
    });
  }
  return records;
}

function collectSessionReferenceRecords(db) {
  if (!tableExists(db, 'sessions')) return new Map();
  const requestedColumns = [
    'id', 'user_id', 'account_workspace_id', 'agent_instance_id', 'conversation_id', 'department_id',
    'conversation_role', 'write_state', 'superseded_by_session_id', 'status',
  ];
  const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((row) => String(row.name || '')));
  const selected = requestedColumns.filter((column) => columns.has(column));
  if (!selected.includes('id')) return new Map();
  return new Map(db.prepare(`SELECT ${selected.map((column) => `"${column}"`).join(',')} FROM sessions ORDER BY id`).all()
    .map((row) => [String(row.id || ''), { ...row }]));
}

function assertAgentDelegationsPreserved(before, after, afterSessions) {
  if (!(before instanceof Map) || !(after instanceof Map)) return;
  const immutableColumns = [
    'account_workspace_id', 'requester_user_id', 'recipient_user_id', 'sender_agent_id', 'recipient_agent_id',
    'title', 'instruction', 'status', 'task_run_id', 'group_id', 'last_error',
    'created_at', 'updated_at', 'started_at', 'completed_at',
  ];
  for (const [id, source] of before) {
    const target = after.get(id);
    if (!target) throw new Error('Database migration validation detected a missing agent delegation.');
    for (const column of immutableColumns) {
      if (!Object.hasOwn(source.row, column)) continue;
      if (source.row[column] !== target.row[column]) {
        throw new Error(`Database migration validation detected a changed agent delegation ${column}.`);
      }
    }
    assertAgentDelegationSessionPreserved(source, target, afterSessions);
    assertAgentDelegationMetadataPreserved(source, target);
  }
}

function assertAgentDelegationSessionPreserved(source, target, afterSessions) {
  if (!Object.hasOwn(source.row, 'session_id')) return;
  const sourceSessionId = String(source.row.session_id || '');
  const targetSessionId = String(target.row.session_id || '');
  if (sourceSessionId === targetSessionId) return;
  if (!sourceSessionId || !targetSessionId || !target.session) {
    throw new Error('Database migration validation detected an invalid agent delegation session rebind.');
  }
  const sourceSessionAfter = afterSessions instanceof Map ? afterSessions.get(sourceSessionId) : null;
  const superseded = String(sourceSessionAfter?.superseded_by_session_id || '') === targetSessionId
    && String(sourceSessionAfter?.conversation_role || '') === 'history'
    && String(sourceSessionAfter?.write_state || '') === 'read_only';
  const workspaceBound = String(target.workspace?.session_id || '') === targetSessionId
    && String(target.session?.department_id || '') === 'agent_delegation';
  if (!superseded && !workspaceBound) {
    throw new Error('Database migration validation detected an unproven agent delegation session rebind.');
  }
}

function assertAgentDelegationMetadataPreserved(source, target) {
  const targetWorkspaceMetadata = target.workspace?.metadata || {};
  for (const [key, value] of Object.entries(source.metadata || {})) {
    if (PRIVATE_AGENT_DELEGATION_METADATA_KEYS.has(key)) {
      const preserved = deepEqualJson(target.metadata?.[key], value) || deepEqualJson(targetWorkspaceMetadata[key], value);
      if (!preserved) throw new Error(`Database migration validation detected missing private agent delegation metadata: ${key}.`);
      continue;
    }
    if (!deepEqualJson(target.metadata?.[key], value)) {
      throw new Error(`Database migration validation detected changed public agent delegation metadata: ${key}.`);
    }
  }
  for (const [key, value] of Object.entries(source.workspace?.metadata || {})) {
    if (!deepEqualJson(targetWorkspaceMetadata[key], value)) {
      throw new Error(`Database migration validation detected changed agent delegation workspace metadata: ${key}.`);
    }
  }
}

function safeJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function deepEqualJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertFingerprintMapPreserved(before, after, label) {
  if (!(before instanceof Map) || !(after instanceof Map)) return;
  for (const [id, fingerprint] of before) {
    if (after.get(id) !== fingerprint) throw new Error(`Database migration validation detected a missing or changed ${label}.`);
  }
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}
