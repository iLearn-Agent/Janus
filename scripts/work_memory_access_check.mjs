import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/main/db.js';
import { Store } from '../src/main/store.js';
import { createWorkMemoryRuntimeApi } from '../src/main/modules/orchestration/index.js';
import { TaskScheduler } from '../src/main/scheduler.js';
import { state as rendererState } from '../src/renderer/app/state.js';
import { configureCollaborationView, renderCollaboration } from '../src/renderer/app/views/collaborationView.js';

const root = mkdtempSync(path.join(tmpdir(), 'janus-work-memory-access-'));
let db;

try {
  db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  createUser(db, 'owner', 'owner@work-memory.test');
  createUser(db, 'other_owner', 'other@work-memory.test');

  const lead = recruit(store, 'owner', 'task_lead_agent');
  const worker = recruit(store, 'owner', 'worker_agent');
  const peer = recruit(store, 'owner', 'peer_agent');
  const observer = recruit(store, 'owner', 'observer_agent');
  const highProfessional = recruit(store, 'owner', 'p10_l0_agent');
  const unappointedLeader = recruit(store, 'owner', 'unappointed_l3_agent');
  const external = recruit(store, 'other_owner', 'external_agent');

  const task = store.createTaskRun({
    title: 'Work Memory authorization matrix',
    prompt: 'Verify exact-scope Agent collaboration Memory access.',
    ownerUserId: 'owner',
    leadAgentId: lead.agentFamilyId,
    leadAgentInstanceId: lead.id,
  });
  for (const [instance, title] of [
    [worker, 'Worker node'],
    [peer, 'Peer node'],
    [observer, 'Observer node'],
    [highProfessional, 'P10/L0 node'],
    [unappointedLeader, 'Unappointed L3 node'],
  ]) {
    store.createTaskNode({
      taskRunId: task.id,
      title,
      objective: title,
      agentId: instance.agentFamilyId,
      agentInstanceId: instance.id,
    });
  }
  const workScopeId = `task:${task.id}`;
  store.upsertWorkParticipant({ workScopeId, agentInstanceId: external.id, role: 'executor' });
  store.linkWorkCollaborators({
    workScopeId,
    agentInstanceId: worker.id,
    collaboratorAgentInstanceId: peer.id,
  });

  const workerMemory = taskMemory(store, worker.id, task.id);
  const peerMemory = taskMemory(store, peer.id, task.id);
  assert.equal(workerMemory.workScopeId, workScopeId);
  assert.equal(workerMemory.visibility, 'agent_private');

  let expectedAuditCount = 0;
  const readAllowed = (input) => {
    const value = store.readCollaboratorWorkMemory(input);
    expectedAuditCount += 1;
    assert.equal(store.listWorkMemoryAccessAudits({ limit: 1000 }).length, expectedAuditCount);
    return value;
  };
  const readDenied = (input, code) => {
    assert.throws(
      () => store.readCollaboratorWorkMemory(input),
      (error) => error?.code === code,
      `expected work Memory denial ${code}`,
    );
    expectedAuditCount += 1;
    const audits = store.listWorkMemoryAccessAudits({ limit: 1000 });
    assert.equal(audits.length, expectedAuditCount);
    assert.equal(audits[0].result, 'denied');
    assert.equal(audits[0].resultCode, code);
  };

  readDenied({
    workScopeId,
    requesterAgentInstanceId: lead.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: workerMemory.currentVersionId,
  }, 'MEMORY_PRIVATE');

  const collaboratorsVersion = store.publishWorkMemoryVersion({
    workScopeId,
    agentInstanceId: worker.id,
    memoryDocumentId: workerMemory.id,
    visibility: 'work_collaborators',
    content: '# Worker progress\n\n- Direct-collaborator detail.\n',
  }).version;
  assert.match(readAllowed({
    workScopeId,
    requesterAgentInstanceId: peer.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: collaboratorsVersion.id,
  }).content, /Direct-collaborator detail/);
  readDenied({
    workScopeId,
    requesterAgentInstanceId: observer.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: collaboratorsVersion.id,
  }, 'NOT_DIRECT_COLLABORATOR');
  assert.match(readAllowed({
    workScopeId,
    requesterAgentInstanceId: lead.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: collaboratorsVersion.id,
  }).content, /Direct-collaborator detail/, 'appointed task lead must read all non-private Memory in its exact work');

  const leadershipVersion = store.publishWorkMemoryVersion({
    workScopeId,
    agentInstanceId: worker.id,
    memoryDocumentId: workerMemory.id,
    visibility: 'work_leadership',
    content: '# Leadership update\n\n- Escalation detail.\n',
  }).version;
  readDenied({
    workScopeId,
    requesterAgentInstanceId: peer.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: leadershipVersion.id,
  }, 'LEADERSHIP_APPOINTMENT_REQUIRED');
  assert.match(readAllowed({
    workScopeId,
    requesterAgentInstanceId: lead.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: leadershipVersion.id,
  }).content, /Escalation detail/);
  readDenied({
    workScopeId,
    requesterAgentInstanceId: highProfessional.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: leadershipVersion.id,
  }, 'LEADERSHIP_APPOINTMENT_REQUIRED');
  readDenied({
    workScopeId,
    requesterAgentInstanceId: unappointedLeader.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: leadershipVersion.id,
  }, 'LEADERSHIP_APPOINTMENT_REQUIRED');

  const participantVersion = store.publishWorkMemoryVersion({
    workScopeId,
    agentInstanceId: worker.id,
    memoryDocumentId: workerMemory.id,
    visibility: 'work_participants',
    content: '# Participant update\n\n- Shared task fact.\n',
  }).version;
  assert.match(readAllowed({
    workScopeId,
    requesterAgentInstanceId: observer.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: participantVersion.id,
  }).content, /Shared task fact/);

  const summaryVersion = store.publishWorkMemoryVersion({
    workScopeId,
    agentInstanceId: worker.id,
    memoryDocumentId: workerMemory.id,
    visibility: 'work_summary',
    content: '# Work summary\n\n- Milestone complete.\n',
  }).version;
  assert.match(readAllowed({
    workScopeId,
    requesterAgentInstanceId: observer.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: summaryVersion.id,
  }).content, /Milestone complete/);

  const runtimeApi = createWorkMemoryRuntimeApi({
    auth: { requireUser: () => ({ id: 'owner' }) },
    store,
  });
  const runtimePublished = (await runtimeApi.publishWorkMemory({
    workScopeId,
    agentInstanceId: worker.id,
    memoryDocumentId: workerMemory.id,
    visibility: 'work_summary',
    content: '# Runtime API publication\n',
  })).version;
  assert.match((await runtimeApi.readWorkMemory({
    workScopeId,
    requesterAgentInstanceId: observer.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: runtimePublished.id,
  })).content, /Runtime API publication/);
  expectedAuditCount += 1;
  assert.equal(store.listWorkMemoryAccessAudits({ limit: 1000 }).length, expectedAuditCount);
  assert.ok(runtimeApi.workMemoryProgress({ workScopeId, requesterAgentInstanceId: observer.id }).length >= 5);
  const scheduler = new TaskScheduler({ root, store, org: {} });
  const workerNode = store.getTaskRun(task.id).nodes.find((item) => item.agentInstanceId === worker.id);
  const coordinationMemory = scheduler.readCommunicationProgressMemory({
    task: store.getTaskRun(task.id),
    communication: {
      id: 'blocking-communication-check',
      fromAgentId: worker.agentFamilyId,
      references: [{ taskNodeId: workerNode.id }],
    },
    requesterAgentInstanceId: observer.id,
  });
  assert.match(coordinationMemory.content, /Runtime API publication/);
  expectedAuditCount += 1;
  assert.equal(store.listWorkMemoryAccessAudits({ limit: 1000 })[0].requestedReason,
    'orchestration:blocking_communication_response:blocking-communication-check');
  await assert.rejects(() => runtimeApi.readWorkMemory({
    workScopeId,
    requesterAgentInstanceId: external.id,
    targetAgentInstanceId: worker.id,
  }), (error) => error?.code === 'AGENT_OWNERSHIP_REQUIRED');
  expectedAuditCount += 1;
  assert.equal(store.listWorkMemoryAccessAudits({ limit: 1000 })[0].resultCode, 'AGENT_OWNERSHIP_REQUIRED');

  const otherTask = store.createTaskRun({
    title: 'Unrelated work',
    prompt: 'Must remain isolated.',
    ownerUserId: 'owner',
    leadAgentId: lead.agentFamilyId,
    leadAgentInstanceId: lead.id,
  });
  store.createTaskNode({
    taskRunId: otherTask.id,
    title: 'Same worker, unrelated task',
    objective: 'Remain isolated.',
    agentId: worker.agentFamilyId,
    agentInstanceId: worker.id,
  });
  readDenied({
    workScopeId: `task:${otherTask.id}`,
    requesterAgentInstanceId: lead.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentId: workerMemory.id,
    memoryDocumentVersionId: summaryVersion.id,
  }, 'MEMORY_WORK_SCOPE_MISMATCH');
  assert.equal(store.listWorkMemoryAccessAudits({ workScopeId: `task:${otherTask.id}` })[0].resultCode, 'MEMORY_WORK_SCOPE_MISMATCH');

  readDenied({
    workScopeId,
    requesterAgentInstanceId: worker.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: summaryVersion.id,
  }, 'SELF_READ_NOT_COLLABORATION');
  readDenied({
    requesterAgentInstanceId: peer.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: summaryVersion.id,
  }, 'WORK_SCOPE_REQUIRED');
  assert.ok(store.listWorkMemoryAccessAudits({ limit: 1000 }).some((item) => item.workScopeId === '' && item.resultCode === 'WORK_SCOPE_REQUIRED'));

  readDenied({
    workScopeId,
    requesterAgentInstanceId: external.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: summaryVersion.id,
  }, 'CLOUD_AUTH_REQUIRED');

  assert.throws(() => store.publishWorkMemoryVersion({
    workScopeId,
    agentInstanceId: peer.id,
    memoryDocumentId: workerMemory.id,
    visibility: 'work_summary',
  }), (error) => error?.code === 'CROSS_AGENT_WRITE_FORBIDDEN');
  assert.equal(typeof store.searchCollaboratorWorkMemory, 'undefined', 'fuzzy cross-work Memory search must not exist');

  const temporaryLeader = store.appointWorkLeader({
    workScopeId,
    agentInstanceId: observer.id,
    role: 'team_lead',
    leadershipLevelSnapshot: 'L3',
    appointedBy: lead.id,
  });
  assert.equal(temporaryLeader.role, 'team_lead');
  const duringAppointmentVersion = store.publishWorkMemoryVersion({
    workScopeId,
    agentInstanceId: worker.id,
    memoryDocumentId: workerMemory.id,
    visibility: 'work_leadership',
    content: '# During temporary appointment\n\n- Current leadership detail.\n',
  }).version;
  assert.match(readAllowed({
    workScopeId,
    requesterAgentInstanceId: observer.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: duringAppointmentVersion.id,
  }).content, /Current leadership detail/);
  store.revokeWorkLeader({ workScopeId, agentInstanceId: observer.id });
  await tick();
  const postRevocationVersion = store.publishWorkMemoryVersion({
    workScopeId,
    agentInstanceId: worker.id,
    memoryDocumentId: workerMemory.id,
    visibility: 'work_leadership',
    content: '# Later leadership update\n\n- Revoked leaders cannot read this.\n',
  }).version;
  readDenied({
    workScopeId,
    requesterAgentInstanceId: observer.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: postRevocationVersion.id,
  }, 'LEADERSHIP_APPOINTMENT_REQUIRED');

  const peerPublishedBeforeRemoval = store.publishWorkMemoryVersion({
    workScopeId,
    agentInstanceId: worker.id,
    memoryDocumentId: workerMemory.id,
    visibility: 'work_collaborators',
    content: '# Before peer removal\n',
  }).version;
  store.removeWorkParticipant({ workScopeId, agentInstanceId: peer.id });
  assert.match(readAllowed({
    workScopeId,
    requesterAgentInstanceId: peer.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: peerPublishedBeforeRemoval.id,
  }).content, /Before peer removal/);
  await tick();
  const peerPublishedAfterRemoval = store.publishWorkMemoryVersion({
    workScopeId,
    agentInstanceId: worker.id,
    memoryDocumentId: workerMemory.id,
    visibility: 'work_collaborators',
    content: '# After peer removal\n',
  }).version;
  readDenied({
    workScopeId,
    requesterAgentInstanceId: peer.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: peerPublishedAfterRemoval.id,
  }, 'REQUESTER_OUTSIDE_MEMBERSHIP_WINDOW');

  const mergeAlias = recruit(store, 'owner', 'canonical_merge_agent');
  store.createTaskNode({
    taskRunId: task.id,
    title: 'Canonical merge node',
    objective: 'Preserve work ACL references during identity canonicalization.',
    agentId: mergeAlias.agentFamilyId,
    agentInstanceId: mergeAlias.id,
  });
  store.linkWorkCollaborators({
    workScopeId,
    agentInstanceId: worker.id,
    collaboratorAgentInstanceId: mergeAlias.id,
  });
  const mergeMemory = taskMemory(store, mergeAlias.id, task.id);
  const mergeVersion = store.publishWorkMemoryVersion({
    workScopeId,
    agentInstanceId: mergeAlias.id,
    memoryDocumentId: mergeMemory.id,
    visibility: 'work_summary',
    content: '# Canonical merge publication\n',
  }).version;
  const canonicalMergeId = 'canonical_merge_agent_instance';
  store.bindCanonicalAgentInstance({
    userId: 'owner',
    aliasInstanceId: mergeAlias.id,
    canonicalInstanceId: canonicalMergeId,
  });
  assert.ok(db.prepare(`SELECT 1 FROM work_participants WHERE work_scope_id=? AND agent_instance_id=?`).get(workScopeId, canonicalMergeId));
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM work_participants WHERE agent_instance_id=?`).get(mergeAlias.id).count, 0);
  assert.equal(db.prepare('SELECT published_by_agent_instance_id FROM memory_document_versions WHERE id=?').get(mergeVersion.id).published_by_agent_instance_id, canonicalMergeId);
  assert.ok(store.upsertWorkParticipant({ workScopeId, agentInstanceId: worker.id }).collaboratorAgentInstanceIds.includes(canonicalMergeId));
  assert.match(readAllowed({
    workScopeId,
    requesterAgentInstanceId: lead.id,
    targetAgentInstanceId: canonicalMergeId,
    memoryDocumentVersionId: mergeVersion.id,
  }).content, /Canonical merge publication/);

  const progress = store.listWorkParticipantProgress({ workScopeId, requesterAgentInstanceId: lead.id });
  assert.ok(progress.some((item) => item.agentInstanceId === worker.id && item.node?.title === 'Worker node'));
  assert.equal(JSON.stringify(progress).includes('After peer removal'), false, 'progress index must not include Memory content');

  store.updateTaskRunStatus(task.id, 'completed', 'Historical work complete.');
  assert.equal(store.getWorkScope(workScopeId).status, 'closed');
  assert.match(readAllowed({
    workScopeId,
    requesterAgentInstanceId: lead.id,
    targetAgentInstanceId: worker.id,
    memoryDocumentVersionId: summaryVersion.id,
  }).content, /Milestone complete/, 'closed work must remain historically readable');
  assert.throws(() => store.publishWorkMemoryVersion({
    workScopeId,
    agentInstanceId: worker.id,
    memoryDocumentId: workerMemory.id,
    visibility: 'work_summary',
    content: '# Illegal post-close write\n',
  }), (error) => error?.code === 'WORK_SCOPE_CLOSED');

  const allAudits = store.listWorkMemoryAccessAudits({ limit: 1000 });
  assert.equal(allAudits.length, expectedAuditCount, 'all allow/deny reads, including empty and unrelated scopes, must be audited exactly once');
  assert.ok(allAudits.some((item) => item.result === 'allowed'));
  assert.ok(allAudits.some((item) => item.result === 'denied'));
  assert.equal(taskMemory(store, peer.id, task.id).id, peerMemory.id);

  const federatedTask = store.createTaskRun({
    title: 'Federated delegated work',
    prompt: 'Publish encrypted work progress through uBuddy.',
    ownerUserId: 'owner',
    leadAgentId: worker.agentFamilyId,
    leadAgentInstanceId: worker.id,
    metadata: { delegationId: 'delegation_work_memory_check' },
  });
  const federatedScopeId = `task:${federatedTask.id}`;
  const federatedScope = store.getWorkScope(federatedScopeId);
  assert.equal(federatedScope.federationType, 'delegation');
  assert.equal(federatedScope.federationId, 'delegation_work_memory_check');
  const federatedMemory = taskMemory(store, worker.id, federatedTask.id);
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyring = {
    activeKeyId: 'local-publication-test-key',
    keys: { 'local-publication-test-key': publicKey.export({ type: 'spki', format: 'pem' }) },
  };
  const prepared = store.prepareTaskCloudCollaborationEnvelope({ taskRunId: federatedTask.id, keyring: publicKeyring });
  assert.equal(prepared.cloudCollaborationAllowed, true);
  assert.equal(prepared.cloudEvolutionAllowed, false, 'collaboration must not grant cluster evolution consent');
  assert.equal(prepared.cloudEnvelopeState, 'active');

  let relayedPublication = null;
  let relayedRead = null;
  let relayedAppointment = null;
  let relayedRevocation = null;
  let relayConnected = true;
  const federatedRuntime = createWorkMemoryRuntimeApi({
    auth: { requireUser: () => ({ id: 'owner' }) },
    store,
    socialRelay: {
      connected: () => relayConnected,
      publishWorkMemory: async (payload) => { relayedPublication = payload; return { ok: true }; },
      appointWorkLeader: async (payload) => { relayedAppointment = payload; return { status: 'appointed' }; },
      revokeWorkLeader: async (payload) => { relayedRevocation = payload; return { status: 'revoked' }; },
      readWorkMemory: async (payload) => { relayedRead = payload; return { content: 'Remote collaborator progress.' }; },
    },
  });
  const federatedPublished = await federatedRuntime.publishWorkMemory({
    workScopeId: federatedScopeId,
    agentInstanceId: worker.id,
    memoryDocumentId: federatedMemory.id,
    visibility: 'work_summary',
    content: '# Encrypted cloud publication\n',
  });
  assert.equal(federatedPublished.cloud.status, 'published');
  assert.equal(federatedPublished.cloud.outbox.status, 'published');
  assert.equal(federatedPublished.cloud.outbox.attemptCount, 1);
  assert.equal(relayedPublication.federationId, 'delegation_work_memory_check');
  assert.ok(relayedAppointment.assignmentId, 'task-lead publication must synchronize its exact leadership assignment');
  assert.equal(Object.hasOwn(relayedPublication.version, 'content'), false);
  assert.ok(relayedPublication.version.contentCiphertext);
  assert.equal(db.prepare('SELECT content FROM memory_document_versions WHERE id=?').get(federatedPublished.version.id).content, '');
  assert.equal((await federatedRuntime.readWorkMemory({
    workScopeId: federatedScopeId,
    requesterAgentInstanceId: worker.id,
    targetAgentInstanceId: 'remote_collaborator_agent',
    memoryDocumentVersionId: 'remote_version',
  })).content, 'Remote collaborator progress.');
  assert.equal(relayedRead.federationType, 'delegation');
  assert.equal(relayedRead.federationId, 'delegation_work_memory_check');

  relayConnected = false;
  const offlinePublished = await federatedRuntime.publishWorkMemory({
    workScopeId: federatedScopeId,
    agentInstanceId: worker.id,
    memoryDocumentId: federatedMemory.id,
    visibility: 'work_participants',
    content: '# Offline publication retained in outbox\n',
    sourceCursor: 'offline-publication',
  });
  assert.equal(offlinePublished.cloud.status, 'unavailable');
  assert.equal(offlinePublished.outbox.status, 'pending');
  assert.equal(federatedRuntime.workMemoryPublicationStatus({ workScopeId: federatedScopeId, status: 'pending' }).length, 1);
  relayConnected = true;
  const offlineFlush = await federatedRuntime.flushWorkMemoryPublications();
  assert.equal(offlineFlush.published, 1);
  assert.equal(store.getWorkMemoryPublicationOutbox({ memoryDocumentVersionId: offlinePublished.version.id }).status, 'published');

  const milestone = store.publishTaskMilestone({
    taskRunId: federatedTask.id,
    agentInstanceId: worker.id,
    taskNodeId: 'federated-node',
    nodeTitle: 'Federated node',
    status: 'completed',
    summary: '  Completed   the bounded milestone.  ',
    sourceCursor: 'milestone-cursor-1',
  });
  const repeatedMilestone = store.publishTaskMilestone({
    taskRunId: federatedTask.id,
    agentInstanceId: worker.id,
    taskNodeId: 'federated-node',
    nodeTitle: 'Federated node',
    status: 'completed',
    summary: 'Completed the bounded milestone.',
    sourceCursor: 'milestone-cursor-1',
  });
  assert.equal(repeatedMilestone.idempotent, true);
  assert.equal(repeatedMilestone.version.id, milestone.version.id);
  const milestoneDocument = store.getMemoryDocument(milestone.version.memoryDocumentId);
  assert.equal(milestoneDocument.slotNo, 1000);
  assert.equal(milestoneDocument.displayName, 'work-progress.md');
  assert.match(milestoneDocument.content, /Completed the bounded milestone\./);
  assert.equal(store.listWorkMemoryPublicationOutbox({
    userId: 'owner', workScopeId: federatedScopeId,
  }).filter((item) => item.memoryDocumentVersionId === milestone.version.id).length, 1);
  const milestoneFlush = await federatedRuntime.flushWorkMemoryPublications();
  assert.equal(milestoneFlush.published, 1);

  const retryPublication = store.publishWorkMemoryVersion({
    workScopeId: federatedScopeId,
    agentInstanceId: worker.id,
    memoryDocumentId: federatedMemory.id,
    visibility: 'work_summary',
    content: '# Retry publication\n',
    sourceCursor: 'retry-publication',
  });
  assert.equal(store.claimWorkMemoryPublication({ id: retryPublication.outbox.id }), true);
  const failedOutbox = store.failWorkMemoryPublication({
    id: retryPublication.outbox.id,
    error: 'simulated transport failure',
    retryAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(failedOutbox.status, 'failed');
  assert.equal(failedOutbox.attemptCount, 1);
  assert.ok(store.listWorkMemoryPublicationOutbox({ userId: 'owner', dueOnly: true })
    .some((item) => item.id === failedOutbox.id));
  const retryFlush = await federatedRuntime.flushWorkMemoryPublications();
  assert.equal(retryFlush.published, 1);
  assert.equal(store.getWorkMemoryPublicationOutbox({ id: failedOutbox.id }).attemptCount, 2);

  const runtimeAppointment = await federatedRuntime.appointWorkMemoryLeader({
    workScopeId: federatedScopeId,
    targetAgentInstanceId: worker.id,
    role: 'task_lead',
    leadershipLevelSnapshot: 'L2',
  });
  assert.equal(runtimeAppointment.local.role, 'task_lead');
  assert.equal(runtimeAppointment.cloud.status, 'appointed');
  assert.equal(relayedAppointment.targetUserId, 'owner');
  assert.equal(relayedAppointment.assignmentId, runtimeAppointment.local.id);
  const runtimeRevocation = await federatedRuntime.revokeWorkMemoryLeader({
    workScopeId: federatedScopeId,
    targetAgentInstanceId: worker.id,
  });
  assert.equal(runtimeRevocation.cloud.status, 'revoked');
  assert.equal(relayedRevocation.targetAgentInstanceId, worker.id);

  const previousRendererState = {
    tasks: rendererState.tasks,
    taskDetail: rendererState.taskDetail,
    workMemoryObservability: rendererState.workMemoryObservability,
  };
  configureCollaborationView({ agentNameById: (id) => id });
  rendererState.tasks = [store.getTaskRun(federatedTask.id)];
  rendererState.taskDetail = rendererState.tasks[0];
  rendererState.workMemoryObservability = {
    workScopeId: federatedScopeId,
    outbox: federatedRuntime.workMemoryPublicationStatus({ workScopeId: federatedScopeId }),
    audits: store.listWorkMemoryAccessAudits({ workScopeId: federatedScopeId }),
    loading: false,
    error: '',
  };
  const collaborationMarkup = renderCollaboration();
  assert.match(collaborationMarkup, /协作 Memory 可观测性/);
  assert.match(collaborationMarkup, /data-work-memory-refresh=/);
  Object.assign(rendererState, previousRendererState);

  assert.throws(() => store.createTaskRun({
    title: 'Federated delegated work retry',
    prompt: 'Retry the same delegated work without sharing the exact task scope.',
    ownerUserId: 'owner',
    leadAgentId: worker.agentFamilyId,
    leadAgentInstanceId: worker.id,
    metadata: { delegationId: 'delegation_work_memory_check' },
  }), (error) => error?.code === 'WORK_FEDERATION_ACTIVE');
  store.updateTaskRunStatus(federatedTask.id, 'failed', 'The first delegated attempt ended before delivery.');
  const federatedRetryTask = store.createTaskRun({
    title: 'Federated delegated work retry',
    prompt: 'Retry the same delegated work after the previous attempt ended.',
    ownerUserId: 'owner',
    leadAgentId: worker.agentFamilyId,
    leadAgentInstanceId: worker.id,
    metadata: { delegationId: 'delegation_work_memory_check' },
  });
  const federatedRetryScope = store.getWorkScope(`task:${federatedRetryTask.id}`);
  assert.notEqual(federatedRetryScope.id, federatedScope.id);
  assert.equal(federatedRetryScope.federationType, 'delegation');
  assert.equal(federatedRetryScope.federationId, federatedScope.federationId);
  assert.equal(store.getWorkScope(federatedScopeId).federationId, '');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM work_scopes
    WHERE federation_type='delegation' AND federation_id='delegation_work_memory_check'`).get().count, 1);

  console.log(`Work Memory access checks passed (${allAudits.length} audited decisions).`);
} finally {
  try { db?.close(); } catch {}
  rmSync(root, { recursive: true, force: true });
}

function createUser(dbHandle, id, email) {
  dbHandle.prepare('INSERT INTO auth_users (id,email,display_name) VALUES (?,?,?)').run(id, email, id);
}

function recruit(store, userId, agentFamilyId) {
  const agent = {
    id: agentFamilyId,
    name: agentFamilyId,
    role: 'agent',
    departmentId: 'general',
    routable: true,
    baseSkill: `# ${agentFamilyId}\n`,
  };
  store.upsertAgentFamily(agent);
  store.upsertAgentVersion({ agent, memoryTemplate: `# Memory ${agentFamilyId}\n` });
  return store.recruitUserAgent({
    userId,
    agentFamilyId,
    commandId: `work-memory-check:${userId}:${agentFamilyId}`,
  }).instance;
}

function taskMemory(store, agentInstanceId, taskRunId) {
  const document = store.listMemoryDocuments({ agentInstanceId })
    .find((item) => item.scope === 'task' && item.taskRunId === taskRunId);
  assert.ok(document, `task Memory missing for ${agentInstanceId}`);
  return document;
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}
