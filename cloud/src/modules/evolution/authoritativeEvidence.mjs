import crypto from 'node:crypto';

import {
  PERSONAL_THRESHOLD_ELIGIBILITY_POLICY_VERSION,
  encryptEvolutionEnvelope,
  encryptEvolutionPayload,
  evolutionEnvelopeCapability,
  normalizeEvolutionEvidenceIdentity,
  personalEvolutionThresholdEligible,
  stableEvolutionEvidenceId,
} from '../../../../src/shared/evolution/index.js';
import { createPostgresEvidenceUsageLedger } from './evidenceUsageLedger.mjs';

export async function createPostgresAuthoritativeEvidence(client, {
  keyring,
  envelopeKeyring = null,
  requireEnvelope = false,
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
  occurredAt = new Date(),
  metadata = {},
  personal = true,
  cluster = true,
  historicalInactive = false,
} = {}) {
  const instance = (await client.query(`SELECT * FROM cloud_user_agent_instances_v3
    WHERE user_id=$1 AND id=$2`, [ownerUserId,userAgentInstanceId])).rows[0];
  if (!instance || (agentFamilyId && instance.agent_family_id !== agentFamilyId)) {
    throw new Error('Authoritative Evidence Agent identity mismatch.');
  }
  const plaintext = typeof content === 'string' ? content : JSON.stringify(content);
  if (!plaintext.trim()) throw new Error('Authoritative Evidence content is required.');
  const contentHash = crypto.createHash('sha256').update(plaintext).digest('hex');
  const identity = normalizeEvolutionEvidenceIdentity({ ownerUserId,userAgentInstanceId,sourceKind,sourceId,sourceVersionId,contentHash });
  const evidenceId = stableEvolutionEvidenceId(identity);
  const envelopeAvailable = Boolean(envelopeKeyring && evolutionEnvelopeCapability(envelopeKeyring).available);
  if (requireEnvelope && !envelopeAvailable) throw new Error('Evolution Worker public-key envelope is required for cloud-native Evidence.');
  const encrypted = envelopeAvailable ? encryptEvolutionEnvelope(plaintext,envelopeKeyring) : encryptEvolutionPayload(plaintext,keyring);
  const pendingValidation = encrypted.algorithm === 'aes-256-gcm+rsa-oaep-sha256';
  const scopes = historicalInactive?[]:[personal && instance.personal_evolution_consent ? 'personal' : '',cluster ? 'cluster' : ''].filter(Boolean);
  const inserted = await client.query(`INSERT INTO cloud_evolution_evidence (
    evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,source_version_id,
    context_space_id,task_id,delegation_id,content_hash,content_ciphertext,content_nonce,content_tag,
    encryption_algorithm,key_id,confidence,privacy_level,quarantine_reason,occurred_at,metadata_json,
    personal_threshold_eligible,eligibility_policy_version,lineage_key,validation_status,validation_policy_version,
    validation_json,validated_at,historical_inactive,wrapped_data_key,key_wrap_algorithm,key_version,envelope_format
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'',$19,$20::jsonb,$21,$22,$23,$24,$25,
    $26::jsonb,$27,$28,$29,$30,$31,$32)
    ON CONFLICT(evidence_id) DO NOTHING RETURNING evidence_id`, [
    evidenceId,ownerUserId,userAgentInstanceId,instance.agent_family_id,identity.sourceKind,identity.sourceId,identity.sourceVersionId,
    contextSpaceId,taskId,delegationId,contentHash,encrypted.ciphertext,encrypted.nonce,encrypted.tag,
    encrypted.algorithm,encrypted.keyId,Math.min(1,Math.max(0,Number(confidence))),privacyLevel,occurredAt,
    JSON.stringify({ ...metadata,allowedEvolutionScopes:scopes,sourceAuthority:'cloud_native' }),
    personalEvolutionThresholdEligible(identity.sourceKind),PERSONAL_THRESHOLD_ELIGIBILITY_POLICY_VERSION,
    String(metadata.lineageKey||`${identity.sourceKind}:${identity.sourceId}:${identity.sourceVersionId}`),
    pendingValidation?'pending_validation':'validated','cloud_evidence_validation_v1',
    JSON.stringify(pendingValidation?{}:{policyVersion:'cloud_evidence_validation_v1',sourceVerified:true,taskRelevance:Number(metadata.taskRelevance??1),acceptanceQuality:Number(metadata.acceptanceQuality??1)}),
    pendingValidation?null:new Date(),Boolean(historicalInactive),encrypted.wrappedDataKey||'',encrypted.keyWrapAlgorithm||'',Number(encrypted.keyVersion||0),
    encrypted.envelopeFormat||'legacy_symmetric',
  ]);
  if (pendingValidation && inserted.rows.length) await client.query(`INSERT INTO cloud_evolution_evidence_validation_jobs
    (evidence_id,status,available_at) VALUES($1,'queued',now()) ON CONFLICT(evidence_id) DO NOTHING`,[evidenceId]);
  if (!pendingValidation && scopes.includes('personal')) await createPostgresEvidenceUsageLedger(client).ensureAvailable({ evidenceId,scope:'personal',consumerId:userAgentInstanceId });
  return { evidenceId,inserted:Boolean(inserted.rows.length) };
}
