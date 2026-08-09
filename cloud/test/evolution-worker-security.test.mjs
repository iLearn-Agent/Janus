import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createEvolutionAuthority } from '../../src/cloud/modules/evolution/evolutionAuthority.js';
import { openCloudDatabase } from '../../src/cloud/server.js';
import {
  decryptEvolutionPayload,
  encryptEvolutionEnvelope,
  rewrapEvolutionEnvelope,
} from '../../src/shared/evolution/crypto.js';
import { stableEvolutionEvidenceId } from '../../src/shared/evolution/contracts.js';

test('Evolution envelope rewrap rotates only the wrapped data key and preserves plaintext', () => {
  const oldKeys=rsaPair();const nextKeys=rsaPair();
  const envelope=encryptEvolutionEnvelope('rotation payload',{activeKeyId:'old',keys:{old:oldKeys.publicKey}});
  const rotated=rewrapEvolutionEnvelope(envelope,{privateKeyring:{activeKeyId:'old',keys:{old:oldKeys.privateKey}},
    publicKeyring:{activeKeyId:'next',keys:{next:nextKeys.publicKey}},targetKeyId:'next'});
  assert.equal(rotated.ciphertext,envelope.ciphertext);
  assert.notEqual(rotated.wrappedDataKey,envelope.wrappedDataKey);
  assert.equal(rotated.keyId,'next');
  assert.equal(decryptEvolutionPayload(rotated,{activeKeyId:'next',keys:{next:nextKeys.privateKey}}),'rotation payload');
});

test('embedded Worker validates envelope Evidence before usage and audits allowed access', async (t) => {
  const fixture=await securityFixture(t,{includePrivateKey:true});
  const content='verification evidence without private identifiers';
  const result=fixture.authority.ingestEvidence(fixture.grant,[evidenceInput(fixture,content)]);
  assert.equal(result.accepted.length,1);
  const evidenceId=result.accepted[0];
  assert.equal(fixture.db.prepare('SELECT validation_status FROM cloud_evolution_evidence WHERE evidence_id=?').get(evidenceId).validation_status,'pending_validation');
  assert.equal(fixture.db.prepare('SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE evidence_id=?').get(evidenceId).count,0);
  await fixture.authority.tickWorker({workerId:'embedded-security-test'});
  assert.equal(fixture.db.prepare('SELECT validation_status FROM cloud_evolution_evidence WHERE evidence_id=?').get(evidenceId).validation_status,'validated');
  assert.equal(fixture.db.prepare("SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE evidence_id=? AND status='available'").get(evidenceId).count,1);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) count FROM cloud_evolution_evidence_access_audits WHERE evidence_id=? AND purpose='ingest_validation' AND result='allowed'").get(evidenceId).count,1);
});

test('missing Worker private key stops after bounded retries and recovers when the key appears', async (t) => {
  const fixture=await securityFixture(t,{includePrivateKey:false});
  const result=fixture.authority.ingestEvidence(fixture.grant,[evidenceInput(fixture,'verification evidence awaiting its Worker key')]);
  const evidenceId=result.accepted[0];
  await fixture.authority.tickWorker({workerId:'embedded-missing-key'});
  assert.equal(fixture.db.prepare('SELECT validation_status FROM cloud_evolution_evidence WHERE evidence_id=?').get(evidenceId).validation_status,'failed_retryable');
  assert.equal(fixture.db.prepare('SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE evidence_id=?').get(evidenceId).count,0);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) count FROM cloud_evolution_evidence_access_audits WHERE evidence_id=? AND result='failed'").get(evidenceId).count,1);
  for(let attempt=2;attempt<=5;attempt+=1){
    fixture.db.prepare("UPDATE cloud_evolution_evidence_validation_jobs SET available_at='2000-01-01T00:00:00.000Z' WHERE evidence_id=?").run(evidenceId);
    await fixture.authority.tickWorker({workerId:'embedded-missing-key'});
  }
  const terminal=fixture.db.prepare('SELECT status,attempt_count,error_code FROM cloud_evolution_evidence_validation_jobs WHERE evidence_id=?').get(evidenceId);
  assert.equal(terminal.status,'failed_terminal');
  assert.equal(terminal.attempt_count,5);
  assert.equal(terminal.error_code,'evolution_decryption_key_unavailable');
  assert.equal(fixture.db.prepare("SELECT COUNT(*) count FROM cloud_evolution_evidence_access_audits WHERE evidence_id=? AND result='failed'").get(evidenceId).count,5);
  await fixture.authority.tickWorker({workerId:'embedded-missing-key'});
  assert.equal(fixture.db.prepare("SELECT COUNT(*) count FROM cloud_evolution_evidence_access_audits WHERE evidence_id=? AND result='failed'").get(evidenceId).count,5);
  fixture.keyring.keys[fixture.keyId]=fixture.keys.privateKey;
  await fixture.authority.tickWorker({workerId:'embedded-key-recovery'});
  assert.equal(fixture.db.prepare('SELECT validation_status FROM cloud_evolution_evidence WHERE evidence_id=?').get(evidenceId).validation_status,'validated');
  assert.equal(fixture.db.prepare("SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE evidence_id=? AND status='available'").get(evidenceId).count,1);
});

test('structured model metrics ignore internal references but still reject actual credentials', async (t) => {
  const fixture=await securityFixture(t,{includePrivateKey:true});
  const safe=JSON.stringify({status:'completed',ownerUserId:'user_1234567890',taskRunId:'task_1234567890',
    taskNodeId:'task_node_1234567890',eventKind:'task_terminal',occurredAt:'2026-07-29T12:00:00.000Z',
    acceptanceScore:0.3333333333333333,usage:{input_tokens:120,output_tokens:40},durationMs:900});
  const safeResult=fixture.authority.ingestEvidence(fixture.grant,[evidenceInput(fixture,safe,{sourceKind:'model_execution_metric'})]);
  const safeEvidenceId=safeResult.accepted[0];
  fixture.db.prepare(`UPDATE cloud_evolution_evidence SET validation_status='quarantined',quarantine_reason='credential_like_content',
    validation_policy_version='cloud_evidence_validation_v1' WHERE evidence_id=?`).run(safeEvidenceId);
  fixture.db.prepare("UPDATE cloud_evolution_evidence_validation_jobs SET status='quarantined',completed_at=? WHERE evidence_id=?").run(new Date().toISOString(),safeEvidenceId);
  fixture.db.prepare(`INSERT INTO cloud_evolution_evidence_quarantine
    (id,evidence_id,reason_code,resolution_status) VALUES('legacy-metric-quarantine',?,'credential_like_content','pending')`).run(safeEvidenceId);
  await fixture.authority.tickWorker({workerId:'embedded-structured-metric'});
  assert.equal(fixture.db.prepare('SELECT validation_status FROM cloud_evolution_evidence WHERE evidence_id=?').get(safeEvidenceId).validation_status,'validated');
  assert.equal(fixture.db.prepare("SELECT resolution_status FROM cloud_evolution_evidence_quarantine WHERE evidence_id=?").get(safeEvidenceId).resolution_status,'released');

  const unsafe=JSON.stringify({status:'failed',taskRunId:'task_1234567890',errorText:'api_key=sk-examplecredential123456'});
  const unsafeResult=fixture.authority.ingestEvidence(fixture.grant,[evidenceInput(fixture,unsafe,{sourceKind:'model_execution_metric'})]);
  const unsafeEvidenceId=unsafeResult.accepted[0];
  await fixture.authority.tickWorker({workerId:'embedded-structured-metric'});
  assert.equal(fixture.db.prepare('SELECT validation_status FROM cloud_evolution_evidence WHERE evidence_id=?').get(unsafeEvidenceId).validation_status,'quarantined');
});

test('Worker privacy quarantine is terminal for eligibility and creates no usage', async (t) => {
  const fixture=await securityFixture(t,{includePrivateKey:true});
  const result=fixture.authority.ingestEvidence(fixture.grant,[evidenceInput(fixture,'Contact private-owner@example.com for the secret project.')]);
  const evidenceId=result.accepted[0];
  await fixture.authority.tickWorker({workerId:'embedded-privacy-quarantine'});
  assert.equal(fixture.db.prepare('SELECT validation_status FROM cloud_evolution_evidence WHERE evidence_id=?').get(evidenceId).validation_status,'quarantined');
  assert.equal(fixture.db.prepare('SELECT COUNT(*) count FROM cloud_evolution_evidence_usage WHERE evidence_id=?').get(evidenceId).count,0);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) count FROM cloud_evolution_evidence_quarantine WHERE evidence_id=? AND resolution_status='pending'").get(evidenceId).count,1);
});

test('production Evidence ingest rejects legacy plaintext payloads', async (t) => {
  const fixture=await securityFixture(t,{includePrivateKey:true,production:true});
  const content='legacy plaintext';
  const result=fixture.authority.ingestEvidence(fixture.grant,[{
    userAgentInstanceId:'security_instance',sourceKind:'message',sourceId:'legacy_message',content,
    contentHash:sha256(content),occurredAt:new Date().toISOString(),allowedEvolutionScopes:['personal'],
  }]);
  assert.equal(result.rejected[0].code,'evolution_envelope_required');
});

async function securityFixture(t,{includePrivateKey,production=false}){
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'janus-worker-security-'));
  const db=openCloudDatabase(home);t.after(async()=>{db.close();await fs.rm(home,{recursive:true,force:true});});
  const keys=rsaPair();const keyId='worker-key';
  const env={NODE_ENV:production?'production':'test',JANUS_EVOLUTION_ALLOW_PLAINTEXT_TEST_ONLY:'1',
    JANUS_EVOLUTION_WORKER_ACTIVE_KEY_ID:keyId,
    JANUS_EVOLUTION_WORKER_PUBLIC_KEYS_JSON:JSON.stringify({[keyId]:keys.publicKey}),
    JANUS_EVOLUTION_WORKER_PRIVATE_KEYS_JSON:JSON.stringify(includePrivateKey?{[keyId]:keys.privateKey}:{})};
  db.prepare("INSERT INTO users(id,email,display_name,username,password_hash) VALUES('security_user','security@example.com','Security User','security_user','hash')").run();
  db.prepare("INSERT INTO cloud_agent_families_v3(id,name) VALUES('security_family','Security Agent')").run();
  db.prepare(`INSERT INTO cloud_user_agent_instances_v3
    (user_id,id,agent_family_id,status,sync_enabled,personal_evolution_consent) VALUES('security_user','security_instance','security_family','active',1,1)`).run();
  const keyring={activeKeyId:keyId,keys:includePrivateKey?{[keyId]:keys.privateKey}:{},allowPlaintextTestOnly:true};
  const authority=createEvolutionAuthority({db,env,modelExecutor:async()=>'',keyring});
  const grant=authority.issueGrant({userId:'security_user',deviceId:'security_device'});
  return {db,authority,grant:{userId:'security_user',deviceId:'security_device'},keys,keyId,keyring};
}

function evidenceInput(fixture,content,{sourceKind='message'}={}){
  const contentHash=sha256(content);const sourceId=`source_${contentHash.slice(0,12)}`;
  const evidenceId=stableEvolutionEvidenceId({ownerUserId:'security_user',userAgentInstanceId:'security_instance',sourceKind,sourceId,contentHash});
  return {evidenceId,userAgentInstanceId:'security_instance',sourceKind,sourceId,contentHash,
    evolutionEnvelope:encryptEvolutionEnvelope(content,{activeKeyId:fixture.keyId,keys:{[fixture.keyId]:fixture.keys.publicKey}}),
    occurredAt:new Date().toISOString(),allowedEvolutionScopes:['personal']};
}
function rsaPair(){return crypto.generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},
  privateKeyEncoding:{type:'pkcs8',format:'pem'}});}
function sha256(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}
