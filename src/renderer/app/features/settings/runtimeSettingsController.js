export function createRuntimeSettingsController({
  api,
  state,
  render,
  notify,
  appendStatus,
  reasoningOptionsForModel,
  modelCatalogEntry,
  escapeAttr,
  escapeHtml,
  documentRef,
  windowRef,
  translateText = (value) => String(value || ''),
}) {
  let feishuStatusPollTimer = null;

  function scheduleFeishuStatusPoll() {
    if (feishuStatusPollTimer) windowRef.clearTimeout(feishuStatusPollTimer);
    feishuStatusPollTimer = null;
    const shouldPoll = state.currentTab === 'settings'
      && state.currentSettingsSection === 'connections'
      && ['connecting', 'reconnecting'].includes(state.feishuStatus?.connectionState);
    if (!shouldPoll) return;
    feishuStatusPollTimer = windowRef.setTimeout(() => {
      feishuStatusPollTimer = null;
      if (state.currentTab === 'settings' && state.currentSettingsSection === 'connections') {
        void loadFeishuStatus({ silent: true });
      }
    }, 1500);
  }

  async function changePassword(event) {
    event.preventDefault();
    try {
      await api.updatePassword({
        currentPassword: documentRef.getElementById('current-password')?.value || '',
        newPassword: documentRef.getElementById('new-password')?.value || '',
        code: documentRef.getElementById('password-change-code')?.value || '',
      });
      state.emailCodeNotice = null;
      notify('密码已更新。', 'success');
      render();
    } catch (error) {
      notify(`修改失败：${error.message || error}`, 'error');
    }
  }

  function captureFeishuDraft() {
    state.feishuDraft = {
      appId: documentRef.getElementById('feishu-app-id')?.value.trim() || '',
      appSecret: documentRef.getElementById('feishu-app-secret')?.value || '',
      domain: documentRef.getElementById('feishu-domain')?.value === 'lark' ? 'lark' : 'feishu',
      enabled: Boolean(documentRef.getElementById('feishu-enabled')?.checked),
    };
    return state.feishuDraft;
  }

  async function loadFeishuStatus({ silent = false } = {}) {
    if (state.feishuLoading) return state.feishuStatus;
    state.feishuLoading = true;
    if (!silent) render();
    try {
      state.feishuStatus = await api.feishuStatus();
      return state.feishuStatus;
    } catch (error) {
      state.feishuTestResult = { ok: false, message: error.message || String(error) };
      return null;
    } finally {
      state.feishuLoading = false;
      render();
      scheduleFeishuStatusPoll();
    }
  }

  async function testFeishuConfig() {
    if (state.feishuBusy) return;
    const payload = captureFeishuDraft();
    state.feishuBusy = 'test';
    state.feishuTestResult = null;
    render();
    try {
      await api.testFeishuConfig(payload);
      state.feishuTestResult = { ok: true, message: '凭证测试通过。' };
    } catch (error) {
      state.feishuTestResult = { ok: false, message: `凭证测试失败：${error.message || error}` };
    } finally {
      state.feishuBusy = '';
      render();
      scheduleFeishuStatusPoll();
    }
  }

  async function saveFeishuConfig(event) {
    event.preventDefault();
    if (state.feishuBusy) return;
    const payload = captureFeishuDraft();
    state.feishuBusy = 'save';
    state.feishuTestResult = null;
    render();
    try {
      state.feishuStatus = await api.saveFeishuConfig(payload);
      state.feishuDraft = null;
      state.feishuTestResult = { ok: true, message: '飞书配置已保存。' };
      notify('飞书配置已保存。', 'success');
    } catch (error) {
      state.feishuTestResult = { ok: false, message: `保存失败：${error.message || error}` };
      notify(`飞书配置保存失败：${error.message || error}`, 'error');
    } finally {
      state.feishuBusy = '';
      render();
      scheduleFeishuStatusPoll();
    }
  }

  async function regenerateFeishuBindingCode() {
    if (state.feishuBusy) return;
    state.feishuBusy = 'regenerate';
    render();
    try {
      state.feishuStatus = await api.regenerateFeishuBindingCode();
      notify('已生成新的飞书绑定码。', 'success');
    } catch (error) {
      notify(`生成绑定码失败：${error.message || error}`, 'error');
    } finally {
      state.feishuBusy = '';
      render();
    }
  }

  async function unbindFeishu() {
    if (state.feishuBusy) return;
    state.feishuBusy = 'unbind';
    render();
    try {
      state.feishuStatus = await api.unbindFeishu();
      notify('飞书账号已解除绑定。', 'success');
    } catch (error) {
      notify(`解除绑定失败：${error.message || error}`, 'error');
    } finally {
      state.feishuBusy = '';
      render();
    }
  }





  async function saveCodexConfig(event) {
    event.preventDefault();
    if (state.busy) return;
    const baseUrl = documentRef.getElementById('codex-base-url')?.value.trim() || '';
    const model = documentRef.getElementById('codex-model')?.value.trim() || 'gpt-5.6-sol';
    const reasoningEffort = documentRef.getElementById('codex-reasoning')?.value || 'medium';
    const apiKey = documentRef.getElementById('codex-api-key')?.value.trim() || '';
    const adminProviderOverride = Boolean(documentRef.getElementById('codex-admin-provider-override')?.checked);
    state.busy = true;
    state.codexConnectionTest = {
      status: 'running',
      title: '保存配置',
      message: '正在保存字段配置...',
    };
    render();
    try {
      state.codexConfig = await api.saveCodexConfig({
        baseUrl,
        model,
        reviewModel: model,
        reasoningEffort,
        apiKey,
        adminProviderOverride,
      });
      state.codexConfigFiles = null;
      const test = await runCodexConnectionTest('字段配置已保存，正在测试 Janus 模型通路...');
      if (api.managedProviderUsageStatus) state.managedProviderUsage = await api.managedProviderUsageStatus();
      notify(test.passed ? 'Janus 模型配置已保存，通路可用。' : 'Janus 模型配置已保存，但通路测试失败。', notificationToneForConnectionTest(test));
    } catch (error) {
      appendStatus(`Janus model configuration error: ${error.message || error}`);
      state.codexConnectionTest = {
        status: 'fail',
        title: '保存失败',
        message: error.message || String(error),
      };
      notify(`Janus 模型配置保存失败：${error.message || error}`, 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  function toggleCodexApiKeyVisibility(event) {
    const input = documentRef.getElementById('codex-api-key');
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    event.currentTarget.textContent = translateText(show ? '隐藏' : '显示');
    input.focus();
  }

  async function switchCodexConfigMode(mode = 'fields') {
    const nextMode = mode === 'files' ? 'files' : 'fields';
    if (nextMode === 'files' && !state.codexConfigFiles) {
      try {
        state.codexConfigFiles = await api.codexConfigFiles();
      } catch (error) {
        notify(`读取高级配置失败：${error.message || error}`, 'error');
        return;
      }
    }
    state.codexConfigMode = nextMode;
    render();
  }

  function closeSettingsCustomSelects(except = null) {
    documentRef.querySelectorAll('.settings-select.open').forEach((control) => {
      if (control === except) return;
      control.classList.remove('open');
      control.querySelector('[data-settings-select-trigger]')?.setAttribute('aria-expanded', 'false');
    });
  }

  function syncSettingsCustomSelect(control) {
    const select = control?.querySelector('select');
    const trigger = control?.querySelector('[data-settings-select-trigger]');
    const menu = control?.querySelector('.settings-select-menu');
    if (!select || !trigger || !menu) return;
    const selected = select.selectedOptions?.[0] || select.options[select.selectedIndex];
    const optionIcon = control.classList.contains('startup-workspace-select') ? trigger.querySelector('i')?.outerHTML || '' : '';
    trigger.querySelector('span').textContent = selected?.textContent || select.value;
    menu.innerHTML = Array.from(select.options).map((option) => `
      <button class="settings-select-option ${option.selected ? 'selected' : ''}" type="button" role="option" aria-selected="${option.selected ? 'true' : 'false'}" data-settings-select-option="${select.id}" data-value="${option.value}" ${select.disabled ? 'disabled' : ''}>
        ${optionIcon}<span>${option.textContent}</span>
      </button>
    `).join('');
  }

  function bindSettingsCustomSelects() {
    documentRef.querySelectorAll('.settings-select').forEach((control) => {
      syncSettingsCustomSelect(control);
      const trigger = control.querySelector('[data-settings-select-trigger]');
      const select = control.querySelector('select');
      if (!trigger || !select) return;
      trigger.addEventListener('click', (event) => {
        event.stopPropagation();
        const willOpen = !control.classList.contains('open');
        closeSettingsCustomSelects(control);
        control.classList.toggle('open', willOpen);
        trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      });
      control.addEventListener('click', (event) => {
        const option = event.target.closest('[data-settings-select-option]');
        if (!option || option.dataset.settingsSelectOption !== select.id) return;
        select.value = option.dataset.value || '';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        syncSettingsCustomSelect(control);
        closeSettingsCustomSelects();
      });
    });
  }

  if (!windowRef.__janusSettingsSelectBound) {
    windowRef.__janusSettingsSelectBound = true;
    documentRef.addEventListener('click', () => closeSettingsCustomSelects());
    documentRef.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeSettingsCustomSelects();
    });
  }

  function updateCodexReasoningOptions(event) {
    const select = documentRef.getElementById('codex-reasoning');
    if (!select) return;
    const model = event.currentTarget.value || '';
    const options = reasoningOptionsForModel(state.modelCatalog, model);
    const previous = select.value;
    select.innerHTML = options
      .map(([value, label]) => `<option value="${escapeAttr(value)}">${escapeHtml(label)}</option>`)
      .join('');
    const fallback = modelCatalogEntry(state.modelCatalog, model)?.defaultReasoningEffort || options[0]?.[0] || 'medium';
    select.value = options.some(([value]) => value === previous) ? previous : fallback;
    syncSettingsCustomSelect(select.closest('.settings-select'));
  }

  async function saveCodexConfigFiles(event) {
    event.preventDefault();
    if (state.busy) return;
    const authJson = documentRef.getElementById('codex-auth-json')?.value || '';
    const configToml = documentRef.getElementById('codex-config-toml')?.value || '';
    state.busy = true;
    state.codexConfigFiles = {
      ...(state.codexConfigFiles || {}),
      authJson,
      configToml,
    };
    state.codexConnectionTest = {
      status: 'running',
      title: '保存配置',
      message: '正在保存整文件配置...',
    };
    render();
    try {
      const result = await api.saveCodexConfigFiles({ authJson, configToml });
      state.codexConfig = result.status;
      state.codexConfigFiles = result.files;
      const test = result.test || {
        passed: false,
        status: 'fail',
        title: '通路测试失败',
        message: '主进程未返回 Provider 测试结果；当前继续使用默认模型服务。',
      };
      state.codexConnectionTest = {
        status: test.status === 'fallback' ? 'pass' : test.status,
        title: test.title,
        message: test.message,
      };
      if (api.managedProviderUsageStatus) state.managedProviderUsage = await api.managedProviderUsageStatus();
      notify(test.passed
        ? test.status === 'fallback' ? '高级配置已清空，已恢复默认模型服务。' : '高级配置测试通过，已启用自定义模型服务。'
        : '高级配置测试失败，将继续使用默认模型服务。',
      test.passed ? 'success' : 'error');
    } catch (error) {
      appendStatus(`Janus model file configuration error: ${error.message || error}`);
      state.codexConnectionTest = {
        status: 'fail',
        title: '保存失败',
        message: error.message || String(error),
      };
      notify(`文件配置保存失败：${error.message || error}`, 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function requestProviderKeyApplication(event) {
    event.preventDefault();
    if (state.providerKeyApplicationBusy) return;
    const organization = documentRef.getElementById('provider-key-organization')?.value.trim() || '';
    const usage = documentRef.getElementById('provider-key-usage')?.value.trim() || '';
    state.providerKeyApplicationDraft = { organization, usage };
    state.providerKeyApplicationBusy = true;
    state.providerKeyApplicationResult = {
      status: 'running',
      title: '正在提交',
      message: '正在通过已验证邮箱提交机构申请…',
    };
    render();
    try {
      const result = await api.requestProviderKeyApplication({ organization, usage });
      state.providerKeyAccess = await api.providerKeyApplications();
      state.providerKeyApplicationResult = {
        status: 'pass',
        title: result.reused ? '申请已受理' : '申请已提交',
        message: result.notificationDelivered === false
          ? '申请已记录，但管理员通知邮件暂未送达；管理员仍可在审核区看到申请。'
          : `审核结果会发送到 ${result.application?.accountEmail || state.currentUser?.email || '当前账号邮箱'}。`,
      };
      notify(result.reused ? '近期申请已受理，请勿重复提交。' : 'Provider Key 申请已提交。', 'success');
    } catch (error) {
      state.providerKeyApplicationResult = {
        status: 'fail',
        title: '提交失败',
        message: error.message || String(error),
      };
      notify(`Provider Key 申请失败：${error.message || error}`, 'error');
    } finally {
      state.providerKeyApplicationBusy = false;
      render();
    }
  }

  async function loadProviderKeyApplications({ silent = false } = {}) {
    if (state.providerKeyAccessBusy) return state.providerKeyAccess;
    state.providerKeyAccessBusy = true;
    if (!silent) render();
    try {
      state.providerKeyAccess = await api.providerKeyApplications();
      if (!silent) notify('Provider Key 申请状态已刷新。', 'success');
      return state.providerKeyAccess;
    } catch (error) {
      if (!silent) notify(`刷新 Provider Key 申请失败：${error.message || error}`, 'error');
      return null;
    } finally {
      state.providerKeyAccessBusy = false;
      render();
    }
  }

  async function decideProviderKeyApplication(applicationId = '', action = '') {
    if (!applicationId || state.providerKeyDecisionBusyId) return;
    const noteInput = Array.from(documentRef.querySelectorAll('[data-provider-key-review-note]'))
      .find((input) => input.dataset.providerKeyReviewNote === applicationId);
    state.providerKeyDecisionBusyId = applicationId;
    render();
    try {
      const result = await api.decideProviderKeyApplication({
        applicationId,
        action,
        note: noteInput?.value || '',
      });
      await loadProviderKeyApplications({ silent: true });
      const label = action === 'approve' ? '批准' : action === 'reject' ? '拒绝' : action === 'reissue' ? '重新开放领取' : '停止再次领取';
      notify(result.notificationDelivered === false ? `${label}已生效，但结果邮件发送失败。` : `申请已${label}。`, result.notificationDelivered === false ? 'warning' : 'success');
    } catch (error) {
      notify(`Provider Key 审核失败：${error.message || error}`, 'error');
    } finally {
      state.providerKeyDecisionBusyId = '';
      render();
    }
  }

  async function claimProviderKeyApplication(applicationId = '') {
    if (!applicationId || state.providerKeyClaimBusy) return;
    state.providerKeyClaimBusy = true;
    state.providerKeyApplicationResult = {
      status: 'running', title: '正在领取', message: '正在安全写入本机 Janus 模型配置…',
    };
    render();
    try {
      const result = await api.claimProviderKeyApplication({ applicationId });
      state.codexConfig = result.status;
      state.codexConfigFiles = await api.codexConfigFiles();
      await loadProviderKeyApplications({ silent: true });
      state.providerKeyApplicationResult = {
        status: 'pass', title: '领取完成', message: '共享 Provider URL 和 Key 已写入当前设备，可以直接测试 Janus 模型通路。',
      };
      notify('Provider Key 已领取并写入高级配置。', 'success');
    } catch (error) {
      state.providerKeyApplicationResult = {
        status: 'fail', title: '领取失败', message: error.message || String(error),
      };
      notify(`Provider Key 领取失败：${error.message || error}`, 'error');
    } finally {
      state.providerKeyClaimBusy = false;
      render();
    }
  }

  async function sendProviderKeyEmailCode() {
    if (state.providerKeyEmailVerificationBusy) return;
    const email = String(state.currentUser?.email || '').trim();
    if (!email) return notify('当前账号尚未绑定邮箱。', 'warning');
    state.providerKeyEmailVerificationBusy = true;
    render();
    try {
      await api.sendEmailCode({ method: 'email', email, purpose: 'email_verify' });
      state.providerKeyApplicationResult = {
        status: 'pass', title: '验证码已发送', message: `请检查 ${email}。`,
      };
      notify('邮箱验证码已发送。', 'success');
    } catch (error) {
      state.providerKeyApplicationResult = {
        status: 'fail', title: '验证码发送失败', message: error.message || String(error),
      };
      notify(`邮箱验证码发送失败：${error.message || error}`, 'error');
    } finally {
      state.providerKeyEmailVerificationBusy = false;
      render();
    }
  }

  async function verifyProviderKeyEmail() {
    if (state.providerKeyEmailVerificationBusy) return;
    const email = String(state.currentUser?.email || '').trim();
    const code = documentRef.getElementById('provider-key-email-code')?.value.trim() || state.providerKeyEmailCode || '';
    state.providerKeyEmailCode = code;
    if (!/^\d{6}$/.test(code)) return notify('请输入 6 位邮箱验证码。', 'warning');
    state.providerKeyEmailVerificationBusy = true;
    render();
    try {
      const user = await api.verifyEmail({ email, code, purpose: 'email_verify' });
      state.currentUser = { ...(state.currentUser || {}), ...(user?.user || user || {}), emailVerified: true, email_verified: true };
      state.providerKeyEmailCode = '';
      state.providerKeyApplicationResult = {
        status: 'pass', title: '邮箱验证完成', message: '现在可以提交机构申请。',
      };
      notify('邮箱验证完成。', 'success');
    } catch (error) {
      state.providerKeyApplicationResult = {
        status: 'fail', title: '邮箱验证失败', message: error.message || String(error),
      };
      notify(`邮箱验证失败：${error.message || error}`, 'error');
    } finally {
      state.providerKeyEmailVerificationBusy = false;
      render();
    }
  }

  function formatCodexAuthJson() {
    const input = documentRef.getElementById('codex-auth-json');
    if (!input) return;
    try {
      const formatted = `${JSON.stringify(JSON.parse(input.value || '{}'), null, 2)}\n`;
      input.value = formatted;
      state.codexConfigFiles = {
        ...(state.codexConfigFiles || {}),
        authJson: formatted,
      };
      notify('auth.json 已格式化。', 'success');
    } catch (error) {
      notify(`auth.json 不是合法 JSON：${error.message || error}`, 'error');
    }
  }

  async function reloadCodexConfigFiles() {
    try {
      state.codexConfigFiles = await api.codexConfigFiles();
      state.codexConfig = await api.codexConfig();
      if (api.managedProviderUsageStatus) state.managedProviderUsage = await api.managedProviderUsageStatus();
      render();
      notify('已重载 Janus 模型配置文件。', 'success');
    } catch (error) {
      notify(`重载配置失败：${error.message || error}`, 'error');
    }
  }

  async function runCodexConnectionTest(message = '正在测试 Janus 模型通路...') {
    state.codexConnectionTest = {
      status: 'running',
      title: '通路测试中',
      message,
    };
    render();
    try {
      const report = await api.codexDoctor();
      state.codexDoctor = report;
      const classification = classifyCodexDoctor(report);
      state.codexConnectionTest = {
        status: classification.status,
        title: classification.title,
        message: summarizeCodexDoctor(report),
      };
      render();
      return { ...classification, report };
    } catch (error) {
      const messageText = error.message || String(error);
      state.codexConnectionTest = {
        status: 'fail',
        title: '通路测试失败',
        message: messageText,
      };
      render();
      return { passed: false, report: null, error };
    }
  }

  function summarizeCodexDoctor(report) {
    if (!report) return '未收到 Janus 模型诊断报告。';
    if (report.available === false) return report.error || 'Janus 模型运行组件未找到。';
    if (report.error) return report.error;
    const classification = classifyCodexDoctor(report);
    if (classification.passed) {
      const version = report.codexVersion ? ` ${report.codexVersion}` : '';
      const suffix = classification.status === 'warn' ? '；Doctor 返回 warning，但关键检查均可用。' : '。';
      return `Janus 模型运行组件${version}可用，配置加载、鉴权和 Provider 网络检查通过${suffix}`;
    }
    const failedChecks = Object.entries(report.checks || {})
      .filter(([, item]) => isFailingDoctorStatus(item?.status))
      .map(([key, item]) => `${key}: ${item.summary || item.status}`);
    return failedChecks.join('；') || `Janus 模型诊断状态：${report.overallStatus || 'unknown'}`;
  }

  function classifyCodexDoctor(report) {
    if (!report || report.available === false || report.error) {
      return { passed: false, status: 'fail', title: '通路测试失败' };
    }
    const checks = report.checks || {};
    const criticalChecks = ['installation', 'auth.credentials', 'config.load', 'network.provider_reachability'];
    const hasCriticalFailure = criticalChecks.some((key) => checks[key] && isFailingDoctorStatus(checks[key].status));
    const hasAnyFailure = Object.values(checks).some((item) => item?.status && isFailingDoctorStatus(item.status));
    if (Number(report.exitCode || 0) !== 0 || hasCriticalFailure || hasAnyFailure || isFailingDoctorStatus(report.overallStatus)) {
      return { passed: false, status: 'fail', title: '通路测试失败' };
    }
    if (isWarningDoctorStatus(report.overallStatus) || Object.values(checks).some((item) => isWarningDoctorStatus(item?.status))) {
      return { passed: true, status: 'warn', title: '通路可用（有警告）' };
    }
    return { passed: true, status: 'pass', title: '通路测试通过' };
  }

  function isWarningDoctorStatus(status) {
    return ['warn', 'warning'].includes(String(status || '').toLowerCase());
  }

  function isFailingDoctorStatus(status) {
    return ['fail', 'failed', 'error'].includes(String(status || '').toLowerCase());
  }

  function notificationToneForConnectionTest(test) {
    if (!test?.passed) return 'error';
    return test.status === 'warn' ? 'warning' : 'success';
  }

  async function resolveCommunication(communicationId, button) {
    if (!communicationId || state.busy) return;
    const row = button?.closest('[data-communication-id]');
    const input = row?.querySelector('textarea');
    const responseText = input?.value.trim() || '';
    if (!responseText) {
      appendStatus('Communication response is required before resolving.');
      input?.focus();
      return;
    }
    state.busy = true;
    render();
    try {
      await api.resolveCommunication({
        communicationId,
        response: {
          responseText,
          responderId: 'desktop_operator',
        },
      });
      if (state.taskDetail?.id) state.taskDetail = await api.getTask(state.taskDetail.id);
      state.tasks = await api.listTasks();
      state.agentStatuses = await api.agentStatuses();
      notify('沟通请求已解决。', 'success');
    } catch (error) {
      appendStatus(`Communication resolve error: ${error.message || error}`);
      notify(`解决沟通请求失败：${error.message || error}`, 'error');
    } finally {
      state.busy = false;
      render();
    }
  }





  return {
    changePassword,
    loadFeishuStatus,
    testFeishuConfig,
    saveFeishuConfig,
    regenerateFeishuBindingCode,
    unbindFeishu,
    saveCodexConfig,
    toggleCodexApiKeyVisibility,
    switchCodexConfigMode,
    closeSettingsCustomSelects,
    syncSettingsCustomSelect,
    bindSettingsCustomSelects,
    updateCodexReasoningOptions,
    saveCodexConfigFiles,
    requestProviderKeyApplication,
    loadProviderKeyApplications,
    decideProviderKeyApplication,
    claimProviderKeyApplication,
    sendProviderKeyEmailCode,
    verifyProviderKeyEmail,
    formatCodexAuthJson,
    reloadCodexConfigFiles,
    runCodexConnectionTest,
    summarizeCodexDoctor,
    classifyCodexDoctor,
    isWarningDoctorStatus,
    isFailingDoctorStatus,
    notificationToneForConnectionTest,
    resolveCommunication,
  };
}
