import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createRuntime, pptOverallPercent } from '../src/main/runtime.js';
import { diagnoseAgentEvidence } from '../src/main/diagnosis.js';
import { validateHrReviewProposal } from '../src/main/evolution.js';
import { scoreEvolutionGate } from '../src/main/gate.js';
import { extractEvalCases, runRegressionEvalCases } from '../src/main/regression.js';
import { memoryMergeDecision, upsertTypedMemory } from '../src/main/memory.js';
import { codexEvidenceForAgent } from '../src/main/transcripts.js';
import { buildAgentChatPrompt, buildTaskNodePrompt } from '../src/main/prompts.js';
import { TaskScheduler, buildGlobalTaskSummary, taskCommunicationsForNode } from '../src/main/scheduler.js';
import { janusBrandText, renderMarkdown, userVisibleErrorMessage } from '../src/renderer/app/utils/format.js';
import { normalizeFilePayload } from '../src/renderer/app/utils/filePayload.js';
import { renderUserAvatar } from '../src/renderer/app/utils/avatar.js';
import { state as rendererState } from '../src/renderer/app/state.js';
import { renderPptxPreview } from '../src/renderer/app/components/overlays.js';
import { renderChat } from '../src/renderer/app/views/chatView.js';
import { codexTurnChangeModel, renderCodexChangeSummary } from '../src/renderer/app/views/codexChangeReviewView.js';
import { renderCodexTranscript } from '../src/renderer/app/views/codexTranscriptView.js';
import { renderSettings } from '../src/renderer/app/views/settingsView.js';
import { renderPluginSettings } from '../src/renderer/app/views/pluginsView.js';
import { authEmailValidationMessage, registrationValidationMessage } from '../src/renderer/app/features/settings/authController.js';
import { renderPersonalEvolution } from '../src/renderer/app/views/personalEvolutionView.js';
import { renderEmployees } from '../src/renderer/app/views/employeesView.js';
import { cycleMessageDefaultVariant, normalizeMessageDefaultVariantOrder, renderMessageDefaultPage, reorderMessageDefaultVariants } from '../src/renderer/app/views/messageHomeView.js';
import { formatReleaseDate, renderUpdateAnnouncementDialog } from '../src/renderer/app/views/releaseNotesView.js';
import { renderContactsWorkspace, renderNetworkPanel } from '../src/renderer/app/views/networkView.js';
import { renderSettingsSidebar } from '../src/renderer/app/views/navigationView.js';
import { createFriendsController } from '../src/renderer/app/features/network/friendsController.js';
import { CloudSyncClient, OpenAIImagesClient, SocialClient } from '../network/index.js';
import { planHomeChatRoute } from '../src/main/chatPlanner.js';
import { ModelCatalog, normalizeModelCatalog } from '../src/main/modelCatalog.js';
import { bundledCodexCandidates, codexAppServerArgs, codexCollaborationMode, codexExecutionBackend, codexExecProcessFailure, createCodexStreamEventParser, codexGeneratedImagePath, codexPermissionProfile, codexProcessEventForItem, codexProviderConfigForRuntime, codexProviderRelayArgs, codexProxyEnvFromElectron, codexStreamEvent, codexTokenUsage, configureCodexProviderRelay, ensureCodexTlsBundle, ensureWindowsSandboxReady, filterCodexModelCatalogForProvider, JANUS_CLIENT_VERSION, materializeCodexGeneratedImageResult, probeCodexProvider, queryWindowsSandboxReadiness, sanitizeProcessProtocolValue } from '../src/main/codex.js';
import { createCodexProviderRelay } from '../src/main/codexProviderRelay.js';
import { codexAgentToml, codexHarnessAssignment, discoverCodexAgents, validateCodexAgentToml, writeCodexAgentHarness } from '../src/main/codexAgentHarness.js';
import { codexPrivateSessionConfig, sharedConfigArgs } from '../src/main/codexConfig.js';
import { sha256Text, syncDirFromSeed } from '../src/main/utils.js';
import { resolvePythonInvocation } from '../src/main/python.js';
import { composePptStyleSkill, pptSkillStatus, resolvePptStyleSkill } from '../src/main/skills.js';
import { CloudSyncService } from '../src/main/cloudSync.js';
import { openDatabase } from '../src/main/db.js';
import { inspectDatabaseBackup } from '../src/main/databaseBackup.js';
import { PersonalEvolutionCoordinator, sanitizeEvidence } from '../src/main/modules/evolution/application/personalEvolutionCoordinator.js';
import { createEmployeeRuntimeApi, progressionSyncForEmployee } from '../src/main/modules/identity/application/createEmployeeRuntimeApi.js';
import { createIdentityRuntimeApi } from '../src/main/modules/identity/application/createIdentityRuntimeApi.js';
import { Store } from '../src/main/store.js';
import { collectMessageOutputArtifacts, collectTurnChangedFilePaths, renderUploadedFile, uploadFile, uploadFileFromPath } from '../src/main/files.js';
import { createCloudServer, openCloudDatabase } from '../src/cloud/server.js';
import { createEvolutionAuthority } from '../src/cloud/modules/evolution/index.js';
import { importCloudEvolutionEvidence } from '../src/cloud/evolutionEvidence.js';
import { unifiedAgentReleaseVersion, unifiedDesktopReleaseReadiness } from '../src/cloud/releasePublisher.js';
import { archiveCodexGeneratedImageArtifact, artifactMessage, sessionOutputsDir } from '../src/main/artifacts.js';
import { normalizePptAssistantAnswer, pptProgressMilestones, relocatePptResult, shouldAttachPptArtifact } from '../src/main/pptRenderer.js';
import { applyAgentBundle, buildAgentBundle, readInstalledAgentBundle, rollbackAgentBundle, signAgentBundle, validateAgentBundle, verifyAgentBundleSignature } from '../src/shared/agentBundle.js';
import { createAgentBundleService } from '../src/main/agentBundles.js';
import {
  agentBundleUpdateNotificationContent,
  agentDeliveryNotificationContent,
  applicationUpdateNotificationContent,
  collaborationTaskNotificationContent,
  createNativeNotificationOptions,
  createSystemNotificationAvailabilityChecker,
  socialMessageNotificationContent,
} from '../src/main/systemNotifications.js';
import { pluginCatalog, pluginStatus } from '../src/main/pluginRegistry.js';
import { isSkillPackageInstalled, setSkillPackageInstalled, skillPackageCatalogRoot, skillPackageInstallRoot } from '../src/shared/skillPackages.js';
import { normalizeReleaseArtifactPath, versionReleaseManifest } from '../src/shared/releaseLayout.js';
import { readMacUpdateSignatureManifest, signUpdateMetadata, verifyUpdateMetadata } from '../src/shared/updateSignature.js';
import { macAppBundleFromExecutable, verifyMacUpdatePackage } from '../network/clients/macosUpdateInstaller.js';
import { codexStyleUserDataRoot, prepareCodexStyleUserDataRoot, resolveRuntimeRoot } from '../src/main/paths.js';
import { prunePlatformReleaseDirectories } from '../src/shared/releaseRetention.js';
import { promoteDesktopPlatformFeed } from '../src/shared/unifiedDesktopRelease.js';
import { installBrokenPipeGuards, sendWebContentsSafely } from '../src/shared/electronProcessSafety.js';
import { installExternalNavigation, normalizeExternalHttpUrl } from '../src/main/externalNavigation.js';
import { parseLocalFileReference, resolveMessageArtifactLink } from '../src/renderer/app/utils/messageArtifactLinks.js';
import { desktopReleaseChannel, desktopReleaseRootUrl, desktopUserDataDirectoryName } from '../src/shared/desktopReleaseChannel.js';
import { normalizeAuthServerUrl, packagedAuthServerUrl, packagedAuthUserId } from '../src/main/authServerConfig.js';
import {
  cloudEvolutionAuthorityEnabled,
  evolutionPrivacyFindings,
  redactEvolutionPrivateText,
} from '../src/shared/evolution/index.js';
import { decryptTaskMemoryContent, encryptTaskMemoryContent, unwrapTaskKeyFromCloud, wrapTaskKeyForCloud } from '../src/shared/taskMemoryCrypto.js';
import { buildOrganizationInviteLink, parseOrganizationInviteLink } from '../src/shared/organizationInvites.js';
import { RELEASE_ANNOUNCEMENTS, compareReleaseVersions, releaseAnnouncementForVersion } from '../src/shared/releaseAnnouncements.js';
import { normalizeProfileAvatarUrl, profileAvatarUrlValidation } from '../src/shared/profileAvatar.js';
import {
  buildPrivateAssistantPrompt,
  privateAssistantUsageStatus,
  privateAssistantWeekWindow,
  recordPrivateAssistantUsage,
  resolvePrivateAssistantTurnUsage,
} from '../src/main/privateAssistant.js';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'janus-check-'));
const avatarPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
const longAvatarUrl = `data:image/png;base64,${Buffer.concat([avatarPng, Buffer.alloc(3_072, 7)]).toString('base64')}`;
const replacementAvatarUrl = `data:image/png;base64,${Buffer.concat([avatarPng, Buffer.alloc(3_200, 9)]).toString('base64')}`;
const priorTaskMemoryPublicKeys = process.env.JANUS_TASK_MEMORY_CLOUD_PUBLIC_KEYS_JSON;
const priorTaskMemoryPrivateKeys = process.env.JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON;
const priorTaskMemoryActiveKey = process.env.JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID;
const taskMemoryKeyPair = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
process.env.JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID = 'task_cloud_check_v1';
process.env.JANUS_TASK_MEMORY_CLOUD_PUBLIC_KEYS_JSON = JSON.stringify({ task_cloud_check_v1: taskMemoryKeyPair.publicKey });
process.env.JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON = JSON.stringify({ task_cloud_check_v1: taskMemoryKeyPair.privateKey });

try {
  const truncatedWebp = Buffer.alloc(20);
  truncatedWebp.write('RIFF', 0, 'ascii');
  truncatedWebp.writeUInt32LE(12_000, 4);
  truncatedWebp.write('WEBP', 8, 'ascii');
  const truncatedWebpUrl = `data:image/webp;base64,${truncatedWebp.toString('base64')}`;
  assert.equal(janusBrandText('Codex needs permission. Codex CLI is unavailable.'), 'Janus needs permission. Janus runtime is unavailable.');
  assert.equal(userVisibleErrorMessage(new Error('Codex app-server rejected the request.')), 'Janus runtime rejected the request.');
  assert.equal(
    userVisibleErrorMessage(new Error("Error invoking remote method 'chat:send': CodexUnavailable: Janus 已连接本地模型运行时，但上游模型服务在连续 5 个等待周期内（每次 60 秒，累计约 300 秒）始终未返回任何模型输出。")),
    'JanusUnavailable: Janus 已连接本地模型运行时，但上游模型服务在连续 5 个等待周期内（每次 60 秒，累计约 300 秒）始终未返回任何模型输出。',
  );
  assert.equal(profileAvatarUrlValidation(longAvatarUrl).valid, true);
  assert.equal(normalizeProfileAvatarUrl(longAvatarUrl), longAvatarUrl);
  assert.equal(profileAvatarUrlValidation(truncatedWebpUrl).valid, false);
  assert.equal(normalizeProfileAvatarUrl(truncatedWebpUrl), '');
  assert.match(renderUserAvatar({ id: 'valid-avatar', displayName: '有效头像', avatarUrl: longAvatarUrl }), /has-custom-avatar[\s\S]*data-user-avatar-image/);
  assert.match(renderUserAvatar({ id: 'viewer-avatar', displayName: '可查看头像', avatarUrl: longAvatarUrl }, { viewerUserId: 'viewer-avatar' }), /<button[\s\S]*data-avatar-viewer-user="viewer-avatar"[\s\S]*data-user-avatar-image/);
  assert.doesNotMatch(renderUserAvatar({ id: 'broken-avatar', displayName: '损坏头像', avatarUrl: truncatedWebpUrl }), /has-custom-avatar|<img/);
  assert.match(renderUserAvatar({ id: 'english-default', displayName: 'account' }, { fallbackLabel: 'account' }), />AC<\/span>/);
  assert.match(renderUserAvatar({ id: 'multiword-default', displayName: 'Susan Lee' }, { fallbackLabel: 'Susan Lee' }), />SL<\/span>/);
  assert.match(renderUserAvatar({ id: 'numbered-chinese-default', displayName: '测试账号 01' }, { fallbackLabel: '测试账号 01' }), /data-no-localize>01<\/span>/);
  assert.match(renderUserAvatar({ id: 'numbered-chinese-default-10', displayName: '测试账号 10' }, { fallbackLabel: '测试账号 10' }), /data-no-localize>10<\/span>/);
  assert.match(renderUserAvatar({ id: 'numbered-chinese-default', displayName: '测试账号 01' }, { fallbackLabel: '测试账号 01' }), /data-no-localize>01<\/span>/);
  assert.match(renderUserAvatar({ id: 'numbered-english-default', displayName: 'Test Account 01' }, { fallbackLabel: 'Test Account 01' }), /data-no-localize>01<\/span>/);
  assert.match(renderUserAvatar({ id: 'chinese-default', displayName: '张小明' }, { fallbackLabel: '张小明' }), /data-no-localize>小明<\/span>/);
  assert.match(renderUserAvatar({ id: 'chinese-name-default', displayName: '刘思杰' }, { fallbackLabel: '刘思杰' }), /data-no-localize>思杰<\/span>/);
  assert.doesNotMatch(renderUserAvatar({ id: 'english-default', displayName: 'account' }, { fallbackLabel: 'account' }), />account<\/span>/i);
  execFileSync(process.execPath, ['scripts/desktop_activity_policy_smoke.mjs'], { cwd: process.cwd(), stdio: 'pipe' });
  execFileSync(process.execPath, ['scripts/desktop_power_lifecycle_smoke.mjs'], { cwd: process.cwd(), stdio: 'pipe' });
  execFileSync(process.execPath, ['scripts/runtime_desktop_activity_smoke.mjs'], { cwd: process.cwd(), stdio: 'pipe' });
  execFileSync(process.execPath, ['scripts/profile_identity_contract_smoke.mjs'], { cwd: process.cwd(), stdio: 'pipe' });
  execFileSync(process.execPath, ['scripts/startup_progressive_bootstrap_smoke.mjs'], { cwd: process.cwd(), stdio: 'pipe' });
  let unavailableNotificationProbeCount = 0;
  const unavailableNotifications = createSystemNotificationAvailabilityChecker({
    notificationApi: { isSupported: () => true },
    platform: 'linux',
    env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/check-dbus' },
    now: () => 1_000,
    execFileFn(_file, _args, _options, callback) {
      unavailableNotificationProbeCount += 1;
      callback(null, '(false,)');
    },
  });
  assert.equal(await unavailableNotifications(), false);
  assert.equal(await unavailableNotifications(), false);
  assert.equal(unavailableNotificationProbeCount, 1, 'Linux notification owner probe should be cached');
  const availableNotifications = createSystemNotificationAvailabilityChecker({
    notificationApi: { isSupported: () => true },
    platform: 'linux',
    env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/check-dbus' },
    execFileFn(_file, _args, _options, callback) { callback(null, '(true,)'); },
  });
  assert.equal(await availableNotifications(), true);

  const unownedLinuxProbeCalls = [];
  const unownedLinuxNotifications = createSystemNotificationAvailabilityChecker({
    notificationApi: { isSupported: () => true },
    platform: 'linux',
    env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/check-dbus' },
    execFileFn(file, args, _options, callback) {
      unownedLinuxProbeCalls.push(file);
      if (args.includes('org.freedesktop.DBus.NameHasOwner')) callback(null, '(false,)');
      else callback(null, "(['org.freedesktop.Notifications'],)");
    },
  });
  assert.equal(await unownedLinuxNotifications(), false);
  assert.deepEqual(unownedLinuxProbeCalls, ['gdbus']);

  const disabledNotifications = createSystemNotificationAvailabilityChecker({
    notificationApi: { isSupported: () => true },
    platform: 'linux',
    env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/check-dbus', JANUS_DESKTOP_NOTIFICATIONS: '0' },
    execFileFn() { throw new Error('disabled notifications must not probe D-Bus'); },
  });
  assert.equal(await disabledNotifications(), false);

  for (const platform of ['win32', 'darwin']) {
    let nativeProbeCount = 0;
    const nativeNotifications = createSystemNotificationAvailabilityChecker({
      notificationApi: { isSupported: () => true },
      platform,
      env: {},
      execFileFn() { nativeProbeCount += 1; },
    });
    assert.equal(await nativeNotifications(), true);
    assert.equal(nativeProbeCount, 0, `${platform} notifications must not probe Linux D-Bus services`);
  }

  const linuxProbeFiles = [];
  const fallbackLinuxNotifications = createSystemNotificationAvailabilityChecker({
    notificationApi: { isSupported: () => true },
    platform: 'linux',
    env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/check-dbus' },
    execFileFn(file, _args, _options, callback) {
      linuxProbeFiles.push(file);
      if (file === 'gdbus') {
        const error = new Error('gdbus is unavailable');
        error.code = 'ENOENT';
        callback(error);
        return;
      }
      callback(null, 'boolean true');
    },
  });
  assert.equal(await fallbackLinuxNotifications(), true);
  assert.deepEqual(linuxProbeFiles, ['gdbus', 'dbus-send']);

  const commonNativeNotification = {
    title: '跨平台通知',
    body: 'macOS、Linux、Windows 内容保持一致',
    icon: '/tmp/janus-notification-icon.png',
  };
  const macNativeNotification = createNativeNotificationOptions({
    ...commonNativeNotification,
    platform: 'darwin',
  });
  const windowsNativeNotification = createNativeNotificationOptions({
    ...commonNativeNotification,
    platform: 'win32',
  });
  const linuxNativeNotification = createNativeNotificationOptions({
    ...commonNativeNotification,
    platform: 'linux',
  });
  for (const options of [macNativeNotification, windowsNativeNotification, linuxNativeNotification]) {
    assert.equal(options.title, commonNativeNotification.title);
    assert.equal(options.body, commonNativeNotification.body);
    assert.equal(options.silent, false);
  }
  assert.equal(macNativeNotification.subtitle, 'Janus');
  assert.equal('icon' in macNativeNotification, false);
  assert.equal(windowsNativeNotification.timeoutType, 'default');
  assert.equal(windowsNativeNotification.icon, commonNativeNotification.icon);
  assert.equal(linuxNativeNotification.urgency, 'normal');
  assert.equal(linuxNativeNotification.timeoutType, 'default');
  assert.equal(linuxNativeNotification.icon, commonNativeNotification.icon);

  const taskNotification = collaborationTaskNotificationContent({
    id: 'task-notice',
    title: '\u6574\u7406\u63a8\u8350\u7cfb\u7edf\u9009\u9898',
    instruction: '\u8bf7\u6574\u7406\u4e09\u4e2a\u53ef\u843d\u5730\u7684\u65b9\u5411\u5e76\u9644\u98ce\u9669\u6e05\u5355',
    status: 'assigned',
    requester: { displayName: '\u5c0f\u6960' },
  });
  assert.match(taskNotification.title, /\u63a8\u8350\u7cfb\u7edf\u9009\u9898/);
  assert.match(taskNotification.body, /\u5c0f\u6960/);
  assert.match(taskNotification.body, /\u98ce\u9669\u6e05\u5355/);
  const messageNotification = socialMessageNotificationContent({
    sender: { displayName: '\u5f20\u4e09' },
    content: '\u65b9\u6848\u5df2\u7ecf\u66f4\u65b0\uff0c\u8bf7\u67e5\u6536\u3002',
    metadata: {},
  });
  assert.match(messageNotification.title, /\u5f20\u4e09\u53d1\u6765\u6d88\u606f/);
  assert.match(messageNotification.body, /\u65b9\u6848\u5df2\u7ecf\u66f4\u65b0/);
  const agentNotification = agentDeliveryNotificationContent({
    receipt: { deliveryStatus: 'completed' },
    agent: { name: '\u8bbe\u8ba1 Agent' },
    sourceSession: { title: '\u9996\u9875\u6539\u7248' },
    notification: { content: '\u8bbe\u8ba1 Agent \u5df2\u5b8c\u6210\u4efb\u52a1\uff1a\n\n\u5df2\u751f\u6210\u4e24\u5957\u754c\u9762\u65b9\u6848\u3002' },
  });
  assert.match(agentNotification.title, /\u8bbe\u8ba1 Agent\s+\u5df2\u5b8c\u6210\u5de5\u4f5c/);
  assert.match(agentNotification.body, /\u9996\u9875\u6539\u7248/);
  assert.match(agentNotification.body, /\u4e24\u5957\u754c\u9762\u65b9\u6848/);
  const chineseUpdateNotification = applicationUpdateNotificationContent(
    { available: true, version: '0.2.19', autoDownload: false },
    { available: false },
    'zh-CN',
  );
  assert.equal(chineseUpdateNotification.title, '发现 Janus 0.2.19 更新');
  assert.equal(chineseUpdateNotification.body, '点击打开更新中心，查看版本信息并下载。');
  const englishUpdateNotification = applicationUpdateNotificationContent(
    { available: true, version: '0.2.19', autoDownload: false },
    { available: false },
    'en',
  );
  assert.equal(englishUpdateNotification.title, 'Janus 0.2.19 update available');
  assert.equal(englishUpdateNotification.body, 'Click to open Update Center, review the version, and download.');
  assert.match(agentBundleUpdateNotificationContent(
    { available: true, candidate: { artifact: { bundleId: 'bundle-19', releaseVersion: '0.2.19' } } },
    { available: false },
  ).title, /0\.2\.19/);
  assert.deepEqual(RELEASE_ANNOUNCEMENTS.map((item) => item.version), ['1.1.0', '0.3.0', '0.2.28', '0.2.27', '0.2.26', '0.2.21', '0.2.20', '0.2.19', '0.2.18']);
  assert.match(releaseAnnouncementForVersion('v1.1.0')?.title || '', /Follower Beta/);
  assert.match(releaseAnnouncementForVersion('v1.1.0')?.highlights?.[1] || '', /uBuddy.*界面与功能耦合/);
  assert.match(releaseAnnouncementForVersion('v1.1.0')?.highlights?.[2] || '', /PPT 员工/);
  assert.match(releaseAnnouncementForVersion('v1.1.0')?.highlights?.[3] || '', /客制化桌面关闭行为/);
  assert.equal(releaseAnnouncementForVersion('v1.1.0')?.sections?.length, 5);
  assert.match(releaseAnnouncementForVersion('v0.3.0')?.title || '', /从任务协作到成果验收的完整升级/);
  assert.match(releaseAnnouncementForVersion('v0.3.0')?.highlights?.[0] || '', /消息页.*深色主题/);
  assert.match(releaseAnnouncementForVersion('v0.3.0')?.highlights?.[2] || '', /跨用户委托.*验收/);
  assert.equal(releaseAnnouncementForVersion('v0.3.0')?.highlights?.length, 6);
  assert.match(releaseAnnouncementForVersion('v0.2.28')?.title || '', /任务理解、模型适配与社交交互升级/);
  assert.match(releaseAnnouncementForVersion('v0.2.28')?.highlights?.[0] || '', /多处 UI 优化/);
  assert.match(releaseAnnouncementForVersion('v0.2.28')?.highlights?.[1] || '', /点击.*头像.*简介/);
  assert.equal(releaseAnnouncementForVersion('v0.2.28')?.highlights?.length, 6);
  assert.equal(compareReleaseVersions('0.2.21', '0.2.20'), 1);
  assert.match(releaseAnnouncementForVersion('v0.2.21')?.title || '', /uBuddy 调度、协作文件与工作空间/);
  const previousUpdateAnnouncementDialog = rendererState.updateAnnouncementDialog;
  const previousUpdateAnnouncementAutoPopup = rendererState.updateAnnouncementAutoPopup;
  const previousUpdates = rendererState.updates;
  const previousLanguageMode = rendererState.languageMode;
  rendererState.languageMode = 'zh-CN';
  rendererState.updateAnnouncementAutoPopup = true;
  rendererState.updates = {
    available: true,
    version: '0.2.21',
    releaseDate: '2026-08-12T16:00:00.000Z',
    downloaded: false,
    downloading: false,
  };
  assert.equal(
    formatReleaseDate(new Date(2026, 7, 14, 2, 39, 9).toISOString(), new Date(2026, 7, 14, 8)),
    '02:39',
  );
  assert.equal(
    formatReleaseDate(new Date(2026, 7, 14, 2, 39, 9).toISOString(), new Date(2026, 7, 15, 8)),
    '8月14日 02:39',
  );
  assert.equal(formatReleaseDate('2026-08-02'), '2026年8月2日');
  rendererState.updateAnnouncementDialog = { mode: 'available', version: '0.2.21', detail: false };
  const updateAnnouncementSummary = renderUpdateAnnouncementDialog();
  assert.match(updateAnnouncementSummary, /发现 Janus 0\.2\.21/);
  assert.ok(updateAnnouncementSummary.includes(`发布时间：${formatReleaseDate(rendererState.updates.releaseDate)}`));
  assert.match(updateAnnouncementSummary, /datetime="2026-08-12T16:00:00\.000Z"/);
  assert.match(updateAnnouncementSummary, /data-update-announcement-download/);
  assert.match(updateAnnouncementSummary, /查看详细更新日志/);
  assert.doesNotMatch(updateAnnouncementSummary, /版本 0\.2\.18/);
  rendererState.updateAnnouncementDialog = { mode: 'history', version: '0.2.21', detail: true };
  const updateAnnouncementDetails = renderUpdateAnnouncementDialog();
  assert.match(updateAnnouncementDetails, /版本 0\.2\.21/);
  assert.ok(updateAnnouncementDetails.includes(`发布时间：${formatReleaseDate(rendererState.updates.releaseDate)}`));
  assert.match(updateAnnouncementDetails, /版本 0\.2\.20/);
  assert.match(updateAnnouncementDetails, /版本 0\.2\.19/);
  assert.match(updateAnnouncementDetails, /版本 0\.2\.18/);
  rendererState.languageMode = 'en';
  rendererState.updateAnnouncementDialog = { mode: 'available', version: '0.2.21', detail: false };
  assert.ok(renderUpdateAnnouncementDialog().includes(`Released: ${formatReleaseDate(rendererState.updates.releaseDate)}`));
  rendererState.languageMode = previousLanguageMode;
  rendererState.updateAnnouncementDialog = previousUpdateAnnouncementDialog;
  rendererState.updateAnnouncementAutoPopup = previousUpdateAnnouncementAutoPopup;
  rendererState.updates = previousUpdates;

  const legacyMigrationRoot = path.join(tmp, 'legacy-migration-backup-check');
  mkdirSync(path.join(legacyMigrationRoot, 'data'), { recursive: true });
  const legacyTaskMemoryKey = path.join(legacyMigrationRoot, 'data', 'task-memory-device-key.json');
  writeFileSync(legacyTaskMemoryKey, `${JSON.stringify({ keyId: 'legacy-backup-check', key: Buffer.alloc(32, 7).toString('base64') })}\n`, { mode: 0o600 });
  const legacyMigrationDb = new DatabaseSync(path.join(legacyMigrationRoot, 'data', 'janus.db'));
  legacyMigrationDb.exec("CREATE TABLE legacy_marker (value TEXT NOT NULL); INSERT INTO legacy_marker VALUES ('preserved')");
  legacyMigrationDb.close();
  const migratedLegacyDb = openDatabase(legacyMigrationRoot);
  assert.ok(migratedLegacyDb.migrationBackup?.backupPath, 'existing databases must be backed up before pending migrations');
  assert.ok(migratedLegacyDb.migrationBackup?.taskMemoryKeyBackupPath, 'migration backup must include the task Memory device key when present');
  assert.equal(inspectDatabaseBackup(migratedLegacyDb.migrationBackup.backupPath).integrity, 'ok');
  assert.equal(migratedLegacyDb.prepare('SELECT value FROM legacy_marker').get().value, 'preserved');
  const migrationBackupPath = migratedLegacyDb.migrationBackup.backupPath;
  migratedLegacyDb.close();
  const restoredMigrationRoot = path.join(tmp, 'restored-migration-backup-check');
  execFileSync(process.execPath, ['scripts/restore_database_backup.mjs', '--root', restoredMigrationRoot, '--backup', migrationBackupPath], { cwd: process.cwd(), stdio: 'pipe' });
  const restoredMigrationDb = new DatabaseSync(path.join(restoredMigrationRoot, 'data', 'janus.db'));
  assert.equal(restoredMigrationDb.prepare('SELECT value FROM legacy_marker').get().value, 'preserved');
  assert.equal(restoredMigrationDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  restoredMigrationDb.close();
  assert.equal(readFileSync(path.join(restoredMigrationRoot, 'data', 'task-memory-device-key.json'), 'utf8'), readFileSync(legacyTaskMemoryKey, 'utf8'));

  const rollbackMigrationRoot = path.join(tmp, 'migration-rollback-check');
  assert.throws(() => openDatabase(rollbackMigrationRoot, {
    beforeCommit() { throw new Error('injected migration failure'); },
  }), /injected migration failure/);
  const rollbackInspectionDb = new DatabaseSync(path.join(rollbackMigrationRoot, 'data', 'janus.db'));
  assert.equal(rollbackInspectionDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get().count, 0, 'failed migrations must roll back all schema changes');
  rollbackInspectionDb.close();

  const pipeListeners = [];
  const fakePipe = { on(event, listener) { pipeListeners.push({ event, listener }); } };
  installBrokenPipeGuards({ stdout: fakePipe, stderr: null });
  assert.equal(pipeListeners.length, 1);
  assert.equal(pipeListeners[0].event, 'error');
  assert.doesNotThrow(() => pipeListeners[0].listener(Object.assign(new Error('closed installer pipe'), { code: 'EPIPE' })));
  assert.equal(sendWebContentsSafely({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: () => { throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' }); } },
  }, 'check:event', {}), false);
  let safeSend = null;
  assert.equal(sendWebContentsSafely({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (...args) => { safeSend = args; } },
  }, 'check:event', { ok: true }), true);
  assert.deepEqual(safeSend, ['check:event', { ok: true }]);

  const codexStyleHome = path.join(tmp, 'codex-style-home');
  const legacyElectronUserData = path.join(tmp, 'legacy-electron-user-data');
  const legacyRuntimeRoot = path.join(legacyElectronUserData, 'workspace');
  mkdirSync(path.join(legacyRuntimeRoot, 'data'), { recursive: true });
  writeFileSync(path.join(legacyRuntimeRoot, 'data', 'migration-check.txt'), 'preserved');
  const preparedUserDataRoot = prepareCodexStyleUserDataRoot({ legacyUserDataDir: legacyElectronUserData, homeDir: codexStyleHome });
  assert.equal(preparedUserDataRoot, path.join(codexStyleHome, '.janus'));
  assert.equal(codexStyleUserDataRoot({ homeDir: codexStyleHome }), preparedUserDataRoot);
  assert.equal(readFileSync(path.join(preparedUserDataRoot, 'data', 'migration-check.txt'), 'utf8'), 'preserved');
  assert.equal(existsSync(legacyRuntimeRoot), false);
  assert.equal(resolveRuntimeRoot({ isDev: false, userDataDir: preparedUserDataRoot }), preparedUserDataRoot);
  assert.equal(desktopReleaseChannel({ appName: 'Janus' }), 'stable');
  assert.equal(desktopReleaseChannel({ appName: 'Janus Test' }), 'test');
  assert.equal(desktopReleaseChannel({ appName: 'janus-test' }), 'test');
  assert.equal(desktopReleaseRootUrl('test'), 'http://your-janus.example/janus/test_releases');
  assert.equal(desktopUserDataDirectoryName('test'), '.janus-test');
  assert.equal(codexStyleUserDataRoot({ homeDir: codexStyleHome, directoryName: desktopUserDataDirectoryName('test') }), path.join(codexStyleHome, '.janus-test'));
  assert.equal(packagedAuthServerUrl(), 'http://your-janus.example');
  assert.equal(packagedAuthUserId(), '');
  assert.equal(packagedAuthServerUrl({ explicitUrl: 'https://auth.example.test/' }), 'https://auth.example.test');
  assert.equal(normalizeAuthServerUrl('not-a-url'), '');
  assert.equal(userVisibleErrorMessage(Object.assign(new Error('unauthorized'), { status: 401 })),
    '云端拒绝了当前请求；这不一定表示登录过期，请检查云端服务版本或授权状态。');
  assert.equal(userVisibleErrorMessage(Object.assign(new Error('expired'), { status: 401, code: 'session_expired' })),
    '登录状态已失效，请重新登录。');
  assert.equal(userVisibleErrorMessage(Object.assign(new Error('Device approval is required before a Sync Grant can be issued.'), { status: 409, code: 'device_not_approved' })),
    '当前设备尚未获得云端同步授权，请重新登录或稍后重试。');

  const packagedCloudRuntimeRoot = path.join(tmp, 'packaged-cloud-runtime');
  const developmentPackagedRuntime = await createRuntime({ root: packagedCloudRuntimeRoot, isDev: true });
  assert.equal(developmentPackagedRuntime.cloudSync.status().serverUrl, '');
  developmentPackagedRuntime.close();
  const configuredPackagedRuntime = await createRuntime({ root: packagedCloudRuntimeRoot, isDev: false });
  assert.equal(configuredPackagedRuntime.cloudSync.status().serverUrl, packagedAuthServerUrl(), 'packaged auth URL must seed an existing blank cloud sync target');
  configuredPackagedRuntime.close();

  const explicitAuthRoot = path.join(tmp, 'explicit-auth-runtime');
  const legacyImplicitRuntime = await createRuntime({ root: explicitAuthRoot, isDev: true });
  const legacyImplicitUser = legacyImplicitRuntime.currentUser();
  const legacySentinel = legacyImplicitRuntime.store.createSession({
    title: 'Explicit authentication preservation sentinel',
    userId: legacyImplicitUser.id,
    departmentId: 'general',
  });
  legacyImplicitRuntime.authUpdatePassword({ currentPassword: '', newPassword: 'legacy-local-admin-password1' });
  legacyImplicitRuntime.close();
  const explicitAuthRuntime = await createRuntime({
    root: explicitAuthRoot,
    isDev: true,
    requireExplicitAuthentication: true,
  });
  assert.equal(explicitAuthRuntime.currentUser(), null, 'desktop authentication gate must not silently restore the unbound local_admin account');
  assert.equal(explicitAuthRuntime.db.prepare("SELECT value FROM app_settings WHERE key='auth:active_user_id'").get().value, '');
  assert.equal(explicitAuthRuntime.db.prepare('SELECT user_id FROM sessions WHERE id=?').get(legacySentinel.id).user_id, legacyImplicitUser.id,
    'enabling the authentication gate must preserve legacy local_admin data without changing ownership');
  assert.equal((await explicitAuthRuntime.bootstrap({ remote: false })).currentUser, null,
    'anonymous desktop bootstrap must render the login or registration surface');
  const explicitlyRegistered = explicitAuthRuntime.authRegister({
    email: 'explicit-auth@example.com',
    password: 'explicit-auth-password1',
    displayName: 'Explicit Auth User',
  });
  assert.notEqual(explicitlyRegistered.id, 'local_admin');
  explicitAuthRuntime.close();
  const restoredExplicitAuthRuntime = await createRuntime({
    root: explicitAuthRoot,
    isDev: true,
    requireExplicitAuthentication: true,
  });
  assert.equal(restoredExplicitAuthRuntime.currentUser().id, explicitlyRegistered.id,
    'an explicitly authenticated account may remain active across restarts');
  restoredExplicitAuthRuntime.close();

  const remoteIdentityUser = { id: 'local_cloud_user', remoteBound: true, remoteId: 'remote_cloud_user' };
  const cloudConfigWrites = [];
  const cloudSyncRequests = [];
  let boundCloudStatus = { userId: '', serverUrl: '' };
  const identityApi = createIdentityRuntimeApi({
    auth: { currentUser: () => remoteIdentityUser },
    socialRelay: {
      enabled: () => true,
      status: () => ({ serverUrl: 'https://auth.example.test' }),
      login: async () => ({ ok: true, source: 'login' }),
      register: async () => ({ ok: true, source: 'register' }),
    },
    cloudSync: {
      status: () => boundCloudStatus,
      saveConfig(payload) {
        cloudConfigWrites.push(payload);
        boundCloudStatus = { ...boundCloudStatus, userId: payload.userId, serverUrl: payload.serverUrl };
        return boundCloudStatus;
      },
      requestAutoSync(payload) {
        cloudSyncRequests.push(payload);
        return Promise.reject(new Error('injected background sync failure'));
      },
    },
    currentUser: () => remoteIdentityUser,
  });
  assert.equal((await identityApi.authLogin({ identifier: 'cloud-user' })).source, 'login');
  assert.deepEqual(cloudConfigWrites, [{ serverUrl: 'https://auth.example.test', userId: 'remote_cloud_user' }]);
  assert.deepEqual(cloudSyncRequests, [{ reason: 'auth_connected', delayMs: 0 }]);
  assert.equal((await identityApi.authRegister({ email: 'cloud@example.test', password: 'cloud-register1' })).source, 'register', 'background sync failure must not fail registration');
  assert.deepEqual(cloudSyncRequests, [
    { reason: 'auth_connected', delayMs: 0 },
    { reason: 'auth_connected', delayMs: 0 },
  ]);

  const employeeCloud = {
    employeeOverview: async () => ({ policyVersion: 'employee_cloud_authority_v1', quota: { limit: 10 }, recruitableFamilies: [] }),
    status: () => ({ lastError: 'unrelated global cloud error', multiMemory: { enabled: true, readOnly: false } }),
  };
  const employeeApi = createEmployeeRuntimeApi({
    auth: { requireUser: () => ({ id: 'local_cloud_user', role: 'member' }) },
    store: {
      getEmployeeQuota: () => ({ used: 0, limit: 10 }),
      ensureSystemAgentInstances: () => [],
      listEmployeeRoster: () => [],
      listRecruitableAgentFamilies: () => [],
      listRecruitmentEvents: () => [],
    },
    cloudSync: employeeCloud,
  });
  assert.equal((await employeeApi.employeeOverview()).lastSyncError, '', 'unrelated global sync errors must not appear as employee sync failures');
  employeeCloud.employeeOverview = async () => {
    const error = new Error('Cloud sync is not configured for employee authority.');
    error.code = 'cloud_not_configured';
    throw error;
  };
  assert.equal((await employeeApi.employeeOverview()).lastSyncError, 'cloud_not_configured');
  employeeCloud.employeeOverview = async () => {
    const error = new Error('Cloud GET http://internal.example.test/v1/employees failed.');
    error.status = 503;
    throw error;
  };
  assert.equal((await employeeApi.employeeOverview()).lastSyncError, 'employee_cloud_http_503');
  const partialProgression = {
    status: 'partial', refreshedAt: '2026-08-04T00:00:00.000Z', lastError: 'agent_instance_not_found',
    instances: {
      instance_a: { status: 'synchronized', refreshedAt: '2026-08-04T00:00:00.000Z', lastError: '' },
      instance_b: { status: 'partial', refreshedAt: '2026-08-04T00:00:00.000Z', lastError: 'agent_instance_not_found' },
    },
  };
  assert.equal(progressionSyncForEmployee(partialProgression, 'instance_a').lastError, '',
    'one stale Agent identity must not show a progression error on another Agent');
  assert.equal(progressionSyncForEmployee(partialProgression, 'instance_b').lastError, 'agent_instance_not_found');

  const retentionRoot = path.join(tmp, 'release-retention');
  for (const version of ['0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.2.0']) {
    mkdirSync(path.join(retentionRoot, version), { recursive: true });
  }
  const retention = await prunePlatformReleaseDirectories(retentionRoot, { keep: 3 });
  assert.deepEqual(retention.retained, ['0.2.0', '0.1.3', '0.1.2']);
  assert.deepEqual(retention.removed, ['0.1.1', '0.1.0']);
  assert.equal(existsSync(path.join(retentionRoot, '0.1.1')), false);
  const prereleaseRetentionRoot = path.join(tmp, 'test-release-retention');
  for (const version of ['0.3.0-test.1', '0.3.0-test.2', '0.3.0-test.3', '0.3.0-test.4']) {
    mkdirSync(path.join(prereleaseRetentionRoot, version), { recursive: true });
  }
  const prereleaseRetention = await prunePlatformReleaseDirectories(prereleaseRetentionRoot, { keep: 3 });
  assert.deepEqual(prereleaseRetention.retained, ['0.3.0-test.4', '0.3.0-test.3', '0.3.0-test.2']);
  assert.deepEqual(prereleaseRetention.removed, ['0.3.0-test.1']);

  const legacyWorkspaceRoot = path.join(tmp, 'legacy-private-workspace-db');
  mkdirSync(path.join(legacyWorkspaceRoot, 'data'), { recursive: true });
  const legacyWorkspaceDbPath = path.join(legacyWorkspaceRoot, 'data', 'janus.db');
  const legacyWorkspaceDb = new DatabaseSync(legacyWorkspaceDbPath);
  legacyWorkspaceDb.exec(`CREATE TABLE agent_delegation_workspace_messages (
    id TEXT PRIMARY KEY,
    delegation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    UNIQUE(delegation_id, user_id, id)
  )`);
  legacyWorkspaceDb.close();
  const migratedWorkspaceDb = openDatabase(legacyWorkspaceRoot);
  const migratedWorkspaceColumns = new Set(migratedWorkspaceDb.prepare('PRAGMA table_info(agent_delegation_workspace_messages)').all().map((row) => row.name));
  assert.ok(migratedWorkspaceColumns.has('source_event_id'));
  assert.ok(migratedWorkspaceColumns.has('source_group_message_id'));
  assert.ok(migratedWorkspaceDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_delegation_workspace_messages_source_event'").get());
  migratedWorkspaceDb.close();

  const legacyCollaborationMessageRoot = path.join(tmp, 'legacy-collaboration-message-db');
  mkdirSync(path.join(legacyCollaborationMessageRoot, 'data'), { recursive: true });
  const legacyCollaborationMessageDb = new DatabaseSync(path.join(legacyCollaborationMessageRoot, 'data', 'janus.db'));
  legacyCollaborationMessageDb.exec(`CREATE TABLE collaboration_group_messages (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,
    sender_agent_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'friend',
    content TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
  );
  INSERT INTO collaboration_group_messages (
    id, group_id, sender_user_id, content, created_at, updated_at
  ) VALUES ('legacy_group_message', 'legacy_group', 'legacy_user', 'preserved', '2026-01-01', '2026-01-01');`);
  legacyCollaborationMessageDb.close();
  const migratedCollaborationMessageDb = openDatabase(legacyCollaborationMessageRoot);
  const migratedCollaborationMessageColumns = new Set(migratedCollaborationMessageDb.prepare('PRAGMA table_info(collaboration_group_messages)').all().map((row) => row.name));
  assert.ok(migratedCollaborationMessageColumns.has('source_event_id'));
  assert.ok(migratedCollaborationMessageDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_collaboration_messages_source_event'").get());
  assert.equal(migratedCollaborationMessageDb.prepare("SELECT content FROM collaboration_group_messages WHERE id = 'legacy_group_message'").get().content, 'preserved');
  migratedCollaborationMessageDb.close();

  const legacyCloudCollaborationMessageHome = path.join(tmp, 'legacy-cloud-collaboration-message-db');
  mkdirSync(legacyCloudCollaborationMessageHome, { recursive: true });
  const legacyCloudCollaborationMessageDb = new DatabaseSync(path.join(legacyCloudCollaborationMessageHome, 'cloud.db'));
  legacyCloudCollaborationMessageDb.exec(`CREATE TABLE collaboration_group_messages (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,
    sender_agent_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'friend',
    content TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
  );
  INSERT INTO collaboration_group_messages (
    id, group_id, sender_user_id, content, created_at, updated_at
  ) VALUES ('legacy_cloud_group_message', 'legacy_cloud_group', 'legacy_cloud_user', 'preserved', '2026-01-01', '2026-01-01');`);
  legacyCloudCollaborationMessageDb.close();
  const migratedCloudCollaborationMessageDb = openCloudDatabase(legacyCloudCollaborationMessageHome);
  const migratedCloudCollaborationMessageColumns = new Set(migratedCloudCollaborationMessageDb.prepare('PRAGMA table_info(collaboration_group_messages)').all().map((row) => row.name));
  assert.ok(migratedCloudCollaborationMessageColumns.has('source_event_id'));
  assert.ok(migratedCloudCollaborationMessageDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_cloud_collaboration_messages_source_event'").get());
  assert.equal(migratedCloudCollaborationMessageDb.prepare("SELECT content FROM collaboration_group_messages WHERE id = 'legacy_cloud_group_message'").get().content, 'preserved');
  migratedCloudCollaborationMessageDb.close();

  const legacyCloudDelegationHome = path.join(tmp, 'legacy-cloud-delegation-db');
  mkdirSync(legacyCloudDelegationHome, { recursive: true });
  const legacyCloudDelegationDb = new DatabaseSync(path.join(legacyCloudDelegationHome, 'cloud.db'));
  legacyCloudDelegationDb.exec(`CREATE TABLE agent_delegations (
    id TEXT PRIMARY KEY,
    account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
    requester_user_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    sender_agent_id TEXT NOT NULL DEFAULT 'secretary_agent',
    recipient_agent_id TEXT NOT NULL DEFAULT 'secretary_agent',
    title TEXT NOT NULL DEFAULT '',
    instruction TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'assigned',
    session_id TEXT NOT NULL DEFAULT '',
    task_run_id TEXT NOT NULL DEFAULT '',
    group_id TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    started_at TEXT,
    completed_at TEXT
  );
  INSERT INTO agent_delegations (
    id, requester_user_id, recipient_user_id, title, instruction, created_at, updated_at
  ) VALUES ('legacy_cloud_delegation', 'legacy_requester', 'legacy_recipient', 'preserved title', 'preserved instruction', '2026-01-01', '2026-01-01');`);
  legacyCloudDelegationDb.close();
  const migratedCloudDelegationDb = openCloudDatabase(legacyCloudDelegationHome);
  const migratedCloudDelegationColumns = new Set(migratedCloudDelegationDb.prepare('PRAGMA table_info(agent_delegations)').all().map((row) => row.name));
  assert.ok(migratedCloudDelegationColumns.has('client_request_id'));
  assert.ok(migratedCloudDelegationDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_cloud_agent_delegations_client_request'").get());
  assert.deepEqual({ ...migratedCloudDelegationDb.prepare("SELECT title,instruction,client_request_id FROM agent_delegations WHERE id = 'legacy_cloud_delegation'").get() }, {
    title: 'preserved title', instruction: 'preserved instruction', client_request_id: '',
  });
  migratedCloudDelegationDb.close();
  const reopenedCloudDelegationDb = openCloudDatabase(legacyCloudDelegationHome);
  assert.equal(reopenedCloudDelegationDb.prepare("SELECT COUNT(*) AS count FROM agent_delegations WHERE id = 'legacy_cloud_delegation'").get().count, 1);
  reopenedCloudDelegationDb.close();

  const legacyWorkScopeRoot = path.join(tmp, 'legacy-work-scope-federation-db');
  mkdirSync(path.join(legacyWorkScopeRoot, 'data'), { recursive: true });
  const legacyWorkScopeDb = new DatabaseSync(path.join(legacyWorkScopeRoot, 'data', 'janus.db'));
  legacyWorkScopeDb.exec(`CREATE TABLE work_scopes (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    parent_work_scope_id TEXT NOT NULL DEFAULT '',
    revision_id TEXT NOT NULL DEFAULT '',
    owner_user_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    UNIQUE(scope_type, source_id)
  );
  INSERT INTO work_scopes (id, scope_type, source_id) VALUES ('legacy_scope', 'task_run', 'legacy_task');`);
  legacyWorkScopeDb.close();
  const migratedWorkScopeDb = openDatabase(legacyWorkScopeRoot);
  const migratedWorkScopeColumns = new Set(migratedWorkScopeDb.prepare('PRAGMA table_info(work_scopes)').all().map((row) => row.name));
  assert.ok(migratedWorkScopeColumns.has('federation_type'));
  assert.ok(migratedWorkScopeColumns.has('federation_id'));
  assert.ok(migratedWorkScopeDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_work_scopes_federation'").get());
  assert.equal(migratedWorkScopeDb.prepare("SELECT source_id FROM work_scopes WHERE id = 'legacy_scope'").get().source_id, 'legacy_task');
  migratedWorkScopeDb.close();

  const officeSlidesPreview = renderPptxPreview({
    kind: 'pptx',
    name: 'office-preview.pptx',
    slide_image_urls: ['file:///slide-01.png', 'file:///slide-02.png'],
    slides: [{ index: 24, text: ['stale extracted text'] }],
  });
  assert.ok(officeSlidesPreview.includes('file:///slide-01.png'));
  assert.ok(!officeSlidesPreview.includes('stale extracted text'), 'Office-rendered slide images must replace PPTX text extraction in the preview');
  const officePdfPreview = renderPptxPreview({
    kind: 'pptx',
    name: 'office-preview.pptx',
    office_pdf_url: 'file:///deck.pdf',
  });
  assert.ok(officePdfPreview.includes('preview-ppt-pdf'));
  assert.ok(officePdfPreview.includes('file:///deck.pdf'));
  const fallbackDeckPreview = renderPptxPreview({
    kind: 'pptx',
    name: 'fallback-preview.pptx',
    preview_render_mode: 'fallback',
    cover_url: 'file:///fake-cover.png',
    slides: [{ index: 24, text: ['misleading extracted slide'] }],
  });
  assert.ok(fallbackDeckPreview.includes('无法生成与 PowerPoint 一致的视觉预览'));
  assert.ok(!fallbackDeckPreview.includes('fake-cover.png'));
  assert.ok(!fallbackDeckPreview.includes('misleading extracted slide'));
  assert.equal(normalizeFilePayload({ previewRenderMode: 'office' }).preview_render_mode, 'office');

  assert.equal(
    userVisibleErrorMessage(new Error("Error invoking remote method 'friends:search': NetworkRequestError: Janus communication GET /api/friends/search failed (403): 没有权限执行该操作。")),
    '没有权限执行该操作。',
  );
  assert.equal(
    userVisibleErrorMessage('同步失败：Cloud PATCH /v1/sync/batches failed (409): 该数据已经更新，请刷新后重试。'),
    '同步失败：该数据已经更新，请刷新后重试。',
  );
  assert.equal(
    userVisibleErrorMessage({
      message: 'NetworkRequestError: Request failed (429): fallback',
      body: { error: { message: '请稍后再试。' } },
    }),
    '请稍后再试。',
  );

  const dottedConfigRoot = path.join(tmp, 'dotted-codex-config');
  mkdirSync(path.join(dottedConfigRoot, 'config', 'codex'), { recursive: true });
  writeFileSync(path.join(dottedConfigRoot, 'config', 'codex', 'config.toml'), [
    'model = "gpt-5.6-sol"',
    '[projects."/path/to/Janus"]',
    'trust_level = "trusted"',
    '[tui.model_availability_nux]',
    '"gpt-5.5" = 4',
    '"gpt-5.6-sol" = 4',
    '',
  ].join('\n'));
  writeFileSync(path.join(dottedConfigRoot, 'config', 'codex', 'auth.json'), '{}\n');
  const dottedConfigArgs = sharedConfigArgs(dottedConfigRoot);
  assert.ok(dottedConfigArgs.includes('model="gpt-5.6-sol"'));
  assert.ok(!dottedConfigArgs.some((item) => item.startsWith('projects.')));
  assert.ok(!dottedConfigArgs.some((item) => item.startsWith('tui.')));

  const fakeCodexPackageRoot = path.join(tmp, 'fake-openai-codex');
  const fakeBundledCodex = path.join(
    fakeCodexPackageRoot,
    'node_modules',
    '@openai',
    'codex-linux-x64',
    'vendor',
    'x86_64-unknown-linux-musl',
    'bin',
    'codex',
  );
  mkdirSync(path.dirname(fakeBundledCodex), { recursive: true });
  writeFileSync(fakeBundledCodex, 'fake bundled codex');
  assert.deepEqual(
    bundledCodexCandidates({ platform: 'linux', arch: 'x64', packageRoots: [fakeCodexPackageRoot] }),
    [fakeBundledCodex],
  );
  const codexTlsBundle = ensureCodexTlsBundle(path.join(tmp, 'windows-codex-tls'), {
    platform: 'win32',
    rootCertificates: ['-----BEGIN CERTIFICATE-----\nmozilla-root\n-----END CERTIFICATE-----'],
    systemCertificates: [
      '-----BEGIN CERTIFICATE-----\nwindows-root\n-----END CERTIFICATE-----',
      '-----BEGIN CERTIFICATE-----\nmozilla-root\n-----END CERTIFICATE-----',
    ],
  });
  const codexTlsBundleText = readFileSync(codexTlsBundle, 'utf8');
  assert.ok(codexTlsBundleText.includes('mozilla-root'));
  assert.ok(codexTlsBundleText.includes('windows-root'));
  assert.equal(codexTlsBundleText.match(/mozilla-root/g)?.length, 1);
  assert.equal(ensureCodexTlsBundle(tmp, { platform: 'linux' }), '');
  assert.deepEqual(codexProxyEnvFromElectron('PROXY 127.0.0.1:7890; DIRECT'), {
    HTTP_PROXY: 'http://127.0.0.1:7890',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    NO_PROXY: 'localhost,127.0.0.1,::1',
  });
  assert.deepEqual(codexProxyEnvFromElectron('SOCKS5 127.0.0.1:1080'), {
    ALL_PROXY: 'socks5://127.0.0.1:1080',
    NO_PROXY: 'localhost,127.0.0.1,::1',
  });
  assert.deepEqual(codexProxyEnvFromElectron('DIRECT'), {});
  const relayConfig = codexProviderConfigForRuntime([
    'model_provider = "custom"',
    '[model_providers.custom]',
    'base_url = "https://provider.example/v1"',
    'wire_api = "responses"',
    '',
  ].join('\n'), 'http://127.0.0.1:43210');
  assert.ok(relayConfig.includes('base_url = "http://127.0.0.1:43210"'));
  assert.ok(relayConfig.includes('wire_api = "responses"'));
  const relayArgsRoot = path.join(tmp, 'relay-command-args');
  mkdirSync(path.join(relayArgsRoot, 'config', 'codex'), { recursive: true });
  writeFileSync(path.join(relayArgsRoot, 'config', 'codex', 'config.toml'), [
    'model_provider = "third_party"',
    '[model_providers.third_party]',
    'base_url = "https://provider.example/v1"',
    'env_key = "OPENAI_API_KEY"',
    '',
  ].join('\n'));
  writeFileSync(path.join(relayArgsRoot, 'config', 'codex', 'auth.json'), '{}\n');
  configureCodexProviderRelay('http://127.0.0.1:43210');
  assert.deepEqual(codexProviderRelayArgs(relayArgsRoot), [
    '--config',
    'model_providers.custom.base_url="http://127.0.0.1:43210"',
  ]);
  configureCodexProviderRelay('');
  let relayedAuthorization = '';
  let relayedBody = '';
  const relayUpstream = http.createServer(async (request, response) => {
    relayedAuthorization = String(request.headers.authorization || '');
    for await (const chunk of request) relayedBody += chunk;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"type":"response.output_text.delta","delta":"O"}\n\n');
    response.end('data: {"type":"response.completed"}\n\n');
  });
  await new Promise((resolve) => relayUpstream.listen(0, '127.0.0.1', resolve));
  const relayUpstreamUrl = `http://127.0.0.1:${relayUpstream.address().port}/v1`;
  const providerRelay = await createCodexProviderRelay({
    electronSession: { fetch: globalThis.fetch },
    getBaseUrl: () => relayUpstreamUrl,
  });
  const relayedResponse = await fetch(`${providerRelay.url}/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer relay-test', 'content-type': 'application/json' },
    body: '{"input":"hello"}',
  });
  assert.equal(relayedResponse.status, 200);
  assert.match(await relayedResponse.text(), /response\.completed/);
  assert.equal(relayedAuthorization, 'Bearer relay-test');
  assert.equal(relayedBody, '{"input":"hello"}');
  await providerRelay.close();
  await new Promise((resolve) => relayUpstream.close(resolve));

  const seedSource = path.join(tmp, 'seed-source');
  const seedTarget = path.join(tmp, 'seed-target');
  mkdirSync(seedSource, { recursive: true });
  writeFileSync(path.join(seedSource, 'managed.txt'), 'managed-v1');
  writeFileSync(path.join(seedSource, 'customizable.txt'), 'customizable-v1');
  const firstSeedSync = await syncDirFromSeed(seedSource, seedTarget);
  assert.equal(readFileSync(path.join(seedTarget, 'managed.txt'), 'utf8'), 'managed-v1');
  writeFileSync(path.join(seedTarget, 'customizable.txt'), 'user-edited');
  writeFileSync(path.join(seedSource, 'managed.txt'), 'managed-v2');
  writeFileSync(path.join(seedSource, 'customizable.txt'), 'customizable-v2');
  writeFileSync(path.join(seedSource, 'new-file.txt'), 'new-file');
  const secondSeedSync = await syncDirFromSeed(seedSource, seedTarget, { previousHashes: firstSeedSync.hashes });
  assert.equal(readFileSync(path.join(seedTarget, 'managed.txt'), 'utf8'), 'managed-v2');
  assert.equal(readFileSync(path.join(seedTarget, 'customizable.txt'), 'utf8'), 'user-edited');
  assert.equal(readFileSync(path.join(seedTarget, 'new-file.txt'), 'utf8'), 'new-file');
  assert.ok(secondSeedSync.updated.includes('managed.txt'));
  assert.ok(secondSeedSync.preserved.includes('customizable.txt'));

  const nativeUploadSource = path.join(tmp, 'native-upload-source.txt');
  writeFileSync(nativeUploadSource, 'native path upload');
  const nativeUpload = uploadFileFromPath(tmp, { sourcePath: nativeUploadSource }, 'native_user');
  assert.equal(readFileSync(nativeUpload.path, 'utf8'), 'native path upload');
  assert.equal(nativeUpload.filename, 'native-upload-source.txt');
  const outputArtifactRoot = path.join(tmp, 'message-output-artifacts');
  const outputArtifactDir = path.join(outputArtifactRoot, 'outputs', 'weather');
  mkdirSync(outputArtifactDir, { recursive: true });
  const outputReportPath = path.join(outputArtifactDir, '深圳南山区近十日天气报告.md');
  const outputChartPath = path.join(outputArtifactDir, '天气变化图.png');
  writeFileSync(outputReportPath, '# 天气报告');
  writeFileSync(outputChartPath, 'not-a-real-png');
  const collectedOutputArtifacts = collectMessageOutputArtifacts(tmp, [
    '文件下载：',
    '',
    `- [天气报告](<${outputReportPath}>)`,
    '- [天气变化图](outputs/weather/天气变化图.png)',
    `- [工作区外文件](${nativeUploadSource})`,
  ].join('\n'), { workspaceRoot: outputArtifactRoot });
  assert.deepEqual(collectedOutputArtifacts.map((item) => item.name), ['深圳南山区近十日天气报告.md', '天气变化图.png']);
  assert.equal(collectedOutputArtifacts[0].workspace_relative_path, 'outputs/weather/深圳南山区近十日天气报告.md');
  const changedPaths = collectTurnChangedFilePaths([{ changes: [
    { path: outputReportPath, kind: 'update' },
  ] }], { workspaceRoot: outputArtifactRoot });
  assert.equal(changedPaths.has(outputReportPath), true);
  assert.equal(changedPaths.has(outputChartPath), false);
  const changedOnlyArtifacts = collectMessageOutputArtifacts(tmp, [
    `- [天气报告](outputs/weather/深圳南山区近十日天气报告.md)`,
    `- [天气变化图](outputs/weather/天气变化图.png)`,
  ].join('\n'), { workspaceRoot: outputArtifactRoot, changedPaths });
  assert.deepEqual(changedOnlyArtifacts.map((item) => item.name), ['深圳南山区近十日天气报告.md']);
  const previousRendererAttachments = rendererState.attachments;
  const previousRendererMessages = rendererState.messages;
  rendererState.attachments = [{
    id: 'native-render-check',
    name: nativeUpload.filename,
    kind: 'file',
    status: 'done',
    progress: 100,
    uploaded: nativeUpload,
  }];
  rendererState.messages = [];
  try {
    const attachmentMarkup = renderChat();
    assert.ok(attachmentMarkup.includes('native-upload-source.txt'));
    assert.ok(attachmentMarkup.includes('已就绪'));
  } finally {
    rendererState.attachments = previousRendererAttachments;
    rendererState.messages = previousRendererMessages;
  }
  const previousMessageAvatarState = {
    currentUser: rendererState.currentUser,
    currentAgentId: rendererState.currentAgentId,
    currentDepartmentId: rendererState.currentDepartmentId,
    currentSessionId: rendererState.currentSessionId,
    homeMode: rendererState.homeMode,
    messages: rendererState.messages,
    sessions: rendererState.sessions,
    org: rendererState.org,
  };
  rendererState.currentUser = { id: 'avatar-check-user', displayName: 'Koali', avatarUrl: longAvatarUrl, avatar_url: longAvatarUrl };
  rendererState.currentAgentId = 'general_agent';
  rendererState.currentDepartmentId = 'general';
  rendererState.currentSessionId = 'avatar-check-session';
  rendererState.homeMode = 'department';
  rendererState.sessions = [{ id: 'avatar-check-session', agentId: 'general_agent', departmentId: 'general' }];
  rendererState.org = {
    ...rendererState.org,
    agents: [{ id: 'general_agent', name: 'Generalist' }],
  };
  rendererState.messages = [
    { id: 'avatar-check-user-message', role: 'user', content: '右侧用户消息', createdAt: '2026-07-31T08:00:00.000Z', metadata: {} },
    { id: 'avatar-check-user-followup', role: 'user', content: '右侧连续消息', createdAt: '2026-07-31T08:01:00.000Z', metadata: {} },
    { id: 'avatar-check-user-later', role: 'user', content: '间隔较久后重新显示头像', createdAt: '2026-07-31T08:10:00.000Z', metadata: {} },
    { id: 'avatar-check-agent-message', role: 'assistant', content: '左侧 Agent 消息', createdAt: '2026-07-31T08:11:00.000Z', metadata: {} },
    { id: 'avatar-check-agent-followup', role: 'assistant', content: '左侧连续消息', createdAt: '2026-07-31T08:12:00.000Z', metadata: { outputArtifacts: collectedOutputArtifacts } },
  ];
  try {
    const avatarMarkup = renderChat();
    assert.match(avatarMarkup, /message user has-chat-avatar[\s\S]*message-shell[\s\S]*chat-message-avatar is-person is-self/);
    assert.match(avatarMarkup, /message assistant has-chat-avatar[\s\S]*chat-message-avatar is-agent tone-0[\s\S]*message-shell/);
    assert.match(avatarMarkup, /title="Koali"/);
    assert.equal(avatarMarkup.includes(`src="${longAvatarUrl}"`), true);
    assert.match(avatarMarkup, /chat-message-avatar is-person is-self has-custom-avatar[\s\S]*data-user-avatar-image/);
    assert.match(avatarMarkup, /<img class="agent-avatar-image" src="\.\.\/\.\.\/assets\/system_agents\/general_agent\/avatar\.png"/);
    assert.equal((avatarMarkup.match(/chat-message-avatar is-person is-self/g) || []).length, 2);
    assert.equal((avatarMarkup.match(/chat-message-avatar is-agent tone-0/g) || []).length, 1);
    assert.equal((avatarMarkup.match(/chat-message-avatar-spacer/g) || []).length, 2);
    assert.equal((avatarMarkup.match(/is-consecutive-message/g) || []).length, 2);
    assert.equal((avatarMarkup.match(/has-consecutive-next/g) || []).length, 2);
    assert.match(avatarMarkup, /message-output-artifacts/);
    assert.match(avatarMarkup, /深圳南山区近十日天气报告\.md/);
    assert.match(avatarMarkup, /data-preview-file=/);
    assert.match(avatarMarkup, /data-open-file=/);
  } finally {
    Object.assign(rendererState, previousMessageAvatarState);
  }
  rendererState.messages = [{
    id: 'ppt-progress-render-check',
    role: 'assistant',
    content: '正在制作第 4/12 页：总体技术路线',
    departmentId: 'ppt_department',
    metadata: {
      transient: 'run-status',
      stage: 'working',
      pptProgress: {
        phase: 'render',
        currentSlide: 4,
        totalSlides: 12,
        phaseCurrent: 4,
        phaseTotal: 12,
        overallPercent: 43,
        slideTitle: '总体技术路线',
        attempt: 1,
      },
    },
  }];
  try {
    const pptProgressMarkup = renderChat();
    assert.ok(pptProgressMarkup.includes('ppt-run-progress'));
    assert.ok(pptProgressMarkup.includes('ppt-run-progress-stages'));
    assert.ok(pptProgressMarkup.includes('4 / 12 页'));
    assert.ok(pptProgressMarkup.includes('总体 43%'));
    assert.ok(pptProgressMarkup.includes('总体技术路线'));
    rendererState.messages = [{
      id: 'ppt-image-progress-render-check',
      role: 'assistant',
      content: '已复用第 6/12 页的缓存配图',
      departmentId: 'ppt_department',
      metadata: {
        transient: 'run-status',
        stage: 'working',
        pptProgress: {
          phase: 'image',
          currentSlide: 6,
          totalSlides: 12,
          phaseCurrent: 1,
          phaseTotal: 2,
          overallPercent: 18,
          slideTitle: '核心案例',
          status: 'cached',
          cacheHits: 1,
          concurrency: 2,
        },
      },
    }];
    const pptImageProgressMarkup = renderChat();
    assert.ok(pptImageProgressMarkup.includes('1 / 2 张配图'));
    assert.ok(pptImageProgressMarkup.includes('缓存复用 1'));
    assert.ok(pptImageProgressMarkup.includes('并行 2'));
  } finally {
    rendererState.messages = previousRendererMessages;
  }
  const longAnswer = `完整协作结果：${'长内容'.repeat(2500)}`;
  rendererState.messages = [{ id: 'long-result-render-check', role: 'assistant', content: longAnswer, metadata: {} }];
  try {
    const longResultMarkup = renderChat();
    assert.equal(longResultMarkup.includes('long-message-details'), false);
    assert.equal(longResultMarkup.includes('展开全文'), false);
    assert.ok(longResultMarkup.includes(longAnswer.slice(-120)), 'the full answer must remain in rendered markup');
  } finally {
    rendererState.messages = previousRendererMessages;
  }
  rendererState.messages = [{
    id: 'process-timeline-render-check', role: 'assistant', content: '最终回答正文', metadata: {
      processDurationMs: 4200,
      processEvents: [
        {
          activityId: 'reason-1', activityType: 'reasoning', eventOrigin: 'codex', status: 'completed',
          detail: '先确认协议事件，再检查渲染状态。',
          summaryParts: [{ index: 0, text: '先确认协议事件，再检查渲染状态。' }],
          reasoningText: '逐项读取 Codex reasoning text。', nativeSource: 'codex_app_server',
          protocolEvents: [{ sequence: 1, method: 'item/reasoning/textDelta' }],
        },
        {
          activityId: 'thread-state', activityType: 'status', eventOrigin: 'codex', status: 'completed',
          title: 'Codex 线程状态更新', detail: '[object Object]', threadId: 'thread-private',
          protocolEvents: [{ sequence: 2, method: 'thread/status/changed', envelope: { method: 'thread/status/changed', params: { status: { type: 'idle' } } } }],
        },
        {
          activityId: 'stage-1', activityType: 'commentary', eventOrigin: 'codex', status: 'completed',
          title: '执行说明', detail: '阶段一开始：检查命令、文件和测试。', threadId: 'thread-private',
        },
        {
          activityId: 'command-1', activityType: 'command', eventOrigin: 'codex', status: 'completed',
          command: 'git status --short --branch', cwd: '~/Janus-main', output: '## main\n M src/demo.js', exitCode: 0, durationMs: 120,
        },
        {
          activityId: 'command-2', activityType: 'command', eventOrigin: 'codex', status: 'completed',
          command: 'rg --files src', output: 'src/demo.js', exitCode: 0,
        },
        {
          activityId: 'file-1', activityType: 'file', eventOrigin: 'codex', status: 'completed', title: '文件处理', detail: 'update · src/demo.js',
          changes: [{ path: '/repo/src/demo.js', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' }], diff: '@@ -1 +1 @@\n-old\n+new',
        },
        {
          activityId: 'sandbox-ready', activityType: 'sandbox', eventOrigin: 'codex', status: 'completed',
          title: 'Windows Sandbox 已就绪', detail: '',
        },
        { activityId: 'planning-old', activityType: 'reasoning', eventOrigin: 'janus', status: 'completed', detail: '模拟的路由思考。' },
        { activityId: 'protocol-only-1', activityType: 'protocol', eventOrigin: 'codex', status: 'completed', detail: 'raw protocol' },
      ],
    },
  }];
  try {
    const processMarkup = renderChat();
    assert.ok(processMarkup.includes('codex-transcript'));
    assert.equal(processMarkup.includes('process-transcript'), false);
    assert.ok(processMarkup.includes('先确认协议事件，再检查渲染状态。'));
    assert.equal(processMarkup.includes('逐项读取 Codex reasoning text。'), false);
    assert.equal(processMarkup.includes('模拟的路由思考。'), false);
    assert.ok(processMarkup.includes('阶段一开始：检查命令、文件和测试。'));
    assert.equal(processMarkup.includes('[object Object]'), false);
    assert.equal(processMarkup.includes('Codex 线程状态更新'), false);
    assert.equal(processMarkup.includes('thread-private'), false);
    assert.equal(processMarkup.includes('<details class="codex-technical-stream">'), false);
    assert.equal(processMarkup.includes('raw protocol'), false);
    assert.equal(processMarkup.includes('Windows Sandbox 已就绪'), false);
    assert.equal(processMarkup.includes('暂无额外详情。'), false);
    assert.equal(processMarkup.includes('<div class="codex-transcript-label">思考</div>'), false);
    assert.ok(processMarkup.includes('<details class="codex-process-disclosure" data-process-toggle="process-timeline-render-check">'));
    assert.doesNotMatch(processMarkup, /data-process-toggle="process-timeline-render-check"[^>]* open/);
    assert.ok(processMarkup.includes('<span>已处理</span><small>4s</small>'));
    assert.ok(processMarkup.includes('运行了多个命令'));
    assert.match(processMarkup, /codex-command-group is-completed[^>]*data-codex-command-group-toggle="process-timeline-render-check::command-1"/);
    assert.doesNotMatch(processMarkup, /data-codex-command-group-toggle="process-timeline-render-check::command-1"[^>]* open/);
    assert.doesNotMatch(processMarkup, /data-codex-command-toggle="process-timeline-render-check::command-1"[^>]* open/);
    assert.ok(processMarkup.includes('$ git status --short --branch'));
    assert.ok(processMarkup.includes('## main'));
    assert.ok(processMarkup.includes('~/Janus-main'));
    assert.ok(processMarkup.includes('退出码 0'));
    assert.ok(processMarkup.includes('<strong>修改了</strong>'));
    assert.ok(processMarkup.includes('src/demo.js'));
    assert.ok(processMarkup.includes('codex-change-summary'));
    assert.ok(processMarkup.includes('已编辑 1 个文件'));
    assert.ok(processMarkup.includes('data-codex-review-open="codex-review-template-process-timeline-render-check"'));
    assert.ok(processMarkup.includes('data-codex-review-template'));
    assert.ok(processMarkup.includes('data-codex-review-dialog'));
    assert.ok(processMarkup.includes('<small>上一轮 · '));
    assert.ok(processMarkup.includes('data-codex-review-panel="file-0" open'));
    assert.equal(processMarkup.includes('/repo/src/demo.js'), false);
    assert.equal(processMarkup.includes('assistant-result'), false);
    assert.equal(processMarkup.includes('执行说明</'), false);
    assert.ok(processMarkup.includes('最终回答正文'));
  } finally {
    rendererState.messages = previousRendererMessages;
  }
  rendererState.messages = [{
    id: 'expanded-command-render-check', role: 'assistant', content: '', metadata: {
      transient: 'process', streaming: true, processEvents: [
        {
          activityId: 'command-expanded', activityType: 'command', eventOrigin: 'codex', status: 'running',
          command: 'node scripts/check.mjs', output: 'still running', commandGroupExpanded: true, expanded: true,
        },
        { activityId: 'reason-between', activityType: 'reasoning', eventOrigin: 'codex', status: 'running', detail: '等待检查结束后继续。' },
        { activityId: 'command-after', activityType: 'command', eventOrigin: 'codex', status: 'completed', command: 'git diff --check', exitCode: 0 },
        { activityId: 'status-running', activityType: 'status', eventOrigin: 'janus', status: 'running', title: '运行中', detail: '普通心跳。' },
        { activityId: 'status-cancelled', activityType: 'status', eventOrigin: 'janus', status: 'cancelled', title: '执行已中断', detail: '已保留现有记录。' },
      ],
    },
  }];
  try {
    const expandedMarkup = renderChat();
    assert.equal((expandedMarkup.match(/codex-single-command/g) || []).length, 2,
      'live Agent processing must retain compact command-operation hints');
    assert.ok(expandedMarkup.includes('<span>处理中</span>'));
    assert.equal(expandedMarkup.includes('等待检查结束后继续。'), true);
    assert.equal(expandedMarkup.includes('普通心跳。'), false);
    assert.ok(expandedMarkup.includes('执行已中断'));
  } finally {
    rendererState.messages = previousRendererMessages;
  }
  rendererState.messages = [{
    id: 'failed-command-render-check', role: 'assistant', content: '', metadata: {
      transient: 'process', streaming: true, processEvents: [{
        activityId: 'failed-command', activityType: 'command', eventOrigin: 'codex', status: 'failed',
        command: 'node failing-test.mjs', output: 'AssertionError', exitCode: 1, durationMs: 45,
      }],
    },
  }];
  try {
    const failedCommandMarkup = renderChat();
    assert.ok(failedCommandMarkup.includes('codex-single-command'));
    assert.ok(failedCommandMarkup.includes('运行未成功'));
    assert.doesNotMatch(failedCommandMarkup, /data-codex-command-group-toggle="failed-command-render-check::failed-command"/);
    assert.doesNotMatch(failedCommandMarkup, /data-codex-command-toggle="failed-command-render-check::failed-command"/);
    assert.ok(failedCommandMarkup.includes('codex-command-item is-failed is-direct'));
    assert.ok(failedCommandMarkup.includes('AssertionError'));
    assert.ok(failedCommandMarkup.includes('退出码 1'));
  } finally {
    rendererState.messages = previousRendererMessages;
  }
  rendererState.messages = [{
    id: 'recovered-command-render-check', role: 'assistant', content: '已改用备用接口并完成结果。', metadata: {
      processDurationMs: 3000,
      processEvents: [
        {
          activityId: 'archive-command', activityType: 'command', eventOrigin: 'codex', status: 'failed',
          command: 'curl archive-api.example', output: 'request failed', exitCode: 1,
        },
        {
          activityId: 'forecast-command', activityType: 'command', eventOrigin: 'codex', status: 'completed',
          command: 'curl forecast-api.example', output: 'ok', exitCode: 0,
        },
      ],
    },
  }];
  try {
    const recoveredCommandMarkup = renderChat();
    assert.ok(recoveredCommandMarkup.includes('<span>已处理</span><small>3s</small>'));
    assert.equal(recoveredCommandMarkup.includes('处理失败'), false);
    assert.ok(recoveredCommandMarkup.includes('运行了多个命令'));
    assert.match(recoveredCommandMarkup, /codex-command-group is-completed/);
    assert.ok(recoveredCommandMarkup.includes('运行未成功'));
    assert.ok(recoveredCommandMarkup.includes('已改用备用接口并完成结果。'));
  } finally {
    rendererState.messages = previousRendererMessages;
  }
  const collaborationTranscriptMarkup = renderCodexTranscript([{
    actorId: 'general_agent', command: 'npm test', output: 'all passed', status: 'completed',
    payload: { activityId: 'task-command', activityType: 'command', eventOrigin: 'codex', exitCode: 0 },
  }], {
    messageId: 'task-ubuddy-check',
    actorLabelForEvent: (item) => item.actorId === 'general_agent' ? '通用 Agent' : '',
  });
  assert.ok(collaborationTranscriptMarkup.includes('codex-single-command'));
  assert.ok(collaborationTranscriptMarkup.includes('$ npm test'));
  assert.ok(collaborationTranscriptMarkup.includes('通用 Agent'));
  assert.ok(collaborationTranscriptMarkup.includes('codex-command-item is-completed is-direct'));
  const statusOnlyLiveTranscriptMarkup = renderCodexTranscript([{
    activityId: 'agent-starting', activityType: 'status', eventOrigin: 'janus', status: 'running',
    title: 'Agent 正在启动', detail: '正在准备运行环境。',
  }], { messageId: 'status-only-live-check', streaming: true, startedAt: Date.now() - 2000 });
  assert.match(statusOnlyLiveTranscriptMarkup, /class="codex-transcript is-streaming"/);
  assert.match(statusOnlyLiveTranscriptMarkup, /<span>处理中<\/span>/);
  assert.doesNotMatch(statusOnlyLiveTranscriptMarkup, /Agent 正在启动|正在准备运行环境/);
  assert.equal(renderCodexTranscript([{
    activityId: 'agent-settled', activityType: 'status', eventOrigin: 'janus', status: 'completed',
  }], { messageId: 'status-only-settled-check' }), '');
  const activeOperationBatchMarkup = renderCodexTranscript([
    {
      activityId: 'active-batch-reasoning', activityType: 'commentary', eventOrigin: 'codex', status: 'completed',
      detail: '我会依次执行检索操作。',
    },
    {
      activityId: 'active-batch-command', activityType: 'command', eventOrigin: 'codex', status: 'running',
      command: 'node scripts/query.mjs', output: '',
    },
  ], { messageId: 'active-operation-batch-check', streaming: true });
  assert.match(activeOperationBatchMarkup, /<details class="codex-reasoning-actions" open>/);
  assert.ok(activeOperationBatchMarkup.includes('正在执行 1 项操作'));
  assert.doesNotMatch(activeOperationBatchMarkup, /data-codex-command-toggle="active-operation-batch-check::active-batch-command" open/);
  const waitingModelMarkup = renderCodexTranscript([{
    activityId: 'model-first-response-waiting-thread-check', activityType: 'model', eventOrigin: 'codex', status: 'running',
    title: '模型服务响应较慢，继续等待（2/5）', detail: '上游模型服务尚未返回输出；已等待约 120 秒，Janus 将保留当前请求并继续等待响应。',
  }], { messageId: 'model-waiting-check', streaming: true });
  assert.match(waitingModelMarkup, /class="codex-operation-item type-model is-running is-model-waiting"/);
  assert.match(waitingModelMarkup, /data-model-waiting/);
  const completedOperationBatchMarkup = renderCodexTranscript([
    {
      activityId: 'completed-batch-reasoning', activityType: 'commentary', eventOrigin: 'codex', status: 'completed',
      detail: '我会依次执行检索操作。',
    },
    {
      activityId: 'completed-batch-command', activityType: 'command', eventOrigin: 'codex', status: 'completed',
      command: 'node scripts/query.mjs', output: 'done', exitCode: 0,
    },
  ], { messageId: 'completed-operation-batch-check', streaming: true });
  assert.doesNotMatch(completedOperationBatchMarkup, /<details class="codex-reasoning-actions" open>/);
  assert.ok(completedOperationBatchMarkup.includes('已执行 1 项操作'));
  const nativeFileDiffMarkup = renderCodexTranscript([
    {
      activityId: 'native-file-css', activityType: 'file', eventOrigin: 'codex', nativeSource: 'codex_app_server', status: 'completed',
      changes: [{
        path: '/home/private/Janus-main/src/renderer/styles/demo.css', kind: 'update',
        diff: 'diff --git a/src/renderer/styles/demo.css b/src/renderer/styles/demo.css\n--- a/src/renderer/styles/demo.css\n+++ b/src/renderer/styles/demo.css\n@@ -1,2 +1,3 @@\n-old\n+new\n context\n+added',
      }],
    },
    {
      activityId: 'native-file-doc', activityType: 'file', eventOrigin: 'codex', nativeSource: 'codex_app_server', status: 'completed',
      changes: [{ path: '/home/private/Janus-main/docs/demo.md', kind: 'add', diff: '@@ -0,0 +1 @@\n+document' }],
    },
    {
      activityId: 'native-turn-diff', activityType: 'file', eventOrigin: 'codex', nativeSource: 'codex_app_server', status: 'completed',
      diff: '@@ -1 +1 @@\n-old\n+new',
    },
  ], { messageId: 'native-file-diff-check' });
  assert.ok(nativeFileDiffMarkup.includes('<strong>文件变更</strong>'));
  assert.ok(nativeFileDiffMarkup.includes('修改 1 个，新增 1 个 · +3 −1'));
  assert.ok(nativeFileDiffMarkup.includes('src/renderer/styles/demo.css'));
  assert.ok(nativeFileDiffMarkup.includes('codex-diff-line is-delete'));
  assert.ok(nativeFileDiffMarkup.includes('codex-diff-line is-add'));
  assert.ok(nativeFileDiffMarkup.includes('codex-diff-line is-hunk'));
  assert.ok(nativeFileDiffMarkup.includes('<code>+++ b/src/renderer/styles/demo.css</code>'));
  assert.equal((nativeFileDiffMarkup.match(/codex-file-change"/g) || []).length, 2);
  assert.equal(nativeFileDiffMarkup.includes('/home/private/'), false);
  const changeSummaryModel = codexTurnChangeModel([
    {
      activityId: 'summary-file-css', activityType: 'file', status: 'completed', workspaceRoot: '/home/private/Janus-main',
      changes: [{ path: '/home/private/Janus-main/src/renderer/styles/demo.css', kind: 'update', diff: '@@ -1 +1,2 @@\n-old\n+new\n+next' }],
    },
    {
      activityId: 'summary-file-doc', activityType: 'file', status: 'completed', workspaceRoot: '/home/private/Janus-main',
      changes: [{ path: '/home/private/Janus-main/docs/demo.md', kind: 'add', diff: '@@ -0,0 +1 @@\n+document' }],
    },
  ]);
  assert.equal(changeSummaryModel.files.length, 2);
  assert.equal(changeSummaryModel.additions, 3);
  assert.equal(changeSummaryModel.deletions, 1);
  assert.equal(changeSummaryModel.files[0].path, 'src/renderer/styles/demo.css');
  const legacyPlainAddEvents = [{
    activityId: 'legacy-object-kind-add', activityType: 'file', status: 'completed', workspaceRoot: '/home/private/Janus-main',
    changes: [{ path: '/home/private/Janus-main/three_lines.md', relativePath: 'three_lines.md', kind: '[object Object]',
      diff: '# line one\nline two\nline three\n' }],
    protocolEvents: [{ params: { item: { changes: [{ path: '/home/private/Janus-main/three_lines.md', kind: { type: 'add' } }] } } }],
  }];
  const legacyPlainAddModel = codexTurnChangeModel(legacyPlainAddEvents);
  assert.equal(legacyPlainAddModel.files[0].kind, 'add');
  assert.equal(legacyPlainAddModel.files[0].additions, 3);
  assert.equal(legacyPlainAddModel.files[0].deletions, 0);
  const legacyPlainAddMarkup = renderCodexChangeSummary(legacyPlainAddEvents, { messageId: 'legacy-plain-add-check' });
  assert.equal((legacyPlainAddMarkup.match(/codex-review-diff-line is-add/g) || []).length, 6);
  assert.ok(legacyPlainAddMarkup.includes('codex-review-diff-new">3</span>'));
  assert.ok(legacyPlainAddMarkup.includes('<span class="codex-change-additions">+3</span>'));
  const authoritativeChangeModel = codexTurnChangeModel([
    ...changeSummaryModel.files.map((file, index) => ({
      activityId: `granular-${index}`, activityType: 'file', status: 'completed',
      changes: [{ path: file.path, kind: file.kind, diff: file.diff }],
    })),
    {
      activityId: 'turn-diff-authoritative', activityType: 'file', status: 'completed',
      diff: 'diff --git a/src/renderer/styles/demo.css b/src/renderer/styles/demo.css\n--- a/src/renderer/styles/demo.css\n+++ b/src/renderer/styles/demo.css\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/docs/new.md b/docs/new.md\nnew file mode 100644\n--- /dev/null\n+++ b/docs/new.md\n@@ -0,0 +1 @@\n+created',
    },
  ]);
  assert.equal(authoritativeChangeModel.files.length, 2);
  assert.equal(authoritativeChangeModel.additions, 2);
  assert.equal(authoritativeChangeModel.deletions, 1);
  assert.equal(authoritativeChangeModel.files[1].label, '新增');
  const metricOnlyEvents = [
    {
      activityId: 'granular-created-text', activityType: 'file', status: 'completed', workspaceRoot: '/home/private/Janus-main',
      changes: [{
        path: '/home/private/Janus-main/docs/notes.md', kind: 'add',
        comparison: {
          status: 'complete', strict: true, operation: 'add', kind: 'md',
          semantic: { afterMetrics: { lines: 4, characters: 128 } },
        },
      }],
    },
    {
      activityId: 'turn-diff-created-text', activityType: 'file', status: 'completed',
      diff: 'diff --git a/docs/notes.md b/docs/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/docs/notes.md',
    },
  ];
  const metricOnlyModel = codexTurnChangeModel(metricOnlyEvents);
  assert.equal(metricOnlyModel.additions, 0);
  assert.equal(metricOnlyModel.files[0].createdContentMetric.value, 128);
  const metricOnlyMarkup = renderCodexChangeSummary(metricOnlyEvents, { messageId: 'metric-only-check' });
  assert.ok(metricOnlyMarkup.includes('\u65b0\u589e 128 \u5b57\u7b26'));
  assert.ok(metricOnlyMarkup.includes('\u5b57\u7b26 128'));
  assert.ok(metricOnlyMarkup.includes('data-codex-review-resizer'));
  assert.equal(metricOnlyMarkup.includes('+0'), false);
  const changeSummaryMarkup = renderCodexChangeSummary([
    { activityType: 'file', status: 'completed', workspaceRoot: '/home/private/Janus-main', changes: changeSummaryModel.files.map((file) => ({ ...file, kind: 'update' })) },
  ], { messageId: 'summary-check' });
  assert.ok(changeSummaryMarkup.includes('codex-change-summary'));
  assert.ok(changeSummaryMarkup.includes('data-codex-review-template'));
  assert.ok(changeSummaryMarkup.includes('data-codex-review-dialog'));
  assert.ok(changeSummaryMarkup.includes('data-codex-review-select="file-0"'));
  assert.ok(changeSummaryMarkup.includes('data-codex-review-panel="file-0" open'));
  assert.ok(changeSummaryMarkup.includes('data-codex-review-current'));
  assert.equal(changeSummaryMarkup.includes('/home/private/'), false);
  const binaryFileDiffMarkup = renderCodexTranscript([{
    activityId: 'native-file-binary', activityType: 'file', eventOrigin: 'codex', status: 'completed',
    changes: [{ path: '/home/private/Janus-main/assets/demo.png', kind: 'update', diff: 'Binary files a/assets/demo.png and b/assets/demo.png differ' }],
  }]);
  assert.ok(binaryFileDiffMarkup.includes('这是二进制文件变更'));
  assert.ok(binaryFileDiffMarkup.includes('图片资源'));
  assert.ok(binaryFileDiffMarkup.includes('预览当前图片'));
  assert.ok(binaryFileDiffMarkup.includes('data-open-file='));
  assert.ok(binaryFileDiffMarkup.includes('data-show-file='));
  assert.ok(binaryFileDiffMarkup.includes('data-copy-file-path="assets/demo.png"'));
  const imagePreviewPayload = JSON.parse(decodeURIComponent(binaryFileDiffMarkup.match(/data-preview-file="([^"]+)"/)?.[1] || '%7B%7D'));
  assert.equal(imagePreviewPayload.kind, '', 'path-only image actions must use the secure renderer preview pipeline to materialize a file URL');
  assert.equal(binaryFileDiffMarkup.includes('codex-diff-line is-add'), false);
  const documentSemanticMarkup = renderCodexTranscript([{
    activityId: 'native-file-docx', activityType: 'file', eventOrigin: 'codex', status: 'completed',
    changes: [{
      path: '/home/private/Janus-main/docs/specification.docx', kind: 'update',
      diff: 'Binary files a/docs/specification.docx and b/docs/specification.docx differ',
    }],
  }]);
  assert.ok(documentSemanticMarkup.includes('Word 文档'));
  assert.ok(documentSemanticMarkup.includes('标题、段落、列表和表格'));
  assert.ok(documentSemanticMarkup.includes('预览当前文档'));
  assert.ok(documentSemanticMarkup.includes('class="codex-file-path-button"'));
  const collaborationDocumentMarkup = renderCodexTranscript([{
    activityId: 'task-file-docx', activityType: 'file', eventOrigin: 'codex', status: 'completed',
    changes: [{ path: '/home/private/Janus-main/docs/task.docx', kind: 'update' }],
  }], { messageId: 'task-collaboration-file' });
  assert.equal(collaborationDocumentMarkup.includes('data-preview-file='), false);
  assert.equal(collaborationDocumentMarkup.includes('data-open-file='), false);
  const fileApprovalMarkup = renderCodexTranscript([{
    activityId: 'request-file-approval', activityType: 'approval', eventOrigin: 'codex', status: 'waiting',
    title: '文件修改等待批准', approvalType: 'file',
    changes: [{ path: '/home/private/Janus-main/docs/approval.docx', kind: 'update' }],
  }]);
  assert.ok(fileApprovalMarkup.includes('需要确认一项操作'));
  assert.ok(fileApprovalMarkup.includes('等待批准'));
  assert.ok(fileApprovalMarkup.includes('预览展示当前磁盘版本'));
  const failedFileMarkup = renderCodexTranscript([{
    activityId: 'failed-file-change', activityType: 'file', eventOrigin: 'codex', status: 'failed',
    changes: [{ path: '/home/private/Janus-main/docs/failed.pdf', kind: 'update' }],
  }]);
  assert.ok(failedFileMarkup.includes('<strong>文件修改失败</strong>'));
  assert.ok(failedFileMarkup.includes('class="codex-file-change-status is-failed">修改失败</span>'));
  assert.ok(failedFileMarkup.includes('修改操作未成功'));
  const turnOnlyDiffMarkup = renderCodexTranscript([{
    activityId: 'native-turn-only-diff', activityType: 'file', eventOrigin: 'codex', status: 'completed',
    diff: '@@ -8 +8 @@\n-before\n+after',
  }]);
  assert.ok(turnOnlyDiffMarkup.includes('本轮统一差异 · +1 −1'));
  assert.ok(turnOnlyDiffMarkup.includes('codex-diff-line is-delete'));
  assert.ok(turnOnlyDiffMarkup.includes('codex-diff-line is-add'));
  const fileKindsMarkup = renderCodexTranscript([{
    activityId: 'native-file-kinds', activityType: 'file', eventOrigin: 'codex', status: 'completed',
    changes: [
      { path: '/home/private/Janus-main/src/removed.js', kind: 'delete' },
      { path: '/home/private/Janus-main/src/old-name.js', kind: 'move', movePath: '/home/private/Janus-main/src/new-name.js' },
    ],
  }]);
  assert.ok(fileKindsMarkup.includes('删除 1 个，移动 1 个'));
  assert.ok(fileKindsMarkup.includes('移动到 <code>src/new-name.js</code>'));
  const longFileDiffMarkup = renderCodexTranscript([{
    activityId: 'native-file-long', activityType: 'file', eventOrigin: 'codex', status: 'completed',
    changes: [{
      path: '/home/private/Janus-main/src/generated.js', kind: 'add',
      diff: ['@@ -0,0 +1,245 @@', ...Array.from({ length: 245 }, (_, index) => `+line ${index + 1}`)].join('\n'),
    }],
  }]);
  assert.ok(longFileDiffMarkup.includes('继续显示其余 6 行'));
  const previousSelfChatState = {
    currentUser: rendererState.currentUser,
    networkPanelOpen: rendererState.networkPanelOpen,
    networkConversationPeerId: rendererState.networkConversationPeerId,
    networkConversationMode: rendererState.networkConversationMode,
    networkConversationMessages: rendererState.networkConversationMessages,
    networkMessageHomeOpen: rendererState.networkMessageHomeOpen,
    networkPanelView: rendererState.networkPanelView,
    socialThreads: rendererState.socialThreads,
    friendOverview: rendererState.friendOverview,
    friendDirectoryCategory: rendererState.friendDirectoryCategory,
    friendDirectoryView: rendererState.friendDirectoryView,
    contactsActivePane: rendererState.contactsActivePane,
    collaborationGroupId: rendererState.collaborationGroupId,
    collaborationGroupDetail: rendererState.collaborationGroupDetail,
  };
  rendererState.currentUser = { id: 'self-chat-user-id', displayName: 'koali', username: 'koali-user', avatarUrl: longAvatarUrl, avatar_url: longAvatarUrl };
  rendererState.networkPanelOpen = true;
  rendererState.networkConversationPeerId = 'self-chat-user-id';
  rendererState.networkConversationMode = 'person';
  rendererState.networkConversationMessages = [];
  rendererState.friendOverview = { friends: [], requests: { incoming: [], outgoing: [] } };
  rendererState.collaborationGroupId = '';
  rendererState.collaborationGroupDetail = null;
  try {
    const selfChatMarkup = renderChat();
    assert.match(selfChatMarkup, /<strong>koali<\/strong>/);
    assert.match(selfChatMarkup, /开始聊天/);
    assert.doesNotMatch(selfChatMarkup, /文件传输助手|自己与自己的消息|给自己发送/);
    rendererState.networkConversationPeerId = 'avatar-friend-id';
    rendererState.friendOverview = {
      friends: [{ friend: { id: 'avatar-friend-id', displayName: '刘思杰', avatarUrl: replacementAvatarUrl, avatar_url: replacementAvatarUrl } }],
      requests: { incoming: [], outgoing: [] },
    };
    rendererState.networkConversationMessages = [
      { id: 'avatar-direct-peer', senderUserId: 'avatar-friend-id', recipientUserId: 'self-chat-user-id', content: '左侧联系人消息' },
      { id: 'avatar-direct-peer-followup', senderUserId: 'avatar-friend-id', recipientUserId: 'self-chat-user-id', content: '左侧联系人连续消息' },
      { id: 'avatar-direct-self', senderUserId: 'self-chat-user-id', recipientUserId: 'avatar-friend-id', content: '右侧自己的消息' },
      { id: 'avatar-direct-self-followup', senderUserId: 'self-chat-user-id', recipientUserId: 'avatar-friend-id', content: '右侧自己的连续消息' },
    ];
    const directAvatarMarkup = renderChat();
    assert.match(directAvatarMarkup, /message assistant social-group-message direct-social-message has-chat-avatar[\s\S]*chat-message-avatar is-person is-peer[\s\S]*message-shell/);
    assert.match(directAvatarMarkup, /message user social-group-message direct-social-message has-chat-avatar[\s\S]*message-shell[\s\S]*chat-message-avatar is-person is-self/);
    assert.equal((directAvatarMarkup.match(/data-user-avatar-image/g) || []).length, 2);
    assert.match(directAvatarMarkup, />思杰<\/span>/);
    assert.equal((directAvatarMarkup.match(/chat-message-avatar is-person is-peer/g) || []).length, 1);
    assert.equal((directAvatarMarkup.match(/chat-message-avatar is-person is-self/g) || []).length, 1);
    assert.equal((directAvatarMarkup.match(/chat-message-avatar-spacer/g) || []).length, 2);
    rendererState.collaborationGroupId = 'avatar-group-id';
    rendererState.collaborationGroupDetail = {
      group: { id: 'avatar-group-id', ownerUserId: 'self-chat-user-id', title: '头像任务群', status: 'active' },
      members: [
        { userId: 'self-chat-user-id', status: 'active', user: rendererState.currentUser },
        { userId: 'avatar-friend-id', status: 'active', user: { id: 'avatar-friend-id', displayName: '刘思杰', avatarUrl: replacementAvatarUrl } },
      ],
      tasks: [],
      messages: [
        { id: 'avatar-group-peer', senderUserId: 'avatar-friend-id', sender: { id: 'avatar-friend-id', displayName: '刘思杰', avatarUrl: replacementAvatarUrl }, content: '左侧群成员消息', metadata: {} },
        { id: 'avatar-group-self', senderUserId: 'self-chat-user-id', sender: rendererState.currentUser, content: '自己的群消息', metadata: {} },
      ],
    };
    const groupAvatarMarkup = renderChat();
    assert.match(groupAvatarMarkup, /message assistant social-group-message has-chat-avatar[\s\S]*chat-message-avatar is-person is-peer[\s\S]*message-shell/);
    assert.match(groupAvatarMarkup, /message user social-group-message has-chat-avatar[\s\S]*chat-message-avatar is-person is-self[\s\S]*message-shell/);
    assert.equal((groupAvatarMarkup.match(/data-user-avatar-image/g) || []).length, 2);
    assert.match(groupAvatarMarkup, /<span>koali<\/span>/);
    rendererState.networkMessageHomeOpen = true;
    rendererState.networkPanelView = 'messages';
    rendererState.socialThreads = [{
      friend: { id: 'self-chat-user-id', displayName: '旧名称', remark: '文件传输助手' },
      messages: [{
        id: 'self-chat-message', senderUserId: 'self-chat-user-id', recipientUserId: 'self-chat-user-id',
        content: '自己的普通联系人会话', status: 'read', updatedAt: new Date().toISOString(),
      }],
    }];
    const selfConversationListMarkup = renderNetworkPanel();
    assert.match(selfConversationListMarkup, /<strong>koali<\/strong>/);
    assert.doesNotMatch(selfConversationListMarkup, /文件传输助手|旧名称/);
    assert.match(selfConversationListMarkup, /network-user-avatar has-custom-avatar[\s\S]*data-user-avatar-image/);
    rendererState.socialThreads = [{
      friend: { id: 'avatar-friend-id', displayName: '刘思杰', avatarUrl: replacementAvatarUrl },
      messages: [{
        id: 'avatar-list-message', senderUserId: 'avatar-friend-id', recipientUserId: 'self-chat-user-id',
        content: '联系人头像同步消息', status: 'sent', updatedAt: new Date().toISOString(),
      }],
    }];
    rendererState.friendOverview = {
      friends: [{ friend: { id: 'avatar-friend-id', displayName: '刘思杰', avatarUrl: replacementAvatarUrl } }],
      requests: { incoming: [], outgoing: [] },
      organizations: [],
    };
    const peerConversationListMarkup = renderNetworkPanel();
    assert.match(peerConversationListMarkup, /network-user-avatar has-custom-avatar[\s\S]*data-user-avatar-image/);
    assert.equal(peerConversationListMarkup.includes(`src="${replacementAvatarUrl}"`), true);
    assert.match(peerConversationListMarkup, /im-conversation-preview-prefix" data-no-localize>Sijie Liu · <\/span><span data-no-localize>联系人头像同步消息<\/span>/);
    rendererState.socialThreads[0].messages.push({
      id: 'avatar-list-message-self', senderUserId: 'self-chat-user-id', recipientUserId: 'avatar-friend-id',
      content: '我发送的联系人消息', status: 'read', updatedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    const selfSentConversationListMarkup = renderNetworkPanel();
    assert.match(selfSentConversationListMarkup, /class="network-message-preview"><span data-no-localize>我发送的联系人消息<\/span><\/span>/);
    assert.doesNotMatch(selfSentConversationListMarkup, /im-conversation-preview-prefix"[^>]*>Sijie Liu · <\/span><span data-no-localize>我发送的联系人消息<\/span>/);
    rendererState.networkPanelView = 'friends';
    rendererState.friendDirectoryCategory = 'external';
    rendererState.friendDirectoryView = 'contacts';
    rendererState.contactsActivePane = 'contacts';
    const contactsAvatarMarkup = renderContactsWorkspace();
    assert.match(contactsAvatarMarkup, /network-user-avatar has-custom-avatar[\s\S]*data-user-avatar-image/);
    assert.equal(contactsAvatarMarkup.includes(`src="${replacementAvatarUrl}"`), true);
  } finally {
    Object.assign(rendererState, previousSelfChatState);
  }
  const previousCollaborationGroupId = rendererState.collaborationGroupId;
  const previousCollaborationGroupDetail = rendererState.collaborationGroupDetail;
  const previousCollaborationCurrentUser = rendererState.currentUser;
  rendererState.currentUser = { id: 'closed-group-render-user', displayName: 'Closed Group User' };
  rendererState.collaborationGroupId = 'closed-group-render-check';
  rendererState.collaborationGroupDetail = {
    group: { id: 'closed-group-render-check', title: '已解散历史群', ownerUserId: 'closed-group-render-user', status: 'closed' },
    members: [{ userId: 'closed-group-render-user', status: 'closed', user: rendererState.currentUser }],
    messages: [{
      id: 'closed-group-history-message',
      senderUserId: 'closed-group-render-user',
      kind: 'friend',
      content: '这条解散前的群聊历史必须保留。',
      createdAt: new Date().toISOString(),
    }],
    tasks: [],
  };
  try {
    const closedGroupMarkup = renderChat();
    assert.ok(closedGroupMarkup.includes('这条解散前的群聊历史必须保留。'));
    assert.ok(closedGroupMarkup.includes('工作群已解散'));
    assert.ok(closedGroupMarkup.includes('群聊与任务工作区现为只读'));
    assert.ok(!closedGroupMarkup.includes('id="chat-form"'), 'dissolved collaboration groups must not render a composer');
  } finally {
    rendererState.collaborationGroupId = previousCollaborationGroupId;
    rendererState.collaborationGroupDetail = previousCollaborationGroupDetail;
    rendererState.currentUser = previousCollaborationCurrentUser;
  }
  rendererState.messages = [
    { id: 'ppt-summary-gap-check', role: 'assistant', content: 'PPT 页面结构已整理，共 1 页：\n\n- 第 1 页：封面' },
    { id: 'ppt-artifact-gap-check', role: 'system', content: artifactMessage('ppt', { deck_name: 'gap-check.pptx', preview: {} }) },
  ];
  try {
    const pptArtifactMarkup = renderChat();
    assert.ok(pptArtifactMarkup.includes('ppt-artifact-message'));
  } finally {
    rendererState.messages = previousRendererMessages;
  }

  const previousRendererUser = rendererState.currentUser;
  const previousAgentSettings = rendererState.userAgentSettings;
  const previousSettingsSection = rendererState.currentSettingsSection;
  const previousEvolutionPreference = rendererState.evolutionPreference;
  const previousEvolutionUpdates = rendererState.evolutionUpdates;
  const previousPersonalEvolutionVersionsByAgent = rendererState.personalEvolutionVersionsByAgent;
  const previousPersonalEvolutionExpandedAgentIds = rendererState.personalEvolutionExpandedAgentIds;
  const previousEmployeeOverview = rendererState.employeeOverview;
  rendererState.currentUser = { id: 'renderer_identity_user', displayName: 'Renderer Identity', email: 'renderer.identity@example.com', role: 'member', remoteBound: false };
  rendererState.currentSettingsSection = 'account';
  rendererState.userAgentSettings = [
    {
      id: 'renderer_instance', agentFamilyId: 'ppt', syncEnabled: true,
      activePersonalSkillVersionId: 'renderer_skill_v1',
      personalEvolutionConsent: false, clusterContributionConsent: false,
      family: { name: 'PPT Agent' },
      memoryDocuments: [{ id: 'renderer_memory0', scope: 'general', slotNo: 0, allowPersonalEvolution: false, allowClusterEvolution: false }],
    },
    {
      id: 'renderer_hidden_system', agentFamilyId: 'secretary_agent', syncEnabled: true,
      family: { name: 'uBuddy', instanceKind: 'system' }, memoryDocuments: [],
    },
  ];
  rendererState.employeeOverview = {
    roster: [],
    recruitableFamilies: [{ id: 'ppt', name: 'PPT Agent', departmentId: 'ppt_department' }],
  };
  rendererState.evolutionPreference = { authority: 'cloud', enabled: true, stateRevision: 1 };
  rendererState.evolutionUpdates = { checkedAt: '2026-07-25T08:00:00.000Z', preference: rendererState.evolutionPreference, personal: [{
    agentInstanceId: 'renderer_instance', agentFamilyId: 'ppt', agentName: 'PPT Agent', currentVersionId: 'renderer_skill_v1', availableCount: 1,
    latestAvailableVersion: { id: 'renderer_skill_v2', status: 'candidate', stabilityStatus: 'stable', available: true },
  }], market: [{
    agentFamilyId: 'ppt', name: 'PPT Agent', departmentId: 'ppt', recruited: true, agentInstanceId: 'renderer_instance',
    updateStatus: 'available', releasedVersionCount: 2, availableVersionCount: 1, currentMarketVersionId: 'renderer_market_v1',
    latestVersion: { id: 'renderer_market_v2', status: 'released', sectionCount: 2, health: { status: 'healthy' } },
  }, {
    agentFamilyId: 'research', name: 'Research Agent', departmentId: 'research', recruited: false, agentInstanceId: '',
    updateStatus: 'view_only_available', releasedVersionCount: 1, availableVersionCount: 1, currentMarketVersionId: '',
    latestVersion: { id: 'renderer_research_v1', status: 'released', sectionCount: 1 },
  }] };
  rendererState.personalEvolutionVersionsByAgent = { renderer_instance: { authority: 'cloud', items: [
    { id: 'renderer_skill_v2', status: 'candidate', stabilityStatus: 'stable', available: true },
    { id: 'renderer_skill_v1', status: 'active', stabilityStatus: 'stable' },
    { id: 'renderer_skill_v0', status: 'archived', stabilityStatus: 'stable' },
  ] } };
  rendererState.personalEvolutionExpandedAgentIds = ['renderer_instance'];
  const accountSettingsMarkup = renderSettings();
  assert.match(accountSettingsMarkup, /账户与权限/);
  assert.match(accountSettingsMarkup, /class="view settings-view settings-section-view settings-account-view"/);
  assert.equal((accountSettingsMarkup.match(/data-account-section-target=/g) || []).length, 6);
  assert.equal((accountSettingsMarkup.match(/data-account-section="/g) || []).length, 6);
  assert.match(accountSettingsMarkup, /data-account-section-menu/);
  assert.match(accountSettingsMarkup, /data-account-section="organization"/);
  assert.match(accountSettingsMarkup, /data-account-section="updates"/);
  assert.match(accountSettingsMarkup, /data-account-section="model-service"/);
  assert.match(accountSettingsMarkup, /data-account-section="profile"/);
  assert.match(accountSettingsMarkup, /data-account-section="security"/);
  assert.match(accountSettingsMarkup, /data-account-section="sign-out"/);
  assert.doesNotMatch(accountSettingsMarkup, /自进化与更新/);
  assert.doesNotMatch(accountSettingsMarkup, /Agent 云端同步/);
  assert.doesNotMatch(accountSettingsMarkup, /data-evolution-preference-toggle/);
  assert.doesNotMatch(accountSettingsMarkup, /data-agent-setting="syncEnabled"/);
  rendererState.currentSettingsSection = 'evolution-sync';
  const settingsSidebarMarkup = renderSettingsSidebar();
  assert.ok(settingsSidebarMarkup.indexOf('data-settings-section="account"')
    < settingsSidebarMarkup.indexOf('data-settings-section="preferences"'),
  '设置个人分组必须先显示账户与权限，再显示偏好');
  assert.match(settingsSidebarMarkup, /data-settings-section="evolution-sync"/);
  assert.match(settingsSidebarMarkup, /自进化与同步/);
  const identitySettingsMarkup = renderSettings();
  assert.match(identitySettingsMarkup, /自进化与同步/);
  assert.match(identitySettingsMarkup, /自进化与更新/);
  assert.doesNotMatch(identitySettingsMarkup, /data-evolution-preference-toggle/);
  assert.doesNotMatch(identitySettingsMarkup, /账户自进化/);
  assert.match(identitySettingsMarkup, /data-evolution-updates-check/);
  assert.match(identitySettingsMarkup, /更新到此版本/);
  assert.match(identitySettingsMarkup, /回退到此版本/);
  assert.match(identitySettingsMarkup, /恢复基础 Skill/);
  assert.match(identitySettingsMarkup, /公司集群 Skill/);
  assert.match(identitySettingsMarkup, /data-settings-market-family="ppt"/);
  assert.doesNotMatch(identitySettingsMarkup, /data-settings-market-family="research"/);
  assert.match(identitySettingsMarkup, /查看并选择 Skill/);
  assert.doesNotMatch(identitySettingsMarkup, /暂停会停止 Evidence 提交/);
  assert.doesNotMatch(identitySettingsMarkup, /Agent 云端同步/);
  assert.doesNotMatch(identitySettingsMarkup, /data-agent-setting="syncEnabled"/);
  assert.doesNotMatch(identitySettingsMarkup, /secretary_agent/);
  assert.doesNotMatch(identitySettingsMarkup, /data-agent-setting="personalEvolutionConsent"/);
  assert.doesNotMatch(identitySettingsMarkup, /data-agent-setting="allowPersonalEvolution"/);
  assert.doesNotMatch(identitySettingsMarkup, /data-agent-setting="allowClusterEvolution"/);
  assert.doesNotMatch(identitySettingsMarkup, /data-agent-setting="personalSkillAutoActivate"/);
  assert.doesNotMatch(identitySettingsMarkup, /已开启同步的 Agent 会自动参与云端自进化/);
  assert.doesNotMatch(identitySettingsMarkup, /尚未绑定云账号/);
  const previousPersonalStatus = rendererState.personalEvolutionStatus;
  const previousPersonalProposals = rendererState.personalEvolutionProposals;
  const previousPersonalProposalDetail = rendererState.personalEvolutionProposalDetail;
  rendererState.personalEvolutionStatus = { enabled: true, authority: 'cloud', providerBoundary: 'platform_managed', grantReady: true,
    configured: true, executionAvailable: true, readiness: { database: true, model: true, encryption: true },
    evidenceUpload: { currentAccount: { pending: 4, deferred: 2 }, otherAccountsPending: 8, permanentlyBlocked: 1,
      nextRetryAt: '2026-08-02T00:00:00.000Z' } };
  rendererState.personalEvolutionProposals = [];
  rendererState.personalEvolutionProposalDetail = {
    id: 'renderer_personal_run', agentFamilyId: 'ppt', status: 'available', summary: 'Renderer rollback check',
    memoryOperations: [{ id: 'renderer_memory_operation', status: 'applied', operationType: 'add', sectionName: 'Workflow Notes',
      proposedText: 'Verify the final artifact.', memoryDocumentId: 'renderer_memory0', baselineVersionId: 'renderer_memory0_v1' }],
  };
  const personalEvolutionMarkup = renderPersonalEvolution();
  assert.match(personalEvolutionMarkup, /我的 Agent 自进化/);
  assert.match(personalEvolutionMarkup, /云端唯一权威/);
  assert.doesNotMatch(personalEvolutionMarkup, /data-personal-evolution-run/);
  assert.doesNotMatch(personalEvolutionMarkup, /Skill 与 Memory 变更会自动应用/);
  assert.match(personalEvolutionMarkup, /等待选择版本/);
  assert.match(personalEvolutionMarkup, /data-personal-evolution-settings/);
  assert.match(personalEvolutionMarkup, /本账户待上传 <b>6<\/b>/);
  assert.match(personalEvolutionMarkup, /其他账户待处理 <b>8<\/b>/);
  assert.match(personalEvolutionMarkup, /永久阻塞 <b>1<\/b>/);
  assert.doesNotMatch(personalEvolutionMarkup, /uBuddy|secretary_agent/);
  assert.match(personalEvolutionMarkup, /data-personal-memory-rollback/);
  assert.match(personalEvolutionMarkup, /data-target-version-id="renderer_memory0_v1"/);
  const previousStage8EvolutionStatus = rendererState.stage8EvolutionStatus;
  const previousClusterEvolutionOverview = rendererState.clusterEvolutionOverview;
  const previousEmployeeSelectedInstanceId = rendererState.employeeSelectedInstanceId;
  const previousEmployeeDetailTab = rendererState.employeeDetailTab;
  const previousEmployeeMarketDrawer = rendererState.employeeMarketDrawer;
  const previousEmployeeMarketFilters = {
    query: rendererState.employeeMarketQuery,
    department: rendererState.employeeMarketDepartmentFilter,
    status: rendererState.employeeMarketStatusFilter,
  };
  const previousPluginCatalog = rendererState.pluginCatalog;
  const previousDirectoryStars = rendererState.directoryStars;
  const previousNetworkPanelState = {
    networkPanelView: rendererState.networkPanelView,
    networkMessageSearchQuery: rendererState.networkMessageSearchQuery,
    networkMessageListFilter: rendererState.networkMessageListFilter,
    networkMessageHomeOpen: rendererState.networkMessageHomeOpen,
    sessions: rendererState.sessions,
    chatRuns: rendererState.chatRuns,
    org: rendererState.org,
    employeeOverview: rendererState.employeeOverview,
    currentSessionId: rendererState.currentSessionId,
    currentChatKey: rendererState.currentChatKey,
    currentDepartmentId: rendererState.currentDepartmentId,
    currentAgentId: rendererState.currentAgentId,
    selectionSource: rendererState.selectionSource,
    homeMode: rendererState.homeMode,
    friendOverview: rendererState.friendOverview,
    socialInbox: rendererState.socialInbox,
    agentDelegations: rendererState.agentDelegations,
    collaborationOverview: rendererState.collaborationOverview,
    networkContactProfileOpen: rendererState.networkContactProfileOpen,
    networkSelectedContactId: rendererState.networkSelectedContactId,
    friendDirectoryView: rendererState.friendDirectoryView,
    friendDirectoryCategory: rendererState.friendDirectoryCategory,
    contactAddDialogOpen: rendererState.contactAddDialogOpen,
    contactAddDialogTab: rendererState.contactAddDialogTab,
    contactDirectoryContextMenu: rendererState.contactDirectoryContextMenu,
    directoryStars: rendererState.directoryStars,
    accountWorkspaces: rendererState.accountWorkspaces,
    activeAccountWorkspace: rendererState.activeAccountWorkspace,
    startupAccountWorkspace: rendererState.startupAccountWorkspace,
  };
  rendererState.networkPanelView = 'messages';
  rendererState.networkMessageSearchQuery = '';
  rendererState.networkMessageListFilter = 'all';
  rendererState.networkMessageHomeOpen = true;
  rendererState.chatRuns = [];
  rendererState.currentSessionId = '';
  rendererState.currentChatKey = 'new-renderer-message-check';
  rendererState.currentDepartmentId = '';
  rendererState.currentAgentId = '';
  rendererState.selectionSource = null;
  rendererState.homeMode = 'department';
  rendererState.employeeOverview = { roster: [] };
  rendererState.sessions = [{ id: 'general-session-hidden-check', agentId: 'general_agent', departmentId: 'general', title: '不应单独显示的私人助理会话' }];
  rendererState.org = {
    agents: [
      { id: 'secretary_agent', name: 'uBuddy', departmentId: 'secretary_department', routable: true },
      { id: 'general_agent', name: 'General Agent', departmentId: 'general', routable: true },
    ],
    departments: [],
  };
  rendererState.friendOverview = { friends: [], requests: { incoming: [], outgoing: [] } };
  rendererState.socialInbox = [];
  rendererState.agentDelegations = [];
  rendererState.collaborationOverview = { groups: [], tasks: [] };
  const messagesPanelMarkup = renderNetworkPanel();
  assert.equal((messagesPanelMarkup.match(/data-network-peer="self-secretary"/g) || []).length, 1);
  assert.equal((messagesPanelMarkup.match(/data-network-peer="self-private-assistant"/g) || []).length, 1);
  assert.match(messagesPanelMarkup, /(?:私人助理|Private)/);
  assert.match(messagesPanelMarkup, /(?:<small[^>]*>(?:本地|Local)<\/small>|aria-label="(?:私人助理，本地|Private, Local)")/);
  assert.doesNotMatch(messagesPanelMarkup, /独立每周 Token 额度|本周剩余/);
  assert.doesNotMatch(messagesPanelMarkup, /data-message-private-assistant/);
  rendererState.sessions = [];
  rendererState.org.agents.push({ id: 'writer_agent', name: 'Writer Agent', departmentId: 'writing_department', routable: true });
  rendererState.org.departments.push({ id: 'writing_department', name: '写作部门' });
  rendererState.currentDepartmentId = 'writing_department';
  rendererState.currentAgentId = 'writer_agent';
  const selectedAgentMessagesMarkup = renderNetworkPanel();
  assert.match(selectedAgentMessagesMarkup, /data-agent-inbox="writer_agent"/);
  assert.match(selectedAgentMessagesMarkup, /Writer Agent/);
  rendererState.currentDepartmentId = 'general';
  rendererState.currentAgentId = 'general_agent';
  rendererState.currentAgentInstanceId = 'selected-general-employee';
  rendererState.selectionSource = 'employee';
  rendererState.employeeOverview = { roster: [{
    id: 'selected-general-employee', agentFamilyId: 'general_agent', employmentState: 'active', routeEligible: true,
  }] };
  const selectedEmployeeMessagesMarkup = renderNetworkPanel();
  assert.match(selectedEmployeeMessagesMarkup, /data-agent-inbox="general_agent"/);
  rendererState.currentSessionId = 'general-instance-session-a';
  rendererState.currentAgentInstanceId = 'general-instance-a';
  rendererState.selectionSource = null;
  rendererState.sessions = [
    { id: 'general-instance-session-a', agentId: 'general_agent', agentInstanceId: 'general-instance-a', departmentId: 'general', title: 'A 会话', conversationRole: 'primary', updatedAt: '2026-07-29T10:00:00.000Z' },
    { id: 'general-instance-session-b', agentId: 'general_agent', agentInstanceId: 'general-instance-b', departmentId: 'general', title: 'B 会话', conversationRole: 'primary', updatedAt: '2026-07-29T11:00:00.000Z' },
  ];
  rendererState.employeeOverview = { roster: [
    { id: 'general-instance-a', agentFamilyId: 'general_agent', displayName: '通用 Agent A', note: '研究', employmentState: 'active', routeEligible: true, family: { departmentId: 'general' } },
    { id: 'general-instance-b', agentFamilyId: 'general_agent', displayName: '通用 Agent B', note: '写作', employmentState: 'active', routeEligible: true, family: { departmentId: 'general' } },
  ] };
  const multiInstanceMessagesMarkup = renderNetworkPanel();
  assert.equal((multiInstanceMessagesMarkup.match(/data-agent-message-row="general_agent"/g) || []).length, 2);
  assert.match(multiInstanceMessagesMarkup, /data-agent-instance-row="general-instance-a"/);
  assert.match(multiInstanceMessagesMarkup, /data-agent-instance-row="general-instance-b"/);
  assert.match(multiInstanceMessagesMarkup, /通用 Agent A/);
  assert.match(multiInstanceMessagesMarkup, /通用 Agent B/);
  rendererState.currentAgentId = '';
  rendererState.currentAgentInstanceId = '';
  rendererState.currentDepartmentId = '';
  rendererState.selectionSource = null;
  rendererState.employeeOverview = { roster: [] };
  rendererState.chatRuns = [{
    channelId: 'writer-pending-run', chatKey: 'writer-pending-chat', departmentId: 'writing_department', agentId: 'writer_agent',
    userMessage: '正在生成的写作请求', sessionTitle: '正在生成的写作请求', startedAt: Date.now(), terminal: false,
  }];
  rendererState.sessions = [{
    id: 'writer-older-session', agentId: 'writer_agent', departmentId: 'writing_department', title: '较早的写作会话',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }];
  const pendingAgentMessagesMarkup = renderNetworkPanel();
  assert.match(pendingAgentMessagesMarkup, /data-agent-inbox-run="writer-pending-run"/);
  assert.doesNotMatch(pendingAgentMessagesMarkup, /data-network-session="writer-older-session"/);
  assert.match(pendingAgentMessagesMarkup, /生成中/);
  assert.match(pendingAgentMessagesMarkup, /正在生成的写作请求/);
  const pendingAgentRendererSource = readFileSync(path.join(process.cwd(), 'src/renderer/app/core/rendererApp.js'), 'utf8');
  const pendingAgentHandlerStart = pendingAgentRendererSource.indexOf("document.querySelectorAll('[data-agent-inbox]')");
  const pendingAgentHandlerEnd = pendingAgentRendererSource.indexOf("document.querySelectorAll('[data-contact-profile]')", pendingAgentHandlerStart);
  const pendingAgentHandlerSource = pendingAgentRendererSource.slice(pendingAgentHandlerStart, pendingAgentHandlerEnd);
  assert.match(pendingAgentHandlerSource, /dataset\.agentInboxRun/);
  assert.match(pendingAgentHandlerSource, /state\.currentChatKey = activeRun\.chatKey/);
  assert.match(pendingAgentHandlerSource, /restoreActiveRunTransient\(\)/);
  assert.match(pendingAgentHandlerSource, /openSession\(activeRunSessionId, \{ preserveNetworkPanel: true \}\)/);
  rendererState.chatRuns = [];
  rendererState.org.agents = rendererState.org.agents.filter((agent) => agent.id !== 'writer_agent');
  rendererState.org.departments = rendererState.org.departments.filter((department) => department.id !== 'writing_department');
  rendererState.sessions = [{ id: 'general-session-employee-check', agentId: 'general_agent', agentInstanceId: 'renderer_general_employee', departmentId: 'general', title: 'Recruited employee primary session' }];
  const generalEmployeeMessagesMarkup = renderNetworkPanel();
  assert.match(generalEmployeeMessagesMarkup, /data-network-session="general-session-employee-check"/);
  rendererState.networkPanelView = 'friends';
  rendererState.friendOverview = {
    friends: [{ id: 'friendship-remark-ui', remark: '项目王老师', friend: { id: 'remark-friend', displayName: 'Wang Ming', username: 'wangming', remark: '项目王老师' } }],
    requests: { incoming: [{ id: 'request-ui', message: '你好，想添加你为好友', user: { id: 'request-user', displayName: 'Li Lei', username: 'lilei' } }], outgoing: [] },
    organizations: [{
      id: 'organization-ui', organizationNumber: 'CHECK-2026', name: 'Check 组织', role: 'owner', memberCount: 1,
      members: [{ role: 'owner', user: { id: rendererState.currentUser?.id || 'renderer-user', displayName: 'Renderer User', username: 'renderer' } }],
    }],
  };
  rendererState.networkContactProfileOpen = true;
  rendererState.networkSelectedContactId = 'remark-friend';
  rendererState.directoryStars = { contacts: {}, employees: [] };
  const contactsDirectoryMarkup = renderNetworkPanel();
  const remarkedContactsWorkspaceMarkup = renderContactsWorkspace();
  assert.match(contactsDirectoryMarkup, /data-page-kind="friends"/);
  assert.match(contactsDirectoryMarkup, /data-friend-directory-category="new"/);
  assert.match(contactsDirectoryMarkup, /data-account-organization-action="manage"/);
  assert.match(contactsDirectoryMarkup, /data-friend-directory-category="internal"/);
  assert.match(contactsDirectoryMarkup, /data-friend-directory-category="external"/);
  assert.match(contactsDirectoryMarkup, /data-friend-directory-category="groups"/);
  assert.doesNotMatch(contactsDirectoryMarkup, /data-friend-directory-category="organizations"/);
  assert.doesNotMatch(contactsDirectoryMarkup, /id="friend-search-form"/);
  assert.match(contactsDirectoryMarkup, /data-contact-add-open="contact"/);
  assert.match(contactsDirectoryMarkup, /im-directory-nav-badge/);
  assert.match(remarkedContactsWorkspaceMarkup, /项目王老师/);
  assert.match(remarkedContactsWorkspaceMarkup, /Wang Ming/);
  assert.match(remarkedContactsWorkspaceMarkup, /data-friend-remark="remark-friend"/);
  assert.match(remarkedContactsWorkspaceMarkup, /class="contact-profile-avatar avatar-viewer-trigger"[\s\S]*data-avatar-viewer-user="remark-friend"/);
  assert.match(remarkedContactsWorkspaceMarkup, /data-contact-star-toggle="remark-friend"/);
  assert.match(remarkedContactsWorkspaceMarkup, /data-contact-star-toggle="remark-friend"[^>]*>[\s\S]*?<span>星标<\/span>/);
  assert.doesNotMatch(remarkedContactsWorkspaceMarkup, /备注与描述|编辑内容|contact-profile-links/);
  rendererState.contactDirectoryContextMenu = { x: 20, y: 30, targetUserId: 'remark-friend', organizationId: '', targetRole: 'member' };
  const targetedContactMenuMarkup = renderContactsWorkspace();
  assert.match(targetedContactMenuMarkup, /data-chat-group-create-target="remark-friend"/);
  assert.match(targetedContactMenuMarkup, /data-contact-add-target="remark-friend"/);
  assert.match(pendingAgentRendererSource, /dataset\.chatGroupCreateTarget/);
  assert.match(pendingAgentRendererSource, /dataset\.contactAddTarget/);
  assert.match(pendingAgentRendererSource, /activateOrganizationWorkspace: activateJoinedOrganizationWorkspace/);
  assert.match(pendingAgentRendererSource, /setStartupAccountWorkspace\(\{ workspaceId \}\)/);
  assert.match(pendingAgentRendererSource, /switchRendererAccountWorkspace\(workspaceId, \{ notifySuccess: false, notifyError: false \}\)/);
  rendererState.contactDirectoryContextMenu = null;
  rendererState.directoryStars = { contacts: { 'remark-friend': true }, employees: [] };
  rendererState.friendDirectoryCategory = 'starred';
  const starredContactsWorkspaceMarkup = renderContactsWorkspace();
  assert.match(starredContactsWorkspaceMarkup, /data-contact-profile="remark-friend"/);
  assert.match(starredContactsWorkspaceMarkup, /contact-row-star/);
  assert.match(starredContactsWorkspaceMarkup, /data-contact-star-toggle="remark-friend"[^>]*>[\s\S]*?<span>已星标<\/span>/);
  rendererState.friendDirectoryCategory = 'organizations';
  rendererState.networkContactProfileOpen = false;
  const organizationWorkspaceMarkup = renderContactsWorkspace();
  assert.match(organizationWorkspaceMarkup, /Check 组织/);
  assert.match(organizationWorkspaceMarkup, /CHECK-2026/);
  const organizationInviteLink = buildOrganizationInviteLink({
    organizationNumber: 'CHECK-2026',
    verificationCode: 'check-invitation-code',
    organizationName: 'Check 组织',
    ownerName: 'Renderer User',
  });
  assert.deepEqual(parseOrganizationInviteLink(`请使用 ${organizationInviteLink} 加入`), {
    organizationNumber: 'CHECK-2026',
    verificationCode: 'check-invitation-code',
    organizationName: 'Check 组织',
    ownerName: 'Renderer User',
    version: '1',
    link: organizationInviteLink,
  });
  const organizationJoinPayloads = [];
  const organizationJoinInputs = new Map([
    ['organization-join-number', { value: 'MANUAL-2026' }],
    ['organization-join-code', { value: 'manual-invitation-code' }],
    ['organization-join-link', { value: organizationInviteLink }],
    ['organization-join-default', { checked: true }],
    ['organization-create-name', { value: 'Created organization' }],
    ['organization-create-number', { value: 'CREATED-2026' }],
    ['organization-create-code', { value: 'created-invitation-code' }],
  ]);
  const activatedOrganizationWorkspaces = [];
  const organizationJoinState = {
    contactAddBusy: '',
    contactAddDialogOpen: true,
    organizationJoinDraft: { organizationNumber: '', verificationCode: '', shareLink: '' },
    organizationCreateDraft: { name: '', organizationNumber: '', verificationCode: '' },
    friendOverview: { friends: [], organizations: [], requests: { incoming: [], outgoing: [] } },
  };
  const organizationJoinController = createFriendsController({
    api: {
      async joinOrganization(payload) {
        organizationJoinPayloads.push(payload);
        return { organization: { id: 'joined-organization', name: 'Joined organization' }, overview: organizationJoinState.friendOverview };
      },
      async friendsOverview() { return organizationJoinState.friendOverview; },
      async createOrganization() {
        return {
          organization: { id: 'created-organization', name: 'Created organization' },
          overview: {
            ...organizationJoinState.friendOverview,
            organizations: [{ id: 'created-organization', name: 'Created organization', organizationNumber: 'CREATED-2026' }],
          },
        };
      },
      async listAccountWorkspaces() {
        const createdWorkspace = {
          id: 'workspace_org_created-organization',
          kind: 'organization',
          organizationId: 'created-organization',
          name: 'Created organization',
        };
        return {
          workspaces: [{ id: 'workspace_personal', kind: 'personal', name: '个人空间' }, createdWorkspace],
          activeWorkspace: { id: 'workspace_personal', kind: 'personal', name: '个人空间' },
          startupWorkspace: { id: 'workspace_personal', kind: 'personal', name: '个人空间' },
        };
      },
    },
    state: organizationJoinState,
    render: () => {},
    notify: () => {},
    userErrorMessage: (error) => error?.message || String(error),
    refreshSocialInbox: async () => {},
    refreshSocialThreads: async () => {},
    refreshAgentDelegations: async () => {},
    openNetworkConversation: async () => {},
    activateOrganizationWorkspace: async (organization, options) => {
      activatedOrganizationWorkspaces.push({ organization, options });
      return { switched: true, defaultSaved: options.setAsDefault };
    },
    windowRef: { requestAnimationFrame: (callback) => callback() },
    documentRef: {
      getElementById: (id) => organizationJoinInputs.get(id) || null,
      querySelector: () => null,
    },
  });
  await organizationJoinController.joinOrganization({
    preventDefault() {},
    currentTarget: { dataset: { organizationJoinMethod: 'share-link' } },
  });
  organizationJoinInputs.get('organization-join-link').value = 'not-a-valid-link';
  organizationJoinInputs.get('organization-join-default').checked = false;
  organizationJoinState.contactAddDialogOpen = true;
  await organizationJoinController.joinOrganization({
    preventDefault() {},
    currentTarget: { dataset: { organizationJoinMethod: 'credentials' } },
  });
  assert.deepEqual(organizationJoinPayloads, [
    { organizationNumber: 'CHECK-2026', verificationCode: 'check-invitation-code' },
    { organizationNumber: 'MANUAL-2026', verificationCode: 'manual-invitation-code' },
  ]);
  assert.deepEqual(activatedOrganizationWorkspaces, [
    { organization: { id: 'joined-organization', name: 'Joined organization' }, options: { setAsDefault: true } },
    { organization: { id: 'joined-organization', name: 'Joined organization' }, options: { setAsDefault: false } },
  ]);
  organizationJoinState.friendOverview = {
    ...organizationJoinState.friendOverview,
    friends: [{ friend: { id: 'prefill-contact', username: 'prefill-user', email: 'prefill@example.com' } }],
  };
  organizationJoinController.openContactAddDialog('contact', { targetUserId: 'prefill-contact' });
  assert.equal(organizationJoinState.friendAddSearchQuery, 'prefill@example.com');
  await organizationJoinController.createOrganization({ preventDefault() {} });
  assert.deepEqual(organizationJoinState.accountWorkspaces.map((workspace) => workspace.id), [
    'workspace_personal',
    'workspace_org_created-organization',
  ]);
  assert.equal(organizationJoinState.activeAccountWorkspace.id, 'workspace_personal');
  assert.equal(organizationJoinState.contactsSelectedOrganizationId, 'created-organization');
  rendererState.contactsSelectedOrganizationId = 'organization-ui';
  rendererState.accountWorkspaces = [{
    id: 'workspace_org_organization-ui', kind: 'organization', organizationId: 'organization-ui', name: 'Check 组织',
  }];
  rendererState.activeAccountWorkspace = {
    id: 'workspace_org_organization-ui', kind: 'organization', organizationId: 'organization-ui', name: 'Check 组织',
  };
  rendererState.startupAccountWorkspace = rendererState.activeAccountWorkspace;
  rendererState.organizationShareLinks = {};
  let selectedOrganizationMarkup = renderContactsWorkspace();
  assert.match(selectedOrganizationMarkup, /当前组织/);
  assert.match(selectedOrganizationMarkup, /组织信息/);
  assert.match(selectedOrganizationMarkup, /组织偏好/);
  assert.match(selectedOrganizationMarkup, /data-organization-share-generate="organization-ui"/);
  assert.match(selectedOrganizationMarkup, /data-organization-action="update_invitation_code"/);
  assert.doesNotMatch(selectedOrganizationMarkup, /contacts-organization-switch/);
  const createdUiOrganization = {
    id: 'created-organization-ui', organizationNumber: 'CREATED-UI-2026', name: 'Created UI 组织', role: 'owner', memberCount: 1,
    members: [{ role: 'owner', user: rendererState.currentUser }],
  };
  rendererState.friendOverview = {
    ...rendererState.friendOverview,
    organizations: [...rendererState.friendOverview.organizations, createdUiOrganization],
  };
  rendererState.accountWorkspaces.push({
    id: 'workspace_org_created-organization-ui', kind: 'organization', organizationId: createdUiOrganization.id, name: createdUiOrganization.name,
  });
  rendererState.contactsSelectedOrganizationId = createdUiOrganization.id;
  const createdOrganizationMarkup = renderContactsWorkspace();
  assert.match(createdOrganizationMarkup, /Created UI 组织/);
  assert.match(createdOrganizationMarkup, /data-account-workspace-id="workspace_org_created-organization-ui"[^>]*>切换到此组织/);
  rendererState.contactsSelectedOrganizationId = 'organization-ui';
  rendererState.friendDirectoryCategory = 'internal';
  const organizationContactsMarkup = renderContactsWorkspace();
  assert.match(organizationContactsMarkup, /<span>组织内联系人<\/span>/);
  assert.doesNotMatch(organizationContactsMarkup, /contacts-organization-switch/);
  assert.doesNotMatch(organizationContactsMarkup, /data-organization-switch=/);
  rendererState.friendDirectoryCategory = 'organizations';
  rendererState.organizationShareLinks = { 'organization-ui': organizationInviteLink };
  selectedOrganizationMarkup = renderContactsWorkspace();
  assert.match(selectedOrganizationMarkup, /data-organization-share-view="organization-ui"/);
  assert.match(selectedOrganizationMarkup, /查看分享链接/);
  rendererState.organizationActionDialog = { action: 'view_invitation_link', organizationId: 'organization-ui' };
  const organizationShareLinkDialogMarkup = renderContactsWorkspace();
  assert.match(organizationShareLinkDialogMarkup, /organization-share-link-fields/);
  assert.match(organizationShareLinkDialogMarkup, /data-organization-share-link-copy/);
  assert.match(organizationShareLinkDialogMarkup, /data-organization-share-regenerate/);
  rendererState.organizationActionDialog = null;
  rendererState.organizationInvitePrompt = parseOrganizationInviteLink(organizationInviteLink);
  const organizationInvitePromptMarkup = renderContactsWorkspace();
  assert.match(organizationInvitePromptMarkup, /加入组织邀请/);
  assert.match(organizationInvitePromptMarkup, /组织名称/);
  assert.match(organizationInvitePromptMarkup, /Check 组织/);
  assert.match(organizationInvitePromptMarkup, /CHECK-2026/);
  assert.match(organizationInvitePromptMarkup, /Renderer User/);
  assert.match(organizationInvitePromptMarkup, /data-organization-invite-confirm/);
  assert.match(organizationInvitePromptMarkup, /id="organization-invite-default" type="checkbox" checked/);
  assert.match(organizationInvitePromptMarkup, /设该组织为默认工作空间/);
  rendererState.organizationInvitePrompt = null;
  rendererState.organizationInviteBusy = false;
  rendererState.organizationActionDialog = { action: 'update_invitation_code', organizationId: 'organization-ui' };
  const invitationUpdateMarkup = renderContactsWorkspace();
  assert.match(invitationUpdateMarkup, /data-organization-invitation-reset-open/);
  assert.match(invitationUpdateMarkup, /organization-invitation-help/);
  assert.match(invitationUpdateMarkup, /验证当前身份/);
  assert.match(invitationUpdateMarkup, /无需邮箱验证/);
  assert.match(invitationUpdateMarkup, /id="organization-remember-secondary-verification"/);
  assert.doesNotMatch(invitationUpdateMarkup, /data-organization-invitation-reset-send-code/);
  assert.doesNotMatch(invitationUpdateMarkup, /organization-invitation-reset-email-code/);
  rendererState.organizationActionDialog = { action: 'reset_invitation_code', organizationId: 'organization-ui' };
  const invitationResetMarkup = renderContactsWorkspace();
  assert.match(invitationResetMarkup, /重置邀请码/);
  assert.match(invitationResetMarkup, /使用邮箱重置/);
  assert.match(invitationResetMarkup, /data-organization-invitation-reset-send-code/);
  assert.match(invitationResetMarkup, /data-organization-invitation-reset-back/);
  assert.match(invitationResetMarkup, /organization_invitation_reset|organization-invitation-reset-email-code/);
  assert.doesNotMatch(invitationResetMarkup, /id="organization-action-code"/);
  assert.doesNotMatch(invitationResetMarkup, /id="organization-action-password"/);
  rendererState.organizationSecondaryVerificationById = { 'organization-ui': true };
  rendererState.organizationActionDialog = { action: 'update_invitation_code', organizationId: 'organization-ui' };
  const rememberedInvitationUpdateMarkup = renderContactsWorkspace();
  assert.match(rememberedInvitationUpdateMarkup, /本次登录已验证/);
  assert.doesNotMatch(rememberedInvitationUpdateMarkup, /id="organization-action-code"/);
  assert.doesNotMatch(rememberedInvitationUpdateMarkup, /id="organization-action-password"/);
  rendererState.organizationActionDialog = { action: 'transfer_owner', organizationId: 'organization-ui', targetUserId: 'organization-member-ui' };
  const ownerTransferMarkup = renderContactsWorkspace();
  assert.match(ownerTransferMarkup, /id="organization-transfer-retain-admin"/);
  assert.match(ownerTransferMarkup, /<option value="true" selected>保留管理员身份<\/option>/);
  assert.match(ownerTransferMarkup, /<option value="false">成为普通成员<\/option>/);
  assert.match(ownerTransferMarkup, /你仍会留在组织中/);
  assert.match(ownerTransferMarkup, /本次登录已完成二次验证/);
  assert.doesNotMatch(ownerTransferMarkup, /id="organization-action-code"/);
  rendererState.organizationActionDialog = { action: 'owner_exit', organizationId: 'organization-ui' };
  const ownerExitMarkup = renderContactsWorkspace();
  assert.match(ownerExitMarkup, /id="organization-owner-exit-mode"/);
  assert.doesNotMatch(ownerExitMarkup, /organization-transfer-retain-admin/);
  rendererState.organizationActionDialog = null;
  rendererState.organizationSecondaryVerificationById = {};
  rendererState.organizationShareLinks = {};
  rendererState.contactsSelectedOrganizationId = '';
  rendererState.contactAddDialogOpen = true;
  rendererState.contactAddDialogTab = 'join-organization';
  const contactJoinMarkup = renderContactsWorkspace();
  assert.match(contactJoinMarkup, /id="organization-join-form"/);
  assert.match(contactJoinMarkup, /id="organization-join-link-form"/);
  assert.match(contactJoinMarkup, /id="organization-join-link"/);
  assert.match(contactJoinMarkup, /任选一种方式即可加入/);
  assert.match(contactJoinMarkup, /不需要同时填写/);
  assert.match(contactJoinMarkup, /id="organization-join-default" type="checkbox" checked/);
  assert.match(contactJoinMarkup, /设该组织为默认工作空间/);
  rendererState.organizationJoinDraft = { organizationNumber: '', verificationCode: '', shareLink: '', setAsDefault: false };
  const contactJoinOptOutMarkup = renderContactsWorkspace();
  assert.doesNotMatch(contactJoinOptOutMarkup, /id="organization-join-default" type="checkbox" checked/);
  rendererState.contactAddDialogTab = 'create-organization';
  const contactAddMarkup = renderContactsWorkspace();
  assert.match(contactAddMarkup, /添加联系人与组织/);
  assert.match(contactAddMarkup, /id="organization-create-form"/);
  assert.equal((contactAddMarkup.match(/data-contact-add-tab=/g) || []).length, 3);
  rendererState.contactAddDialogOpen = false;
  rendererState.friendDirectoryCategory = 'all';
  rendererState.networkContactProfileOpen = true;
  rendererState.friendDirectoryView = 'requests';
  const friendRequestsWorkspaceMarkup = renderContactsWorkspace();
  assert.match(friendRequestsWorkspaceMarkup, /新联系人/);
  assert.match(friendRequestsWorkspaceMarkup, /Li Lei/);
  assert.match(friendRequestsWorkspaceMarkup, /你好，想添加你为好友/);
  assert.match(friendRequestsWorkspaceMarkup, /data-friend-accept="request-ui"/);
  assert.match(friendRequestsWorkspaceMarkup, /data-friend-reject="request-ui"/);
  Object.assign(rendererState, previousNetworkPanelState);
  rendererState.employeeOverview = {
    authority: 'cloud', quota: { used: 2, active: 1, reserved: 1, limit: 10, remaining: 8 },
    roster: [
      {
        id: 'renderer_ubuddy', agentFamilyId: 'secretary_agent', instanceKind: 'system', employmentState: 'active',
        defaultRecruited: true, quotaExempt: true, routeEligible: true, family: { name: 'uBuddy', departmentId: 'secretary_department' },
        currentMemory: { displayName: 'memory0' }, queueDepth: 0,
      },
      {
        id: 'renderer_pending_employee', agentFamilyId: 'writer', employmentState: 'pending_cloud_confirmation',
        pendingTargetState: 'active', stateRevision: 1, routeEligible: true, family: { name: 'Writer Agent', departmentId: 'writing' },
        currentMemory: { displayName: 'memory0' }, queueDepth: 0,
      },
    ],
    recruitableFamilies: [
      {
        id: 'research', name: 'Research Agent', departmentId: 'research_department', canRecruit: true,
        employmentState: 'not_recruited', metadata: { summary: 'Research synthesis and evidence review.', capabilityTags: ['Literature', 'Evidence'] },
      },
      {
        id: 'ppt', name: 'PPT Agent', departmentId: 'ppt_department', canRecruit: true,
        employmentState: 'not_recruited', metadata: { summary: 'Presentation planning across selectable styles.', capabilityTags: ['Slides', 'Academic'] },
      },
      {
        id: 'data_scout', name: 'Data Scout', departmentId: 'data_department', canRecruit: true,
        employmentState: 'recruitable', instances: [{ id: 'renderer_inactive_employee', employmentState: 'inactive', stateRevision: 7 }],
        metadata: { summary: 'Data analysis and validation.', capabilityTags: ['Data', 'Validation'] },
      },
      {
        id: 'active_hidden', name: 'Active Hidden Agent', departmentId: 'general', canRecruit: false,
        employmentState: 'active', instance: { id: 'renderer_active_hidden', employmentState: 'active', stateRevision: 2 },
      },
      { id: 'quota_hidden', name: 'Quota Hidden Agent', departmentId: 'general', canRecruit: false, employmentState: 'not_recruited' },
    ],
  };
  rendererState.stage8EvolutionStatus = {
    authority: 'cloud',
    cluster: { enabled: true, executionAvailable: false, code: 'evolution_model_unavailable' },
    market: { enabled: true, queryAvailable: true, adoptionAvailable: true, rollbackAvailable: true, candidateGenerationAvailable: false },
  };
  rendererState.clusterEvolutionOverview = { cohorts: [], runs: [], candidates: [] };
  const messageDefaultMarkup = renderMessageDefaultPage();
  assert.match(messageDefaultMarkup, /data-message-default-page/);
  assert.match(messageDefaultMarkup, /优秀的你，值得一朵小红花/);
  assert.doesNotMatch(messageDefaultMarkup, /data-message-employee-home|data-message-employee-card|data-employee-open-chat/);
  assert.match(renderMessageDefaultPage(1), /先把复杂的事，说清楚/);
  assert.match(renderMessageDefaultPage(1), /data-message-default-action="ubuddy"/);
  assert.match(renderMessageDefaultPage(2), /选择一个会话，开始协作/);
  assert.match(renderMessageDefaultPage(2), /data-message-default-action="talent-market"/);
  assert.deepEqual(normalizeMessageDefaultVariantOrder([2, 2, 7, 0]), [2, 0, 1]);
  assert.deepEqual(reorderMessageDefaultVariants([0, 1, 2], 0, 2), [1, 0, 2]);
  assert.equal(cycleMessageDefaultVariant([2, 0, 1], 2, 'previous'), 1);
  assert.equal(cycleMessageDefaultVariant([2, 0, 1], 1, 'next'), 2);
  const orderedMessageHome = renderMessageDefaultPage(0, { variantOrder: [2, 0, 1], orderEditorOpen: true });
  assert.match(orderedMessageHome, /data-message-default-step="previous"/);
  assert.match(orderedMessageHome, /data-message-default-step="next"/);
  assert.match(orderedMessageHome, /data-message-default-order-editor/);
  assert.ok(orderedMessageHome.indexOf('data-message-default-order-item="2"') < orderedMessageHome.indexOf('data-message-default-order-item="0"'));
  const firstOrderedMessageHome = renderMessageDefaultPage(2, { variantOrder: [2, 0, 1] });
  assert.match(firstOrderedMessageHome, /data-message-default-step="previous"/);
  assert.match(firstOrderedMessageHome, /data-message-default-step="next"/);
  const lastOrderedMessageHome = renderMessageDefaultPage(1, { variantOrder: [2, 0, 1] });
  assert.match(lastOrderedMessageHome, /data-message-default-step="previous"/);
  assert.match(lastOrderedMessageHome, /data-message-default-step="next"/);
  rendererState.pluginCatalog = [{
    id: 'ppt_creation', name: 'PPT 制作技能', chatTarget: 'pptx', providesAgentIds: ['ppt'],
    status: {
      installed: true,
      available: true,
      ready: false,
      runtimeMode: 'system',
      missing: 'PPT 制作技能缺少必要 Python 组件：python-pptx',
      dependencies: [{ id: 'python-pptx', installed: false }],
    },
  }];
  rendererState.pluginDetailId = 'ppt_creation';
  const unreadyPptPluginMarkup = renderPluginSettings();
  assert.match(unreadyPptPluginMarkup, /运行环境未就绪/);
  assert.match(unreadyPptPluginMarkup, /系统 Python/);
  assert.match(unreadyPptPluginMarkup, /修复运行环境/);
  assert.doesNotMatch(unreadyPptPluginMarkup, />立即使用</);
  rendererState.pluginDetailId = '';
  rendererState.pluginCatalog = [{
    id: 'ppt_creation', name: 'PPT 制作技能', providesAgentIds: ['ppt'],
    status: { installed: false, available: true },
  }];
  const employeesMarkup = renderEmployees();
  assert.doesNotMatch(employeesMarkup, /云端同步|同步状态/);
  assert.match(employeesMarkup, /talent-directory-quota/);
  assert.match(employeesMarkup, /员工额度/);
  assert.match(employeesMarkup, /<strong>2 \/ 10<\/strong>/);
  assert.match(employeesMarkup, /role="progressbar"[^>]*aria-valuenow="2"/);
  assert.match(employeesMarkup, /style="width:20%"/);
  assert.match(employeesMarkup, /剩余 8 名 · 1 名确认中/);
  assert.doesNotMatch(employeesMarkup, /talent-directory-title-icon|data-employees-refresh/);
  assert.match(employeesMarkup, /placeholder="搜索人才"/);
  assert.match(employeesMarkup, /talent-directory-installed/);
  assert.match(employeesMarkup, />我的员工</);
  assert.doesNotMatch(employeesMarkup, />公开<|>个人</);
  assert.match(employeesMarkup, />精选人才</);
  assert.doesNotMatch(employeesMarkup, /uBuddy/);
  assert.doesNotMatch(employeesMarkup, /data-employee-open-chat="renderer_ubuddy"/);
  assert.doesNotMatch(employeesMarkup, /公司集群进化/);
  assert.doesNotMatch(employeesMarkup, /员工团队/);
  assert.match(employeesMarkup, /data-employee-open-chat="renderer_pending_employee"/);
  assert.match(employeesMarkup, /Active Hidden Agent/);
  assert.match(employeesMarkup, /Quota Hidden Agent/);
  assert.match(employeesMarkup, /id="employee-market-search"/);
  assert.match(employeesMarkup, /data-employee-market-department-option="all"/);
  assert.match(employeesMarkup, /role="menuitemradio"/);
  assert.match(employeesMarkup, /talent-directory-group/);
  assert.match(employeesMarkup, /talent-directory-compact-tags/);
  assert.match(employeesMarkup, /data-employee-recruit="research"/);
  assert.doesNotMatch(employeesMarkup, /Research synthesis and evidence review/);
  assert.match(employeesMarkup, /research_department/);
  assert.match(employeesMarkup, /data-employee-recruit="active_hidden" disabled/);
  assert.match(employeesMarkup, /data-employee-recruit="quota_hidden" disabled/);
  assert.match(employeesMarkup, /data-employee-recruit="data_scout"/);
  assert.doesNotMatch(employeesMarkup, /需要安装 PPT 制作技能/);
  assert.match(employeesMarkup, /data-plugin-install="ppt_creation"[^>]*data-plugin-agent-family="ppt"/);
  assert.doesNotMatch(employeesMarkup, /data-employee-recruit="ppt"/);
  rendererState.directoryStars = { contacts: {}, employees: ['renderer_pending_employee'] };
  rendererState.employeeContextMenu = { agentInstanceId: 'renderer_pending_employee', x: 20, y: 20 };
  const starredEmployeeMarkup = renderEmployees();
  assert.match(starredEmployeeMarkup, /talent-directory-installed-star/);
  assert.match(starredEmployeeMarkup, /data-employee-context-action="toggle-star"/);
  assert.match(starredEmployeeMarkup, /取消星标员工/);
  rendererState.employeeContextMenu = null;
  rendererState.employeeMarketCandidateId = 'ppt';
  const employeeCandidateDetailMarkup = renderEmployees();
  assert.match(employeeCandidateDetailMarkup, /talent-candidate-drawer/);
  assert.match(employeeCandidateDetailMarkup, /需要安装 PPT 制作技能/);
  assert.match(employeeCandidateDetailMarkup, /必须先安装该 Skill，安装完成后才可招募此 Agent/);
  assert.match(employeeCandidateDetailMarkup, /data-plugin-install="ppt_creation"/);
  assert.match(employeeCandidateDetailMarkup, /data-open-plugin-settings/);
  rendererState.employeeMarketCandidateId = '';
  rendererState.employeeMarketQuery = 'validation';
  const searchedEmployeesMarkup = renderEmployees();
  assert.match(searchedEmployeesMarkup, /Data Scout/);
  assert.doesNotMatch(searchedEmployeesMarkup, /Research Agent/);
  rendererState.employeeMarketQuery = '';
  rendererState.employeeOverview.lastSyncError = 'cloud_not_configured';
  const localOnlyEmployeesMarkup = renderEmployees();
  assert.doesNotMatch(localOnlyEmployeesMarkup, /employee-sync-warning|尚未连接云端/);
  rendererState.employeeOverview.lastSyncError = 'device_not_approved';
  const pendingDeviceEmployeesMarkup = renderEmployees();
  assert.doesNotMatch(pendingDeviceEmployeesMarkup, /当前设备尚未获得云端同步授权/);
  assert.doesNotMatch(pendingDeviceEmployeesMarkup, /Device approval is required/);
  rendererState.employeeOverview.lastSyncError = 'employee_cloud_http_503';
  const unavailableEmployeesMarkup = renderEmployees();
  assert.doesNotMatch(unavailableEmployeesMarkup, /错误码：employee_cloud_http_503/);
  rendererState.employeeOverview.lastSyncError = '';
  rendererState.employeeSelectedInstanceId = 'renderer_pending_employee';
  rendererState.employeeDetailTab = 'overview';
  const employeeOverviewMarkup = renderEmployees();
  assert.match(employeeOverviewMarkup, /Agent 详情/);
  assert.match(employeeOverviewMarkup, /概览/);
  assert.match(employeeOverviewMarkup, />记忆</);
  assert.match(employeeOverviewMarkup, />成长</);
  assert.match(employeeOverviewMarkup, /查看 Skill 版本/);
  assert.match(employeeOverviewMarkup, /data-employee-star-toggle="renderer_pending_employee"/);
  assert.match(employeeOverviewMarkup, /取消星标员工/);
  assert.match(employeeOverviewMarkup, /实际管理范围和协作 Memory 权限只来自/);
  rendererState.employeeSelectedInstanceId = '';
  rendererState.employeeMarketDrawer = {
    source: 'employees', agentInstanceId: 'renderer_pending_employee', agentFamilyId: 'research', familyName: 'Research Agent',
    recruited: true, items: [], effectiveSkill: null, canary: null, conflictPreview: null, loading: false, busy: false, error: '',
  };
  const employeeMarketBackMarkup = renderEmployees();
  assert.match(employeeMarketBackMarkup, /data-employee-market-back="renderer_pending_employee"/);
  assert.match(employeeMarketBackMarkup, /aria-label="返回员工详情"/);
  rendererState.employeeOverview = previousEmployeeOverview;
  rendererState.stage8EvolutionStatus = previousStage8EvolutionStatus;
  rendererState.clusterEvolutionOverview = previousClusterEvolutionOverview;
  rendererState.employeeSelectedInstanceId = previousEmployeeSelectedInstanceId;
  rendererState.employeeDetailTab = previousEmployeeDetailTab;
  rendererState.employeeMarketDrawer = previousEmployeeMarketDrawer;
  rendererState.directoryStars = previousDirectoryStars;
  rendererState.employeeMarketQuery = previousEmployeeMarketFilters.query;
  rendererState.employeeMarketDepartmentFilter = previousEmployeeMarketFilters.department;
  rendererState.employeeMarketStatusFilter = previousEmployeeMarketFilters.status;
  rendererState.pluginCatalog = previousPluginCatalog;
  rendererState.personalEvolutionStatus = previousPersonalStatus;
  rendererState.personalEvolutionProposals = previousPersonalProposals;
  rendererState.personalEvolutionProposalDetail = previousPersonalProposalDetail;
  rendererState.evolutionPreference = previousEvolutionPreference;
  rendererState.evolutionUpdates = previousEvolutionUpdates;
  rendererState.personalEvolutionVersionsByAgent = previousPersonalEvolutionVersionsByAgent;
  rendererState.personalEvolutionExpandedAgentIds = previousPersonalEvolutionExpandedAgentIds;
  rendererState.currentUser = previousRendererUser;
  rendererState.userAgentSettings = previousAgentSettings;
  rendererState.currentSettingsSection = previousSettingsSection;

  const pptRegression = resolvePythonInvocation([path.join(process.cwd(), 'scripts', 'ppt_slide_library_regression.py')], { required: true });
  execFileSync(pptRegression.command, pptRegression.args, { cwd: process.cwd(), stdio: 'pipe' });
  const sparseSlideDeck = path.join(tmp, 'sparse-internal-slide-numbers.pptx');
  const sparseSlideFixture = resolvePythonInvocation([
    '-c',
    [
      'import sys',
      'from pptx import Presentation',
      'prs=Presentation(sys.argv[1])',
      'remove_count=max(0, len(prs.slides)-3)',
      'for _ in range(remove_count):',
      ' sld_id=prs.slides._sldIdLst[0]',
      ' prs.part.drop_rel(sld_id.rId)',
      ' prs.slides._sldIdLst.remove(sld_id)',
      'prs.save(sys.argv[2])',
    ].join('\n'),
    path.join(process.cwd(), 'assets', 'departments', 'ppt_department', 'templates', '通用多功能PPT模板.pptx'),
    sparseSlideDeck,
  ], { required: true });
  execFileSync(sparseSlideFixture.command, sparseSlideFixture.args, { cwd: process.cwd(), stdio: 'pipe' });
  const regressionDeckPreview = renderUploadedFile(tmp, { path: sparseSlideDeck });
  assert.deepEqual(
    regressionDeckPreview.slides.map((slide) => slide.index),
    regressionDeckPreview.slides.map((_slide, index) => index + 1),
    'PPTX text fallback must use visible slide order instead of sparse internal slide XML numbers',
  );
  assert.deepEqual(pptProgressMilestones(299_999), []);
  assert.deepEqual(pptProgressMilestones(300_000), [5]);
  assert.deepEqual(pptProgressMilestones(420_000), [5, 7]);
  assert.deepEqual(pptProgressMilestones(600_000), [5, 7, 10]);
  assert.deepEqual(pptProgressMilestones(1_200_000), [5, 7, 10, 15, 20]);
  assert.equal(pptOverallPercent({ phase: 'parse', phaseCurrent: 1, phaseTotal: 1 }), 8);
  assert.equal(pptOverallPercent({ phase: 'image', phaseCurrent: 1, phaseTotal: 2, currentSlide: 11, totalSlides: 12 }), 18);
  assert.equal(pptOverallPercent({ phase: 'render', phaseCurrent: 6, phaseTotal: 12 }), 50);
  assert.equal(pptOverallPercent({ phase: 'qa', phaseCurrent: 1, phaseTotal: 1 }), 82);
  assert.equal(pptOverallPercent({ phase: 'repair', phaseCurrent: 6, phaseTotal: 12, attempt: 2 }), 85);
  assert.equal(pptOverallPercent({ phase: 'preview', phaseCurrent: 1, phaseTotal: 1 }), 100);

  const pptRuntimeRoot = path.join(tmp, 'ppt-runtime-root');
  const pptProjectRoot = path.join(tmp, 'ppt-project-root');
  const pptSourceDir = path.join(pptRuntimeRoot, 'outputs', 'ppt_department', 'session-workspace-output');
  const pptSourceDeck = path.join(pptSourceDir, 'workspace-output.pptx');
  const pptSourceNotes = path.join(pptSourceDir, 'speaker-notes.md');
  mkdirSync(pptSourceDir, { recursive: true });
  writeFileSync(pptSourceDeck, 'pptx fixture');
  writeFileSync(pptSourceNotes, 'notes fixture');
  const relocatedPpt = relocatePptResult({ deck: pptSourceDeck, notes: pptSourceNotes, slide_images: [] }, {
    root: pptRuntimeRoot,
    outputRoot: pptProjectRoot,
  });
  assert.ok(relocatedPpt.deck.startsWith(pptProjectRoot));
  assert.doesNotMatch(path.relative(pptProjectRoot, relocatedPpt.deck), /(^|[\\/])outputs([\\/]|$)/);
  assert.doesNotMatch(path.relative(pptProjectRoot, relocatedPpt.deck), /(^|[\\/])ppt_department([\\/]|$)/);
  assert.ok(existsSync(relocatedPpt.deck));
  assert.ok(existsSync(relocatedPpt.notes));
  assert.equal(existsSync(pptSourceDir), false);

  const priorEvolutionAuthority = process.env.JANUS_EVOLUTION_AUTHORITY;
  process.env.JANUS_EVOLUTION_AUTHORITY = 'legacy_test';
  const runtime = await createRuntime({
    root: tmp,
    isDev: true,
    serverAuthoritativeSkills: true,
    probeCodexProviderImpl: async ({ baseUrl }) => ({
      status: 'pass', summary: 'test provider reachable',
      modelIds: String(baseUrl).includes('raw.example') ? ['gpt-raw'] : [],
    }),
  });
  if (priorEvolutionAuthority === undefined) delete process.env.JANUS_EVOLUTION_AUTHORITY;
  else process.env.JANUS_EVOLUTION_AUTHORITY = priorEvolutionAuthority;
  const deliveryUser = runtime.currentUser();
  const deliverySource = runtime.ensureSecretarySession({ title: 'Delivery progress check' });
  const deliveryInstance = runtime.store.findUserAgentInstance({ userId: deliveryUser.id, agentFamilyId: 'general_agent' });
  assert.ok(deliveryInstance?.id);
  const deliveryTarget = runtime.store.getPrimaryAgentSession({ userId: deliveryUser.id, agentInstanceId: deliveryInstance.id })
    || runtime.store.createSession({
      title: 'Delivery target check', userId: deliveryUser.id, departmentId: 'general',
      agentId: 'general_agent', agentInstanceId: deliveryInstance.id,
    });
  runtime.store.createAgentDeliveryReceipt({
    userId: deliveryUser.id, sourceSessionId: deliverySource.id, targetSessionId: deliveryTarget.id,
    targetAgentInstanceId: deliveryInstance.id, requestMessageId: 'delivery_request_check', workId: 'delivery_work_check',
    metadata: { targetAgentId: 'general_agent', targetAgentName: 'General Agent' },
  });
  runtime.store.recordAgentDeliveryEvent({ workId: 'delivery_work_check', status: 'queued', event: { kind: 'progress', stage: 'queued', message: '等待执行' } });
  runtime.store.recordAgentDeliveryEvent({ workId: 'delivery_work_check', status: 'running', event: { kind: 'progress', stage: 'working', message: '正在执行' } });
  const deliveryRuns = runtime.listAgentDeliveryRuns({ sessionId: deliverySource.id, statuses: ['queued', 'running'] });
  assert.equal(deliveryRuns.length, 1);
  assert.equal(deliveryRuns[0].deliveryStatus, 'running');
  assert.deepEqual(deliveryRuns[0].events.map((item) => item.message), ['等待执行', '正在执行']);
  const officialAgents = discoverCodexAgents(tmp);
  assert.ok(officialAgents.some((agent) => agent.id === 'general_agent'));
  assert.ok(officialAgents.some((agent) => agent.id === 'ppt'));
  assert.equal(officialAgents.some((agent) => ['ppt_academic_report', 'ppt_major_project', 'ppt_research_scout'].includes(agent.id)), false);

  const pptMergeRoot = path.join(tmp, 'ppt-agent-consolidation-rehearsal');
  let pptMergeRuntime = await createRuntime({ root: pptMergeRoot, isDev: true, serverAuthoritativeSkills: true });
  pptMergeRuntime.store.upsertAgentFamily({
    id: 'ppt_academic_report', name: 'Legacy Academic PPT', departmentId: 'ppt_department', role: 'agent',
    lifecycleStatus: 'active', enabled: true, routable: true,
  });
  pptMergeRuntime.store.upsertAgentVersion({
    agent: { id: 'ppt_academic_report', name: 'Legacy Academic PPT', departmentId: 'ppt_department', role: 'agent', lifecycleStatus: 'active', baseSkill: 'legacy academic skill' },
    memoryTemplate: '# legacy\n', sourceBundleId: 'ppt-agent-consolidation-check',
  });
  const canonicalPpt = pptMergeRuntime.store.recruitUserAgent({ userId: 'local_admin', agentFamilyId: 'ppt', commandId: 'ppt-merge:ppt' }).instance;
  const legacyPpt = pptMergeRuntime.store.recruitUserAgent({ userId: 'local_admin', agentFamilyId: 'ppt_academic_report', commandId: 'ppt-merge:legacy' }).instance;
  const legacyPptMemory = pptMergeRuntime.store.listMemoryDocuments({ agentInstanceId: legacyPpt.id })[0];
  const legacyPptSession = pptMergeRuntime.store.createSession({
    title: 'Legacy academic session', userId: 'local_admin', departmentId: 'ppt_department',
    agentId: 'ppt_academic_report', agentInstanceId: legacyPpt.id, reusePrimary: false,
  });
  pptMergeRuntime.store.addMessage({
    sessionId: legacyPptSession.id, role: 'user', content: '制作学术汇报', departmentId: 'ppt_department',
    agentId: 'ppt_academic_report', agentInstanceId: legacyPpt.id, metadata: {},
  });
  pptMergeRuntime.db.prepare(`INSERT INTO auth_users (
    id, email, display_name, username, role, email_verified
  ) VALUES ('ppt_merge_second_user', 'ppt.merge.second@check.local', 'PPT Merge Second', 'ppt_merge_second', 'member', 1)`).run();
  const secondCanonicalPpt = pptMergeRuntime.store.recruitUserAgent({
    userId: 'ppt_merge_second_user', agentFamilyId: 'ppt', commandId: 'ppt-merge:second:ppt',
  }).instance;
  const secondLegacyPpt = pptMergeRuntime.store.recruitUserAgent({
    userId: 'ppt_merge_second_user', agentFamilyId: 'ppt_academic_report', commandId: 'ppt-merge:second:legacy',
  }).instance;
  const secondLegacyPptSession = pptMergeRuntime.store.createSession({
    title: 'Second legacy academic session', userId: 'ppt_merge_second_user', departmentId: 'ppt_department',
    agentId: 'ppt_academic_report', agentInstanceId: secondLegacyPpt.id, reusePrimary: false,
  });
  pptMergeRuntime.close();
  pptMergeRuntime = await createRuntime({ root: pptMergeRoot, isDev: true, serverAuthoritativeSkills: true });
  assert.equal(pptMergeRuntime.store.findUserAgentInstance({ userId: 'local_admin', agentFamilyId: 'ppt' }).id, canonicalPpt.id);
  assert.equal(pptMergeRuntime.store.findUserAgentInstance({ userId: 'local_admin', agentFamilyId: 'ppt_academic_report' }), null);
  assert.equal(pptMergeRuntime.store.resolveUserAgent({ userId: 'local_admin', agentInstanceId: legacyPpt.id, agentFamilyId: 'ppt' }).instance.id, canonicalPpt.id);
  assert.equal(pptMergeRuntime.store.getSession(legacyPptSession.id).agentId, 'ppt');
  assert.equal(pptMergeRuntime.store.listMessages(legacyPptSession.id)[0].metadata.pptStyleId, 'academic_report');
  assert.ok(pptMergeRuntime.db.prepare('SELECT canonical_document_id FROM memory_document_aliases WHERE alias_document_id=?').get(legacyPptMemory.id));
  assert.equal(pptMergeRuntime.store.findUserAgentInstance({ userId: 'ppt_merge_second_user', agentFamilyId: 'ppt' }).id, secondCanonicalPpt.id);
  assert.equal(pptMergeRuntime.store.findUserAgentInstance({ userId: 'ppt_merge_second_user', agentFamilyId: 'ppt_academic_report' }), null);
  assert.equal(pptMergeRuntime.store.getSession(secondLegacyPptSession.id).agentId, 'ppt');
  assert.equal(pptMergeRuntime.store.getSession(secondLegacyPptSession.id).agentInstanceId, secondCanonicalPpt.id);
  assert.equal(pptMergeRuntime.store.getAgentFamily('ppt_academic_report').status, 'retired');
  pptMergeRuntime.close();
  const generalAgentToml = codexAgentToml(officialAgents.find((agent) => agent.id === 'general_agent'));
  assert.equal(validateCodexAgentToml(generalAgentToml), true);
  assert.match(generalAgentToml, /^name = "general_agent"/m);
  assert.match(generalAgentToml, /^description = /m);
  assert.match(generalAgentToml, /^developer_instructions = /m);
  assert.match(generalAgentToml, /\[\[skills\.config\]\]/);
  const harnessHome = path.join(tmp, 'official-harness-home');
  const writtenAgents = writeCodexAgentHarness(tmp, harnessHome);
  assert.equal(writtenAgents.length, officialAgents.length);
  assert.ok(existsSync(path.join(harnessHome, 'agents', 'general_agent.toml')));
  const directAgentAssignment = codexHarnessAssignment('Do the task.', { agentId: 'general_agent', role: 'agent_chat' });
  assert.match(directAgentAssignment, /already serving as the user-selected Janus Agent `general_agent`/);
  assert.doesNotMatch(directAgentAssignment, /Spawn the custom agent named/);
  const officialProjectRoot = path.join(tmp, 'official-project-root');
  mkdirSync(officialProjectRoot, { recursive: true });
  const officialProject = runtime.createProject({ title: 'Official project', workspaceRoot: officialProjectRoot });
  const reusedOfficialProject = runtime.createProject({ title: 'Duplicate project', workspaceRoot: officialProjectRoot });
  assert.equal(reusedOfficialProject.id, officialProject.id, 'selecting the same local folder must reuse its project');
  assert.equal(officialProject.workspaceRoot, realpathSync(officialProjectRoot));
  assert.throws(() => runtime.createProject({ workspaceRoot: path.join(tmp, 'missing-project-root') }), /不存在|不可访问/);
  await import('./project_workspace_file_access_smoke.mjs');
  assert.deepEqual(codexPermissionProfile('request-approval'), {
    mode: 'request-approval', sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', appServer: true,
  });
  assert.deepEqual(codexPermissionProfile('task-workspace'), {
    mode: 'task-workspace', sandbox: 'workspace-write', approvalPolicy: 'never', approvalsReviewer: 'user', appServer: false,
  });
  const codexTimeoutFailure = codexExecProcessFailure(new Error('Process timed out after 180000ms: C:\\Janus\\codex.exe'));
  assert.equal(codexTimeoutFailure.name, 'JanusUnavailable');
  assert.equal(codexTimeoutFailure.code, 'codex_request_timeout');
  assert.match(codexTimeoutFailure.message, /timed out after 180s/);
  assert.doesNotMatch(codexTimeoutFailure.message, /JANUS_CODEX_BIN/);
  const codexLaunchFailure = codexExecProcessFailure(Object.assign(new Error('spawn codex.exe ENOENT'), { code: 'ENOENT' }));
  assert.equal(codexLaunchFailure.code, 'codex_cli_launch_failed');
  assert.match(codexLaunchFailure.message, /JANUS_CODEX_BIN/);
  assert.equal(codexExecutionBackend(codexPermissionProfile('task-workspace'), 'win32'), 'app-server');
  assert.equal(codexExecutionBackend(codexPermissionProfile('task-workspace'), 'linux'), 'exec');
  assert.equal(codexExecutionBackend(codexPermissionProfile('request-approval'), 'linux'), 'app-server');
  assert.equal(codexPermissionProfile('auto-approve').approvalsReviewer, 'auto_review');
  assert.equal(codexPermissionProfile('full-access').sandbox, 'danger-full-access');
  assert.equal(JANUS_CLIENT_VERSION, JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version);
  assert.deepEqual(codexAppServerArgs('Options:\n  --listen <URL>'), ['app-server', '--listen', 'stdio://']);
  assert.deepEqual(codexAppServerArgs('Options:\n  --stdio'), ['app-server', '--stdio']);
  assert.deepEqual(codexAppServerArgs('Usage: codex app-server'), ['app-server']);
  assert.deepEqual(codexCollaborationMode('plan', { model: 'gpt-5.6', reasoningEffort: 'high' }), {
    mode: 'plan',
    settings: { model: 'gpt-5.6', reasoning_effort: 'high', developer_instructions: null },
  });
  assert.equal(codexCollaborationMode('', { model: 'gpt-5.6' }).mode, 'default');
  const startedCommandEvent = codexStreamEvent(JSON.stringify({
    type: 'item.started',
    item: { id: 'cmd-modern', type: 'command_execution', command: 'API_KEY=secret rg -n processEvents src', status: 'in_progress' },
  }));
  assert.equal(startedCommandEvent.command, 'API_KEY=secret rg -n processEvents src');
  assert.equal(startedCommandEvent.detail, 'API_KEY=secret rg -n processEvents src');
  assert.equal(startedCommandEvent.activityType, 'command');
  const completedCommandProtocolEvent = codexProcessEventForItem({
    id: 'cmd-completed', type: 'commandExecution', command: 'npm test', cwd: '/home/private/Janus-main',
    aggregatedOutput: 'API_KEY=secret\nall tests passed', exitCode: 0, durationMs: 1250,
    processId: 'pty-1', source: 'agent', commandActions: [{ type: 'unknown', command: 'npm test' }],
  }, { status: 'completed', completedAtMs: 12345 });
  assert.equal(completedCommandProtocolEvent.cwd, '/home/private/Janus-main');
  assert.equal(completedCommandProtocolEvent.output, 'API_KEY=secret\nall tests passed');
  assert.equal(completedCommandProtocolEvent.processId, 'pty-1');
  assert.equal(completedCommandProtocolEvent.commandActions[0].command, 'npm test');
  const objectKindFileEvent = codexProcessEventForItem({
    id: 'file-object-kind', type: 'fileChange', status: 'completed',
    changes: [{ path: '/home/private/Janus-main/three_lines.md', kind: { type: 'add' }, content: 'one\ntwo\nthree\n' }],
  }, { status: 'completed' });
  assert.equal(objectKindFileEvent.changes[0].kind, 'add');
  assert.equal(objectKindFileEvent.changes[0].diff, 'one\ntwo\nthree\n');
  assert.doesNotMatch(objectKindFileEvent.detail, /\[object Object\]/);
  const sensitiveOutputEvent = codexProcessEventForItem({
    id: 'cmd-sensitive-output', type: 'commandExecution', command: 'inspect credentials',
    aggregatedOutput: '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-data\n-----END OPENSSH PRIVATE KEY-----\ntoken: eyJabcdefgh.abcdefgh.abcdefgh',
  }, { status: 'completed' });
  assert.match(sensitiveOutputEvent.output, /private-data|eyJabcdefgh/);
  const sanitizedProtocolValue = sanitizeProcessProtocolValue({
    apiKey: 'sk-abcdefghijklmnop',
    tokenUsage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    nested: { output: 'token: eyJabcdefghijk.abcdefghijk.abcdefghijk github_pat_abcdefghijklmnopqrstuvwxyz123456 AWS_ACCESS_KEY_ID_TEST' },
  });
  assert.equal(sanitizedProtocolValue.apiKey, '[REDACTED]');
  assert.equal(sanitizedProtocolValue.tokenUsage.totalTokens, 30);
  assert.doesNotMatch(JSON.stringify(sanitizedProtocolValue), /sk-abcdefghijklmnop|eyJabcdefghijk|github_pat_|AWS_ACCESS_KEY_ID_TEST/);
  let boundedTaskUpdate = null;
  const taskWithLongEventHistory = {
    id: 'bounded-task-update-check', nodes: [], communications: [], metadata: {},
    events: Array.from({ length: 75 }, (_, index) => ({ id: `bounded-event-${index}`, createdAt: String(index) })),
  };
  const boundedScheduler = new TaskScheduler({
    root: process.cwd(), org: { list: () => ({ agents: [] }) },
    store: { getTaskRun: () => taskWithLongEventHistory },
    onTaskUpdated: (payload) => { boundedTaskUpdate = payload; },
  });
  const fullTaskUpdate = boundedScheduler.notifyTaskUpdated(taskWithLongEventHistory.id, { type: 'node_activity' });
  assert.equal(fullTaskUpdate.events.length, 75);
  assert.equal(boundedTaskUpdate.task.events.length, 50);
  assert.equal(boundedTaskUpdate.task.eventCount, 75);
  assert.equal(boundedTaskUpdate.task.eventHistoryPartial, true);
  assert.deepEqual(codexStreamEvent(JSON.stringify({
    type: 'item.completed', item: { id: 'commentary-modern', type: 'agent_message', phase: 'commentary', text: '正在检查渲染链路。' },
  })), {
    kind: 'activity', activityId: 'commentary-modern', activityType: 'commentary', status: 'completed',
    title: '执行说明', detail: '正在检查渲染链路。', append: false, eventOrigin: 'codex', nativeSource: 'codex_cli_jsonl',
  });
  const legacyCommentaryParser = createCodexStreamEventParser();
  const legacyCommentaryPrefix = '我会使用通用 Agent 的报告工作流，结合现有环境治理材料';
  const legacyCommentarySnapshots = [
    legacyCommentaryPrefix,
    `${legacyCommentaryPrefix}，整理成完整报告`,
    `${legacyCommentaryPrefix}，整理成完整报告并交付。`,
  ].map((message) => legacyCommentaryParser(JSON.stringify({
    type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message },
  })));
  assert.equal(new Set(legacyCommentarySnapshots.map((event) => event.activityId)).size, 1);
  assert.equal(legacyCommentarySnapshots.at(-1).detail, `${legacyCommentaryPrefix}，整理成完整报告并交付。`);
  assert.equal(legacyCommentaryParser(JSON.stringify({
    type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '我会使用通用 Agent 的报告工作流' },
  })), null);
  const separateLegacyCommentary = legacyCommentaryParser(JSON.stringify({
    type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '接下来核对报告中的引用来源。' },
  }));
  assert.notEqual(separateLegacyCommentary.activityId, legacyCommentarySnapshots[0].activityId);
  const explicitLegacyCommentary = createCodexStreamEventParser()(JSON.stringify({
    type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', item_id: 'legacy-explicit-id', message: '保留协议提供的 ID。' },
  }));
  assert.equal(explicitLegacyCommentary.activityId, 'legacy-explicit-id');
  const reasoningProtocolEvent = codexStreamEvent(JSON.stringify({
    type: 'item.completed',
    item: { id: 'reason-modern', type: 'reasoning', text: '检查当前协议并形成摘要。', content: ['完整 reasoning 内容。'] },
  }));
  assert.equal(reasoningProtocolEvent.detail, '检查当前协议并形成摘要。');
  assert.equal(reasoningProtocolEvent.reasoningText, '完整 reasoning 内容。');
  assert.deepEqual(codexStreamEvent(JSON.stringify({
    type: 'item.completed', item: { id: 'answer-modern', type: 'agent_message', text: '现代协议最终回答' },
  })), { kind: 'answer', content: '现代协议最终回答', eventOrigin: 'codex', nativeSource: 'codex_cli_jsonl' });
  assert.deepEqual(codexStreamEvent(JSON.stringify({
    type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 30 },
  })), {
    kind: 'usage', usage: {
      inputTokens: 120, outputTokens: 30, cachedInputTokens: 80, totalTokens: 150,
      contextInputTokens: 120, contextMeasurementState: 'available',
    },
    eventOrigin: 'codex', nativeSource: 'codex_cli_jsonl',
  });
  const splitCodexUsage = codexTokenUsage({ tokenUsage: {
    total: { inputTokens: 60_470, outputTokens: 100, totalTokens: 60_570 },
    last: { inputTokens: 17_463, outputTokens: 20, totalTokens: 17_483 },
    modelContextWindow: 258_400,
  } });
  assert.equal(splitCodexUsage.inputTokens, 60_470);
  assert.equal(splitCodexUsage.last.inputTokens, 17_463);
  assert.equal(splitCodexUsage.contextInputTokens, 17_463);
  assert.equal(splitCodexUsage.modelContextWindow, 258_400);
  assert.deepEqual(codexTokenUsage(splitCodexUsage), splitCodexUsage,
    'normalized Codex usage must retain tokenUsage.last when parsed again');
  assert.equal(codexGeneratedImagePath({ type: 'image_generation', saved_path: '/tmp/generated/example.png' }), '/tmp/generated/example.png');
  assert.equal(codexGeneratedImagePath({ type: 'image_view', path: '/tmp/generated/example.png' }), '');
  const generatedImageWorkspace = path.join(tmp, 'generated-image-workspace');
  const generatedImageSourceDir = path.join(tmp, 'codex-home', 'generated_images');
  const generatedImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4VQAAAAASUVORK5CYII=';
  mkdirSync(generatedImageWorkspace, { recursive: true });
  mkdirSync(generatedImageSourceDir, { recursive: true });
  const materializedGeneratedImage = materializeCodexGeneratedImageResult({
    id: 'image-result-only',
    type: 'imageGeneration',
    result: generatedImageBase64,
  }, generatedImageSourceDir);
  assert.equal(existsSync(materializedGeneratedImage), true, 'result-only imageGeneration items must be materialized');
  assert.equal(path.extname(materializedGeneratedImage), '.png');
  assert.equal(materializeCodexGeneratedImageResult({ type: 'imageGeneration', result: 'not-an-image' }, generatedImageSourceDir), '');
  const generatedImageSource = path.join(generatedImageSourceDir, 'agent result.png');
  writeFileSync(generatedImageSource, Buffer.from(generatedImageBase64, 'base64'));
  const generatedImageOutput = sessionOutputsDir(generatedImageWorkspace, 'generated-image-session');
  assert.equal(
    sessionOutputsDir(generatedImageWorkspace, '../escape').startsWith(`${path.join(generatedImageWorkspace, 'outputs')}${path.sep}`),
    true,
  );
  const archivedGeneratedImage = archiveCodexGeneratedImageArtifact({
    workspaceRoot: generatedImageWorkspace,
    outputRoot: generatedImageOutput,
    sourcePath: generatedImageSource,
  });
  assert.equal(archivedGeneratedImage.kind, 'image');
  assert.equal(archivedGeneratedImage.workspace_relative_path, 'outputs/generated-image-session/agent-result.png');
  assert.equal(archivedGeneratedImage.relative_path, 'generated-image-session/agent-result.png');
  assert.ok(existsSync(archivedGeneratedImage.path));
  assert.equal(path.dirname(realpathSync(archivedGeneratedImage.path)), realpathSync(generatedImageOutput));
  const privateConfig = codexPrivateSessionConfig('[features]\nmulti_agent = true\n[tools]\nweb_search = true\n[sandbox_workspace_write]\nnetwork_access = true\n');
  assert.match(privateConfig, /\[features\][\s\S]*multi_agent = false/);
  assert.match(privateConfig, /\[tools\][\s\S]*web_search = false/);
  assert.match(privateConfig, /\[sandbox_workspace_write\][\s\S]*network_access = false/);
  const privateWeek = privateAssistantWeekWindow(new Date('2026-07-22T08:00:00+08:00'));
  assert.ok(privateWeek.startAt < privateWeek.resetAt);
  const privateUsageStore = new Map();
  const privateUsageAdapter = {
    settingGet: (key, fallback = '') => privateUsageStore.get(key) ?? fallback,
    settingSet: (key, value) => privateUsageStore.set(key, value),
  };
  assert.equal(privateAssistantUsageStatus(privateUsageAdapter, 'private-check', { now: new Date('2026-07-22T08:00:00+08:00'), limit: 1_000 }).weeklyTokensUsed, 0);
  const recordedPrivateUsage = recordPrivateAssistantUsage(privateUsageAdapter, 'private-check', {
    inputTokens: 120, outputTokens: 30, totalTokens: 150, source: 'provider',
  }, { now: new Date('2026-07-22T08:00:00+08:00'), limit: 1_000 });
  assert.equal(recordedPrivateUsage.weeklyTokensUsed, 150);
  assert.equal(recordedPrivateUsage.weeklyTokensRemaining, 850);
  const splitPrivateUsage = resolvePrivateAssistantTurnUsage({ usage: splitCodexUsage }, '', '');
  assert.equal(splitPrivateUsage.inputTokens, 17_463,
    'per-turn private assistant accounting must not add the cumulative thread total again');
  assert.equal(splitPrivateUsage.totalTokens, 17_483);
  const cumulativeOnlyPrivateUsage = resolvePrivateAssistantTurnUsage({ usage: { tokenUsage: {
    total: { inputTokens: 60_470, outputTokens: 100, totalTokens: 60_570 },
  } } }, '四个中文字符', '回答');
  assert.equal(cumulativeOnlyPrivateUsage.totalTokens, 8,
    'cumulative-only thread totals must fall back to a per-turn estimate instead of being charged again');
  assert.equal(cumulativeOnlyPrivateUsage.source, 'estimated');
  assert.equal(resolvePrivateAssistantTurnUsage({}, '四个中文字符', '回答').source, 'estimated');
  const privatePrompt = buildPrivateAssistantPrompt({ userMessage: '只处理这里', recentMessages: [] });
  assert.match(privatePrompt, /Never delegate, spawn, mention, message, route to, or request information from any other Agent/);
  assert.match(privatePrompt, /Do not use web search, network tools, MCP tools, or external services/);
  const sandboxMethods = [];
  const legacySandboxRequest = async (method) => {
    sandboxMethods.push(method);
    if (method === 'windowsSandbox/readiness') {
      throw new Error('Invalid request: unknown variant `windowsSandbox/readiness`, expected one of `initialize`, `windowsSandbox/setupStart`');
    }
    if (method === 'windowsSandbox/setupStart') return { started: false };
    if (method === 'thread/start') return { thread: { id: 'legacy-thread' } };
    if (method === 'turn/start') return { turn: { id: 'legacy-turn' } };
    throw new Error(`unexpected method ${method}`);
  };
  const legacySandbox = await ensureWindowsSandboxReady({ request: legacySandboxRequest, cwd: 'C:\\Janus' });
  assert.deepEqual(legacySandbox, { readinessSupported: false, setupStarted: false, status: 'compatibility_fallback' });
  await legacySandboxRequest('thread/start', {});
  await legacySandboxRequest('turn/start', {});
  assert.deepEqual(sandboxMethods, [
    'windowsSandbox/readiness',
    'windowsSandbox/setupStart',
    'thread/start',
    'turn/start',
  ]);
  await assert.rejects(
    () => queryWindowsSandboxReadiness(async () => { throw new Error('Windows sandbox service crashed.'); }),
    /service crashed/,
  );
  await assert.rejects(
    () => ensureWindowsSandboxReady({
      request: async () => { throw new Error('Windows sandbox service crashed.'); }, cwd: 'C:\\Janus',
    }),
    (error) => error?.code === 'sandbox_workspace_write_unavailable' && /service crashed/.test(error.message),
  );
  assert.deepEqual(await probeCodexProvider({
    baseUrl: 'https://provider.example/v1',
    apiKey: 'sk-test',
    model: 'gpt-test',
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.authorization, 'Bearer sk-test');
      if (url.endsWith('/models')) {
        assert.equal(options.method, 'GET');
        return new Response(JSON.stringify({ data: [{ id: 'gpt-test' }] }), { status: 200 });
      }
      assert.equal(url, 'https://provider.example/v1/responses');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), {
        model: 'gpt-test', input: 'Reply with OK.', max_output_tokens: 16, store: false,
      });
      return new Response(JSON.stringify({ id: 'response-test' }), { status: 200 });
    },
  }), {
    status: 'pass', summary: 'Provider 网络、鉴权和 Responses API 可用（HTTP 200）。',
    modelIds: ['gpt-test'], modelVerified: true,
  });
  assert.deepEqual(await probeCodexProvider({
    baseUrl: 'https://provider.example/v1',
    apiKey: 'sk-test',
    model: 'gpt-custom',
    fetchImpl: async (url) => url.endsWith('/models')
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify({ id: 'response-test' }), { status: 200 }),
  }), {
    status: 'pass', summary: 'Provider 网络、鉴权和 Responses API 可用（HTTP 200）。',
    modelIds: [], modelVerified: true,
  });
  assert.equal((await probeCodexProvider({
    baseUrl: 'https://provider.example/v1',
    apiKey: 'bad-responses-key',
    model: 'gpt-test',
    fetchImpl: async (url) => url.endsWith('/models')
      ? new Response(JSON.stringify({ data: [{ id: 'gpt-test' }] }), { status: 200 })
      : new Response('{}', { status: 401 }),
  })).status, 'fail');
  assert.equal((await probeCodexProvider({
    baseUrl: 'https://provider.example/v1',
    apiKey: 'bad-key',
    fetchImpl: async () => new Response('{}', { status: 401 }),
  })).status, 'fail');
  assert.equal((await probeCodexProvider({
    baseUrl: 'https://provider.example/v1',
    apiKey: 'sk-test',
    fetchImpl: async () => new Response('{}', { status: 404 }),
  })).status, 'warn');
  const planningOrg = runtime.org.list();
  const normalPlan = planHomeChatRoute({ message: '你好，简单解释一下向量数据库是什么。', organization: planningOrg });
  assert.equal(normalPlan.mode, 'agent');
  assert.equal(normalPlan.departmentId, 'general');
  assert.equal(normalPlan.agentId, 'general_agent');
  assert.equal(normalPlan.title, '向量数据库');
  const paperPlan = planHomeChatRoute({ message: '帮我写一篇多智能体系统论文的摘要和提纲。', organization: planningOrg });
  assert.equal(paperPlan.mode, 'agent');
  assert.equal(paperPlan.agentId, 'general_agent');
  assert.equal(paperPlan.title, '多智能体系统论文摘要与提纲');
  const githubResearchPlan = planHomeChatRoute({
    message: '帮我搜索 GitHub 上面的开源项目并整理相关内容',
    organization: planningOrg,
  });
  assert.equal(githubResearchPlan.complexity, 'moderate');
  assert.equal(githubResearchPlan.signals.researchWorkflow, true);
  assert.ok(githubResearchPlan.signals.actionCount >= 2);
  const pptAnalysisPlan = planHomeChatRoute({ message: '帮我解析一个 ppt 并总结重点。', organization: planningOrg });
  assert.equal(pptAnalysisPlan.departmentId, 'general');
  assert.equal(pptAnalysisPlan.agentId, 'general_agent');
  const pptAttachmentAnalysisPlan = planHomeChatRoute({
    message: '请分析这个附件并给出改进建议。',
    attachments: [{ name: 'source.pptx' }],
    organization: planningOrg,
  });
  assert.equal(pptAttachmentAnalysisPlan.departmentId, 'general');
  assert.equal(pptAttachmentAnalysisPlan.agentId, 'general_agent');
  assert.equal(
    shouldAttachPptArtifact(
      { departmentId: 'ppt_department', agentId: 'ppt' },
      '请解析附件并生成一份文字摘要',
      '这里是文字摘要。',
    ),
    false,
  );
  assert.equal(
    shouldAttachPptArtifact(
      { departmentId: 'ppt_department', agentId: 'ppt' },
      '请整理一下附件内容',
      '这里是整理结果。',
    ),
    false,
  );
  const pptCreationPlan = planHomeChatRoute({ message: '请根据这些内容制作一份答辩 PPT。', organization: planningOrg });
  assert.equal(pptCreationPlan.departmentId, 'ppt_department');
  assert.equal(pptCreationPlan.agentId, 'ppt');
  const drawnPptMessage = '你好！帮我绘制一个介绍生成式推荐系统的ppt';
  const drawnPptPlan = planHomeChatRoute({ message: drawnPptMessage, organization: planningOrg });
  assert.equal(drawnPptPlan.departmentId, 'ppt_department');
  assert.equal(drawnPptPlan.agentId, 'ppt');
  assert.equal(
    shouldAttachPptArtifact(
      { departmentId: 'ppt_department', agentId: 'ppt', explicitPptMode: true },
      drawnPptMessage,
      '下面是页面结构。',
    ),
    true,
  );
  assert.equal(
    shouldAttachPptArtifact(
      { departmentId: 'ppt_department', agentId: 'ppt', explicitPptMode: true, interactionMode: 'plan' },
      drawnPptMessage,
      '下面是页面结构。',
    ),
    true,
    'legacy Plan mode metadata must no longer create a host-side read-only branch',
  );
  assert.equal(
    shouldAttachPptArtifact(
      { departmentId: 'ppt_department', agentId: 'ppt' },
      '请根据这些内容制作一份答辩 PPT。',
      '下面是页面结构。',
    ),
    true,
  );
  const collaborationPlan = planHomeChatRoute({ message: '先调研多智能体系统，设计实验，写成论文，最后生成答辩 PPT。', organization: planningOrg });
  assert.equal(collaborationPlan.mode, 'agent');
  assert.equal(collaborationPlan.departmentId, 'ppt_department');
  const goalModeRoute = planHomeChatRoute({
    message: '先调研多智能体系统，设计实验，写成论文，最后生成答辩 PPT。',
    organization: planningOrg,
    allowCollaboration: false,
  });
  assert.notEqual(goalModeRoute.mode, 'collaboration', 'goal mode must stay on a single read/write-governed Codex session');
  const explicitPlan = planHomeChatRoute({
    message: '按我选择的 PPT 部门处理。',
    routePreference: 'explicit',
    selectedDepartmentId: 'ppt_department',
    selectedAgentId: 'ppt',
    organization: planningOrg,
  });
  assert.equal(explicitPlan.mode, 'agent');
  assert.equal(explicitPlan.departmentId, 'ppt_department');
  assert.equal(explicitPlan.agentId, 'ppt');
  const forcedNormalPlan = planHomeChatRoute({
    message: '帮我写一篇论文，但这次只想在普通聊天里讨论。',
    routePreference: 'explicit',
    selectedDepartmentId: 'general',
    organization: planningOrg,
  });
  assert.equal(forcedNormalPlan.mode, 'agent');
  assert.equal(forcedNormalPlan.agentId, 'general_agent');
  assert.equal(forcedNormalPlan.confidence, 1);
  const explicitGeneralGreetingPlan = planHomeChatRoute({
    message: '你好',
    routePreference: 'explicit',
    selectedDepartmentId: 'general',
    selectedAgentId: 'general_agent',
    organization: planningOrg,
  });
  assert.equal(explicitGeneralGreetingPlan.mode, 'agent');
  assert.equal(explicitGeneralGreetingPlan.agentId, 'general_agent');
  const normalAfterImagePlan = planHomeChatRoute({
    message: '继续解释刚才的结果。',
    organization: planningOrg,
    existingSession: { departmentId: 'image_generation', agentId: 'gpt-image-2' },
  });
  assert.equal(normalAfterImagePlan.mode, 'agent');
  assert.equal(normalAfterImagePlan.agentId, 'general_agent');
  assert.ok(existsSync(path.join(tmp, 'config', 'codex', 'config.toml')));
  assert.ok(existsSync(path.join(tmp, 'departments', 'ppt_department', 'department.json')));
  const pptTemplateRegistry = JSON.parse(readFileSync(path.join(tmp, 'departments', 'ppt_department', 'templates', 'template_registry.json'), 'utf8'));
  for (const [templateId, filename] of [
    ['hitsz', '哈工深多功能PPT模板.pptx'],
    ['scut', '华工多功能PPT模板.pptx'],
  ]) {
    const template = pptTemplateRegistry.templates.find((item) => item.id === templateId);
    assert.equal(template?.engine, 'slide_library');
    assert.equal(template?.schema_version, 'janus-multifunction-v1');
    assert.equal(path.basename(template?.path || ''), filename);
    assert.ok(existsSync(path.join(tmp, 'departments', 'ppt_department', 'templates', filename)), `missing multi-function PPT template ${filename}`);
  }
  const pptLayoutRegistry = JSON.parse(readFileSync(path.join(tmp, 'departments', 'ppt_department', 'templates', 'layouts', 'layout_registry.json'), 'utf8'));
  for (const family of Object.values(pptLayoutRegistry.families || {})) {
    const ids = new Set((family.layouts || []).map((item) => item.id));
    assert.ok(ids.has('basic_content'), `${family.label || 'PPT layout family'} missing basic_content`);
    assert.ok(ids.has('media_showcase'), `${family.label || 'PPT layout family'} missing media_showcase`);
  }
  const hiddenDeckSpec = renderMarkdown('可见内容\n\n```janus-deck-spec\n{"slides":[]}\n```');
  assert.ok(hiddenDeckSpec.includes('可见内容'));
  assert.ok(!hiddenDeckSpec.includes('slides'), 'machine PPT deck spec must be hidden from chat rendering');
  const latexMarkdown = renderMarkdown([
    '一个候选下界是：',
    '',
    '\\[',
    'T_{spec,P}\\geq\\max\\left(\\frac{W_{spec}}{P},D_{verify},D_{irreversible},L_{max}\\right)',
    '\\]',
    '',
    '行内公式 \\(x^2+y^2=z^2\\)。',
  ].join('\n'));
  assert.match(latexMarkdown, /class="message-math-block"[\s\S]*class="katex-display"/);
  assert.match(latexMarkdown, /class="message-math-inline"[\s\S]*class="katex"/);
  const literalMathCode = renderMarkdown('`$x^2$`');
  assert.doesNotMatch(literalMathCode, /message-math-inline/);
  assert.match(literalMathCode, /<code>\$x\^2\$<\/code>/);
  const copyableCodeBlock = renderMarkdown('```python\nprint("Janus")\n```');
  assert.ok(copyableCodeBlock.includes('data-copy-code-block'));
  assert.ok(copyableCodeBlock.includes('data-localize-ui'));
  assert.ok(copyableCodeBlock.includes('aria-label="复制代码"'));
  assert.ok(copyableCodeBlock.includes('message-code-head'));
  assert.ok(copyableCodeBlock.includes('data-code-language data-no-localize>Python</span>'));
  assert.ok(copyableCodeBlock.includes('message-code-copy-icon'));
  assert.ok(copyableCodeBlock.includes('data-code-copy-label>复制</span>'));
  assert.ok(copyableCodeBlock.includes('<code data-language="python">print(&quot;Janus&quot;)</code>'));
  const enrichedPptPrompt = buildAgentChatPrompt({
    agent: { id: 'ppt', name: 'PPT Agent', departmentId: 'ppt_department', description: 'Unified PPT creation' },
    department: { name: 'PPT Department', description: 'Presentation creation' },
    skill: '# Effective Skill\n\n- Use the adopted market workflow.\n',
    memory: '# Current Memory\n\n- The user prefers evidence-first slides.\n',
    userMessage: '帮我生成一个介绍多模态推荐的ppt',
    chatContext: {
      type: 'ppt',
      styleId: 'academic_report',
      styleLabel: '学术汇报风',
      templateId: 'hitsz',
      audience: 'auto',
      durationMinutes: 'auto',
      depth: 'auto',
    },
  });
  assert.ok(enrichedPptPrompt.includes('Internally inferred brief for this underspecified introduction request'));
  assert.ok(enrichedPptPrompt.includes('VBPR') && enrichedPptPrompt.includes('Recall@K'));
  assert.ok(enrichedPptPrompt.includes('Asset routing: reserve generated images for the cover'));
  assert.match(enrichedPptPrompt, /Current effective Skill:[\s\S]*adopted market workflow/);
  assert.match(enrichedPptPrompt, /Current Janus Memory context:[\s\S]*evidence-first slides/);
  const continuedOrderedLists = renderMarkdown([
    '1. 登录与账户',
    '',
    '- 统一登录页文字。',
    '- 修复验证码发送。',
    '',
    '1. 工作目录与项目',
    '',
    '- 选择目录后立即生效。',
    '',
    '1. 界面与导航',
  ].join('\n'));
  assert.ok(continuedOrderedLists.includes('<ol><li>登录与账户</li></ol>'));
  assert.ok(continuedOrderedLists.includes('<ol start="2"><li>工作目录与项目</li></ol>'));
  assert.ok(continuedOrderedLists.includes('<ol start="3"><li>界面与导航</li></ol>'));
  const explicitlyStartedList = renderMarkdown('4. 第四项\n5. 第五项');
  assert.ok(explicitlyStartedList.includes('<ol start="4">'));
  const localMarkdownLink = renderMarkdown('[查看 TODO.md](F:/coding/project/outputs/TODO.md)');
  assert.ok(localMarkdownLink.includes('data-preview-local-file="F:/coding/project/outputs/TODO.md"'));
  assert.ok(localMarkdownLink.includes('message-local-file-link'));
  const angleWrappedWindowsLink = renderMarkdown('[天气报告](<C:\\Users\\User\\.janus-test\\outputs\\天气报告.md>)');
  assert.ok(angleWrappedWindowsLink.includes('data-preview-local-file="C:\\Users\\User\\.janus-test\\outputs\\天气报告.md"'));
  assert.ok(!angleWrappedWindowsLink.includes('&lt;C:'));
  const relativeImageLink = renderMarkdown('[天气变化图](outputs/weather chart.png)');
  assert.ok(relativeImageLink.includes('data-preview-local-file="outputs/weather chart.png"'));
  const archiveLink = renderMarkdown('[下载归档](outputs/release bundle.zip)');
  assert.ok(archiveLink.includes('data-preview-local-file="outputs/release bundle.zip"'));
  const parenthesizedFileLink = renderMarkdown('[查看终稿](outputs/报告 (终稿).pdf)');
  assert.ok(parenthesizedFileLink.includes('data-preview-local-file="outputs/报告 (终稿).pdf"'));
  const nestedParenthesizedFileLink = renderMarkdown('[查看终稿](outputs/报告 ((终稿)).pdf)');
  assert.ok(nestedParenthesizedFileLink.includes('data-preview-local-file="outputs/报告 ((终稿)).pdf"'));
  const titledFileLink = renderMarkdown('[查看报告](outputs/report.md "报告标题")');
  assert.ok(titledFileLink.includes('data-preview-local-file="outputs/report.md"'));
  const extensionlessFileLink = renderMarkdown('[查看产物](outputs/BUILD_RESULT)');
  assert.ok(extensionlessFileLink.includes('data-preview-local-file="outputs/BUILD_RESULT"'));
  const webMarkdownLink = renderMarkdown('[Janus](https://example.com/docs?q=janus)');
  assert.ok(webMarkdownLink.includes('href="https://example.com/docs?q=janus"'));
  assert.ok(webMarkdownLink.includes('target="_blank"'));
  const parenthesizedWebLink = renderMarkdown('[Reference](https://example.com/Function_(mathematics))');
  assert.ok(parenthesizedWebLink.includes('href="https://example.com/Function_(mathematics)"'));
  assert.ok(!renderMarkdown('[危险链接](javascript:alert)').includes('<a '));

  const linkArtifacts = [
    { name: '报告 终稿.md', path: '/workspace/outputs/报告 终稿.md', relative_path: 'outputs/报告 终稿.md' },
    { name: 'deck.pptx', path: 'C:\\Workspace\\outputs\\deck.pptx', relative_path: 'outputs/deck.pptx' },
  ];
  assert.equal(resolveMessageArtifactLink('报告%20终稿.md', linkArtifacts), linkArtifacts[0]);
  assert.equal(resolveMessageArtifactLink('outputs/报告%20终稿.md', linkArtifacts), linkArtifacts[0]);
  assert.equal(resolveMessageArtifactLink('file:///workspace/outputs/%E6%8A%A5%E5%91%8A%20%E7%BB%88%E7%A8%BF.md', linkArtifacts), linkArtifacts[0]);
  assert.equal(resolveMessageArtifactLink('file:///C:/Workspace/outputs/deck.pptx', linkArtifacts), linkArtifacts[1]);
  assert.equal(resolveMessageArtifactLink('C:\\Workspace\\outputs\\deck.pptx', linkArtifacts), linkArtifacts[1]);
  assert.equal(resolveMessageArtifactLink('outputs/报告%20终稿.md:12:4', linkArtifacts), linkArtifacts[0]);
  assert.equal(resolveMessageArtifactLink('outputs/报告%20终稿.md#结论', linkArtifacts), linkArtifacts[0]);
  assert.equal(resolveMessageArtifactLink('outputs/报告%20终稿.md?preview=1', linkArtifacts), linkArtifacts[0]);
  assert.deepEqual(parseLocalFileReference('outputs/报告.md:12:4'), {
    path: 'outputs/报告.md', line: 12, column: 4, suffix: '',
  });
  const duplicateArtifacts = [
    { name: 'result.csv', path: '/workspace/one/result.csv' },
    { name: 'result.csv', path: '/workspace/two/result.csv' },
  ];
  assert.equal(resolveMessageArtifactLink('result.csv', duplicateArtifacts), null);
  assert.equal(resolveMessageArtifactLink('/workspace/two/result.csv', duplicateArtifacts), duplicateArtifacts[1]);

  assert.equal(normalizeExternalHttpUrl('https://example.com/docs'), 'https://example.com/docs');
  assert.equal(normalizeExternalHttpUrl('http://example.com/path'), 'http://example.com/path');
  assert.equal(normalizeExternalHttpUrl('javascript:alert(1)'), '');
  assert.equal(normalizeExternalHttpUrl('file:///tmp/private.txt'), '');
  const externalHandlers = new Map();
  let windowOpenHandler = null;
  const openedExternalUrls = [];
  const externalWebContents = {
    getURL: () => 'file:///app/index.html',
    on: (event, handler) => externalHandlers.set(event, handler),
    setWindowOpenHandler: (handler) => { windowOpenHandler = handler; },
  };
  assert.equal(installExternalNavigation({ webContents: externalWebContents }, {
    shell: { openExternal: async (url) => openedExternalUrls.push(url) },
  }), true);
  assert.deepEqual(windowOpenHandler({ url: 'https://example.com/from-message' }), { action: 'deny' });
  assert.deepEqual(windowOpenHandler({ url: 'javascript:alert(1)' }), { action: 'deny' });
  let externalNavigationPrevented = false;
  externalHandlers.get('will-navigate')({ preventDefault: () => { externalNavigationPrevented = true; } }, 'http://example.com/direct');
  await Promise.resolve();
  assert.equal(externalNavigationPrevented, true);
  assert.deepEqual(openedExternalUrls, [
    'https://example.com/from-message',
    'http://example.com/direct',
  ]);
  const normalizedPptAnswer = normalizePptAssistantAnswer([
    '| layout_id | title | message | visual |',
    '|---|---|---|---|',
    '| cover | 封面 | 主题 | 封面视觉 |',
    '| challenge_map | 背景与挑战 | 背景 | 挑战图 |',
    '| method_pipeline | 方法路线 | 方法 | 流程图 |',
    '| result_big_numbers | 关键结果 | 结果 | 指标卡 |',
    '| summary_takeaways | 总结 | 总结 | 总结卡 |',
    '',
    '```janus-deck-spec',
    '{"schema_version":"janus-multifunction-v1","slides":[]}',
    '```',
  ].join('\n'));
  assert.ok(normalizedPptAnswer.includes('PPT 页面结构已整理，共 5 页'));
  assert.ok(normalizedPptAnswer.includes('第 2 页：背景与挑战'));
  assert.ok(normalizedPptAnswer.includes('第 4 页：关键结果'));
  assert.ok(normalizedPptAnswer.includes('```janus-slide-plan'));
  const normalizedPptOutlineOnly = normalizePptAssistantAnswer(normalizedPptAnswer, { artifactPending: false });
  assert.ok(normalizedPptOutlineOnly.includes('页面结构已整理完成。'));
  assert.ok(!normalizedPptOutlineOnly.includes('正在生成和校验可编辑 PPTX'));
  const pptStyleSkillRoot = path.join(tmp, 'ppt-style-skill-check');
  const pptStyleRegistry = JSON.parse(readFileSync(path.join(
    process.cwd(), 'assets', 'departments', 'ppt_department', 'styles', 'style_registry.json',
  ), 'utf8'));
  assert.deepEqual(Object.fromEntries(pptStyleRegistry.styles.map((style) => [style.id, style.skill_path])), {
    general: 'agents/ppt/styles/ppt-general/SKILL.md',
    academic_report: 'agents/ppt/styles/ppt-academic-report/SKILL.md',
    major_project: 'agents/ppt/styles/ppt-major-project/SKILL.md',
  });
  const bundledPptBaseSkill = readFileSync(path.join(
    process.cwd(), 'assets', 'skills', 'ppt_creation', 'departments', 'ppt_department', 'agents', 'ppt', 'SKILL.md',
  ), 'utf8');
  assert.doesNotMatch(bundledPptBaseSkill, /^## Style Profiles$/m, 'style-specific rules must not remain embedded in the common PPT Skill');
  const pptSkillRuntimeStatus = pptSkillStatus(pptStyleSkillRoot);
  const pptSkillFiles = pptSkillRuntimeStatus.skillFiles;
  assert.equal(pptSkillRuntimeStatus.platform, process.platform);
  assert.equal(pptSkillRuntimeStatus.architecture, process.arch);
  assert.ok(['bundled', 'system', 'missing'].includes(pptSkillRuntimeStatus.runtimeMode));
  assert.deepEqual(pptSkillFiles.map((item) => item.id), [
    'ppt',
    'ppt-style-general',
    'ppt-style-academic-report',
    'ppt-style-major-project',
  ]);
  assert.ok(pptSkillFiles.every((item) => item.available), 'bundled common and style Skills must all validate');
  const effectivePptSkills = Object.fromEntries(['general', 'academic_report', 'major_project'].map((styleId) => {
    const resolved = resolvePptStyleSkill(pptStyleSkillRoot, styleId);
    assert.equal(resolved.styleId, styleId);
    assert.equal(resolved.fallback, false);
    return [styleId, composePptStyleSkill(pptStyleSkillRoot, bundledPptBaseSkill, styleId)];
  }));
  assert.match(effectivePptSkills.general, /Active PPT Style Skill: general/);
  assert.match(effectivePptSkills.general, /audience-led narrative/);
  assert.doesNotMatch(effectivePptSkills.general, /benchmark_metrics/);
  assert.match(effectivePptSkills.academic_report, /Active PPT Style Skill: academic_report/);
  assert.match(effectivePptSkills.academic_report, /benchmark_metrics/);
  assert.doesNotMatch(effectivePptSkills.academic_report, /project_target_map/);
  assert.match(effectivePptSkills.major_project, /Active PPT Style Skill: major_project/);
  assert.match(effectivePptSkills.major_project, /project_target_map/);
  assert.doesNotMatch(effectivePptSkills.major_project, /method_loop/);
  assert.equal(new Set(Object.values(effectivePptSkills).map((value) => sha256Text(value))).size, 3, 'each PPT style must produce a distinct effective Skill hash');
  const migratedLegacyPptSkill = composePptStyleSkill(pptStyleSkillRoot, [
    '# Legacy Common PPT Skill',
    '',
    '## Style Profiles',
    '',
    '### `general`',
    '- legacy general profile',
    '',
    '### `major_project`',
    '- legacy project profile',
    '',
    '## Internal Research Role',
    '',
    '- preserve this common research rule',
  ].join('\n'), 'academic_report');
  assert.doesNotMatch(migratedLegacyPptSkill, /legacy general profile|legacy project profile/);
  assert.match(migratedLegacyPptSkill, /preserve this common research rule/);
  assert.match(migratedLegacyPptSkill, /Active PPT Style Skill: academic_report/);
  const invalidInstalledAcademicSkill = path.join(
    skillPackageInstallRoot(pptStyleSkillRoot, 'ppt_creation'),
    'departments', 'ppt_department', 'agents', 'ppt', 'styles', 'ppt-academic-report', 'SKILL.md',
  );
  mkdirSync(path.dirname(invalidInstalledAcademicSkill), { recursive: true });
  writeFileSync(invalidInstalledAcademicSkill, 'invalid local style skill\n');
  const recoveredAcademicSkill = resolvePptStyleSkill(pptStyleSkillRoot, 'academic_report');
  assert.equal(recoveredAcademicSkill.styleId, 'academic_report');
  assert.equal(recoveredAcademicSkill.source, 'bundled');
  assert.match(recoveredAcademicSkill.content, /^---\s*\nname: ppt-academic-report/m);
  const normalizedPptHtml = renderMarkdown(normalizedPptAnswer);
  assert.ok(!normalizedPptHtml.includes('layout_id'), 'detailed PPT slide plan must be hidden from chat rendering');
  assert.ok(!normalizedPptHtml.includes('schema_version'), 'PPT machine spec must remain hidden after normalization');
  assert.ok(
    readFileSync(path.join(process.cwd(), 'src/renderer/styles/attachments-preview.css'), 'utf8')
      .includes('.message.assistant + .ppt-artifact-message'),
    'PPT summary and artifact card should use the compact adjacent-message spacing rule',
  );
  const attachmentPreviewStyles = readFileSync(path.join(process.cwd(), 'src/renderer/styles/attachments-preview.css'), 'utf8');
  assert.ok(
    attachmentPreviewStyles.includes('.shell.theme-dark .preview-deck-cover'),
    'PPT preview containers should provide a dark-mode surface',
  );
  assert.ok(
    attachmentPreviewStyles.includes('.shell.theme-dark .ppt-preview-subtitle'),
    'PPT preview secondary text should provide a readable dark-mode color',
  );
  const typedMemoryColumns = runtime.db.prepare('PRAGMA table_info(typed_memories)').all().map((row) => row.name);
  assert.ok(!typedMemoryColumns.includes('content_embedding_json'), 'fresh schema must not create hash embedding storage');
  const sessionColumns = runtime.db.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name);
  assert.ok(sessionColumns.includes('interaction_mode'), 'sessions must persist goal mode and normalize legacy values at runtime');
  assert.ok(sessionColumns.includes('goal_objective'), 'sessions must mirror the native Codex goal objective');
  assert.ok(sessionColumns.includes('goal_status'), 'sessions must mirror the native Codex goal status');
  assert.ok(sessionColumns.includes('goal_token_budget'), 'the deprecated Goal budget column must remain for historical database compatibility');
  assert.ok(sessionColumns.includes('agent_instance_id'), 'sessions must bind conversations to a user Agent instance');
  assert.ok(runtime.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_agent_instances'").get());
  assert.ok(runtime.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_documents'").get());
  assert.ok(runtime.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_agent_recruitment_events'").get());
  assert.ok(runtime.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_security_contexts'").get());
  assert.ok(runtime.db.prepare("SELECT id FROM schema_migrations WHERE id = 'employee_recruitment_phase_a_v1'").get());
  assert.ok(runtime.db.prepare("SELECT id FROM schema_migrations WHERE id = 'multi_memory_task_security_phase_d_v1'").get());
  const localAdminGeneralInstance = runtime.store.findUserAgentInstance({ userId: 'local_admin', agentFamilyId: 'general_agent' });
  const localAdminSecretaryInstance = runtime.store.findUserAgentInstance({ userId: 'local_admin', agentFamilyId: 'secretary_agent' });
  assert.ok(localAdminGeneralInstance, 'new users must receive the default general employee');
  assert.equal(localAdminGeneralInstance.instanceKind, 'employee');
  assert.equal(localAdminGeneralInstance.employmentState, 'active');
  assert.equal(localAdminGeneralInstance.quotaExempt, false);
  assert.equal(localAdminGeneralInstance.displayName, 'Generalist A');
  for (const agentFamilyId of ['general_agent_1', 'general_agent_2', 'general_agent_3']) {
    const family = runtime.store.getAgentFamily(agentFamilyId);
    assert.ok(!family || family.recruitable === false, `${agentFamilyId} must not remain a recruitable talent Family`);
    assert.equal(runtime.store.findUserAgentInstance({ userId: 'local_admin', agentFamilyId }), null,
      `${agentFamilyId} must not create a separate employee identity`);
  }
  assert.ok(localAdminSecretaryInstance, 'new users must receive uBuddy as a system instance');
  assert.equal(localAdminSecretaryInstance.instanceKind, 'system');
  assert.equal(localAdminSecretaryInstance.quotaExempt, true);
  assert.equal(runtime.store.findUserAgentInstance({ userId: 'local_admin', agentFamilyId: 'ppt' }), null, 'specialists must not be auto-recruited');
  assert.deepEqual(runtime.store.getEmployeeQuota({ userId: 'local_admin' }), {
    used: 1,
    limit: 10,
    remaining: 9,
    grandfatheredOverLimit: false,
    policyState: 'within_limit',
    policyVersion: 'employee_recruitment_phase_a_v1',
  });
  assert.equal(runtime.store.listEmployeeRoster({ userId: 'local_admin' }).some((item) => item.agentFamilyId === 'secretary_agent'), false, 'uBuddy must not enter the employee roster');
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM agent_families WHERE role IN ('hr', 'department_leader') AND instance_kind != 'governance'").get().count, 0, 'HR and Department Leaders must be governance instances');
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM agent_families WHERE role IN ('hr', 'department_leader') AND recruitable != 0").get().count, 0, 'governance roles must not be recruitable');
  const localAdminInstanceCountBeforeMissingResolution = runtime.store.listUserAgentInstances({ userId: 'local_admin' }).length;
  assert.equal(runtime.store.resolveUserAgent({ userId: 'local_admin', agentFamilyId: 'ppt' }), null, 'resolving an unrecruited Agent family must not create an instance');
  assert.equal(runtime.store.listUserAgentInstances({ userId: 'local_admin' }).length, localAdminInstanceCountBeforeMissingResolution);
  assert.throws(() => runtime.store.createSession({
    title: 'Unrecruited employee session', userId: 'local_admin', departmentId: 'ppt_department', agentId: 'ppt',
  }), (error) => error?.code === 'agent_instance_not_found', 'session creation must reject an unrecruited employee without creating it');
  assert.equal(runtime.store.findUserAgentInstance({ userId: 'local_admin', agentFamilyId: 'ppt' }), null);
  const taskCountBeforeUnrecruitedLead = runtime.db.prepare('SELECT COUNT(*) AS count FROM task_runs').get().count;
  assert.throws(() => runtime.store.createTaskRun({
    title: 'Unrecruited employee task', prompt: 'Must not create an employee.', departmentId: 'ppt_department',
    leadAgentId: 'ppt', ownerUserId: 'local_admin',
  }), (error) => error?.code === 'agent_instance_not_found', 'task creation must reject an unrecruited lead without creating it');
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM task_runs').get().count, taskCountBeforeUnrecruitedLead);
  assert.equal(runtime.store.findUserAgentInstance({ userId: 'local_admin', agentFamilyId: 'ppt' }), null);
  const externalModelSession = runtime.store.createSession({
    title: 'External image model session', userId: 'local_admin', departmentId: 'image_generation', agentId: 'gpt-image-2',
  });
  assert.equal(externalModelSession.agentInstanceId, '', 'non-family execution identifiers must remain usable without becoming employees');
  const employeeFilteredTask = runtime.scheduler.createTaskRun({
    title: 'Employee-filtered scheduler task', prompt: 'Prepare a PPT outline without silently recruiting a specialist.',
    departmentId: 'ppt_department', userId: 'local_admin',
  });
  assert.equal(employeeFilteredTask.leadAgentId, 'general_agent', 'the scheduler must fall back within the recruited employee pool');
  assert.ok(employeeFilteredTask.nodes.every((node) => node.agentId === 'general_agent'));
  assert.equal(runtime.store.findUserAgentInstance({ userId: 'local_admin', agentFamilyId: 'ppt' }), null);
  const localAdminPptRecruitment = runtime.store.recruitUserAgent({
    userId: 'local_admin', agentFamilyId: 'ppt', commandId: 'check:local-admin:recruit-ppt',
  });
  assert.equal(localAdminPptRecruitment.status, 'active');
  const localAdminPptInstance = localAdminPptRecruitment.instance;
  assert.equal(localAdminPptInstance.personalEvolutionConsent, true, 'recruitment must default personal evolution on');
  assert.equal(localAdminPptInstance.clusterContributionConsent,true,'active synchronized recruitment must participate in cluster evolution');
  runtime.store.upsertAgentFamily({
    id: 'pending_cloud_agent', name: 'Pending Cloud Agent', departmentId: 'general', role: 'agent',
    lifecycleStatus: 'active', enabled: true, routable: true,
  });
  const pendingRecruitable = runtime.store.listRecruitableAgentFamilies({ userId: 'local_admin' })
    .find((item) => !item.instance && item.id !== 'general_agent');
  assert.ok(pendingRecruitable, 'pending cloud recruitment test requires an unrecruited family');
  const pendingRecruit = runtime.store.stagePendingEmployeeCommand({
    userId: 'local_admin', remoteUserId: 'remote_local_admin', action: 'recruit',
    agentFamilyId: pendingRecruitable.id, commandId: 'check:cloud-pending:recruit', sourceDeviceId: 'check_device',
  });
  assert.equal(pendingRecruit.status, 'pending_cloud_confirmation');
  assert.equal(pendingRecruit.instance.pendingTargetState, 'active');
  assert.equal(pendingRecruit.instance.authorityState, 'pending');
  assert.equal(runtime.store.activeEmployeeAgentsForUser({ userId: 'local_admin' }).some((item) => item.id === pendingRecruit.instance.id), true, 'pending cloud recruitment should be locally routable while reserving quota');
  assert.equal(runtime.store.listEmployeeCommandOutbox({ userId: 'local_admin', statuses: ['pending'] }).some((item) => item.commandId === 'check:cloud-pending:recruit'), true);
  runtime.db.prepare("UPDATE user_agent_instances SET status='inactive',employment_state='inactive' WHERE id=?")
    .run(pendingRecruit.instance.id);
  const legacyPendingActive = runtime.store.activeEmployeeAgentsForUser({ userId: 'local_admin' })
    .find((item) => item.id === pendingRecruit.instance.id);
  assert.equal(legacyPendingActive?.routeEligible, true, 'a legacy inactive row with a queued active target must remain locally routable');
  const repeatedPendingActivation = runtime.store.stagePendingEmployeeCommand({
    userId: 'local_admin', remoteUserId: 'remote_local_admin', action: 'reactivate',
    agentFamilyId: pendingRecruitable.id, agentInstanceId: pendingRecruit.instance.id,
    commandId: 'check:cloud-pending:reactivate-duplicate', expectedStateRevision: pendingRecruit.instance.stateRevision,
    sourceDeviceId: 'check_device',
  });
  assert.equal(repeatedPendingActivation.idempotent, true, 'repeating an already queued active target must be idempotent');
  assert.equal(repeatedPendingActivation.commandId, 'check:cloud-pending:recruit');
  assert.equal(runtime.store.getEmployeeCommandOutbox({
    userId: 'local_admin', commandId: 'check:cloud-pending:reactivate-duplicate',
  }), null, 'idempotent activation must not create a second lifecycle command');
  const cloudCanonicalId = 'check_cloud_canonical_instance';
  const confirmedPendingRecruit = runtime.store.applyCloudEmployeeCommandResult({
    userId: 'local_admin', commandId: 'check:cloud-pending:recruit',
    result: {
      status: 'confirmed', commandId: 'check:cloud-pending:recruit',
      instance: {
        id: cloudCanonicalId, agentFamilyId: pendingRecruitable.id, status: 'active', instanceKind: 'employee',
        employmentState: 'active', quotaExempt: false, stateRevision: 1, policyVersion: 'employee_cloud_authority_v1',
        syncEnabled: true, personalEvolutionConsent: true, clusterContributionConsent: true, personalSkillAutoActivate: true,
      },
      event: {
        id: 'check_cloud_recruit_event', agentFamilyId: pendingRecruitable.id, agentInstanceId: cloudCanonicalId,
        eventType: 'recruited', previousState: 'not_recruited', nextState: 'active', commandId: 'check:cloud-pending:recruit',
      },
    },
  });
  assert.equal(confirmedPendingRecruit.instance.id, cloudCanonicalId);
  assert.equal(confirmedPendingRecruit.instance.authorityState, 'cloud_confirmed');
  assert.equal(runtime.store.resolveUserAgent({ userId: 'local_admin', agentInstanceId: pendingRecruit.instance.id }).instance.id, cloudCanonicalId, 'provisional instance IDs must resolve to the cloud canonical instance');
  assert.equal(runtime.store.listEmployeeCommandOutbox({ userId: 'local_admin', statuses: ['confirmed'] }).some((item) => item.commandId === 'check:cloud-pending:recruit'), true);
  runtime.store.applyCloudEmployeeInstance({
    userId: 'local_admin',
    instance: {
      ...confirmedPendingRecruit.instance, status: 'inactive', employmentState: 'inactive', stateRevision: 2,
      deactivatedAt: new Date().toISOString(), policyVersion: 'employee_cloud_authority_v1',
    },
  });
  const fifoChat = runtime.store.enqueueAgentWork({
    userId: 'local_admin', agentInstanceId: localAdminPptInstance.id, workKind: 'chat', workId: 'check_fifo_chat', payload: { title: 'FIFO chat' },
  });
  const fifoTask = runtime.store.enqueueAgentWork({
    userId: 'local_admin', agentInstanceId: localAdminPptInstance.id, workKind: 'task_node', workId: 'check_fifo_task', payload: { title: 'FIFO task' },
  });
  assert.equal(runtime.store.claimAgentWork({ id: fifoTask.id }), null, 'later work cannot bypass the Agent FIFO head');
  assert.equal(runtime.store.claimAgentWork({ id: fifoChat.id }).status, 'running');
  assert.equal(runtime.store.claimAgentWork({ id: fifoTask.id }), null, 'one Agent cannot run chat and task work concurrently');
  runtime.store.finishAgentWork({ id: fifoChat.id, status: 'completed' });
  assert.equal(runtime.store.claimAgentWork({ id: fifoTask.id }).status, 'running');
  runtime.store.finishAgentWork({ id: fifoTask.id, status: 'completed' });
  const queuedBeforeDeactivate = runtime.store.enqueueAgentWork({
    userId: 'local_admin', agentInstanceId: localAdminPptInstance.id, workKind: 'task_node', workId: 'check_fifo_cancel', payload: { title: 'Cancel on deactivate' },
  });
  const originalEmployeeRequireUser = runtime.auth.requireUser;
  const originalEmployeeCloudStatus = runtime.cloudSync.status;
  const originalEmployeeSubmitCommand = runtime.cloudSync.submitEmployeeCommand;
  const originalEmployeeAutoSync = runtime.cloudSync.requestAutoSync;
  runtime.auth.requireUser = () => ({ ...originalEmployeeRequireUser.call(runtime.auth), remoteBound: true, remoteId: 'remote_local_admin' });
  runtime.cloudSync.status = () => ({
    ...originalEmployeeCloudStatus.call(runtime.cloudSync),
    configured: true,
    userId: 'remote_local_admin',
    serverUrl: 'https://cloud.example.test',
    deviceId: 'check_device',
    employeeCapabilities: { contractVersion: 2, lifecycleMutation: 'command_only', profileSequenceAuthority: 'server' },
  });
  runtime.cloudSync.submitEmployeeCommand = async () => ({ status: 'queued' });
  runtime.cloudSync.requestAutoSync = async () => ({ status: 'skipped', reason: 'check_stub' });
  try {
    const freshPpt = runtime.store.getUserAgentInstance(localAdminPptInstance.id);
    const deactivatedThroughRuntime = await runtime.deactivateEmployee({
      agentInstanceId: freshPpt.id, commandId: 'check:runtime:deactivate-ppt', expectedStateRevision: freshPpt.stateRevision,
    });
    assert.equal(deactivatedThroughRuntime.status, 'pending_cloud_confirmation');
    assert.equal(deactivatedThroughRuntime.instance.employmentState, 'inactive', 'deactivation must become locally inactive before cloud confirmation');
    assert.equal(deactivatedThroughRuntime.instance.authorityState, 'pending', 'the durable cloud command must remain queued separately');
    assert.equal(deactivatedThroughRuntime.instance.pendingTargetState, 'inactive');
    assert.equal(runtime.store.getAgentWork(queuedBeforeDeactivate.id).status, 'cancelled', 'deactivation must cancel queued work');
    runtime.store.applyCloudEmployeeCommandResult({
      userId: 'local_admin', commandId: 'check:runtime:deactivate-ppt', result: {
        status: 'confirmed', commandId: 'check:runtime:deactivate-ppt',
        instance: { ...freshPpt, status: 'inactive', employmentState: 'inactive', stateRevision: freshPpt.stateRevision + 1,
          policyVersion: 'employee_cloud_authority_v1', deactivatedAt: new Date().toISOString() },
        event: { id: 'check_runtime_deactivate_event', agentFamilyId: freshPpt.agentFamilyId, agentInstanceId: freshPpt.id,
          eventType: 'deactivated', previousState: 'active', nextState: 'inactive', commandId: 'check:runtime:deactivate-ppt' },
      },
    });
    const inactivePpt = runtime.store.getUserAgentInstance(localAdminPptInstance.id);
    const reactivatedThroughRuntime = await runtime.reactivateEmployee({
      agentInstanceId: inactivePpt.id, commandId: 'check:runtime:reactivate-ppt', expectedStateRevision: inactivePpt.stateRevision,
    });
    assert.equal(reactivatedThroughRuntime.status, 'pending_cloud_confirmation');
    const repeatedRuntimeReactivation = await runtime.reactivateEmployee({
      agentInstanceId: inactivePpt.id, commandId: 'check:runtime:reactivate-ppt-duplicate', expectedStateRevision: inactivePpt.stateRevision,
    });
    assert.equal(repeatedRuntimeReactivation.idempotent, true);
    assert.equal(repeatedRuntimeReactivation.commandId, 'check:runtime:reactivate-ppt');
    assert.equal(runtime.store.getEmployeeCommandOutbox({
      userId: 'local_admin', commandId: 'check:runtime:reactivate-ppt-duplicate',
    }), null, 'runtime idempotency must reuse the queued lifecycle command');
    runtime.store.applyCloudEmployeeCommandResult({
      userId: 'local_admin', commandId: 'check:runtime:reactivate-ppt', result: {
        status: 'confirmed', commandId: 'check:runtime:reactivate-ppt',
        instance: { ...inactivePpt, status: 'active', employmentState: 'active', stateRevision: inactivePpt.stateRevision + 1,
          policyVersion: 'employee_cloud_authority_v1', deactivatedAt: '' },
        event: { id: 'check_runtime_reactivate_event', agentFamilyId: inactivePpt.agentFamilyId, agentInstanceId: inactivePpt.id,
          eventType: 'reactivated', previousState: 'inactive', nextState: 'active', commandId: 'check:runtime:reactivate-ppt' },
      },
    });
  } finally {
    runtime.auth.requireUser = originalEmployeeRequireUser;
    runtime.cloudSync.status = originalEmployeeCloudStatus;
    runtime.cloudSync.submitEmployeeCommand = originalEmployeeSubmitCommand;
    runtime.cloudSync.requestAutoSync = originalEmployeeAutoSync;
  }
  const modernPptAfterQueueChecks = runtime.store.getUserAgentInstance(localAdminPptInstance.id);
  const modernPptRevision = modernPptAfterQueueChecks.stateRevision;
  const modernPptRecruitmentSource = modernPptAfterQueueChecks.recruitmentSource;
  runtime.store.reconcileEmployeeInstanceClassifications();
  const reconciledModernPpt = runtime.store.getUserAgentInstance(localAdminPptInstance.id);
  assert.equal(reconciledModernPpt.stateRevision, modernPptRevision, 'catalog reconciliation must not rewrite a modern employee lifecycle');
  assert.equal(reconciledModernPpt.recruitmentSource, modernPptRecruitmentSource);
  const personalCoordinatorStatus = runtime.evolutionCoordinators.personal.status();
  assert.equal(personalCoordinatorStatus.authority, 'cloud');
  assert.equal(personalCoordinatorStatus.authorityLocked, true);
  assert.equal(personalCoordinatorStatus.enabled, true);
  assert.equal(personalCoordinatorStatus.localExecutionEnabled, false);
  assert.equal(personalCoordinatorStatus.code, 'cloud_not_configured');
  const clusterCoordinatorStatus = runtime.evolutionCoordinators.cluster.status();
  assert.equal(clusterCoordinatorStatus.authority, 'cloud');
  assert.equal(clusterCoordinatorStatus.authorityLocked, true);
  assert.equal(clusterCoordinatorStatus.enabled, true);
  assert.equal(clusterCoordinatorStatus.readOnly, true);
  assert.equal(runtime.store.ensureUserAgentInstance({ userId: 'local_admin', agentFamilyId: 'ppt' }).id, localAdminPptInstance.id, 'system/default provisioning must reuse its existing instance');
  const localEmployeeOverview = await runtime.employeeOverview();
  const defaultUBuddyTalent = localEmployeeOverview.roster.find((item) => item.agentFamilyId === 'secretary_agent');
  assert.ok(defaultUBuddyTalent, 'talent market must include the default uBuddy system instance');
  assert.equal(defaultUBuddyTalent.defaultRecruited, true);
  assert.equal(defaultUBuddyTalent.routeEligible, true);
  assert.equal(defaultUBuddyTalent.quotaExempt, true);
  runtime.db.prepare(
    `INSERT INTO auth_users (id, email, display_name, username, role, remote_id, email_verified)
     VALUES ('identity_user_check', 'identity.user@check.local', 'Identity User', 'identity_user_check', 'member', '', 1)`,
  ).run();
  runtime.store.provisionNewUserAgentDefaults({ userId: 'identity_user_check' });
  const secondPptInstance = runtime.store.recruitUserAgent({
    userId: 'identity_user_check', agentFamilyId: 'ppt', commandId: 'check:identity-user:recruit-ppt',
  }).instance;
  assert.notEqual(secondPptInstance.id, localAdminPptInstance.id, 'different users must receive isolated instances of the same Agent family');

  runtime.db.prepare(
    `INSERT INTO auth_users (id, email, display_name, username, role, remote_id, email_verified)
     VALUES ('recruitment_user_check', 'recruitment.user@check.local', 'Recruitment User', 'recruitment_user_check', 'member', '', 1)`,
  ).run();
  const recruitmentDefaults = runtime.store.provisionNewUserAgentDefaults({ userId: 'recruitment_user_check' });
  assert.equal(recruitmentDefaults.quota.used, 1, 'the default general employee must consume one quota slot');
  const recruitmentSecretary = runtime.store.findUserAgentInstance({ userId: 'recruitment_user_check', agentFamilyId: 'secretary_agent' });
  assert.ok(recruitmentSecretary?.quotaExempt, 'uBuddy must be quota exempt for every user');
  runtime.db.prepare("UPDATE user_agent_instances SET status = 'inactive', employment_state = 'inactive', quota_exempt = 0 WHERE id = ?").run(recruitmentSecretary.id);
  runtime.store.provisionNewUserAgentDefaults({ userId: 'recruitment_user_check' });
  const restoredRecruitmentSecretary = runtime.store.getUserAgentInstance(recruitmentSecretary.id);
  assert.equal(restoredRecruitmentSecretary.employmentState, 'active', 'default provisioning must restore the permanent uBuddy system instance');
  assert.equal(restoredRecruitmentSecretary.quotaExempt, true);
  for (let employeeNumber = 2; employeeNumber <= 11; employeeNumber += 1) {
    const familyId = `quota_employee_${employeeNumber}`;
    runtime.store.upsertAgentFamily({
      id: familyId,
      name: `Quota Employee ${employeeNumber}`,
      departmentId: 'general',
      role: 'agent',
      routable: true,
      enabled: true,
      lifecycleStatus: 'active',
    });
    runtime.store.upsertAgentVersion({
      agent: { id: familyId, name: `Quota Employee ${employeeNumber}`, departmentId: 'general', role: 'agent', baseSkill: `# ${familyId}\n` },
      memoryTemplate: `# Agent Memory: ${familyId}\n`,
      sourceBundleId: 'employee_recruitment_check',
    });
  }
  assert.throws(() => runtime.store.recruitUserAgent({
    userId: 'recruitment_user_check', agentFamilyId: 'quota_employee_2',
  }), (error) => error?.code === 'recruitment_command_required', 'employee lifecycle commands must require an idempotency command ID');
  const secondEmployeeRecruitment = runtime.store.recruitUserAgent({
    userId: 'recruitment_user_check', agentFamilyId: 'quota_employee_2', commandId: 'quota-command-2',
  });
  assert.equal(secondEmployeeRecruitment.quota.used, 2);
  const secondEmployeeHistoricalSession = runtime.store.createSession({
    title: 'Employee history survives deactivation', userId: 'recruitment_user_check',
    departmentId: 'general', agentId: 'quota_employee_2', agentInstanceId: secondEmployeeRecruitment.instance.id,
  });
  const secondEmployeeMemory = runtime.store.listMemoryDocuments({ agentInstanceId: secondEmployeeRecruitment.instance.id })[0];
  const idempotentSecondEmployeeRecruitment = runtime.store.recruitUserAgent({
    userId: 'recruitment_user_check', agentFamilyId: 'quota_employee_2', commandId: 'quota-command-2',
  });
  assert.equal(idempotentSecondEmployeeRecruitment.idempotent, true, 'replayed recruitment commands must return the original result');
  assert.equal(idempotentSecondEmployeeRecruitment.instance.id, secondEmployeeRecruitment.instance.id);
  const sameFamilyRecruitment = runtime.store.recruitUserAgent({
    userId: 'recruitment_user_check', agentFamilyId: 'quota_employee_2', commandId: 'quota-command-2-already-active',
  });
  assert.equal(sameFamilyRecruitment.action, 'recruited');
  assert.notEqual(sameFamilyRecruitment.instance.id, secondEmployeeRecruitment.instance.id);
  assert.equal(secondEmployeeRecruitment.instance.displayName, 'Quota Employee 2 A');
  assert.equal(sameFamilyRecruitment.instance.displayName, 'Quota Employee 2 B');
  assert.notEqual(runtime.store.listMemoryDocuments({ agentInstanceId: sameFamilyRecruitment.instance.id })[0].id, secondEmployeeMemory?.id);
  const profiledSameFamilyInstance = runtime.store.updateUserAgentProfile({
    userId: 'recruitment_user_check', agentInstanceId: sameFamilyRecruitment.instance.id,
    displayName: '备用研究助手', note: '只属于 B 实例的备注',
  });
  assert.equal(profiledSameFamilyInstance.displayName, '备用研究助手');
  assert.equal(profiledSameFamilyInstance.note, '只属于 B 实例的备注');
  assert.equal(runtime.store.getUserAgentInstance(secondEmployeeRecruitment.instance.id).displayName, 'Quota Employee 2 A',
    'editing one same-Family instance profile must not rename its sibling');
  assert.equal(runtime.store.updateUserAgentProfile({
    userId: 'recruitment_user_check', agentInstanceId: sameFamilyRecruitment.instance.id,
    displayName: '', note: profiledSameFamilyInstance.note,
  }).displayName, 'Quota Employee 2 B', 'clearing a custom name must restore the sequence-based default');
  assert.equal(runtime.store.recruitUserAgent({
    userId: 'recruitment_user_check', agentFamilyId: 'quota_employee_2', commandId: 'quota-command-2-already-active',
  }).idempotent, true, 'same-family recruitment commands must remain idempotent');
  for (let employeeNumber = 3; employeeNumber <= 9; employeeNumber += 1) {
    const result = runtime.store.recruitUserAgent({
      userId: 'recruitment_user_check',
      agentFamilyId: `quota_employee_${employeeNumber}`,
      commandId: `quota-command-${employeeNumber}`,
    });
    assert.equal(result.status, 'active', `employee ${employeeNumber} must fit within the quota`);
  }
  assert.equal(runtime.store.getEmployeeQuota({ userId: 'recruitment_user_check' }).used, 10, 'the tenth active employee must be accepted');
  const eleventhEmployee = runtime.store.recruitUserAgent({
    userId: 'recruitment_user_check', agentFamilyId: 'quota_employee_10', commandId: 'quota-command-10',
  });
  assert.equal(eleventhEmployee.status, 'rejected');
  assert.equal(eleventhEmployee.code, 'employee_quota_exceeded', 'the eleventh active employee must be rejected');
  const deactivatedSecondEmployee = runtime.store.deactivateUserAgent({
    userId: 'recruitment_user_check', agentInstanceId: secondEmployeeRecruitment.instance.id, commandId: 'quota-deactivate-2',
    expectedStateRevision: secondEmployeeRecruitment.instance.stateRevision,
  });
  assert.equal(deactivatedSecondEmployee.status, 'inactive');
  assert.equal(deactivatedSecondEmployee.quota.used, 9, 'deactivation must immediately release one quota slot');
  assert.equal(runtime.store.getSession(secondEmployeeHistoricalSession.id).agentInstanceId, secondEmployeeRecruitment.instance.id, 'deactivation must preserve readable historical sessions');
  assert.throws(() => runtime.store.createSession({
    title: 'Inactive employee cannot start again', userId: 'recruitment_user_check',
    departmentId: 'general', agentId: 'quota_employee_2', agentInstanceId: secondEmployeeRecruitment.instance.id,
  }), (error) => error?.code === 'employee_not_active');
  const activeEmployeesWhileSecondInactive = runtime.store.activeEmployeeAgentsForUser({ userId: 'recruitment_user_check' });
  assert.equal(activeEmployeesWhileSecondInactive.some((item) => item.id === secondEmployeeRecruitment.instance.id), false);
  assert.equal(activeEmployeesWhileSecondInactive.some((item) => item.agentFamilyId === 'secretary_agent'), false);
  const reactivatedSecondEmployee = runtime.store.reactivateUserAgent({
    userId: 'recruitment_user_check', agentInstanceId: secondEmployeeRecruitment.instance.id, commandId: 'quota-reactivate-2',
    expectedStateRevision: deactivatedSecondEmployee.instance.stateRevision,
  });
  assert.equal(reactivatedSecondEmployee.quota.used, 10);
  assert.equal(reactivatedSecondEmployee.instance.id, secondEmployeeRecruitment.instance.id, 'reactivation must preserve the permanent Agent instance id');
  assert.equal(runtime.store.listMemoryDocuments({ agentInstanceId: reactivatedSecondEmployee.instance.id })[0].id, secondEmployeeMemory.id, 'reactivation must preserve memory0');
  const replayedDeactivationAfterReactivation = runtime.store.deactivateUserAgent({
    userId: 'recruitment_user_check', agentInstanceId: secondEmployeeRecruitment.instance.id,
    commandId: 'quota-deactivate-2', expectedStateRevision: secondEmployeeRecruitment.instance.stateRevision,
  });
  assert.equal(replayedDeactivationAfterReactivation.idempotent, true);
  assert.equal(replayedDeactivationAfterReactivation.status, 'inactive', 'an idempotent replay must preserve the original command result even after later state changes');
  assert.equal(replayedDeactivationAfterReactivation.instance.employmentState, 'active', 'the replay may expose the current instance snapshot without reapplying the old command');
  const staleDeactivation = runtime.store.deactivateUserAgent({
    userId: 'recruitment_user_check', agentInstanceId: secondEmployeeRecruitment.instance.id,
    commandId: 'quota-stale-deactivate-2', expectedStateRevision: deactivatedSecondEmployee.instance.stateRevision,
  });
  assert.equal(staleDeactivation.status, 'rejected');
  assert.equal(staleDeactivation.code, 'employee_state_conflict', 'stale lifecycle writes must be rejected instead of overwriting newer state');
  assert.equal(runtime.store.getUserAgentInstance(secondEmployeeRecruitment.instance.id).employmentState, 'active');
  assert.throws(() => runtime.db.prepare(`INSERT INTO user_agent_instances (
    id, user_id, agent_family_id, base_agent_version_id, status,
    instance_kind, employment_state, quota_exempt
  ) VALUES ('quota_bypass_instance', 'recruitment_user_check', 'quota_employee_11', '', 'active', 'employee', 'active', 0)`).run(), /employee quota exceeded/, 'the database trigger must reject quota bypasses');
  runtime.db.prepare(`INSERT INTO auth_users (
    id, email, display_name, username, role, email_verified, remote_id
  ) VALUES ('stable_local_user', 'stable.binding@check.local', 'Stable Local', 'stable_local_user', 'member', 1, '')`).run();
  const boundStableUser = runtime.auth.importCloudUser({
    id: 'remote_stable_user',
    email: 'stable.binding@check.local',
    displayName: 'Stable Cloud User',
    emailVerified: true,
  });
  assert.equal(boundStableUser.id, 'stable_local_user', 'cloud binding must preserve the local user primary key');
  assert.equal(boundStableUser.remoteId, 'remote_stable_user');
  assert.equal(boundStableUser.remoteBound, true);
  let partialBoundStableUser = null;
  for (let index = 0; index < 3; index += 1) partialBoundStableUser = runtime.auth.importCloudUser({ id: 'remote_stable_user' });
  assert.equal(partialBoundStableUser.displayName, 'Stable Cloud User', 'an id-only social snapshot must not replace a bound display name with its database key');
  assert.equal(partialBoundStableUser.email, 'stable.binding@check.local', 'an id-only social snapshot must preserve the bound email');
  assert.equal(partialBoundStableUser.username, 'stable_local_user', 'an id-only social snapshot must preserve the bound username');
  assert.equal(partialBoundStableUser.emailVerified, true, 'an id-only social snapshot must preserve verification state');
  const newCloudLocalUser = runtime.auth.importCloudUser({
    id: 'remote_new_user', email: 'new.cloud@check.local', displayName: 'New Cloud User', emailVerified: true, avatarUrl: longAvatarUrl,
  });
  assert.equal(newCloudLocalUser.id, 'remote_new_user', 'unmatched cloud users must preserve the stable cloud user id locally');
  assert.equal(newCloudLocalUser.remoteId, 'remote_new_user');
  const refreshedCloudContact = runtime.auth.importCloudUser({
    id: 'remote_new_user', email: 'new.cloud@check.local', displayName: 'New Cloud User', emailVerified: true, avatarUrl: replacementAvatarUrl,
  });
  assert.equal(refreshedCloudContact.avatarUrl, replacementAvatarUrl, 'an explicit cloud contact avatar must replace the cached prior avatar even when a legacy snapshot omitted updatedAt');
  const activeAvatarUser = runtime.currentUser();
  runtime.auth.importCloudOrganizations([{
    id: 'avatar_sync_org', organizationNumber: 'AVATAR-SYNC', name: 'Avatar Sync', ownerUserId: activeAvatarUser.id,
    owner: activeAvatarUser,
    members: [
      { role: 'owner', user: activeAvatarUser },
      { role: 'member', user: { id: 'remote_new_user', email: 'new.cloud@check.local', displayName: 'New Cloud User', avatarUrl: replacementAvatarUrl } },
    ],
  }]);
  assert.equal(runtime.db.prepare('SELECT max(length(avatar_url)) AS length FROM account_workspace_memberships WHERE user_id=?').get(refreshedCloudContact.id).length,
    replacementAvatarUrl.length, 'workspace membership snapshots must preserve complete custom avatar data instead of truncating it');
  assert.throws(() => runtime.auth.bindRemoteIdentity({ localUserId: 'identity_user_check', remoteId: 'remote_stable_user' }), /already bound|已绑定/);
  runtime.store.reconcileAgentIdentityCatalog({
    organization: {
      agents: [{
        id: 'legacy_template_gap_agent', name: 'Legacy Template Gap', departmentId: 'general', role: 'agent',
        routable: false, enabled: true, lifecycleStatus: 'active', baseSkill: '# Legacy Gap Skill',
        memoryPath: '/runtime/legacy-template-gap/MEMORY.md', runtimeMemory: '# Runtime private memory\n',
      }],
      hrs: [], leaders: [],
    },
    memoryTemplateForAgent: () => '',
  });
  assert.ok(runtime.db.prepare("SELECT id FROM legacy_memory_candidates WHERE agent_family_id = 'legacy_template_gap_agent'").get(), 'runtime Memory must enter review even when the asset template is missing');
  assert.equal(runtime.store.findUserAgentInstance({ userId: 'local_admin', agentFamilyId: 'legacy_template_gap_agent' }), null, 'non-routable specialists must not create user instances');
  const adminMemory0 = runtime.store.listMemoryDocuments({ agentInstanceId: localAdminPptInstance.id });
  const secondMemory0 = runtime.store.listMemoryDocuments({ agentInstanceId: secondPptInstance.id });
  assert.equal(adminMemory0.length, 1);
  assert.equal(secondMemory0.length, 1);
  assert.notEqual(adminMemory0[0].id, secondMemory0[0].id, 'memory0 must be private to its user Agent instance');
  assert.equal(adminMemory0[0].slotNo, 0);
  assert.equal(adminMemory0[0].displayName, 'memory0.md');
  assert.equal(secondMemory0[0].displayName, 'memory0.md');
  const adminMemory1 = runtime.store.createNextGeneralMemoryDocument({ agentInstanceId: localAdminPptInstance.id });
  assert.equal(adminMemory1.slotNo, 1, 'memory1 must be created only through an explicit create operation');
  assert.equal(adminMemory1.displayName, '新对话 2');
  const generalMemoryContext = runtime.store.resolveMemoryContext({ agentInstanceId: localAdminPptInstance.id });
  assert.deepEqual(generalMemoryContext.documents.map((item) => item.id), [adminMemory1.id], 'only the current general Memory may enter the runtime context');
  const secondDeviceContext = runtime.store.getDeviceContextState({ deviceId: 'memory-device-b', userId: 'local_admin', agentInstanceId: localAdminPptInstance.id });
  assert.equal(secondDeviceContext.activeMemoryDocumentId, adminMemory1.id);
  runtime.store.switchCurrentMemory({ agentInstanceId: localAdminPptInstance.id, memoryDocumentId: adminMemory0[0].id, deviceId: 'memory-device-a' });
  assert.deepEqual(runtime.store.resolveMemoryContext({ agentInstanceId: localAdminPptInstance.id, deviceId: 'memory-device-a' }).documents.map((item) => item.id), [adminMemory0[0].id]);
  assert.deepEqual(runtime.store.resolveMemoryContext({agentInstanceId:localAdminPptInstance.id,deviceId:'memory-device-b'}).documents.map((item)=>item.id),[adminMemory0[0].id],'current Memory selection must synchronize account-wide');
  const clearedGeneralMemory = runtime.store.clearCurrentMemory({ agentInstanceId: localAdminPptInstance.id, deviceId: 'memory-device-a' });
  assert.equal(clearedGeneralMemory.archived.id, adminMemory0[0].id, 'clear must archive memory0 without deleting its versions');
  assert.equal(clearedGeneralMemory.current.slotNo, 2, 'clear must create and activate the next numbered Memory slot');
  assert.equal(runtime.store.getDeviceContextState({deviceId:'memory-device-b',userId:'local_admin',agentInstanceId:localAdminPptInstance.id}).activeMemoryDocumentId,clearedGeneralMemory.current.id,
    'clearing Memory must synchronize the new current slot across devices');
  const memoryConflictBaseline = runtime.store.getMemoryDocument(adminMemory1.id);
  const memoryConflictCurrent = runtime.store.appendMemoryDocumentVersion({
    memoryDocumentId: adminMemory1.id, content: `${memoryConflictBaseline.content}\n- canonical device edit`, sourceKind: 'conflict_check',
  });
  runtime.store.appendMemoryDocumentVersion({
    memoryDocumentId: adminMemory1.id, content: `${memoryConflictBaseline.content}\n- concurrent device edit`, sourceKind: 'conflict_check',
    baseVersionId: memoryConflictBaseline.currentVersionId,
  });
  const memoryConflicts = runtime.store.listMemoryConflicts({ memoryDocumentId: adminMemory1.id });
  assert.equal(memoryConflicts.length, 1, 'a stale base version must create a preserved sibling branch');
  assert.equal(runtime.store.getMemoryDocument(adminMemory1.id).currentVersionId, memoryConflictCurrent.currentVersionId,
    'an unresolved branch must not silently replace the current Memory version');
  const resolvedMemoryConflict=runtime.store.resolveMemoryConflict({memoryDocumentId:adminMemory1.id,versionId:memoryConflicts[0].id,createdBy:'local_admin'});
  assert.equal(resolvedMemoryConflict.selectedVersionId,memoryConflicts[0].id);
  assert.equal(runtime.store.getMemoryDocument(adminMemory1.id).currentVersionId,resolvedMemoryConflict.mergedVersionId);
  const memoryCheckpointDeviceId = 'memory-checkpoint-device';
  const originalCloudStatus = runtime.cloudSync.status;
  runtime.cloudSync.status = () => ({
    ...originalCloudStatus.call(runtime.cloudSync),
    deviceId: memoryCheckpointDeviceId,
    multiMemory: { enabled: true, readOnly: false, code: '' },
  });
  try {
    const checkpointSession = runtime.ensureSecretarySession();
    const checkpointInstanceId = checkpointSession.agentInstanceId;
    runtime.store.addMessage({
      sessionId: checkpointSession.id,
      role: 'user',
      content: '请把这一段当前任务背景保存到 Memory。',
      agentId: 'secretary_agent',
      departmentId: 'secretary_department',
    });
    runtime.store.addMessage({
      sessionId: checkpointSession.id,
      role: 'assistant',
      content: '已记录当前任务背景，等待用户切换上下文。',
      agentId: 'secretary_agent',
      departmentId: 'secretary_department',
    });
    const checkpointResult = runtime.clearEmployeeMemory({
      agentInstanceId: checkpointInstanceId,
      sessionId: checkpointSession.id,
      saveCurrentContext: true,
    });
    assert.ok(checkpointResult.checkpoint?.content.includes('请把这一段当前任务背景保存到 Memory'));
    assert.equal(checkpointResult.archived.lifecycleState, 'archived');
    assert.equal(checkpointResult.current.slotNo, checkpointResult.archived.slotNo + 1);
    const clearedContextState = runtime.store.getDeviceContextState({
      deviceId: memoryCheckpointDeviceId, userId: checkpointSession.userId, agentInstanceId: checkpointInstanceId,
    });
    assert.equal(runtime.store.listMessages(checkpointSession.id, {
      contextSpaceId: clearedContextState.activeContextSpaceId,
      includeAllContexts: false,
    }).length, 0, 'a newly activated Memory must start with an empty active context while preserving prior single-window history');
    runtime.store.restoreMemoryDocument({ memoryDocumentId: checkpointResult.archived.id });
    runtime.store.switchCurrentMemory({ agentInstanceId: checkpointInstanceId, memoryDocumentId: checkpointResult.archived.id, deviceId: memoryCheckpointDeviceId });
    assert.ok(runtime.listMessages(checkpointSession.id).some((message) => message.content.includes('当前任务背景')), 'switching back must restore the messages associated with that Memory context');
  } finally {
    runtime.cloudSync.status = originalCloudStatus;
  }
  const scopedTask = runtime.store.createTaskRun({
    title: 'Scoped Memory Task', prompt: 'Verify task Memory isolation.', departmentId: 'ppt_department',
    leadAgentId: 'ppt', leadAgentInstanceId: localAdminPptInstance.id, ownerUserId: 'local_admin',
  });
  const taskSecurity = runtime.store.getTaskSecurityContext(scopedTask.id);
  assert.match(taskSecurity.localKeyId, /^task_local_key_/);
  assert.match(taskSecurity.cloudKeyId, /^task_cloud_key_/);
  assert.notEqual(taskSecurity.localKeyId, taskSecurity.cloudKeyId);
  assert.equal(taskSecurity.cloudEvolutionAllowed, false);
  assert.equal(taskSecurity.localEnvelopeState, 'active');
  assert.equal(taskSecurity.localWrapAlgorithm, 'aes-256-gcm');
  assert.ok(taskSecurity.localWrappedKey, 'task DEK must be wrapped by a device-local key');
  const scopedTaskMemory = runtime.store.listMemoryDocuments({ agentInstanceId: localAdminPptInstance.id })
    .find((item) => item.scope === 'task' && item.taskRunId === scopedTask.id);
  assert.ok(scopedTaskMemory, 'assigning a task must create an Agent-specific task Memory');
  assert.equal(scopedTaskMemory.decryptionState, 'decrypted');
  const encryptedTaskVersion = runtime.db.prepare('SELECT * FROM memory_document_versions WHERE id=?').get(scopedTaskMemory.currentVersionId);
  assert.equal(encryptedTaskVersion.content, '', 'task Memory plaintext must not remain in the version row');
  assert.equal(encryptedTaskVersion.encryption_algorithm, 'aes-256-gcm');
  assert.ok(encryptedTaskVersion.content_ciphertext);
  assert.equal(encryptedTaskVersion.content_ciphertext.includes('Scoped Memory Task'), false);
  assert.equal(generalMemoryContext.documents.some((item) => item.id === scopedTaskMemory.id), false, 'ordinary chat Memory must exclude task documents');
  const taskMemoryContext = runtime.store.resolveMemoryContext({ agentInstanceId: localAdminPptInstance.id, taskRunId: scopedTask.id });
  assert.equal(taskMemoryContext.documents.some((item) => item.id === scopedTaskMemory.id), true);
  runtime.store.setTaskCloudEvolutionAllowed({ taskRunId: scopedTask.id, allowed: true });
  const rotatedTaskKeyPair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  assert.equal(runtime.store.ensurePendingTaskCloudEnvelopes({
    keyring: { activeKeyId: 'task_cloud_check_v2', keys: { task_cloud_check_v2: rotatedTaskKeyPair.publicKey } },
  }).activated, 1);
  assert.equal(runtime.store.getTaskSecurityContext(scopedTask.id).cloudWrappingKeyId, 'task_cloud_check_v2');
  assert.equal(runtime.store.ensurePendingTaskCloudEnvelopes({
    keyring: { activeKeyId: 'task_cloud_check_v1', keys: { task_cloud_check_v1: taskMemoryKeyPair.publicKey } },
  }).activated, 1);
  const cloudTaskSecurity = runtime.store.getTaskSecurityContext(scopedTask.id);
  assert.equal(cloudTaskSecurity.cloudEvolutionAllowed, true);
  assert.equal(cloudTaskSecurity.cloudEnvelopeState, 'active');
  const cloudTaskKey = unwrapTaskKeyFromCloud({
    algorithm: cloudTaskSecurity.cloudWrapAlgorithm,
    keyId: cloudTaskSecurity.cloudWrappingKeyId,
    wrappedKey: cloudTaskSecurity.cloudWrappedKey,
  });
  assert.match(decryptTaskMemoryContent({
    algorithm: encryptedTaskVersion.encryption_algorithm,
    ciphertext: encryptedTaskVersion.content_ciphertext,
    nonce: encryptedTaskVersion.content_nonce,
    tag: encryptedTaskVersion.content_tag,
    aad: encryptedTaskVersion.content_aad,
  }, cloudTaskKey), /Scoped Memory Task/);
  assert.equal(runtime.store.getMemoryDocument(scopedTaskMemory.id).allowClusterEvolution, true);
  runtime.store.setTaskCloudEvolutionAllowed({ taskRunId: scopedTask.id, allowed: false });
  assert.equal(runtime.store.getTaskSecurityContext(scopedTask.id).cloudEnvelopeState, 'revoked');
  assert.equal(runtime.store.getMemoryDocument(scopedTaskMemory.id).allowClusterEvolution, false);
  runtime.store.setTaskCloudEvolutionAllowed({ taskRunId: scopedTask.id, allowed: true });
  const relationshipMemory = runtime.store.ensureRelationshipMemoryDocument({
    agentInstanceId: localAdminPptInstance.id, relationshipId: 'user:collaboration-check',
  });
  assert.equal(runtime.store.resolveMemoryContext({
    agentInstanceId: localAdminPptInstance.id, relationshipId: 'user:collaboration-check',
  }).documents.some((item) => item.id === relationshipMemory.id), true);
  assert.equal(runtime.store.resolveMemoryContext({
    agentInstanceId: localAdminPptInstance.id, relationshipId: 'user:other-collaborator',
  }).documents.some((item) => item.id === relationshipMemory.id), false);
  runtime.store.archiveMemoryDocument({ memoryDocumentId: adminMemory1.id });
  assert.equal(runtime.store.resolveMemoryContext({ agentInstanceId: localAdminPptInstance.id }).documents.some((item) => item.id === adminMemory1.id), false);
  assert.throws(() => runtime.store.resolveUserAgent({
    userId: 'local_admin', agentInstanceId: secondPptInstance.id, agentFamilyId: 'ppt',
  }), /does not belong/, 'an explicit Agent instance must not cross user ownership');
  assert.throws(() => runtime.store.createSession({
    title: 'Cross-user instance rejection', userId: 'local_admin', agentId: 'ppt', agentInstanceId: secondPptInstance.id,
  }), /does not belong/, 'session creation must reject another user\'s Agent instance');
  const consentBeforeRejectedMemoryUpdate = runtime.store.getUserAgentInstance(localAdminPptInstance.id).personalEvolutionConsent;
  assert.throws(() => runtime.updateUserAgentSettings({
    agentInstanceId: localAdminPptInstance.id,
    memoryDocumentId: secondMemory0[0].id,
    personalEvolutionConsent: !consentBeforeRejectedMemoryUpdate,
  }), /无权修改该 Memory 文档/);
  assert.equal(
    runtime.store.getUserAgentInstance(localAdminPptInstance.id).personalEvolutionConsent,
    consentBeforeRejectedMemoryUpdate,
    'rejected Memory authorization requests must not partially update Agent consent',
  );
  const additionalPptInstance = runtime.store.recruitUserAgent({
    userId: 'identity_user_check', agentFamilyId: 'ppt', commandId: 'check:identity-user:recruit-second-ppt',
  }).instance;
  assert.notEqual(additionalPptInstance.id, secondPptInstance.id, 'one user may recruit multiple instances of the same Agent family');
  assert.equal(additionalPptInstance.agentFamilyId, secondPptInstance.agentFamilyId);
  assert.equal(additionalPptInstance.familyInstanceSeq, secondPptInstance.familyInstanceSeq + 1);
  assert.notEqual(additionalPptInstance.displayName, secondPptInstance.displayName);
  const personalSkillCandidate = runtime.store.createPersonalSkillVersion({
    agentInstanceId: secondPptInstance.id,
    overlayText: '## Personal Rules\n- Prefer concise evidence tables.',
  });
  const activatedPersonalSkill = runtime.store.activatePersonalSkillVersion({
    agentInstanceId: secondPptInstance.id,
    skillVersionId: personalSkillCandidate.id,
  });
  assert.equal(activatedPersonalSkill.personalSkillVersion.status, 'active');
  assert.ok(activatedPersonalSkill.effectiveSkill.includes('JANUS PERSONAL OVERLAY START'));
  assert.equal(activatedPersonalSkill.effectiveSkillHash, sha256Text(activatedPersonalSkill.effectiveSkill));
  const updatedSecondMemory = runtime.store.appendMemoryDocumentVersion({
    memoryDocumentId: secondMemory0[0].id,
    content: `${secondMemory0[0].content}\n## User Check\n- Isolated preference.\n`,
    sourceKind: 'check',
    reviewStatus: 'approved',
  });
  assert.notEqual(updatedSecondMemory.currentVersionId, secondMemory0[0].currentVersionId);
  assert.equal(runtime.store.getMemoryDocument(adminMemory0[0].id).content, adminMemory0[0].content, 'editing one user memory must not mutate another user memory');
  runtime.store.updateUserAgentConsents({
    agentInstanceId: secondPptInstance.id,
    syncEnabled: true,
    clusterContributionConsent: true,
  });
  assert.equal(runtime.evolutionCoordinators.cluster.eligibleSubjects({ minContributors: 1 }).some((item) => item.agentFamilyId === 'ppt'), false, 'unbound users must not contribute to cluster evolution');
  const boundIdentityUser = runtime.auth.importCloudUser({
    id: 'remote_identity_user_check',
    email: 'identity.user@check.local',
    displayName: 'Identity User Cloud',
    emailVerified: true,
  });
  assert.equal(boundIdentityUser.id, 'identity_user_check', 'cloud binding must preserve the local primary key');
  assert.equal(boundIdentityUser.remoteId, 'remote_identity_user_check');
  assert.equal(runtime.evolutionCoordinators.cluster.eligibleSubjects({ minContributors: 1 }).some((item) => item.agentFamilyId === 'ppt'), false,
    'desktop cluster coordinator must remain read-only even for bound users');
  runtime.store.upsertAgentFamily({ id: 'identity_overlay_agent', name: 'Identity Overlay Agent', departmentId: 'general', role: 'agent', routable: true });
  const overlayBaseVersion = runtime.store.upsertAgentVersion({
    agent: { id: 'identity_overlay_agent', name: 'Identity Overlay Agent', departmentId: 'general', role: 'agent', baseSkill: '# Base Skill\n\n- Base behavior.\n' },
    memoryTemplate: '# Agent Memory: identity_overlay_agent\n\n## Stable Learnings\n- None yet.\n',
    sourceBundleId: 'check_bundle',
  });
  assert.throws(() => runtime.db.prepare('UPDATE agent_versions SET base_skill_content = ? WHERE id = ?')
    .run('# Mutable Skill\n', overlayBaseVersion.id), /immutable/, 'market Agent versions must be immutable');
  const overlayInstance = runtime.store.recruitUserAgent({
    userId: 'local_admin', agentFamilyId: 'identity_overlay_agent', commandId: 'check:local-admin:recruit-overlay',
  }).instance;
  const isolatedOverlayInstance = runtime.store.recruitUserAgent({
    userId: 'identity_user_check', agentFamilyId: 'identity_overlay_agent', commandId: 'check:identity-user:recruit-overlay',
  }).instance;
  assert.equal(overlayInstance.personalEvolutionConsent, true, 'personal evolution must default on');
  assert.equal(overlayInstance.clusterContributionConsent,true,'active synchronized Agents must participate in cluster evolution');
  assert.equal(overlayInstance.personalSkillAutoActivate, false, 'personal Skill activation must be independently opt-in');
  const firstOverlay = runtime.store.createPersonalSkillVersion({ agentInstanceId: overlayInstance.id, overlayText: '## Personal Rules\n- Prefer concise output.' });
  const firstActivation = runtime.store.activatePersonalSkillVersion({ agentInstanceId: overlayInstance.id, skillVersionId: firstOverlay.id });
  assert.match(firstActivation.effectiveSkill, /JANUS PERSONAL OVERLAY START/);
  assert.match(firstActivation.effectiveSkill, /Prefer concise output/);
  assert.equal(firstActivation.effectiveSkillHash, runtime.store.resolveUserAgent({ userId: 'local_admin', agentFamilyId: 'identity_overlay_agent' }).effectiveSkillHash);
  const secondOverlay = runtime.store.createPersonalSkillVersion({ agentInstanceId: overlayInstance.id, overlayText: '## Personal Rules\n- Prefer evidence-first output.' });
  runtime.store.activatePersonalSkillVersion({ agentInstanceId: overlayInstance.id, skillVersionId: secondOverlay.id });
  assert.equal(runtime.db.prepare('SELECT status FROM user_agent_skill_versions WHERE id = ?').get(firstOverlay.id).status, 'archived');
  assert.equal(runtime.db.prepare('SELECT status FROM user_agent_skill_versions WHERE id = ?').get(secondOverlay.id).status, 'active');
  assert.equal(runtime.store.resolveEffectiveSkill({ agentInstanceId: isolatedOverlayInstance.id }).personalSkillVersion, null, 'personal overlays must not cross users');
  const overlayMemory = runtime.store.ensureDefaultMemoryDocument({ agentInstanceId: overlayInstance.id });
  const isolatedOverlayMemory = runtime.store.ensureDefaultMemoryDocument({ agentInstanceId: isolatedOverlayInstance.id });
  assert.equal(overlayMemory.allowPersonalEvolution, true, 'new Memory must opt into evolution by default');
  assert.equal(overlayMemory.allowClusterEvolution,true,'active synchronized Agent Memory must participate in cluster evolution');
  const editedMemory = runtime.store.appendMemoryDocumentVersion({
    memoryDocumentId: overlayMemory.id,
    content: '# Agent Memory: identity_overlay_agent\n\n## Stable Learnings\n- User prefers evidence-first answers.\n',
    sourceKind: 'check_user_edit',
    reviewStatus: 'approved',
  });
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM memory_document_versions WHERE memory_document_id = ?').get(overlayMemory.id).count, 2);
  assert.match(editedMemory.content, /evidence-first/);
  assert.doesNotMatch(runtime.store.getMemoryDocument(isolatedOverlayMemory.id).content, /evidence-first/);
  runtime.store.updateUserAgentConsents({ agentInstanceId: overlayInstance.id, personalEvolutionConsent: true, clusterContributionConsent: true });
  runtime.store.updateMemoryEvolutionPermissions({ memoryDocumentId: overlayMemory.id, allowPersonalEvolution: true, allowClusterEvolution: false });
  assert.equal(runtime.store.getUserAgentInstance(overlayInstance.id).personalEvolutionConsent, true);
  assert.equal(runtime.store.getMemoryDocument(overlayMemory.id).allowPersonalEvolution, true);
  assert.equal(runtime.store.getMemoryDocument(overlayMemory.id).allowClusterEvolution,true,'cluster Memory participation remains mandatory while the Agent is active and synchronized');
  runtime.store.updateUserAgentConsents({ agentInstanceId: overlayInstance.id, clusterContributionConsent: false, personalSkillAutoActivate: false });
  assert.equal(runtime.store.getUserAgentInstance(overlayInstance.id).personalEvolutionConsent, true, 'changing cluster consent must preserve personal consent');
  assert.equal(runtime.store.getUserAgentInstance(overlayInstance.id).clusterContributionConsent,true,'cluster participation cannot be revoked while the Agent remains active and synchronized');
  const beforeRollbackVersionCount = runtime.db.prepare('SELECT COUNT(*) AS count FROM memory_document_versions WHERE memory_document_id = ?').get(overlayMemory.id).count;
  runtime.db.exec(`CREATE TRIGGER check_memory_version_rollback BEFORE UPDATE OF current_version_id ON memory_documents
    WHEN NEW.id = '${overlayMemory.id}' BEGIN SELECT RAISE(ABORT, 'forced memory update failure'); END`);
  assert.throws(() => runtime.store.appendMemoryDocumentVersion({ memoryDocumentId: overlayMemory.id, content: '# Must roll back\n' }), /forced memory update failure/);
  runtime.db.exec('DROP TRIGGER check_memory_version_rollback');
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM memory_document_versions WHERE memory_document_id = ?').get(overlayMemory.id).count, beforeRollbackVersionCount, 'failed Memory updates must roll back inserted versions');
  const personalScopeRun = runtime.store.createScopedEvolutionRun({
    scope: 'personal',
    userId: 'local_admin',
    agentInstanceId: localAdminPptInstance.id,
    agentFamilyId: 'ppt',
    departmentId: 'ppt_department',
  });
  const clusterScopeRun = runtime.store.createScopedEvolutionRun({
    scope: 'cluster',
    agentFamilyId: 'ppt',
    departmentId: 'ppt_department',
    cohortKey: 'check-cohort',
  });
  assert.equal(runtime.db.prepare('SELECT evolution_scope FROM evolution_runs WHERE id = ?').get(personalScopeRun).evolution_scope, 'personal');
  assert.equal(runtime.db.prepare('SELECT evolution_scope FROM evolution_runs WHERE id = ?').get(clusterScopeRun).evolution_scope, 'cluster');
  assert.throws(() => runtime.store.createScopedEvolutionRun({ scope: 'personal', agentFamilyId: 'ppt' }), /requires userId/);
  assert.throws(() => runtime.store.createScopedEvolutionRun({
    scope: 'personal', userId: 'identity_user_check', agentInstanceId: localAdminPptInstance.id, agentFamilyId: 'ppt',
  }), /does not match/);
  assert.throws(() => runtime.db.prepare(`INSERT INTO evolution_runs (
    id, agent_id, agent_family_id, evolution_scope, user_id, user_agent_instance_id, cohort_key
  ) VALUES ('invalid_personal_identity_check', 'ppt', 'ppt', 'personal', 'identity_user_check', ?, '')`)
    .run(localAdminPptInstance.id), /identity mismatch/);
  assert.throws(() => runtime.db.prepare(`INSERT INTO evolution_runs (
    id, agent_id, agent_family_id, evolution_scope, user_id, user_agent_instance_id, cohort_key
  ) VALUES ('invalid_cluster_check', 'ppt', 'ppt', 'cluster', 'local_admin', '', 'cohort')`).run(), /invalid cluster evolution identity/);
  assert.throws(() => runtime.db.prepare("UPDATE user_agent_instances SET user_id = 'missing_identity_user' WHERE id = ?")
    .run(overlayInstance.id), /user does not exist/);
  assert.throws(() => runtime.db.prepare("UPDATE user_agent_skill_versions SET base_agent_version_id = 'missing_agent_version' WHERE id = ?")
    .run(secondOverlay.id), /base Agent version does not exist/);
  assert.throws(() => runtime.db.prepare('UPDATE memory_documents SET user_agent_instance_id = ? WHERE id = ?')
    .run(isolatedOverlayInstance.id, overlayMemory.id), /Memory document Agent identity does not exist/);
  assert.throws(() => runtime.db.prepare("UPDATE memory_document_versions SET memory_document_id = 'missing_memory_document' WHERE id = ?")
    .run(editedMemory.currentVersionId), /Memory document version owner does not exist/);
  runtime.db.prepare('DELETE FROM evolution_runs WHERE id IN (?, ?)').run(personalScopeRun, clusterScopeRun);
  runtime.db.prepare(`INSERT INTO sessions (
    id, user_id, title, department_id, agent_id, agent_instance_id
  ) VALUES ('lazy_identity_session', 'local_admin', 'Lazy identity session', 'general', 'identity_overlay_agent', '')`).run();
  assert.equal(runtime.store.getSession('lazy_identity_session').agentInstanceId, '', 'reading an old session must not mutate or create Agent identity state');
  runtime.db.prepare(`INSERT INTO sessions (
    id, user_id, title, department_id, agent_id, agent_instance_id
  ) VALUES ('unrecruited_legacy_session', 'local_admin', 'Unrecruited legacy session', 'general', 'quota_employee_11', '')`).run();
  runtime.db.prepare(`INSERT INTO task_runs (
    id, owner_user_id, title, prompt, department_id, lead_agent_id, lead_agent_instance_id
  ) VALUES ('legacy_identity_task', 'local_admin', 'Legacy identity task', 'backfill', 'general', 'identity_overlay_agent', '')`).run();
  runtime.db.prepare(`INSERT INTO task_nodes (
    id, task_run_id, title, objective, department_id, agent_id, agent_instance_id
  ) VALUES ('legacy_identity_node', 'legacy_identity_task', 'Legacy node', 'backfill', 'general', 'identity_overlay_agent', '')`).run();
  runtime.db.prepare(`INSERT INTO memory_entries (
    id, scope, owner_id, user_id, department_id, agent_id, agent_instance_id, memory_document_id,
    memory_type, content, source_id
  ) VALUES ('legacy_identity_memory', 'agent', 'identity_overlay_agent', 'local_admin', 'general', 'identity_overlay_agent', '', '',
    'stable_learning', 'Legacy backfill memory', 'legacy_identity_memory')`).run();
  runtime.db.prepare(`INSERT INTO agent_performance_reviews (
    id, department_id, agent_id, user_id, agent_family_id, user_agent_instance_id
  ) VALUES ('legacy_identity_review', 'general', 'identity_overlay_agent', 'local_admin', 'identity_overlay_agent', '')`).run();
  const localAdminInstanceCountBeforeBackfill = runtime.store.listUserAgentInstances({ userId: 'local_admin' }).length;
  const identityBackfill = runtime.store.backfillAgentInstanceReferences();
  assert.equal(identityBackfill.creationPolicy, 'existing_only');
  assert.ok(identityBackfill.unresolvedSessions >= 1);
  assert.equal(runtime.db.prepare("SELECT agent_instance_id FROM sessions WHERE id = 'unrecruited_legacy_session'").get().agent_instance_id, '', 'compatibility backfill must not recruit a missing employee');
  assert.equal(runtime.store.listUserAgentInstances({ userId: 'local_admin' }).length, localAdminInstanceCountBeforeBackfill);
  assert.equal(runtime.db.prepare("SELECT lead_agent_instance_id FROM task_runs WHERE id = 'legacy_identity_task'").get().lead_agent_instance_id, overlayInstance.id);
  assert.equal(runtime.db.prepare("SELECT agent_instance_id FROM task_nodes WHERE id = 'legacy_identity_node'").get().agent_instance_id, overlayInstance.id);
  assert.equal(runtime.db.prepare("SELECT agent_instance_id FROM memory_entries WHERE id = 'legacy_identity_memory'").get().agent_instance_id, overlayInstance.id);
  assert.equal(runtime.db.prepare("SELECT memory_document_id FROM memory_entries WHERE id = 'legacy_identity_memory'").get().memory_document_id, overlayMemory.id);
  assert.equal(runtime.db.prepare("SELECT user_agent_instance_id FROM agent_performance_reviews WHERE id = 'legacy_identity_review'").get().user_agent_instance_id, overlayInstance.id);
  assert.equal(runtime.evolutionCoordinators.cluster.eligibleSubjects({ minContributors: 1 }).some((item) => item.agentFamilyId === 'identity_overlay_agent'), false, 'unbound users must not contribute to cluster evolution even when a local consent bit is present');
  const boundClusterInstance = runtime.store.recruitUserAgent({
    userId: 'stable_local_user', agentFamilyId: 'identity_overlay_agent', commandId: 'check:stable-user:recruit-overlay',
  }).instance;
  const boundClusterMemory = runtime.store.ensureDefaultMemoryDocument({ agentInstanceId: boundClusterInstance.id });
  runtime.store.updateUserAgentConsents({ agentInstanceId: boundClusterInstance.id, syncEnabled: true, clusterContributionConsent: true });
  runtime.store.updateMemoryEvolutionPermissions({ memoryDocumentId: boundClusterMemory.id, allowClusterEvolution: true });
  const clusterSubject = runtime.evolutionCoordinators.cluster.eligibleSubjects({ minContributors: 1 }).find((item) => item.agentFamilyId === 'identity_overlay_agent');
  assert.equal(clusterSubject, undefined, 'desktop cluster coordination must not stage local cohort work');
  runtime.store.updateUserAgentConsents({ agentInstanceId: overlayInstance.id, personalEvolutionConsent: true, personalSkillAutoActivate: false });
  runtime.store.updateMemoryEvolutionPermissions({ memoryDocumentId: overlayMemory.id, allowPersonalEvolution: true });
  for (let sessionIndex = 0; sessionIndex < 2; sessionIndex += 1) {
    const session = runtime.store.createSession({
      title: `Personal evolution evidence ${sessionIndex}`, departmentId: 'general', agentId: 'identity_overlay_agent',
      agentInstanceId: overlayInstance.id, userId: 'local_admin',
    });
    for (let messageIndex = 0; messageIndex < 4; messageIndex += 1) {
      runtime.store.addMessage({
        sessionId: session.id, role: messageIndex % 2 ? 'assistant' : 'user', agentId: 'identity_overlay_agent',
        agentInstanceId: overlayInstance.id, departmentId: 'general',
        content: messageIndex === 0 && sessionIndex === 0
          ? 'Please improve evidence checks for test.user@example.com and /home/private/project/data.txt.'
          : messageIndex % 2 ? 'Use an evidence-first check and verify the final artifact.' : 'The workflow failed and needs a reusable procedure.',
      });
    }
  }
  assert.equal(sanitizeEvidence('email test.user@example.com path /home/private/file.txt').text.includes('test.user@example.com'), false);
  const localProposalCountBeforeCloudRequest = runtime.store.listPersonalEvolutionProposals({ userId: 'local_admin' }).length;
  const personalProposal = await runtime.runPersonalEvolution({ agentInstanceId: overlayInstance.id, dryRun: true });
  assert.equal(personalProposal.status, 'unavailable');
  assert.equal(personalProposal.code, 'cloud_not_configured');
  assert.equal(runtime.store.listPersonalEvolutionProposals({ userId: 'local_admin' }).length, localProposalCountBeforeCloudRequest,
    'desktop cloud request must not create a local Proposal');
  assert.equal(runtime.db.prepare('PRAGMA table_info(personal_evolution_proposal_evidence)').all().some((row) => row.name === 'content'), false, 'personal evidence audit rows must not copy raw content');
  for (let sessionIndex = 0; sessionIndex < 3; sessionIndex += 1) {
    const session = runtime.store.createSession({
      title: `Personal auto evidence ${sessionIndex}`, departmentId: 'general', agentId: 'identity_overlay_agent',
      agentInstanceId: overlayInstance.id, userId: 'local_admin',
    });
    for (let messageIndex = 0; messageIndex < 7; messageIndex += 1) {
      runtime.store.addMessage({
        sessionId: session.id, role: messageIndex % 2 ? 'assistant' : 'user', agentId: 'identity_overlay_agent',
        agentInstanceId: overlayInstance.id, departmentId: 'general',
        content: messageIndex % 2 ? 'Apply the evidence-first workflow and verify the artifact.' : 'Repeated failure requires an evidence-backed workflow.',
      });
    }
  }
  const automaticProposal = await runtime.runPersonalEvolution({ agentInstanceId: overlayInstance.id, trigger: 'auto', dryRun: true });
  assert.equal(automaticProposal.status, 'unavailable');
  assert.equal(automaticProposal.code, 'cloud_not_configured');

  const providerBaselineSkill = runtime.store.createPersonalSkillVersion({
    agentInstanceId: overlayInstance.id,
    overlayText: '## Existing Personal Rule\n- LEGACY_ACTIVE_ONLY_MARKER must appear only in the baseline replay.',
  });
  runtime.store.activatePersonalSkillVersion({ agentInstanceId: overlayInstance.id, skillVersionId: providerBaselineSkill.id });
  for (let sessionIndex = 0; sessionIndex < 2; sessionIndex += 1) {
    const session = runtime.store.createSession({
      title: `Personal provider evidence ${sessionIndex}`, departmentId: 'general', agentId: 'identity_overlay_agent',
      agentInstanceId: overlayInstance.id, userId: 'local_admin',
    });
    const providerEvidenceContext = runtime.store.ensureAgentContextSpace({
      userId: 'local_admin', agentInstanceId: overlayInstance.id, contextKind: 'relationship',
      relationshipUserId: `provider-evidence-${sessionIndex}`,
    });
    runtime.store.switchAgentContext({
      deviceId: runtime.store.contextDeviceId(), userId: 'local_admin', agentInstanceId: overlayInstance.id,
      contextSpaceId: providerEvidenceContext.id,
    });
    for (let messageIndex = 0; messageIndex < 4; messageIndex += 1) {
      runtime.store.addMessage({
        sessionId: session.id, role: messageIndex % 2 ? 'assistant' : 'user', agentId: 'identity_overlay_agent',
        agentInstanceId: overlayInstance.id, departmentId: 'general',
        content: messageIndex % 2 ? 'Verify the evidence and final artifact.' : 'A reusable evidence verification procedure is required.',
      });
    }
  }
  const providerCalls = [];
  const providerCoordinator = new PersonalEvolutionCoordinator({
    store: runtime.store,
    root: tmp,
    enabled: true,
    executeModel: async ({ role, prompt }) => {
      providerCalls.push({ role, prompt });
      if (role === 'personal-evolution-proposer') {
        const diagnosisText = String(prompt).match(/Diagnosis:\n([\s\S]*?)\n\nSanitized evidence:/)?.[1] || '{}';
        const diagnostic = JSON.parse(diagnosisText);
        return JSON.stringify({
          summary: 'Provider-backed personal workflow improvement.',
          overlay_text: `## Provider Personal Procedure\n- ${diagnostic.recommendation || diagnostic.primary_layer || 'Use evidence verification.'}`,
          memory_operations: [{
            memory_document_id: overlayMemory.id,
            section_name: 'Workflow Notes',
            operation_type: 'add',
            target_item_hash: '',
            proposed_text: 'Verify reusable evidence and the final artifact before delivery.',
            rationale: 'The sanitized evidence shows a recurring verification need.',
          }],
          eval_cases: [{ input: 'Complete a similar workflow.', expected: 'verify evidence artifact reusable workflow' }],
          risks: ['Avoid overfitting and preserve private data boundaries.'],
        });
      }
      if (role === 'personal-evolution-baseline') return 'generic baseline response';
      if (role === 'personal-evolution-candidate') return 'verify evidence artifact reusable workflow';
      throw new Error(`Unexpected personal evolution Provider role: ${role}`);
    },
  });
  const providerProposal = await providerCoordinator.run({ userId: 'local_admin', agentInstanceId: overlayInstance.id });
  assert.equal(providerProposal.status, 'ready', JSON.stringify(providerProposal.gate));
  assert.deepEqual(providerCalls.map((item) => item.role), [
    'personal-evolution-proposer', 'personal-evolution-baseline', 'personal-evolution-candidate',
  ]);
  assert.match(providerCalls.find((item) => item.role === 'personal-evolution-baseline').prompt, /LEGACY_ACTIVE_ONLY_MARKER/);
  assert.doesNotMatch(providerCalls.find((item) => item.role === 'personal-evolution-candidate').prompt, /LEGACY_ACTIVE_ONLY_MARKER/);
  assert.doesNotMatch(
    runtime.db.prepare('SELECT effective_skill_content FROM user_agent_skill_versions WHERE id = ?').get(providerProposal.candidatePersonalSkillVersionId).effective_skill_content,
    /LEGACY_ACTIVE_ONLY_MARKER/,
    'candidate evaluation must use base Skill plus the candidate Overlay, not stack onto the active Overlay',
  );
  const earlyLocalRetry = await providerCoordinator.run({
    userId: 'local_admin', agentInstanceId: overlayInstance.id, force: true,
  });
  assert.equal(earlyLocalRetry.reason, 'personal_evolution_not_due', 'local compatibility mode force must not bypass the 24-hour cadence');

  await assert.rejects(() => runtime.rollbackPersonalMemory({ memoryDocumentId: overlayMemory.id, targetVersionId: '' }));

  for (let sessionIndex = 0; sessionIndex < 2; sessionIndex += 1) {
    const session = runtime.store.createSession({
      title: `Unsafe provider evidence ${sessionIndex}`, departmentId: 'general', agentId: 'identity_overlay_agent',
      agentInstanceId: overlayInstance.id, userId: 'local_admin',
    });
    const unsafeEvidenceContext = runtime.store.ensureAgentContextSpace({
      userId: 'local_admin', agentInstanceId: overlayInstance.id, contextKind: 'relationship',
      relationshipUserId: `unsafe-evidence-${sessionIndex}`,
    });
    runtime.store.switchAgentContext({
      deviceId: runtime.store.contextDeviceId(), userId: 'local_admin', agentInstanceId: overlayInstance.id,
      contextSpaceId: unsafeEvidenceContext.id,
    });
    for (let messageIndex = 0; messageIndex < 4; messageIndex += 1) {
      runtime.store.addMessage({
        sessionId: session.id, role: messageIndex % 2 ? 'assistant' : 'user', agentId: 'identity_overlay_agent',
        agentInstanceId: overlayInstance.id, departmentId: 'general',
        content: messageIndex % 2 ? 'Keep the reusable workflow private.' : 'Generate another narrow workflow proposal.',
      });
    }
  }
  const unsafeProviderCoordinator = new PersonalEvolutionCoordinator({
    store: runtime.store,
    root: tmp,
    enabled: true,
    executeModel: async ({ role }) => {
      assert.equal(role, 'personal-evolution-proposer');
      return JSON.stringify({
        summary: 'Contact leak@example.com about /private/project.txt or https://private.example/resource.',
        overlay_text: '## Unsafe Rule\n- password=do not store this entire phrase\n- inspect /mnt/private/project.txt',
        memory_operations: [{
          memory_document_id: overlayMemory.id,
          section_name: 'Workflow Notes',
          operation_type: 'add',
          target_item_hash: '',
          proposed_text: 'Read /private/project.txt.',
          rationale: 'Send to leak@example.com.',
        }],
        eval_cases: [{ input: 'Open /home/private/project.txt', expected: 'email leak@example.com' }],
        risks: ['Use sk-abcdefghijklmnop only in the private environment.'],
      });
    },
  });
  runtime.store.updatePersonalEvolutionInstanceState(overlayInstance.id, { nextEligibleAt: '2000-01-01T00:00:00.000Z' });
  const unsafeProviderProposal = await unsafeProviderCoordinator.run({ userId: 'local_admin', agentInstanceId: overlayInstance.id });
  assert.equal(unsafeProviderProposal.status, 'failed');
  assert.ok(unsafeProviderProposal.privacyReport.flagCount > 0);
  assert.doesNotMatch(
    JSON.stringify({
      proposalMarkdown: unsafeProviderProposal.proposalMarkdown,
      summary: unsafeProviderProposal.summary,
      proposedOverlayText: unsafeProviderProposal.proposedOverlayText,
      memoryOperations: unsafeProviderProposal.memoryOperations,
    }),
    /leak@example\.com|\/private\/project\.txt|\/mnt\/private\/project\.txt|private\.example|do not store this entire phrase|sk-abcdefghijklmnop/,
    'rejected Provider output must be redacted before it is persisted',
  );
  await assert.rejects(() => runtime.rollbackPersonalSkill({ agentInstanceId: overlayInstance.id, targetSkillVersionId: '' }),
    (error) => error.code === 'cloud_authority_required');
  assert.equal(runtime.store.getUserAgentInstance(overlayInstance.id).activePersonalSkillVersionId, providerBaselineSkill.id,
    'legacy local Skill history must remain read-only under permanent cloud authority');
  const goalSession = runtime.store.createSession({ title: 'Native goal mirror', departmentId: 'general' });
  const mirroredGoalSession = runtime.store.updateSession(goalSession.id, {
    goal: { objective: 'Finish the migration and keep tests green', status: 'active', tokensUsed: 12, tokenBudget: 100, timeUsedSeconds: 3 },
  });
  assert.equal(mirroredGoalSession.goal.objective, 'Finish the migration and keep tests green');
  assert.equal(mirroredGoalSession.goal.status, 'active');
  assert.equal('tokenBudget' in mirroredGoalSession.goal, false);
  assert.equal(runtime.db.prepare('SELECT goal_token_budget FROM sessions WHERE id=?').get(goalSession.id).goal_token_budget, 0);
  const seededPpt = runtime.org.agent('ppt');
  assert.equal(seededPpt.evolutionSummary.seedProposalCount, 0, 'fresh installs must start without bundled evolution history');
  assert.equal(seededPpt.evolutionSummary.proposalCount, 0, 'fresh installs must start without runtime evolution history');
  const holdout = runtime.evolution.recordHoldoutEval({
    agentId: 'ppt',
    departmentId: 'ppt_department',
    caseText: 'Hidden artifact verification holdout',
    inputText: 'Generate a PPTX and verify the artifact.',
    expectedText: 'The editable PPTX exists and opens before delivery.',
  });
  assert.ok(runtime.store.evolutionOverview().holdoutEvals.some((item) => item.id === holdout.id));
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const agentUpdateFetchCalls = [];
  const agentUpdateService = createAgentBundleService({
    root: path.join(tmp, 'agent-update-network'),
    appVersion: '0.1.0',
    autoApply: false,
    fetchImpl: async (url) => {
      agentUpdateFetchCalls.push(String(url));
      return new Response(JSON.stringify({
        manifest: {
          version: '0.1.1',
          artifacts: [{
            kind: 'agent_bundle',
            bundleId: 'agents-network-check',
            releaseVersion: '0.1.1',
            minAppVersion: '0.1.0',
            url: '/v1/releases/artifacts/agents%2F0.1.1%2Fagents-network-check.json',
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const agentUpdateNetworkStatus = await agentUpdateService.checkNow();
  assert.equal(agentUpdateNetworkStatus.available, true);
  assert.equal(agentUpdateNetworkStatus.candidate.artifact.releaseVersion, '0.1.1');
  assert.equal(agentUpdateFetchCalls.length, 1);
  assert.match(agentUpdateFetchCalls[0], /\/v1\/releases\/latest\?/);
  assert.match(agentUpdateFetchCalls[0], /kind=agent_bundle/);
  const mainProcessNetworkSource = readFileSync(path.join(process.cwd(), 'src/main/main.js'), 'utf8');
  assert.ok(mainProcessNetworkSource.includes('electronSession.defaultSession.fetch.bind'));
  const unifiedReleaseHome = path.join(tmp, 'unified-release-home');
  assert.equal(unifiedAgentReleaseVersion('0.2.0'), '0.2.0');
  assert.ok(readFileSync(path.join(process.cwd(), 'src/cloud/releasePublisher.js'), 'utf8').includes('artifact.releaseVersion === releaseVersion'));
  assert.deepEqual(unifiedDesktopReleaseReadiness(unifiedReleaseHome, '0.2.0'), {
    ready: false,
    version: '0.2.0',
    available: [],
    missing: ['windows', 'macos', 'linux'],
  });
  for (const [platform, feed] of [['windows', 'latest.yml'], ['macos', 'latest-mac.yml'], ['linux', 'latest-linux.yml']]) {
    const directory = path.join(unifiedReleaseHome, 'releases', platform, '0.2.0');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, feed), 'version: 0.2.0\n');
  }
  assert.deepEqual(unifiedDesktopReleaseReadiness(unifiedReleaseHome, '0.2.0'), {
    ready: true,
    version: '0.2.0',
    available: ['windows', 'macos', 'linux'],
    missing: [],
  });
  assert.equal(normalizeReleaseArtifactPath('0.1.5/Janus Setup 0.1.5.exe'), '0.1.5/Janus Setup 0.1.5.exe');
  assert.equal(normalizeReleaseArtifactPath('../private-key.pem'), '');
  const versionedFeed = versionReleaseManifest('files:\n  - url: Janus Setup 0.1.5.exe\npath: Janus Setup 0.1.5.exe\n', '0.1.5');
  assert.ok(versionedFeed.includes('url: 0.1.5/Janus Setup 0.1.5.exe'));
  assert.ok(versionedFeed.includes('path: 0.1.5/Janus Setup 0.1.5.exe'));
  assert.equal(packageJson.desktopName, 'Janus');
  assert.equal(packageJson.main, 'src/main/main.js');
  assert.equal(packageJson.build.appId, 'local.janus.desktop');
  assert.equal(packageJson.build.productName, 'Janus');
  assert.equal(packageJson.build.icon, 'assets/icons/icon.png');
  assert.match(packageJson.dependencies['@openai/codex'], /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Codex CLI must be pinned exactly for reproducible desktop packages');
  assert.equal(packageJson.dependencies['electron-updater'], '^6.8.9');
  for (const requiredFile of ['src/**/*', 'network/**/*', 'assets/**/*', 'package.json']) {
    assert.ok(packageJson.build.files.includes(requiredFile), `missing build file rule ${requiredFile}`);
  }
  assert.equal(packageJson.build.publish[0].provider, 'generic');
  assert.equal(packageJson.build.publish[0].url, 'http://your-janus.example/janus/releases');
  assert.deepEqual(packageJson.build.linux.target, ['AppImage']);
  assert.equal(packageJson.build.linux.icon, 'assets/icons');
  assert.deepEqual(packageJson.build.mac.target, ['dmg', 'zip']);
  assert.equal(packageJson.build.mac.category, 'public.app-category.developer-tools');
  assert.equal(packageJson.build.mac.icon, 'assets/icons/icon.icns');
  assert.deepEqual(packageJson.build.win.target, ['nsis']);
  assert.equal(packageJson.build.win.icon, 'assets/icons/icon.ico');
  assert.equal(packageJson.scripts.dev, 'node scripts/dev.mjs');
  assert.equal(packageJson.scripts.start, 'node scripts/dev.mjs');
  assert.equal(packageJson.scripts['dev:linux'], 'node scripts/dev.mjs --dev-profile=linux');
  assert.equal(packageJson.scripts['dev:mac'], 'node scripts/dev.mjs --dev-profile=macos');
  assert.equal(packageJson.scripts['dev:win'], 'node scripts/dev.mjs --dev-profile=windows');
  assert.equal(packageJson.scripts['sync:codex-cli'], 'node scripts/sync_codex_cli.mjs --sync');
  assert.equal(packageJson.scripts['check:codex-cli'], 'node scripts/sync_codex_cli.mjs --check');
  assert.equal(packageJson.scripts['test:logging'], 'node scripts/application_logging_smoke.mjs');
  assert.equal(packageJson.scripts.pack, undefined);
  assert.equal(packageJson.scripts.dist, undefined);
  assert.equal(packageJson.scripts['pack:linux'], 'electron-builder --dir --linux --x64 --config deploy/electron-builder.linux.cjs');
  assert.equal(packageJson.scripts['pack:linux:test'], 'electron-builder --dir --linux --x64 --config deploy/electron-builder.linux.test.cjs');
  assert.equal(packageJson.scripts['dist:linux'], 'electron-builder --linux AppImage --x64 --config deploy/electron-builder.linux.cjs');
  assert.equal(packageJson.scripts['pack:mac'], 'electron-builder --dir --mac --config deploy/electron-builder.macos.cjs');
  assert.equal(packageJson.scripts['pack:mac:test'], 'electron-builder --dir --mac --config deploy/electron-builder.macos.test.cjs');
  assert.equal(packageJson.scripts['pack:win'], 'electron-builder --dir --win --config deploy/electron-builder.windows.cjs');
  assert.equal(packageJson.scripts['pack:win:test'], 'electron-builder --dir --win --config deploy/electron-builder.windows.test.cjs');
  assert.equal(packageJson.scripts['dist:mac'], 'electron-builder --mac --config deploy/electron-builder.macos.cjs');
  assert.equal(packageJson.scripts['dist:win'], 'electron-builder --win --config deploy/electron-builder.windows.cjs');
  assert.equal(packageJson.scripts['dist:win:test'], 'node scripts/build_windows_test.mjs');
  assert.equal(packageJson.scripts['verify:win:test'], 'node scripts/verify_packaged_app.mjs --app-dir test-artifacts/windows/win-unpacked --expected-channel test --expected-cloud-url http://your-janus.example');
  assert.equal(packageJson.scripts['publish:release'], 'bash deploy/janus-release-desktop');
  assert.equal(packageJson.scripts['release:desktop'], 'bash deploy/janus-release-desktop');
  assert.equal(packageJson.scripts['release:test'], 'bash deploy/janus-release-desktop --test');
  assert.equal(packageJson.scripts['release:linux'], 'bash deploy/janus-release-linux');
  assert.equal(packageJson.scripts['release:linux:build'], 'bash deploy/janus-release-linux --build-only');
  assert.equal(packageJson.scripts['release:linux:test'], 'bash deploy/janus-release-linux --test');
  assert.equal(packageJson.scripts['release:linux:test:build'], 'bash deploy/janus-release-linux --test --build-only');
  assert.equal(packageJson.scripts['release:local'], undefined);
  assert.equal(packageJson.scripts['release:local:build'], undefined);
  assert.equal(packageJson.scripts['cloud:publish-linux'], undefined);
  assert.ok(existsSync(path.join(process.cwd(), 'deploy', 'janus-release-desktop')));
  assert.ok(existsSync(path.join(process.cwd(), 'deploy', 'janus-release-linux')));
  assert.equal(existsSync(path.join(process.cwd(), 'deploy', 'janus-release-local')), false);
  assert.equal(existsSync(path.join(process.cwd(), '.github', 'workflows', 'release.yml')), false);
  for (const devFile of [
    'dev/shared-architecture.md',
    'dev/linux/README.md',
    'dev/linux/env.example',
    'dev/linux/run-dev.sh',
    'dev/macos/README.md',
    'dev/macos/env.example',
    'dev/macos/run-dev.sh',
    'dev/windows/README.md',
    'dev/windows/env.example.ps1',
    'dev/windows/run-dev.ps1',
    'scripts/dev.mjs',
  ]) {
    assert.ok(existsSync(path.join(process.cwd(), devFile)), `missing platform dev file ${devFile}`);
  }
  assert.ok(existsSync(path.join(process.cwd(), 'dev/linux')));
  const devLauncherSource = readFileSync(path.join(process.cwd(), 'scripts/dev.mjs'), 'utf8');
  assert.ok(devLauncherSource.includes("process.platform === 'linux'"));
  assert.ok(devLauncherSource.includes("'--no-sandbox'"));
  assert.ok(devLauncherSource.includes("'xvfb-run'"));
  assert.ok(devLauncherSource.includes("GTK_IM_MODULE: env.GTK_IM_MODULE || 'ibus'"));
  assert.equal(devLauncherSource.includes("spawn('ibus-daemon'"), false, 'desktop startup must not replace the user input-method daemon');
  assert.equal(devLauncherSource.includes("spawnSync('ibus', ['engine', 'libpinyin']"), false, 'desktop startup must preserve the user-selected input engine');
  const mainProcessSource = readFileSync(path.join(process.cwd(), 'src/main/main.js'), 'utf8');
  const mainIpcSource = readFileSync(path.join(process.cwd(), 'src/main/ipc/registerIpcHandlers.js'), 'utf8');
  const mainDesktopSource = `${mainProcessSource}\n${mainIpcSource}`;
  assert.ok(mainProcessSource.includes('createUpdateService'));
  assert.ok(mainProcessSource.includes('waitForInitialUiLanguage().then(() => updateService.scheduleInitialCheck())'),
    'initial update checks must wait for the renderer language before showing native notifications');
  assert.ok(mainProcessSource.includes('app.requestSingleInstanceLock()'));
  assert.ok(mainProcessSource.includes("process.platform === 'win32'"));
  assert.ok(mainProcessSource.includes('app.disableHardwareAcceleration()'));
  assert.ok(mainProcessSource.includes('JANUS_ENABLE_HARDWARE_ACCELERATION'));
  assert.ok(mainProcessSource.includes("const windowsFallbackLocale = 'en-US'"));
  assert.ok(mainProcessSource.includes("app.commandLine.getSwitchValue('lang').trim()"));
  assert.ok(mainProcessSource.includes("app.commandLine.appendSwitch('lang', windowsFallbackLocale)"));
  assert.ok(mainProcessSource.includes('crashReporter.start({'));
  assert.ok(mainProcessSource.includes('initializeApplicationLogging({'));
  assert.ok(mainProcessSource.includes("process.on('uncaughtExceptionMonitor'"));
  assert.ok(mainProcessSource.includes("process.on('unhandledRejection'"));
  assert.ok(mainProcessSource.includes('const nativeWindowFrame = false'));
  assert.ok(mainProcessSource.includes('frame: nativeWindowFrame'));
  assert.ok(mainProcessSource.includes('codexConfigStatus(runtime.root)'));
  assert.ok(mainProcessSource.includes("webContents.on('render-process-gone'"));
  assert.ok(mainProcessSource.includes("recordDesktopDiagnostic(event, details"));
  assert.ok(mainProcessSource.includes('maxRecoveriesPerWindow = 2'));
  assert.ok(mainDesktopSource.includes('workspaceRoot,'));
  assert.ok(mainDesktopSource.includes('requiresRestart: false'));
  assert.equal(mainDesktopSource.includes('saveWorkspaceRoot('), false);
  assert.equal(mainDesktopSource.includes('configuredWorkspaceRoot('), false);
  const rendererEntrySource = readFileSync(path.join(process.cwd(), 'src/renderer/app.js'), 'utf8');
  const rendererCoreSource = readFileSync(path.join(process.cwd(), 'src/renderer/app/core/rendererApp.js'), 'utf8');
  const rendererMessageSendSource = readFileSync(path.join(process.cwd(), 'src/renderer/app/features/chat/messageSendController.js'), 'utf8');
  const rendererSessionNavigationSource = readFileSync(path.join(process.cwd(), 'src/renderer/app/features/navigation/sessionNavigationController.js'), 'utf8');
  const rendererAppSource = `${rendererEntrySource}\n${rendererCoreSource}\n${rendererMessageSendSource}\n${rendererSessionNavigationSource}`;
  assert.ok(rendererCoreSource.includes('const nativeWindowFrame = false'));
  assert.ok(rendererCoreSource.includes("reportRendererEvent('error', 'renderer-window-error'"));
  assert.ok(rendererCoreSource.includes('refreshApplicationLoggingStatus'));
  assert.ok(rendererCoreSource.includes("document.addEventListener('compositionstart'"));
  assert.ok(rendererCoreSource.includes('imeRenderDeferred = true'));
  assert.ok(rendererCoreSource.includes('ownerName: owner?.id ? organizationInviteUserName(owner) :'), 'organization share links must resolve owner names inside the renderer core');
  assert.equal(rendererCoreSource.includes('ownerName: owner?.id ? displayUserName(owner) :'), false, 'organization share-link generation must not call a view-local helper');
  const networkStylesSource = readFileSync(path.join(process.cwd(), 'src/renderer/styles/network.css'), 'utf8');
  assert.ok(networkStylesSource.includes('grid-template-rows: auto minmax(0, 1fr) auto'), 'organization dialogs must reserve a shrinkable scrolling body row');
  assert.ok(networkStylesSource.includes('.organization-action-body { display: grid; gap: 12px; min-height: 0;') && networkStylesSource.includes('overflow-y: auto; overscroll-behavior: contain;'), 'organization dialog bodies must remain vertically scrollable');
  assert.ok(rendererMessageSendSource.includes("input?.dataset?.imeComposing === 'true'"));
  const collaborationViewSource = readFileSync(path.join(process.cwd(), 'src/renderer/app/views/collaborationView.js'), 'utf8');
  const preloadSource = readFileSync(path.join(process.cwd(), 'src/preload/preload.js'), 'utf8');
  const navigationViewSource = readFileSync(path.join(process.cwd(), 'src/renderer/app/views/navigationView.js'), 'utf8');
  assert.equal(navigationViewSource.includes('janusAccountMenuAction'), false);
  assert.ok(
    rendererAppSource.includes('await window.janus.createProject({')
      || rendererAppSource.includes('await windowRef.janus.createProject({'),
  );
  assert.ok(rendererAppSource.includes('startNewProjectChat(project.id'));
  assert.ok(rendererAppSource.includes('interactionMode: outgoingInteractionMode'));
  const runtimeSource = readFileSync(path.join(process.cwd(), 'src/main/runtime.js'), 'utf8');
  const cloudSyncSource = readFileSync(path.join(process.cwd(), 'src/main/cloudSync.js'), 'utf8');
  const projectPromptContextSource = readFileSync(path.join(process.cwd(), 'src/main/modules/projects/application/promptContext.js'), 'utf8');
  assert.ok(projectPromptContextSource.includes('Active interaction mode: Goal'));
  assert.ok(projectPromptContextSource.includes('Active interaction mode: Plan'));
  assert.ok(projectPromptContextSource.includes('proactively call request_user_input'));
  assert.equal(runtimeSource.includes('planClarificationQuestions'), false);
  assert.equal(runtimeSource.includes('chatPlanForPresentation'), false);
  assert.ok(runtimeSource.includes('interactionMode: resolvedInteractionMode'));
  assert.ok(runtimeSource.includes("goalObjective: resolvedInteractionMode === 'goal' ? message : ''"));
  assert.ok(runtimeSource.includes('allowCollaboration: !resolvedInteractionMode'));
  assert.ok(runtimeSource.includes("triggerAutoSync('chat_failed'"));
  assert.ok(runtimeSource.includes('processEvents: visibleProcessEvents'));
  assert.ok(cloudSyncSource.includes('e.updated_at > ?'), 'streamed task event updates must advance the cloud cursor');
  assert.ok(cloudSyncSource.includes('sanitizeTaskEventForCloud'));
  assert.ok(cloudSyncSource.includes("privacyLevel === 'local_private'"));
  assert.ok(runtimeSource.includes('async retryTaskNode({ taskRunId, taskNodeId, options = {} })'));
  assert.ok(mainIpcSource.includes("ipcMain.handle('tasks:retry-node'"));
  assert.ok(preloadSource.includes("retryTaskNode: (payload) => ipcRenderer.invoke('tasks:retry-node', payload)"));
  assert.ok(rendererCoreSource.includes('async function retryFailedTaskNode('));
  assert.ok(collaborationViewSource.includes('data-retry-task-node='));
  const chatViewSource = readFileSync(path.join(process.cwd(), 'src/renderer/app/views/chatView.js'), 'utf8');
  assert.ok(chatViewSource.includes('文件和文件夹'));
  assert.ok(chatViewSource.includes('data-composer-interaction-mode="goal"'));
  assert.ok(chatViewSource.includes('data-composer-interaction-mode="plan"'));
  assert.ok(chatViewSource.includes('composer-interaction-indicator mode-plan'));
  assert.ok(chatViewSource.includes('chat-plan-card'));
  assert.ok(chatViewSource.includes('chat-plan-viewer'));
  assert.ok(chatViewSource.includes('chat-user-input-panel'));
  assert.equal(chatViewSource.includes('chat-user-input-overlay'), false);
  assert.ok(rendererMessageSendSource.includes("['goal', 'plan'].includes(state.interactionMode)"));
  assert.ok(rendererSessionNavigationSource.includes("['goal', 'plan'].includes(session?.interactionMode || session?.interaction_mode)"));
  assert.ok(rendererCoreSource.includes('function implementChatPlan'));
  assert.ok(runtimeSource.includes("resolvedInteractionMode === 'plan' && result.plan"));
  assert.equal(preloadSource.includes('publishSecretaryDispatchDraft'), false);
  assert.equal(preloadSource.includes('prepareCollaborationDraft'), false);
  assert.ok(
    chatViewSource.includes('class="ppt-primary-meta-controls"')
      && chatViewSource.includes("${renderPptTemplatePicker({ placement: 'footer' })}")
      && chatViewSource.includes("${renderPptStylePicker({ placement: 'footer' })}")
      && chatViewSource.includes('data-composer-meta-overflow-toggle'),
    'PPT composer footer must prioritize template/style and retain secondary controls through overflow',
  );
  assert.equal(chatViewSource.includes('ppt-audience-select'), false);
  assert.equal(chatViewSource.includes('ppt-duration-select'), false);
  assert.equal(chatViewSource.includes('ppt-depth-select'), false);
  assert.ok(readFileSync(path.join(process.cwd(), 'src/main/imageGeneration.js'), 'utf8').includes('outputRoot = root'));
  assert.ok(readFileSync(path.join(process.cwd(), 'src/main/pptRenderer.js'), 'utf8').includes('relocatePptResult'));
  assert.ok(readFileSync(path.join(process.cwd(), 'src/main/updates.js'), 'utf8').includes('../../network/clients/updateService.js'));
  assert.ok(readFileSync(path.join(process.cwd(), 'src/shared/desktopReleaseChannel.js'), 'utf8').includes('your-janus.example'));
  assert.ok(readFileSync(path.join(process.cwd(), 'network/clients/updateService.js'), 'utf8').includes("`${normalized}/macos`"));
  assert.ok(readFileSync(path.join(process.cwd(), 'network/clients/updateService.js'), 'utf8').includes("`${normalized}/windows`"));
  assert.ok(readFileSync(path.join(process.cwd(), 'network/clients/updateService.js'), 'utf8').includes("`${normalized}/linux`"));
  const desktopUpdateSource = readFileSync(path.join(process.cwd(), 'network/clients/updateService.js'), 'utf8');
  assert.ok(desktopUpdateSource.includes("platform === 'linux'"));
  assert.ok(desktopUpdateSource.includes('autoUpdater.quitAndInstall(false, true)'));
  assert.ok(desktopUpdateSource.includes('Install it when you are ready to restart.'));
  assert.equal(desktopUpdateSource.includes("message: 'Signed update verified. Installing automatically.'"), false);
  const updateRendererAppSource = readFileSync(path.join(process.cwd(), 'src/renderer/app/core/rendererApp.js'), 'utf8');
  assert.ok(updateRendererAppSource.includes('captureSettingsScrollState()'));
  assert.ok(updateRendererAppSource.includes('restoreSettingsScrollState(settingsScrollSnapshot)'));
  assert.ok(updateRendererAppSource.includes('updateCenterRenderKey(state.updates, state.agentUpdates)'));
  assert.ok(updateRendererAppSource.includes('maybeQueueAvailableUpdateAnnouncement()'));
  assert.ok(updateRendererAppSource.includes('saveUpdateAnnouncementPreferences'));
  assert.ok(readFileSync(path.join(process.cwd(), 'src/renderer/app/views/settingsView.js'), 'utf8').includes('install-update-btn'));
  const desktopUpdateSigningSource = readFileSync(path.join(process.cwd(), 'scripts/sign_desktop_update.mjs'), 'utf8');
  assert.ok(desktopUpdateSigningSource.includes('releaseAnnouncementForVersion'));
  assert.ok(desktopUpdateSigningSource.includes("'releaseNotes: |-'"));
  assert.ok(readFileSync(path.join(process.cwd(), 'cloud/src/server.mjs'), 'utf8').includes('createExpressNetworkMiddleware'));
  assert.ok(readFileSync(path.join(process.cwd(), 'src/cloud/server.js'), 'utf8').includes('sendFileResponse'));
  await assertNetworkClients(tmp);
  await assertCloudEvolutionAuthority(tmp);
  await assertCloudSyncLineage(tmp);
  const desktopReleaseScript = readFileSync(path.join(process.cwd(), 'deploy/janus-release-desktop'), 'utf8');
  assert.ok(desktopReleaseScript.includes('gh workflow run build-macos.yml'));
  assert.ok(desktopReleaseScript.includes('gh workflow run build-windows.yml'));
  assert.ok(desktopReleaseScript.includes('deploy/janus-release-linux'));
  assert.ok(desktopReleaseScript.includes('RELEASE_CHANNEL="test"'));
  assert.ok(desktopReleaseScript.includes('WORKFLOW_REF="main"'));
  assert.ok(desktopReleaseScript.includes('--version "$VERSION"'));
  assert.ok(desktopReleaseScript.includes('RELEASE_TAG="test-v$VERSION"'));
  assert.equal(desktopReleaseScript.includes('gh run watch'), false);
  const linuxReleaseScript = readFileSync(path.join(process.cwd(), 'deploy/janus-release-linux'), 'utf8');
  assert.ok(linuxReleaseScript.includes('electron-builder --linux AppImage --x64'));
  assert.ok(linuxReleaseScript.includes('--config.extraMetadata.version="$VERSION"'));
  assert.equal(linuxReleaseScript.includes('sync_codex_cli.mjs --sync'), false, 'release builds must not mutate the committed Codex dependency');
  assert.equal(linuxReleaseScript.includes('.deb'), false);
  assert.ok(linuxReleaseScript.includes('scripts/sign_desktop_update.mjs'));
  assert.ok(linuxReleaseScript.includes('scripts/register_linux_release.mjs'));
  assert.ok(linuxReleaseScript.includes('test_releases'));
  assert.ok(linuxReleaseScript.includes('electron-builder.linux.test.cjs'));
  assert.ok(linuxReleaseScript.includes('Refusing to publish'));
  assert.ok(linuxReleaseScript.includes('JANUS_RELEASE_DISTRIBUTION_MODE'));
  assert.ok(linuxReleaseScript.includes('${JANUS_RELEASE_DISTRIBUTION_MODE:-open-source}'));
  assert.ok(linuxReleaseScript.includes('unset JANUS_TRIAL_CODEX_KEY JANUS_TRIAL_CODEX_KEY_FILE JANUS_TRIAL_CODEX_BASE_URL JANUS_TRIAL_PROVIDER_REQUIRED JANUS_ALLOW_OFFICIAL_PROVIDER_EMBED'));
  const cloudReleaseScript = readFileSync(path.join(process.cwd(), 'scripts/cloud.mjs'), 'utf8');
  assert.equal(cloudReleaseScript.includes('publish-linux'), false);
  assert.ok(cloudReleaseScript.includes('AppImage'));
  assert.ok(cloudReleaseScript.includes('latest-linux'));
  const cloudReleasePublisher = readFileSync(path.join(process.cwd(), 'src/cloud/releasePublisher.js'), 'utf8');
  assert.ok(cloudReleasePublisher.includes("platform: 'any'"));
  const cloudReleaseServer = readFileSync(path.join(process.cwd(), 'src/cloud/server.js'), 'utf8');
  assert.ok(cloudReleaseServer.includes('latest-linux.yml'));
  assert.ok(cloudReleaseServer.includes('AppImage'));
  assert.ok(existsSync(path.join(process.cwd(), 'scripts/register_macos_release.mjs')));
  assert.ok(existsSync(path.join(process.cwd(), 'scripts/register_windows_release.mjs')));
  assert.ok(existsSync(path.join(process.cwd(), 'deploy/janus-publish-windows-artifact')));
  assert.ok(existsSync(path.join(process.cwd(), 'deploy/janus-publish-macos-artifact')));
  assert.ok(existsSync(path.join(process.cwd(), 'scripts/register_linux_release.mjs')));
  const macWorkflow = readFileSync(path.join(process.cwd(), '.github/workflows/build-macos.yml'), 'utf8');
  const macPublishScript = readFileSync(path.join(process.cwd(), 'deploy/janus-publish-macos-artifact'), 'utf8');
  assert.ok(macWorkflow.includes('Publish macOS update to Janus server'));
  assert.ok(macPublishScript.includes('scripts/register_macos_release.mjs'));
  assert.ok(macWorkflow.includes('--mac dmg zip --arm64'));
  assert.ok(macWorkflow.includes('scripts/sign_desktop_update.mjs --platform macos'));
  assert.ok(macWorkflow.includes('dist/*.zip'));
  assert.ok(macWorkflow.includes('WINDOWS_UPDATE_FEED'));
  assert.ok(macWorkflow.includes('scripts/register_macos_release.mjs'));
  assert.ok(macWorkflow.includes('electron-builder.macos.test.cjs'));
  assert.ok(macWorkflow.includes('$framework_resources/en.lproj/locale.pak'));
  assert.ok(macWorkflow.includes('$framework_resources/zh_CN.lproj/locale.pak'));
  assert.ok(macWorkflow.includes('Janus-Test-macOS-arm64'));
  assert.ok(macWorkflow.includes("- 'test-v*'"));
  assert.ok(macWorkflow.includes('JANUS_TRIAL_PROVIDER_REQUIRED'));
  assert.ok(macWorkflow.includes('JANUS_TRIAL_CODEX_KEY'));
  assert.ok(macWorkflow.includes('JANUS_ALLOW_OFFICIAL_PROVIDER_EMBED'));
  assert.equal(macWorkflow.includes('npm run sync:codex-cli'), false, 'macOS release builds must use the committed dependency lock');
  assert.ok(macWorkflow.includes('scp '), 'macOS publishing must stream the verified Runner artifacts directly to the release server');
  const updateSettingsViewSource = readFileSync(path.join(process.cwd(), 'src/renderer/app/views/settingsView.js'), 'utf8');
  assert.ok(updateSettingsViewSource.includes('newerVersion(current.releaseVersion'));
  assert.ok(updateSettingsViewSource.includes('agentUpdate.available || agentUpdate.downloaded'));
  assert.ok(updateSettingsViewSource.includes('失败详情：'));
  const agentBundleServiceSource = readFileSync(path.join(process.cwd(), 'src/main/agentBundles.js'), 'utf8');
  assert.ok(agentBundleServiceSource.includes('Agent 组织 ${installed.releaseVersion} 已应用'));
  const windowsWorkflow = readFileSync(path.join(process.cwd(), '.github/workflows/build-windows.yml'), 'utf8');
  assert.ok(windowsWorkflow.includes('runs-on: windows-2025'));
  assert.ok(windowsWorkflow.includes('--win nsis --x64'));
  assert.ok(windowsWorkflow.includes('scripts/sign_desktop_update.mjs --platform windows'));
  assert.ok(windowsWorkflow.includes('deploy/janus-publish-windows-artifact'));
  assert.ok(windowsWorkflow.includes('electron-builder.windows.test.cjs'));
  assert.ok(windowsWorkflow.includes('dist/win-unpacked/locales/en-US.pak'));
  assert.ok(windowsWorkflow.includes('dist/win-unpacked/locales/zh-CN.pak'));
  assert.ok(windowsWorkflow.includes('scripts/verify_packaged_app.mjs --app-dir dist/win-unpacked'));
  assert.ok(windowsWorkflow.includes('actions/setup-python@v5'));
  assert.ok(windowsWorkflow.includes("python-version: '3.12'"));
  assert.ok(windowsWorkflow.includes('scripts/verify_windows_python_runtime.mjs --app-dir dist/win-unpacked'));
  assert.ok(windowsWorkflow.includes('Janus-Test-Windows-x64'));
  assert.ok(windowsWorkflow.includes("- 'test-v*'"));
  assert.ok(windowsWorkflow.includes('JANUS_TRIAL_PROVIDER_REQUIRED'));
  assert.ok(windowsWorkflow.includes('JANUS_TRIAL_CODEX_KEY'));
  assert.equal(windowsWorkflow.includes('npm run sync:codex-cli'), false, 'Windows release builds must use the committed dependency lock');
  assert.equal(windowsWorkflow.includes('scp '), false, 'Windows publishing must pull the GitHub Artifact through the server proxy instead of slow inbound SCP');
  assert.ok(existsSync(path.join(process.cwd(), 'deploy/electron-builder.windows.cjs')));
  assert.ok(existsSync(path.join(process.cwd(), 'deploy/electron-builder.windows.test.cjs')));
  assert.ok(existsSync(path.join(process.cwd(), 'scripts/build_windows_test.mjs')));
  assert.ok(existsSync(path.join(process.cwd(), 'scripts/verify_packaged_app.mjs')));
  assert.ok(existsSync(path.join(process.cwd(), 'scripts/prepare_windows_python_runtime.mjs')));
  assert.ok(existsSync(path.join(process.cwd(), 'scripts/verify_windows_python_runtime.mjs')));
  assert.ok(existsSync(path.join(process.cwd(), 'deploy/electron-builder.macos.test.cjs')));
  assert.ok(existsSync(path.join(process.cwd(), 'deploy/electron-builder.linux.test.cjs')));
  const testBuilderIdentity = readFileSync(path.join(process.cwd(), 'deploy/electron-builder.test-identity.cjs'), 'utf8');
  assert.ok(testBuilderIdentity.includes("build.appId = 'local.janus.desktop.test'"));
  assert.ok(testBuilderIdentity.includes("build.productName = 'Janus Test'"));
  assert.ok(testBuilderIdentity.includes("name: 'janus-test'"));
  assert.ok(testBuilderIdentity.includes('/janus/test_releases'));
  assert.ok(testBuilderIdentity.includes("channel: 'latest'"));
  assert.ok(testBuilderIdentity.includes('build.detectUpdateChannel = false'));
  assert.ok(testBuilderIdentity.includes("process.env.JANUS_TRIAL_PROVIDER_REQUIRED = '1'"));
  const windowsTestBuildSource = readFileSync(path.join(process.cwd(), 'scripts/build_windows_test.mjs'), 'utf8');
  assert.ok(windowsTestBuildSource.includes('scripts/prepare_trial_provider_bundle.mjs'));
  assert.ok(windowsTestBuildSource.includes('scripts/lib/trialProviderDevEnv.mjs'));
  assert.ok(windowsTestBuildSource.includes("'trial-provider', 'provider.enc'"));
  const nginxSource = readFileSync(path.join(process.cwd(), 'deploy/nginx/janus.conf'), 'utf8');
  assert.ok(nginxSource.includes('location /janus/test_releases/'));
  assert.ok(nginxSource.includes('location /janus-sync/'));
  assert.ok(nginxSource.includes('proxy_pass http://127.0.0.1:9100;'));
  assert.ok(nginxSource.includes('proxy_set_header Host $http_host;'));
  const windowsVerificationWorkflow = readFileSync(path.join(process.cwd(), '.github/workflows/verify-windows-installer.yml'), 'utf8');
  assert.ok(windowsVerificationWorkflow.includes('Installed Janus exited during the clean first-launch check'));
  assert.ok(windowsVerificationWorkflow.includes("$env:JANUS_UPDATES_ENABLED = '0'"));
  assert.ok(windowsVerificationWorkflow.includes("$env:RELEASE_CHANNEL -eq 'test'"));
  assert.ok(windowsVerificationWorkflow.includes('Join-Path $installDir "$productName.exe"'));
  assert.ok(windowsVerificationWorkflow.includes('Join-Path $installDir "Uninstall $productName.exe"'));
  assert.ok(windowsVerificationWorkflow.includes("($env:RELEASE_VERSION -split '-')[0]"));
  assert.ok(readFileSync(path.join(process.cwd(), 'network/clients/macosUpdateInstaller.js'), 'utf8').includes('/Applications/Janus Test.app'));
  assert.ok(existsSync(path.join(process.cwd(), 'deploy/electron-builder.linux.cjs')));
  for (const [builderConfig, platformPackage, excludedFamilies] of [
    ['deploy/electron-builder.linux.cjs', 'codex-linux-x64', ['codex-darwin-', 'codex-win32-']],
    ['deploy/electron-builder.macos.cjs', 'codex-darwin-arm64', ['codex-linux-', 'codex-win32-']],
    ['deploy/electron-builder.windows.cjs', 'codex-win32-x64', ['codex-darwin-', 'codex-linux-']],
  ]) {
    const contents = readFileSync(path.join(process.cwd(), builderConfig), 'utf8');
    assert.ok(contents.includes("'node_modules/@openai/codex/**/*'"), `${builderConfig} must package and unpack the managed Codex CLI`);
    assert.ok(contents.includes(`'node_modules/@openai/${platformPackage}/**/*'`), `${builderConfig} must include the correct platform Codex binary package`);
    for (const family of excludedFamilies) {
      assert.ok(contents.includes(`'!node_modules/@openai/${family}*/**/*'`), `${builderConfig} must exclude ${family} packages`);
    }
  }
  const windowsBuilderConfig = readFileSync(path.join(process.cwd(), 'deploy/electron-builder.windows.cjs'), 'utf8');
  assert.ok(windowsBuilderConfig.includes("build.electronLanguages = ['en-US', 'zh-CN']"));
  assert.ok(windowsBuilderConfig.includes('build.extraResources'));
  assert.ok(windowsBuilderConfig.includes("'build-runtime', 'windows-x64', 'python'"));
  assert.ok(windowsBuilderConfig.includes("to: 'python'"));
  assert.ok(windowsBuilderConfig.includes('build.beforePack = async () =>'));
  assert.ok(windowsBuilderConfig.includes("'prepare_windows_python_runtime.mjs'"));
  const pythonRuntimeSource = readFileSync(path.join(process.cwd(), 'src/main/python.js'), 'utf8');
  assert.ok(pythonRuntimeSource.includes('process.resourcesPath'));
  assert.ok(pythonRuntimeSource.includes("'python.exe'"));
  assert.ok(pythonRuntimeSource.includes("PYTHONNOUSERSITE: '1'"));
  const packagedAppVerifier = readFileSync(path.join(process.cwd(), 'scripts/verify_packaged_app.mjs'), 'utf8');
  assert.ok(packagedAppVerifier.includes("path.join(runtimeRoot, 'python.exe')"));
  assert.ok(packagedAppVerifier.includes("const MINIMUM_CODEX_PLUGIN_VERSION = '0.144.3'"));
  assert.ok(packagedAppVerifier.includes("runExecutable(execution, ['plugin', '--help'])"));
  assert.ok(packagedAppVerifier.includes('codexVersion'));
  const windowsPythonRuntimeBuilder = readFileSync(path.join(process.cwd(), 'scripts/prepare_windows_python_runtime.mjs'), 'utf8');
  assert.ok(windowsPythonRuntimeBuilder.includes("const PYTHON_VERSION = '3.12.10'"));
  assert.ok(windowsPythonRuntimeBuilder.includes("'python-pptx==1.0.2'"));
  assert.ok(windowsPythonRuntimeBuilder.includes('PYTHON_EMBED_SHA256'));
  const windowsPythonRuntimeVerifier = readFileSync(path.join(process.cwd(), 'scripts/verify_windows_python_runtime.mjs'), 'utf8');
  assert.ok(windowsPythonRuntimeVerifier.includes('runRendererProbe({ execution, rendererScript, tempRoot })'));
  assert.ok(windowsPythonRuntimeVerifier.includes("JANUS_PPT_ENABLE_IMAGEGEN: '0'"));
  assert.ok(windowsPythonRuntimeVerifier.includes('Packaged PPT renderer did not create a complete PPTX package.'));
  const macBuilderConfig = readFileSync(path.join(process.cwd(), 'deploy/electron-builder.macos.cjs'), 'utf8');
  assert.ok(macBuilderConfig.includes("build.electronLanguages = ['en', 'zh_CN']"));
  for (const registrationScript of [
    'scripts/register_windows_release.mjs',
    'scripts/register_macos_release.mjs',
    'scripts/register_linux_release.mjs',
  ]) {
    const registrationSource = readFileSync(path.join(process.cwd(), registrationScript), 'utf8');
    assert.ok(registrationSource.includes("releasesDirectory === 'test_releases' ? 1 : 3"));
  }
  assert.ok(windowsBuilderConfig.includes('oneClick: false'));
  assert.ok(windowsBuilderConfig.includes('perMachine: false'));
  assert.ok(windowsBuilderConfig.includes('allowToChangeInstallationDirectory: true'));
  assert.ok(windowsBuilderConfig.includes('useZip: false'));
  assert.ok(windowsBuilderConfig.includes("include: 'deploy/installer.windows.nsh'"));
  const windowsInstallerInclude = readFileSync(path.join(process.cwd(), 'deploy/installer.windows.nsh'), 'utf8');
  assert.ok(windowsInstallerInclude.includes('janusUpgradeProgressActive'));
  assert.ok(windowsInstallerInclude.includes('$hasPerMachineInstallation == "1"'));
  assert.ok(windowsInstallerInclude.includes('$hasPerUserInstallation == "1"'));
  assert.ok(windowsInstallerInclude.includes('JANUS_PBM_SETMARQUEE'));
  assert.ok(windowsInstallerInclude.includes('正在移除旧版本，请稍候'));
  assert.ok(windowsInstallerInclude.includes('正在安装新版本，请勿关闭安装程序'));
  assert.ok(windowsInstallerInclude.includes('正在完成升级'));
  assert.ok(windowsInstallerInclude.includes('!macro customUnInstallCheck'));
  assert.ok(windowsInstallerInclude.includes('!macro customUnInstallCheckCurrentUser'));
  assert.ok(windowsInstallerInclude.includes('!macro customInstall'));
  assert.ok(windowsInstallerInclude.includes('JANUS_PBM_SETPOS} 100'));
  assert.ok(windowsInstallerInclude.includes('!macro customCheckAppRunning'));
  assert.ok(windowsInstallerInclude.includes('nsProcess::KillProcess'));
  assert.ok(windowsInstallerInclude.includes('nsProcess::FindProcess'));
  assert.ok(windowsInstallerInclude.includes('taskkill.exe'));
  assert.ok(windowsInstallerInclude.includes('/F /T /IM'));
  assert.ok(windowsInstallerInclude.includes('ExecToStack /TIMEOUT=20000'));
  const desktopMainSource = readFileSync(path.join(process.cwd(), 'src', 'main', 'main.js'), 'utf8');
  assert.ok(desktopMainSource.includes('defaultSession.resolveProxy'));
  assert.ok(desktopMainSource.includes('refreshCodexSystemProxy'));
  assert.ok(desktopMainSource.includes('terminateActiveCodexProcesses'));
  assert.ok(readFileSync(path.join(process.cwd(), 'src', 'preload', 'preload.js'), 'utf8').includes('webUtils.getPathForFile'));
  assert.ok(mainIpcSource.includes("ipcMain.handle('files:select'"));
  for (const iconFile of ['assets/icons/icon.png', 'assets/icons/icon.ico', 'assets/icons/icon.icns']) {
    assert.ok(existsSync(path.join(process.cwd(), iconFile)), `missing packaged icon ${iconFile}`);
  }
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    assertPngDimensions(path.join(process.cwd(), 'assets', 'icons', `${size}x${size}.png`), size, size);
  }
  assertPngDimensions(path.join(process.cwd(), 'assets/icons/icon.png'), 1024, 1024);
  assertIco(path.join(process.cwd(), 'assets/icons/icon.ico'), 4);
  assertIcns(path.join(process.cwd(), 'assets/icons/icon.icns'));
  const defaultCodexConfig = runtime.codexConfig();
  assert.equal(defaultCodexConfig.model, 'gpt-5.6-sol');
  assert.equal(defaultCodexConfig.reasoningEffort, 'medium');
  assert.equal(defaultCodexConfig.webSearch, true);
  assert.equal(defaultCodexConfig.sandboxNetwork, true);
  assert.equal(defaultCodexConfig.requestMaxRetries, 4);
  assert.equal(defaultCodexConfig.streamMaxRetries, 5);
  const normalizedModels = normalizeModelCatalog({
    models: [
      { slug: 'gpt-test-new', display_name: 'GPT Test New', visibility: 'list', supported_in_api: true, priority: 1, default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
      { slug: 'hidden-test', display_name: 'Hidden Test', visibility: 'hide', supported_in_api: true, priority: 2 },
    ],
  });
  assert.deepEqual(normalizedModels.map((item) => item.id), ['gpt-test-new']);
  const providerFilteredModels = filterCodexModelCatalogForProvider({
    models: [
      { slug: 'gpt-test-new', visibility: 'list' },
      { slug: 'gpt-5.2', visibility: 'list' },
    ],
  }, ['gpt-test-new']);
  assert.deepEqual(providerFilteredModels.models.map((item) => item.slug), ['gpt-test-new']);
  const testModelCatalog = new ModelCatalog({
    root: tmp,
    fetchCatalog: async () => ({ models: [
      { slug: 'gpt-test-new', display_name: 'GPT Test New', visibility: 'list', supported_in_api: true, priority: 1, default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
    ] }),
  });
  await testModelCatalog.refresh();
  assert.deepEqual(testModelCatalog.resolveSelection({ model: 'gpt-test-new', reasoningEffort: 'high' }), { model: 'gpt-test-new', reasoningEffort: 'high' });
  assert.deepEqual(testModelCatalog.resolveSelection({}), { model: '', reasoningEffort: '' });
  assert.throws(() => testModelCatalog.resolveSelection({ model: 'unknown', reasoningEffort: 'ultra' }), /Unsupported Codex model/);
  const staleSelectionCatalog = new ModelCatalog({
    root: path.join(tmp, 'stale-selection-catalog'),
    fetchCatalog: async () => ({ models: [
      { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', supported_in_api: true, priority: 1, default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] },
    ] }),
    getDefaultSelection: () => ({ model: 'gpt-5.2', reasoningEffort: 'medium' }),
  });
  await staleSelectionCatalog.refresh();
  assert.deepEqual(staleSelectionCatalog.resolveSelection({}), { model: 'gpt-5.6-sol', reasoningEffort: 'medium' });
  assert.deepEqual(staleSelectionCatalog.resolveSelection({ model: 'gpt-5.2', reasoningEffort: 'high' }), { model: 'gpt-5.6-sol', reasoningEffort: 'low' });
  const cachedTestModelCatalog = new ModelCatalog({ root: tmp });
  assert.deepEqual(cachedTestModelCatalog.status().models.map((item) => item.id), ['gpt-test-new']);
  const savedCodexConfig = runtime.saveCodexConfig({
    baseUrl: 'https://example.invalid/v1/',
    apiKey: 'sk-test-janus',
    model: 'gpt-test',
    reviewModel: 'gpt-test-review',
    reasoningEffort: 'low',
  });
  assert.equal(savedCodexConfig.baseUrl, 'https://example.invalid/v1');
  assert.equal(savedCodexConfig.model, 'gpt-test');
  assert.equal(savedCodexConfig.reviewModel, 'gpt-test-review');
  assert.equal(savedCodexConfig.reasoningEffort, 'low');
  assert.equal(savedCodexConfig.authEnvKey, 'OPENAI_API_KEY');
  assert.equal(savedCodexConfig.hasApiKey, true);
  const rawCodexFiles = runtime.codexConfigFiles();
  assert.ok(rawCodexFiles.configToml.includes('model = "gpt-test"'));
  assert.ok(rawCodexFiles.authJson.includes('sk-test-janus'));
  const rawSaveResult = await runtime.saveCodexConfigFiles({
    authJson: '{\n  "THIRD_PARTY_KEY": "sk-raw-test"\n}\n',
    configToml: [
      'model_provider = "third_party"',
      'model = "gpt-raw"',
      'review_model = "gpt-raw-review"',
      'model_reasoning_effort = "high"',
      'disable_response_storage = true',
      '',
      '[tools]',
      'web_search = true',
      '',
      '[sandbox_workspace_write]',
      'network_access = true',
      '',
      '[model_providers.third_party]',
      'name = "third_party"',
      'base_url = "https://raw.example/v1"',
      'wire_api = "responses"',
      'requires_openai_auth = true',
      'env_key = "THIRD_PARTY_KEY"',
      '',
    ].join('\n'),
  });
  assert.equal(rawSaveResult.status.model, 'gpt-raw');
  assert.equal(rawSaveResult.status.baseUrl, 'https://raw.example/v1');
  assert.equal(rawSaveResult.status.reasoningEffort, 'high');
  assert.equal(rawSaveResult.status.hasApiKey, true);
  assert.equal(rawSaveResult.status.providerName, 'third_party');
  assert.equal(rawSaveResult.status.authEnvKey, 'THIRD_PARTY_KEY');
  assert.equal(rawSaveResult.status.requestMaxRetries, 4);
  assert.equal(rawSaveResult.status.streamMaxRetries, 5);
  assert.ok(rawSaveResult.files.configToml.includes('request_max_retries = 4'));
  assert.ok(rawSaveResult.files.configToml.includes('stream_max_retries = 5'));

  const defaultUser = runtime.currentUser();
  assert.equal(authEmailValidationMessage(''), '请输入邮箱。');
  assert.equal(authEmailValidationMessage('not-an-email'), '邮箱格式不正确，请检查后重试。');
  assert.equal(authEmailValidationMessage('valid@example.com'), '');
  assert.equal(registrationValidationMessage({ email: 'valid@example.com' }), '请输入邮箱验证码。');
  assert.equal(registrationValidationMessage({ email: 'valid@example.com', code: '12' }), '邮箱验证码应为 6 位数字。');
  assert.equal(registrationValidationMessage({ email: 'valid@example.com', code: '123456' }), '请输入初始密码。');
  assert.equal(registrationValidationMessage({ email: 'valid@example.com', code: '123456', password: 'short', passwordConfirm: 'short' }), '密码至少需要 8 位。');
  assert.equal(registrationValidationMessage({ email: 'valid@example.com', code: '123456', password: 'password-1' }), '请再次输入密码。');
  assert.equal(registrationValidationMessage({ email: 'valid@example.com', code: '123456', password: 'password-1', passwordConfirm: 'password-2' }), '两次输入的密码不一致。');
  assert.equal(registrationValidationMessage({ email: 'valid@example.com', code: '123456', password: 'password-1', passwordConfirm: 'password-1' }), '');
  assert.equal(defaultUser.id, 'local_admin');
  assert.equal(defaultUser.role, 'admin');
  assert.equal(defaultUser.emailVerified, true);
  assert.throws(() => runtime.authLogin({ identifier: 'local_admin', password: '' }), /不支持直接登录/);
  assert.equal(runtime.authUpdatePassword({ currentPassword: '', newPassword: 'local-admin-check1' }).ok, true);
  const member = runtime.authRegister({
    email: 'member@example.com',
    password: 'member-password1',
    displayName: 'Member User',
  });
  assert.equal(member.role, 'member');
  assert.equal(member.emailVerified, true);
  assert.equal(runtime.currentUser().id, member.id);
  assert.ok(runtime.store.findUserAgentInstance({ userId: member.id, agentFamilyId: 'general_agent' }), 'registration must provision the default general employee');
  assert.ok(runtime.store.findUserAgentInstance({ userId: member.id, agentFamilyId: 'secretary_agent' }), 'registration must provision uBuddy');
  assert.equal(runtime.store.getEmployeeQuota({ userId: member.id }).used, 1);
  const resetCode = runtime.authSendEmailCode({ email: 'member@example.com', purpose: 'password_reset' });
  assert.equal(resetCode.delivery, 'local_debug');
  const repeatedResetCode = runtime.authSendEmailCode({ email: 'member@example.com', purpose: 'password_reset' });
  assert.equal(repeatedResetCode.reused, true);
  assert.equal(repeatedResetCode.devCode, resetCode.devCode);
  assert.equal(runtime.db.prepare(
    "SELECT COUNT(*) AS count FROM email_verifications WHERE lower(email) = ? AND purpose = ? AND consumed = 0",
  ).get('member@example.com', 'password_reset').count, 1);
  assert.equal(runtime.authResetPasswordByEmail({ email: 'member@example.com', code: resetCode.devCode, newPassword: 'member-password1-2' }).ok, true);
  runtime.authLogin({ identifier: 'member@example.com', password: 'member-password1-2' });
  assert.equal(runtime.store.listUserAgentInstances({ userId: member.id }).length, 2, 'login provisioning must remain idempotent');
  const memberCodexConfig = runtime.codexConfig();
  assert.equal(memberCodexConfig.hasApiKey, true);
  assert.equal(memberCodexConfig.configurationMode, 'user-configurable');
  assert.equal(memberCodexConfig.baseUrl, 'https://raw.example/v1');
  assert.equal(memberCodexConfig.authEnvKey, 'THIRD_PARTY_KEY');
  assert.ok(runtime.codexConfigFiles().configToml.includes('model_provider'));
  assert.equal((await runtime.saveCodexConfigFiles({
    ...runtime.codexConfigFiles(),
    adminProviderOverride: false,
  })).status.configurationMode, 'user-configurable');
  assert.throws(() => runtime.saveCodexConfig({ model: 'member-forbidden' }), /管理员权限/);
  assert.equal(member.permissions.canEditCodexConfig, false);
  assert.equal(member.permissions.canRunDoctor, true);
  assert.equal(member.permissions.canManageSkills, true);
  assert.throws(
    () => runtime.authRegister({ email: 'MEMBER@example.com', password: 'another-password1', displayName: 'Duplicate Member' }),
    /已被注册/,
  );
  const settingsViewSource = readFileSync(path.join(process.cwd(), 'src/renderer/app/views/settingsView.js'), 'utf8');
  assert.ok(settingsViewSource.includes('模型服务'));
  assert.ok(settingsViewSource.includes('仅保存在当前设备'));
  assert.ok(settingsViewSource.includes('保存并测试通过'));
  const priorRendererUser = rendererState.currentUser;
  const priorRendererCodexConfig = rendererState.codexConfig;
  const priorRendererCodexConfigFiles = rendererState.codexConfigFiles;
  const priorSettingsSection = rendererState.currentSettingsSection;
  rendererState.currentUser = member;
  rendererState.codexConfig = memberCodexConfig;
  rendererState.codexConfigFiles = runtime.codexConfigFiles();
  rendererState.currentSettingsSection = 'account';
  const memberSettingsHtml = renderSettings();
  assert.ok(memberSettingsHtml.includes('试用模型服务已就绪'));
  assert.ok(memberSettingsHtml.includes('普通用户无需填写'));
  assert.equal(memberSettingsHtml.includes('id="codex-file-config-form"'), false);
  assert.equal(memberSettingsHtml.includes('id="codex-config-toml"'), false);
  assert.equal(memberSettingsHtml.includes('id="codex-auth-json"'), false);
  assert.equal(memberSettingsHtml.includes('id="provider-key-application-form"'), false);
  assert.equal(memberSettingsHtml.includes('id="codex-base-url"'), false);
  assert.equal(memberSettingsHtml.includes('id="codex-api-key"'), false);
  assert.equal(memberSettingsHtml.includes('data-codex-config-mode="files"'), false);
  rendererState.currentUser = priorRendererUser;
  rendererState.codexConfig = priorRendererCodexConfig;
  rendererState.codexConfigFiles = priorRendererCodexConfigFiles;
  rendererState.currentSettingsSection = priorSettingsSection;
  assert.equal(settingsViewSource.includes('local-admin-login-btn'), false);
  assert.equal(settingsViewSource.includes('local_admin 直接登录'), false);
  assert.ok(settingsViewSource.includes('id="register-code"'));
  assert.ok(settingsViewSource.includes('send-register-code-btn'));
  assert.ok(settingsViewSource.includes('register-password-confirm'));
  const memberSession = runtime.store.createSession({ title: 'Member private session', departmentId: 'general', userId: member.id });
  runtime.store.addMessage({
    sessionId: memberSession.id,
    role: 'user',
    content: 'Alpha evidence belongs to the member search fixture.',
    departmentId: 'general',
    metadata: { attachments: [{ name: 'member-notes.pdf' }] },
  });
  const adminSession = runtime.store.createSession({ title: 'Admin private session', departmentId: 'general', userId: defaultUser.id });
  runtime.store.addMessage({
    sessionId: adminSession.id,
    role: 'assistant',
    content: 'Alpha evidence belongs to the admin search fixture.',
    departmentId: 'general',
  });
  assert.ok(runtime.listSessions().every((session) => session.userId === member.id), 'member session list should be scoped to current user');
  const memberTitleSearch = runtime.searchSessions({ query: 'member private' });
  assert.ok(memberTitleSearch.some((session) => session.id === memberSession.id), 'member should search own session title');
  assert.ok(!memberTitleSearch.some((session) => session.id === adminSession.id), 'member search should not include admin session title');
  const memberMessageSearch = runtime.searchSessions({ query: 'alpha evidence' });
  const memberMessageHit = memberMessageSearch.find((session) => session.id === memberSession.id);
  assert.equal(memberMessageHit?.matchRole, 'user');
  assert.ok(memberMessageHit?.matchExcerpt.includes('Alpha evidence'));
  assert.ok(!memberMessageSearch.some((session) => session.id === adminSession.id), 'member search should not include admin message hit');
  assert.ok(runtime.searchSessions({ query: 'member-notes.pdf' }).some((session) => session.id === memberSession.id), 'member should search message metadata');
  assert.throws(
    () => runtime.updateSession({ sessionId: adminSession.id, action: 'rename', title: 'Forbidden rename' }),
    /无权修改/,
    'member should not rename another user session',
  );
  const renamedMemberSession = runtime.updateSession({ sessionId: memberSession.id, action: 'rename', title: 'Renamed member session' });
  assert.equal(renamedMemberSession.title, 'Renamed member session');
  const pinnedMemberSession = runtime.updateSession({ sessionId: memberSession.id, action: 'pin' });
  assert.ok(pinnedMemberSession.pinnedAt, 'pin action should set pinnedAt');
  const throwawaySession = runtime.store.createSession({ title: 'Pinned throwaway session', departmentId: 'general', userId: member.id });
  const throwawayAttachment = runtime.uploadFile({
    filename: 'delete-with-session.txt',
    contentType: 'text/plain',
    dataBase64: Buffer.from('delete this managed attachment').toString('base64'),
  });
  runtime.store.addMessage({
    sessionId: throwawaySession.id,
    role: 'user',
    content: 'temporary attachment',
    departmentId: 'general',
    metadata: { attachments: [throwawayAttachment] },
  });
  assert.ok(existsSync(throwawayAttachment.path));
  const archivedMemberSession = runtime.updateSession({ sessionId: memberSession.id, action: 'archive' });
  assert.equal(archivedMemberSession.archived, true);
  assert.ok(!runtime.listSessions().some((session) => session.id === memberSession.id), 'archived session should be hidden from recent list');
  const archivedSearchHit = runtime.searchSessions({ query: 'renamed member session' }).find((session) => session.id === memberSession.id);
  assert.equal(archivedSearchHit?.archived, true, 'archived session should remain searchable');
  const unarchivedMemberSession = runtime.updateSession({ sessionId: memberSession.id, action: 'unarchive' });
  assert.equal(unarchivedMemberSession.archived, false);
  assert.ok(runtime.listSessions().some((session) => session.id === memberSession.id), 'unarchived session should return to recent list');
  const deletedThrowaway = runtime.updateSession({ sessionId: throwawaySession.id, action: 'delete' });
  assert.equal(deletedThrowaway.deletedSessionId, throwawaySession.id);
  assert.equal(deletedThrowaway.attachmentCleanup.deletedFiles, 1);
  assert.equal(existsSync(throwawayAttachment.path), false, 'deleting a session should remove its managed attachment file');
  assert.ok(!runtime.listSessions().some((session) => session.id === throwawaySession.id), 'deleted session should be hidden from recent list');
  assert.ok(!runtime.searchSessions({ query: 'pinned throwaway' }).some((session) => session.id === throwawaySession.id), 'deleted session should be hidden from search');

  const sharedAttachment = runtime.uploadFile({
    filename: 'shared-between-sessions.txt',
    contentType: 'text/plain',
    dataBase64: Buffer.from('shared managed attachment').toString('base64'),
  });
  const sharedSessionA = runtime.store.createSession({ title: 'Shared attachment A', departmentId: 'general', userId: member.id });
  const sharedSessionB = runtime.store.createSession({ title: 'Shared attachment B', departmentId: 'general', userId: member.id });
  for (const sharedSession of [sharedSessionA, sharedSessionB]) {
    runtime.store.addMessage({
      sessionId: sharedSession.id,
      role: 'user',
      content: 'shared attachment reference',
      departmentId: 'general',
      metadata: { attachments: [sharedAttachment] },
    });
  }
  const deletedSharedA = runtime.updateSession({ sessionId: sharedSessionA.id, action: 'delete' });
  assert.equal(deletedSharedA.attachmentCleanup.retainedFiles, 1);
  assert.ok(existsSync(sharedAttachment.path), 'a managed attachment referenced by another session must be retained');
  runtime.updateSession({ sessionId: sharedSessionB.id, action: 'delete' });
  assert.equal(existsSync(sharedAttachment.path), false, 'the last session deletion should remove the shared managed attachment');

  const deliveryDraftAttachment = runtime.uploadFile({
    filename: 'delegation-delivery-draft.md',
    contentType: 'text/markdown',
    dataBase64: Buffer.from('# completed delegation draft').toString('base64'),
  });
  const deliverySourceSession = runtime.store.createSession({ title: 'Delegation delivery source', departmentId: 'agent_delegation', userId: member.id });
  const deliveryConfirmationSession = runtime.store.createSession({ title: 'Delegation delivery confirmation', departmentId: 'secretary_department', userId: member.id });
  runtime.store.addMessage({
    sessionId: deliverySourceSession.id,
    role: 'system',
    content: 'generated task file',
    departmentId: 'agent_delegation',
    metadata: { generatedTaskFiles: true, attachments: [deliveryDraftAttachment] },
  });
  runtime.store.addMessage({
    sessionId: deliveryConfirmationSession.id,
    role: 'assistant',
    content: 'waiting for owner delivery confirmation',
    departmentId: 'secretary_department',
    metadata: { externalDelegationDeliveryDraft: { attachments: [deliveryDraftAttachment] } },
  });
  const deletedDeliverySource = runtime.updateSession({ sessionId: deliverySourceSession.id, action: 'delete' });
  assert.equal(deletedDeliverySource.attachmentCleanup.retainedFiles, 1);
  assert.ok(existsSync(deliveryDraftAttachment.path), 'a pending delegation confirmation must pin its managed delivery attachment');
  runtime.updateSession({ sessionId: deliveryConfirmationSession.id, action: 'delete' });
  assert.equal(existsSync(deliveryDraftAttachment.path), false, 'the delivery attachment may be removed after its final active confirmation reference is deleted');

  const friend = runtime.authRegister({
    email: 'friend@example.com',
    password: 'friend-password1',
    displayName: 'Friend User',
  });
  const friendSearch = runtime.friendSearch({ query: 'member@example.com' });
  assert.ok(friendSearch.some((user) => user.id === member.id), 'friend search should find member by email');
  const request = runtime.friendSendRequest({ userId: member.id });
  assert.equal(request.ok, true);
  runtime.authLogin({ identifier: 'member@example.com', password: 'member-password1-2' });
  const incoming = runtime.friendsOverview().requests.incoming;
  assert.equal(incoming.length, 1);
  const accepted = runtime.friendAcceptRequest({ requestId: incoming[0].id });
  assert.equal(accepted.overview.friends.length, 1);
  assert.equal(accepted.overview.friends[0].friend.id, friend.id);
  const remarkedFriend = runtime.friendUpdateRemark({ userId: friend.id, remark: '项目王老师' });
  assert.equal(remarkedFriend.overview.friends[0].remark, '项目王老师');
  assert.equal(remarkedFriend.overview.friends[0].friend.remark, '项目王老师');
  runtime.authLogin({ identifier: 'friend@example.com', password: 'friend-password1' });
  assert.equal(runtime.friendsOverview().friends[0].remark, '', 'friend remarks must be private to the owner who set them');
  const socialMessage = runtime.socialSendMessage({
    recipientId: member.id,
    senderAgentId: 'friend_project_agent',
    title: 'Agent task handoff',
    content: 'Please review the AI healthcare project brief from my agent.',
  });
  assert.equal(socialMessage.ok, true);
  runtime.authLogin({ identifier: 'member@example.com', password: 'member-password1-2' });
  const memberInbox = runtime.socialInbox();
  assert.equal(memberInbox.length, 1);
  assert.equal(memberInbox[0].sender.id, friend.id);
  assert.equal(memberInbox[0].senderAgentId, 'friend_project_agent');
  assert.ok(!memberInbox.some((item) => item.title === memberSession.title), 'social inbox must not include normal AI chat sessions');
  runtime.authLogin({ identifier: 'friend@example.com', password: 'friend-password1' });
  const readonlyLegacyGroupId = 'readonly-legacy-group-check';
  runtime.socialSendMessage({
    recipientId: member.id,
    kind: 'system',
    content: '创建只读回归群聊。',
    metadata: { type: 'social_task_group', action: 'created', taskGroupId: readonlyLegacyGroupId },
  });
  runtime.socialSendMessage({
    recipientId: member.id,
    kind: 'friend',
    content: '解散前的群聊历史消息。',
    metadata: { type: 'social_task_group_message', taskGroupId: readonlyLegacyGroupId },
  });
  runtime.socialSendMessage({
    recipientId: member.id,
    kind: 'system',
    content: '解散只读回归群聊。',
    metadata: { type: 'social_task_group', action: 'dissolved', taskGroupId: readonlyLegacyGroupId },
  });
  assert.ok(runtime.socialConversation({ peerId: member.id }).some((item) => item.content === '解散前的群聊历史消息。'), 'dissolved groups must retain historical messages');
  assert.throws(() => runtime.socialSendMessage({
    recipientId: member.id,
    kind: 'friend',
    content: '这条消息不应发送。',
    metadata: { type: 'social_task_group_message', taskGroupId: readonlyLegacyGroupId },
  }), /任务群已解散，只能查看历史记录/);
  const delegationResult = runtime.createAgentDelegation({
    recipientId: member.id,
    title: 'AI healthcare agent delegation',
    instruction: 'Please let your secretary agent prepare a first-pass outline for an AI healthcare project application.',
  });
  assert.equal(delegationResult.ok, true);
  assert.equal(delegationResult.delegation.requesterUserId, friend.id);
  assert.equal(delegationResult.delegation.recipientUserId, member.id);
  assert.ok(runtime.agentDelegations({ direction: 'outgoing' }).some((item) => item.id === delegationResult.delegation.id));
  runtime.authLogin({ identifier: 'member@example.com', password: 'member-password1-2' });
  const memberInboxWithDelegation = runtime.socialInbox();
  const delegationMessage = memberInboxWithDelegation.find((item) => item.metadata?.delegationId === delegationResult.delegation.id);
  assert.ok(delegationMessage, 'recipient inbox should include secretary-agent delegation message');
  assert.equal(delegationMessage.kind, 'agent');
  assert.equal(delegationMessage.senderAgentId, 'secretary_agent');
  const incomingDelegations = runtime.agentDelegations({ direction: 'incoming' });
  assert.ok(incomingDelegations.some((item) => item.id === delegationResult.delegation.id), 'recipient should see incoming delegation record');
  await assert.rejects(() => runtime.startAgentDelegation({ delegationId: delegationResult.delegation.id, execute: false }), /\u5148\u63a5\u6536/);
  const acceptedDelegation = await runtime.respondAgentDelegation({ delegationId: delegationResult.delegation.id, action: 'accept' });
  assert.equal(acceptedDelegation.delegation.status, 'running');
  const startedDelegation = await runtime.startAgentDelegation({ delegationId: delegationResult.delegation.id, execute: false });
  assert.equal(startedDelegation.ok, true);
  assert.equal(startedDelegation.delegation.status, 'accepted');
  assert.equal(startedDelegation.session.userId, member.id);
  assert.equal(startedDelegation.session.departmentId, 'agent_delegation');
  const delegationSessionMessages = runtime.listMessages(startedDelegation.session.id);
  assert.ok(delegationSessionMessages.some((item) => item.metadata?.agentDelegation?.id === delegationResult.delegation.id), 'starting a delegation should create a recipient-owned session message');
  assert.equal((await runtime.friendRemove({ userId: friend.id })).ok, true);

  runtime.authLogin({ identifier: defaultUser.id, password: 'local-admin-check1' });
  assert.equal(runtime.currentUser().role, 'admin');
  assert.ok(!runtime.listSessions().some((session) => session.userId === member.id), 'admin must not bypass another account Workspace session boundary');
  const adminSearch = runtime.searchSessions({ query: 'alpha evidence' });
  assert.ok(!adminSearch.some((session) => session.id === memberSession.id), 'admin search must not include another account Workspace session hits');
  assert.ok(adminSearch.some((session) => session.id === adminSession.id), 'admin search should include admin session hits');
  const promoted = runtime.adminUpdateUserRole({ userId: member.id, role: 'admin' });
  assert.equal(promoted.role, 'admin');
  const demoted = runtime.adminUpdateUserRole({ userId: member.id, role: 'member' });
  assert.equal(demoted.role, 'member');
  const reset = runtime.adminResetUserPassword({ userId: member.id });
  assert.equal(reset.password, 'opl12345');
  const deleted = runtime.adminDeleteUser({ userId: member.id });
  assert.equal(deleted.deleted_user_id, member.id);
  assert.equal(runtime.adminDeleteUser({ userId: friend.id }).deleted_user_id, friend.id);

  const org = runtime.org.list();
  assert.deepEqual(org.departments.map((department) => department.id).sort(), ['ppt_department', 'secretary_department']);
  assert.deepEqual(org.leaders.map((leader) => leader.id), ['ppt_leader']);
  assert.deepEqual(runtime.org.highestLeadAgents().map((leader) => leader.id), ['ppt_leader']);
  assert.ok(org.agents.some((agent) => agent.id === 'ppt'), 'seeded ppt agent');
  const generalAgent = runtime.org.agent('general_agent');
  assert.ok(generalAgent?.standalone);
  assert.equal(generalAgent.departmentId, 'general');
  assert.equal(generalAgent.routable, true);
  assert.ok(generalAgent.skillPath.includes(`${path.sep}system_agents${path.sep}general_agent${path.sep}`));
  for (const agentFamilyId of ['general_agent_1', 'general_agent_2', 'general_agent_3']) {
    assert.equal(runtime.org.agent(agentFamilyId), null, `${agentFamilyId} must not remain a standalone bundled Agent`);
  }
  assert.ok(org.agents.some((agent) => agent.id === 'secretary_agent'), 'Buddy agent participates in the normal Agent evolution roster');
  const buddyAgent = runtime.org.agent('secretary_agent');
  assert.ok(buddyAgent);
  assert.equal(buddyAgent.departmentId, 'secretary_department');
  assert.match(buddyAgent.systemPrompt, /secretary-agent Skill/);
  const buddySkill = runtime.org.readSkill(buddyAgent);
  assert.match(buddySkill, /Professional secretary standard/);
  assert.match(buddySkill, /Result-version discipline/);
  assert.match(buddySkill, /requester's private task session/i);
  assert.match(buddySkill, /task-group shared file workspace/i);
  assert.match(buddySkill, /Completion is defined by the task outcome, not by an arbitrary elapsed time/);
  assert.ok(existsSync(path.join(path.dirname(buddyAgent.skillPath), 'references', 'operating-protocol.md')));
  const buddyEvaluatorReview = await runtime.evolution.reviewAgentEvolutionProposal({
    agent: buddyAgent,
    hr: null,
    runId: 'buddy_evaluator_dry_run_check',
    proposal: '## Summary\nDry-run evaluator check.',
    proposalPath: '',
    diagnostic: { primary_layer: 'skill_procedure', evidence_messages: 5 },
    gate: { status: 'passed', score: 1 },
    dryRun: true,
  });
  assert.equal(buddyEvaluatorReview.reviewerType, 'buddy_evaluator');
  assert.equal(buddyEvaluatorReview.reviewerId, 'buddy_evaluator');
  assert.equal(runtime.db.prepare("SELECT hr_id FROM agent_evolution_reviews WHERE run_id = 'buddy_evaluator_dry_run_check'").get().hr_id, 'buddy_evaluator');
  assert.throws(
    () => runtime.evolution.transitionAgentCareer({ agentId: 'secretary_agent', action: 'promote', reviewerId: 'check' }),
    /excluded from Lab-level career actions/,
  );
  const generalEvaluatorReview = await runtime.evolution.reviewAgentEvolutionProposal({
    agent: generalAgent,
    hr: null,
    runId: 'general_evaluator_dry_run_check',
    proposal: '## Summary\nDry-run standalone general Agent evaluator check.',
    proposalPath: '',
    diagnostic: { primary_layer: 'skill_procedure', evidence_messages: 5 },
    gate: { status: 'passed', score: 1 },
    dryRun: true,
  });
  assert.equal(generalEvaluatorReview.reviewerType, 'general_agent_evaluator');
  assert.equal(generalEvaluatorReview.reviewerId, 'general_agent_evaluator');
  assert.throws(
    () => runtime.evolution.transitionAgentCareer({ agentId: 'general_agent', action: 'promote', reviewerId: 'check' }),
    /participates in recruitment deliberation only/,
  );
  const generalReviewCountBefore = runtime.db.prepare("SELECT COUNT(*) AS count FROM agent_performance_reviews WHERE agent_id = 'general_agent'").get().count;
  const generalRecruitment = runtime.evolution.runGeneralAgentRecruitmentParticipation({ force: true, dryRun: true });
  assert.equal(generalRecruitment.status, 'completed');
  assert.equal(generalRecruitment.organizationPolicy, 'recruitment_only_no_assessment_or_career_actions');
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM agent_performance_reviews WHERE agent_id = 'general_agent'").get().count, generalReviewCountBefore);
  const buddyHrReview = await runtime.evolution.runHrReview({ departmentId: 'secretary_department', dryRun: true });
  assert.equal(buddyHrReview.status, 'skipped');
  assert.equal(buddyHrReview.reason, 'buddy_agent_lab_governance_excluded');
  runtime.db.prepare(
    `INSERT INTO specialist_experiments (
      id, department_id, candidate_agent_id, source_agent_id, baseline_agent_id
     ) VALUES ('buddy_experiment_check', 'secretary_department', 'secretary_agent', 'ppt', 'ppt')`,
  ).run();
  assert.throws(
    () => runtime.evolution.startSpecialistExperiment({ experimentId: 'buddy_experiment_check', prompt: 'Buddy guard fixture' }),
    /excluded from specialist experiments/,
  );
  assert.throws(
    () => runtime.evolution.evaluateSpecialistExperiment({ experimentId: 'buddy_experiment_check' }),
    /excluded from specialist experiments/,
  );
  assert.throws(
    () => runtime.evolution.finalizeSpecialistExperiment({ experimentId: 'buddy_experiment_check', decision: 'promote' }),
    /excluded from specialist experiments/,
  );
  runtime.evolution.applyStructuralActions('secretary_department', {
    decisions: {
      actions: [{
        type: 'retire_agent',
        validation_status: 'approved',
        source_agents: ['secretary_agent'],
        evidence_summary: 'This action must be blocked by Buddy policy.',
      }],
    },
  }, 'buddy_structural_guard_check');
  assert.ok(runtime.db.prepare(
    "SELECT id FROM agent_governance_events WHERE event_type = 'buddy_lab_action_blocked' AND source_review_id = 'buddy_structural_guard_check'",
  ).get());
  const buddyOriginalSkill = readFileSync(buddyAgent.skillPath, 'utf8');
  const buddyOriginalMemory = readFileSync(buddyAgent.memoryPath, 'utf8');
  const buddyLifecycleBefore = {
    lifecycleStatus: buddyAgent.lifecycleStatus,
    lifecycleRole: buddyAgent.lifecycleRole,
    routingState: buddyAgent.routingState,
    rank: buddyAgent.rank,
    routable: buddyAgent.routable,
    permissions: buddyAgent.permissions,
  };
  runtime.evolution.snapshotSkill(buddyAgent, 'buddy_rollback_check_source', buddyOriginalSkill);
  runtime.store.settingSet('buddy:last_assessment_at', '2998-01-01T00:00:00.000Z');
  for (let index = 0; index < 3; index += 1) {
    runtime.db.prepare(
      `INSERT INTO agent_delegations (
        id, requester_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
        title, instruction, status, updated_at
       ) VALUES (?, 'local_admin', 'local_admin', 'secretary_agent', 'secretary_agent', ?, ?, 'completed', '2999-01-01T00:00:00.000Z')`,
    ).run(`buddy_success_delegation_${index}`, `Buddy success ${index}`, 'Assessment success fixture');
  }
  const buddyBestAssessment = runtime.evolution.runBuddyPerformanceAssessment({ force: true });
  assert.equal(buddyBestAssessment.rating, 'excellent');
  runtime.store.settingSet('buddy:last_assessment_at', '2999-06-01T00:00:00.000Z');
  writeFileSync(buddyAgent.skillPath, `${buddyOriginalSkill}\n\n## Buddy Temporary Drift\n- This failed policy must be rolled back.\n`);
  for (let index = 0; index < 3; index += 1) {
    runtime.db.prepare(
      `INSERT INTO agent_delegations (
        id, requester_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
        title, instruction, status, last_error, updated_at
       ) VALUES (?, 'local_admin', 'local_admin', 'secretary_agent', 'secretary_agent', ?, ?, 'failed', ?, '2999-07-01T00:00:00.000Z')`,
    ).run(`buddy_failed_delegation_${index}`, `Buddy failure ${index}`, 'Assessment fixture', 'Fixture failure');
  }
  const buddyAssessment = runtime.evolution.runBuddyPerformanceAssessment({ force: true });
  assert.equal(buddyAssessment.status, 'completed');
  assert.equal(buddyAssessment.rating, 'observe');
  assert.equal(buddyAssessment.failureCount, 3);
  assert.equal(buddyAssessment.rollback.status, 'applied');
  assert.equal(buddyAssessment.rollback.skillVersionId, buddyBestAssessment.assessedSkillVersionId);
  assert.equal(readFileSync(buddyAgent.skillPath, 'utf8'), buddyOriginalSkill);
  assert.equal(readFileSync(buddyAgent.memoryPath, 'utf8'), buddyOriginalMemory);
  const buddyLifecycleAfter = runtime.org.agent('secretary_agent');
  assert.deepEqual({
    lifecycleStatus: buddyLifecycleAfter.lifecycleStatus,
    lifecycleRole: buddyLifecycleAfter.lifecycleRole,
    routingState: buddyLifecycleAfter.routingState,
    rank: buddyLifecycleAfter.rank,
    routable: buddyLifecycleAfter.routable,
    permissions: buddyLifecycleAfter.permissions,
  }, buddyLifecycleBefore);
  const buddyPerformanceReview = runtime.db.prepare(
    `SELECT * FROM agent_performance_reviews
     WHERE agent_id = 'secretary_agent' AND review_type = 'buddy_periodic_skill_only'
     ORDER BY created_at DESC LIMIT 1`,
  ).get();
  assert.ok(buddyPerformanceReview);
  assert.match(buddyPerformanceReview.recommendation, /lifecycle, role, rank, routing, permissions, Memory/);
  const initialStatuses = runtime.agentStatuses();
  assert.equal(initialStatuses.length, org.agents.length);
  assert.equal(initialStatuses.find((item) => item.agentId === 'secretary_agent')?.departmentId, 'secretary_department');
  const rollbackAgent = runtime.org.agent('ppt');
  const rollbackOriginalSkill = readFileSync(rollbackAgent.skillPath, 'utf8');
  runtime.evolution.snapshotSkill(rollbackAgent, 'rollback_check_source', rollbackOriginalSkill);
  const rollbackVersion = runtime.db.prepare("SELECT * FROM skill_versions WHERE source_run_id = 'rollback_check_source'").get();
  assert.ok(rollbackVersion);
  writeFileSync(rollbackAgent.skillPath, `${rollbackOriginalSkill}\n\n## Temporary Drift\n- This line should be removed by rollback.\n`);
  const rollbackResult = runtime.evolution.rollbackSkillVersion({
    skillVersionId: rollbackVersion.id,
    reviewerId: 'check_hr',
    reason: 'Regression check rollback.',
  });
  assert.equal(rollbackResult.status, 'applied');
  assert.equal(readFileSync(rollbackAgent.skillPath, 'utf8'), rollbackOriginalSkill);
  assert.ok(existsSync(rollbackResult.beforePath));
  assert.ok(existsSync(rollbackResult.afterPath));
  assert.ok(runtime.store.evolutionOverview().skillVersions.some((item) => item.id === rollbackVersion.id));
  const rollbackEvent = runtime.db.prepare(
    "SELECT * FROM agent_governance_events WHERE event_type = 'skill_rollback' AND agent_id = 'ppt' ORDER BY created_at DESC LIMIT 1",
  ).get();
  assert.ok(rollbackEvent);

  const session = runtime.store.createSession({
    title: 'check',
    departmentId: 'ppt_department',
    agentId: 'ppt',
  });
  runtime.store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: 'PPTX 没有生成，需要重新处理。',
    agentId: 'ppt',
    departmentId: 'ppt_department',
  });
  runtime.store.addMessage({
    sessionId: session.id,
    role: 'assistant',
    content: '我会补充 artifact 检查。',
    agentId: 'ppt',
    departmentId: 'ppt_department',
  });
  const evidence = runtime.store.evidenceForAgent('ppt', 20);
  assert.equal(evidence.length, 2);

  const jsonlDir = path.join(tmp, 'data', 'codex_backend_sessions', session.id, 'sessions', '2026', '07', '01');
  mkdirSync(jsonlDir, { recursive: true });
  writeFileSync(
    path.join(jsonlDir, 'transcript.jsonl'),
    [
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'JSONL 用户说 PPTX missing' }, created_at: '2026-07-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'JSONL assistant will verify artifact' }, created_at: '2026-07-01T00:00:01.000Z' }),
    ].join('\n'),
  );
  const transcriptEvidence = codexEvidenceForAgent({ db: runtime.db, store: runtime.store, root: tmp, agentId: 'ppt', limit: 20 });
  assert.equal(transcriptEvidence.length, 4);
  assert.ok(transcriptEvidence.some((item) => item.content.includes('JSONL')));
  assert.ok(transcriptEvidence.some((item) => item.content.includes('artifact 检查')));
  const transcriptSearch = runtime.searchSessions({ query: 'jsonl assistant verify' });
  const transcriptHit = transcriptSearch.find((item) => item.id === session.id);
  assert.equal(transcriptHit?.matchRole, 'assistant');
  assert.equal(transcriptHit?.matchSource, 'codex_transcript');

  const diagnostic = diagnoseAgentEvidence({
    agentId: 'ppt',
    departmentId: 'ppt_department',
    evidence,
  });
  assert.equal(diagnostic.primary_layer, 'artifact_contract');
  runtime.evolution.recordWorkflowCreditFromDiagnostic({
    runId: 'workflow_credit_check',
    agent: runtime.org.agent('ppt'),
    diagnostic,
  });
  const overviewWithCredit = runtime.store.evolutionOverview();
  assert.ok(overviewWithCredit.workflowCredits.some((item) => item.runId === 'workflow_credit_check' && item.workflowStep === 'artifact_contract'));

  const proposal = [
    '## Summary',
    'Improve artifact QA.',
    '## Proposed memory replacement',
    'no-op',
    '## Proposed memory patch',
    '- Workflow Notes: Verify exported PPTX exists before final answer.',
    '## Proposed skill patch',
    'Add to **Output Standards**:',
    '- Verify generated PPTX artifacts exist and can be opened before final delivery.',
    '## Eval cases',
    '- Input: User asks for a PPTX. Expected: skill requires artifact existence check.',
    '## HR notes',
    'No structural change.',
    '## Risks',
    'May add small QA overhead.',
  ].join('\n');
  const gate = scoreEvolutionGate({ proposal, diagnostic, validationErrors: [] });
  assert.equal(gate.status, 'passed');

  const cases = extractEvalCases(proposal);
  assert.equal(cases.length, 1);
  assert.ok(cases[0].expectedText.includes('artifact'));

  const merge = memoryMergeDecision(
    'Verify generated PPTX artifacts before final delivery.',
    'Verify generated pptx artifacts before final delivery.',
  );
  assert.equal(merge.merge, true);
  assert.equal(Object.hasOwn(merge, 'embedding_similarity'), false);

  const hrReviewBase = [
    '## Department summary',
    'Keep the department stable.',
    '## Debate transcript',
    '- HR: Keep current staffing.',
    '- ppt agent: The update is narrow.',
    '- project manager: No structural change is warranted.',
    '## Agent roster recommendation',
    'Keep current agents; no change.',
    '## Structural change decisions',
    '{"actions":[{"type":"no_change","status":"approved"}]}',
    '## Proposed new agents',
    'None.',
    '## Proposed merges or retirements',
    'None.',
    '## Skill and memory review',
    'No structural skill change.',
    '## Eval cases',
    '- Input: review. Expected: no roster change.',
    '## HR memory replacement',
    'no-op',
    '## HR memory patch',
    'no-op',
    '## Memory migration plan',
    'No migration required.',
    '## Risks',
    'Low risk.',
  ].join('\n');
  assert.deepEqual(validateHrReviewProposal(hrReviewBase), []);
  assert.ok(validateHrReviewProposal(hrReviewBase.replace('## HR memory patch\nno-op', '## HR memory patch\n- Keep current staffing.\n```text\nembedded fence\n```')).some(
    (error) => error.includes('code fences'),
  ));
  assert.deepEqual(
    validateHrReviewProposal(hrReviewBase.replace('no-op\n## HR memory patch', 'Replace empty HR memory with:\n# HR Memory: ppt_department\n\n## Governance Notes\n- Keep staffing decisions evidence-based.\n## HR memory patch')),
    [],
  );

  const insertArchive = (runId, score, { gateStatus = 'passed', applied = 1 } = {}) => {
    runtime.db.prepare(
      `INSERT INTO evolution_archives (
        id, run_id, agent_id, department_id, gate_status, gate_score, gate_json, applied
       ) VALUES (?, ?, 'ppt', 'ppt_department', ?, ?, '{}', ?)`,
    ).run(`archive_${runId}`, runId, gateStatus, score, applied);
  };
  insertArchive('calibration_weak_positive_1', 0.81);
  insertArchive('calibration_weak_positive_2', 0.8);
  const insufficient = runtime.evolution.calibrateGateFromHistory({ minSamples: 2 });
  assert.equal(insufficient.status, 'insufficient_data');
  assert.equal(insufficient.negative_count, 0);

  for (const item of [
    ['calibration_labeled_positive_1', 0.9, true],
    ['calibration_labeled_positive_2', 0.86, true],
    ['calibration_labeled_negative_1', 0.6, false],
    ['calibration_labeled_negative_2', 0.58, false],
  ]) {
    const [runId, score, label] = item;
    insertArchive(runId, score, { gateStatus: 'passed', applied: label ? 1 : 0 });
    runtime.evolution.recordArchiveLabel({
      runId,
      label,
      labelSource: 'human',
      confidence: 0.95,
      rationale: 'check fixture',
    });
  }
  const calibrated = runtime.evolution.calibrateGateFromHistory({ minSamples: 6 });
  assert.equal(calibrated.status, 'calibrated');
  assert.ok(calibrated.best.false_positive_rate >= 0);
  assert.ok(calibrated.selected_min_score >= 0.61 && calibrated.selected_min_score <= 0.81);
  const activeCalibration = runtime.db.prepare("SELECT status FROM evolution_gate_calibrations WHERE status = 'active'").get();
  assert.equal(activeCalibration.status, 'active');
  runtime.evolution.recordArchiveLabel({
    runId: 'calibration_labeled_negative_2',
    archiveId: 'archive_calibration_labeled_negative_2',
    label: false,
    labelSource: 'human',
    confidence: 1,
    rationale: 'Operator observed degraded behavior after this evolution.',
  });
  const labeledOverview = runtime.store.evolutionOverview().archives.find((item) => item.runId === 'calibration_labeled_negative_2');
  assert.equal(labeledOverview.latestLabel.label, false);
  assert.equal(labeledOverview.latestLabel.source, 'human');
  assert.ok(labeledOverview.latestLabel.rationale.includes('degraded'));
  const recalibrated = runtime.evolution.calibrateGateFromHistory({ minSamples: 6 });
  assert.equal(recalibrated.status, 'calibrated');

  const pptHr = runtime.org.hrForDepartment('ppt_department');
  const pptAgents = runtime.org.agentsForDepartment('ppt_department');
  const structuralProposal = [
    '## Structural change decisions',
    '```json',
    JSON.stringify({
      actions: [{
        type: 'new_agent',
        status: 'approved',
        evidence_count: 99,
        confidence: 0.99,
        evidence_summary: 'Repeated stable evidence supports a controlled specialist trial.',
        memory_migration_plan: 'Keep existing memory with source agent; migrate only reviewed reusable workflow notes after candidate assessment.',
        source_agents: ['ppt'],
        target_agents: [],
        votes: [
          { agent_id: pptHr.id, vote: 'abstain' },
          ...pptAgents.map((item) => ({ agent_id: item.id, vote: 'approve' })),
        ],
        new_agent: {
          id: 'ppt_quality_specialist_check',
          name: 'PPT Quality Specialist Check',
          description: 'Canary specialist for artifact QA checks.',
          system_prompt: 'Check PPT artifact quality.',
          self_evolution_prompt: 'Improve PPT quality checks from evidence.',
          skills: ['artifact QA'],
        },
      }],
    }),
    '```',
  ].join('\n');
  const structural = runtime.evolution.validateStructuralDecisions({
    departmentId: 'ppt_department',
    proposal: structuralProposal,
    maturityPolicy: runtime.evolution.maturityPolicy('ppt_department'),
    agents: pptAgents,
    hr: pptHr,
  });
  assert.ok(structural.errors.some((error) => error.includes('HR must explicitly approve')));
  assert.ok(structural.errors.some((error) => error.includes('Insufficient department evidence count')));
  const departmentVerifiedVotes = await runtime.evolution.collectIndependentStructuralVotes({
    reviewId: 'hr_verified_vote_check',
    department: runtime.org.department('ppt_department'),
    participants: [pptHr, ...pptAgents],
    actions: [{ type: 'new_agent' }],
    dryRun: true,
  });
  const generalVerifiedVotes = await runtime.evolution.collectIndependentStructuralVotes({
    reviewId: 'hr_verified_vote_check',
    department: runtime.org.department('ppt_department'),
    participants: [generalAgent],
    actions: [{ type: 'new_agent' }],
    allowedActionTypes: ['new_agent', 'new_department'],
    participationScope: 'recruitment_only',
    dryRun: true,
  });
  const verifiedVotes = [...departmentVerifiedVotes, ...generalVerifiedVotes];
  assert.equal(verifiedVotes.length, 2 + pptAgents.length);
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM hr_governance_votes WHERE review_id = 'hr_verified_vote_check'").get().count, verifiedVotes.length);
  const structurallyVerified = runtime.evolution.validateStructuralDecisions({
    departmentId: 'ppt_department',
    proposal: structuralProposal,
    maturityPolicy: runtime.evolution.maturityPolicy('ppt_department'),
    agents: pptAgents,
    hr: pptHr,
    verifiedVotes,
  });
  assert.ok(!structurallyVerified.errors.some((error) => error.includes('Missing vote')));
  assert.ok(!structurallyVerified.errors.some((error) => error.includes('HR must explicitly approve')));

  const newDepartmentAction = {
    type: 'new_department',
    status: 'approved',
    origin_agent_id: 'general_agent',
    source_agents: [],
    target_agents: [],
    evidence_count: 99,
    confidence: 0.99,
    evidence_summary: 'Repeated recruitment evidence shows a durable legal-compliance capability outside the current secretary and presentation boundaries.',
    memory_migration_plan: 'Start with empty reviewed memory and migrate only reusable public governance rules after probationary evaluation.',
    new_department: {
      id: 'legal_compliance_department',
      name: 'Legal Compliance Department',
      description: 'Owns legal and regulatory compliance analysis that is distinct from secretary coordination and presentation production.',
      reference_department_id: 'ppt_department',
      boundary_assessment: [
        { department_id: 'ppt_department', overlap_score: 0.1, rationale: 'Presentation production does not own legal or regulatory judgments.' },
        { department_id: 'secretary_department', overlap_score: 0.15, rationale: 'Secretary coordination may relay work but does not own compliance analysis.' },
      ],
      leader: {
        id: 'legal_compliance_leader', name: 'Legal Compliance Leader', description: 'Owns compliance quality and department orchestration.',
        system_prompt: 'Lead legal compliance analysis without inventing law or facts.', self_evolution_prompt: 'Improve reusable compliance workflows from reviewed evidence.', skills: ['compliance orchestration'],
      },
      hr: {
        id: 'legal_compliance_hr', name: 'Legal Compliance HR', description: 'Owns roster boundaries and periodic assessment.',
        system_prompt: 'Review legal compliance agent performance and boundaries.', debate_prompt: 'Require evidence before structural change.',
      },
      initial_agent: {
        id: 'legal_compliance_analyst', name: 'Legal Compliance Analyst', description: 'Performs source-grounded compliance analysis.',
        system_prompt: 'Analyze compliance requirements and clearly label uncertainty.', self_evolution_prompt: 'Improve reusable analysis skills from reviewed evidence.', skills: ['regulatory analysis'],
      },
    },
  };
  const newDepartmentProposal = [
    '## Structural change decisions',
    '```json',
    JSON.stringify({ actions: [newDepartmentAction] }),
    '```',
  ].join('\n');
  const newDepartmentVotes = await runtime.evolution.collectIndependentStructuralVotes({
    reviewId: 'new_department_regular_vote_check',
    department: runtime.org.department('ppt_department'),
    participants: [pptHr, ...pptAgents, generalAgent],
    actions: [newDepartmentAction],
    dryRun: true,
  });
  const newDepartmentLeadVotes = await runtime.evolution.collectLeadCouncilVotes({
    reviewId: 'new_department_lead_vote_check',
    actions: [newDepartmentAction],
    dryRun: true,
  });
  assert.deepEqual(newDepartmentLeadVotes.map((vote) => vote.voterAgentId), ['ppt_leader']);
  const newDepartmentWithoutLeadApproval = runtime.evolution.validateStructuralDecisions({
    departmentId: 'ppt_department',
    proposal: newDepartmentProposal,
    maturityPolicy: {
      ...runtime.evolution.maturityPolicy('ppt_department'),
      department_evidence_count: 999,
      min_evidence_count: 1,
      min_confidence: 0.5,
      max_structural_actions: 1,
    },
    agents: pptAgents,
    hr: pptHr,
    verifiedVotes: newDepartmentVotes,
    leadVotes: [],
  });
  assert.ok(newDepartmentWithoutLeadApproval.errors.some((error) => error.includes('Missing highest-lead approval: ppt_leader')));
  const newDepartmentStructural = runtime.evolution.validateStructuralDecisions({
    departmentId: 'ppt_department',
    proposal: newDepartmentProposal,
    maturityPolicy: {
      ...runtime.evolution.maturityPolicy('ppt_department'),
      department_evidence_count: 999,
      min_evidence_count: 1,
      min_confidence: 0.5,
      max_structural_actions: 1,
    },
    agents: pptAgents,
    hr: pptHr,
    verifiedVotes: newDepartmentVotes,
    leadVotes: newDepartmentLeadVotes,
  });
  assert.deepEqual(newDepartmentStructural.errors, []);
  runtime.evolution.applyStructuralActions('ppt_department', newDepartmentStructural, 'new_department_apply_check');
  assert.ok(runtime.org.department('legal_compliance_department'));
  assert.equal(runtime.org.leaderForDepartment('legal_compliance_department')?.rank, 'lead');
  assert.equal(runtime.org.agent('legal_compliance_analyst')?.lifecycleStatus, 'active');
  assert.deepEqual(runtime.org.highestLeadAgents().map((leader) => leader.id).sort(), ['legal_compliance_leader', 'ppt_leader']);

  const structuralDuplicateId = runtime.evolution.validateStructuralDecisions({
    departmentId: 'ppt_department',
    proposal: structuralProposal.replace('"id":"ppt_quality_specialist_check"', '"id":"ppt"'),
    maturityPolicy: runtime.evolution.maturityPolicy('ppt_department'),
    agents: pptAgents,
    hr: pptHr,
  });
  assert.ok(structuralDuplicateId.errors.some((error) => error.includes('New agent id already exists')));

  const structuralMergeSelf = runtime.evolution.validateStructuralDecisions({
    departmentId: 'ppt_department',
    proposal: [
      '## Structural change decisions',
      '```json',
      JSON.stringify({
        actions: [{
          type: 'merge_agents',
          status: 'approved',
          evidence_count: 99,
          confidence: 0.99,
          evidence_summary: 'Repeated stable evidence supports consolidating overlapping responsibilities.',
          memory_migration_plan: 'Migrate only reviewed reusable workflow notes and archive stale source-agent memory.',
          source_agents: ['ppt'],
          target_agents: ['ppt'],
          votes: [
            { agent_id: pptHr.id, vote: 'approve' },
            ...pptAgents.map((item) => ({ agent_id: item.id, vote: 'approve' })),
          ],
        }],
      }),
      '```',
    ].join('\n'),
    maturityPolicy: runtime.evolution.maturityPolicy('ppt_department'),
    agents: pptAgents,
    hr: pptHr,
  });
  assert.ok(structuralMergeSelf.errors.some((error) => error.includes('cannot merge an agent into itself')));

  runtime.evolution.applyStructuralActions('ppt_department', {
    decisions: {
      actions: [{
        type: 'new_agent',
        validation_status: 'approved',
        evidence_count: 99,
        confidence: 0.99,
        evidence_summary: 'Repeated stable evidence supports a controlled specialist trial.',
        memory_migration_plan: 'Keep existing memory with the source agent until immediate admission assessment is complete.',
        source_agents: ['ppt'],
        target_agents: [],
        votes: [
          { agent_id: pptHr.id, vote: 'approve' },
          ...pptAgents.map((item) => ({ agent_id: item.id, vote: 'approve' })),
        ],
        new_agent: {
          id: 'ppt_quality_specialist_runtime_check',
          name: 'PPT Quality Specialist Runtime Check',
          description: 'Canary specialist for artifact QA checks.',
          system_prompt: 'Check PPT artifact quality.',
          self_evolution_prompt: 'Improve PPT quality checks from evidence.',
          skills: ['artifact QA'],
        },
      }],
    },
  }, 'hr_canary_check');
  const canaryAgent = runtime.org.agent('ppt_quality_specialist_runtime_check');
  assert.ok(canaryAgent);
  assert.equal(canaryAgent.lifecycleStatus, 'active');
  assert.equal(canaryAgent.lifecycleRole, 'specialist');
  assert.equal(canaryAgent.routable, true);
  assert.equal(canaryAgent.permissions.automaticRouting, true);
  assert.equal(canaryAgent.permissions.canWriteLongTermMemory, true);
  assert.equal(canaryAgent.permissions.memoryWritePolicy, 'reviewed');
  const canaryExperiment = runtime.db.prepare("SELECT * FROM specialist_experiments WHERE candidate_agent_id = 'ppt_quality_specialist_runtime_check'").get();
  assert.equal(canaryExperiment.baseline_agent_id, 'ppt');
  assert.equal(canaryExperiment.started_by_review_id, 'hr_canary_check');
  assert.equal(canaryExperiment.state, 'promoted');
  assert.equal(canaryExperiment.status, 'active');
  assert.equal(JSON.parse(canaryExperiment.metrics_json).auto_routed_runs, 0);
  assert.equal(JSON.parse(canaryExperiment.evaluation_json).immediate_admission_assessment.passed, true);
  const overviewExperiment = runtime.store.evolutionOverview().specialistExperiments.find((item) => item.candidateAgentId === canaryAgent.id);
  assert.equal(overviewExperiment.baselineAgentId, 'ppt');
  assert.equal(overviewExperiment.startedByReviewId, 'hr_canary_check');
  assert.ok(runtime.db.prepare("SELECT id FROM agent_governance_events WHERE event_type = 'immediate_agent_admission_assessment' AND agent_id = 'ppt_quality_specialist_runtime_check' AND status = 'passed'").get());

  const retireSourceMemory = runtime.store.upsertMemoryEntry({
    scope: 'agent',
    ownerId: canaryAgent.id,
    agentId: canaryAgent.id,
    departmentId: 'ppt_department',
    memoryType: 'workflow_note',
    content: 'Canary artifact QA note to archive during retirement.',
    lifecycleState: 'active',
    confidence: 0.7,
    sourceKind: 'check',
    sourceId: 'retire-source-memory',
  });
  runtime.db.prepare(
    `INSERT INTO typed_memories (
      id, scope, owner_id, department_id, agent_id, memory_type,
      content, privacy_level, confidence, evidence_count, status
    ) VALUES (
      'typed_retire_canary_check', 'agent', ?, 'ppt_department', ?, 'workflow_note',
      'Typed candidate-assessment memory to archive during retirement.', 'public_reusable', 0.7, 2, 'active'
    )`,
  ).run(canaryAgent.id, canaryAgent.id);
  runtime.evolution.applyStructuralActions('ppt_department', {
    decisions: {
      actions: [{
        type: 'retire_agent',
        validation_status: 'approved',
        source_agents: [canaryAgent.id],
        target_agents: [],
        memory_migration_plan: 'Archive the candidate-assessment memory and keep source-agent memory authoritative.',
      }],
    },
  }, 'hr_retire_canary_check');
  const retiredCanary = runtime.org.agent(canaryAgent.id);
  assert.equal(retiredCanary.lifecycleStatus, 'retired');
  assert.equal(retiredCanary.lifecycleRole, 'archived_specialist');
  assert.equal(retiredCanary.enabled, false);
  assert.equal(retiredCanary.permissions.automaticRouting, false);
  assert.equal(retiredCanary.permissions.memoryWritePolicy, 'archived');
  assert.ok(!runtime.org.agentsForDepartment('ppt_department', { routableOnly: true }).some((agent) => agent.id === canaryAgent.id));
  assert.equal(runtime.store.getMemoryEntry(retireSourceMemory.id).lifecycleState, 'archived');
  const retiredTypedMemory = runtime.db.prepare("SELECT status FROM typed_memories WHERE id = 'typed_retire_canary_check'").get();
  assert.equal(retiredTypedMemory.status, 'archived');

  runtime.evolution.applyStructuralActions('ppt_department', {
    decisions: {
      actions: [{
        type: 'new_agent',
        validation_status: 'approved',
        evidence_count: 99,
        confidence: 0.99,
        evidence_summary: 'Repeated stable evidence supports a temporary merge-source specialist fixture.',
        memory_migration_plan: 'Keep existing memory with the source agent until merge evaluation is complete.',
        source_agents: ['ppt'],
        target_agents: [],
        votes: [
          { agent_id: pptHr.id, vote: 'approve' },
          ...pptAgents.map((item) => ({ agent_id: item.id, vote: 'approve' })),
        ],
        new_agent: {
          id: 'ppt_merge_source_check',
          name: 'PPT Merge Source Check',
          description: 'Temporary specialist fixture for merge migration checks.',
          system_prompt: 'Provide PPT merge-source checks.',
          self_evolution_prompt: 'Improve migration checks from evidence.',
          skills: ['migration fixture'],
        },
      }],
    },
  }, 'hr_merge_source_create_check');
  const mergeSource = runtime.org.agent('ppt_merge_source_check');
  const mergeSourceMemory = runtime.store.upsertMemoryEntry({
    scope: 'agent',
    ownerId: mergeSource.id,
    agentId: mergeSource.id,
    departmentId: 'ppt_department',
    memoryType: 'workflow_note',
    content: 'Reusable merge-source artifact QA memory should move to ppt.',
    lifecycleState: 'active',
    confidence: 0.7,
    sourceKind: 'check',
    sourceId: 'merge-source-memory',
  });
  runtime.db.prepare(
    `INSERT INTO typed_memories (
      id, scope, owner_id, department_id, agent_id, memory_type,
      content, privacy_level, confidence, evidence_count, status
    ) VALUES (
      'typed_merge_source_check', 'agent', ?, 'ppt_department', ?, 'workflow_note',
      'Typed merge-source QA memory should move to ppt.', 'public_reusable', 0.7, 2, 'active'
    )`,
  ).run(mergeSource.id, mergeSource.id);
  runtime.evolution.applyStructuralActions('ppt_department', {
    decisions: {
      actions: [{
        type: 'merge_agents',
        validation_status: 'approved',
        source_agents: [mergeSource.id],
        target_agents: ['ppt'],
        memory_migration_plan: 'Migrate reusable QA workflow notes to ppt and archive the source specialist memory.',
      }],
    },
  }, 'hr_merge_memory_check');
  const mergedSource = runtime.org.agent(mergeSource.id);
  assert.equal(mergedSource.lifecycleStatus, 'merged');
  assert.equal(mergedSource.lifecycleRole, 'archived_specialist');
  assert.equal(mergedSource.enabled, false);
  assert.equal(mergedSource.permissions.canSelfEvolve, false);
  assert.equal(runtime.store.getMemoryEntry(mergeSourceMemory.id).lifecycleState, 'archived');
  const migratedMemory = runtime.store.listMemoryEntries({ scope: 'agent', ownerId: 'ppt', limit: 200 }).find((item) => (
    item.sourceKind === 'structural_memory_migration' &&
    item.sourceId === `hr_merge_memory_check:${mergeSourceMemory.id}`
  ));
  assert.ok(migratedMemory);
  assert.equal(migratedMemory.lifecycleState, 'candidate');
  assert.equal(migratedMemory.reviewStatus, 'needs_hr_review');
  const sourceTypedAfterMerge = runtime.db.prepare("SELECT status FROM typed_memories WHERE id = 'typed_merge_source_check'").get();
  assert.equal(sourceTypedAfterMerge.status, 'archived');
  const targetTypedAfterMerge = runtime.db.prepare(
    "SELECT status FROM typed_memories WHERE agent_id = 'ppt' AND content = 'Typed merge-source QA memory should move to ppt.'",
  ).get();
  assert.equal(targetTypedAfterMerge.status, 'active');

  const agent = runtime.org.agent('ppt');
  writeFileSync(
    agent.skillPath,
    `${readFileSyncUtf8(agent.skillPath)}\n\n## Check Fixture\n- Require artifact existence check before final delivery.\n`,
  );
  const evalLookup = {
    ppt: { skillPath: agent.skillPath, memoryPath: agent.memoryPath },
    'ppt_department:ppt': { skillPath: agent.skillPath, memoryPath: agent.memoryPath },
  };
  runtime.db.prepare(
    `INSERT INTO evolution_regression_evals (
      id, run_id, agent_id, department_id, case_index, case_text, input_text,
      expected_text, replay_spec_json, source_proposal_hash, skill_hash, memory_hash
    ) VALUES (
      'eval_check_pass', 'regression_check_pass', 'ppt', 'ppt_department', 1,
      'PPT artifact delivery', 'create pptx',
      'artifact existence check final delivery', '{"kind":"artifact_check"}', 'proposal', 'skill', 'memory'
    )`,
  ).run();
  const replayStats = runRegressionEvalCases(runtime.db, {
    runId: 'regression_check_pass',
    root: tmp,
    agentLookup: evalLookup,
    replayRunner: () => ({ status: 'passed', score: 0.9, checks: { artifact: true } }),
    judgeRunner: () => ({ status: 'passed', score: 0.85, rationale: 'covered', checks: { reusable: true } }),
  });
  assert.equal(replayStats.passed, 1);
  assert.equal(replayStats.replayed, 1);
  assert.equal(replayStats.llm_judged, 1);
  const replayRow = runtime.db.prepare("SELECT evaluator_type, judge_result_json FROM evolution_regression_evals WHERE id = 'eval_check_pass'").get();
  assert.equal(replayRow.evaluator_type, 'static_plus_heuristic_plus_replay_plus_llm_judge');
  assert.equal(JSON.parse(replayRow.judge_result_json).status, 'passed');

  runtime.db.prepare(
    `INSERT INTO evolution_regression_evals (
      id, run_id, agent_id, department_id, case_index, case_text, input_text,
      expected_text, replay_spec_json, source_proposal_hash, skill_hash, memory_hash
    ) VALUES (
      'eval_check_judge_fail', 'regression_check_judge_fail', 'ppt', 'ppt_department', 1,
      'PPT artifact delivery', 'create pptx',
      'artifact existence check final delivery', '{}', 'proposal', 'skill', 'memory'
    )`,
  ).run();
  const judgeFailStats = runRegressionEvalCases(runtime.db, {
    runId: 'regression_check_judge_fail',
    root: tmp,
    agentLookup: evalLookup,
    judgeRunner: () => ({ status: 'failed', score: 0.2, rationale: 'not enough', checks: {} }),
  });
  assert.equal(judgeFailStats.failed, 1);
  const judgeFailRow = runtime.db.prepare("SELECT status, evaluator_type FROM evolution_regression_evals WHERE id = 'eval_check_judge_fail'").get();
  assert.equal(judgeFailRow.status, 'failed');
  assert.equal(judgeFailRow.evaluator_type, 'static_plus_heuristic_plus_llm_judge');

  const task = runtime.scheduler.createTaskRun({
    title: 'check graph',
    prompt: '请做一个科研 PPT，并查找资料。',
    departmentId: 'ppt_department',
    metadata:{leadershipEnforcementMode:'shadow',enforceDeliverableContract:false},
  });
  assert.ok(task.nodes.length >= 2);
  assert.ok(task.nodes.some((node) => node.status === 'ready'));
  assert.ok(task.nodes.every((node) => node.estimatedMinutes > 0));
  const processTaskEventId = 'event_check_process_stream';
  runtime.store.recordTaskEvent({
    eventId: processTaskEventId,
    taskRunId: task.id,
    taskNodeId: task.nodes[0].id,
    eventType: 'node_activity',
    actorId: task.nodes[0].agentId,
    status: 'running',
    summary: '命令执行：检查任务事件流',
    command: 'rg -n task_events src',
    output: 'first line\n',
    payload: { activityId: 'command-check', activityType: 'command', appendOutput: false },
  });
  runtime.store.recordTaskEvent({
    eventId: processTaskEventId,
    taskRunId: task.id,
    taskNodeId: task.nodes[0].id,
    eventType: 'node_activity',
    actorId: task.nodes[0].agentId,
    status: 'completed',
    summary: '命令执行：检查任务事件流完成',
    output: 'second line\n',
    payload: { activityId: 'command-check', activityType: 'command', appendOutput: true },
  });
  const processTaskEvent = runtime.store.getTaskEvent(processTaskEventId);
  assert.equal(processTaskEvent.eventId, processTaskEventId);
  assert.equal(processTaskEvent.taskId, task.id);
  assert.equal(processTaskEvent.nodeId, task.nodes[0].id);
  assert.equal(processTaskEvent.agentId, task.nodes[0].agentId);
  assert.equal(processTaskEvent.status, 'completed');
  assert.equal(processTaskEvent.privacyLevel, 'local_private');
  assert.equal(processTaskEvent.command, 'rg -n task_events src');
  assert.equal(processTaskEvent.output, 'first line\nsecond line\n');
  assert.ok(processTaskEvent.updatedAt);
  runtime.store.recordTaskEvent({
    eventId: 'event_check_reasoning_stream', taskRunId: task.id, taskNodeId: task.nodes[0].id,
    eventType: 'node_activity', actorId: task.nodes[0].agentId, status: 'running', summary: '第一段',
    payload: {
      activityId: 'reason-check', activityType: 'reasoning', detail: '第一段', append: true,
      reasoningText: '推理 A', appendReasoningText: true, terminalInput: '输入 A', appendTerminalInput: true,
      protocolEvents: [{ protocolEventId: 'protocol-a', method: 'item/reasoning/textDelta', sequence: 1 }],
    },
  });
  runtime.store.recordTaskEvent({
    eventId: 'event_check_reasoning_stream', taskRunId: task.id, taskNodeId: task.nodes[0].id,
    eventType: 'node_activity', actorId: task.nodes[0].agentId, status: 'running', summary: '第二段',
    payload: {
      activityId: 'reason-check', activityType: 'reasoning', detail: '第二段', append: true,
      reasoningText: '推理 B', appendReasoningText: true, terminalInput: '输入 B', appendTerminalInput: true,
      protocolEvents: [{ protocolEventId: 'protocol-b', method: 'item/completed', sequence: 2 }],
    },
  });
  const reasoningTaskEvent = runtime.store.getTaskEvent('event_check_reasoning_stream');
  assert.equal(reasoningTaskEvent.summary, '第一段第二段');
  assert.equal(reasoningTaskEvent.payload.reasoningText, '推理 A推理 B');
  assert.equal(reasoningTaskEvent.payload.terminalInput, '输入 A输入 B');
  assert.equal(reasoningTaskEvent.payload.protocolEvents.length, 2);
  assert.equal(reasoningTaskEvent.privacyLevel, 'local_private');
  const privateToolTaskEvent = runtime.store.recordTaskEvent({
    eventId: 'event_check_private_tool', taskRunId: task.id, taskNodeId: task.nodes[0].id,
    eventType: 'node_activity', actorId: task.nodes[0].agentId, status: 'completed', summary: '工具调用完成',
    payload: { activityId: 'tool-check', activityType: 'tool', arguments: { apiKey: 'sk-private-tool-secret' }, result: { ok: true } },
  });
  assert.equal(privateToolTaskEvent.privacyLevel, 'local_private');
  runtime.store.settleTaskProcessEvents({ taskRunId: task.id, taskNodeId: task.nodes[0].id, status: 'cancelled' });
  assert.equal(runtime.store.getTaskEvent('event_check_reasoning_stream').status, 'cancelled');
  const skippedEvent = runtime.store.recordTaskEvent({
    taskRunId: task.id, taskNodeId: task.nodes[0].id, eventType: 'node_non_blocking_skipped',
    actorId: 'task_scheduler', summary: '非阻塞节点已跳过。', payload: {},
  });
  assert.equal(skippedEvent.status, 'completed');
  const taskEventColumns = runtime.db.prepare('PRAGMA table_info(task_events)').all().map((row) => row.name);
  assert.ok(taskEventColumns.includes('privacy_level'));
  assert.ok(taskEventColumns.includes('updated_at'));
  const strategyNode = task.nodes.find((node) => node.title === 'Deck strategy and slide plan');
  assert.equal(strategyNode?.estimatedMinutes, 35);
  assert.equal(task.nodes.find((node) => node.title === 'Final deck synthesis')?.estimatedMinutes, 45);
  assert.ok(strategyNode.dependencies.length >= 1);
  assert.ok(strategyNode.notify.length >= 1);
  const strategyAgent = runtime.org.agent(strategyNode.agentId);
  assert.equal(buildGlobalTaskSummary('核心任务说明\n\n附加资源:\n不应进入全局摘要'), '核心任务说明');
  const communicationFixture = taskCommunicationsForNode(strategyNode, [
    { id: 'from-current', fromAgentId: strategyNode.agentId, toAgentId: 'other', references: [] },
    { id: 'to-current', fromAgentId: 'other', toAgentId: strategyNode.agentId, references: [] },
    { id: 'ref-current', fromAgentId: 'other-a', toAgentId: 'other-b', references: [{ taskNodeId: strategyNode.id }] },
    { id: 'unrelated', fromAgentId: 'other-a', toAgentId: 'other-b', references: [{ taskNodeId: 'other-node' }] },
  ]);
  assert.deepEqual(communicationFixture.map((item) => item.id), ['from-current', 'to-current', 'ref-current']);
  const strategyPrompt = buildTaskNodePrompt({
    taskRun: task,
    node: strategyNode,
    agent: strategyAgent,
    skill: runtime.org.readSkill(strategyAgent),
    memory: runtime.org.readMemory(strategyAgent),
    dependencyResults: strategyNode.dependencies.map((id) => runtime.store.getTaskNode(id)).filter(Boolean),
    communications: [],
  });
  for (const requiredFragment of [
    '- priority: 30',
    '- parallel group: strategy',
    '- blocking downstream: true',
    '- dependency node ids:',
    '- notify agents on completion:',
    '- output format: markdown slide table',
    '- estimated minutes: 35',
  ]) {
    assert.ok(strategyPrompt.includes(requiredFragment), `missing task prompt contract fragment ${requiredFragment}`);
  }

  for (const node of task.nodes) {
    runtime.store.updateTaskNode(node.id, {
      status: 'completed',
      resultText: `${node.title} done`,
      completedAt: new Date().toISOString(),
    });
  }
  runtime.scheduler.reconcileTaskStatus(task.id);
  const completedTask = runtime.store.getTaskRun(task.id);
  assert.equal(completedTask.status, 'completed');
  assert.ok(completedTask.retrospective.finalSummary.includes('Participants'));
  assert.ok(completedTask.retrospective.finalSummary.includes('Parallel groups:'));
  assert.ok(completedTask.retrospective.finalSummary.includes('critical_path_estimate='));
  const completedMetrics = completedTask.retrospective.skillFindings.find((item) => item.agentId === 'task_scheduler')?.executionMetrics;
  assert.ok(completedMetrics);
  assert.ok(completedMetrics.parallelGroups.some((item) => item.group === 'strategy'));
  assert.ok(completedMetrics.criticalPathEstimatedMinutes >= 80);
  assert.ok(completedMetrics.finalDelivery?.nodeTitle);
  const taskMemory = runtime.store.listMemoryEntries({ scope: 'task', ownerId: task.id });
  assert.ok(taskMemory.some((item) => item.memoryType === 'task_retrospective'));
  const shortTerm = runtime.store.listMemoryEntries({ scope: 'short_term', ownerId: task.id });
  const temporaryContext = shortTerm.find((item) => item.memoryType === 'temporary_context');
  assert.ok(temporaryContext);
  assert.equal(temporaryContext.lifecycleState, 'archived');
  assert.equal(temporaryContext.reviewStatus, 'task_retrospective_cleanup');
  const shortTermCleanupVersion = runtime.db.prepare(
    `SELECT COUNT(*) AS count
     FROM memory_versions
     WHERE memory_entry_id = ? AND source_kind = 'task_retrospective_cleanup'`,
  ).get(temporaryContext.id);
  assert.equal(Number(shortTermCleanupVersion.count), 1);
  const projectMemory = runtime.store.listMemoryEntries({ scope: 'project', ownerId: 'janus' });
  assert.ok(projectMemory.some((item) => item.memoryType === 'project_rule'));

  const crossDepartmentTask = runtime.scheduler.createTaskRun({
    title: 'ppt evidence graph',
    prompt: '做一个复杂 PPT，需要先联网调研文献和数据，再生成汇报。',
    departmentId: 'ppt_department',
  });
  assert.equal(crossDepartmentTask.metadata.primaryDepartmentId, 'ppt_department');
  assert.equal(crossDepartmentTask.metadata.crossDepartment, false);
  const researchNode = crossDepartmentTask.nodes.find((node) => node.title === 'Evidence pack');
  const mainNode = crossDepartmentTask.nodes.find((node) => node.title === 'Deck strategy and slide plan');
  const finalNode = crossDepartmentTask.nodes.find((node) => node.title === 'Final deck synthesis');
  assert.ok(researchNode);
  assert.equal(researchNode.agentId, 'ppt');
  assert.ok(mainNode);
  assert.ok(mainNode.dependencies.includes(researchNode.id));
  assert.ok(finalNode.dependencies.includes(mainNode.id));
  assert.ok(crossDepartmentTask.nodes.every((node) => node.estimatedMinutes > 0));
  assert.equal(researchNode.estimatedMinutes, 25);
  assert.equal(mainNode.estimatedMinutes, 35);

  const collaborationTask = runtime.scheduler.createTaskRun({
    title: 'collaboration graph',
    prompt: '帮我完成一篇论文从选题、实验设计、写作到 PPT 汇报的完整计划。',
    departmentId: 'collaboration',
  });
  assert.equal(collaborationTask.departmentId, 'collaboration');
  assert.equal(collaborationTask.metadata.primaryDepartmentId, 'collaboration');
  assert.equal(collaborationTask.metadata.crossDepartment, true);
  assert.ok(collaborationTask.nodes.length >= 2);
  const collaborationDepartments = new Set(collaborationTask.nodes.map((node) => node.departmentId));
  assert.ok(collaborationDepartments.has('ppt_department'));
  assert.ok(collaborationTask.nodes.some((node) => node.title === 'Cross-department synthesis'));
  assert.ok(collaborationTask.nodes.some((node) => node.agentId === collaborationTask.leadAgentId));

  const expiredMemory = runtime.store.upsertMemoryEntry({
    scope: 'short_term',
    ownerId: 'memory_policy_check',
    memoryType: 'temporary_context',
    content: 'Temporary context that should expire.',
    lifecycleState: 'active',
    confidence: 0.5,
    sourceKind: 'check',
    sourceId: 'expired',
    expiresAt: '2026-06-30T00:00:00.000Z',
  });
  const canonicalMemory = runtime.store.upsertMemoryEntry({
    scope: 'agent',
    ownerId: 'ppt',
    agentId: 'ppt',
    departmentId: 'ppt_department',
    memoryType: 'workflow_note',
    content: 'Verify generated artifacts before final delivery.',
    lifecycleState: 'active',
    confidence: 0.8,
    sourceKind: 'check',
    sourceId: 'duplicate-canonical',
  });
  const duplicateMemory = runtime.store.upsertMemoryEntry({
    scope: 'agent',
    ownerId: 'ppt',
    agentId: 'ppt',
    departmentId: 'ppt_department',
    memoryType: 'workflow_note',
    content: 'Verify generated artifacts before final delivery.',
    lifecycleState: 'active',
    confidence: 0.5,
    sourceKind: 'check',
    sourceId: 'duplicate-copy',
  });
  const privateMemory = runtime.store.upsertMemoryEntry({
    scope: 'agent',
    ownerId: 'ppt',
    agentId: 'ppt',
    departmentId: 'ppt_department',
    memoryType: 'preference',
    content: 'Private uploaded-file detail should not influence future tasks.',
    lifecycleState: 'active',
    confidence: 0.5,
    privacyLevel: 'private',
    sourceKind: 'check',
    sourceId: 'private',
  });
  const staleCandidate = runtime.store.upsertMemoryEntry({
    scope: 'agent',
    ownerId: 'ppt',
    agentId: 'ppt',
    departmentId: 'ppt_department',
    memoryType: 'failure_mode',
    content: 'Weak unverified candidate memory.',
    lifecycleState: 'candidate',
    confidence: 0.2,
    sourceKind: 'check',
    sourceId: 'stale-candidate',
  });
  const conflictCanonical = runtime.store.upsertMemoryEntry({
    scope: 'agent',
    ownerId: 'ppt',
    agentId: 'ppt',
    departmentId: 'ppt_department',
    memoryType: 'preference',
    content: 'Use academic tone for reusable deck introductions.',
    lifecycleState: 'active',
    confidence: 0.9,
    sourceKind: 'check',
    sourceId: 'conflict-canonical',
  });
  const conflictMemory = runtime.store.upsertMemoryEntry({
    scope: 'agent',
    ownerId: 'ppt',
    agentId: 'ppt',
    departmentId: 'ppt_department',
    memoryType: 'preference',
    content: 'Do not use academic tone for reusable deck introductions.',
    lifecycleState: 'active',
    confidence: 0.6,
    sourceKind: 'check',
    sourceId: 'conflict-memory',
  });
  const forbiddenMemory = runtime.store.upsertMemoryEntry({
    scope: 'agent',
    ownerId: 'ppt',
    agentId: 'ppt',
    departmentId: 'ppt_department',
    memoryType: 'do_not_store',
    content: 'Raw private upload details must be preserved only as a non-reusable counterexample.',
    lifecycleState: 'active',
    confidence: 0.8,
    sourceKind: 'check',
    sourceId: 'do-not-store-memory',
  });
  const typedForbidden = upsertTypedMemory(runtime.db, {
    scope: 'agent',
    ownerId: 'ppt',
    agentId: 'ppt',
    departmentId: 'ppt_department',
    memoryType: 'do_not_store',
    content: 'Do not reuse raw private upload details as future task context.',
    confidence: 0.64,
    evidenceCount: 2,
    sourceKind: 'check',
    sourceId: 'typed-do-not-store-memory',
  });
  assert.equal(typedForbidden.status, 'inserted_blocked');
  const typedForbiddenRow = runtime.db.prepare('SELECT status, privacy_level FROM typed_memories WHERE id = ?').get(typedForbidden.id);
  assert.equal(typedForbiddenRow.status, 'blocked');
  assert.equal(typedForbiddenRow.privacy_level, 'privacy_policy');
  runtime.db.prepare("UPDATE memory_entries SET updated_at = '2026-05-01T00:00:00.000Z' WHERE id = ?").run(staleCandidate.id);
  const memoryPolicy = runtime.store.applyMemoryLifecyclePolicy({ now: new Date('2026-07-01T00:00:00.000Z') });
  assert.ok(memoryPolicy.actions.some((item) => item.action === 'archive_expired' && item.memoryEntryId === expiredMemory.id));
  assert.ok(memoryPolicy.actions.some((item) => item.action === 'archive_duplicate' && item.memoryEntryId === duplicateMemory.id && item.canonicalMemoryEntryId === canonicalMemory.id));
  assert.ok(
    memoryPolicy.actions.some((item) => item.action === 'block_private' && item.memoryEntryId === privateMemory.id)
      || runtime.store.getMemoryEntry(privateMemory.id).lifecycleState === 'blocked',
    'private memory must be blocked either eagerly on write or by the lifecycle policy',
  );
  assert.ok(memoryPolicy.actions.some((item) => item.action === 'archive_stale_candidate' && item.memoryEntryId === staleCandidate.id));
  assert.ok(
    memoryPolicy.actions.some((item) => item.action === 'forbid_reuse' && item.memoryEntryId === forbiddenMemory.id && item.privacyLevel === 'privacy_policy')
      || (
        runtime.store.getMemoryEntry(forbiddenMemory.id).lifecycleState === 'blocked'
        && runtime.store.getMemoryEntry(forbiddenMemory.id).privacyLevel === 'privacy_policy'
      ),
    'do-not-store memory must be blocked either eagerly on write or by the lifecycle policy',
  );
  assert.ok(memoryPolicy.actions.some((item) => (
    item.action === 'flag_conflict' &&
    item.memoryEntryId === conflictMemory.id &&
    item.conflictWithMemoryEntryId === conflictCanonical.id
  )));
  assert.equal(runtime.store.getMemoryEntry(expiredMemory.id).lifecycleState, 'archived');
  assert.equal(runtime.store.getMemoryEntry(duplicateMemory.id).lifecycleState, 'archived');
  assert.equal(runtime.store.getMemoryEntry(canonicalMemory.id).lifecycleState, 'active');
  assert.equal(runtime.store.getMemoryEntry(privateMemory.id).lifecycleState, 'blocked');
  assert.equal(runtime.store.getMemoryEntry(staleCandidate.id).lifecycleState, 'archived');
  assert.equal(runtime.store.getMemoryEntry(conflictCanonical.id).lifecycleState, 'active');
  assert.equal(runtime.store.getMemoryEntry(conflictMemory.id).lifecycleState, 'candidate');
  assert.equal(runtime.store.getMemoryEntry(conflictMemory.id).reviewStatus, 'flag_conflict');
  assert.equal(runtime.store.getMemoryEntry(forbiddenMemory.id).lifecycleState, 'blocked');
  assert.equal(runtime.store.getMemoryEntry(forbiddenMemory.id).privacyLevel, 'privacy_policy');
  assert.ok(
    ['forbid_reuse', 'unreviewed'].includes(runtime.store.getMemoryEntry(forbiddenMemory.id).reviewStatus),
    'eagerly blocked do-not-store memory may not require a later lifecycle review transition',
  );
  const versionCount = runtime.db.prepare(
    `SELECT COUNT(*) AS count
     FROM memory_versions
     WHERE memory_entry_id IN (?, ?, ?, ?, ?, ?)`,
  ).get(expiredMemory.id, duplicateMemory.id, privateMemory.id, staleCandidate.id, conflictMemory.id, forbiddenMemory.id);
  const versionedMemoryIds = new Set(memoryPolicy.actions.map((item) => item.memoryEntryId));
  const expectedVersionCount = [expiredMemory.id, duplicateMemory.id, privateMemory.id, staleCandidate.id, conflictMemory.id, forbiddenMemory.id]
    .filter((id) => versionedMemoryIds.has(id)).length;
  assert.equal(Number(versionCount.count), expectedVersionCount);
  assert.ok(memoryPolicy.audit.actions.length >= 4);

  const notifyTask = runtime.scheduler.createTaskRun({
    title: 'notify graph',
    prompt: '建立一个跨 Agent 通知测试。',
    departmentId: 'general',
  });
  const upstreamNode = runtime.scheduler.addTaskNode(notifyTask.id, {
    title: 'PPT notification source', objective: 'Produce a short PPT evidence note and notify the general lead.',
    departmentId: 'ppt_department', agentId: 'ppt', notify: ['general_agent'], priority: 1,
  });
  assert.ok(upstreamNode.notify.length >= 1);
  const notifiedTarget = upstreamNode.notify[0];
  const notifiedTask = await runtime.scheduler.runReadyNodes(notifyTask.id, { dryRun: true, maxParallel: 1 });
  const notifiedComm = notifiedTask.communications.find((item) => item.status === 'notified' && item.toAgentId === notifiedTarget);
  assert.ok(notifiedComm);
  assert.equal(notifiedComm.blocking, false);
  const notifiedStatus = runtime.store.agentStatuses().find((item) => item.agentId === notifiedTarget);
  assert.equal(notifiedStatus?.openCommunicationCount || 0, 0);

  const dynamic = runtime.scheduler.createTaskRun({
    title: 'dynamic check',
    prompt: '做一个复杂项目并需要动态补充验证节点。',
    departmentId: 'ppt_department',
  });
  const added = runtime.scheduler.addTaskNode(dynamic.id, {
    title: 'Dynamic verification',
    objective: 'Verify a newly discovered requirement.',
    agentId: 'ppt',
    departmentId: 'ppt_department',
  }, { reason: 'new requirement discovered', actorId: 'task_planner' });
  assert.equal(added.status, 'ready');
  assert.equal(added.estimatedMinutes, 20);
  assert.ok(runtime.store.getTaskRun(dynamic.id).revisions.length >= 1);
  const reordered = runtime.scheduler.reprioritizeTaskNode(dynamic.id, added.id, 15, {
    reason: 'urgent verification should run earlier',
    actorId: 'task_planner',
  });
  assert.equal(reordered.priority, 15);
  const dynamicMergeSource = runtime.scheduler.addTaskNode(dynamic.id, {
    title: 'Redundant verification',
    objective: 'Duplicate verification branch that should be merged.',
    agentId: 'ppt',
    departmentId: 'ppt_department',
    priority: 65,
  }, { reason: 'redundant branch discovered', actorId: 'task_planner' });
  const mergeDependent = runtime.scheduler.addTaskNode(dynamic.id, {
    title: 'Dependent after merge',
    objective: 'Should depend on the merged verification target.',
    agentId: 'ppt',
    departmentId: 'ppt_department',
    dependencies: [dynamicMergeSource.id],
    priority: 70,
  }, { reason: 'dependent branch for merge check', actorId: 'task_planner' });
  runtime.scheduler.mergeTaskNodes(dynamic.id, {
    sourceNodeIds: [dynamicMergeSource.id],
    targetNodeId: added.id,
  }, { reason: 'merge redundant verification into dynamic target', actorId: 'task_planner' });
  assert.equal(runtime.store.getTaskNode(dynamicMergeSource.id).status, 'cancelled');
  assert.ok(runtime.store.getTaskNode(mergeDependent.id).dependencies.includes(added.id));
  assert.ok(!runtime.store.getTaskNode(mergeDependent.id).dependencies.includes(dynamicMergeSource.id));
  const cancelCandidate = runtime.scheduler.addTaskNode(dynamic.id, {
    title: 'Cancelled branch',
    objective: 'Branch removed by dynamic replan.',
    agentId: 'ppt',
    departmentId: 'ppt_department',
  }, { reason: 'temporary branch added for cancellation check', actorId: 'task_planner' });
  const cancelDependent = runtime.scheduler.addTaskNode(dynamic.id, {
    title: 'Dependent after cancel',
    objective: 'Should drop the cancelled dependency and continue.',
    agentId: 'ppt',
    departmentId: 'ppt_department',
    dependencies: [cancelCandidate.id],
  }, { reason: 'dependent branch for cancellation check', actorId: 'task_planner' });
  const cancelled = runtime.scheduler.cancelTaskNode(dynamic.id, cancelCandidate.id, {
    reason: 'branch is no longer necessary',
    actorId: 'task_planner',
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(!runtime.store.getTaskNode(cancelDependent.id).dependencies.includes(cancelCandidate.id));
  assert.deepEqual(runtime.store.getTaskNode(cancelDependent.id).dependencies, []);
  const cancelReplacement = runtime.scheduler.addTaskNode(dynamic.id, {
    title: 'Cancelled branch with replacement',
    objective: 'Branch replaced by the dynamic verification target.',
    agentId: 'ppt',
    departmentId: 'ppt_department',
  }, { reason: 'temporary branch added for replacement cancellation check', actorId: 'task_planner' });
  const replacementDependent = runtime.scheduler.addTaskNode(dynamic.id, {
    title: 'Dependent after replacement cancel',
    objective: 'Should depend on the replacement verification target.',
    agentId: 'ppt',
    departmentId: 'ppt_department',
    dependencies: [cancelReplacement.id],
  }, { reason: 'dependent branch for replacement cancellation check', actorId: 'task_planner' });
  runtime.scheduler.cancelTaskNode(dynamic.id, cancelReplacement.id, {
    reason: 'branch replaced by surviving verification target',
    actorId: 'task_planner',
    replacementDependencyIds: [added.id],
  });
  assert.ok(runtime.store.getTaskNode(replacementDependent.id).dependencies.includes(added.id));
  assert.ok(!runtime.store.getTaskNode(replacementDependent.id).dependencies.includes(cancelReplacement.id));
  const dynamicRevisionTypes = runtime.store.getTaskRun(dynamic.id).revisions.map((item) => item.revisionType);
  for (const revisionType of ['add_node', 'reorder_node', 'merge_nodes', 'cancel_node']) {
    assert.ok(dynamicRevisionTypes.includes(revisionType), `missing dynamic revision ${revisionType}`);
  }
  const comm = runtime.store.createCommunication({
    taskRunId: dynamic.id,
    fromAgentId: 'ppt',
    toAgentId: 'researcher',
    purpose: 'Need source evidence',
    requestedInfo: 'Return evidence summary',
    blocking: true,
  });
  const resolved = runtime.scheduler.resolveCommunication(comm.id, {
    responseText: 'Evidence summary ready.',
    responderId: 'researcher',
  });
  assert.equal(resolved.status, 'resolved');
  runtime.store.updateTaskNode(added.id, { status: 'waiting' });
  assert.ok(!runtime.store.readyTaskNodes(dynamic.id).some((node) => node.id === added.id));
  const waitingComm = runtime.store.createCommunication({
    taskRunId: dynamic.id,
    fromAgentId: 'ppt',
    toAgentId: 'researcher',
    purpose: 'Need one more source',
    requestedInfo: 'Return second evidence summary',
    blocking: true,
  });
  runtime.scheduler.resolveCommunication(waitingComm.id, {
    responseText: 'Second evidence summary ready.',
    responderId: 'researcher',
  });
  assert.ok(runtime.store.readyTaskNodes(dynamic.id).some((node) => node.id === added.id));
  runtime.scheduler.addTaskNode(dynamic.id, {
    title: 'Independent status-ready probe',
    objective: 'This node proves an agent can continue separate work while another node waits.',
    agentId: 'ppt',
    departmentId: 'ppt_department',
    priority: 18,
  }, { reason: 'status visibility ready-count check', actorId: 'task_planner' });
  const statusWaitingProbe = runtime.scheduler.addTaskNode(dynamic.id, {
    title: 'Independent status-waiting probe',
    objective: 'This node waits for external input without stopping independent executable work.',
    agentId: 'ppt',
    departmentId: 'ppt_department',
    priority: 19,
  }, { reason: 'status visibility waiting-count check', actorId: 'task_planner' });
  runtime.store.updateTaskNode(statusWaitingProbe.id, {
    status: 'waiting',
    waitReason: 'Waiting for non-blocking external confirmation.',
    timeoutPolicy: 'Continue other ready ppt nodes while this waits.',
  });
  const mixedAgentStatus = runtime.store.agentStatuses().find((item) => item.agentId === 'ppt');
  assert.equal(mixedAgentStatus.status, 'ready');
  assert.ok(mixedAgentStatus.readyCount >= 1);
  assert.ok(mixedAgentStatus.waitingCount >= 1);
  const dependentsBeforeTimeout = runtime.store.getTaskRun(dynamic.id).nodes
    .filter((node) => (node.dependencies || []).includes(added.id))
    .map((node) => node.id);
  assert.ok(dependentsBeforeTimeout.length >= 1);
  runtime.store.updateTaskNode(added.id, {
    status: 'running',
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  const timedOut = runtime.scheduler.applyTimeouts(dynamic.id, { maxRunningMs: 1 });
  assert.equal(timedOut.length, 1);
  assert.equal(timedOut[0].status, 'retry_wait');
  const afterTimeout = runtime.store.getTaskRun(dynamic.id);
  const timeoutFallbacks = afterTimeout.nodes.filter((node) => node.objective.includes(`Timed out node: ${added.id}`));
  assert.equal(timeoutFallbacks.length, 0);
  assert.equal(runtime.store.getTaskNode(added.id).lastErrorCode, 'node_timeout');
  assert.ok(afterTimeout.events.some((item) => item.eventType === 'node_timeout' && item.taskNodeId === added.id));
  assert.ok(afterTimeout.events.some((item) => item.eventType === 'node_retry_scheduled' && item.taskNodeId === added.id));
  for (const dependentId of dependentsBeforeTimeout) {
    const dependent = runtime.store.getTaskNode(dependentId);
    assert.ok(dependent.dependencies.includes(added.id));
  }
  const repeatedTimeout = runtime.scheduler.applyTimeouts(dynamic.id, { maxRunningMs: 1 });
  assert.equal(repeatedTimeout.length, 0);
  assert.equal(runtime.store.getTaskRun(dynamic.id).nodes.filter((node) => node.objective.includes(`Timed out node: ${added.id}`)).length, 0);
  runtime.scheduler.releaseScheduledRetries(dynamic.id, { now: Date.now() + 120_000 });
  runtime.store.updateTaskNode(added.id, {
    status: 'completed',
    resultText: 'Same-Agent timeout retry verification completed.',
    completedAt: new Date().toISOString(),
  });
  const readyAfterRetry = runtime.store.readyTaskNodes(dynamic.id).map((node) => node.id);
  for (const dependentId of dependentsBeforeTimeout) {
    assert.ok(readyAfterRetry.includes(dependentId));
  }
  const statuses = runtime.store.agentStatuses();
  assert.ok(statuses.some((item) => item.agentId === 'ppt'));
  const idleOnlyComm = runtime.store.createCommunication({
    taskRunId: dynamic.id,
    fromAgentId: 'ppt',
    toAgentId: 'secretary_agent',
    purpose: 'Need secretary status check',
    requestedInfo: 'Acknowledge cross-roster waiting state.',
    blocking: true,
  });
  const paperWaiting = runtime.agentStatuses().find((item) => item.agentId === 'secretary_agent');
  assert.equal(paperWaiting.status, 'waiting');
  assert.equal(paperWaiting.openCommunicationCount, 1);
  runtime.scheduler.resolveCommunication(idleOnlyComm.id, {
    responseText: 'Acknowledged.',
    responderId: 'secretary_agent',
  });
  const failedTask = runtime.scheduler.createTaskRun({
    title: 'event triggered review check',
    prompt: '做一个项目执行任务，用于失败触发考核检查。',
    departmentId: 'ppt_department',
  });
  for (const [index, node] of failedTask.nodes.entries()) {
    runtime.store.updateTaskNode(node.id, {
      status: index === 0 ? 'failed' : 'completed',
      errorText: index === 0 ? 'Regression failure for event-triggered review.' : '',
      fallback: index === 0 ? 'Fallback to HR event-triggered review and route correction.' : '',
      resultText: index === 0 ? '' : 'Completed supporting node.',
      completedAt: new Date().toISOString(),
    });
  }
  runtime.scheduler.reconcileTaskStatus(failedTask.id);
  const failedTaskAfter = runtime.store.getTaskRun(failedTask.id);
  assert.equal(failedTaskAfter.status, 'failed');
  assert.ok(failedTaskAfter.retrospective.finalSummary.includes('failed=1'));
  assert.ok(failedTaskAfter.retrospective.finalSummary.includes('retry_or_fallback_events='));
  const failedMetrics = failedTaskAfter.retrospective.skillFindings.find((item) => item.agentId === 'task_scheduler')?.executionMetrics;
  assert.ok(failedMetrics);
  assert.equal(failedMetrics.failedNodes, 1);
  assert.ok(failedMetrics.retryOrFallbackEventCount >= 1);
  const eventReview = runtime.db.prepare(
    `SELECT * FROM agent_performance_reviews
     WHERE source_review_id = ? AND review_type = 'event_triggered' AND agent_id = 'ppt'
     ORDER BY created_at DESC LIMIT 1`,
  ).get(failedTask.id);
  assert.ok(eventReview);
  assert.equal(eventReview.rating, 'observe');
  assert.ok(eventReview.recommendation.includes('Event-triggered HR review'));
  const audit = runtime.store.recordMemoryAudit({ scope: 'task', ownerId: task.id });
  assert.ok(audit.migrationCandidateCount >= 0);

  const originalMaintenanceSync = runtime.cloudSync.requestAutoSync.bind(runtime.cloudSync);
  let releaseMaintenance;
  runtime.cloudSync.requestAutoSync = async () => {
    await new Promise((resolve) => {
      releaseMaintenance = resolve;
    });
    return { status: 'completed_for_lock_check' };
  };
  const firstMaintenance = runtime.runMaintenanceSafely({ respectActiveRuns: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const secondMaintenance = await runtime.runMaintenanceSafely({ respectActiveRuns: false });
  assert.equal(secondMaintenance.status, 'deferred');
  assert.ok(secondMaintenance.reason.includes('already in progress'));
  releaseMaintenance();
  const completedMaintenance = await firstMaintenance;
  assert.equal(completedMaintenance.authority, 'cloud');
  assert.equal(completedMaintenance.sync.status, 'completed_for_lock_check');
  assert.equal(runtime.store.settingGet('maintenance:lock', ''), '');
  runtime.cloudSync.requestAutoSync = originalMaintenanceSync;

  const careerPromote = runtime.evolution.transitionAgentCareer({ agentId: 'ppt', action: 'promote', reviewerId: 'check', reason: 'controlled promotion fixture' });
  assert.equal(careerPromote.nextRank, 'senior');
  assert.equal(runtime.org.agent('ppt').permissions.canLeadTask, true);
  const careerProbation = runtime.evolution.transitionAgentCareer({ agentId: 'ppt', action: 'probation', reviewerId: 'check', reason: 'controlled probation fixture', probationDays: 7 });
  assert.equal(careerProbation.status, 'probation');
  assert.equal(runtime.org.agent('ppt').routable, false);
  const careerRestore = runtime.evolution.transitionAgentCareer({ agentId: 'ppt', action: 'restore', reviewerId: 'check', reason: 'controlled restore fixture' });
  assert.equal(careerRestore.status, 'active');
  assert.equal(runtime.org.agent('ppt').routable, true);
  assert.equal(runtime.evolution.organizationReviewDue('new_department_without_history'), true);
  runtime.evolution.markOrganizationReviewComplete('new_department_without_history', new Date().toISOString());
  assert.equal(runtime.evolution.organizationReviewDue('new_department_without_history'), false);
  const dailyReviewDepartment = 'daily_review_schedule_check';
  runtime.evolution.markOrganizationReviewComplete(dailyReviewDepartment, new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString());
  assert.equal(runtime.evolution.organizationReviewDue(dailyReviewDepartment), false);
  runtime.evolution.markOrganizationReviewComplete(dailyReviewDepartment, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
  assert.equal(runtime.evolution.organizationReviewDue(dailyReviewDepartment), true);

  const agentBundle = buildAgentBundle({
    departmentsRoot: path.join(tmp, 'departments'),
    skillsRoot: path.join(process.cwd(), 'assets', 'skills'),
    appVersion: '0.1.0',
    releaseVersion: '0.1.1',
    sourceMaintenanceRunId: 'maintenance_check',
    changeSummary: 'Agent bundle check fixture.',
  });
  const bundleValidation = validateAgentBundle(agentBundle);
  assert.equal(agentBundle.releaseVersion, '0.1.1');
  assert.equal(bundleValidation.bundleId, agentBundle.bundleId);
  assert.ok(bundleValidation.fileCount > 10);
  assert.equal(agentBundle.files.some((item) => path.basename(item.path) === 'MEMORY.md'), false, 'public Agent bundles must not publish runtime user memory');
  assert.equal(bundleValidation.skillPackageCount, 1);
  const signingKeys = crypto.generateKeyPairSync('ed25519');
  const signingPrivatePem = signingKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const signingPublicPem = signingKeys.publicKey.export({ type: 'spki', format: 'pem' });
  signAgentBundle(agentBundle, { privateKeyPem: signingPrivatePem });
  assert.equal(verifyAgentBundleSignature(agentBundle, { publicKeyPem: signingPublicPem }).valid, true);
  const windowsPublicPem = signingPublicPem.replace(/\n/g, '\r\n');
  assert.equal(
    verifyAgentBundleSignature(agentBundle, { publicKeyPem: windowsPublicPem }).signingKeyId,
    agentBundle.signingKeyId,
    'Agent signing key IDs must be based on the parsed key, not platform-specific PEM line endings',
  );
  const automaticBundleRoot = path.join(tmp, 'automatic-agent-bundle-update');
  const automaticBundleText = `${JSON.stringify(agentBundle, null, 2)}\n`;
  const automaticBundleSha256 = crypto.createHash('sha256').update(automaticBundleText).digest('hex');
  const automaticBundlePublicKey = path.join(tmp, 'automatic-agent-bundle-public.pem');
  writeFileSync(automaticBundlePublicKey, signingPublicPem);
  const previousAgentSigningKey = process.env.JANUS_RELEASE_SIGNING_PUBLIC_KEY;
  process.env.JANUS_RELEASE_SIGNING_PUBLIC_KEY = automaticBundlePublicKey;
  try {
    const automaticBundleService = createAgentBundleService({
      root: automaticBundleRoot,
      appVersion: '0.1.0',
      fetchImpl: async (url) => String(url).includes('/v1/releases/latest?')
        ? new Response(JSON.stringify({
            manifest: {
              version: '0.1.1',
              artifacts: [{
                kind: 'agent_bundle',
                bundleId: agentBundle.bundleId,
                releaseVersion: '0.1.1',
                minAppVersion: '0.1.0',
                sha256: automaticBundleSha256,
                url: '/v1/releases/artifacts/agents%2F0.1.1%2Fautomatic-agent-bundle.json',
              }],
            },
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(automaticBundleText, { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const automaticBundleStatus = await automaticBundleService.checkNow();
    assert.equal(automaticBundleStatus.available, false);
    assert.equal(automaticBundleStatus.downloaded, false);
    assert.equal(automaticBundleStatus.current.releaseVersion, '0.1.1');
    assert.equal(readInstalledAgentBundle(automaticBundleRoot).bundleId, agentBundle.bundleId);
  } finally {
    if (previousAgentSigningKey === undefined) delete process.env.JANUS_RELEASE_SIGNING_PUBLIC_KEY;
    else process.env.JANUS_RELEASE_SIGNING_PUBLIC_KEY = previousAgentSigningKey;
  }
  const updateZipPath = path.join(tmp, 'Janus-0.1.1-arm64.zip');
  writeFileSync(updateZipPath, 'signed macOS update fixture');
  const updateSha512 = crypto.createHash('sha512').update(readFileSync(updateZipPath)).digest('base64');
  const updateSize = readFileSync(updateZipPath).length;
  const updateMetadata = signUpdateMetadata({
    version: '0.1.1',
    file: path.basename(updateZipPath),
    sha512: updateSha512,
    size: updateSize,
  }, signingPrivatePem);
  assert.equal(verifyUpdateMetadata(updateMetadata, signingPublicPem).valid, true);
  const parsedUpdateManifest = readMacUpdateSignatureManifest([
    "janusInstallMode: 'custom-macos'",
    'janusUpdateSignature:',
    `  schemaVersion: ${updateMetadata.schemaVersion}`,
    `  algorithm: '${updateMetadata.algorithm}'`,
    `  keyId: '${updateMetadata.keyId}'`,
    `  version: '${updateMetadata.version}'`,
    `  file: '${updateMetadata.file}'`,
    `  sha512: '${updateMetadata.sha512}'`,
    `  size: ${updateMetadata.size}`,
    `  signature: '${updateMetadata.signature}'`,
    '',
  ].join('\n'));
  assert.equal(parsedUpdateManifest.installMode, 'custom-macos');
  assert.equal(verifyUpdateMetadata(parsedUpdateManifest.metadata, signingPublicPem).valid, true);
  assert.equal((await verifyMacUpdatePackage({
    file: updateZipPath,
    updateInfo: {
      version: '0.1.1',
      files: [{ url: `0.1.1/${path.basename(updateZipPath)}`, sha512: updateSha512, size: updateSize }],
      janusUpdateSignature: updateMetadata,
    },
    publicKeyPem: signingPublicPem,
  })).actualSha512, updateSha512);
  assert.equal(macAppBundleFromExecutable('/Applications/Janus.app/Contents/MacOS/Janus'), '/Applications/Janus.app');
  const signingScriptDist = path.join(tmp, 'mac-signing-dist');
  const signingPrivateKeyPath = path.join(tmp, 'update-signing-private.pem');
  const signingPublicKeyPath = path.join(tmp, 'update-signing-public.pem');
  mkdirSync(signingScriptDist, { recursive: true });
  writeFileSync(signingPrivateKeyPath, signingPrivatePem);
  writeFileSync(signingPublicKeyPath, signingPublicPem);
  writeFileSync(path.join(signingScriptDist, path.basename(updateZipPath)), readFileSync(updateZipPath));
  writeFileSync(path.join(signingScriptDist, 'latest-mac.yml'), [
    'version: 0.1.1',
    'files:',
    `  - url: ${path.basename(updateZipPath)}`,
    `    sha512: ${updateSha512}`,
    `    size: ${updateSize}`,
    `path: ${path.basename(updateZipPath)}`,
    `sha512: ${updateSha512}`,
    'releaseDate: 2026-07-18T00:00:00.000Z',
    '',
  ].join('\n'));
  execFileSync(process.execPath, [
    'scripts/sign_desktop_update.mjs',
    '--platform', 'macos',
    '--dist', signingScriptDist,
    '--private-key', signingPrivateKeyPath,
    '--install-mode', 'custom-macos',
  ], { cwd: process.cwd(), stdio: 'pipe' });
  const signedScriptManifest = readFileSync(path.join(signingScriptDist, 'latest-mac.yml'), 'utf8');
  const signedScriptMetadata = readMacUpdateSignatureManifest(signedScriptManifest);
  assert.equal(signedScriptMetadata.installMode, 'custom-macos');
  assert.equal(verifyUpdateMetadata(signedScriptMetadata.metadata, signingPublicPem).valid, true);

  const releaseNotesSigningDist = path.join(tmp, 'release-notes-signing-dist');
  const releaseNotesArtifact = path.join(releaseNotesSigningDist, 'Janus-0.2.20-arm64.zip');
  mkdirSync(releaseNotesSigningDist, { recursive: true });
  writeFileSync(releaseNotesArtifact, 'release notes signing fixture');
  const releaseNotesSha512 = crypto.createHash('sha512').update(readFileSync(releaseNotesArtifact)).digest('base64');
  const releaseNotesSize = readFileSync(releaseNotesArtifact).length;
  writeFileSync(path.join(releaseNotesSigningDist, 'latest-mac.yml'), [
    'version: 0.2.20',
    'files:',
    `  - url: ${path.basename(releaseNotesArtifact)}`,
    `    sha512: ${releaseNotesSha512}`,
    `    size: ${releaseNotesSize}`,
    `path: ${path.basename(releaseNotesArtifact)}`,
    `sha512: ${releaseNotesSha512}`,
    '',
  ].join('\n'));
  execFileSync(process.execPath, [
    'scripts/sign_desktop_update.mjs',
    '--platform', 'macos',
    '--dist', releaseNotesSigningDist,
    '--private-key', signingPrivateKeyPath,
    '--install-mode', 'custom-macos',
  ], { cwd: process.cwd(), stdio: 'pipe' });
  const releaseNotesManifest = readFileSync(path.join(releaseNotesSigningDist, 'latest-mac.yml'), 'utf8');
  assert.match(releaseNotesManifest, /releaseName: '消息、组织与更新体验进一步统一'/);
  assert.match(releaseNotesManifest, /releaseNotes: \|-\n  集中统一桌面端/);

  const releaseCloudHome = path.join(tmp, 'runner-release-cloud');
  execFileSync(process.execPath, ['scripts/cloud.mjs', 'init'], {
    cwd: process.cwd(),
    env: { ...process.env, JANUS_CLOUD_HOME: releaseCloudHome },
    stdio: 'pipe',
  });
  const macIncoming = path.join(releaseCloudHome, 'incoming', 'macos-check');
  mkdirSync(macIncoming, { recursive: true });
  writeFileSync(path.join(macIncoming, path.basename(updateZipPath)), readFileSync(updateZipPath));
  writeFileSync(path.join(macIncoming, 'Janus-0.1.1-arm64.dmg'), 'dmg fixture');
  writeFileSync(path.join(macIncoming, 'latest-mac.yml'), signedScriptManifest);
  execFileSync(process.execPath, [
    'scripts/register_macos_release.mjs', '--version', '0.1.1', '--incoming', macIncoming,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, JANUS_CLOUD_HOME: releaseCloudHome, JANUS_RELEASE_SIGNING_PUBLIC_KEY: signingPublicKeyPath },
    stdio: 'pipe',
  });
  assert.equal(readlinkSync(path.join(releaseCloudHome, 'releases', 'macos', 'latest-mac.yml')), '0.1.1/latest-mac.yml');
  assert.match(readFileSync(path.join(releaseCloudHome, 'releases', 'latest-mac.yml'), 'utf8'), /url: macos\/0\.1\.1\//);
  assert.ok(existsSync(path.join(releaseCloudHome, 'releases', 'macos', '0.1.1', path.basename(updateZipPath))));
  assert.deepEqual(await promoteDesktopPlatformFeed(releaseCloudHome, 'macos', '0.1.1'), {
    status: 'promoted',
    platform: 'macos',
    version: '0.1.1',
  });
  assert.equal(readlinkSync(path.join(releaseCloudHome, 'releases', 'macos', 'latest-mac.yml')), '0.1.1/latest-mac.yml');
  assert.match(readFileSync(path.join(releaseCloudHome, 'releases', 'latest-mac.yml'), 'utf8'), /url: macos\/0\.1\.1\//);

  const windowsIncoming = path.join(releaseCloudHome, 'incoming', 'windows-check');
  const windowsSigningBin = path.join(tmp, 'windows-signing-bin');
  const fakeOsslSigncode = path.join(windowsSigningBin, 'osslsigncode');
  mkdirSync(windowsSigningBin, { recursive: true });
  writeFileSync(fakeOsslSigncode, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "osslsigncode test fixture"; exit 0; fi\necho "Signature verification: ok"\necho "Subject: CN=Janus Test Publisher"\n');
  chmodSync(fakeOsslSigncode, 0o755);
  const windowsReleaseTestEnv = {
    ...process.env,
    PATH: `${windowsSigningBin}${path.delimiter}${process.env.PATH || ''}`,
    JANUS_CLOUD_HOME: releaseCloudHome,
    JANUS_RELEASE_SIGNING_PUBLIC_KEY: signingPublicKeyPath,
    JANUS_WINDOWS_PUBLISHER_NAME: 'Janus Test Publisher',
  };
  const windowsExe = 'Janus Setup 0.1.1.exe';
  const windowsExeContent = Buffer.from('nsis fixture');
  const windowsExeSha512 = crypto.createHash('sha512').update(windowsExeContent).digest('base64');
  mkdirSync(windowsIncoming, { recursive: true });
  writeFileSync(path.join(windowsIncoming, windowsExe), windowsExeContent);
  writeFileSync(path.join(windowsIncoming, `${windowsExe}.blockmap`), 'blockmap fixture');
  writeFileSync(path.join(windowsIncoming, 'latest.yml'), [
    'version: 0.1.1',
    'files:',
    `  - url: ${windowsExe}`,
    `    sha512: ${windowsExeSha512}`,
    `    size: ${windowsExeContent.length}`,
    `path: ${windowsExe}`,
    `sha512: ${windowsExeSha512}`,
    'releaseDate: 2026-07-18T00:00:00.000Z',
    '',
  ].join('\n'));
  execFileSync(process.execPath, [
    'scripts/sign_desktop_update.mjs',
    '--platform', 'windows',
    '--dist', windowsIncoming,
    '--private-key', signingPrivateKeyPath,
  ], { cwd: process.cwd(), stdio: 'pipe' });
  execFileSync(process.execPath, [
    'scripts/register_windows_release.mjs', '--version', '0.1.1', '--incoming', windowsIncoming,
  ], {
    cwd: process.cwd(),
    env: windowsReleaseTestEnv,
    stdio: 'pipe',
  });
  assert.equal(readlinkSync(path.join(releaseCloudHome, 'releases', 'windows', 'latest.yml')), '0.1.1/latest.yml');
  assert.match(readFileSync(path.join(releaseCloudHome, 'releases', 'latest.yml'), 'utf8'), /url: windows\/0\.1\.1\//);
  assert.ok(existsSync(path.join(releaseCloudHome, 'releases', 'windows', '0.1.1', windowsExe)));

  const linuxIncoming = path.join(releaseCloudHome, 'incoming', 'linux-check');
  const linuxAppImage = 'Janus-0.1.1-x86_64.AppImage';
  const linuxAppImageContent = Buffer.from('appimage fixture');
  const linuxAppImageSha512 = crypto.createHash('sha512').update(linuxAppImageContent).digest('base64');
  mkdirSync(linuxIncoming, { recursive: true });
  writeFileSync(path.join(linuxIncoming, linuxAppImage), linuxAppImageContent);
  writeFileSync(path.join(linuxIncoming, 'latest-linux.yml'), [
    'version: 0.1.1',
    'files:',
    `  - url: ${linuxAppImage}`,
    `    sha512: ${linuxAppImageSha512}`,
    `    size: ${linuxAppImageContent.length}`,
    `path: ${linuxAppImage}`,
    `sha512: ${linuxAppImageSha512}`,
    'releaseDate: 2026-07-18T00:00:00.000Z',
    '',
  ].join('\n'));
  execFileSync(process.execPath, [
    'scripts/sign_desktop_update.mjs',
    '--platform', 'linux',
    '--dist', linuxIncoming,
    '--private-key', signingPrivateKeyPath,
  ], { cwd: process.cwd(), stdio: 'pipe' });
  execFileSync(process.execPath, [
    'scripts/register_linux_release.mjs', '--version', '0.1.1', '--incoming', linuxIncoming,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, JANUS_CLOUD_HOME: releaseCloudHome, JANUS_RELEASE_SIGNING_PUBLIC_KEY: signingPublicKeyPath },
    stdio: 'pipe',
  });
  assert.equal(readlinkSync(path.join(releaseCloudHome, 'releases', 'linux', 'latest-linux.yml')), '0.1.1/latest-linux.yml');
  assert.equal(readlinkSync(path.join(releaseCloudHome, 'releases', 'macos', 'latest-mac.yml')), '0.1.1/latest-mac.yml');
  assert.equal(readlinkSync(path.join(releaseCloudHome, 'releases', 'windows', 'latest.yml')), '0.1.1/latest.yml');
  assert.ok(existsSync(path.join(releaseCloudHome, 'releases', 'linux', '0.1.1', linuxAppImage)));
  const legacyWindowsManifest = readFileSync(path.join(releaseCloudHome, 'releases', 'latest.yml'), 'utf8');
  assert.match(legacyWindowsManifest, /url: windows\/0\.1\.1\/Janus Setup 0\.1\.1\.exe/);
  assert.match(legacyWindowsManifest, /path: windows\/0\.1\.1\/Janus Setup 0\.1\.1\.exe/);
  assert.doesNotMatch(legacyWindowsManifest, /file: windows\//);
  assert.match(readFileSync(path.join(releaseCloudHome, 'releases', 'latest-mac.yml'), 'utf8'), /url: macos\/0\.1\.1\//);
  assert.match(readFileSync(path.join(releaseCloudHome, 'releases', 'latest-linux.yml'), 'utf8'), /url: linux\/0\.1\.1\//);
  for (const [platform, registrationScript] of [
    ['macos', 'scripts/register_macos_release.mjs'],
    ['windows', 'scripts/register_windows_release.mjs'],
    ['linux', 'scripts/register_linux_release.mjs'],
  ]) {
    const sourceDirectory = path.join(releaseCloudHome, 'releases', platform, '0.1.1');
    const testIncoming = path.join(releaseCloudHome, 'incoming', `${platform}-test-check`);
    mkdirSync(testIncoming, { recursive: true });
    for (const name of readdirSync(sourceDirectory)) {
      copyFileSync(path.join(sourceDirectory, name), path.join(testIncoming, name));
    }
    execFileSync(process.execPath, [
      registrationScript,
      '--version', '0.1.1',
      '--incoming', testIncoming,
      '--releases-dir', 'test_releases',
    ], {
      cwd: process.cwd(),
      env: platform === 'windows'
        ? windowsReleaseTestEnv
        : { ...process.env, JANUS_CLOUD_HOME: releaseCloudHome, JANUS_RELEASE_SIGNING_PUBLIC_KEY: signingPublicKeyPath },
      stdio: 'pipe',
    });
  }
  assert.equal(readlinkSync(path.join(releaseCloudHome, 'test_releases', 'linux', 'latest-linux.yml')), '0.1.1/latest-linux.yml');
  assert.equal(readlinkSync(path.join(releaseCloudHome, 'test_releases', 'macos', 'latest-mac.yml')), '0.1.1/latest-mac.yml');
  assert.equal(readlinkSync(path.join(releaseCloudHome, 'test_releases', 'windows', 'latest.yml')), '0.1.1/latest.yml');
  assert.ok(readFileSync(path.join(releaseCloudHome, 'test_releases', 'latest.yml'), 'utf8').includes('url: windows/0.1.1/'));
  const uninstalledBundleClientRoot = path.join(tmp, 'bundle-client-uninstalled');
  applyAgentBundle({ root: uninstalledBundleClientRoot, bundle: agentBundle });
  assert.equal(isSkillPackageInstalled(uninstalledBundleClientRoot, 'ppt_creation'), false);
  assert.equal(existsSync(skillPackageInstallRoot(uninstalledBundleClientRoot, 'ppt_creation')), false);
  assert.equal(existsSync(path.join(skillPackageCatalogRoot(uninstalledBundleClientRoot, 'ppt_creation'), '.package.json')), true);
  const registeredPlugins = pluginCatalog(uninstalledBundleClientRoot, { appVersion: '9.8.7' });
  const registeredPptPlugin = registeredPlugins.find((plugin) => plugin.id === 'ppt_creation');
  assert.ok(registeredPptPlugin, 'generic plugin catalog must expose the PPT creation plugin');
  assert.deepEqual(registeredPptPlugin.providesAgentIds, ['ppt']);
  assert.equal(registeredPptPlugin.category, 'content');
  assert.equal(registeredPptPlugin.chatTarget, 'pptx');
  assert.equal(registeredPptPlugin.status.version, '9.8.7');
  assert.equal(registeredPptPlugin.status.availableVersion, '9.8.7');
  assert.deepEqual(pluginStatus(uninstalledBundleClientRoot, 'ppt_creation', { appVersion: '9.8.7' }), registeredPptPlugin);
  assert.throws(() => pluginStatus(uninstalledBundleClientRoot, 'unknown_plugin'), /Unknown plugin/);

  const bundleClientRoot = path.join(tmp, 'bundle-client');
  const existingSkill = path.join(skillPackageInstallRoot(bundleClientRoot, 'ppt_creation'), 'departments', 'ppt_department', 'agents', 'ppt', 'SKILL.md');
  mkdirSync(path.dirname(existingSkill), { recursive: true });
  writeFileSync(existingSkill, 'client-local-skill-before-bundle\n');
  setSkillPackageInstalled(bundleClientRoot, 'ppt_creation', true, { source: 'local', version: '0.1.0' });
  const staleInstalledPlugin = pluginStatus(bundleClientRoot, 'ppt_creation', { appVersion: '9.8.7' });
  assert.equal(staleInstalledPlugin.status.version, '9.8.7');
  assert.equal(staleInstalledPlugin.status.packageVersion, '0.1.0');
  const installedBundle = applyAgentBundle({ root: bundleClientRoot, bundle: agentBundle });
  assert.equal(installedBundle.releaseVersion, '0.1.1');
  assert.equal(installedBundle.bundleId, agentBundle.bundleId);
  assert.notEqual(readFileSync(existingSkill, 'utf8'), 'client-local-skill-before-bundle\n');
  const rolledBackBundle = rollbackAgentBundle({ root: bundleClientRoot });
  assert.equal(rolledBackBundle.rolledBackBundleId, agentBundle.bundleId);
  assert.equal(readFileSync(existingSkill, 'utf8'), 'client-local-skill-before-bundle\n');
  assert.equal(isSkillPackageInstalled(bundleClientRoot, 'ppt_creation'), true);

  await assertImageSessionContinuity(tmp);

  runtime.close();
  console.log('check passed');
} finally {
  if (priorTaskMemoryPublicKeys === undefined) delete process.env.JANUS_TASK_MEMORY_CLOUD_PUBLIC_KEYS_JSON;
  else process.env.JANUS_TASK_MEMORY_CLOUD_PUBLIC_KEYS_JSON = priorTaskMemoryPublicKeys;
  if (priorTaskMemoryPrivateKeys === undefined) delete process.env.JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON;
  else process.env.JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON = priorTaskMemoryPrivateKeys;
  if (priorTaskMemoryActiveKey === undefined) delete process.env.JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID;
  else process.env.JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID = priorTaskMemoryActiveKey;
  await cleanupTempDir(tmp);
}

function readFileSyncUtf8(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

async function assertImageSessionContinuity(tmp) {
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const root = path.join(tmp, 'image-session-continuity');
  const runtime = await createRuntime({ root, isDev: true });
  try {
    runtime.saveCodexConfig({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-image-session-check',
      model: 'gpt-5.5',
      reviewModel: 'gpt-5.5',
      reasoningEffort: 'medium',
    });
    const session = runtime.store.createSession({
      title: '同一对话图片测试',
      departmentId: 'general',
      userId: 'local_admin',
    });
    runtime.store.updateSessionThread(session.id, 'existing-codex-thread');
    const result = await runtime.sendChat({
      chatMode: 'image',
      sessionId: session.id,
      message: '在当前对话生成图片',
      imageModel: 'gpt-image-2',
      inlineImageMode: true,
      imageHostDepartmentId: 'general',
      imageHostAgentId: '',
    });
    assert.equal(result.session.id, session.id, 'image mode must reuse the active conversation');
    assert.equal(result.session.codexThreadId, 'existing-codex-thread', 'inline image mode must preserve the text conversation thread');
    assert.equal(runtime.store.listMessages(session.id).length, 3, 'image turn must remain fully stored in the active conversation');
  } finally {
    runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function assertNetworkClients(tmp) {
  const timedSocialClient = new SocialClient({
    timeoutMs: 10,
    fetchImpl: async (_url, options = {}) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });
  await assert.rejects(
    () => timedSocialClient.me({ server_url: 'https://social.example', access_token: 'test-token' }),
    /Request timed out after 10ms/,
    'social collaboration requests must fail within a bounded time instead of hanging forever',
  );
  const socialClient = new SocialClient({
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: '账号或密码不正确。' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(
    () => socialClient.login({ server_url: 'https://social.example' }, { identifier: 'test', password: 'bad-password' }),
    (error) => {
      assert.equal(error.name, 'NetworkRequestError');
      assert.equal(error.message, '账号或密码不正确。');
      assert.equal(error.status, 401);
      assert.equal(error.method, 'POST');
      assert.equal(error.route, '/api/auth/login');
      return true;
    },
  );

  const failingCloudClient = new CloudSyncClient({
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: '该数据已经更新，请刷新后重试。' } }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(
    () => failingCloudClient.submitBatch({ server_url: 'https://cloud.example', token: 'test-token' }, { batch: {} }),
    (error) => {
      assert.equal(error.message, '该数据已经更新，请刷新后重试。');
      assert.equal(error.status, 409);
      assert.equal(error.route, '/v1/sync/batches');
      return true;
    },
  );

  const cloudRequests = [];
  const cloudClient = new CloudSyncClient({
    fetchImpl: async (url, options = {}) => {
      cloudRequests.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const cloudResult = await cloudClient.submitBatch(
    { server_url: 'https://cloud.example/root/', token: 'tok_test' },
    { batch: { id: 'batch_test' }, files: [] },
  );
  assert.equal(cloudResult.ok, true);
  assert.equal(cloudRequests[0].url, 'https://cloud.example/v1/sync/batches');
  assert.equal(cloudRequests[0].options.method, 'POST');
  assert.equal(cloudRequests[0].options.headers.authorization, 'Bearer tok_test');
  assert.equal(cloudRequests[0].options.headers['content-type'], 'application/json');

  const sourceA = path.join(tmp, 'openai-source-a.png');
  const sourceB = path.join(tmp, 'openai-source-b.png');
  writeFileSync(sourceA, Buffer.from('a'));
  writeFileSync(sourceB, Buffer.from('b'));
  const imageCalls = [];
  const imageClient = new OpenAIImagesClient({
    apiKey: 'sk-test-image',
    apiBase: 'https://api.example',
    fetchImpl: async (url, options = {}) => {
      const keys = options.body?.keys ? [...options.body.keys()] : [];
      imageCalls.push({ url, options, keys });
      if (imageCalls.length === 1) {
        return new Response(JSON.stringify({ error: { message: 'first multipart shape rejected' } }), { status: 400 });
      }
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('ok').toString('base64') }] }), { status: 200 });
    },
  });
  const editResponse = await imageClient.editImages(
    { model: 'gpt-image-test', prompt: 'edit', size: '1024x1024', n: '1' },
    [
      { path: sourceA, mediaType: 'image/png' },
      { path: sourceB, mediaType: 'image/png' },
    ],
  );
  const bytes = await imageClient.imageBytesFromResponse(editResponse, '图片编辑');
  assert.equal(bytes.toString('utf8'), 'ok');
  assert.deepEqual(imageCalls[0].keys.filter((key) => key === 'image'), ['image', 'image']);
  assert.deepEqual(imageCalls[1].keys.filter((key) => key === 'image[]'), ['image[]', 'image[]']);
  assert.equal(imageCalls[0].options.headers.Authorization, 'Bearer sk-test-image');
  assert.equal(imageCalls[1].url, 'https://api.example/v1/images/edits');
}

async function assertCloudEvolutionAuthority(tmp) {
  assert.equal(cloudEvolutionAuthorityEnabled({}), true, 'cloud evolution authority must be permanently enabled');
  assert.equal(cloudEvolutionAuthorityEnabled({ JANUS_CLOUD_EVOLUTION_AUTHORITY: 'false' }), true);
  assert.equal(cloudEvolutionAuthorityEnabled({ JANUS_CLOUD_EVOLUTION_AUTHORITY: 'true' }), true);
  const privacySample = 'email leak@example.com path /private/project/file URL https://private.example access_token = a multi word value sk-abcdefghijklmnop';
  assert.ok(evolutionPrivacyFindings(privacySample).length >= 5);
  assert.doesNotMatch(redactEvolutionPrivateText(privacySample), /leak@example\.com|\/private\/project|private\.example|multi word value|sk-abcdefghijklmnop/);

  const home = path.join(tmp, 'cloud-evolution-authority-check');
  const db = openCloudDatabase(home);
  const now = new Date().toISOString();
  const keyring = { activeKeyId: 'check', keys: { check: Buffer.alloc(32, 9).toString('base64') }, allowPlaintextTestOnly: false };
  const env = {
    JANUS_CLOUD_EVOLUTION_AUTHORITY: 'true',
    JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID: process.env.JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID,
    JANUS_TASK_MEMORY_CLOUD_PUBLIC_KEYS_JSON: process.env.JANUS_TASK_MEMORY_CLOUD_PUBLIC_KEYS_JSON,
    JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON: process.env.JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON,
  };
  const seed = ({ userId = 'evolution_user', instanceId = 'evolution_instance', familyId = 'evolution_family', autoActivate = 0, consent = 1 } = {}) => {
    db.prepare(`INSERT OR IGNORE INTO cloud_agent_families_v3 (id,department_id,name,role,status,routable,current_version_id,payload_json,updated_at)
      VALUES (?, 'general', ?, 'agent', 'active', 1, ?, ?, ?)`).run(familyId, familyId, `${familyId}_base`, JSON.stringify({ id: familyId, departmentId: 'general' }), now);
    db.prepare(`INSERT OR IGNORE INTO cloud_agent_versions_v3 (id,agent_family_id,content_hash,payload_json,created_at)
      VALUES (?, ?, ?, ?, ?)`).run(`${familyId}_base`, familyId, `${familyId}_hash`, JSON.stringify({ id: `${familyId}_base`, baseSkillContent: '# Base Skill\n' }), now);
    db.prepare(`INSERT INTO cloud_user_agent_instances_v3 (
      user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,personal_evolution_consent,personal_skill_auto_activate,payload_json,created_at,updated_at
    ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, '{}', ?, ?)`).run(userId, instanceId, familyId, `${familyId}_base`, consent, autoActivate, now, now);
  };
  seed();
  const memoryId = 'evolution_memory';
  const memoryVersionId = 'evolution_memory_v1';
  const memoryContent = '# Memory\n\n## Workflow Notes\n- Existing rule\n';
  const memoryHash = crypto.createHash('sha256').update(memoryContent).digest('hex');
  db.prepare(`INSERT INTO cloud_memory_documents_v3 (
    user_id,id,user_agent_instance_id,scope,slot_no,current_version_id,lifecycle_state,sync_enabled,allow_personal_evolution,payload_json,created_at,updated_at
  ) VALUES ('evolution_user',?, 'evolution_instance','general',0,'','active',1,0,'{}',?,?)`).run(memoryId, now, now);
  db.prepare(`INSERT INTO cloud_memory_document_versions_v3 (user_id,id,memory_document_id,version_no,content_hash,payload_json,created_at)
    VALUES ('evolution_user',?,?,1,?,?,?)`).run(memoryVersionId, memoryId, memoryHash, JSON.stringify({ id: memoryVersionId, memoryDocumentId: memoryId, content: memoryContent }), now);
  db.prepare(`UPDATE cloud_memory_documents_v3 SET current_version_id=? WHERE user_id='evolution_user' AND id=?`).run(memoryVersionId, memoryId);

  const approvedModel = async ({ kind, prompt = '' }) => {
    if (kind === 'personal_proposal') {
      const diagnosisText = String(prompt).match(/Diagnosis:\n([^\n]+)\nEvidence:/)?.[1] || '{}';
      const diagnosis = JSON.parse(diagnosisText);
      const recommendation = diagnosis.recommendation || diagnosis.primary_layer || 'Verify evidence before delivery.';
      return JSON.stringify({
      summary: 'Use evidence-first checks.', overlay_text: `## Personal Procedure\n- ${recommendation}`,
      memory_operations: [{ memory_document_id: memoryId, section_name: 'Workflow Notes', operation_type: 'add', target_item_hash: '', proposed_text: 'Verify evidence before final delivery.', rationale: 'Reusable workflow improvement.' }],
      eval_cases: [{ input: 'Prepare a result.', expected: 'Verify evidence first.' }], risks: ['Avoid overfitting.'],
      });
    }
    if (kind === 'personal_review') return JSON.stringify({ decision: 'full', rationale: 'Narrow and testable.', risks: [] });
    if (kind === 'personal_replay_before') return 'Deliver result.';
    if (kind === 'personal_replay_after') return 'Verify evidence, then deliver result.';
    if (kind === 'personal_replay_judge') return JSON.stringify({ winner: 'after', before_score: 0.5, after_score: 0.9, rationale: 'Improved.' });
    throw new Error(`unexpected evolution model kind ${kind}`);
  };
  const authority = createEvolutionAuthority({ db, env, keyring, modelExecutor: approvedModel });
  assert.equal(authority.capabilities().personal.enabled, true);
  assert.equal(authority.capabilities().taskMemoryEncryption.available, true);
  assert.equal(createEvolutionAuthority({ db, env: {}, keyring, modelExecutor: approvedModel }).capabilities().personal.enabled, true);
  const readOnlyGrantToken = authority.issueGrant({ userId: 'evolution_user', deviceId: 'read_device', scopes: ['evolution:read'] }).token;
  assert.throws(() => authority.requireGrant(readOnlyGrantToken, 'evolution:write'), (error) => error.code === 'evolution_grant_scope_denied');
  const grantToken = authority.issueGrant({ userId: 'evolution_user', deviceId: 'evolution_device' }).token;
  const grant = authority.requireGrant(grantToken, 'evolution:write');
  db.prepare("UPDATE cloud_sync_grants SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id='evolution_user' AND device_id='read_device'").run();
  assert.throws(() => authority.requireGrant(readOnlyGrantToken, 'evolution:read'), (error) => error.code === 'evolution_grant_invalid');
  assert.equal(authority.revokeGrant({ userId: 'evolution_user', deviceId: 'read_device' }).status, 'revoked');

  const missingKeyAuthority = createEvolutionAuthority({ db, env, keyring: { activeKeyId: '', keys: {}, allowPlaintextTestOnly: false }, modelExecutor: approvedModel });
  assert.throws(() => missingKeyAuthority.ingestEvidence(grant, [{ userAgentInstanceId: 'evolution_instance', sourceKind: 'message', sourceId: 'missing_key', content: 'evidence', allowedEvolutionScopes: ['personal'] }]), (error) => error.code === 'evolution_encryption_key_unavailable');
  const plaintextTestAuthority = createEvolutionAuthority({ db, env, keyring: { activeKeyId: '', keys: {}, allowPlaintextTestOnly: true }, modelExecutor: approvedModel });
  const plaintextResult = plaintextTestAuthority.ingestEvidence(grant, [{ userAgentInstanceId: 'evolution_instance', sourceKind: 'message', sourceId: 'plain_test', content: 'explicit test-only plaintext', allowedEvolutionScopes: ['personal'] }]);
  assert.equal(plaintextResult.accepted.length, 1, JSON.stringify(plaintextResult));
  assert.equal(db.prepare("SELECT encryption_algorithm FROM cloud_evolution_evidence WHERE source_id='plain_test'").get().encryption_algorithm, 'plain_test_only');
  db.prepare("DELETE FROM cloud_evolution_evidence_usage WHERE evidence_id=(SELECT evidence_id FROM cloud_evolution_evidence WHERE source_id='plain_test')").run();

  const clusterOnlyMemory = authority.ingestEvidence(grant, [{ userAgentInstanceId: 'evolution_instance', sourceKind: 'memory_version', sourceId: memoryId, sourceVersionId: memoryVersionId, content: memoryContent, allowedEvolutionScopes: ['personal'] }]);
  assert.equal(clusterOnlyMemory.accepted.length, 1);
  assert.deepEqual(JSON.parse(db.prepare('SELECT metadata_json FROM cloud_evolution_evidence WHERE evidence_id=?').get(clusterOnlyMemory.accepted[0]).metadata_json).allowedEvolutionScopes, ['cluster']);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM cloud_evolution_evidence_usage WHERE evidence_id=? AND evolution_scope='personal'").get(clusterOnlyMemory.accepted[0]).count, 0);
  db.prepare("UPDATE cloud_memory_documents_v3 SET allow_personal_evolution=1 WHERE user_id='evolution_user' AND id=?").run(memoryId);
  assert.equal(authority.ingestEvidence(grant, [{ userAgentInstanceId: 'evolution_instance', sourceKind: 'memory_version', sourceId: memoryId, sourceVersionId: memoryVersionId, content: memoryContent, allowedEvolutionScopes: ['personal'] }]).duplicates.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM cloud_evolution_evidence_usage WHERE evidence_id=? AND evolution_scope='personal'").get(clusterOnlyMemory.accepted[0]).count, 1);
  const taskEvidenceDocumentId = 'encrypted_task_memory';
  const taskEvidenceVersionId = 'encrypted_task_memory_v1';
  const taskEvidenceTaskId = 'encrypted_task_run';
  const taskEvidenceContent = '# Encrypted Task Memory\n\n- Cloud may read this only while task consent is active.\n';
  const taskEvidenceKey = crypto.randomBytes(32);
  const taskEvidenceEnvelope = wrapTaskKeyForCloud(taskEvidenceKey, {
    activeKeyId: process.env.JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID,
    keys: { [process.env.JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID]: taskMemoryKeyPair.publicKey },
  });
  const taskEvidenceCiphertext = encryptTaskMemoryContent(taskEvidenceContent, taskEvidenceKey, {
    documentId: taskEvidenceDocumentId, versionNo: 1, keyVersion: 1,
  });
  const taskEvidenceHash = crypto.createHash('sha256').update(taskEvidenceContent).digest('hex');
  db.prepare(`INSERT INTO cloud_memory_documents_v3 (
    user_id,id,user_agent_instance_id,scope,slot_no,task_run_id,current_version_id,lifecycle_state,
    sync_enabled,allow_personal_evolution,payload_json,created_at,updated_at
  ) VALUES ('evolution_user',?,'evolution_instance','task',0,?,?,'active',1,1,'{}',?,?)`).run(
    taskEvidenceDocumentId, taskEvidenceTaskId, taskEvidenceVersionId, now, now,
  );
  db.prepare(`INSERT INTO cloud_memory_document_versions_v3 (user_id,id,memory_document_id,version_no,content_hash,payload_json,created_at)
    VALUES ('evolution_user',?,?,1,?,?,?)`).run(taskEvidenceVersionId, taskEvidenceDocumentId, taskEvidenceHash,
    JSON.stringify({ id: taskEvidenceVersionId, memoryDocumentId: taskEvidenceDocumentId, ...taskEvidenceCiphertext }), now);
  db.prepare(`INSERT INTO cloud_task_security_contexts_v5 (
    user_id,task_run_id,owner_user_id,local_key_id,cloud_key_id,key_version,cloud_evolution_allowed,
    local_envelope_state,cloud_envelope_state,status,payload_json,created_at,updated_at
  ) VALUES ('evolution_user',?,'evolution_user','local_ref','cloud_ref',1,1,'device_local_only','active','active',?,?,?)`).run(
    taskEvidenceTaskId, JSON.stringify({
      cloud_wrap_algorithm: taskEvidenceEnvelope.algorithm,
      cloud_wrapping_key_id: taskEvidenceEnvelope.keyId,
      cloud_wrapped_key: taskEvidenceEnvelope.wrappedKey,
    }), now, now,
  );
  const encryptedTaskEvidenceInput = {
    userAgentInstanceId: 'evolution_instance', sourceKind: 'memory_version', sourceId: taskEvidenceDocumentId,
    sourceVersionId: taskEvidenceVersionId, taskId: taskEvidenceTaskId, contentHash: taskEvidenceHash,
    encryptedContent: taskEvidenceCiphertext, allowedEvolutionScopes: ['personal'],
  };
  const encryptedTaskEvidenceResult = authority.ingestEvidence(grant, [encryptedTaskEvidenceInput]);
  assert.equal(encryptedTaskEvidenceResult.accepted.length, 1, JSON.stringify(encryptedTaskEvidenceResult));
  const encryptedTaskEvidenceId = encryptedTaskEvidenceResult.accepted[0];
  db.prepare('DELETE FROM cloud_evolution_evidence_usage WHERE evidence_id=?').run(encryptedTaskEvidenceId);
  db.prepare('DELETE FROM cloud_evolution_evidence WHERE evidence_id=?').run(encryptedTaskEvidenceId);
  db.prepare("UPDATE cloud_task_security_contexts_v5 SET cloud_evolution_allowed=0,cloud_envelope_state='revoked' WHERE user_id='evolution_user' AND task_run_id=?").run(taskEvidenceTaskId);
  assert.equal(authority.ingestEvidence(grant, [encryptedTaskEvidenceInput]).rejected[0].code, 'task_cloud_evolution_not_allowed');
  const quarantined = authority.ingestEvidence(grant, [{ userAgentInstanceId: 'evolution_instance', sourceKind: 'message', sourceId: 'credential_message', content: 'access_token = should never become evidence', allowedEvolutionScopes: ['personal'] }]);
  assert.equal(quarantined.quarantined.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM cloud_evolution_evidence_usage WHERE evidence_id=?').get(quarantined.quarantined[0].evidenceId).count, 0);

  const messageEvidence = Array.from({ length: 4 }, (_, index) => ({
    userAgentInstanceId: 'evolution_instance', sourceKind: 'message', sourceId: `evolution_message_${index}`,
    content: `Reusable task evidence ${index}`, occurredAt: new Date(Date.now() + index).toISOString(), allowedEvolutionScopes: ['personal'],
  }));
  assert.equal(authority.ingestEvidence(grant, messageEvidence).accepted.length, 4);
  assert.equal(authority.ingestEvidence(grant, [messageEvidence[0]]).duplicates.length, 1);
  const encryptedRow = db.prepare("SELECT content_ciphertext,encryption_algorithm FROM cloud_evolution_evidence WHERE source_id='evolution_message_0'").get();
  assert.equal(encryptedRow.encryption_algorithm, 'aes-256-gcm');
  assert.equal(encryptedRow.content_ciphertext.includes('Reusable task evidence'), false);
  const queued = authority.requestPersonalRun(grant, { agentInstanceId: 'evolution_instance' });
  assert.equal(queued.status, 'queued');
  assert.equal(authority.requestPersonalRun(grant, { agentInstanceId: 'evolution_instance' }).reason, 'personal_evolution_already_running');
  assert.equal((await authority.tickWorker({ limit: 1 })).completed[0].status, 'available');
  const proposed = authority.getRun(grant, queued.run.id);
  assert.equal(proposed.status, 'available');
  assert.equal(proposed.candidateVersion.status, 'candidate');
  assert.equal(proposed.memoryOperations[0].status, 'pending');
  assert.equal(db.prepare('SELECT current_version_id FROM cloud_memory_documents_v3 WHERE id=?').get(memoryId).current_version_id, memoryVersionId);
  assert.equal(authority.evidenceCounts(grant, { agentInstanceId: 'evolution_instance' }).counts.consumed, 5);
  assert.throws(() => authority.decidePersonalRun(grant, { runId: proposed.id, decisions: [
    { targetKind: 'skill', targetId: proposed.candidatePersonalSkillVersionId, decision: 'accept' },
  ] }), (error) => error.code === 'personal_version_activation_required');
  const activated = authority.activatePersonalVersion(grant, {
    agentInstanceId: 'evolution_instance', targetVersionId: proposed.candidatePersonalSkillVersionId,
    commandId: 'check_activate_personal_version', expectedActiveVersionId: '',
  });
  assert.equal(activated.status, 'activated');
  assert.equal(authority.getRun(grant, queued.run.id).candidateVersion.status, 'active');
  const decision = authority.decidePersonalRun(grant, { runId: proposed.id, decisions: [
    { targetKind: 'memory_operation', targetId: proposed.memoryOperations[0].id, decision: 'reject' },
  ] });
  assert.equal(decision.status, 'accepted');
  assert.equal(decision.run.status, 'applied');
  assert.equal(authority.evidenceCounts(grant, { agentInstanceId: 'evolution_instance' }).counts.consumed, 5);

  seed({ userId: 'retry_user', instanceId: 'retry_instance', familyId: 'retry_family' });
  let retryCalls = 0;
  const retryAuthority = createEvolutionAuthority({ db, env, keyring, modelExecutor: async (input) => {
    retryCalls += 1;
    if (retryCalls === 1) throw new Error('temporary outage');
    if (input.kind === 'personal_proposal') {
      const diagnosisText = String(input.prompt || '').match(/Diagnosis:\n([^\n]+)\nEvidence:/)?.[1] || '{}';
      const diagnosis = JSON.parse(diagnosisText);
      return JSON.stringify({
        summary: 'Retry-safe improvement.',
        overlay_text: `## Retry Procedure\n- ${diagnosis.recommendation || diagnosis.primary_layer || 'Verify before delivery.'}`,
        memory_operations: [],
        eval_cases: [{ input: 'Retry a task.', expected: 'Verify before delivery.' }],
        risks: ['Avoid repeated retries.'],
      });
    }
    return approvedModel(input);
  } });
  const retryToken = retryAuthority.issueGrant({ userId: 'retry_user', deviceId: 'retry_device' }).token;
  const retryGrant = retryAuthority.requireGrant(retryToken, 'evolution:write');
  retryAuthority.ingestEvidence(retryGrant, Array.from({ length: 5 }, (_, index) => ({
    userAgentInstanceId: 'retry_instance', sourceKind: 'message', sourceId: `retry_${index}`,
    content: `retry evidence ${index}`, allowedEvolutionScopes: ['personal'],
  })));
  retryAuthority.requestPersonalRun(retryGrant, { agentInstanceId: 'retry_instance' });
  assert.equal((await retryAuthority.tickWorker()).completed[0].status, 'failed_retryable');
  assert.equal(retryAuthority.evidenceCounts(retryGrant, { agentInstanceId: 'retry_instance' }).counts.released, 5);
  db.prepare("UPDATE cloud_evolution_jobs SET available_at='2000-01-01T00:00:00.000Z' WHERE status='failed_retryable'").run();
  assert.equal((await retryAuthority.tickWorker()).completed[0].status, 'available');

  for (let index = 0; index < 6; index += 1) {
    const userId = `batch_user_${index}`;
    const instanceId = `batch_instance_${index}`;
    seed({ userId, instanceId, familyId: `batch_family_${index}` });
    db.prepare(`INSERT INTO cloud_evolution_runs (id,evolution_scope,owner_user_id,user_agent_instance_id,agent_family_id,consumer_id,algorithm_version,status)
      VALUES (?, 'personal', ?, ?, ?, ?, 'batch_check', 'queued')`).run(`batch_run_${index}`, userId, instanceId, `batch_family_${index}`, instanceId);
    db.prepare(`INSERT INTO cloud_evolution_jobs (id,run_id,job_kind,status,available_at) VALUES (?,?,'personal_evolution','queued',?)`).run(`batch_job_${index}`, `batch_run_${index}`, now);
  }
  assert.equal((await authority.tickWorker({ limit: 99 })).completed.length, 5, 'Worker must process at most five jobs per tick');
  assert.throws(() => authority.mutateCluster(), (error) => error.code === 'cluster_evolution_not_enabled');
  assert.throws(() => authority.mutateMarket(), (error) => error.code === 'market_evolution_not_enabled');
  db.close();

  const cursorRoot = path.join(tmp, 'cloud-evolution-cursor-check');
  const cursorDb = openDatabase(cursorRoot);
  const cursorStore = new Store(cursorDb);
  cursorDb.prepare(`INSERT INTO auth_users (id,email,display_name,username,role,remote_id,email_verified)
    VALUES ('cursor_local','cursor@example.com','Cursor User','cursor_user','member','cursor_remote',1)`).run();
  cursorStore.upsertAgentFamily({ id: 'cursor_family', name: 'Cursor Agent', departmentId: 'general', role: 'agent', routable: true });
  cursorStore.upsertAgentVersion({ agent: { id: 'cursor_family', name: 'Cursor Agent', departmentId: 'general', role: 'agent', baseSkill: '# Cursor Skill\n' }, memoryTemplate: '# Memory\n' });
  const cursorInstance = cursorStore.recruitUserAgent({ userId: 'cursor_local', agentFamilyId: 'cursor_family', commandId: 'cursor-recruit' }).instance;
  cursorStore.updateUserAgentConsents({ agentInstanceId: cursorInstance.id, syncEnabled: true, personalEvolutionConsent: true });
  const cursorSync = new CloudSyncService({
    root: cursorRoot,
    db: cursorDb,
    store: cursorStore,
    evolutionAuthorityEnabled: true,
    defaultConfig: { serverUrl: 'http://cursor.invalid', token: 'cursor-token', autoSync: false },
  });
  cursorSync.saveConfig({ serverUrl: 'http://cursor.invalid', token: 'cursor-token', autoSync: false, userId: 'cursor_remote', deviceId: 'cursor_device' });
  const cursorSession = cursorStore.createSession({ title: 'Cursor evidence', userId: 'cursor_local', agentId: 'cursor_family', agentInstanceId: cursorInstance.id, departmentId: 'general' });
  const oldMessage = cursorStore.addMessage({ sessionId: cursorSession.id, role: 'user', content: 'historical evidence', agentId: 'cursor_family', agentInstanceId: cursorInstance.id, departmentId: 'general' });
  cursorDb.prepare("UPDATE messages SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(oldMessage.id);
  const newMessage = cursorStore.addMessage({ sessionId: cursorSession.id, role: 'user', content: 'new evidence', agentId: 'cursor_family', agentInstanceId: cursorInstance.id, departmentId: 'general' });
  cursorDb.prepare("UPDATE messages SET created_at='2099-01-01T00:00:00.000Z' WHERE id=?").run(newMessage.id);
  cursorDb.prepare(`INSERT INTO messages (id,session_id,role,content,agent_id,agent_instance_id,department_id,visible,created_at)
    VALUES ('cursor_legacy_raw',?,'assistant','legacy raw evidence','cursor_family',?,'general',1,'1999-01-01T12:00:00.000Z')`).run(cursorSession.id, cursorInstance.id);
  assert.equal(cursorSync.enqueueEvolutionEvidence().queued, 1, 'historical rows without outbox records must remain backfill-compatible');
  assert.equal(cursorDb.prepare('SELECT COUNT(*) AS count FROM evolution_evidence_upload_queue WHERE source_id=?').get(oldMessage.id).count, 0);
  assert.equal(cursorDb.prepare('SELECT COUNT(*) AS count FROM evolution_evidence_upload_queue WHERE source_id=?').get(newMessage.id).count, 0);
  assert.equal(cursorDb.prepare("SELECT COUNT(*) AS count FROM evolution_evidence_upload_queue WHERE source_id='cursor_legacy_raw'").get().count, 1);
  assert.equal(cursorSync.enqueueEvolutionEvidence().queued, 0, 'historical backfill cursors must prevent duplicate queueing');
  const laterMessage = cursorStore.addMessage({ sessionId: cursorSession.id, role: 'assistant', content: 'later evidence', agentId: 'cursor_family', agentInstanceId: cursorInstance.id, departmentId: 'general' });
  cursorDb.prepare("UPDATE messages SET created_at='2099-01-02T00:00:00.000Z' WHERE id=?").run(laterMessage.id);
  assert.equal(cursorSync.enqueueEvolutionEvidence().queued, 0, 'new Store writes after the legacy cursor must still use the outbox only');
  cursorDb.prepare(`INSERT INTO messages (id,session_id,role,content,agent_id,agent_instance_id,department_id,visible,created_at)
    VALUES ('cursor_legacy_later',?,'assistant','later legacy evidence','cursor_family',?,'general',1,'2099-01-03T00:00:00.000Z')`).run(cursorSession.id, cursorInstance.id);
  assert.equal(cursorSync.enqueueEvolutionEvidence().queued, 0, 'post-cutover rows must be captured by the transactional outbox');
  cursorSync.close();
  cursorDb.close();
}

async function assertCloudSyncLineage(tmp) {
  const seededRoot = path.join(tmp, 'cloud-sync-default-seed');
  const seededDb = openDatabase(seededRoot);
  const seededStore = new Store(seededDb);
  const emptySeededSync = new CloudSyncService({ root: seededRoot, db: seededDb, store: seededStore, defaultConfig: {} });
  assert.equal(emptySeededSync.status().configured, false);
  emptySeededSync.close();
  const seededSync = new CloudSyncService({
    root: seededRoot,
    db: seededDb,
    store: seededStore,
    defaultConfig: {
      serverUrl: 'http://sync-default.example',
      token: 'restricted-sync-token-for-checks',
      autoSync: true,
    },
  });
  assert.equal(seededSync.status().configured, true);
  assert.equal(seededSync.status().serverUrl, 'http://sync-default.example');
  assert.equal(seededSync.status().hasToken, true);
  seededSync.close();
  seededDb.close();

  const localRoot = path.join(tmp, 'cloud-sync-lineage-local');
  const cloudHome = path.join(tmp, 'cloud-sync-lineage-server');
  mkdirSync(localRoot, { recursive: true });
  const sentEmailCodes = [];
  const server = createCloudServer({
    home: cloudHome,
    token: 'lineage-token',
    syncToken: 'lineage-sync-token',
    emailCodeSecret: 'lineage-email-code-secret',
    mailer: {
      configured: true,
      async sendEmailCode(payload) {
        sentEmailCodes.push(payload);
      },
    },
  });
  const info = await server.listen({ host: '127.0.0.1', port: 0 });
  const nestedReleaseDir = path.join(cloudHome, 'releases', '0.1.5');
  mkdirSync(nestedReleaseDir, { recursive: true });
  writeFileSync(path.join(nestedReleaseDir, 'nested-release.bin'), 'versioned release');
  const agentReleaseDir = path.join(cloudHome, 'releases', 'agents', '0.1.5');
  mkdirSync(agentReleaseDir, { recursive: true });
  writeFileSync(path.join(agentReleaseDir, 'janus-agents-test.json'), '{"ok":true}\n');
  const db = openDatabase(localRoot);
  const store = new Store(db, { root: localRoot });
  const sync = new CloudSyncService({ root: localRoot, db, store });
  try {
    const authBase = `http://127.0.0.1:${info.port}`;
    const invalidRegistration = await fetch(`${authBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'valid-password1', displayName: 'Invalid' }),
    });
    assert.equal(invalidRegistration.status, 400);
    const shortPasswordRegistration = await fetch(`${authBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'short@example.com', password: 'short', displayName: 'Short' }),
    });
    assert.equal(shortPasswordRegistration.status, 400);
    const missingCodeRegistration = await fetch(`${authBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'cloud.user@example.com', password: 'cloud-password1', displayName: 'Cloud User' }),
    });
    assert.equal(missingCodeRegistration.status, 400);
    assert.equal((await missingCodeRegistration.json()).error.code, 'email_code_invalid');
    const registerCodeResponse = await fetch(`${authBase}/api/auth/email-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'Cloud.User@Example.com', purpose: 'register' }),
    });
    assert.equal(registerCodeResponse.status, 200);
    const registerCodeResult = await registerCodeResponse.json();
    assert.equal(registerCodeResult.delivery, 'email');
    assert.equal(Object.hasOwn(registerCodeResult, 'code'), false);
    assert.equal(Object.hasOwn(registerCodeResult, 'devCode'), false);
    const registerCode = sentEmailCodes.at(-1)?.code;
    assert.match(registerCode, /^\d{6}$/);
    const sentRegisterCodes = sentEmailCodes.length;
    const repeatedRegisterCodeResponse = await fetch(`${authBase}/api/auth/email-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'cloud.user@example.com', purpose: 'register' }),
    });
    assert.equal(repeatedRegisterCodeResponse.status, 200);
    assert.equal((await repeatedRegisterCodeResponse.json()).reused, true);
    assert.equal(sentEmailCodes.length, sentRegisterCodes);
    const registration = await fetch(`${authBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'Cloud.User@Example.com', code: registerCode, password: 'cloud-password1', displayName: 'Cloud User' }),
    });
    assert.equal(registration.status, 201);
    const registeredSession = await registration.json();
    assert.equal(registeredSession.user.email, 'cloud.user@example.com');
    assert.equal(registeredSession.user.role, 'member');
    assert.ok(registeredSession.accessToken);
    assert.ok(registeredSession.refreshToken);
    const evolutionGrantResponse = await fetch(`${authBase}/api/evolution/grants`, {
      method: 'POST',
      headers: { authorization: `Bearer ${registeredSession.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'spoofed_user', deviceId: 'lineage_evolution_device', scopes: ['evolution:read'] }),
    });
    assert.equal(evolutionGrantResponse.status, 201);
    const evolutionGrant = await evolutionGrantResponse.json();
    assert.equal(evolutionGrant.userId, registeredSession.user.id, 'authenticated user identity must override a spoofed Grant user ID');
    assert.deepEqual(evolutionGrant.scopes, ['evolution:read']);
    const evolutionGrantListResponse = await fetch(`${authBase}/api/evolution/grants`, {
      headers: { authorization: `Bearer ${registeredSession.accessToken}` },
    });
    assert.equal(evolutionGrantListResponse.status, 200);
    assert.ok((await evolutionGrantListResponse.json()).items.some((item) => item.deviceId === 'lineage_evolution_device'));
    const evolutionGrantRevokeResponse = await fetch(`${authBase}/api/evolution/grants/lineage_evolution_device`, {
      method: 'DELETE', headers: { authorization: `Bearer ${registeredSession.accessToken}` },
    });
    assert.equal(evolutionGrantRevokeResponse.status, 200);
    assert.equal((await evolutionGrantRevokeResponse.json()).status, 'revoked');
    const storedCloudUser = server.db.prepare('SELECT * FROM users WHERE id = ?').get(registeredSession.user.id);
    assert.equal(storedCloudUser.email, 'cloud.user@example.com');
    assert.ok(storedCloudUser.password_hash.startsWith('pbkdf2$'));
    assert.equal(storedCloudUser.password_hash.includes('cloud-password1'), false);
    assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM users WHERE id = 'local_admin'").get().count, 0);
    const duplicateRegistration = await fetch(`${authBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'CLOUD.USER@example.com', password: 'another-password1', displayName: 'Duplicate' }),
    });
    assert.equal(duplicateRegistration.status, 409);
    assert.equal((await duplicateRegistration.json()).error.code, 'email_already_registered');
    assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM users WHERE email = ? COLLATE NOCASE").get('cloud.user@example.com').count, 1);
    const usernameProfileUpdate = await fetch(`${authBase}/api/auth/profile`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${registeredSession.accessToken}`,
      },
      body: JSON.stringify({ username: 'Cloud Lookup User' }),
    });
    assert.equal(usernameProfileUpdate.status, 200);
    assert.equal((await usernameProfileUpdate.json()).user.username, 'cloud_lookup_user');
    const secondRegisterCodeResponse = await fetch(`${authBase}/api/auth/email-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'cloud.second@example.com', purpose: 'register' }),
    });
    assert.equal(secondRegisterCodeResponse.status, 200);
    const secondRegisterCode = sentEmailCodes.at(-1)?.code;
    const secondRegistration = await fetch(`${authBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'cloud.second@example.com', code: secondRegisterCode, password: 'second-password1', displayName: 'Cloud Second' }),
    });
    assert.equal(secondRegistration.status, 201);
    const secondSession = await secondRegistration.json();
    const duplicateUsernameUpdate = await fetch(`${authBase}/api/auth/profile`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secondSession.accessToken}`,
      },
      body: JSON.stringify({ username: 'CLOUD LOOKUP USER' }),
    });
    assert.equal(duplicateUsernameUpdate.status, 409);
    assert.equal((await duplicateUsernameUpdate.json()).error.code, 'username_already_taken');
    assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM users WHERE username = ? COLLATE NOCASE").get('cloud_lookup_user').count, 1);
    const usernameLogin = await fetch(`${authBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'CLOUD_LOOKUP_USER', password: 'cloud-password1' }),
    });
    assert.equal(usernameLogin.status, 200);
    const usernameLoginSession = await usernameLogin.json();
    const usernameSearch = await fetch(`${authBase}/api/friends/search?q=${encodeURIComponent(secondSession.user.username)}`, {
      headers: { authorization: `Bearer ${usernameLoginSession.accessToken}` },
    });
    assert.equal(usernameSearch.status, 200);
    assert.ok((await usernameSearch.json()).items.some((item) => item.id === secondSession.user.id));
    const localAdminLogin = await fetch(`${authBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'local_admin', password: '' }),
    });
    assert.equal(localAdminLogin.status, 401);
    const login = await fetch(`${authBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'cloud.user@example.com', password: 'cloud-password1' }),
    });
    assert.equal(login.status, 200);
    const loginSession = await login.json();
    const me = await fetch(`${authBase}/api/auth/me`, {
      headers: { authorization: `Bearer ${loginSession.accessToken}` },
    });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.id, registeredSession.user.id);
    const refreshed = await fetch(`${authBase}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: loginSession.refreshToken }),
    });
    assert.equal(refreshed.status, 200);
    const refreshedSession = await refreshed.json();
    assert.notEqual(refreshedSession.refreshToken, loginSession.refreshToken);
    const reusedRefresh = await fetch(`${authBase}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: loginSession.refreshToken }),
    });
    assert.equal(reusedRefresh.status, 401);
    const changeCodeResponse = await fetch(`${authBase}/api/auth/email-code`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${refreshedSession.accessToken}`,
      },
      body: JSON.stringify({ email: 'cloud.user@example.com', purpose: 'password_change' }),
    });
    assert.equal(changeCodeResponse.status, 200);
    const changeCode = sentEmailCodes.at(-1)?.code;
    const changePasswordResponse = await fetch(`${authBase}/api/auth/password`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${refreshedSession.accessToken}`,
      },
      body: JSON.stringify({ currentPassword: 'cloud-password1', newPassword: 'cloud-password1-2', code: changeCode }),
    });
    assert.equal(changePasswordResponse.status, 200);
    const oldPasswordLogin = await fetch(`${authBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'cloud.user@example.com', password: 'cloud-password1' }),
    });
    assert.equal(oldPasswordLogin.status, 401);
    const changedPasswordLogin = await fetch(`${authBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'cloud.user@example.com', password: 'cloud-password1-2' }),
    });
    assert.equal(changedPasswordLogin.status, 200);
    const resetCodeResponse = await fetch(`${authBase}/api/auth/email-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'cloud.user@example.com', purpose: 'password_reset' }),
    });
    assert.equal(resetCodeResponse.status, 200);
    const resetCode = sentEmailCodes.at(-1)?.code;
    const resetPasswordResponse = await fetch(`${authBase}/api/auth/password-reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'cloud.user@example.com', code: resetCode, newPassword: 'cloud-password1-3' }),
    });
    assert.equal(resetPasswordResponse.status, 200);
    const resetPasswordLogin = await fetch(`${authBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'cloud.user@example.com', password: 'cloud-password1-3' }),
    });
    assert.equal(resetPasswordLogin.status, 200);
    const resetPasswordSession = await resetPasswordLogin.json();
    const resettableOrganizationResponse = await fetch(`${authBase}/api/organizations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${resetPasswordSession.accessToken}` },
      body: JSON.stringify({ name: 'SQLite Reset Organization', organizationNumber: 'SQLITE-RESET', verificationCode: 'sqlite-old-code' }),
    });
    assert.equal(resettableOrganizationResponse.status, 201);
    const resettableOrganization = await resettableOrganizationResponse.json();
    const invitationResetCodeResponse = await fetch(`${authBase}/api/auth/email-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${resetPasswordSession.accessToken}` },
      body: JSON.stringify({ email: 'cloud.user@example.com', purpose: 'organization_invitation_reset' }),
    });
    assert.equal(invitationResetCodeResponse.status, 200);
    const invitationResetCode = sentEmailCodes.at(-1)?.code;
    const invitationResetResponse = await fetch(`${authBase}/api/organizations/${encodeURIComponent(resettableOrganization.organization.id)}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${resetPasswordSession.accessToken}` },
      body: JSON.stringify({ action: 'reset_invitation_code', emailCode: invitationResetCode, newInvitationCode: 'sqlite-new-code' }),
    });
    assert.equal(invitationResetResponse.status, 200);
    assert.equal((await invitationResetResponse.json()).invitationCodeReset, true);
    const sqliteOldInvitationJoin = await fetch(`${authBase}/api/organizations/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secondSession.accessToken}` },
      body: JSON.stringify({ organizationNumber: 'SQLITE-RESET', verificationCode: 'sqlite-old-code' }),
    });
    assert.equal(sqliteOldInvitationJoin.status, 403);
    const sqliteNewInvitationJoin = await fetch(`${authBase}/api/organizations/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secondSession.accessToken}` },
      body: JSON.stringify({ organizationNumber: 'SQLITE-RESET', verificationCode: 'sqlite-new-code' }),
    });
    assert.equal(sqliteNewInvitationJoin.status, 200);
    const sqliteRememberedVerificationResponse = await fetch(`${authBase}/api/organizations/${encodeURIComponent(resettableOrganization.organization.id)}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${resetPasswordSession.accessToken}` },
      body: JSON.stringify({
        action: 'promote_admin', targetUserId: secondSession.user.id,
        verificationCode: 'sqlite-new-code', accountPassword: 'cloud-password1-3',
        rememberSecondaryVerification: true,
      }),
    });
    assert.equal(sqliteRememberedVerificationResponse.status, 200);
    const sqliteRememberedVerification = await sqliteRememberedVerificationResponse.json();
    assert.equal(sqliteRememberedVerification.secondaryVerificationRemembered, true);
    assert.ok(sqliteRememberedVerification.secondaryVerificationGrant);
    const sqliteRememberedRevokeResponse = await fetch(`${authBase}/api/organizations/${encodeURIComponent(resettableOrganization.organization.id)}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${resetPasswordSession.accessToken}` },
      body: JSON.stringify({
        action: 'revoke_admin', targetUserId: secondSession.user.id,
        secondaryVerificationGrant: sqliteRememberedVerification.secondaryVerificationGrant,
      }),
    });
    assert.equal(sqliteRememberedRevokeResponse.status, 200);
    const sqliteAutoSuccessorExit = await fetch(`${authBase}/api/organizations/${encodeURIComponent(resettableOrganization.organization.id)}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${resetPasswordSession.accessToken}` },
      body: JSON.stringify({ action: 'owner_exit', mode: 'auto', secondaryVerificationGrant: sqliteRememberedVerification.secondaryVerificationGrant }),
    });
    assert.equal(sqliteAutoSuccessorExit.status, 200);
    const sqliteAutoSuccessorResult = await sqliteAutoSuccessorExit.json();
    assert.equal(sqliteAutoSuccessorResult.exited, true);
    assert.equal(sqliteAutoSuccessorResult.ownerUserId, secondSession.user.id);
    const sqliteDissolveOrganizationResponse = await fetch(`${authBase}/api/organizations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${resetPasswordSession.accessToken}` },
      body: JSON.stringify({ name: 'SQLite Dissolve Organization', organizationNumber: 'SQLITE-DISSOLVE', verificationCode: 'sqlite-dissolve-code' }),
    });
    assert.equal(sqliteDissolveOrganizationResponse.status, 201);
    const sqliteDissolveOrganization = await sqliteDissolveOrganizationResponse.json();
    const sqliteDissolveExit = await fetch(`${authBase}/api/organizations/${encodeURIComponent(sqliteDissolveOrganization.organization.id)}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${resetPasswordSession.accessToken}` },
      body: JSON.stringify({ action: 'owner_exit', mode: 'dissolve', verificationCode: 'sqlite-dissolve-code', accountPassword: 'cloud-password1-3' }),
    });
    assert.equal(sqliteDissolveExit.status, 200);
    assert.equal((await sqliteDissolveExit.json()).dissolved, true);
    const ingestStatus = await fetch(`http://127.0.0.1:${info.port}/v1/sync/status`, {
      headers: { authorization: 'Bearer lineage-sync-token' },
    });
    assert.equal(ingestStatus.status, 200);
    const ingestTrace = await fetch(`http://127.0.0.1:${info.port}/v1/trace/files/${'0'.repeat(64)}`, {
      headers: { authorization: 'Bearer lineage-sync-token' },
    });
    assert.equal(ingestTrace.status, 401, 'packaged sync token must not read trace data');
    const nestedReleaseResponse = await fetch(`http://127.0.0.1:${info.port}/v1/releases/artifacts/${encodeURIComponent('0.1.5/nested-release.bin')}`);
    assert.equal(nestedReleaseResponse.status, 200);
    assert.equal(await nestedReleaseResponse.text(), 'versioned release');
    const canonicalAgentResponse = await fetch(`http://127.0.0.1:${info.port}/v1/releases/artifacts/${encodeURIComponent('agents/0.1.5/janus-agents-test.json')}`);
    assert.equal(canonicalAgentResponse.status, 200);
    assert.equal(await canonicalAgentResponse.text(), '{"ok":true}\n');
    const legacyAgentResponse = await fetch(`http://127.0.0.1:${info.port}/v1/releases/artifacts/${encodeURIComponent('0.1.5/janus-agents-test.json')}`);
    assert.equal(legacyAgentResponse.status, 200);
    assert.equal(await legacyAgentResponse.text(), '{"ok":true}\n');
    const traversalResponse = await fetch(`http://127.0.0.1:${info.port}/v1/releases/artifacts/${encodeURIComponent('../cloud.db')}`);
    assert.equal(traversalResponse.status, 404);
    sync.saveConfig({
      serverUrl: `http://127.0.0.1:${info.port}`,
      token: 'lineage-token',
      userId: 'sync_owner',
      deviceId: 'device_lineage',
    });
    store.db.prepare(`INSERT INTO auth_users (
      id, email, display_name, username, role, remote_id, remote_bound_at, auth_provider, email_verified
    ) VALUES
      ('sync_owner_local', 'sync.owner@check.local', 'Sync Owner', 'sync_owner', 'member', 'sync_owner', ?, 'cloud', 1),
      ('user_lineage', 'lineage.other@check.local', 'Lineage Other User', 'lineage_other', 'member', '', '', 'local', 1)`).run(new Date().toISOString());
    store.upsertAgentFamily({ id: 'sync_agent', name: 'Sync Agent', departmentId: 'general', role: 'agent', routable: true });
    const syncAgentVersion = store.upsertAgentVersion({
      agent: { id: 'sync_agent', name: 'Sync Agent', departmentId: 'general', role: 'agent', baseSkill: '# Sync Agent Skill\n' },
      memoryTemplate: '# Agent Memory: sync_agent\n\n## Stable Learnings\n- None yet.\n',
    });
    const syncAgentInstance = store.recruitUserAgent({
      userId: 'sync_owner_local', agentFamilyId: 'sync_agent', commandId: 'check:sync-owner:recruit-sync-agent',
    }).instance;
    server.db.prepare(`INSERT OR IGNORE INTO cloud_agent_families_v3
      (id,name,department_id,role,status,routable,instance_kind,quota_cost,payload_json,updated_at)
      VALUES('sync_agent','Sync Agent','general','agent','active',1,'employee',1,'{}',?)`).run(new Date().toISOString());
    server.db.prepare(`INSERT OR IGNORE INTO cloud_agent_versions_v3
      (id,agent_family_id,payload_json,created_at)
      VALUES(?,'sync_agent','{}',?)`).run(syncAgentVersion.id,new Date().toISOString());
    server.db.prepare(`INSERT OR IGNORE INTO cloud_user_agent_instances_v3
      (user_id,id,agent_family_id,base_agent_version_id,status,instance_kind,employment_state,sync_enabled,
       personal_evolution_consent,cluster_contribution_consent,created_at,updated_at)
      VALUES('sync_owner',?,'sync_agent',?,'active','employee','active',1,0,1,?,?)`).run(
      syncAgentInstance.id,syncAgentVersion.id,new Date().toISOString(),new Date().toISOString());
    const syncTask = store.createTaskRun({
      title: 'Encrypted sync task', prompt: 'Verify encrypted task Memory sync.', departmentId: 'general',
      leadAgentId: 'sync_agent', leadAgentInstanceId: syncAgentInstance.id, ownerUserId: 'sync_owner_local',
    });
    store.setTaskCloudEvolutionAllowed({ taskRunId: syncTask.id, allowed: true });
    store.recordTaskEvent({
      eventId: 'sync_local_private_task_event', taskRunId: syncTask.id, eventType: 'node_activity', actorId: 'sync_agent',
      status: 'completed', summary: '工具调用完成',
      payload: {
        activityId: 'sync-private-tool', activityType: 'tool', title: '工具调用', detail: 'private detail',
        arguments: { apiKey: 'sk-cloud-private-secret' }, result: { token: 'github_pat_abcdefghijklmnopqrstuvwxyz123456' },
        protocolEvents: [{ method: 'item/completed', params: { authorization: 'Bearer hidden' } }], exitCode: 0,
      },
    });
    store.recordTaskEvent({
      eventId: 'sync_owner_private_task_event', taskRunId: syncTask.id, eventType: 'node_activity', actorId: 'sync_agent',
      status: 'completed', summary: '执行说明',
      payload: {
        activityId: 'sync-owner-commentary', activityType: 'commentary', title: '执行说明',
        detail: 'token: eyJabcdefghijk.abcdefghijk.abcdefghijk AWS AWS_ACCESS_KEY_ID_TEST',
      },
    });
    const ordinary = store.createSession({ title: 'Ordinary trace', departmentId: 'general', userId: 'sync_owner_local' });
    store.updateSession(ordinary.id, {
      interactionMode: 'goal',
      goal: {
        objective: 'Preserve this cross-device Goal state.',
        status: 'active',
        tokensUsed: 12_345,
        tokenBudget: 90_000,
        timeUsedSeconds: 678,
      },
    });
    const project = store.createProject({
      title: 'Project trace',
      workspaceRoot: path.join(tmp, 'private-project-workspace'),
      userId: 'sync_owner_local',
    });
    const projectSession = store.createSession({
      title: 'Project conversation routed to PPT',
      departmentId: 'ppt_department',
      projectId: project.id,
      workspaceRoot: project.workspaceRoot,
      userId: 'sync_owner_local',
    });
    const sameBytes = Buffer.from('same file in two conversations').toString('base64');
    const ordinaryAttachment = uploadFile(localRoot, { filename: 'evidence.txt', contentType: 'text/plain', dataBase64: sameBytes }, 'sync_owner_local');
    const projectAttachment = uploadFile(localRoot, { filename: 'evidence-copy.txt', contentType: 'text/plain', dataBase64: sameBytes }, 'sync_owner_local');
    const externalProjectFile = path.join(tmp, 'external-project-file.txt');
    writeFileSync(externalProjectFile, 'explicitly referenced external project file');
    const externalAttachment = { path: externalProjectFile, name: 'external-project-file.txt', content_type: 'text/plain', size: readFileSync(externalProjectFile).length };
    const ordinaryMessage = store.addMessage({
      sessionId: ordinary.id,
      role: 'user',
      content: 'ordinary question',
      metadata: { attachments: [ordinaryAttachment] },
    });
    const ordinaryAnswer = store.addMessage({ sessionId: ordinary.id, role: 'assistant', content: 'ordinary answer' });
    store.updateMessage(ordinaryAnswer.id, {
      metadata: {
        processEvents: [{
          activityId: 'synced-strict-comparison', activityType: 'file', status: 'completed',
          nativeSource: 'codex_app_server', derivedSource: 'janus_turn_snapshot',
          changes: [{
            path: path.join(project.workspaceRoot, 'private.docx'), relativePath: 'private.docx', kind: 'update',
            comparison: {
              version: 1, status: 'complete', strict: true,
              before: { sha256: 'before-hash', snapshot: { path: path.join(localRoot, 'data', 'file_change_snapshots', 'before.docx'), name: 'before.docx' } },
              after: { sha256: 'after-hash', snapshot: { path: path.join(localRoot, 'data', 'file_change_snapshots', 'after.docx'), name: 'after.docx' } },
              semantic: { added: [{ type: 'heading', text: 'Synced new title' }], removed: [{ type: 'heading', text: 'Synced old title' }] },
            },
          }],
        }],
      },
    });
    store.beginModelExecution({
      id: 'model_exec_lineage',
      userId: 'sync_owner_local',
      conversationId: ordinary.id,
      requestMessageId: ordinaryMessage.id,
      responseMessageId: ordinaryAnswer.id,
      departmentId: 'general',
      executionKind: 'plain_chat',
      providerId: 'custom',
      requestedModel: 'gpt-5.6-sol',
      effectiveModel: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      modelSource: 'request',
      status: 'completed',
    });
    store.completeModelExecution('model_exec_lineage', { responseMessageId: ordinaryAnswer.id });
    const projectMessage = store.addMessage({
      sessionId: projectSession.id,
      role: 'user',
      content: 'project question',
      metadata: { attachments: [projectAttachment, externalAttachment] },
    });
    store.addMessage({ sessionId: projectSession.id, role: 'assistant', content: 'project answer' });
    const outputDir = path.join(localRoot, 'outputs', 'custom', projectSession.id);
    mkdirSync(outputDir, { recursive: true });
    const outputFile = path.join(outputDir, 'agent-output.txt');
    writeFileSync(outputFile, 'agent generated output');
    store.addMessage({
      sessionId: projectSession.id,
      role: 'system',
      content: artifactMessage('text', {
        name: 'agent-output.txt',
        path: outputFile,
        workspace_relative_path: path.relative(localRoot, outputFile).replaceAll('\\', '/'),
        content_type: 'text/plain',
        size: readFileSync(outputFile).length,
      }),
      metadata: { artifact: { kind: 'text' } },
    });
    const privateSyncSession = store.createSession({
      title: 'Private assistant sync exclusion', userId: 'sync_owner_local',
      departmentId: 'private_assistant', agentId: 'private_assistant',
      memoryUseEnabled: false, memoryGenerateEnabled: false,
    });
    const privateSyncMessage = store.addMessage({
      sessionId: privateSyncSession.id, role: 'user', content: 'never upload this private conversation',
      agentId: 'private_assistant', departmentId: 'private_assistant', metadata: { localOnly: true },
    });
    store.beginModelExecution({
      id: 'private_model_exec_sync_exclusion', userId: 'sync_owner_local', conversationId: privateSyncSession.id,
      requestMessageId: privateSyncMessage.id, departmentId: 'private_assistant', agentRole: 'private_assistant',
      executionKind: 'private_assistant_chat', status: 'completed', metadata: { localOnly: true },
    });
    store.completeModelExecution('private_model_exec_sync_exclusion');
    const foreignSyncSession = store.createSession({
      title: 'Another local user must not sync', userId: 'user_lineage', departmentId: 'general',
    });
    const foreignSyncMessage = store.addMessage({
      sessionId: foreignSyncSession.id, role: 'user', content: 'private to another local account', departmentId: 'general',
    });

    const payload = await sync.buildBatchPayload({ ...sync.state(), last_sync_cursor: '' });
    assert.equal(payload.schemaVersion, 5);
    assert.equal(payload.data.userAgentInstances.length, 1);
    assert.equal(payload.data.userAgentInstances[0].id, syncAgentInstance.id);
    assert.equal(payload.data.memoryDocuments.length, 2);
    assert.equal(payload.data.memoryDocumentVersions.length, 2);
    const syncedTaskMemory = payload.data.memoryDocuments.find((item) => item.task_run_id === syncTask.id);
    const syncedTaskVersion = payload.data.memoryDocumentVersions.find((item) => item.memory_document_id === syncedTaskMemory.id);
    assert.ok(syncedTaskVersion, JSON.stringify({ syncedTaskMemory, versions: payload.data.memoryDocumentVersions.map((item) => ({ id: item.id, memory_document_id: item.memory_document_id })) }));
    assert.equal(syncedTaskVersion.content, '', 'task Memory sync payload must not contain plaintext');
    assert.equal(syncedTaskVersion.encryption_algorithm, 'aes-256-gcm');
    assert.ok(syncedTaskVersion.content_ciphertext);
    assert.equal(payload.data.taskSecurityContexts.length, 1);
    assert.equal('local_wrapped_key' in payload.data.taskSecurityContexts[0], false, 'device-local task key envelopes must never sync');
    assert.equal(payload.data.taskSecurityContexts[0].cloud_envelope_state, 'active');
    assert.ok(payload.data.taskSecurityContexts[0].cloud_wrapped_key);
    const syncedPrivateTaskEvent = payload.data.taskEvents.find((item) => item.id === 'sync_local_private_task_event');
    assert.ok(syncedPrivateTaskEvent);
    assert.equal(syncedPrivateTaskEvent.privacy_level, 'local_private');
    assert.deepEqual(Object.keys(syncedPrivateTaskEvent.payload).sort(), ['activityId', 'activityType', 'exitCode', 'status', 'title']);
    assert.doesNotMatch(JSON.stringify(syncedPrivateTaskEvent), /sk-cloud-private-secret|github_pat_|Bearer hidden|private detail/);
    const syncedOwnerTaskEvent = payload.data.taskEvents.find((item) => item.id === 'sync_owner_private_task_event');
    assert.ok(syncedOwnerTaskEvent);
    assert.doesNotMatch(JSON.stringify(syncedOwnerTaskEvent), /eyJabcdefghijk|AWS_ACCESS_KEY_ID_TEST/);
    const syncedGoalConversation = payload.data.conversations.find((item) => item.id === ordinary.id);
    assert.equal(syncedGoalConversation?.conversationType, 'ordinary');
    assert.equal(syncedGoalConversation?.interactionMode, 'goal');
    assert.equal(syncedGoalConversation?.goalObjective, 'Preserve this cross-device Goal state.');
    assert.equal(syncedGoalConversation?.goalStatus, 'active');
    assert.equal(syncedGoalConversation?.goalTokensUsed, 12_345);
    assert.equal(syncedGoalConversation?.goalTokenBudget, 0);
    assert.equal(syncedGoalConversation?.goalTimeUsedSeconds, 678);
    assert.equal(payload.data.conversations.find((item) => item.id === projectSession.id)?.conversationType, 'project');
    assert.equal(payload.data.conversations.find((item) => item.id === projectSession.id)?.projectId, project.id);
    assert.equal(payload.data.modelExecutions.length, 1);
    assert.equal(payload.data.modelExecutions[0].effectiveModel, 'gpt-5.6-sol');
    assert.equal(payload.data.modelExecutions[0].requestMessageId, ordinaryMessage.id);
    assert.equal(payload.data.conversations.some((item) => item.id === privateSyncSession.id), false);
    assert.equal(payload.data.messages.some((item) => item.id === privateSyncMessage.id), false);
    assert.equal(payload.data.modelExecutions.some((item) => item.id === 'private_model_exec_sync_exclusion'), false);
    assert.equal(payload.data.conversations.some((item) => item.id === foreignSyncSession.id), false);
    assert.equal(payload.data.messages.some((item) => item.id === foreignSyncMessage.id), false);
    const syncedComparisonMessage = payload.data.messages.find((item) => item.id === ordinaryAnswer.id);
    const syncedComparison = syncedComparisonMessage?.metadata?.processEvents?.[0]?.changes?.[0]?.comparison;
    assert.equal(syncedComparison?.strict, true);
    assert.equal(syncedComparison?.before?.sha256, 'before-hash');
    assert.equal(syncedComparison?.before?.snapshot?.path, undefined, 'device-local snapshot paths must not enter Cloud Sync');
    assert.equal(syncedComparison?.after?.snapshot?.path, undefined, 'device-local after-snapshot paths must not enter Cloud Sync');
    assert.equal(syncedComparison?.semantic?.added?.[0]?.text, 'Synced new title');
    assert.equal(syncedComparisonMessage.metadata.processEvents[0].changes[0].relativePath, 'private.docx');
    assert.equal(payload.data.fileRefs.length, 4);
    assert.equal(new Set(payload.data.fileRefs.map((item) => item.sha256)).size, 3, 'same object should keep separate message refs while external and generated content remain distinct');
    assert.ok(payload.data.fileRefs.some((item) => item.relationType === 'output' && item.sourceKind === 'artifact:text'));
    assert.ok(payload.files.some((item) => item.localPath.startsWith('external_refs/')), 'explicitly referenced external files should be uploaded through a safe synthetic path');
    assert.equal(JSON.stringify(payload).includes(localRoot), false, 'sync payload must not expose the absolute local root');
    assert.equal(JSON.stringify(payload).includes(project.workspaceRoot), false, 'sync payload must not expose the absolute project workspace');

    const first = await sync.syncNow({ reason: 'lineage_check' });
    assert.equal(first.status, 'completed', first.error || first.cloud?.lastError || 'cloud lineage sync failed');
    assert.equal(first.uploadedFileCount, 3, 'duplicate content should upload once while distinct external and generated content are uploaded separately');
    assert.equal(first.response.fileCount, 4, 'all local, external, and generated file occurrences should remain in the batch');
    assert.equal(first.response.fileRefCount, 4);
    assert.equal(first.response.modelExecutionCount, 1);
    assert.equal(first.response.userAgentInstanceCount, 1);
    assert.equal(first.response.memoryDocumentCount, 2);
    assert.equal(Number(server.db.prepare('SELECT COUNT(*) AS count FROM cloud_user_agent_instances_v3').get().count), 1);
    assert.equal(Number(server.db.prepare('SELECT COUNT(*) AS count FROM cloud_memory_documents_v3').get().count), 2);
    const secondIdentityRoot = path.join(tmp, 'cloud-identity-device-two');
    const secondIdentityDb = openDatabase(secondIdentityRoot);
    const secondIdentityStore = new Store(secondIdentityDb);
    const secondIdentitySync = new CloudSyncService({ root: secondIdentityRoot, db: secondIdentityDb, store: secondIdentityStore });
    secondIdentityDb.prepare(`INSERT INTO auth_users (
      id, email, display_name, username, role, remote_id, remote_bound_at, auth_provider, email_verified
    ) VALUES ('sync_owner_device_two', 'sync.owner.device.two@check.local', 'Sync Owner Device Two',
      'sync_owner_device_two', 'member', 'sync_owner', ?, 'cloud', 1)`).run(new Date().toISOString());
    secondIdentityStore.upsertAgentFamily({ id: 'sync_agent', name: 'Sync Agent', departmentId: 'general', role: 'agent', routable: true });
    const secondIdentityVersion = secondIdentityStore.upsertAgentVersion({
      agent: { id: 'sync_agent', name: 'Sync Agent', departmentId: 'general', role: 'agent', baseSkill: '# Sync Agent Skill\n' },
      memoryTemplate: '# Agent Memory: sync_agent\n\n## Stable Learnings\n- None yet.\n',
    });
    secondIdentitySync.saveConfig({
      serverUrl: `http://127.0.0.1:${info.port}`, token: 'lineage-token', userId: 'sync_owner', deviceId: 'device_lineage_two',
    });
    const secondIdentityBootstrap = await secondIdentitySync.syncNow({ reason: 'cross_device_identity_bootstrap' });
    assert.equal(secondIdentityBootstrap.status, 'completed', secondIdentityBootstrap.error || secondIdentityBootstrap.cloud?.lastError || JSON.stringify(secondIdentityBootstrap));
    const importedGoalConversationId = 'goal_import_contract';
    const importedGoalPayload = { ...syncedGoalConversation, id: importedGoalConversationId, title: 'Imported Goal contract' };
    const importedGoalResult = secondIdentitySync.applyV6Changes([{
      changeId: 'goal_import_contract_v1', entityType: 'conversation', entityId: importedGoalConversationId,
      revision: 1, operation: 'upsert', payload: importedGoalPayload,
    }], { remoteUserId: 'sync_owner' });
    assert.equal(importedGoalResult.status, 'applied');
    let secondDeviceGoalSession = secondIdentityStore.getSession(importedGoalConversationId);
    assert.equal(secondDeviceGoalSession?.interactionMode, 'goal');
    assert.deepEqual(secondDeviceGoalSession?.goal, {
      objective: 'Preserve this cross-device Goal state.',
      status: 'active',
      tokensUsed: 12_345,
      timeUsedSeconds: 678,
    });
    const legacyGoalPayload = { ...importedGoalPayload, title: 'Legacy payload preserved Goal state' };
    for (const key of ['interactionMode', 'goalObjective', 'goalStatus', 'goalTokensUsed', 'goalTokenBudget', 'goalTimeUsedSeconds']) delete legacyGoalPayload[key];
    secondIdentitySync.applyV6Changes([{
      changeId: 'goal_import_contract_v2', entityType: 'conversation', entityId: importedGoalConversationId,
      revision: 2, operation: 'upsert', payload: legacyGoalPayload,
    }], { remoteUserId: 'sync_owner' });
    secondDeviceGoalSession = secondIdentityStore.getSession(importedGoalConversationId);
    assert.equal(secondDeviceGoalSession?.title, 'Legacy payload preserved Goal state');
    assert.equal(secondDeviceGoalSession?.interactionMode, 'goal', 'older conversation payloads must not erase a local interaction mode');
    assert.equal('tokenBudget' in (secondDeviceGoalSession?.goal || {}), false, 'older conversation payloads must not reactivate the retired Goal budget');
    secondIdentityDb.prepare('DELETE FROM sessions WHERE id=?').run(importedGoalConversationId);
    secondIdentityDb.prepare('DELETE FROM conversations WHERE id=?').run(importedGoalConversationId);
    const staleExecutionGuardTask = { id: 'stale_execution_guard_task' };
    const staleExecutionGuardNode = { id: 'stale_execution_guard_node' };
    secondIdentityDb.prepare(`INSERT INTO task_runs (
      id,account_workspace_id,owner_user_id,title,prompt,department_id,lead_agent_id,lead_agent_instance_id,
      status,summary,metadata_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      staleExecutionGuardTask.id, 'workspace_personal', 'sync_owner_device_two', 'Stale execution guard',
      'Preserve terminal task state against an older cloud snapshot.', '', '', '', 'running', '', '{}',
      '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:05.000Z',
    );
    secondIdentityDb.prepare(`INSERT INTO task_nodes (
      id,task_run_id,title,objective,department_id,agent_id,agent_instance_id,status,dependencies_json,output_format,
      estimated_minutes,priority,parallel_group,blocking,notify_json,fallback,max_attempts,retry_strategy,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      staleExecutionGuardNode.id, staleExecutionGuardTask.id, 'Terminal node', 'Finish once.', '', '', '', 'running', '[]', '',
      0, 50, '', 0, '[]', '', 3, 'automatic', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:05.000Z',
    );
    secondIdentityStore.updateTaskNode(staleExecutionGuardNode.id, {
      status: 'completed', resultText: 'terminal result', resultSummary: 'terminal result', completedAt: '2026-01-02T00:00:20.000Z',
    });
    secondIdentityStore.updateTaskRunStatus(staleExecutionGuardTask.id, 'completed', 'terminal task');
    secondIdentityStore.beginModelExecution({
      id: 'stale_execution_guard_model', userId: 'sync_owner_device_two', taskRunId: staleExecutionGuardTask.id,
      taskNodeId: staleExecutionGuardNode.id, executionKind: 'task_node', status: 'running',
    });
    secondIdentityStore.completeModelExecution('stale_execution_guard_model', { status: 'completed' });
    secondIdentityDb.prepare('UPDATE task_runs SET updated_at=?,completed_at=? WHERE id=?')
      .run('2026-01-02T00:00:20.000Z', '2026-01-02T00:00:20.000Z', staleExecutionGuardTask.id);
    secondIdentityDb.prepare('UPDATE task_nodes SET updated_at=?,completed_at=? WHERE id=?')
      .run('2026-01-02T00:00:20.000Z', '2026-01-02T00:00:20.000Z', staleExecutionGuardNode.id);
    secondIdentityDb.prepare('UPDATE model_executions SET updated_at=?,completed_at=? WHERE id=?')
      .run('2026-01-02T00:00:20.000Z', '2026-01-02T00:00:20.000Z', 'stale_execution_guard_model');
    secondIdentitySync.applyV6Changes([
      {
        changeId: 'stale_execution_guard_task_v1', entityType: 'task_run', entityId: staleExecutionGuardTask.id,
        revision: 1, operation: 'upsert', payload: {
          id: staleExecutionGuardTask.id, title: 'Stale execution guard', prompt: 'stale', status: 'running',
          summary: 'stale running snapshot', updatedAt: '2026-01-02T00:00:10.000Z', createdAt: '2026-01-02T00:00:00.000Z',
        },
      },
      {
        changeId: 'stale_execution_guard_node_v1', entityType: 'task_node', entityId: staleExecutionGuardNode.id,
        revision: 1, operation: 'upsert', payload: {
          id: staleExecutionGuardNode.id, taskRunId: staleExecutionGuardTask.id, title: 'Terminal node', objective: 'stale',
          status: 'running', resultText: '', resultSummary: '', updatedAt: '2026-01-02T00:00:10.000Z',
          createdAt: '2026-01-02T00:00:00.000Z', startedAt: '2026-01-02T00:00:05.000Z', completedAt: '',
        },
      },
      {
        changeId: 'stale_execution_guard_model_v1', entityType: 'model_execution', entityId: 'stale_execution_guard_model',
        revision: 1, operation: 'upsert', payload: {
          id: 'stale_execution_guard_model', taskRunId: staleExecutionGuardTask.id, taskNodeId: staleExecutionGuardNode.id,
          executionKind: 'task_node', status: 'running', updatedAt: '2026-01-02T00:00:10.000Z',
          startedAt: '2026-01-02T00:00:05.000Z', completedAt: '',
        },
      },
    ], { remoteUserId: 'sync_owner' });
    assert.equal(secondIdentityStore.getTaskRun(staleExecutionGuardTask.id)?.status, 'completed',
      'an older cloud task snapshot must not reopen a completed task');
    assert.equal(secondIdentityStore.getTaskNode(staleExecutionGuardNode.id)?.status, 'completed',
      'an older cloud node snapshot must not overwrite terminal node state');
    assert.equal(secondIdentityStore.getTaskNode(staleExecutionGuardNode.id)?.resultText, 'terminal result');
    assert.equal(secondIdentityStore.getModelExecution('stale_execution_guard_model')?.status, 'completed',
      'an older cloud execution snapshot must not restore a completed model execution to running');
    const secondIdentityInstance = secondIdentityStore.findUserAgentInstance({
      userId: 'sync_owner_device_two', agentFamilyId: 'sync_agent',
    });
    assert.equal(secondIdentityInstance.id, syncAgentInstance.id, 'a second device must import the existing employee instance id before editing it');
    const secondIdentityMemory = secondIdentityStore.ensureDefaultMemoryDocument({ agentInstanceId: secondIdentityInstance.id });
    secondIdentityStore.appendMemoryDocumentVersion({
      memoryDocumentId: secondIdentityMemory.id,
      content: `${secondIdentityMemory.content}\n## Device Two\n- Preserve this cross-device version.\n`,
      sourceKind: 'cross_device_check',
      reviewStatus: 'approved',
    });
    const secondIdentitySkill = secondIdentityStore.createPersonalSkillVersion({
      agentInstanceId: secondIdentityInstance.id,
      overlayText: '## Device Two Overlay\n- Keep all cross-device variants.',
    });
    secondIdentityStore.activatePersonalSkillVersion({ agentInstanceId: secondIdentityInstance.id, skillVersionId: secondIdentitySkill.id });
    const secondIdentityResult = await secondIdentitySync.syncNow({ reason: 'cross_device_identity_check' });
    assert.equal(secondIdentityResult.status, 'completed', secondIdentityResult.error || secondIdentityResult.cloud?.lastError || JSON.stringify(secondIdentityResult));
    const canonicalOnSecondDevice = secondIdentityStore.findUserAgentInstance({ userId: 'sync_owner_device_two', agentFamilyId: 'sync_agent' });
    assert.equal(canonicalOnSecondDevice.id, syncAgentInstance.id, 'the cloud instance id must remain stable across devices');
    assert.equal(Number(secondIdentityStore.db.prepare('SELECT COUNT(*) AS count FROM user_agent_instance_aliases').get().count), 0,
      'same-Family employees must not be merged through instance aliases');
    const secondDeviceCanonicalMemory = secondIdentityStore.listMemoryDocuments({ agentInstanceId: syncAgentInstance.id })[0];
    assert.equal(secondIdentityStore.getMemoryDocument(secondIdentityMemory.id)?.id, secondDeviceCanonicalMemory.id);
    const firstIdentityPull = await sync.syncNow({ reason: 'cross_device_identity_pull' });
    assert.equal(firstIdentityPull.status, 'completed');
    const mergedMemory = store.listMemoryDocuments({ agentInstanceId: syncAgentInstance.id }).filter((item) => item.scope === 'general');
    assert.equal(mergedMemory.length, 1, 'cross-device general memory must merge into one canonical memory0');
    assert.ok(store.db.prepare('SELECT COUNT(*) AS count FROM memory_document_versions WHERE memory_document_id = ?').get(mergedMemory[0].id).count >= 2);
    assert.ok(store.resolveEffectiveSkill({ agentInstanceId: syncAgentInstance.id }).effectiveSkill.includes('Device Two Overlay'));
    store.updateUserAgentConsents({ agentInstanceId: syncAgentInstance.id, personalEvolutionConsent: true });
    const cloudPersonalContext = store.resolveUserAgent({ userId: 'sync_owner_local', agentInstanceId: syncAgentInstance.id, agentFamilyId: 'sync_agent' });
    const cloudPersonalRun = store.createScopedEvolutionRun({
      scope: 'personal', userId: 'sync_owner_local', agentInstanceId: syncAgentInstance.id, agentFamilyId: 'sync_agent',
      algorithmVersion: 'personal_overlay_v2', consentSnapshot: { personalEvolutionConsent: true },
    });
    const cloudPersonalProposal = store.createPersonalEvolutionProposal({
      runId: cloudPersonalRun, userId: 'sync_owner_local', agentInstanceId: syncAgentInstance.id, agentFamilyId: 'sync_agent',
      status: 'running', syncScope: 'cloud', originDeviceId: 'device_lineage',
      baseAgentVersionId: cloudPersonalContext.baseVersion.id,
      basePersonalSkillVersionId: cloudPersonalContext.personalSkillVersion?.id || '',
      baseEffectiveSkillHash: cloudPersonalContext.effectiveSkillHash,
      baseMemoryManifestHash: cloudPersonalContext.memoryManifestHash,
      evidenceCursorFrom: {}, evidenceCursorTo: {}, evidenceCount: 20, distinctContextCount: 3,
    });
    const runningProposalUpload = await sync.syncNow({ reason: 'personal_proposal_v4_running_upload' });
    assert.equal(runningProposalUpload.status, 'completed', runningProposalUpload.error || runningProposalUpload.cloud?.lastError || JSON.stringify(runningProposalUpload));
    assert.equal(server.db.prepare(`SELECT status FROM cloud_personal_evolution_proposals_v4
      WHERE user_id = 'sync_owner' AND id = ?`).get(cloudPersonalProposal.id).status, 'legacy_proposal_stale');
    await assert.rejects(sync.decidePersonalEvolution({
      proposalId: cloudPersonalProposal.id,
      decisions: [{ targetKind: 'skill', targetId: 'not_ready_candidate', decision: 'accept' }],
    }), /not reviewable from status legacy_proposal_stale/);
    const cloudPersonalCandidate = store.createPersonalSkillVersion({
      agentInstanceId: syncAgentInstance.id, overlayText: '## Cloud Personal Rule\n- Preserve the first canonical cross-device decision.', sourceEvolutionRunId: cloudPersonalRun,
    });
    store.updatePersonalEvolutionProposal(cloudPersonalProposal.id, {
      status: 'ready', candidatePersonalSkillVersionId: cloudPersonalCandidate.id,
      proposalMarkdown: '# Personal Evolution Proposal\n\nSanitized cross-device decision fixture.\n',
      proposalHash: sha256Text('sanitized-cross-device-proposal'),
      proposedOverlayText: cloudPersonalCandidate.overlayText,
      proposedOverlayHash: cloudPersonalCandidate.effectiveSkillHash,
      gate: { status: 'passed', score: 1 }, privacyReport: { flagCount: 0 },
      evaluationSummary: { regressionCount: 0, averageImprovement: 0.2 }, autoActivationEligible: true,
    });
    const cloudPersonalMemory = store.getMemoryDocument(mergedMemory[0].id);
    const cloudPersonalMemoryOperations = store.addPersonalEvolutionMemoryOperations(cloudPersonalProposal.id, [
      {
        memoryDocumentId: cloudPersonalMemory.id,
        sectionName: 'Workflow Notes',
        operationType: 'add',
        targetItemHash: '',
        proposedText: 'Apply the first canonical cross-device Memory decision.',
        rationale: 'Cross-device Memory decisions must use the same first-decision-wins contract.',
        baselineVersionId: cloudPersonalMemory.currentVersionId,
        baselineContentHash: cloudPersonalMemory.contentHash,
      },
      {
        memoryDocumentId: cloudPersonalMemory.id,
        sectionName: 'Workflow Notes',
        operationType: 'add',
        targetItemHash: '',
        proposedText: 'Apply all accepted operations from the same Proposal in sequence.',
        rationale: 'Multiple accepted operations for one document must remain deterministic.',
        baselineVersionId: cloudPersonalMemory.currentVersionId,
        baselineContentHash: cloudPersonalMemory.contentHash,
      },
    ]);
    const proposalUpload = await sync.syncNow({ reason: 'personal_proposal_v4_upload' });
    assert.equal(proposalUpload.status, 'completed');
    const finalizedCloudProposal = server.db.prepare(`SELECT status, proposal_hash, payload_json
      FROM cloud_personal_evolution_proposals_v4 WHERE user_id = 'sync_owner' AND id = ?`).get(cloudPersonalProposal.id);
    assert.equal(finalizedCloudProposal.status, 'ready');
    assert.equal(finalizedCloudProposal.proposal_hash, sha256Text('sanitized-cross-device-proposal'));
    assert.equal(JSON.parse(finalizedCloudProposal.payload_json).status, 'ready', 'a finalized Proposal must replace its earlier running payload');
    const secondProposalStagePull = await secondIdentitySync.syncNow({ reason: 'personal_proposal_v4_stage_second_device' });
    assert.equal(secondProposalStagePull.status, 'completed');
    assert.deepEqual(secondIdentityStore.getPersonalEvolutionProposal(cloudPersonalProposal.id).memoryOperations.map((item) => item.status), ['pending', 'pending']);
    await assert.rejects(secondIdentitySync.decidePersonalEvolution({
      proposalId: cloudPersonalProposal.id,
      decisions: [{ targetKind: 'skill', targetId: 'foreign_personal_skill', decision: 'accept' }],
    }), /does not belong to the Proposal/);
    const acceptedPersonalDecision = await sync.decidePersonalEvolution({
      proposalId: cloudPersonalProposal.id,
      decisions: [
        { targetKind: 'skill', targetId: cloudPersonalCandidate.id, decision: 'accept' },
        ...cloudPersonalMemoryOperations.map((item) => ({ targetKind: 'memory_operation', targetId: item.id, decision: 'accept' })),
      ],
    });
    assert.equal(acceptedPersonalDecision.status, 'accepted');
    const conflictingPersonalDecision = await secondIdentitySync.decidePersonalEvolution({
      proposalId: cloudPersonalProposal.id,
      decisions: [
        { targetKind: 'skill', targetId: cloudPersonalCandidate.id, decision: 'reject' },
        ...cloudPersonalMemoryOperations.map((item) => ({ targetKind: 'memory_operation', targetId: item.id, decision: 'reject' })),
      ],
    });
    assert.equal(conflictingPersonalDecision.status, 'conflict');
    assert.deepEqual(conflictingPersonalDecision.actions.map((item) => item.decision), ['accept', 'accept', 'accept']);
    const secondPersonalPull = await secondIdentitySync.syncNow({ reason: 'personal_proposal_v4_pull' });
    assert.equal(secondPersonalPull.status, 'completed');
    assert.equal(secondIdentityStore.getPersonalEvolutionProposal(cloudPersonalProposal.id)?.skillActionStatus, 'activated');
    assert.ok(secondIdentityStore.resolveEffectiveSkill({ agentInstanceId: syncAgentInstance.id }).effectiveSkill.includes('Cloud Personal Rule'));
    const secondDevicePersonalProposal = secondIdentityStore.getPersonalEvolutionProposal(cloudPersonalProposal.id);
    assert.deepEqual(secondDevicePersonalProposal.memoryOperations.map((item) => item.status), ['applied', 'applied']);
    assert.match(secondIdentityStore.getMemoryDocument(secondDeviceCanonicalMemory.id).content, /first canonical cross-device Memory decision/,
      JSON.stringify(secondIdentityStore.listMemoryDocuments({ agentInstanceId: syncAgentInstance.id }).map((item) => ({ id: item.id, cloudKey: item.cloudKey, scope: item.scope, slotNo: item.slotNo, lifecycle: item.lifecycleState, content: item.content }))));
    assert.match(secondIdentityStore.getMemoryDocument(secondDeviceCanonicalMemory.id).content, /all accepted operations from the same Proposal/);
    const memoryVersionCountBeforeCanonicalReplay = Number(secondIdentityStore.db.prepare(
      'SELECT COUNT(*) AS count FROM memory_document_versions WHERE memory_document_id = ?',
    ).get(secondDeviceCanonicalMemory.id).count);
    const canonicalActions = server.db.prepare(`SELECT payload_json FROM cloud_personal_evolution_actions_v4
      WHERE user_id = 'sync_owner' AND proposal_id = ? ORDER BY received_at, id`).all(cloudPersonalProposal.id);
    for (const action of canonicalActions) {
      assert.equal(secondIdentitySync.applyCanonicalPersonalEvolutionAction('sync_owner_device_two', JSON.parse(action.payload_json)).status, 'already_applied');
    }
    assert.equal(
      Number(secondIdentityStore.db.prepare('SELECT COUNT(*) AS count FROM memory_document_versions WHERE memory_document_id = ?')
        .get(secondDeviceCanonicalMemory.id).count),
      memoryVersionCountBeforeCanonicalReplay,
      'replaying canonical actions must not duplicate Memory versions',
    );
    secondIdentitySync.close();
    secondIdentityDb.close();
    server.db.prepare(`INSERT INTO cloud_user_agent_instances_v3 (
      user_id,id,agent_family_id,base_agent_version_id,status,instance_kind,employment_state,sync_enabled,
      personal_evolution_consent,cluster_contribution_consent,payload_json,created_at,updated_at
    ) VALUES ('sync_owner','sync_agent_instance_b','sync_agent',?,'active','employee','active',1,1,0,?,?,?)`).run(
      syncAgentVersion.id,
      JSON.stringify({ familyInstanceSeq: 2, displayName: 'Sync Agent B', note: 'Second isolated instance' }),
      new Date().toISOString(),
      new Date().toISOString(),
    );
    const evolutionImportRoot = path.join(tmp, 'cloud-evolution-identity-import');
    const evolutionImportDb = openDatabase(evolutionImportRoot);
    const importedEvolutionIdentity = importCloudEvolutionEvidence({
      cloudDbPath: path.join(cloudHome, 'cloud.db'),
      runtimeDb: evolutionImportDb,
    });
    assert.equal(importedEvolutionIdentity.importedUserAgentInstances, 2);
    assert.equal(importedEvolutionIdentity.importedMemoryDocuments, 2);
    assert.equal(Number(evolutionImportDb.prepare('SELECT COUNT(*) AS count FROM user_agent_instances').get().count), 2);
    assert.deepEqual(
      { ...evolutionImportDb.prepare(`SELECT agent_family_id,family_instance_seq,display_name,note
        FROM user_agent_instances WHERE id='sync_agent_instance_b'`).get() },
      { agent_family_id: 'sync_agent', family_instance_seq: 2, display_name: 'Sync Agent B', note: 'Second isolated instance' },
    );
    assert.ok(Number(evolutionImportDb.prepare('SELECT COUNT(*) AS count FROM memory_document_versions').get().count) >= 2);
    const importedEncryptedTaskVersion = evolutionImportDb.prepare("SELECT * FROM memory_document_versions WHERE encryption_algorithm='aes-256-gcm' LIMIT 1").get();
    assert.equal(importedEncryptedTaskVersion.content, '');
    assert.ok(importedEncryptedTaskVersion.content_ciphertext);
    evolutionImportDb.close();
    const duplicateRefs = payload.data.fileRefs.filter((item) => item.originalName.startsWith('evidence'));
    const sha256 = duplicateRefs[0].sha256;
    const trace = await sync.traceFile({ sha256, userId: 'sync_owner_local', deviceId: 'device_lineage' });
    assert.equal(trace.status, 'ok');
    assert.equal(trace.refs.length, 2);
    assert.equal(trace.contexts.length, 2);
    const projectContext = trace.contexts.find((item) => item.conversation.id === projectSession.id);
    assert.equal(projectContext.project.id, project.id);
    assert.equal(projectContext.messages[0].content, 'project question');
    assert.equal(projectContext.messages[1].content, 'project answer');
    assert.ok(projectContext.messages[2].content.startsWith('__JANUS_ARTIFACT__'));
    assert.equal(projectContext.messages[2].content.includes(localRoot), false);
    assert.ok(trace.refs.some((item) => item.messageId === ordinaryMessage.id));
    assert.ok(trace.refs.some((item) => item.messageId === projectMessage.id));
    const deviceScopedConversation = await sync.traceConversation({ conversationId: projectSession.id });
    assert.equal(deviceScopedConversation.status, 'ok');
    assert.equal(deviceScopedConversation.contexts[0].project.id, project.id);
    const ordinaryContext = await sync.traceConversation({ conversationId: ordinary.id });
    assert.equal(ordinaryContext.contexts[0].modelExecutions[0].effectiveModel, 'gpt-5.6-sol');

    const second = await sync.syncNow({ reason: 'lineage_idempotency_check' });
    assert.equal(second.status, 'completed');
    assert.equal(Number(server.db.prepare('SELECT COUNT(*) AS count FROM cloud_file_refs_v2').get().count), 4);
    assert.equal(Number(server.db.prepare('SELECT COUNT(*) AS count FROM cloud_model_executions_v2').get().count), 1);
    assert.equal(Number(server.db.prepare('SELECT COUNT(*) AS count FROM file_links').get().count), 4);
    store.updateSession(ordinary.id, { deleted: true });
    const ordinaryDeleteSync = await sync.syncNow({ reason: 'lineage_delete_ordinary' });
    assert.equal(ordinaryDeleteSync.status, 'completed');
    const retainedSharedObject = await sync.traceFile({ sha256, userId: 'sync_owner_local', deviceId: 'device_lineage' });
    assert.equal(retainedSharedObject.refs.length, 1, 'cloud object must remain while another conversation still references the same SHA');
    assert.equal(retainedSharedObject.refs[0].conversationId, projectSession.id);
    store.updateSession(projectSession.id, { deleted: true });
    const projectDeleteSync = await sync.syncNow({ reason: 'lineage_delete_project' });
    assert.equal(projectDeleteSync.status, 'completed');
    assert.equal(server.db.prepare('SELECT sha256 FROM file_objects WHERE sha256 = ?').get(sha256), undefined, 'cloud object must be deleted after its last conversation reference is removed');
    const legacyProjectId = 'legacy_project';
    const legacyConversationId = 'legacy_conversation';
    const legacyResponse = await fetch(`http://127.0.0.1:${info.port}/v1/sync/batches`, {
      method: 'POST',
      headers: { authorization: 'Bearer lineage-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        batch: { id: 'legacy_batch', cursorFrom: '', cursorTo: new Date().toISOString(), itemCount: 3 },
        device: { userId: 'legacy_sync_owner', deviceId: 'legacy_device' },
        data: {
          projects: [{ id: legacyProjectId, user_id: 'legacy_user', title: 'Legacy project', workspace_root: '/private/legacy/path', status: 'active', updated_at: new Date().toISOString() }],
          sessions: [{ id: legacyConversationId, user_id: 'legacy_user', title: 'Legacy project chat', project_id: legacyProjectId, department_id: 'ppt_department', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
          messages: [{ id: 'legacy_message', session_id: legacyConversationId, role: 'user', content: 'legacy question', metadata: {}, created_at: new Date().toISOString() }],
        },
        files: [],
      }),
    });
    assert.equal(legacyResponse.status, 200);
    assert.equal(server.db.prepare('SELECT conversation_type FROM cloud_conversations_v2 WHERE device_id = ? AND id = ?').get('legacy_device', legacyConversationId).conversation_type, 'project');
    const legacyStoredProject = JSON.parse(server.db.prepare('SELECT payload_json FROM cloud_projects_v2 WHERE device_id = ? AND id = ?').get('legacy_device', legacyProjectId).payload_json);
    assert.equal(JSON.stringify(legacyStoredProject).includes('/private/legacy/path'), false);
    assert.ok(sync.status().lastSyncCursor);
    const retargeted = sync.saveConfig({ serverUrl: `http://127.0.0.1:${info.port + 1}` });
    assert.equal(retargeted.lastSyncCursor, '');
    assert.equal(retargeted.pendingFileCount, 4);
  } finally {
    sync.close();
    db.close();
    await server.close();
  }
}

function assertPngDimensions(file, width, height) {
  assert.ok(existsSync(file), `missing PNG icon ${file}`);
  const buffer = readFileSync(file);
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `invalid PNG signature ${file}`);
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR', `missing PNG IHDR ${file}`);
  assert.equal(buffer.readUInt32BE(16), width, `unexpected PNG width ${file}`);
  assert.equal(buffer.readUInt32BE(20), height, `unexpected PNG height ${file}`);
}

function assertIco(file, expectedEntries) {
  assert.ok(existsSync(file), `missing ICO icon ${file}`);
  const buffer = readFileSync(file);
  assert.equal(buffer.readUInt16LE(0), 0, `invalid ICO reserved field ${file}`);
  assert.equal(buffer.readUInt16LE(2), 1, `invalid ICO type ${file}`);
  assert.equal(buffer.readUInt16LE(4), expectedEntries, `unexpected ICO entry count ${file}`);
}

function assertIcns(file) {
  assert.ok(existsSync(file), `missing ICNS icon ${file}`);
  const buffer = readFileSync(file);
  assert.equal(buffer.subarray(0, 4).toString('ascii'), 'icns', `invalid ICNS signature ${file}`);
  assert.equal(buffer.readUInt32BE(4), buffer.length, `invalid ICNS declared size ${file}`);
  assert.ok(buffer.includes(Buffer.from('ic10')), `ICNS is missing 1024px icon chunk ${file}`);
}

async function cleanupTempDir(dir) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 7) {
        console.warn(`warning: unable to remove temp dir ${dir}: ${error.message || error}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 + attempt * 100));
    }
  }
}
