import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { decryptEvolutionPayload, encryptEvolutionEnvelope } from '../src/shared/evolution/crypto.js';

const databaseUrl=String(process.env.JANUS_REHEARSAL_DATABASE_URL||'');
const allowed=String(process.env.JANUS_ALLOW_DATABASE_REHEARSAL||'').toLowerCase()==='true';
if(!databaseUrl||!allowed){
  console.error('Evolution Worker security PostgreSQL rehearsal requires JANUS_REHEARSAL_DATABASE_URL and JANUS_ALLOW_DATABASE_REHEARSAL=true.');
  process.exit(2);
}

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const migrationsDir=path.join(root,'cloud','migrations');
const schema=`janus_worker_security_${crypto.randomBytes(6).toString('hex')}`;
const common={connectionString:databaseUrl,ssl:process.env.PGSSL==='true'?{rejectUnauthorized:false}:undefined,connectionTimeoutMillis:10000};
const admin=new pg.Pool({...common,max:1,options:`-c search_path=${schema}`});
const roleDatabaseUrl=(configuredUrl,username,password)=>{
  const rehearsalUrl=new URL(databaseUrl);
  const url=new URL(String(configuredUrl||databaseUrl));
  url.pathname=rehearsalUrl.pathname;
  if(!configuredUrl){
    url.username=username;
    url.password=String(password||'');
  }
  return url.toString();
};
const api=new pg.Pool({...common,connectionString:roleDatabaseUrl(process.env.DATABASE_URL,'janus_api',process.env.JANUS_POSTGRES_API_PASSWORD),max:1,options:`-c search_path=${schema}`});
const worker=new pg.Pool({...common,connectionString:roleDatabaseUrl(process.env.EVOLUTION_WORKER_DATABASE_URL,'janus_evolution_worker',process.env.JANUS_POSTGRES_WORKER_PASSWORD),max:1,options:`-c search_path=${schema}`});

try{
  await admin.query(`CREATE SCHEMA "${schema}"`);
  for(const file of (await fs.readdir(migrationsDir)).filter((item)=>item.endsWith('.sql')).sort()){
    let sql=await fs.readFile(path.join(migrationsDir,file),'utf8');
    if(file==='035_evolution_worker_security.sql')sql=sql.replaceAll('SCHEMA public',`SCHEMA "${schema}"`);
    await admin.query(sql);
  }
  const {publicKey,privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048,
    publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const keyId='worker-rehearsal-key';
  const plaintext='worker-only rehearsal evidence';
  const envelope=encryptEvolutionEnvelope(plaintext,{activeKeyId:keyId,keys:{[keyId]:publicKey}});
  await admin.query("INSERT INTO users(id,email,display_name,password_hash) VALUES('security_user','security@example.com','Security User','hash')");
  await admin.query("INSERT INTO cloud_agent_families_v3(id,name) VALUES('security_family','Security Agent')");
  await admin.query("INSERT INTO cloud_user_agent_instances_v3(user_id,id,agent_family_id,status,sync_enabled) VALUES('security_user','security_instance','security_family','active',true)");
  await api.query(`INSERT INTO cloud_evolution_evidence (
    evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,content_hash,
    content_ciphertext,content_nonce,content_tag,encryption_algorithm,key_id,wrapped_data_key,key_wrap_algorithm,
    key_version,envelope_format,validation_status
  ) VALUES ('security_evidence','security_user','security_instance','security_family','message','security_message',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending_validation')`,[
    crypto.createHash('sha256').update(plaintext).digest('hex'),envelope.ciphertext,envelope.nonce,envelope.tag,envelope.algorithm,
    envelope.keyId,envelope.wrappedDataKey,envelope.keyWrapAlgorithm,envelope.keyVersion,envelope.envelopeFormat,
  ]);

  const metadata=(await api.query("SELECT evidence_id,validation_status FROM cloud_evolution_evidence WHERE evidence_id='security_evidence'")).rows[0];
  if(metadata?.validation_status!=='pending_validation')throw new Error('API role could not read permitted Evidence metadata.');
  let ciphertextDenied=false;
  try{await api.query("SELECT content_ciphertext FROM cloud_evolution_evidence WHERE evidence_id='security_evidence'");}
  catch{ciphertextDenied=true;}
  if(!ciphertextDenied)throw new Error('API role unexpectedly read Evidence ciphertext.');
  let auditDenied=false;
  try{await api.query('SELECT * FROM cloud_evolution_evidence_access_audits');}
  catch{auditDenied=true;}
  if(!auditDenied)throw new Error('API role unexpectedly read Worker Evidence audits.');

  const encrypted=(await worker.query("SELECT * FROM cloud_evolution_evidence WHERE evidence_id='security_evidence'")).rows[0];
  const decrypted=decryptEvolutionPayload({algorithm:encrypted.encryption_algorithm,keyId:encrypted.key_id,
    ciphertext:encrypted.content_ciphertext,nonce:encrypted.content_nonce,tag:encrypted.content_tag,
    wrappedDataKey:encrypted.wrapped_data_key},{activeKeyId:keyId,keys:{[keyId]:privateKey}});
  if(decrypted!==plaintext)throw new Error('Worker role could not decrypt the Evidence envelope.');
  await worker.query(`INSERT INTO cloud_evolution_evidence_access_audits
    (id,worker_identity,evidence_id,purpose,result,key_id) VALUES('security_audit','rehearsal-worker','security_evidence','rehearsal','allowed',$1)`,[keyId]);
  console.log('Evolution Worker security PostgreSQL rehearsal passed: API ciphertext denial, Worker decryption, RLS, and audit isolation verified.');
}finally{
  await api.end().catch(()=>null);
  await worker.end().catch(()=>null);
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(()=>null);
  await admin.end().catch(()=>null);
}
