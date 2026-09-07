import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { codexContextRemainingPercent } from '../src/main/modules/codex/domain/codexContextUsage.js';
import { buildPlainChatPrompt } from '../src/main/prompts.js';
import { compressChatContextWithRefresh } from '../src/renderer/app/features/chat/contextUsageController.js';

assert.equal(codexContextRemainingPercent(0, 128_000), 100);
assert.equal(codexContextRemainingPercent(12_000, 128_000), 100);
assert.equal(codexContextRemainingPercent(17_483, 258_400), 98);
assert.equal(codexContextRemainingPercent(128_000, 128_000), 0);
assert.equal(codexContextRemainingPercent(1_000, 12_000), 0);

{
  const clearCalls = [];
  let statusCalls = 0;
  const result = await compressChatContextWithRefresh({
    api: {
      chatContextStatus: async () => ({ sessionId: 'context_retry_session', stateRevision: ++statusCalls === 1 ? 4 : 5 }),
      clearChatContext: async (payload) => {
        clearCalls.push(payload);
        if (clearCalls.length === 1) throw new Error('Chat context state changed on another device.');
        return { sessionId: payload.sessionId, stateRevision: 6, usagePercent: 0 };
      },
    },
    sessionId: 'context_retry_session',
    currentUsage: { sessionId: 'stale_other_session', stateRevision: 28, usagePercent: 28 },
    commandId: 'context_retry_once',
  });
  assert.deepEqual(clearCalls.map((item) => item.expectedStateRevision), [4, 5]);
  assert.equal(clearCalls[0].commandId, clearCalls[1].commandId);
  assert.equal(result.usagePercent, 0);
}

{
  const longSummary = `${'S'.repeat(4_000)}SUMMARY_TAIL_MARKER`;
  const prompt = buildPlainChatPrompt({
    userMessage: '继续任务',
    recentMessages: [
      { role: 'system', content: longSummary, metadata: { contextCompressionSummary: true } },
      { role: 'user', content: '压缩后新增消息' },
    ],
  });
  assert.match(prompt, /COMPRESSED CONTEXT SUMMARY/);
  assert.match(prompt, /SUMMARY_TAIL_MARKER/, 'compressed summaries must not be truncated to the ordinary 900-character message limit');
  assert.match(prompt, /压缩后新增消息/);
}

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-context-usage-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-context-usage-bin-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const fakeLog = path.join(binRoot, 'prompts.log');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousLog = process.env.JANUS_CONTEXT_PROMPT_LOG;

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex-cli context-smoke');process.exit(0);}
if(args.includes('app-server')&&args.includes('--help')){console.log('Usage: codex app-server [OPTIONS]');process.exit(0);}
if(args.includes('app-server')){
 const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
 const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
 for await(const line of lines){
  if(!line.trim())continue;
  const message=JSON.parse(line);
  if(message.method==='initialize')send({id:message.id,result:{userAgent:'context-smoke'}});
  else if(message.method==='thread/resume'){
   if(message.params?.threadId==='thread_missing')send({id:message.id,error:{code:-32004,message:'thread not found'}});
   else send({id:message.id,result:{thread:{id:message.params?.threadId||'thread_context_new'}}});
  }else if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'thread_context_new'}}});
  else if(message.method==='thread/memoryMode/set'||message.method?.startsWith('thread/goal/')){
   if(message.method==='thread/goal/get')send({id:message.id,result:{goal:null}});else send({id:message.id,result:{}});
  }else if(message.method==='thread/compact/start'){
   if(message.params?.threadId==='thread_unsupported'){
    send({id:message.id,error:{code:-32601,message:'unknown method'}});
    continue;
   }
   if(process.env.JANUS_CONTEXT_PROMPT_LOG)fs.appendFileSync(process.env.JANUS_CONTEXT_PROMPT_LOG,JSON.stringify({compactThreadId:message.params?.threadId||''})+'\\n');
   send({id:message.id,result:{}});
   send({method:'item/started',params:{threadId:message.params?.threadId||'',turnId:'compact-turn',item:{id:'compact-item',type:'contextCompaction'}}});
   send({method:'item/completed',params:{threadId:message.params?.threadId||'',turnId:'compact-turn',item:{id:'compact-item',type:'contextCompaction'}}});
  }else if(message.method==='turn/start'){
   const stdin=String(message.params?.input?.map((item)=>item?.text||'').join('\\n')||'');
   const inputTokens=stdin.includes('AUTO_COMPRESS_TRIGGER')?120000:105000;
   const splitUsage=stdin.includes('CUMULATIVE_USAGE_SPLIT');
   const totalInputTokens=splitUsage?60470:inputTokens;
   const lastInputTokens=splitUsage?17463:inputTokens;
   const modelContextWindow=stdin.includes('MODEL_WINDOW_1M')?1050000:splitUsage?258400:128000;
   if(process.env.JANUS_CONTEXT_PROMPT_LOG)fs.appendFileSync(process.env.JANUS_CONTEXT_PROMPT_LOG,JSON.stringify({stdin})+'\\n');
   send({id:message.id,result:{turn:{id:'context-turn'}}});
   if(splitUsage){
    send({method:'rawResponse/completed',params:{threadId:'thread_context_new',turnId:'context-turn',responseId:'context-response-1',usage:{totalTokens:43007,inputTokens:43007,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0}}});
    send({method:'rawResponse/completed',params:{threadId:'thread_context_new',turnId:'context-turn',responseId:'context-response-2',usage:{totalTokens:17483,inputTokens:17463,cachedInputTokens:12000,outputTokens:20,reasoningOutputTokens:0}}});
   }
   send({method:'thread/tokenUsage/updated',params:{threadId:'thread_context_new',turnId:'context-turn',tokenUsage:{total:{totalTokens:totalInputTokens+20,inputTokens:totalInputTokens,outputTokens:20},last:{totalTokens:lastInputTokens+20,inputTokens:lastInputTokens,cachedInputTokens:splitUsage?12000:0,outputTokens:20},modelContextWindow}}});
   if(stdin.includes('PROVIDER_NATIVE_COMPACTION')){
    send({method:'item/started',params:{threadId:'thread_context_new',turnId:'context-turn',item:{id:'provider-compact',type:'contextCompaction'}}});
    send({method:'item/completed',params:{threadId:'thread_context_new',turnId:'context-turn',item:{id:'provider-compact',type:'contextCompaction'}}});
   }
   send({method:'item/completed',params:{item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'CONTEXT_BOUNDARY_OK'}}});
   send({method:'turn/completed',params:{turn:{id:'context-turn',status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text:'CONTEXT_BOUNDARY_OK'}]}}});
  }else send({id:message.id,error:{code:-32601,message:'unsupported'}});
 }
}
`);
await chmod(fakeCodex, 0o755);
process.env.JANUS_CODEX_BIN = fakeCodex;
process.env.JANUS_CONTEXT_PROMPT_LOG = fakeLog;

const runtime = await createRuntime({ root, isDev: true });
try {
  const user = runtime.currentUser();
  const recordMeasuredContextUsage = ({
    sessionId, executionId, inputTokens, contextWindowTokens, contextSpaceId = '',
  }) => {
    runtime.store.beginModelExecution({
      id: executionId,
      userId: user.id,
      conversationId: sessionId,
      effectiveModel: 'gpt-5.6-sol',
      status: 'completed',
      metadata: {
        usage: {
          inputTokens,
          outputTokens: 0,
          cachedInputTokens: 0,
          totalTokens: inputTokens,
          contextInputTokens: inputTokens,
          contextMeasurementState: 'available',
          modelContextWindow: contextWindowTokens,
        },
      },
    });
    return runtime.store.recordChatContextUsage({
      ownerUserId: user.id,
      sessionId,
      contextSpaceId,
      executionId,
      inputTokens,
      contextWindowTokens,
    });
  };
  const session = runtime.store.createSession({ title: 'Long context', departmentId: 'general', userId: user.id });
  runtime.store.addMessage({ sessionId: session.id, role: 'user', content: 'OLD_CONTEXT_MUST_NOT_RETURN' });
  runtime.store.addMessage({ sessionId: session.id, role: 'assistant', content: '旧回答仍应保留在 UI 历史中' });
  runtime.store.updateSessionThread(session.id, 'thread_context_old');

  const initial = runtime.chatContextStatus({ sessionId: session.id });
  recordMeasuredContextUsage({ sessionId: session.id, executionId: 'usage_warning', inputTokens: 104800, contextWindowTokens: 128000 });
  let status = runtime.chatContextStatus({ sessionId: session.id });
  assert.equal(status.warningLevel, 'warning');
  assert.equal(status.usagePercent, 80);
  assert.equal(status.canSend, true);

  recordMeasuredContextUsage({ sessionId: session.id, executionId: 'usage_critical', inputTokens: 128000, contextWindowTokens: 128000 });
  status = runtime.chatContextStatus({ sessionId: session.id });
  assert.equal(status.warningLevel, 'critical');
  assert.equal(status.usagePercent, 100);
  assert.equal(status.canSend, true, 'context monitoring must never block sending');

  const commandId = 'context_clear_once';
  const cleared = await runtime.clearChatContext({ sessionId: session.id, commandId, expectedStateRevision: status.stateRevision });
  assert.equal(cleared.warningLevel, 'provider_compacted');
  assert.equal(cleared.usedTokens, 0);
  assert.equal(cleared.contextEpoch, initial.contextEpoch, 'native compaction must keep the Janus context epoch');
  assert.equal(runtime.store.listMessages(session.id).length, 2, 'compressing context must preserve visible history');
  const compressedPromptMessages = runtime.store.listMessagesForPrompt(session.id, { ownerUserId: user.id });
  assert.equal(compressedPromptMessages.length, 2, 'native compaction must not replace local messages with a synthetic summary');
  assert.equal(compressedPromptMessages.some((item) => item.metadata?.contextCompressionSummary), false);
  assert.equal(runtime.store.getSession(session.id).codexThreadId, 'thread_context_old');
  let logEntries = (await readFile(fakeLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(logEntries.filter((item) => item.compactThreadId).map((item) => item.compactThreadId), ['thread_context_old']);
  const repeated = await runtime.clearChatContext({ sessionId: session.id, commandId, expectedStateRevision: cleared.stateRevision });
  assert.equal(repeated.contextEpoch, cleared.contextEpoch, 'clear command must be idempotent');
  logEntries = (await readFile(fakeLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(logEntries.filter((item) => item.compactThreadId === 'thread_context_old').length, 1);
  assert.throws(() => runtime.store.recordChatContextNativeCompaction({
    ownerUserId: user.id,
    sessionId: session.id,
    commandId: 'stale_native_compaction',
    contextWindowTokens: cleared.contextWindowTokens,
    expectedStateRevision: cleared.stateRevision - 1,
  }), (error) => error?.code === 'chat_context_state_conflict',
  'native compaction state persistence must not overwrite a newer cross-device revision');

  const resetSession = runtime.store.createSession({ title: 'Explicit fresh context', departmentId: 'general', userId: user.id });
  runtime.store.addMessage({ sessionId: resetSession.id, role: 'user', content: 'RESET_CONTEXT_HISTORY_MUST_STAY_VISIBLE' });
  runtime.store.addMessage({ sessionId: resetSession.id, role: 'assistant', content: '历史回答仍保留在界面中' });
  runtime.store.updateSessionThread(resetSession.id, 'thread_reset_context_old');
  const resetBefore = runtime.chatContextStatus({ sessionId: resetSession.id });
  const resetAfter = runtime.resetChatContext({
    sessionId: resetSession.id,
    commandId: 'explicit_fresh_context_once',
    expectedStateRevision: resetBefore.stateRevision,
  });
  assert.equal(resetAfter.contextEpoch, resetBefore.contextEpoch + 1, 'explicit reset must advance the context epoch');
  assert.equal(runtime.store.getSession(resetSession.id).codexThreadId, '', 'explicit reset must start the next turn on a fresh Codex thread');
  assert.equal(runtime.store.listMessages(resetSession.id).length, 2, 'explicit reset must preserve visible conversation history');
  assert.equal(runtime.store.listMessagesForPrompt(resetSession.id, { ownerUserId: user.id }).length, 0,
    'explicit reset must exclude the previous conversation from the next prompt');
  const resetRepeated = runtime.resetChatContext({
    sessionId: resetSession.id,
    commandId: 'explicit_fresh_context_once',
    expectedStateRevision: resetAfter.stateRevision,
  });
  assert.equal(resetRepeated.contextEpoch, resetAfter.contextEpoch, 'explicit reset command must be idempotent');

  const result = await runtime.sendChat({ sessionId: session.id, chatMode: 'normal', message: 'NEW_CONTEXT_MESSAGE' });
  assert.equal(result.answer, 'CONTEXT_BOUNDARY_OK');
  const prompts = (await readFile(fakeLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).stdin).filter(Boolean);
  const latestPrompt = prompts.at(-1) || '';
  assert.match(latestPrompt, /NEW_CONTEXT_MESSAGE/);
  assert.doesNotMatch(latestPrompt, /COMPRESSED CONTEXT SUMMARY/);
  assert.equal(runtime.store.listMessages(session.id).length, 4, 'new turn must append without deleting old history');

  const execution = runtime.store.getModelExecution(result.message.metadata.modelExecutionId);
  assert.equal(execution.metadata.usage.inputTokens, 105000, 'real Codex usage must be persisted on the execution');
  const afterTurn = runtime.chatContextStatus({ sessionId: session.id });
  assert.equal(afterTurn.warningLevel, 'warning');
  assert.equal(afterTurn.canSend, true);

  runtime.store.markChatContextProviderCompaction({ ownerUserId: user.id, sessionId: session.id });
  const compacted = runtime.chatContextStatus({ sessionId: session.id });
  assert.equal(compacted.warningLevel, 'provider_compacted');
  assert.equal(compacted.canSend, true);
  assert.equal(runtime.store.getSession(session.id).codexThreadId, 'thread_context_old', 'provider compaction warning must not reset the thread');

  const automaticSession = runtime.store.createSession({ title: 'Automatic context compression', departmentId: 'general', userId: user.id });
  const automaticResult = await runtime.sendChat({ sessionId: automaticSession.id, chatMode: 'normal', message: 'AUTO_COMPRESS_TRIGGER' });
  assert.equal(automaticResult.answer, 'CONTEXT_BOUNDARY_OK');
  const automaticStatus = runtime.chatContextStatus({ sessionId: automaticSession.id });
  assert.equal(automaticStatus.warningLevel, 'critical', 'Janus must leave automatic compaction timing to Codex model defaults');
  assert.equal(runtime.store.listMessages(automaticSession.id).length, 2, 'critical usage must preserve visible history');
  assert.equal(runtime.store.listMessagesForPrompt(automaticSession.id, { ownerUserId: user.id }).some((item) => item.metadata?.contextCompressionSummary), false);
  logEntries = (await readFile(fakeLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(logEntries.some((item) => item.compactThreadId === runtime.store.getSession(automaticSession.id).codexThreadId), false,
    'Janus must not launch a second automatic compaction alongside Codex auto-compaction');

  const generalInstance = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' });
  assert.ok(generalInstance);
  const agentSession = runtime.store.createSession({
    title: 'Agent context compression', departmentId: 'general', agentId: 'general_agent',
    agentInstanceId: generalInstance.id, userId: user.id,
  });
  const deviceId = runtime.store.contextDeviceId();
  const memoryStateBefore = runtime.store.getDeviceContextState({ deviceId, userId: user.id, agentInstanceId: generalInstance.id });
  const memoryBefore = runtime.store.getMemoryDocument(memoryStateBefore.activeMemoryDocumentId);
  runtime.store.addMessage({ sessionId: agentSession.id, role: 'user', content: '保留当前 Memory，但压缩这段短期对话。', agentId: 'general_agent' });
  runtime.store.addMessage({ sessionId: agentSession.id, role: 'assistant', content: '已记录短期任务状态。', agentId: 'general_agent' });
  runtime.store.updateSessionThread(agentSession.id, 'thread_agent_context_old');
  recordMeasuredContextUsage({ sessionId: agentSession.id, contextSpaceId: memoryStateBefore.activeContextSpaceId,
    executionId: 'agent_context_usage', inputTokens: 36000, contextWindowTokens: 128000 });
  const agentStatus = runtime.chatContextStatus({ sessionId: agentSession.id });
  await runtime.clearChatContext({ sessionId: agentSession.id, commandId: 'compress_agent_context', expectedStateRevision: agentStatus.stateRevision });
  const memoryStateAfter = runtime.store.getDeviceContextState({ deviceId, userId: user.id, agentInstanceId: generalInstance.id });
  const memoryAfter = runtime.store.getMemoryDocument(memoryStateAfter.activeMemoryDocumentId);
  assert.equal(memoryStateAfter.activeContextSpaceId, memoryStateBefore.activeContextSpaceId, 'compression must not switch Context Space');
  assert.equal(memoryStateAfter.activeMemoryDocumentId, memoryStateBefore.activeMemoryDocumentId, 'compression must not switch Memory');
  assert.equal(memoryAfter.currentVersionId, memoryBefore.currentVersionId, 'compression must not create a Memory version');
  assert.equal(runtime.listMessages(agentSession.id).length, 2, 'compression must preserve all visible Agent records');
  const agentPromptMessages = runtime.store.listMessagesForPrompt(agentSession.id, { ownerUserId: user.id,
    contextSpaceId: memoryStateAfter.activeContextSpaceId, includeAllContexts: false });
  assert.equal(agentPromptMessages.length, 2);
  assert.equal(agentPromptMessages.some((item) => item.metadata?.contextCompressionSummary), false);
  assert.equal(runtime.store.getSession(agentSession.id).codexThreadId, 'thread_agent_context_old');

  const agentContinued = await runtime.sendChat({
    sessionId: agentSession.id,
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: generalInstance.id,
    chatMode: 'agent',
    routePreference: 'explicit',
    message: 'AGENT_CONTINUE_AFTER_NATIVE_COMPACTION',
  });
  assert.equal(agentContinued.answer, 'CONTEXT_BOUNDARY_OK');
  logEntries = (await readFile(fakeLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const refreshedAgentPrompt = logEntries.map((item) => item.stdin).filter(Boolean).at(-1) || '';
  assert.match(refreshedAgentPrompt, /Current Janus Memory context:/,
    'the first Agent turn after native compaction must refresh the active Janus Memory');
  assert.match(refreshedAgentPrompt, /AGENT_CONTINUE_AFTER_NATIVE_COMPACTION/);
  assert.notEqual(runtime.chatContextStatus({ sessionId: agentSession.id }).warningLevel, 'provider_compacted',
    'a successful post-compaction Agent turn must acknowledge the runtime-context refresh');

  const millionWindowSession = runtime.store.createSession({ title: 'Provider model window', departmentId: 'general', userId: user.id });
  const millionWindowResult = await runtime.sendChat({
    sessionId: millionWindowSession.id,
    chatMode: 'normal',
    message: 'MODEL_WINDOW_1M',
  });
  assert.equal(millionWindowResult.answer, 'CONTEXT_BOUNDARY_OK');
  const millionWindowStatus = runtime.chatContextStatus({ sessionId: millionWindowSession.id });
  assert.equal(millionWindowStatus.contextWindowTokens, 1_050_000,
    'the provider-reported modelContextWindow must override the 128K catalog fallback');
  assert.equal(millionWindowStatus.usagePercent, 9);

  const splitUsageSession = runtime.store.createSession({ title: 'Cumulative versus last request', departmentId: 'general', userId: user.id });
  const splitUsageResult = await runtime.sendChat({
    sessionId: splitUsageSession.id,
    chatMode: 'normal',
    message: 'CUMULATIVE_USAGE_SPLIT',
  });
  const splitUsageExecution = runtime.store.getModelExecution(splitUsageResult.message.metadata.modelExecutionId);
  assert.equal(splitUsageExecution.metadata.usage.inputTokens, 17_463,
    'per-execution usage must use tokenUsage.last, not the cumulative thread total');
  assert.equal(splitUsageExecution.metadata.threadTokenUsage.inputTokens, 60_470,
    'the cumulative tokenUsage.total snapshot must remain available separately');
  assert.equal(splitUsageExecution.metadata.threadTokenUsage.last.inputTokens, 17_463);
  const splitUsageLedger = runtime.db.prepare(`SELECT raw_total_tokens,input_tokens,output_tokens,cached_input_tokens
    FROM managed_provider_usage_events WHERE execution_id=?`).get(splitUsageResult.message.metadata.modelExecutionId);
  assert.equal(splitUsageLedger.raw_total_tokens, 60_490,
    'the shared quota ledger must sum every upstream model response in the Codex turn');
  assert.equal(splitUsageLedger.input_tokens, 60_470);
  assert.equal(splitUsageLedger.output_tokens, 20);
  assert.equal(splitUsageLedger.cached_input_tokens, 12_000, 'cached input remains diagnostic and is not charged twice');
  const splitUsageStatus = runtime.chatContextStatus({ sessionId: splitUsageSession.id });
  assert.equal(splitUsageStatus.usedTokens, 17_483);
  assert.equal(splitUsageStatus.contextWindowTokens, 258_400);
  assert.equal(splitUsageStatus.remainingPercent, 98);
  assert.equal(splitUsageStatus.usagePercent, 2,
    'context percentage must match Codex CLI baseline-adjusted last.totalTokens calculation');

  const legacyUsageSession = runtime.store.createSession({ title: 'Legacy cumulative measurement', departmentId: 'general', userId: user.id });
  runtime.store.updateSessionThread(legacyUsageSession.id, 'thread_legacy_cumulative');
  runtime.store.beginModelExecution({
    id: 'legacy_cumulative_usage',
    userId: user.id,
    conversationId: legacyUsageSession.id,
    effectiveModel: 'gpt-5.6-sol',
    status: 'completed',
    metadata: { usage: { inputTokens: 60_470, outputTokens: 100, totalTokens: 60_570, modelContextWindow: 258_400 } },
  });
  runtime.store.recordChatContextUsage({
    ownerUserId: user.id,
    sessionId: legacyUsageSession.id,
    executionId: 'legacy_cumulative_usage',
    inputTokens: 60_470,
    contextWindowTokens: 258_400,
  });
  const legacyUsageStatus = runtime.chatContextStatus({ sessionId: legacyUsageSession.id });
  assert.equal(legacyUsageStatus.measurementState, 'unknown',
    'persisted measurements without an explicit last-request basis must not be treated as active context');
  assert.equal(legacyUsageStatus.usagePercent, 0);

  const providerEventSession = runtime.store.createSession({ title: 'Provider compaction item', departmentId: 'general', userId: user.id });
  await runtime.sendChat({ sessionId: providerEventSession.id, chatMode: 'normal', message: 'PROVIDER_NATIVE_COMPACTION' });
  assert.equal(runtime.chatContextStatus({ sessionId: providerEventSession.id }).warningLevel, 'provider_compacted',
    'the current contextCompaction item must be detected without relying on deprecated thread/compacted');
  await runtime.sendChat({ sessionId: providerEventSession.id, chatMode: 'normal', message: 'ACK_PROVIDER_NATIVE_COMPACTION' });
  assert.notEqual(runtime.chatContextStatus({ sessionId: providerEventSession.id }).warningLevel, 'provider_compacted');

  const fallbackSession = runtime.store.createSession({ title: 'Native compaction fallback', departmentId: 'general', userId: user.id });
  runtime.store.addMessage({ sessionId: fallbackSession.id, role: 'user', content: 'FALLBACK_CONTEXT_MUST_SURVIVE' });
  runtime.store.updateSessionThread(fallbackSession.id, 'thread_missing');
  recordMeasuredContextUsage({
    sessionId: fallbackSession.id, executionId: 'fallback_context_usage',
    inputTokens: 120000, contextWindowTokens: 128000,
  });
  const fallbackBefore = runtime.chatContextStatus({ sessionId: fallbackSession.id });
  const fallbackCompressed = await runtime.clearChatContext({
    sessionId: fallbackSession.id,
    commandId: 'fallback_context_compress',
    expectedStateRevision: fallbackBefore.stateRevision,
  });
  assert.equal(fallbackCompressed.warningLevel, 'normal');
  assert.equal(runtime.store.getSession(fallbackSession.id).codexThreadId, '');
  const fallbackPromptMessages = runtime.store.listMessagesForPrompt(fallbackSession.id, { ownerUserId: user.id });
  assert.equal(fallbackPromptMessages.length, 1);
  assert.equal(fallbackPromptMessages[0].metadata?.contextCompressionSummary, true);
  assert.match(fallbackPromptMessages[0].content, /FALLBACK_CONTEXT_MUST_SURVIVE/);

  const unsupportedSession = runtime.store.createSession({ title: 'Unsupported native compaction', departmentId: 'general', userId: user.id });
  runtime.store.addMessage({ sessionId: unsupportedSession.id, role: 'user', content: 'UNSUPPORTED_NATIVE_FALLBACK_MARKER' });
  runtime.store.updateSessionThread(unsupportedSession.id, 'thread_unsupported');
  const unsupportedBefore = runtime.chatContextStatus({ sessionId: unsupportedSession.id });
  await runtime.clearChatContext({
    sessionId: unsupportedSession.id,
    commandId: 'unsupported_native_fallback',
    expectedStateRevision: unsupportedBefore.stateRevision,
  });
  const unsupportedPromptMessages = runtime.store.listMessagesForPrompt(unsupportedSession.id, { ownerUserId: user.id });
  assert.equal(unsupportedPromptMessages.length, 1);
  assert.equal(unsupportedPromptMessages[0].metadata?.contextCompressionSummary, true);
  assert.match(unsupportedPromptMessages[0].content, /UNSUPPORTED_NATIVE_FALLBACK_MARKER/);

  const resumeFallbackSession = runtime.store.createSession({
    title: 'Resume fallback bootstrap', departmentId: 'general', agentId: 'general_agent',
    agentInstanceId: generalInstance.id, userId: user.id,
  });
  runtime.store.addMessage({
    sessionId: resumeFallbackSession.id,
    role: 'assistant',
    content: 'RESUME_FALLBACK_HISTORY_MARKER',
    agentId: 'general_agent',
    agentInstanceId: generalInstance.id,
    contextSpaceId: memoryStateAfter.activeContextSpaceId,
  });
  runtime.store.updateSessionThread(resumeFallbackSession.id, 'thread_missing');
  await runtime.sendChat({
    sessionId: resumeFallbackSession.id,
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: generalInstance.id,
    chatMode: 'agent',
    routePreference: 'explicit',
    message: 'RESUME_FALLBACK_CURRENT_MESSAGE',
  });
  logEntries = (await readFile(fakeLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const resumeFallbackPrompt = logEntries.map((item) => item.stdin).filter(Boolean).at(-1) || '';
  assert.match(resumeFallbackPrompt, /Current Janus Memory context:/);
  assert.match(resumeFallbackPrompt, /RESUME_FALLBACK_HISTORY_MARKER/,
    'a failed thread resume must use the full bootstrap prompt instead of the lightweight resume prompt');

  console.log('context usage smoke passed');
} finally {
  runtime.close();
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN; else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousLog === undefined) delete process.env.JANUS_CONTEXT_PROMPT_LOG; else process.env.JANUS_CONTEXT_PROMPT_LOG = previousLog;
  await rm(root, { recursive: true, force: true });
  await rm(binRoot, { recursive: true, force: true });
}
