import { createRequire } from 'node:module';
import { createBufferedSubscriber } from './bufferedSubscriber.js';
import { createFollowerPreloadBridge } from './follower.js';

const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer, webUtils } = require('electron');

function createBufferedNavigationSubscription(channel) {
  const bridge = createBufferedSubscriber();
  ipcRenderer.on(channel, (_event, payload) => bridge.emit(payload));
  return (callback) => bridge.subscribe(callback);
}

const onSocialOpenTask = createBufferedNavigationSubscription('social:open-task');
const onSystemOpenConversation = createBufferedNavigationSubscription('system:open-conversation');
const onSystemOpenAgentSession = createBufferedNavigationSubscription('system:open-agent-session');
const onSystemOpenUpdates = createBufferedNavigationSubscription('system:open-updates');
const onSystemOpenFollower = createBufferedNavigationSubscription('system:open-follower');
const onDesktopNotification = createBufferedNavigationSubscription('desktop:notification');
const voiceCallSignalSubscribers = new Set();
const deliverVoiceCallEvent = (payload) => {
  try { window.dispatchEvent(new CustomEvent('janus:voice-call-incoming', { detail: payload })); } catch {}
  for (const callback of voiceCallSignalSubscribers) {
    try { callback(payload); } catch {}
  }
};
ipcRenderer.on('voice-call:signal', (_event, payload) => deliverVoiceCallEvent(payload));
ipcRenderer.on('voice-call:event', (_event, payload) => deliverVoiceCallEvent(payload));

contextBridge.exposeInMainWorld('janus', {
  ...createFollowerPreloadBridge(ipcRenderer),
  platform: process.platform,
  setUiLanguage: (language) => ipcRenderer.invoke('app:set-ui-language', { language }),
  openVoiceCallWindow: (payload = {}) => ipcRenderer.invoke('voice-call-window:open', payload),
  auxiliaryWindowPayload: (value) => ipcRenderer.invoke('aux-window:payload', typeof value === 'string' ? { token: value } : (value || {})),
  closeAuxiliaryWindow: (value, submitted = false) => ipcRenderer.invoke('aux-window:close', typeof value === 'string' ? { token: value, submitted } : (value || {})),
  minimizeAuxiliaryWindow: (token) => ipcRenderer.invoke('aux-window:minimize', { token }),
  toggleMaximizeAuxiliaryWindow: (token) => ipcRenderer.invoke('aux-window:toggle-maximize', { token }),
  setVoiceCallSharingMode: (token, sharing) => ipcRenderer.invoke('voice-call-window:sharing-mode', { token, sharing }),
  listVoiceCallDesktopSources: (token) => ipcRenderer.invoke('voice-call-window:desktop-sources', { token }),
  sendVoiceCallSignal: (payload = {}) => ipcRenderer.invoke('voice-call:signal', payload),
  recordVoiceCall: (payload = {}) => ipcRenderer.invoke('voice-call:record', payload),
  leaveVoiceCall: (payload = {}) => ipcRenderer.invoke('voice-call:leave', payload),
  sendVoiceCallChat: (payload = {}) => ipcRenderer.invoke('voice-call:chat', payload),
  inviteVoiceCallParticipant: (payload = {}) => ipcRenderer.invoke('voice-call:invite', payload),
  kickVoiceCallParticipant: (payload = {}) => ipcRenderer.invoke('voice-call:kick', payload),
  onVoiceCallSignal: (callback) => {
    if (typeof callback !== 'function') return () => {};
    voiceCallSignalSubscribers.add(callback);
    return () => voiceCallSignalSubscribers.delete(callback);
  },
  voiceCallIceServers: () => ipcRenderer.invoke('voice-call:ice-servers'),
  videoRoomConfig: (workspaceId = '', callId = '', groupId = '') => ipcRenderer.invoke('video-room:config', { workspaceId, callId, groupId }),
  openVideoRoomWindow: (payload = {}) => ipcRenderer.invoke('video-room-window:open', payload),
  bootstrap: (payload = {}) => ipcRenderer.invoke('app:bootstrap', payload),
  listAccountWorkspaces: () => ipcRenderer.invoke('account-workspaces:list'),
  switchAccountWorkspace: (payload = {}) => ipcRenderer.invoke('account-workspaces:switch', payload),
  setStartupAccountWorkspace: (payload = {}) => ipcRenderer.invoke('account-workspaces:set-startup', payload),
  currentUser: () => ipcRenderer.invoke('auth:me'),
  login: (payload) => ipcRenderer.invoke('auth:login', payload),
  register: (payload) => ipcRenderer.invoke('auth:register', payload),
  sendEmailCode: (payload) => ipcRenderer.invoke('auth:send-email-code', payload),
  verifyEmail: (payload) => ipcRenderer.invoke('auth:verify-email', payload),
  resetPasswordByEmail: (payload) => ipcRenderer.invoke('auth:reset-password-email', payload),
  logout: () => ipcRenderer.invoke('auth:logout'),
  feishuStatus: () => ipcRenderer.invoke('feishu:status'),
  testFeishuConfig: (payload = {}) => ipcRenderer.invoke('feishu:test-config', payload),
  saveFeishuConfig: (payload = {}) => ipcRenderer.invoke('feishu:save-config', payload),
  enableFeishu: () => ipcRenderer.invoke('feishu:enable'),
  disableFeishu: () => ipcRenderer.invoke('feishu:disable'),
  regenerateFeishuBindingCode: () => ipcRenderer.invoke('feishu:regenerate-binding-code'),
  unbindFeishu: () => ipcRenderer.invoke('feishu:unbind'),
  authProfile: () => ipcRenderer.invoke('auth:profile'),
  updateProfile: (payload) => ipcRenderer.invoke('auth:update-profile', payload),
  updatePassword: (payload) => ipcRenderer.invoke('auth:update-password', payload),
  listUsers: () => ipcRenderer.invoke('admin:users'),
  updateUserRole: (payload) => ipcRenderer.invoke('admin:update-user-role', payload),
  resetUserPassword: (payload) => ipcRenderer.invoke('admin:reset-user-password', payload),
  deleteUser: (payload) => ipcRenderer.invoke('admin:delete-user', payload),
  friendsOverview: () => ipcRenderer.invoke('friends:overview'),
  socialInbox: (payload = {}) => ipcRenderer.invoke('social:inbox', payload),
  sendSocialMessage: (payload = {}) => ipcRenderer.invoke('social:send-message', payload),
  updateSocialMessage: (payload = {}) => ipcRenderer.invoke('social:update-message', payload),
  toggleSocialMessageReaction: (payload = {}) => ipcRenderer.invoke('social:toggle-reaction', payload),
  markSocialMessageRead: (payload = {}) => ipcRenderer.invoke('social:mark-read', payload),
  socialConversation: (payload = {}) => ipcRenderer.invoke('social:conversation', payload),
  socialConversationSummaries: (payload = {}) => ipcRenderer.invoke('social:conversation-summaries', payload),
  pollSocialNetwork: (payload = {}) => ipcRenderer.invoke('social:poll', payload),
  socialStatus: () => ipcRenderer.invoke('social:status'),
  listEmojiFavorites: () => ipcRenderer.invoke('social:emoji-favorites-list'),
  addEmojiFavorite: (payload = {}) => ipcRenderer.invoke('social:emoji-favorites-add', payload),
  removeEmojiFavorite: (payload = {}) => ipcRenderer.invoke('social:emoji-favorites-remove', payload),
  reorderEmojiFavorites: (payload = {}) => ipcRenderer.invoke('social:emoji-favorites-reorder', payload),
  setConversationArchived: (payload = {}) => ipcRenderer.invoke('social:set-conversation-archived', payload),
  conversationPreferencesOverview: () => ipcRenderer.invoke('social:conversation-preferences'),
  uBuddyCapabilityProfilePreview: () => ipcRenderer.invoke('ubuddy:capability-profile-preview'),
  queryUBuddyCapabilityProfiles: (payload = {}) => ipcRenderer.invoke('social:ubuddy-profiles-query', payload),
  uBuddyCapabilityProfilePublicationStatus: () => ipcRenderer.invoke('social:ubuddy-profile-publication-status'),
  uBuddyCapabilityProfileHistory: (payload = {}) => ipcRenderer.invoke('ubuddy:capability-profile-history', payload),
  regenerateUBuddyCapabilityProfile: () => ipcRenderer.invoke('ubuddy:capability-profile-regenerate'),
  reviewUBuddyCapabilityProfile: (payload = {}) => ipcRenderer.invoke('ubuddy:capability-profile-review', payload),
  updateUBuddyCapabilityProfilePublicationPreference: (payload = {}) => ipcRenderer.invoke('ubuddy:capability-profile-publication-preference', payload),
  publishUBuddyCapabilityProfile: (payload = {}) => ipcRenderer.invoke('social:ubuddy-profile-publish', payload),
  unpublishUBuddyCapabilityProfile: (payload = {}) => ipcRenderer.invoke('social:ubuddy-profile-unpublish', payload),
  retryUBuddyCapabilityProfilePublication: () => ipcRenderer.invoke('social:ubuddy-profile-publication-retry'),
  chatGroupsOverview: () => ipcRenderer.invoke('chat-groups:overview'),
  chatGroup: (payload = {}) => ipcRenderer.invoke('chat-groups:group', payload),
  createChatGroup: (payload = {}) => ipcRenderer.invoke('chat-groups:create', payload),
  sendChatGroupMessage: (payload = {}) => ipcRenderer.invoke('chat-groups:send-message', payload),
  markChatGroupRead: (payload = {}) => ipcRenderer.invoke('chat-groups:mark-read', payload),
  updateChatGroup: (payload = {}) => ipcRenderer.invoke('chat-groups:update', payload),
  ensureSecretarySession: (payload = {}) => ipcRenderer.invoke('secretary:ensure-session', payload),
  secretaryTaskReferenceOptions: (payload = {}) => ipcRenderer.invoke('secretary:task-reference-options', payload),
  secretaryChat: (payload = {}) => ipcRenderer.invoke('secretary:chat', payload),
  privateAssistantStatus: () => ipcRenderer.invoke('private-assistant:status'),
  managedProviderUsageStatus: () => ipcRenderer.invoke('managed-provider-usage:status'),
  ensurePrivateAssistantSession: (payload = {}) => ipcRenderer.invoke('private-assistant:ensure-session', payload),
  resetPrivateAssistantContext: (payload = {}) => ipcRenderer.invoke('private-assistant:reset-context', payload),
  listAgentDelegations: (payload = {}) => ipcRenderer.invoke('delegations:list', payload),
  attachedSkillInboxPath: () => ipcRenderer.invoke('skills:attached-inbox-path'),
  scanAttachedSkillInbox: () => ipcRenderer.invoke('skills:attached-inbox-scan'),
  createAgentDelegation: (payload = {}) => ipcRenderer.invoke('delegations:create', payload),
  processAgentDelegationContent: (payload = {}) => ipcRenderer.invoke('delegations:process-content', payload),
  respondAgentDelegation: (payload = {}) => ipcRenderer.invoke('delegations:respond', payload),
  startAgentDelegation: (payload = {}) => ipcRenderer.invoke('delegations:start', payload),
  supplementRecentWorkDigest: (payload = {}) => ipcRenderer.invoke('delegations:work-digest-supplement', payload),
  delegationTaskMemory: (payload = {}) => ipcRenderer.invoke('delegations:task-memory', payload),
  collaborationOverview: () => ipcRenderer.invoke('collaboration:overview'),
  dispatchCollaborationCommand: (payload = {}) => ipcRenderer.invoke('collaboration:dispatch-command', payload),
  cancelPendingUBuddyDispatch: (payload = {}) => ipcRenderer.invoke('collaboration:cancel-pending-dispatch', payload),
  collaborationGroup: (payload = {}) => ipcRenderer.invoke('collaboration:group', payload),
  collaborationGroupWorkspace: (payload = {}) => ipcRenderer.invoke('collaboration:group-workspace', payload),
  sendCollaborationMessage: (payload = {}) => ipcRenderer.invoke('collaboration:send-message', payload),
  prepareCollaborationGroupSummary: (payload = {}) => ipcRenderer.invoke('collaboration:prepare-summary', payload),
  publishCollaborationGroupSummary: (payload = {}) => ipcRenderer.invoke('collaboration:publish-summary', payload),
  updateCollaborationGroup: (payload = {}) => ipcRenderer.invoke('collaboration:update-group', payload),
  collaborationTaskAction: (payload = {}) => ipcRenderer.invoke('collaboration:task-action', payload),
  downloadCollaborationFile: (payload = {}) => ipcRenderer.invoke('collaboration:download-file', payload),
  collaborationWorkspaceMessages: (payload = {}) => ipcRenderer.invoke('collaboration:workspace-messages', payload),
  collaborationWorkspaceMessage: (payload = {}) => ipcRenderer.invoke('collaboration:workspace-message', payload),
  cancelCollaborationWorkspaceWork: (payload = {}) => ipcRenderer.invoke('collaboration:workspace-cancel', payload),
  taskRunWorkspaceMessages: (payload = {}) => ipcRenderer.invoke('task-run:workspace-messages', payload),
  taskRunWorkspaceMessage: (payload = {}) => ipcRenderer.invoke('task-run:workspace-message', payload),
  searchUsers: (payload) => ipcRenderer.invoke('friends:search-users', payload),
  sendFriendRequest: (payload) => ipcRenderer.invoke('friends:send-request', payload),
  acceptFriendRequest: (payload) => ipcRenderer.invoke('friends:accept-request', payload),
  rejectFriendRequest: (payload) => ipcRenderer.invoke('friends:reject-request', payload),
  cancelFriendRequest: (payload) => ipcRenderer.invoke('friends:cancel-request', payload),
  removeFriend: (payload) => ipcRenderer.invoke('friends:remove', payload),
  updateFriendRemark: (payload) => ipcRenderer.invoke('friends:update-remark', payload),
  blockUser: (payload) => ipcRenderer.invoke('friends:block', payload),
  createOrganization: (payload) => ipcRenderer.invoke('organizations:create', payload),
  joinOrganization: (payload) => ipcRenderer.invoke('organizations:join', payload),
  organizationAction: (payload) => ipcRenderer.invoke('organizations:action', payload),
  organizationResearchPolicy: (payload = {}) => ipcRenderer.invoke('organization-research:policy', payload),
  enableOrganizationResearch: (payload = {}) => ipcRenderer.invoke('organization-research:enable', payload),
  syncOrganizationResearch: (payload = {}) => ipcRenderer.invoke('organization-research:sync', payload),
  investigateOrganizationMessages: (payload = {}) => ipcRenderer.invoke('organization-research:investigate', payload),
  organizationResearchSource: (payload = {}) => ipcRenderer.invoke('organization-research:source', payload),
  organizationResearchResult: (payload = {}) => ipcRenderer.invoke('organization-research:result', payload),
  organizationResearchAudits: (payload = {}) => ipcRenderer.invoke('organization-research:audits', payload),
  cloudStatus: () => ipcRenderer.invoke('cloud:status'),
  saveCloudConfig: (payload) => ipcRenderer.invoke('cloud:save-config', payload),
  syncCloudNow: (payload) => ipcRenderer.invoke('cloud:sync-now', payload),
  uploadCompliance: (payload = {}) => ipcRenderer.invoke('cloud:upload-compliance', payload),
  suspendCloudUser: (payload = {}) => ipcRenderer.invoke('cloud:suspend-user', payload),
  reactivateCloudUser: (payload = {}) => ipcRenderer.invoke('cloud:reactivate-user', payload),
  traceCloudFile: (payload) => ipcRenderer.invoke('cloud:trace-file', payload),
  traceCloudConversation: (payload) => ipcRenderer.invoke('cloud:trace-conversation', payload),
  userAgentSettings: () => ipcRenderer.invoke('agents:user-settings'),
  updateUserAgentSettings: (payload) => ipcRenderer.invoke('agents:update-user-settings', payload),
  employeeOverview: (payload = {}) => ipcRenderer.invoke('employees:overview', payload),
  employeeAvailability: (payload = {}) => ipcRenderer.invoke('employees:availability', payload),
  recruitEmployee: (payload) => invokeEmployeeMutation('employees:recruit', payload),
  updateEmployeeProfile: (payload) => invokeEmployeeMutation('employees:update-profile', payload),
  deactivateEmployee: (payload) => invokeEmployeeMutation('employees:deactivate', payload),
  reactivateEmployee: (payload) => invokeEmployeeMutation('employees:reactivate', payload),
  retryEmployeeLifecycleSync: (payload = {}) => invokeEmployeeMutation('employees:retry-sync', payload),
  employeeRecruitmentEvents: (payload = {}) => ipcRenderer.invoke('employees:events', payload),
  employeeMemoryDocuments: (payload = {}) => ipcRenderer.invoke('employees:memory-documents', payload),
  employeeMemoryDetails: (payload = {}) => ipcRenderer.invoke('employees:memory-details', payload),
  employeeMemoryVersions: (payload = {}) => ipcRenderer.invoke('employees:memory-versions', payload),
  createEmployeeMemory: (payload = {}) => invokeEmployeeMutation('employees:memory-create', payload),
  archiveEmployeeMemory: (payload = {}) => invokeEmployeeMutation('employees:memory-archive', payload),
  switchEmployeeMemory: (payload = {}) => invokeEmployeeMutation('employees:memory-switch', payload),
  clearEmployeeMemory: (payload = {}) => invokeEmployeeMutation('employees:memory-clear', payload),
  restoreEmployeeMemory: (payload = {}) => invokeEmployeeMutation('employees:memory-restore', payload),
  restoreAndSwitchEmployeeMemory: (payload = {}) => invokeEmployeeMutation('employees:memory-restore-switch', payload),
  renameEmployeeMemory: (payload = {}) => invokeEmployeeMutation('employees:memory-rename', payload),
  employeeMemoryConflicts: (payload = {}) => ipcRenderer.invoke('employees:memory-conflicts', payload),
  resolveEmployeeMemoryConflict: (payload = {}) => invokeEmployeeMutation('employees:memory-conflict-resolve', payload),
  employeeContextSpaces: (payload = {}) => ipcRenderer.invoke('employees:context-spaces', payload),
  switchEmployeeContext: (payload = {}) => invokeEmployeeMutation('employees:context-switch', payload),
  employeeSessionHistory: (payload = {}) => ipcRenderer.invoke('employees:session-history', payload),
  employeeConversationOverview: (payload = {}) => ipcRenderer.invoke('employees:conversation-overview', payload),
  employeeConversationHistoryGroup: (payload = {}) => ipcRenderer.invoke('employees:conversation-history-group', payload),
  openAgentConversation: (payload = {}) => ipcRenderer.invoke('agents:conversation-open', payload),
  agentConversationTimeline: (payload = {}) => ipcRenderer.invoke('agents:conversation-timeline', payload),
  employeeLeadershipHistory: (payload = {}) => ipcRenderer.invoke('employees:leadership-history', payload),
  requestEmployeeLeadershipTrial: (payload = {}) => invokeEmployeeMutation('employees:leadership-trial', payload),
  decideEmployeeLeadershipAction: (payload = {}) => invokeEmployeeMutation('employees:leadership-decision', payload),
  restoreEmployeeLeadership: (payload = {}) => invokeEmployeeMutation('employees:leadership-restore', payload),
  employeeLeadershipAppeals: (payload = {}) => ipcRenderer.invoke('employees:leadership-appeals', payload),
  submitEmployeeLeadershipAppeal: (payload = {}) => invokeEmployeeMutation('employees:leadership-appeal-submit', payload),
  leadershipGovernanceQueue: () => ipcRenderer.invoke('employees:leadership-governance-queue'),
  decideLeadershipGovernanceAction: (payload = {}) => invokeEmployeeMutation('employees:leadership-governance-decision', payload),
  decideLeadershipGovernanceAppeal: (payload = {}) => invokeEmployeeMutation('employees:leadership-appeal-decision', payload),
  workMemoryProgress: (payload = {}) => ipcRenderer.invoke('work-memory:progress', payload),
  readWorkMemory: (payload = {}) => ipcRenderer.invoke('work-memory:read', payload),
  publishWorkMemory: (payload = {}) => ipcRenderer.invoke('work-memory:publish', payload),
  workMemoryOutbox: (payload = {}) => ipcRenderer.invoke('work-memory:outbox', payload),
  workMemoryAudits: (payload = {}) => ipcRenderer.invoke('work-memory:audits', payload),
  appointWorkMemoryLeader: (payload = {}) => ipcRenderer.invoke('work-memory:appoint', payload),
  revokeWorkMemoryLeader: (payload = {}) => ipcRenderer.invoke('work-memory:revoke', payload),
  personalEvolutionStatus: () => ipcRenderer.invoke('personal-evolution:status'),
  evolutionPreference: () => ipcRenderer.invoke('personal-evolution:preference'),
  setEvolutionPreference: (payload = {}) => ipcRenderer.invoke('personal-evolution:set-preference', payload),
  checkEvolutionUpdates: () => ipcRenderer.invoke('personal-evolution:check-updates'),
  personalEvolutionVersions: (payload = {}) => ipcRenderer.invoke('personal-evolution:versions', payload),
  activatePersonalEvolutionVersion: (payload = {}) => ipcRenderer.invoke('personal-evolution:activate-version', payload),
  personalEvolutionSchedule: (payload) => ipcRenderer.invoke('personal-evolution:schedule', payload),
  stage8EvolutionStatus: () => ipcRenderer.invoke('stage8-evolution:status'),
  agentPerformanceLevel: (payload) => ipcRenderer.invoke('stage8-evolution:performance', payload),
  clusterEvolutionOverview: () => ipcRenderer.invoke('stage8-evolution:cluster-overview'),
  marketVersions: (payload) => ipcRenderer.invoke('stage8-evolution:market-versions', payload),
  setMarketCanaryOptIn:(payload)=>ipcRenderer.invoke('stage8-evolution:canary-opt-in',payload),
  adoptMarketSections: (payload) => ipcRenderer.invoke('stage8-evolution:adopt', payload),
  rollbackMarketSections: (payload) => ipcRenderer.invoke('stage8-evolution:rollback', payload),
  ignoreMarketSections: (payload) => ipcRenderer.invoke('stage8-evolution:ignore', payload),
  listEvolutionGrants: () => ipcRenderer.invoke('personal-evolution:grants'),
  revokeEvolutionGrant: (payload) => ipcRenderer.invoke('personal-evolution:grant-revoke', payload),
  approveEvolutionGrant: (payload) => ipcRenderer.invoke('personal-evolution:grant-approve', payload),
  listPersonalEvolutionProposals: (payload) => ipcRenderer.invoke('personal-evolution:list', payload),
  getPersonalEvolutionProposal: (payload) => ipcRenderer.invoke('personal-evolution:get', payload),
  runPersonalEvolution: (payload) => ipcRenderer.invoke('personal-evolution:run', payload),
  uBuddyOrganizationEvolutionOverview: () => ipcRenderer.invoke('ubuddy-organization-evolution:overview'),
  activateUBuddyOrganizationEvolution: (payload = {}) => ipcRenderer.invoke('ubuddy-organization-evolution:activate', payload),
  disableUBuddyOrganizationEvolution: (payload = {}) => ipcRenderer.invoke('ubuddy-organization-evolution:disable', payload),
  decidePersonalEvolution: (payload) => ipcRenderer.invoke('personal-evolution:decide', payload),
  rollbackPersonalSkill: (payload) => ipcRenderer.invoke('personal-evolution:rollback-skill', payload),
  rollbackPersonalMemory: (payload) => ipcRenderer.invoke('personal-evolution:rollback-memory', payload),
  latestRelease: (payload) => ipcRenderer.invoke('release:latest', payload),
  codexDoctor: () => ipcRenderer.invoke('codex:doctor'),
  codexConfig: () => ipcRenderer.invoke('codex:config'),
  codexConfigFiles: () => ipcRenderer.invoke('codex:config-files'),
  requestProviderKeyApplication: (payload = {}) => ipcRenderer.invoke('codex:request-provider-key', payload),
  providerKeyApplications: () => ipcRenderer.invoke('codex:provider-key-applications'),
  decideProviderKeyApplication: (payload = {}) => ipcRenderer.invoke('codex:decide-provider-key', payload),
  claimProviderKeyApplication: (payload = {}) => ipcRenderer.invoke('codex:claim-provider-key', payload),
  saveCodexConfig: (payload) => ipcRenderer.invoke('codex:save-config', payload),
  listModels: () => ipcRenderer.invoke('models:list'),
  refreshModels: () => ipcRenderer.invoke('models:refresh'),
  saveCodexConfigFiles: (payload) => ipcRenderer.invoke('codex:save-config-files', payload),
  uploadFile: (payload) => ipcRenderer.invoke('files:upload', payload),
  readFileBase64: (payload = {}) => ipcRenderer.invoke('files:read-base64', payload),
  uploadFilePath: (payload) => ipcRenderer.invoke('files:upload-path', payload),
  selectFiles: (payload = {}) => ipcRenderer.invoke('files:select', payload),
  pathForFile: (file) => webUtils.getPathForFile(file),
  renderFile: (payload) => ipcRenderer.invoke('files:render', payload),
  openPath: (filePath) => ipcRenderer.invoke('files:open-path', filePath),
  openFile: (payload) => ipcRenderer.invoke('files:open-file', payload),
  showFileInFolder: (payload) => ipcRenderer.invoke('files:show-in-folder', payload),
  saveFileCopy: (payload) => ipcRenderer.invoke('files:save-copy', payload),
  saveTextFile: (payload) => ipcRenderer.invoke('files:save-text', payload),
  loggingStatus: () => ipcRenderer.invoke('logging:status'),
  openLogDirectory: () => ipcRenderer.invoke('logging:open-directory'),
  exportDiagnosticLog: () => ipcRenderer.invoke('logging:export'),
  clearApplicationLogs: () => ipcRenderer.invoke('logging:clear'),
  reportRendererEvent: (payload = {}) => ipcRenderer.invoke('logging:renderer-event', payload),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  writeClipboardImage: (payload = {}) => ipcRenderer.invoke('clipboard:write-image', payload),
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  selectWorkspace: () => ipcRenderer.invoke('workspace:select'),
  selectProjectWorkspace: () => ipcRenderer.invoke('workspace:select-project'),
  listOrg: () => ipcRenderer.invoke('org:list'),
  listProjects: (payload = {}) => ipcRenderer.invoke('projects:list', payload),
  browseProjectFiles: (payload = {}) => ipcRenderer.invoke('projects:browse-files', payload),
  createProject: (payload = {}) => ipcRenderer.invoke('projects:create', payload),
  updateProject: (payload = {}) => ipcRenderer.invoke('projects:update', payload),
  listSessions: (payload = {}) => ipcRenderer.invoke('sessions:list', payload),
  mobileGatewayStatus: () => ipcRenderer.invoke('mobile-gateway:status'),
  listAgentDeliveryRuns: (payload = {}) => ipcRenderer.invoke('agent-deliveries:list', payload),
  cancelAgentDelivery: (payload = {}) => ipcRenderer.invoke('agent-deliveries:cancel', payload),
  searchSessions: (payload) => ipcRenderer.invoke('sessions:search', payload),
  updateSession: (payload) => ipcRenderer.invoke('sessions:update', payload),
  updateGoal: (payload) => ipcRenderer.invoke('goals:update', payload),
  listMessages: (sessionId) => ipcRenderer.invoke('messages:list', sessionId),
  listMessagePage: (payload = {}) => ipcRenderer.invoke('messages:list-page', payload),
  rewriteLastUserTurn: (payload = {}) => ipcRenderer.invoke('messages:rewrite-last-turn', payload),
  chatContextStatus: (payload = {}) => ipcRenderer.invoke('chat:context-status', payload),
  clearChatContext: (payload = {}) => ipcRenderer.invoke('chat:clear-context', payload),
  resetChatContext: (payload = {}) => ipcRenderer.invoke('chat:reset-context', payload),
  openPlanQuestionWindow: (payload = {}) => ipcRenderer.invoke('plan-question-window:open', payload),
  focusMainWindow: () => ipcRenderer.invoke('aux-window:focus-main'),
  sendChat: (payload) => ipcRenderer.invoke('chat:send', payload),
  cancelChat: (payload) => ipcRenderer.invoke('chat:cancel', payload),
  resolveChatApproval: (payload) => ipcRenderer.invoke('chat:resolve-approval', payload),
  resolveChatUserInput: (payload) => ipcRenderer.invoke('chat:resolve-user-input', payload),
  listTasks: (payload = {}) => ipcRenderer.invoke('tasks:list', payload),
  uBuddyTaskCenter: (payload = {}) => ipcRenderer.invoke('ubuddy:task-center', payload),
  uBuddyDeliveryCenter: (payload = {}) => ipcRenderer.invoke('ubuddy:delivery-center', payload),
  getTask: (taskRunId) => ipcRenderer.invoke('tasks:get', taskRunId),
  createTask: (payload) => ipcRenderer.invoke('tasks:create', payload),
  runReadyTasks: (payload) => ipcRenderer.invoke('tasks:run-ready', payload),
  retryTaskNode: (payload) => ipcRenderer.invoke('tasks:retry-node', payload),
  cancelTask: (payload) => ipcRenderer.invoke('tasks:cancel', payload),
  rerunTask: (payload) => ipcRenderer.invoke('tasks:rerun', payload),
  deleteTasks: (payload) => ipcRenderer.invoke('tasks:delete', payload),
  addTaskNode: (payload) => ipcRenderer.invoke('tasks:add-node', payload),
  resolveCommunication: (payload) => ipcRenderer.invoke('tasks:resolve-communication', payload),
  applyTaskTimeouts: (payload) => ipcRenderer.invoke('tasks:apply-timeouts', payload),
  agentStatuses: () => ipcRenderer.invoke('agents:statuses'),
  auditMemory: (payload) => ipcRenderer.invoke('memory:audit', payload),
  applyMemoryPolicy: (payload) => ipcRenderer.invoke('memory:apply-policy', payload),
  evolutionOverview: () => ipcRenderer.invoke('evolution:overview'),
  runEvolution: (payload) => ipcRenderer.invoke('evolution:run', payload),
  labelArchive: (payload) => ipcRenderer.invoke('evolution:archive-label', payload),
  rollbackSkill: (payload) => ipcRenderer.invoke('evolution:rollback-skill', payload),
  calibrateGate: (payload) => ipcRenderer.invoke('evolution:calibrate-gate', payload),
  startSpecialistExperiment: (payload) => ipcRenderer.invoke('evolution:specialist-start', payload),
  evaluateSpecialistExperiment: (payload) => ipcRenderer.invoke('evolution:specialist-evaluate', payload),
  finalizeSpecialistExperiment: (payload) => ipcRenderer.invoke('evolution:specialist-finalize', payload),
  transitionAgentCareer: (payload) => ipcRenderer.invoke('evolution:career-transition', payload),
  addEvolutionHoldout: (payload) => ipcRenderer.invoke('evolution:holdout-add', payload),
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  pluginStatus: (pluginId) => ipcRenderer.invoke('plugins:status', { pluginId }),
  installPlugin: (pluginId) => ipcRenderer.invoke('plugins:install', { pluginId }),
  uninstallPlugin: (pluginId) => ipcRenderer.invoke('plugins:uninstall', { pluginId }),
  openPluginFiles: (pluginId) => ipcRenderer.invoke('plugins:open-files', { pluginId }),
  listCodexPlugins: () => ipcRenderer.invoke('codex-plugins:list'),
  installCodexPlugin: (pluginId) => ipcRenderer.invoke('codex-plugins:install', { pluginId }),
  removeCodexPlugin: (pluginId) => ipcRenderer.invoke('codex-plugins:remove', { pluginId }),
  addCodexPluginMarketplace: (payload = {}) => ipcRenderer.invoke('codex-plugin-marketplaces:add', payload),
  pickCodexPluginMarketplaceSource: () => ipcRenderer.invoke('codex-plugin-marketplaces:pick-source'),
  upgradeCodexPluginMarketplace: (marketplace) => ipcRenderer.invoke('codex-plugin-marketplaces:upgrade', { marketplace }),
  removeCodexPluginMarketplace: (marketplace) => ipcRenderer.invoke('codex-plugin-marketplaces:remove', { marketplace }),
  onCodexPluginsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('codex-plugins:changed', listener);
    return () => ipcRenderer.removeListener('codex-plugins:changed', listener);
  },
  onAttachedSkillsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('skills:attached-changed', listener);
    return () => ipcRenderer.removeListener('skills:attached-changed', listener);
  },
  listAttachedSkills: () => ipcRenderer.invoke('skills:attached-list'),
  pickAttachedSkillSource: () => ipcRenderer.invoke('skills:attached-pick-source'),
  importAttachedSkillPackage: (payload = {}) => ipcRenderer.invoke('skills:attached-import', payload),
  assignAttachedSkill: (payload = {}) => ipcRenderer.invoke('skills:attached-assign', payload),
  assignAttachedSkillsBatch: (payload = {}) => ipcRenderer.invoke('skills:attached-assign-batch', payload),
  unassignAttachedSkill: (payload = {}) => ipcRenderer.invoke('skills:attached-unassign', payload),
  effectiveAttachedSkills: (payload = {}) => ipcRenderer.invoke('skills:attached-effective', payload),
  disableAttachedSkillPackage: (payload = {}) => ipcRenderer.invoke('skills:attached-disable', payload),
  onPluginProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('plugins:progress', listener);
    return () => ipcRenderer.removeListener('plugins:progress', listener);
  },
  pptxPluginStatus: () => ipcRenderer.invoke('plugins:pptx-status'),
  uninstallPptxPlugin: () => ipcRenderer.invoke('plugins:uninstall-pptx'),
  downloadPptxPlugin: () => ipcRenderer.invoke('plugins:download-pptx'),
  openPptxSkillFile: () => ipcRenderer.invoke('plugins:open-pptx-skill'),
  onPptxPluginProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('plugins:pptx-progress', listener);
    return () => ipcRenderer.removeListener('plugins:pptx-progress', listener);
  },
  updateStatus: () => ipcRenderer.invoke('updates:status'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  agentUpdateStatus: () => ipcRenderer.invoke('agent-updates:status'),
  checkAgentUpdates: () => ipcRenderer.invoke('agent-updates:check'),
  downloadAgentUpdate: () => ipcRenderer.invoke('agent-updates:download'),
  applyAgentUpdate: () => ipcRenderer.invoke('agent-updates:apply'),
  rollbackAgentUpdate: () => ipcRenderer.invoke('agent-updates:rollback'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  respondClosePrompt: (payload = {}) => ipcRenderer.invoke('desktop-close-prompt:respond', payload),
  desktopLifecycleStatus: () => ipcRenderer.invoke('desktop-lifecycle:status'),
  setDesktopCloseBehavior: (closeBehavior) => ipcRenderer.invoke('desktop-lifecycle:set-close-behavior', { closeBehavior }),
  onDesktopLifecycleChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('desktop-lifecycle:changed', listener);
    return () => ipcRenderer.removeListener('desktop-lifecycle:changed', listener);
  },
  appMenuCommand: (command) => ipcRenderer.invoke('app-menu:command', command),
  onUpdateStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updates:status', listener);
    return () => ipcRenderer.removeListener('updates:status', listener);
  },
  onAgentUpdateStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent-updates:status', listener);
    return () => ipcRenderer.removeListener('agent-updates:status', listener);
  },
  onEvolutionProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('evolution:progress', listener);
    return () => ipcRenderer.removeListener('evolution:progress', listener);
  },
  onModelsUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('models:updated', listener);
    return () => ipcRenderer.removeListener('models:updated', listener);
  },
  onCodexEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('codex:event', listener);
    return () => ipcRenderer.removeListener('codex:event', listener);
  },
  onChatSessionUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat-session:updated', listener);
    return () => ipcRenderer.removeListener('chat-session:updated', listener);
  },
  onChatUserInputWindowClosed: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat:user-input-window-closed', listener);
    return () => ipcRenderer.removeListener('chat:user-input-window-closed', listener);
  },
  onSocialUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('social:updated', listener);
    return () => ipcRenderer.removeListener('social:updated', listener);
  },
  onEmployeesUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('employees:updated', listener);
    return () => ipcRenderer.removeListener('employees:updated', listener);
  },
  onAgentDeliveryUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent-delivery:updated', listener);
    return () => ipcRenderer.removeListener('agent-delivery:updated', listener);
  },
  onTaskUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('task:updated', listener);
    return () => ipcRenderer.removeListener('task:updated', listener);
  },
  onAgentAvailabilityChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent-availability:changed', listener);
    return () => ipcRenderer.removeListener('agent-availability:changed', listener);
  },
  onSocialOpenTask,
  onSystemOpenConversation,
  onSystemOpenAgentSession,
  onSystemOpenUpdates,
  onSystemOpenFollower,
  onDesktopNotification,
});

async function invokeEmployeeMutation(channel, payload = {}) {
  const response = await ipcRenderer.invoke(channel, payload);
  if (response?.ok) return response.result;
  const error = new Error(response?.error?.message || 'Employee command failed.');
  error.code = response?.error?.code || 'employee_command_failed';
  error.details = response?.error?.details || {};
  throw error;
}
