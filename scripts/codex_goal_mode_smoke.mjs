import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCodexSession, updateCodexGoal } from '../src/main/codex.js';
import { saveCodexConfig } from '../src/main/codexConfig.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-codex-goal-'));
const fakeCodex = path.join(root, 'fake-codex-goal.mjs');
const requestLog = path.join(root, 'goal-set.log');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousLog = process.env.JANUS_GOAL_SET_LOG;
const previousMode = process.env.JANUS_GOAL_FIXTURE_MODE;

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args=process.argv.slice(2);
if(args[0]==='app-server'&&args.includes('--help')){console.log('Usage: codex app-server');process.exit(0);}
if(args[0]!=='app-server')process.exit(2);
const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
const mode=process.env.JANUS_GOAL_FIXTURE_MODE||'replace';
let goal={objective:'旧目标不能被复用',status:'active',tokenBudget:1000,tokensUsed:25,timeUsedSeconds:2};
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of lines){
  if(!line.trim())continue;
  const message=JSON.parse(line);
  if(!message.method||message.id==null)continue;
  if(message.method==='initialize')send({id:message.id,result:{}});
  else if(message.method==='thread/start'||message.method==='thread/resume')send({id:message.id,result:{thread:{id:'goal-thread'}}});
  else if(message.method==='thread/memoryMode/set')send({id:message.id,result:{}});
  else if(message.method==='thread/goal/get')send({id:message.id,result:{goal}});
  else if(message.method==='thread/goal/set'){
    fs.appendFileSync(process.env.JANUS_GOAL_SET_LOG,JSON.stringify({mode,params:message.params})+'\\n');
    goal={...goal,...message.params};delete goal.threadId;
    send({id:message.id,result:{goal}});
  }else if(message.method==='thread/goal/clear'){
    fs.appendFileSync(process.env.JANUS_GOAL_SET_LOG,JSON.stringify({mode,method:'clear',params:message.params})+'\\n');
    goal=null;send({id:message.id,result:{}});
  }else if(message.method==='turn/start'){
    send({id:message.id,result:{turn:{id:'goal-turn'}}});
    send({method:'item/completed',params:{item:{id:'goal-answer',type:'agentMessage',phase:'final_answer',text:'GOAL_OK'}}});
    send({method:'turn/completed',params:{turn:{id:'goal-turn',status:'completed',items:[{id:'goal-answer',type:'agentMessage',phase:'final_answer',text:'GOAL_OK'}]}}});
  }else send({id:message.id,error:{code:-32601,message:'unsupported '+message.method}});
}
`);
chmodSync(fakeCodex, 0o755);

try {
  process.env.JANUS_CODEX_BIN = fakeCodex;
  process.env.JANUS_GOAL_SET_LOG = requestLog;
  saveCodexConfig(root, { baseUrl: 'https://provider.invalid/v1', apiKey: 'fake-key' });

  process.env.JANUS_GOAL_FIXTURE_MODE = 'replace';
  const replaced = await runCodexSession({
    root, cwd: root, sessionId: 'goal-replace-session', threadId: 'goal-thread', prompt: '设置新目标',
    permissionMode: 'request-approval', interactionMode: 'goal', goalObjective: '新的可靠目标',
    replaceGoal: true, timeoutMs: 5_000,
  });
  assert.equal(replaced.answer, 'GOAL_OK');

  process.env.JANUS_GOAL_FIXTURE_MODE = 'budget';
  const continued = await runCodexSession({
    root, cwd: root, sessionId: 'goal-budget-session', threadId: 'goal-thread', prompt: '继续推进',
    permissionMode: 'request-approval', interactionMode: 'goal', goalObjective: '本轮消息不应覆盖目标',
    replaceGoal: false, timeoutMs: 5_000,
  });
  assert.equal(continued.answer, 'GOAL_OK');

  const paused = await updateCodexGoal({ root, cwd: root, sessionId: 'goal-action-session', threadId: 'goal-thread', action: 'pause', timeoutMs: 5_000 });
  assert.equal(paused.goal.status, 'paused');
  const edited = await updateCodexGoal({ root, cwd: root, sessionId: 'goal-action-session', threadId: 'goal-thread', action: 'edit', objective: '编辑后的目标', timeoutMs: 5_000 });
  assert.equal(edited.goal.objective, '编辑后的目标');
  const deleted = await updateCodexGoal({ root, cwd: root, sessionId: 'goal-action-session', threadId: 'goal-thread', action: 'delete', timeoutMs: 5_000 });
  assert.equal(deleted.goal, null);

  const requests = readFileSync(requestLog, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(requests[0].params, {
    threadId: 'goal-thread', objective: '新的可靠目标', status: 'active', tokenBudget: null,
  });
  assert.deepEqual(requests[1].params, {
    threadId: 'goal-thread', objective: '旧目标不能被复用', status: 'active', tokenBudget: null,
  });
  assert.equal(requests[2].params.status, 'paused');
  assert.equal(requests[2].params.tokenBudget, null);
  assert.equal(requests[3].params.objective, '编辑后的目标');
  assert.equal(requests[3].params.tokenBudget, null);
  assert.equal(requests[4].method, 'clear');
  console.log('Codex Goal lifecycle smoke passed.');
} finally {
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN; else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousLog === undefined) delete process.env.JANUS_GOAL_SET_LOG; else process.env.JANUS_GOAL_SET_LOG = previousLog;
  if (previousMode === undefined) delete process.env.JANUS_GOAL_FIXTURE_MODE; else process.env.JANUS_GOAL_FIXTURE_MODE = previousMode;
  await rm(root, { recursive: true, force: true });
}
