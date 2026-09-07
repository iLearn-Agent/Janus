import { spawnSync } from 'node:child_process';

const databaseUrl=String(process.env.JANUS_REHEARSAL_DATABASE_URL||'').trim();
const allowed=String(process.env.JANUS_ALLOW_DATABASE_REHEARSAL||'').toLowerCase()==='true';
if(!databaseUrl||!allowed){
  console.error('Real PostgreSQL production gate requires JANUS_REHEARSAL_DATABASE_URL and JANUS_ALLOW_DATABASE_REHEARSAL=true.');
  process.exit(2);
}

const scripts=[
  'cloud_sync_v6_postgres_rehearsal.mjs',
  'cloud_employee_postgres_rehearsal.mjs',
  'evolution_worker_security_postgres_rehearsal.mjs',
  'cluster_evolution_postgres_rehearsal.mjs',
];
for(const script of scripts){
  const result=spawnSync(process.execPath,[new URL(script,import.meta.url).pathname],{stdio:'inherit',env:process.env});
  if(result.status!==0)process.exit(result.status||1);
}
console.log('Real PostgreSQL production gate passed.');
