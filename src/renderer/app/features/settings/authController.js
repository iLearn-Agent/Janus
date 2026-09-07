import { iconSvg } from '../../ui/icons.js';
import { PASSWORD_REQUIREMENTS_MESSAGE, passwordValidationMessage } from '../../../../shared/passwordPolicy.js';

export function authEmailValidationMessage(value = '') {
  const email = String(value || '').trim();
  if (!email) return '请输入邮箱。';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '邮箱格式不正确，请检查后重试。';
  return '';
}

export function registrationValidationMessage({ email = '', code = '', password = '', passwordConfirm = '' } = {}) {
  const emailError = authEmailValidationMessage(email);
  if (emailError) return emailError;
  const cleanCode = String(code || '').trim();
  if (!cleanCode) return '请输入邮箱验证码。';
  if (!/^\d{6}$/.test(cleanCode)) return '邮箱验证码应为 6 位数字。';
  if (!password) return '请输入初始密码。';
  const passwordError = passwordValidationMessage(password);
  if (passwordError) return passwordError;
  if (!passwordConfirm) return '请再次输入密码。';
  if (password !== passwordConfirm) return '两次输入的密码不一致。';
  return '';
}

export function createAuthController({
  api,
  documentRef,
  state,
  render,
  notify,
  hydrateComposerDrafts,
  isCurrentUserAdmin,
  refreshReleaseStatus,
  refreshSocialThreads = async () => {},
  loadRememberedLoginIdentifier,
  saveRememberedLoginIdentifier,
  userVisibleErrorMessage,
  localizeRoot = () => {},
  translateText = (value) => String(value || ''),
  resetWorkspaceScopedState = () => {},
  windowRef = window,
}) {
  const emailCodeRequests = new Set();
  let emailCodeCooldownTimer = null;

  function emailCodeTarget(purpose = '') {
    if (purpose === 'password_reset') return String(documentRef.getElementById('reset-email')?.value || state.authDraft.resetEmail || '').trim().toLowerCase();
    if (purpose === 'register') return String(documentRef.getElementById('register-email')?.value || state.authDraft.registerEmail || '').trim().toLowerCase();
    if (purpose === 'password_change') return String(state.currentUser?.email || '').trim().toLowerCase();
    return String(documentRef.getElementById('login-email')?.value || state.authDraft.loginEmail || '').trim().toLowerCase();
  }

  function emailCodeCooldownSeconds(purpose = '', target = emailCodeTarget(purpose)) {
    const cooldown = state.emailCodeCooldowns?.[purpose];
    if (!cooldown || cooldown.target !== target) return 0;
    return Math.max(0, Math.ceil((Number(cooldown.until || 0) - Date.now()) / 1000));
  }

  function refreshEmailCodeButtonState() {
    const buttons = {
      register: documentRef.getElementById('send-register-code-btn'),
      password_reset: documentRef.getElementById('send-reset-code-btn'),
      password_change: documentRef.getElementById('send-password-change-code-btn'),
      login: documentRef.getElementById('send-login-code-btn'),
    };
    Object.entries(buttons).forEach(([purpose, button]) => {
      if (!button) return;
      const target = emailCodeTarget(purpose);
      const sending = state.emailCodeSending?.purpose === purpose && state.emailCodeSending?.target === target;
      const remainingSeconds = emailCodeCooldownSeconds(purpose, target);
      button.disabled = Boolean(sending || remainingSeconds > 0);
      button.textContent = translateText(sending ? '发送中…' : remainingSeconds > 0 ? `${remainingSeconds} 秒后重发` : '获取验证码');
    });
  }

  function ensureEmailCodeCooldownTimer() {
    if (emailCodeCooldownTimer) return;
    emailCodeCooldownTimer = windowRef.setInterval(() => {
      const nextCooldowns = { ...(state.emailCodeCooldowns || {}) };
      let active = false;
      Object.entries(nextCooldowns).forEach(([purpose, cooldown]) => {
        if (Number(cooldown?.until || 0) > Date.now()) active = true;
        else delete nextCooldowns[purpose];
      });
      state.emailCodeCooldowns = nextCooldowns;
      refreshEmailCodeButtonState();
      if (!active) {
        windowRef.clearInterval(emailCodeCooldownTimer);
        emailCodeCooldownTimer = null;
      }
    }, 1000);
  }

  async function refreshSocialAfterAuthentication({ userId = '', workspaceId = '', workspaceGeneration = 0 } = {}) {
    try {
      const social = await api.pollSocialNetwork?.({ autoProcess: false });
      if (!social || social.skipped) return social || { skipped: true, reason: 'poll_unavailable' };
      if (String(state.currentUser?.id || '') !== String(userId || '')
        || String(state.activeAccountWorkspace?.id || 'workspace_personal') !== String(workspaceId || 'workspace_personal')
        || Number(state.workspaceSwitchGeneration || 0) !== Number(workspaceGeneration || 0)) {
        return { skipped: true, reason: 'authentication_context_changed' };
      }
      state.socialStatus = social.status || state.socialStatus;
      state.friendOverview = social.friends || state.friendOverview;
      state.socialInbox = social.inbox || state.socialInbox;
      state.agentDelegations = social.delegations || state.agentDelegations;
      state.collaborationOverview = social.collaboration || state.collaborationOverview;
      state.chatGroupsOverview = social.chatGroups || state.chatGroupsOverview;
      if (state.collaborationOverview?.tasks?.length) state.agentDelegations = state.collaborationOverview.tasks;
      await refreshSocialThreads(false);
      render();
      return social;
    } catch {
      // Login remains successful and cached social data stays visible when the first pull is temporarily unavailable.
      return { skipped: true, reason: 'initial_social_pull_failed' };
    }
  }

  async function refreshBootstrapAfterAuth() {
    const boot = await api.bootstrap();
    state.workspaceSwitchGeneration = Number(state.workspaceSwitchGeneration || 0) + 1;
    state.workspaceSwitchBusy = false;
    resetWorkspaceScopedState();
    state.appVersion = boot.appVersion || state.appVersion;
    state.appPackaged = boot.appPackaged === true;
    state.updatedLaunch = boot.updatedLaunch === true;
    state.root = boot.root || state.root;
    state.workspaceRoot = boot.workspaceRoot || boot.workspace_root || '';
    state.workspaceDetached = false;
    state.workspaceMenuOpen = false;
    state.org = boot.org || { departments: [], agents: [], hrs: [], leaders: [] };
    state.sessions = boot.sessions || [];
    state.preloadedMessagePagesBySessionId = boot.messagePreload?.sessionPages || {};
    state.projects = boot.projects || [];
    state.tasks = boot.tasks || [];
    state.agentStatuses = boot.agentStatuses || [];
    state.evolution = boot.evolution || null;
    state.uBuddyOrganizationEvolution = boot.uBuddyOrganizationEvolution || null;
    state.currentUser = boot.currentUser || null;
    state.uBuddyMessageMode = 'task';
    state.accountWorkspaces = boot.accountWorkspaces || [];
    state.activeAccountWorkspace = boot.activeAccountWorkspace || null;
    state.startupAccountWorkspace = boot.startupAccountWorkspace || null;
    hydrateComposerDrafts();
    state.adminUsers = boot.adminUsers || [];
    state.friendOverview = boot.friendOverview || { friends: [], requests: { incoming: [], outgoing: [] } };
    state.socialInbox = boot.socialInbox || [];
    state.socialThreads = boot.messagePreload?.socialThreads || [];
    state.agentDelegations = boot.agentDelegations || [];
    state.collaborationOverview = boot.collaboration || { groups: [], tasks: state.agentDelegations };
    state.networkDelegationRunsById = {};
    state.networkDelegationProgressById = {};
    state.networkDelegationTaskById = {};
    state.agentWorkStatusByInstanceId = {};
    state.uBuddyCoordinationByTaskId = {};
    state.collaborationGroupProgressOpenById = {};
    state.taskProgressOpenById = {};
    state.uBuddyTaskViewsById = {};
    state.uBuddyTaskViewLoadingById = {};
    state.uBuddyTaskViewErrorById = {};
    state.uBuddyTaskStripOpenBySessionId = {};
    state.uBuddyTaskStripFilterBySessionId = {};
    state.uBuddyTaskDrawerOpenBySessionId = {};
    state.uBuddyTaskUnseenBySessionId = {};
    state.messageViewStateByKey = {};
    if (state.collaborationOverview.tasks?.length) state.agentDelegations = state.collaborationOverview.tasks;
    state.socialStatus = boot.socialStatus || null;
    state.codexConfig = boot.codexConfig || {};
    state.codexConfigFiles = boot.codexConfigFiles || null;
    state.providerKeyAccess = boot.providerKeyAccess || null;
    state.managedProviderUsage = boot.managedProviderUsage ?? null;
    state.cloudSync = boot.cloudSync || null;
    state.userAgentSettings = boot.userAgentSettings || [];
    state.evolutionPreference = null;
    state.evolutionPreferenceLoading = false;
    state.evolutionPreferenceError = '';
    state.evolutionUpdates = null;
    state.evolutionUpdatesLoading = false;
    state.evolutionUpdatesError = '';
    state.personalEvolutionVersionsByAgent = {};
    state.personalEvolutionVersionLoadingId = '';
    state.personalEvolutionExpandedAgentIds = [];
    state.evolutionActionBusyKey = '';
    state.personalEvolutionStatus = boot.personalEvolutionStatus || null;
    state.stage8EvolutionStatus = boot.stage8EvolutionStatus || null;
    state.clusterEvolutionOverview = boot.clusterEvolutionOverview || { cohorts: [], runs: [], candidates: [] };
    state.evolutionGrants = [];
    state.personalEvolutionProposals = boot.personalEvolutionProposals || [];
    state.personalEvolutionProposalDetail = null;
    state.employeeOverview = boot.employees || null;
    state.employeeContextMenu = null;
    state.employeeMarketDrawer = null;
    state.secretarySessionId = state.sessions.find((session) => (
      session.departmentId === 'secretary_department'
      && session.status !== 'deleted'
      && session.writeState !== 'read_only'
    ))?.id || '';
    state.privateAssistant = boot.privateAssistant || null;
    state.privateAssistantResultUnread = false;
    state.pluginCatalog = Array.isArray(boot.plugins) ? boot.plugins : [];
    state.codexPlugins = boot.codexPlugins || state.codexPlugins;
    state.pptxPluginStatus = boot.pptxPluginStatus ?? state.pptxPluginStatus;
    state.releaseDev = null;
    state.releaseStable = null;
    state.currentSessionId = '';
    state.contextUsage = null;
    state.contextCompressionOperations = {};
    state.privateAssistantContextResetBusy = false;
    state.messages = [];
    state.attachments = [];
    state.composerTaskReference = null;
    state.taskReferenceMenuOpen = false;
    state.taskReferenceOptions = [];
    state.taskReferenceOptionsLoading = false;
    state.taskReferenceOptionsError = '';
    if (!state.currentUser) state.currentTab = 'settings';
    if (state.currentUser && state.currentTab === 'settings') state.currentTab = 'chat';
    if (state.currentUser) {
      state.networkPanelOpen = true;
      state.networkPanelView = 'messages';
    }
    if (!isCurrentUserAdmin() && ['tasks', 'evolution'].includes(state.currentTab)) state.currentTab = 'settings';
    if (isCurrentUserAdmin()) await refreshReleaseStatus(false);
  }

  function syncAuthDraftFromDom() {
    state.authDraft = {
      ...state.authDraft,
      loginPhone: documentRef.getElementById('login-phone')?.value ?? state.authDraft.loginPhone,
      loginEmail: documentRef.getElementById('login-email')?.value ?? state.authDraft.loginEmail,
      loginCode: documentRef.getElementById('login-code')?.value ?? state.authDraft.loginCode,
      loginNewPassword: documentRef.getElementById('login-new-password')?.value ?? state.authDraft.loginNewPassword,
      loginIdentifier: documentRef.getElementById('login-identifier')?.value ?? state.authDraft.loginIdentifier,
      loginPassword: documentRef.getElementById('login-password')?.value ?? state.authDraft.loginPassword,
      resetPhone: documentRef.getElementById('reset-phone')?.value ?? state.authDraft.resetPhone,
      resetEmail: documentRef.getElementById('reset-email')?.value ?? state.authDraft.resetEmail,
      resetCode: documentRef.getElementById('reset-code')?.value ?? state.authDraft.resetCode,
      resetNewPassword: documentRef.getElementById('reset-new-password')?.value ?? state.authDraft.resetNewPassword,
      registerName: documentRef.getElementById('register-name')?.value ?? state.authDraft.registerName,
      registerEmail: documentRef.getElementById('register-email')?.value ?? state.authDraft.registerEmail,
      registerCode: documentRef.getElementById('register-code')?.value ?? state.authDraft.registerCode,
      registerPassword: documentRef.getElementById('register-password')?.value ?? state.authDraft.registerPassword,
      registerPasswordConfirm: documentRef.getElementById('register-password-confirm')?.value ?? state.authDraft.registerPasswordConfirm,
    };
  }

  function resetAuthUiState() {
    state.authDraft = {
      loginPhone: '',
      loginEmail: '',
      loginCode: '',
      loginNewPassword: '',
      loginIdentifier: loadRememberedLoginIdentifier(),
      loginPassword: '',
      resetPhone: '',
      resetEmail: '',
      resetCode: '',
      resetNewPassword: '',
      registerName: '',
      registerEmail: '',
      registerCode: '',
      registerPassword: '',
      registerPasswordConfirm: '',
    };
    state.authFeedback = null;
    state.emailCodeNotice = null;
    state.emailCodeSending = null;
    state.organizationSecondaryVerificationById = {};
    state.authScreen = 'login';
    state.authMode = 'password';
    state.authResetMode = 'email';
    state.accountMenuOpen = false;
    state.accountMenuWorkspaceOpen = false;
    state.accountWorkspaceMenuOpen = false;
  }

  function userErrorMessage(error) {
    return userVisibleErrorMessage(error);
  }

  function authFailureFeedback(error, action = 'login') {
    const code = String(error?.code || error?.body?.error?.code || error?.body?.code || '').trim();
    const message = userErrorMessage(error);
    const rawMessage = String(error?.message || error || '');
    const feedback = (title, hint, resolvedMessage = message) => ({
      tone: 'error',
      title,
      message: resolvedMessage,
      hint,
    });

    if (code === 'email_already_registered' || /邮箱.*已.*注册|email.*already.*registered/i.test(message)) {
      return feedback('该邮箱已注册', '可直接返回登录，或使用其他邮箱。', '该邮箱已被注册，请直接登录或使用其他邮箱。');
    }
    if (code === 'email_code_expired' || /验证码.*过期|verification code.*expired/i.test(message)) {
      return feedback('验证码已过期', '请重新获取验证码后再试。', '邮箱验证码已过期，请重新获取。');
    }
    if (code === 'email_code_invalid' || /验证码.*不正确|验证码.*错误|incorrect verification code|invalid verification code/i.test(message)) {
      return feedback('验证码不正确', '请使用最近一封邮件中的 6 位验证码。', '邮箱验证码不正确。');
    }
    if (code === 'email_code_required' || /请输入.*验证码|验证码应为 6 位|verification code.*(?:required|6 digits)/i.test(message)) {
      return feedback('请检查验证码', '请输入邮件中的 6 位数字验证码。', '请输入邮箱验证码。');
    }
    if (/请输入邮箱或用户 ID|请输入账号|account.*required|identifier.*required/i.test(message)) {
      return feedback('请输入账号', '可以使用注册邮箱或用户 ID 登录。', '请输入邮箱或用户 ID。');
    }
    if (code === 'invalid_email' || /邮箱格式不正确|请输入邮箱|invalid email/i.test(message)) {
      return feedback('请检查邮箱', '请输入完整、有效的邮箱地址。', '邮箱格式不正确，请检查后重试。');
    }
    if (code === 'email_not_found' || /邮箱.*尚未注册|no account.*email/i.test(message)) {
      return feedback('未找到该账号', '请检查邮箱，或先创建一个新账号。', '该邮箱尚未注册。');
    }
    if (code === 'email_address_unreachable' || /邮箱不存在|无法接收邮件|mailbox.*(?:unreachable|not found)/i.test(message)) {
      return feedback('邮箱无法接收验证码', '请检查地址是否拼写正确，或更换可正常收件的邮箱。', '该邮箱不存在或无法接收邮件，请检查邮箱地址后重试。');
    }
    if (code === 'email_delivery_failed' || /邮件发送失败|verification email.*could not be sent/i.test(message)) {
      return feedback('验证码发送失败', '请稍后重试；若仍失败，请确认邮箱可以正常收件。', '验证码邮件发送失败，请稍后重试；如果持续失败，请确认邮箱能够正常收件。');
    }
    if (code === 'invalid_password' || /密码(?:至少需要 8 位|必须同时包含字母和数字)|请输入.*密码|password.*(?:at least|required|letter|number)/i.test(message)) {
      const passwordMessage = /请输入.*密码|password.*required/i.test(message)
        ? '请输入密码。'
        : (/必须同时包含字母和数字|letter.*number|number.*letter/i.test(message) ? '密码必须同时包含字母和数字。' : '密码至少需要 8 位。');
      return feedback('请检查密码', PASSWORD_REQUIREMENTS_MESSAGE, passwordMessage);
    }
    if (/两次输入的密码不一致|passwords do not match/i.test(message)) {
      return feedback('两次密码不一致', '请重新输入确认密码，确保与上方密码完全相同。', '两次输入的密码不一致。');
    }
    if (/账号或密码不正确|邮箱尚未验证|invalid credentials|incorrect (?:account|password)|email.*not verified/i.test(message)) {
      const emailNotVerified = /邮箱尚未验证|email.*not verified/i.test(message);
      return feedback(
        emailNotVerified ? '邮箱尚未验证' : '账号或密码有误',
        emailNotVerified
          ? '请先完成邮箱验证，再重新登录。'
          : '请检查邮箱或用户 ID，以及密码是否输入正确。',
        emailNotVerified ? '邮箱尚未验证，请先完成邮箱验证。' : '账号或密码不正确。',
      );
    }
    if (/Failed to fetch|ECONNREFUSED|ENOTFOUND|network (?:error|request failed)|fetch failed/i.test(rawMessage)
      && /Failed to fetch|ECONNREFUSED|ENOTFOUND|network (?:error|request failed)|fetch failed/i.test(message)) {
      return feedback('无法连接账号服务', '请检查网络连接，稍后重试。', '账号服务暂时无法访问。');
    }

    const defaults = {
      login: ['无法登录', '请检查输入内容后重试。'],
      register: ['无法完成注册', '请检查注册信息后重试。'],
      send_code: ['验证码发送失败', '请检查邮箱地址或稍后重试。'],
      reset: ['无法重置密码', '请检查邮箱、验证码和新密码后重试。'],
    };
    const [title, hint] = defaults[action] || defaults.login;
    if (action === 'login') {
      return feedback('账号或密码有误', '请检查邮箱或用户 ID，以及密码是否输入正确。', '账号或密码不正确。');
    }
    return feedback(title, hint, hint);
  }

  async function loginAccount(event) {
    event.preventDefault();
    syncAuthDraftFromDom();
    try {
      const identifier = documentRef.getElementById('login-identifier')?.value || '';
      const password = documentRef.getElementById('login-password')?.value || '';
      if (!String(identifier).trim()) throw new Error('请输入邮箱或用户 ID。');
      if (!password) throw new Error('请输入密码。');
      await api.login({
        method: 'password',
        identifier,
        password,
      });
      saveRememberedLoginIdentifier(identifier);
      await refreshBootstrapAfterAuth();
      resetAuthUiState();
      notify('已登录。', 'success');
      render();
      void refreshSocialAfterAuthentication({
        userId: state.currentUser?.id || '',
        workspaceId: state.activeAccountWorkspace?.id || 'workspace_personal',
        workspaceGeneration: state.workspaceSwitchGeneration,
      });
      return;
    } catch (error) {
      state.authFeedback = authFailureFeedback(error, 'login');
      render();
      return;
    }
    const mode = ['phone', 'email', 'password'].includes(state.authMode) ? state.authMode : 'phone';
    try {
      const payload = mode === 'phone'
        ? {
            method: 'phone_code',
            phone: documentRef.getElementById('login-phone')?.value || '',
            code: documentRef.getElementById('login-code')?.value || '',
            newPassword: documentRef.getElementById('login-new-password')?.value || '',
          }
        : mode === 'email'
          ? {
              method: 'email_code',
              email: documentRef.getElementById('login-email')?.value || '',
              code: documentRef.getElementById('login-code')?.value || '',
              newPassword: documentRef.getElementById('login-new-password')?.value || '',
            }
          : {
              method: 'password',
              identifier: documentRef.getElementById('login-identifier')?.value || '',
              password: documentRef.getElementById('login-password')?.value || '',
            };
      await api.login(payload);
      await refreshBootstrapAfterAuth();
      resetAuthUiState();
      notify('已登录。', 'success');
      render();
    } catch (error) {
      state.authFeedback = authFailureFeedback(error, 'login');
      render();
    }
  }

  async function registerAccount(event) {
    event.preventDefault();
    syncAuthDraftFromDom();
    try {
      const email = documentRef.getElementById('register-email')?.value || '';
      const code = documentRef.getElementById('register-code')?.value || '';
      const password = documentRef.getElementById('register-password')?.value || '';
      const passwordConfirm = documentRef.getElementById('register-password-confirm')?.value || '';
      const validationMessage = registrationValidationMessage({ email, code, password, passwordConfirm });
      if (validationMessage) throw new Error(validationMessage);
      await api.register({
        displayName: documentRef.getElementById('register-name')?.value || '',
        email,
        code,
        password,
      });
      saveRememberedLoginIdentifier(email);
      await refreshBootstrapAfterAuth();
      resetAuthUiState();
      notify('账号已创建并登录。', 'success');
      render();
    } catch (error) {
      state.authFeedback = authFailureFeedback(error, 'register');
      render();
    }
  }

  async function sendEmailCodeFromInput(purpose) {
    syncAuthDraftFromDom();
    const target = emailCodeTarget(purpose);
    const validationMessage = authEmailValidationMessage(target);
    if (validationMessage) {
      state.emailCodeNotice = null;
      state.authFeedback = authFailureFeedback(new Error(validationMessage), 'send_code');
      render();
      return;
    }
    const requestKey = `${purpose}:${target}`;
    if (emailCodeRequests.has(requestKey)) return;
    const remainingSeconds = emailCodeCooldownSeconds(purpose, target);
    if (remainingSeconds > 0) {
      refreshEmailCodeButtonState();
      return;
    }
    emailCodeRequests.add(requestKey);
    state.emailCodeSending = { purpose, target };
    state.emailCodeNotice = null;
    state.authFeedback = null;
    render();
    try {
      const payload = {
        method: 'email',
        email: target,
        purpose,
      };
      const result = await api.sendEmailCode(payload);
      const retryAfterSeconds = Math.max(1, Number(result?.retryAfterSeconds || 60));
      state.emailCodeCooldowns = {
        ...(state.emailCodeCooldowns || {}),
        [purpose]: { target, until: Date.now() + retryAfterSeconds * 1000 },
      };
      state.emailCodeNotice = { ...(result || {}), purpose, target };
      state.authFeedback = null;
      ensureEmailCodeCooldownTimer();
    } catch (error) {
      state.emailCodeNotice = null;
      state.authFeedback = authFailureFeedback(error, 'send_code');
    } finally {
      emailCodeRequests.delete(requestKey);
      if (state.emailCodeSending?.purpose === purpose && state.emailCodeSending?.target === target) {
        state.emailCodeSending = null;
      }
      render();
    }
  }


  async function resetPasswordByEmail(event) {
    event.preventDefault();
    syncAuthDraftFromDom();
    const method = 'email';
    try {
      await api.resetPasswordByEmail(method === 'phone'
        ? {
            method: 'phone',
            phone: documentRef.getElementById('reset-phone')?.value || '',
            code: documentRef.getElementById('reset-code')?.value || '',
            newPassword: documentRef.getElementById('reset-new-password')?.value || '',
          }
        : {
            method: 'email',
            email: documentRef.getElementById('reset-email')?.value || '',
            code: documentRef.getElementById('reset-code')?.value || '',
            newPassword: documentRef.getElementById('reset-new-password')?.value || '',
      });
      state.emailCodeNotice = null;
      state.authScreen = 'login';
      state.authFeedback = {
        tone: 'success',
        title: '密码已重置',
        message: '现在可以使用新密码登录。',
        hint: '为了账号安全，请勿与他人共享密码。',
      };
      render();
    } catch (error) {
      state.authFeedback = authFailureFeedback(error, 'reset');
      render();
    }
  }

  async function logoutAccount() {
    try {
      await api.logout();
      await refreshBootstrapAfterAuth();
      resetAuthUiState();
      notify('已退出登录。', 'success');
      render();
    } catch (error) {
      notify(`退出失败：${error.message || error}`, 'error');
    }
  }


  function setProfileAvatarDraft(avatarUrl = '') {
    const nextAvatarUrl = String(avatarUrl || '').trim();
    const hidden = documentRef.getElementById('profile-avatar-url');
    if (hidden) hidden.value = nextAvatarUrl;
    const displayName = documentRef.getElementById('profile-display-name')?.value || state.currentUser?.displayName || state.currentUser?.display_name || '';
    const username = documentRef.getElementById('profile-username')?.value || state.currentUser?.username || '';
    if (state.currentUser) {
      state.currentUser = {
        ...state.currentUser,
        displayName,
        display_name: displayName,
        username,
        avatarUrl: nextAvatarUrl,
        avatar_url: nextAvatarUrl,
      };
    }
    render();
  }

  function resizeAvatarFile(file) {
    return new Promise((resolve, reject) => {
      if (!file?.type?.startsWith('image/')) {
        reject(new Error('请选择图片文件。'));
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        reject(new Error('头像图片不能超过 8 MB。'));
        return;
      }
      const reader = new windowRef.FileReader();
      reader.onerror = () => reject(new Error('读取头像图片失败。'));
      reader.onload = () => {
        openAvatarCropper(String(reader.result || '')).then(resolve, reject);
      };
      reader.readAsDataURL(file);
    });
  }

  function openAvatarCropper(dataUrl = '') {
    return new Promise((resolve, reject) => {
      const image = new windowRef.Image();
      image.onerror = () => reject(new Error('无法解析这张图片。'));
      image.onload = () => {
        const overlay = documentRef.createElement('div');
        overlay.className = 'avatar-cropper-overlay';
        overlay.innerHTML = `
          <section class="avatar-cropper-modal" role="dialog" aria-modal="true" aria-label="裁剪头像">
            <header><strong>裁剪头像</strong><button type="button" data-avatar-crop-cancel aria-label="关闭">×</button></header>
            <div class="avatar-cropper-layout">
              <div class="avatar-cropper-stage" data-avatar-crop-stage>
                <img src="${dataUrl}" alt="" draggable="false" data-avatar-crop-image />
                <span class="avatar-cropper-grid" aria-hidden="true"></span>
              </div>
              <aside class="avatar-cropper-live" aria-label="头像预览">
                <span class="avatar-cropper-live-preview" data-avatar-crop-live><img src="${dataUrl}" alt="" draggable="false" data-avatar-crop-live-image /></span>
                <small>预览</small>
              </aside>
            </div>
            <label class="avatar-cropper-zoom"><span>缩放</span><input type="range" min="0.5" max="3" step="0.01" value="1" data-avatar-crop-zoom /></label>
            <footer><button class="btn secondary" type="button" data-avatar-crop-cancel>取消</button><button class="btn primary" type="button" data-avatar-crop-confirm>使用头像</button></footer>
          </section>
        `;
        documentRef.body.appendChild(overlay);
        localizeRoot(overlay);
        const stage = overlay.querySelector('[data-avatar-crop-stage]');
        const preview = overlay.querySelector('[data-avatar-crop-image]');
        const zoomInput = overlay.querySelector('[data-avatar-crop-zoom]');
        const livePreview = overlay.querySelector('[data-avatar-crop-live]');
        const liveImage = overlay.querySelector('[data-avatar-crop-live-image]');
        const naturalWidth = image.naturalWidth || image.width || 1;
        const naturalHeight = image.naturalHeight || image.height || 1;
        const cropSize = Math.round(stage.getBoundingClientRect().width || 320);
        const outputSize = 192;
        const baseScale = Math.max(cropSize / naturalWidth, cropSize / naturalHeight);
        const minZoom = 0.5;
        const maxZoom = 3;
        let zoom = 1;
        let offsetX = 0;
        let offsetY = 0;
        let dragging = false;
        let startX = 0;
        let startY = 0;
        let dragStartX = 0;
        let dragStartY = 0;

        const clampOffsets = () => {
          const scale = baseScale * zoom;
          const displayWidth = naturalWidth * scale;
          const displayHeight = naturalHeight * scale;
          const maxX = Math.max(0, (displayWidth - cropSize) / 2);
          const maxY = Math.max(0, (displayHeight - cropSize) / 2);
          offsetX = Math.max(-maxX, Math.min(maxX, offsetX));
          offsetY = Math.max(-maxY, Math.min(maxY, offsetY));
        };
        const updatePreview = () => {
          clampOffsets();
          const scale = baseScale * zoom;
          const displayWidth = naturalWidth * scale;
          const displayHeight = naturalHeight * scale;
          preview.style.width = `${displayWidth}px`;
          preview.style.height = `${displayHeight}px`;
          const left = cropSize / 2 + offsetX - displayWidth / 2;
          const top = cropSize / 2 + offsetY - displayHeight / 2;
          preview.style.left = `${left}px`;
          preview.style.top = `${top}px`;
          if (livePreview && liveImage) {
            const liveSize = livePreview.getBoundingClientRect().width || 96;
            const liveScale = liveSize / cropSize;
            liveImage.style.width = `${displayWidth * liveScale}px`;
            liveImage.style.height = `${displayHeight * liveScale}px`;
            liveImage.style.left = `${left * liveScale}px`;
            liveImage.style.top = `${top * liveScale}px`;
          }
        };
        const cleanup = () => {
          windowRef.removeEventListener('mousemove', onMove);
          windowRef.removeEventListener('touchmove', onMove);
          windowRef.removeEventListener('mouseup', stopDrag);
          windowRef.removeEventListener('touchend', stopDrag);
          overlay.remove();
        };
        const cancel = () => { cleanup(); reject(new Error('Avatar crop cancelled.')); };
        const pointFromEvent = (event) => event.touches?.[0] || event;
        const onMove = (event) => {
          if (!dragging) return;
          event.preventDefault();
          const point = pointFromEvent(event);
          offsetX = dragStartX + point.clientX - startX;
          offsetY = dragStartY + point.clientY - startY;
          updatePreview();
        };
        const stopDrag = () => { dragging = false; };
        const startDrag = (event) => {
          event.preventDefault();
          const point = pointFromEvent(event);
          dragging = true;
          startX = point.clientX;
          startY = point.clientY;
          dragStartX = offsetX;
          dragStartY = offsetY;
        };
        const confirm = () => {
          const scale = baseScale * zoom;
          const displayWidth = naturalWidth * scale;
          const displayHeight = naturalHeight * scale;
          const left = cropSize / 2 + offsetX - displayWidth / 2;
          const top = cropSize / 2 + offsetY - displayHeight / 2;
          const canvas = documentRef.createElement('canvas');
          canvas.width = outputSize;
          canvas.height = outputSize;
          const context = canvas.getContext('2d');
          context.fillStyle = '#e7eefc';
          context.fillRect(0, 0, outputSize, outputSize);
          const outputScale = outputSize / cropSize;
          context.drawImage(image, left * outputScale, top * outputScale, displayWidth * outputScale, displayHeight * outputScale);
          cleanup();
          resolve(canvas.toDataURL('image/webp', 0.82));
        };

        const setZoom = (value) => {
          zoom = Math.max(minZoom, Math.min(maxZoom, Number(value) || 1));
          zoomInput.value = String(zoom);
          updatePreview();
        };

        zoomInput.addEventListener('input', () => setZoom(zoomInput.value));
        stage.addEventListener('wheel', (event) => {
          event.preventDefault();
          setZoom(zoom + (event.deltaY < 0 ? 0.08 : -0.08));
        }, { passive: false });
        stage.addEventListener('mousedown', startDrag);
        stage.addEventListener('touchstart', startDrag, { passive: false });
        windowRef.addEventListener('mousemove', onMove);
        windowRef.addEventListener('touchmove', onMove, { passive: false });
        windowRef.addEventListener('mouseup', stopDrag);
        windowRef.addEventListener('touchend', stopDrag);
        overlay.querySelectorAll('[data-avatar-crop-cancel]').forEach((button) => button.addEventListener('click', cancel));
        overlay.querySelector('[data-avatar-crop-confirm]')?.addEventListener('click', confirm);
        overlay.addEventListener('click', (event) => { if (event.target === overlay) cancel(); });
        overlay.addEventListener('keydown', (event) => { if (event.key === 'Escape') cancel(); });
        overlay.tabIndex = -1;
        overlay.focus();
        updatePreview();
      };
      image.src = dataUrl;
    });
  }

  function previewProfileAvatar() {
    openAvatarViewer({
      avatarUrl: String(documentRef.getElementById('profile-avatar-url')?.value ?? state.currentUser?.avatarUrl ?? state.currentUser?.avatar_url ?? '').trim(),
      displayName: state.currentUser?.displayName || state.currentUser?.display_name || state.currentUser?.username || state.currentUser?.email || 'Janus User',
    });
  }

  function openAvatarViewer({ avatarUrl = '', displayName = 'Janus User' } = {}) {
    avatarUrl = String(avatarUrl || '').trim();
    displayName = String(displayName || 'Janus User').trim() || 'Janus User';
    const label = String(displayName || 'OA').trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'OA';
    const overlay = documentRef.createElement('div');
    overlay.className = 'avatar-viewer-overlay';
    const modal = documentRef.createElement('section');
    modal.className = 'avatar-viewer-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', translateText('查看头像'));
    const close = documentRef.createElement('button');
    close.type = 'button';
    close.className = 'avatar-viewer-close';
    close.setAttribute('aria-label', translateText('关闭'));
    close.textContent = '×';
    const frame = documentRef.createElement('div');
    frame.className = 'avatar-viewer-frame';
    if (avatarUrl) {
      const img = documentRef.createElement('img');
      img.src = avatarUrl;
      img.alt = '';
      frame.appendChild(img);
    } else {
      const fallback = documentRef.createElement('span');
      fallback.className = 'avatar account-avatar avatar-viewer-fallback';
      fallback.textContent = label;
      frame.appendChild(fallback);
    }
    const caption = documentRef.createElement('strong');
    caption.className = 'avatar-viewer-caption';
    caption.textContent = displayName;
    const actions = documentRef.createElement('div');
    actions.className = 'avatar-viewer-actions';
    if (avatarUrl) {
      const download = documentRef.createElement('button');
      download.type = 'button';
      download.className = 'btn secondary avatar-viewer-download';
      download.innerHTML = `${iconSvg('download')}<span>${translateText('下载头像')}</span>`;
      download.addEventListener('click', () => downloadAvatarImage({ avatarUrl, displayName }));
      actions.appendChild(download);
    }
    modal.append(close, frame, caption, actions);
    overlay.appendChild(modal);
    const cleanup = () => overlay.remove();
    close.addEventListener('click', cleanup);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) cleanup(); });
    overlay.addEventListener('keydown', (event) => { if (event.key === 'Escape') cleanup(); });
    documentRef.body.appendChild(overlay);
    localizeRoot(overlay);
    overlay.tabIndex = -1;
    overlay.focus();
  }

  async function downloadAvatarImage({ avatarUrl = '', displayName = 'avatar' } = {}) {
    let downloadUrl = String(avatarUrl || '').trim();
    if (!downloadUrl) return;
    let objectUrl = '';
    try {
      let extension = avatarExtension(downloadUrl);
      if (/^https:/i.test(downloadUrl)) {
        const response = await windowRef.fetch(downloadUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        extension = avatarExtensionFromType(blob.type) || extension;
        objectUrl = windowRef.URL.createObjectURL(blob);
        downloadUrl = objectUrl;
      }
      const safeName = String(displayName || 'avatar').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'avatar';
      const anchor = documentRef.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = `${safeName}-avatar.${extension}`;
      anchor.hidden = true;
      documentRef.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      notify('头像下载已开始。', 'success');
    } catch (error) {
      notify(`下载头像失败：${error.message || error}`, 'error');
    } finally {
      if (objectUrl) windowRef.setTimeout(() => windowRef.URL.revokeObjectURL(objectUrl), 1000);
    }
  }

  function avatarExtension(value = '') {
    const dataType = String(value || '').match(/^data:image\/(png|jpe?g|webp|gif);/i)?.[1]?.toLowerCase();
    if (dataType) return dataType === 'jpeg' ? 'jpg' : dataType;
    const pathExtension = String(value || '').match(/\.(png|jpe?g|webp|gif)(?:[?#]|$)/i)?.[1]?.toLowerCase();
    return pathExtension === 'jpeg' ? 'jpg' : pathExtension || 'png';
  }

  function avatarExtensionFromType(value = '') {
    const type = String(value || '').toLowerCase();
    if (type === 'image/jpeg') return 'jpg';
    return ['image/png', 'image/webp', 'image/gif'].includes(type) ? type.slice(6) : '';
  }

  async function chooseProfileAvatar(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    try {
      const avatarUrl = await resizeAvatarFile(file);
      const previousAvatarUrl = String(state.currentUser?.avatarUrl || state.currentUser?.avatar_url || '');
      setProfileAvatarDraft(avatarUrl);
      try {
        await persistProfileChanges({ avatarUrl, successMessage: '头像已保存。' });
      } catch (error) {
        setProfileAvatarDraft(previousAvatarUrl);
        throw error;
      }
    } catch (error) {
      if (!/crop cancelled/i.test(String(error?.message || error))) notify(error.message || '头像处理失败。', 'error');
    } finally {
      if (event?.target) event.target.value = '';
    }
  }

  async function removeProfileAvatar() {
    const previousAvatarUrl = String(state.currentUser?.avatarUrl || state.currentUser?.avatar_url || '');
    setProfileAvatarDraft('');
    try {
      await persistProfileChanges({ avatarUrl: '', successMessage: '头像已移除。' });
    } catch (error) {
      setProfileAvatarDraft(previousAvatarUrl);
      notify(`移除头像失败：${error.message || error}`, 'error');
    }
  }

  async function persistProfileChanges({ avatarUrl = null, successMessage = '账号资料已保存。' } = {}) {
    const resolvedAvatarUrl = String(avatarUrl ?? documentRef.getElementById('profile-avatar-url')?.value ?? state.currentUser?.avatarUrl ?? state.currentUser?.avatar_url ?? '').trim();
    const displayName = documentRef.getElementById('profile-display-name')?.value || '';
    const email = documentRef.getElementById('profile-email')?.value || '';
    const username = documentRef.getElementById('profile-username')?.value || '';
    const savedUser = await api.updateProfile({ displayName, email, username, avatarUrl: resolvedAvatarUrl, avatar_url: resolvedAvatarUrl });
    state.currentUser = {
      ...(savedUser || state.currentUser || {}),
      displayName: savedUser?.displayName || savedUser?.display_name || displayName,
      display_name: savedUser?.display_name || savedUser?.displayName || displayName,
      username: savedUser?.username || username,
      avatarUrl: resolvedAvatarUrl,
      avatar_url: resolvedAvatarUrl,
    };
    if (isCurrentUserAdmin()) state.adminUsers = await api.listUsers();
    notify(savedUser?.profileSyncPending
      ? '账号资料已保存到本机，连接通信服务器后会自动同步。'
      : successMessage, savedUser?.profileSyncPending ? 'warning' : 'success');
    render();
    return savedUser;
  }

  async function saveProfile(event) {
    event.preventDefault();
    try {
      await persistProfileChanges();
    } catch (error) {
      notify(`保存失败：${error.message || error}`, 'error');
    }
  }

  return {
    loginAccount,
    logoutAccount,
    refreshBootstrapAfterAuth,
    refreshSocialAfterAuthentication,
    registerAccount,
    resetAuthUiState,
    resetPasswordByEmail,
    chooseProfileAvatar,
    openAvatarViewer,
    previewProfileAvatar,
    removeProfileAvatar,
    saveProfile,
    sendEmailCodeFromInput,
    refreshEmailCodeButtonState,
    syncAuthDraftFromDom,
    userErrorMessage,
  };
}
