import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { OpenAIImagesClient, normalizeOpenAiApiBase } from '../network/clients/openaiImagesClient.js';
import { classifyImageIntent } from '../src/main/imageIntent.js';
import { sendImageChat } from '../src/main/modules/artifacts/application/sendImageChat.js';
import { completeImageGeneration, reserveImageGeneration } from '../src/main/managedProviderUsage.js';
import { extractPptImageRequests, generatePptHostImages, recoverPartialPptResult, renderPptArtifact } from '../src/main/pptRenderer.js';
import { createRuntime, pptRenderFailureDetails } from '../src/main/runtime.js';
import { readZipEntries } from '../src/main/zip.js';


assert.equal(
  normalizeOpenAiApiBase('[https://provider.example.com/v1](https://provider.example.com/v1)'),
  'https://provider.example.com/v1',
);
assert.equal(
  normalizeOpenAiApiBase('[https://provider.example.com/v1]'),
  'https://provider.example.com/v1',
);
assert.throws(() => normalizeOpenAiApiBase('not a url'), /图片服务地址无效/);

function createUsageDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE managed_provider_usage_events (
    id TEXT PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL DEFAULT '',
    account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',provider_scope_id TEXT NOT NULL,
    device_id TEXT NOT NULL DEFAULT 'local',execution_id TEXT NOT NULL DEFAULT '',session_id TEXT NOT NULL DEFAULT '',
    thread_id TEXT NOT NULL DEFAULT '',turn_id TEXT NOT NULL DEFAULT '',agent_id TEXT NOT NULL DEFAULT '',
    agent_instance_id TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',reasoning_effort TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0,cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
    raw_total_tokens INTEGER NOT NULL DEFAULT 0,charged_tokens INTEGER NOT NULL DEFAULT 0,usage_source TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'completed',private_assistant INTEGER NOT NULL DEFAULT 0,quota_day TEXT NOT NULL,
    occurred_at TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  return db;
}

{
  const creationRequests = [
    '生成一张小狗图片',
    '帮我画一幅城市夜景插画',
    'Create a watercolor image of a puppy',
    '海报设计并生成一张图片',
    '生成图片，提示词：一只在草地奔跑的小狗',
    '给我生成一张讲述《荆轲刺秦》的漫画',
    'Create a comic about Jing Ke attempting to assassinate the King of Qin',
  ];
  for (const message of creationRequests) {
    assert.deepEqual(classifyImageIntent(message).intent, 'creation', message);
    assert.equal(classifyImageIntent(message).explicit, true, message);
  }
  const editRequests = [
    '修改上一张图片，把背景换成蓝色',
    '把这张照片编辑成水彩风格',
  ];
  for (const message of editRequests) assert.equal(classifyImageIntent(message).intent, 'edit', message);
  assert.equal(classifyImageIntent('把背景换成蓝色', { attachments: [{ name: 'dog.png', type: 'image/png' }] }).intent, 'edit');

  const textRequests = [
    '怎么生成图片？请介绍原理',
    '如何生成一张小狗图片？请教我步骤',
    '写一个生成小狗图片的程序',
    '修改图片的代码应该怎么写',
    '写一段调用 Images API 的代码',
    '分析这张图片里的内容',
    '搜索几张小狗图片',
    '不要生成图片，只给我提示词',
    '把“生成一张小狗图片”翻译成英文',
    '怎么制作漫画？请介绍步骤',
    '写一个漫画生成程序',
  ];
  for (const message of textRequests) assert.equal(classifyImageIntent(message).explicit, false, message);
}

{
  const root = await mkdtemp(path.join(os.tmpdir(), 'janus-image-auto-route-'));
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4VQAAAAASUVORK5CYII=';
  const imageRequests = [];
  const server = createServer((request, response) => {
    if (request.url === '/v1/images/generations' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        imageRequests.push(JSON.parse(body || '{}'));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ b64_json: pngBase64 }], usage: {
          total_tokens: 1_800, input_tokens: 40, output_tokens: 1_760,
          input_tokens_details: { text_tokens: 40, image_tokens: 0 },
        } }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let runtime = null;
  try {
    const port = server.address().port;
    await mkdir(path.join(root, 'config', 'codex'), { recursive: true });
    await writeFile(path.join(root, 'config', 'codex', 'auth.json'), `${JSON.stringify({
      OPENAI_IMAGE_API_KEY: 'fake-image-key',
      OPENAI_IMAGE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    }, null, 2)}\n`);
    runtime = await createRuntime({
      root,
      isDev: true,
      serverAuthoritativeSkills: true,
    });
    const user = runtime.currentUser();
    const instance = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' });
    assert.ok(instance?.id);
    const session = runtime.store.createSession({
      title: '通用 Agent 自动生图', userId: user.id, departmentId: 'general',
      agentId: 'general_agent', agentInstanceId: instance.id,
    });
    const events = [];
    const result = await runtime.sendChat({
      sessionId: session.id,
      departmentId: 'general',
      agentId: 'general_agent',
      agentInstanceId: instance.id,
      routePreference: 'explicit',
      chatMode: 'agent',
      message: '给我生成一张讲述《荆轲刺秦》的漫画',
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.session.id, session.id, 'automatic image routing must preserve the current Agent session');
    assert.equal(result.image.kind, 'image');
    assert.equal(path.dirname(result.image.path), path.join(root, 'outputs', session.id));
    assert.equal(result.image.workspace_relative_path, `outputs/${session.id}/${path.basename(result.image.path)}`);
    const routing = events.find((event) => event.kind === 'routing');
    assert.equal(routing?.automaticRoute, true);
    assert.match(routing?.reason || '', /已自动切换至 GPT Image-2/);
    assert.equal(runtime.store.listMessages(session.id).some((message) => message.metadata?.artifact?.kind === 'image'), true);
    assert.equal(imageRequests.length, 1);
    assert.equal(imageRequests[0].model, 'gpt-image-2');
    assert.equal(imageRequests[0].size, '1024x1024');
    assert.equal(imageRequests[0].n, 1);
  } finally {
    try { runtime?.close(); } catch {}
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

{
  const fetchImpl = (_url, { signal } = {}) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason || new Error('aborted')), { once: true });
  });
  const client = new OpenAIImagesClient({ apiKey: 'test-key', fetchImpl, timeoutMs: 1_000 });
  await assert.rejects(
    () => client.generateImage({ model: 'gpt-image-2', prompt: 'test', size: '1024x1024', n: 1 }),
    /图片生成处理超过 1 秒/,
  );
}

{
  let downloadSignal = null;
  const fetchImpl = (_url, { signal } = {}) => {
    downloadSignal = signal;
    return new Promise((_resolve, reject) => {
      const rejectCancelled = () => reject(signal?.reason || new Error('aborted'));
      if (signal?.aborted) rejectCancelled();
      else signal?.addEventListener('abort', rejectCancelled, { once: true });
    });
  };
  const client = new OpenAIImagesClient({ apiKey: 'test-key', fetchImpl, downloadTimeoutMs: 60_000 });
  const controller = new AbortController();
  const downloading = client.imageBytesFromResponse(
    { data: [{ url: 'http://127.0.0.1/pending-image.png' }] },
    'image generation',
    { signal: controller.signal },
  );
  controller.abort(new Error('user cancelled image download'));
  await assert.rejects(() => downloading, /user cancelled image download/);
  assert.equal(downloadSignal?.aborted, true, 'image download must receive the chat cancellation signal');
}

{
  const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ppt-shared-image-service-'));
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAkCAIAAAC2bqvFAAAAR0lEQVR4nO3PQQ3AIADAQMAKrhCG3ongcVnSU9DOfe74s6UDXjWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaB9EzYBW8fPQ3oAAAAASUVORK5CYII=';
  const requests = [];
  const server = createServer((request, response) => {
    if (request.url === '/v1/images/generations' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        requests.push(JSON.parse(body || '{}'));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ b64_json: pngBase64 }], usage: {} }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const usageDb = createUsageDb();
  const quotaStore = { db: usageDb, contextDeviceId: () => 'ppt-test-device' };
  try {
    const port = server.address().port;
    await mkdir(path.join(root, 'config', 'codex'), { recursive: true });
    await writeFile(path.join(root, 'config', 'codex', 'auth.json'), `${JSON.stringify({
      OPENAI_IMAGE_API_KEY: 'fake-image-key',
      OPENAI_IMAGE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    }, null, 2)}\n`);
    const templateDirectory = path.join(root, 'departments', 'ppt_department', 'templates');
    await mkdir(templateDirectory, { recursive: true });
    for (const filename of ['通用多功能PPT模板.pptx', '哈工深多功能PPT模板.pptx', '华工多功能PPT模板.pptx']) {
      await copyFile(
        path.join(repositoryRoot, 'assets', 'departments', 'ppt_department', 'templates', filename),
        path.join(templateDirectory, filename),
      );
    }
    const answer = [
      '```janus-slide-plan',
      '| layout_id | title | message | proof_object | visual | speaker_note | time |',
      '|---|---|---|---|---|---|---|',
      '| cover | 生成式推荐 | 从预测到生成 | cover | editable cover | intro | 1m |',
      '| basic_content | 推荐场景正在改变 | 用户与智能助手共同完成决策 | scene | 生成插图：真实用户在客厅中通过平板与智能购物助手协作比较商品，纪实编辑插画，柔和自然光，无文字 | explain | 2m |',
      '| summary_takeaways | 总结 | 可交互、可解释、可行动 | cards | editable cards | close | 1m |',
      '```',
    ].join('\n');
    assert.deepEqual(extractPptImageRequests(answer), [{
      slideIndex: 2,
      title: '推荐场景正在改变',
      prompt: '真实用户在客厅中通过平板与智能购物助手协作比较商品，纪实编辑插画，柔和自然光，无文字',
    }]);
    const progress = [];
    const result = await generatePptHostImages({
      root,
      store: quotaStore,
      userId: 'ppt-image-smoke',
      quotaEventPrefix: 'ppt-host-direct',
      sessionId: 'shared-image-ppt',
      assistantAnswer: answer,
      selectedStyle: 'academic_report',
      onProgress: (event) => progress.push(event),
    });
    assert.equal(Object.keys(result.images).join(','), '2');
    assert.equal(result.errors.length, 0);
    assert.equal(existsSync(result.images[2]), true);
    assert.equal(
      result.images[2].startsWith(`${path.join(root, 'outputs', 'shared-image-ppt', 'ppt-assets', 'host-imagegen')}${path.sep}`),
      true,
      'PPT Images API output must be stored below outputs/<sessionId>',
    );
    assert.equal(requests.length, 1, 'PPT host image generation must call the Images HTTP API once');
    assert.equal(requests[0].model, 'gpt-image-2');
    assert.equal(requests[0].size, '1024x1024');
    assert.equal('quality' in requests[0], false);
    assert.equal(progress.some((event) => /复用图片生成服务/.test(event.message || '')), true);
    const templates = ['none', 'hitsz', 'scut'];
    for (const [index, selectedTemplate] of templates.entries()) {
      const sessionId = `shared-image-ppt-render-${selectedTemplate}`;
      const artifactOutputRoot = path.join(root, 'outputs', sessionId);
      const deck = await renderPptArtifact({
        root,
        store: quotaStore,
        quotaEventPrefix: `ppt-render-${selectedTemplate}`,
        outputRoot: artifactOutputRoot,
        artifactRoot: root,
        userId: 'ppt-image-smoke',
        sessionId,
        agentId: 'ppt',
        userMessage: '生成一份包含真实配图的测试 PPT',
        assistantAnswer: answer,
        selectedStyle: 'academic_report',
        selectedTemplate,
      });
      assert.equal(existsSync(deck.deck), true);
      assert.equal(deck.deck.startsWith(`${artifactOutputRoot}${path.sep}`), true);
      assert.equal(deck.deck_file.workspace_relative_path.startsWith(`outputs/${sessionId}/`), true);
      assert.equal(
        requests.length,
        index + 2,
        `${selectedTemplate} PPT render must call the Images HTTP API exactly once`,
      );
      assert.equal(deck.template, selectedTemplate);
      assert.equal(
        [...readZipEntries(deck.deck).keys()].some((name) => name.startsWith('ppt/media/')),
        true,
        `the host-generated image must be embedded in the ${selectedTemplate} PPTX package`,
      );
      assert.equal(deck.preview_warnings.some((warning) => /整份 PPT 没有可用的内容图片/.test(warning)), false);
    }
    const pptQuota = usageDb.prepare(`SELECT COUNT(*) AS count FROM managed_provider_usage_events
      WHERE user_id='ppt-image-smoke' AND usage_source='image_usage_unlimited_v2' AND status='completed'`).get();
    assert.equal(Number(pptQuota?.count || 0), 4, 'every custom-provider PPT image must be tracked without consuming a managed image slot');

    const managedImageProvider = {
      managedProvider: true,
      limited: true,
      providerScopeId: 'janus_image_generation_quota_v1',
    };
    const seedManagedImageUsage = (userId, count) => {
      for (let index = 0; index < count; index += 1) {
        const eventKey = `ppt-quota-seed:${userId}:${index}`;
        reserveImageGeneration(quotaStore, { userId, eventKey, providerState: managedImageProvider });
        completeImageGeneration(quotaStore, eventKey, { userId, providerState: managedImageProvider });
      }
    };
    const twoImageAnswer = answer.replace(
      '| summary_takeaways | 总结 | 可交互、可解释、可行动 | cards | editable cards | close | 1m |',
      '| basic_content | 可信交付 | 每次生成都需要校验 | evidence | 生成插图：工程师检查演示文稿交付质量，无文字 | explain | 1m |\n| summary_takeaways | 总结 | 可交互、可解释、可行动 | cards | editable cards | close | 1m |',
    );

    seedManagedImageUsage('ppt-quota-two-left', 3);
    const beforeTwoSlotRequests = requests.length;
    const twoSlots = await generatePptHostImages({
      root,
      store: quotaStore,
      userId: 'ppt-quota-two-left',
      quotaEventPrefix: 'ppt-quota-two-left',
      sessionId: 'ppt-quota-two-left',
      assistantAnswer: twoImageAnswer,
      imageProvider: managedImageProvider,
    });
    assert.equal(Object.keys(twoSlots.images).length, 2, 'two remaining image slots must allow at most two PPT images');
    assert.equal(requests.length, beforeTwoSlotRequests + 2);

    seedManagedImageUsage('ppt-quota-limited', 4);
    const beforeLimitedRequests = requests.length;
    const limited = await generatePptHostImages({
      root,
      store: quotaStore,
      userId: 'ppt-quota-limited',
      quotaEventPrefix: 'ppt-quota-one-left',
      sessionId: 'ppt-quota-one-left',
      assistantAnswer: twoImageAnswer,
      imageProvider: managedImageProvider,
    });
    assert.equal(Object.keys(limited.images).length, 1, 'one remaining image slot must allow at most one PPT image');
    assert.equal(requests.length, beforeLimitedRequests + 1);

    const exhaustedProgress = [];
    const exhausted = await generatePptHostImages({
      root,
      store: quotaStore,
      userId: 'ppt-quota-limited',
      quotaEventPrefix: 'ppt-quota-zero-left',
      sessionId: 'ppt-quota-zero-left',
      assistantAnswer: twoImageAnswer,
      imageProvider: managedImageProvider,
      onProgress: (event) => exhaustedProgress.push(event),
    });
    assert.deepEqual(exhausted.images, {});
    assert.equal(exhausted.skippedReason, 'quota_exhausted');
    assert.equal(requests.length, beforeLimitedRequests + 1, 'zero remaining image slots must not call the Images API');
    assert.equal(exhaustedProgress.some((event) => event.status === 'skipped'), true);

    const imageFreeDeck = await renderPptArtifact({
      root,
      store: quotaStore,
      userId: 'ppt-quota-limited',
      quotaEventPrefix: 'ppt-quota-free-render',
      outputRoot: path.join(root, 'outputs', 'ppt-quota-free-render'),
      artifactRoot: root,
      sessionId: 'ppt-quota-free-render',
      agentId: 'ppt',
      userMessage: '生成一份即使没有图片额度也可以交付的 PPT',
      assistantAnswer: twoImageAnswer,
      selectedStyle: 'general',
      selectedTemplate: 'none',
      imageProvider: managedImageProvider,
    });
    assert.equal(existsSync(imageFreeDeck.deck), true);
    assert.equal(requests.length, beforeLimitedRequests + 1);
    assert.equal(imageFreeDeck.preview_warnings.some((warning) => /整份 PPT 没有可用的内容图片/.test(warning)), false);

    const sourceVisual = Object.values(limited.images)[0];
    const sourceBackedDeck = await renderPptArtifact({
      root,
      store: quotaStore,
      userId: 'ppt-quota-limited',
      quotaEventPrefix: 'ppt-quota-source-visual-render',
      outputRoot: path.join(root, 'outputs', 'ppt-quota-source-visual-render'),
      artifactRoot: root,
      sessionId: 'ppt-quota-source-visual-render',
      agentId: 'ppt',
      userMessage: '图片额度已用完，请使用附件截图制作 PPT',
      assistantAnswer: twoImageAnswer,
      selectedStyle: 'general',
      selectedTemplate: 'none',
      sourceImagePaths: [sourceVisual],
      imageProvider: managedImageProvider,
    });
    assert.equal(requests.length, beforeLimitedRequests + 1, 'source screenshots must not consume or request generated-image quota');
    assert.equal(
      [...readZipEntries(sourceBackedDeck.deck).keys()].some((name) => name.startsWith('ppt/media/')),
      true,
      'a source screenshot must still be embedded when generated-image quota is exhausted',
    );
  } finally {
    usageDb.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

{
  const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ppt-recovery-'));
  try {
    const sessionId = 'ppt-recovery-session';
    const startedAt = Date.now();
    const output = path.join(root, 'outputs', 'ppt_department', `${sessionId}-recovered-deck`);
    await mkdir(output, { recursive: true });
    const pptx = Buffer.alloc(12_000);
    Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(pptx, 0);
    Buffer.from([0x50, 0x4b, 0x05, 0x06]).copy(pptx, pptx.length - 22);
    await writeFile(path.join(output, 'recovered.pptx'), pptx);
    await writeFile(path.join(output, 'speaker_notes.md'), '# notes\n');
    const recovered = recoverPartialPptResult({
      root,
      sessionId,
      startedAt,
      assistantAnswer: '| title | message | visual |\n|---|---|---|\n| 恢复页面 | 已完成 | 可编辑页面 |',
      includeNotes: true,
    });
    assert.ok(recovered?.deck.endsWith('recovered.pptx'));
    assert.equal(recovered?.recovered_after_timeout, true);
    assert.ok(recovered?.notes.endsWith('speaker_notes.md'));

    const outputRoot = path.join(root, 'workspace');
    const relocatedOutput = path.join(outputRoot, `${sessionId}-relocated-deck`);
    await mkdir(relocatedOutput, { recursive: true });
    await writeFile(path.join(relocatedOutput, 'relocated.pptx'), pptx);
    const recoveredRelocated = recoverPartialPptResult({
      root,
      outputRoot,
      sessionId,
      startedAt,
      assistantAnswer: '| title | message | visual |\n|---|---|---|\n| Recovered | Complete | Editable |',
      includeNotes: false,
    });
    assert.ok(recoveredRelocated?.deck.endsWith('relocated.pptx'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

{
  const fetchImpl = (_url, { signal } = {}) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason || new Error('aborted')), { once: true });
  });
  const client = new OpenAIImagesClient({ apiKey: 'test-key', fetchImpl, timeoutMs: 5_000 });
  const controller = new AbortController();
  const pending = client.generateImage(
    { model: 'gpt-image-2', prompt: 'test', size: '1024x1024', n: 1 },
    { signal: controller.signal },
  );
  controller.abort(new Error('user cancelled image generation'));
  await assert.rejects(() => pending, /user cancelled image generation/);
}

{
  const root = await mkdtemp(path.join(os.tmpdir(), 'janus-image-route-'));
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4VQAAAAASUVORK5CYII=';
  let imageRequestCount = 0;
  const server = createServer((request, response) => {
    if (request.url === '/v1/images/generations' && request.method === 'POST') {
      imageRequestCount += 1;
      response.writeHead(imageRequestCount === 1 ? 500 : 200, { 'content-type': 'application/json' });
      response.end(imageRequestCount === 1
        ? JSON.stringify({ error: { message: 'simulated image service failure' } })
        : JSON.stringify({ data: [{ b64_json: pngBase64 }], usage: {} }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const sessions = new Map([['stale-general-session', {
    id: 'stale-general-session',
    title: '旧的通用会话',
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: 'general-instance-1',
    userId: 'user-1',
    codexThreadId: 'general-thread-1',
  }]]);
  const agentInstances = new Map([['general-instance-1', {
    id: 'general-instance-1',
    userId: 'user-1',
    agentFamilyId: 'general_agent',
  }]]);
  const messages = [];
  const createdSessions = [];
  let threadClears = 0;
  let sequence = 0;
  const usageDb = createUsageDb();
  const store = {
    db: usageDb,
    getSession(id) { return sessions.get(id) || null; },
    createSession(payload) {
      const session = { id: `image-session-${createdSessions.length + 1}`, ...payload };
      sessions.set(session.id, session);
      createdSessions.push(session);
      return session;
    },
    updateSessionThread() { threadClears += 1; },
    updateSession(id, patch) {
      const session = { ...sessions.get(id), ...patch };
      sessions.set(id, session);
      return session;
    },
    addMessage(payload) {
      const session = sessions.get(payload.sessionId);
      const instance = session?.agentInstanceId ? agentInstances.get(session.agentInstanceId) : null;
      if (instance && payload.agentId && payload.agentId !== instance.agentFamilyId) {
        throw new Error('Message Agent identity does not match its Agent instance.');
      }
      const message = { id: `message-${++sequence}`, ...payload };
      messages.push(message);
      return message;
    },
    beginModelExecution() {},
    completeModelExecution() {},
    updateModelExecution() {},
  };
  try {
    await mkdir(path.join(root, 'config', 'codex'), { recursive: true });
    await writeFile(path.join(root, 'config', 'codex', 'auth.json'), `${JSON.stringify({
      OPENAI_IMAGE_API_KEY: 'fake-image-key',
      OPENAI_IMAGE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    }, null, 2)}\n`);
    await assert.rejects(() => sendImageChat({
      runtimeRoot: root,
      store,
      user: { id: 'user-1', role: 'user' },
      sessionId: 'stale-general-session',
      message: '竹林七贤，水墨仿古风，七人同画',
      emitEvent: (_onEvent, _event) => {},
      heartbeat: async (promise) => promise,
      createCancelledError: () => new Error('cancelled'),
    }));
    assert.equal(createdSessions.length, 1);
    assert.equal(createdSessions[0].departmentId, 'image_generation');
    assert.equal(messages.some((message) => message.sessionId === 'stale-general-session'), false);
    assert.equal(messages.some((message) => message.metadata?.imageGenerationFailed), true);

    createdSessions.length = 0;
    messages.length = 0;
    const result = await sendImageChat({
      runtimeRoot: root,
      store,
      user: { id: 'user-1', role: 'user' },
      sessionId: 'stale-general-session',
      message: '继续在当前通用 Agent 会话生成图片',
      inlineImageMode: true,
      imageHostDepartmentId: 'general',
      imageHostAgentId: 'general_agent',
      emitEvent: (_onEvent, _event) => {},
      heartbeat: async (promise) => promise,
      createCancelledError: () => new Error('cancelled'),
    });
    assert.equal(result.session.id, 'stale-general-session');
    assert.equal(result.image.kind, 'image');
    assert.equal(path.dirname(result.image.path), path.join(root, 'outputs', 'stale-general-session'));
    assert.equal(result.image.workspace_relative_path, `outputs/stale-general-session/${path.basename(result.image.path)}`);
    assert.equal(createdSessions.length, 0);
    assert.equal(threadClears, 0);
    assert.equal(messages.length, 3);
    assert.equal(messages.every((message) => message.sessionId === 'stale-general-session'), true);
    assert.equal(messages.every((message) => message.agentId === 'general_agent'), true);
    assert.equal(messages.every((message) => message.departmentId === 'general'), true);
    assert.equal(messages[0].metadata?.imageGeneration?.requestedModel, 'gpt-image-2');
    assert.equal(messages.some((message) => message.metadata?.imageGenerationFailed), false);
    assert.equal(messages.some((message) => message.metadata?.artifact?.kind === 'image'), true);
    assert.equal(imageRequestCount, 2);
  } finally {
    usageDb.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

{
  const root = await mkdtemp(path.join(os.tmpdir(), 'janus-private-image-quota-'));
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4VQAAAAASUVORK5CYII=';
  const server = createServer((request, response) => {
    if (request.url === '/v1/images/generations' && request.method === 'POST') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ b64_json: pngBase64 }], usage: {
        total_tokens: 1_800, input_tokens: 40, output_tokens: 1_760,
        input_tokens_details: { text_tokens: 40, image_tokens: 0 },
      } }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const session = {
    id: 'private-image-session',
    title: '私人助理',
    departmentId: 'private_assistant',
    agentId: 'private_assistant',
    userId: 'user-private',
    codexThreadId: 'private-text-thread',
  };
  const settings = new Map();
  const messages = [];
  let threadClears = 0;
  let sequence = 0;
  const executions = new Map();
  const usageDb = createUsageDb();
  const store = {
    db: usageDb,
    getSession(id) { return id === session.id ? session : null; },
    createSession() { throw new Error('inline private image mode must reuse its session'); },
    updateSessionThread() { threadClears += 1; },
    updateSession() { return session; },
    addMessage(payload) {
      const message = { id: `private-image-message-${++sequence}`, ...payload };
      messages.push(message);
      return message;
    },
    beginModelExecution(payload) { executions.set(payload.id, payload); },
    completeModelExecution() {},
    updateModelExecution(id, patch) { executions.set(id, { ...(executions.get(id) || {}), ...patch }); },
    settingGet(key, fallback = '') { return settings.has(key) ? settings.get(key) : fallback; },
    settingSet(key, value) { settings.set(key, String(value)); },
  };
  try {
    await mkdir(path.join(root, 'config', 'codex'), { recursive: true });
    await writeFile(path.join(root, 'config', 'codex', 'auth.json'), `${JSON.stringify({
      OPENAI_IMAGE_API_KEY: 'fake-image-key',
      OPENAI_IMAGE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    }, null, 2)}\n`);
    const result = await sendImageChat({
      runtimeRoot: root,
      store,
      user: { id: 'user-private', role: 'user' },
      sessionId: session.id,
      message: '在当前私人助理会话生成一张测试图片',
      inlineImageMode: true,
      imageHostDepartmentId: 'private_assistant',
      imageHostAgentId: 'private_assistant',
      emitEvent: (_onEvent, _event) => {},
      heartbeat: async (promise) => promise,
      createCancelledError: () => new Error('cancelled'),
    });
    assert.equal(result.session.id, session.id);
    assert.equal(path.dirname(result.image.path), path.join(root, 'data', 'private_assistant', 'user-private', 'outputs', session.id));
    assert.equal(threadClears, 0);
    assert.equal(result.privateAssistantUsage.weeklyTextTokensUsed, 0);
    assert.equal(result.privateAssistantUsage.weeklyImageTokensUsed, 0);
    assert.equal(result.privateAssistantUsage.weeklyTokensUsed, 0);
    assert.equal(messages.some((message) => message.metadata?.privateAssistantImageUsage?.count === 1), true);
    const imageQuota = usageDb.prepare("SELECT status FROM managed_provider_usage_events WHERE usage_source='image_usage_unlimited_v2'").get();
    assert.equal(imageQuota?.status, 'completed');
  } finally {
    usageDb.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

const rendererSource = readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
assert.match(rendererSource, /data-composer-image-mode[\s\S]*state\.composerImageMode = enabling/);
assert.doesNotMatch(rendererSource, /data-composer-image-mode[\s\S]{0,900}state\.currentSessionId = ''/);

const runtimeSource = readFileSync(new URL('../src/main/runtime.js', import.meta.url), 'utf8');
assert.match(runtimeSource, /requestedImageChat = chatMode === 'image' \|\| departmentId === 'image_generation'/);
assert.match(runtimeSource, /classifyImageIntent\(message/);
assert.match(runtimeSource, /automaticImageRoute/);
assert.match(runtimeSource, /已自动切换至 GPT Image-2/);
assert.match(runtimeSource, /pptRenderFailed: true/);

const imageChatSource = readFileSync(new URL('../src/main/modules/artifacts/application/sendImageChat.js', import.meta.url), 'utf8');
assert.match(imageChatSource, /imageGenerationFailed: true/);
assert.match(imageChatSource, /triggerAutoSync\?\.\('image_failure'/);
assert.match(imageChatSource, /const messageIdentity = inlineImageMode/);
assert.match(imageChatSource, /generateImageArtifact/);
assert.doesNotMatch(imageChatSource, /generateImageWithCodexTool/);

const imageGenerationSource = readFileSync(new URL('../src/main/imageGeneration.js', import.meta.url), 'utf8');
assert.match(imageGenerationSource, /JANUS_IMAGE_REQUEST_TIMEOUT_MS \|\| 600_000/);
assert.match(imageGenerationSource, /JANUS_IMAGE_DOWNLOAD_TIMEOUT_MS \|\| 60_000/);

const pptRendererSource = readFileSync(new URL('../src/main/pptRenderer.js', import.meta.url), 'utf8');
const pythonRuntimeSource = readFileSync(new URL('../src/main/python.js', import.meta.url), 'utf8');
const rendererRunSource = readFileSync(new URL('../src/renderer/app/features/chat/chatRunController.js', import.meta.url), 'utf8');
assert.match(rendererRunSource, /event\.automaticRoute && event\.reason/);
assert.match(pptRendererSource, /JANUS_PPT_RENDER_TIMEOUT_MS \|\| 600_000/);
assert.match(pptRendererSource, /Last renderer stage:/);
assert.match(runtimeSource, /ppt_render_timeout/);
assert.equal(pptRenderFailureDetails(new Error("ModuleNotFoundError: No module named 'pptx'")).code, 'ppt_runtime_unavailable');
assert.equal(pptRenderFailureDetails(new Error('ImportError: DLL load failed while importing _imaging')).code, 'ppt_runtime_unavailable');
assert.equal(pptRenderFailureDetails(new Error("python.exe: can't open file 'render_ppt.py': [Errno 2] No such file or directory")).code, 'ppt_renderer_installation_damaged');
assert.equal(pptRenderFailureDetails(new Error('ENOSPC: no space left on device')).code, 'ppt_storage_full');
assert.match(pptRendererSource, /requiredModules: PPT_REQUIRED_PYTHON_MODULES/);
assert.match(pptRendererSource, /ppt_renderer_process_failed/);
assert.match(pythonRuntimeSource, /requiredModules/);
assert.match(pythonRuntimeSource, /allowPackaged: false/);
assert.match(pythonRuntimeSource, /repairableWithExternalPython/);
assert.match(pythonRuntimeSource, /PYTHONHOME: _ignoredPythonHome/);
assert.match(pythonRuntimeSource, /!packaged && pythonPath/);
assert.match(pythonRuntimeSource, /stdio: 'ignore'/);
assert.match(pythonRuntimeSource, /python-probe-/);
assert.match(pythonRuntimeSource, /import \$\{modules\.join/);
assert.match(pptRendererSource, /ppt_renderer_simplified_retry/);
assert.match(pptRendererSource, /payload\.selected_template = 'none'/);
assert.match(pptRendererSource, /ioMode: fileProtocol \? 'file_protocol' : 'pipes'/);
assert.match(pptRendererSource, /createWindowsRendererProtocol/);
assert.doesNotMatch(
  runtimeSource,
  /renderPptArtifact\(\{[\s\S]{0,500}?accountWorkspaceId:\s*resolvedAccountWorkspaceId/,
  'PPT delivery must use the accountWorkspaceId resolved in the sendChat scope',
);
const schedulerSource = readFileSync(new URL('../src/main/scheduler.js', import.meta.url), 'utf8');
assert.match(schedulerSource, /accountWorkspaceId:\s*taskRun\.accountWorkspaceId[\s\S]{0,180}taskRun\.workspaceId/);
const taskArtifactServiceSource = readFileSync(new URL('../src/main/modules/orchestration/infrastructure/taskArtifactService.js', import.meta.url), 'utf8');
assert.match(taskArtifactServiceSource, /accountWorkspaceId:\s*context\.task\.accountWorkspaceId[\s\S]{0,220}context\.task\.workspaceId/);
assert.match(rendererRunSource, /event\.artifactError/);

const pptImageSource = readFileSync(new URL('../src/main/ppt_service/ppt_pipeline/image_generation.py', import.meta.url), 'utf8');
assert.match(pptImageSource, /JANUS_PPT_IMAGEGEN_TIMEOUT_SECONDS", "30"/);
assert.match(pptImageSource, /JANUS_PPT_IMAGEGEN_ATTEMPTS", "1"/);
assert.match(pptImageSource, /JANUS_PPT_IMAGEGEN_FALLBACK_TIMEOUT_SECONDS", "45"/);
assert.match(pptRendererSource, /generateImageArtifact/);
assert.doesNotMatch(pptRendererSource, /generateImageWithCodexTool/);

console.log('image generation reliability smoke passed');
