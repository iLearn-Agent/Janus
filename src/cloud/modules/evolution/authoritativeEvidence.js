import crypto from 'node:crypto';

import {
  PERSONAL_THRESHOLD_ELIGIBILITY_POLICY_VERSION,
  encryptEvolutionPayload,
  normalizeEvolutionEvidenceIdentity,
  personalEvolutionThresholdEligible,
  stableEvolutionEvidenceId,
} from '../../../shared/evolution/index.js';
import { createSqliteEvidenceUsageLedger } from './evidenceUsageLedger.js';

export function createSqliteAuthoritativeEvidence(db, {
  keyring,
  ownerUserId,
  userAgentInstanceId,
  agentFamilyId = '',
  sourceKind,
  sourceId,
  sourceVersionId = '',
  content = '',
  contextSpaceId = '',
  taskId = '',
  delegationId = '',
  confidence = 1,
  privacyLevel = 'owner_private',
  occurredAt = new Date().toISOString(),
  metadata = {},
  personal = true,
  cluster = true,
} = {}) {
  const instance = db.prepare(`SELECT * FROM cloud_user_agent_instances_v3
    WHERE user_id=? AND id=?`).get(ownerUserId, userAgentInstanceId);
  if (!instance || (agentFamilyId && instance.agent_family_id !== agentFamilyId)) {
    throw new Error('Authoritative Evidence Agent identity mismatch.');
  }
  const plaintext = typeof content === 'string' ? content : JSON.stringify(content);
  if (!plaintext.trim()) throw new Error('Authoritative Evidence content is required.');
  const contentHash = crypto.createHash('sha256').update(plaintext).digest('hex');
  const identity = normalizeEvolutionEvidenceIdentity({ ownerUserId, userAgentInstanceId, sourceKind, sourceId, sourceVersionId, contentHash });
  const evidenceId = stableEvolutionEvidenceId(identity);
  const encrypted = encryptEvolutionPayload(plaintext, keyring);
  const scopes = [personal && Number(instance.personal_evolution_consent) ? 'personal' : '', cluster ? 'cluster' : ''].filter(Boolean);
  const result = db.prepare(`INSERT OR IGNORE INTO cloud_evolution_evidence (
    evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,source_version_id,
    context_space_id,task_id,delegation_id,content_hash,content_ciphertext,content_nonce,content_tag,
    encryption_algorithm,key_id,confidence,privacy_level,quarantine_reason,occurred_at,metadata_json,
    personal_threshold_eligible,eligibility_policy_version,lineage_key,validation_status,validation_policy_version,
    validation_json,validated_at,historical_inactive
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    evidenceId,ownerUserId,userAgentInstanceId,instance.agent_family_id,identity.sourceKind,identity.sourceId,identity.sourceVersionId,
    contextSpaceId,taskId,delegationId,contentHash,encrypted.ciphertext,encrypted.nonce,encrypted.tag,
    encrypted.algorithm,encrypted.keyId,Math.min(1,Math.max(0,Number(confidence))),privacyLevel,'',occurredAt,
    JSON.stringify({ ...metadata, allowedEvolutionScopes: scopes, sourceAuthority: 'cloud_native' }),
    personalEvolutionThresholdEligible(identity.sourceKind) ? 1 : 0,PERSONAL_THRESHOLD_ELIGIBILITY_POLICY_VERSION,
    String(metadata.lineageKey||`${identity.sourceKind}:${identity.sourceId}:${identity.sourceVersionId}`),'validated','cloud_native_v1',
    JSON.stringify({policyVersion:'cloud_native_v1',sourceVerified:true,taskRelevance:Number(metadata.taskRelevance??1),acceptanceQuality:Number(metadata.acceptanceQuality??1)}),
    new Date().toISOString(),0,
  );
  if (scopes.includes('personal')) createSqliteEvidenceUsageLedger(db).ensureAvailable({ evidenceId,scope:'personal',consumerId:userAgentInstanceId });
  return { evidenceId, inserted: Boolean(result.changes) };
}
