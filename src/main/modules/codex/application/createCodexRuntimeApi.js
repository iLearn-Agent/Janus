export function createCodexRuntimeApi({
  auth,
  runtimeRoot,
  runDoctor,
  configStatus,
  configFiles,
  saveConfig,
  saveConfigFiles,
  storedProviderCandidate,
  setStoredProviderValidation,
  probeProvider,
  requestProviderKeyApplication,
  listProviderKeyApplications,
  decideProviderKeyApplication,
  claimProviderKeyApplication,
  confirmProviderKeyClaim,
}) {
  return {
    async doctor() {
      auth.requireUser();
      return runDoctor(runtimeRoot);
    },
    codexConfig() {
      const user = auth.requireUser();
      return codexConfigForUser(configStatus(runtimeRoot), user);
    },
    codexConfigFiles() {
      const user = auth.requireUser();
      requireConfigEditor(configStatus(runtimeRoot), user);
      return configFiles(runtimeRoot);
    },
    saveCodexConfig(payload = {}) {
      auth.requireAdmin();
      return saveConfig(runtimeRoot, payload);
    },
    async saveCodexConfigFiles(payload = {}) {
      const user = auth.requireUser();
      const status = configStatus(runtimeRoot);
      requireConfigEditor(status, user);
      const saved = saveConfigFiles(runtimeRoot, payload);
      const candidate = storedProviderCandidate(runtimeRoot);
      if (candidate.blank) {
        setStoredProviderValidation(runtimeRoot, false);
        return {
          ...saved,
          status: configStatus(runtimeRoot),
          test: {
            passed: true,
            status: 'fallback',
            title: '已恢复默认模型服务',
            message: 'config.toml 和 auth.json 已清空，可继续直接使用 Janus。',
          },
        };
      }
      if (!candidate.complete) {
        setStoredProviderValidation(runtimeRoot, false);
        return {
          ...saved,
          status: configStatus(runtimeRoot),
          test: {
            passed: false,
            status: 'fail',
            title: '自定义配置未启用',
            message: 'config.toml 需要完整的 model_provider/base_url，auth.json 需要对应认证变量；当前继续使用默认模型服务。',
          },
        };
      }
      let probe;
      try {
        probe = await probeProvider({ baseUrl: candidate.baseUrl, apiKey: candidate.apiKey, model: candidate.model });
      } catch (error) {
        probe = { status: 'fail', summary: error?.message || String(error), modelIds: [] };
      }
      const modelIds = Array.isArray(probe?.modelIds) ? probe.modelIds : [];
      const modelUnavailable = Boolean(
        !probe?.modelVerified && candidate.model && modelIds.length && !modelIds.includes(candidate.model),
      );
      const passed = probe?.status === 'pass' && !modelUnavailable;
      setStoredProviderValidation(runtimeRoot, passed);
      const finalStatus = configStatus(runtimeRoot);
      return {
        ...saved,
        status: finalStatus,
        test: passed
          ? {
            passed: true,
            status: 'pass',
            title: '自定义 Provider 已启用',
            message: candidate.model
              ? `网络、鉴权和模型 ${candidate.model} 路由检查通过。`
              : 'Provider 网络和鉴权检查通过。',
          }
          : {
            passed: false,
            status: 'fail',
            title: '自定义配置测试失败',
            message: modelUnavailable
              ? `Provider 不提供模型 ${candidate.model}；当前继续使用默认模型服务。`
              : `${probe?.summary || 'Provider 网络或鉴权不可用。'} 当前继续使用默认模型服务。`,
          },
      };
    },
    requestProviderKeyApplication(payload = {}) {
      const user = auth.requireUser();
      if (!configStatus(runtimeRoot).providerKeyApplicationEnabled) throw new Error('Provider Key 申请入口当前未开放。');
      if (!user.email || !user.emailVerified) throw new Error('请先完成当前账号的邮箱验证。');
      if (typeof requestProviderKeyApplication !== 'function') throw new Error('Provider Key 申请服务尚未配置。');
      return requestProviderKeyApplication(payload);
    },
    providerKeyApplications() {
      auth.requireUser();
      if (!configStatus(runtimeRoot).providerKeyApplicationEnabled) throw new Error('Provider Key 申请入口当前未开放。');
      if (typeof listProviderKeyApplications !== 'function') throw new Error('Provider Key 申请服务尚未配置。');
      return listProviderKeyApplications();
    },
    decideProviderKeyApplication(payload = {}) {
      auth.requireAdmin();
      if (!configStatus(runtimeRoot).providerKeyApplicationEnabled) throw new Error('Provider Key 审核入口当前未开放。');
      if (typeof decideProviderKeyApplication !== 'function') throw new Error('Provider Key 审核服务尚未配置。');
      return decideProviderKeyApplication(String(payload.applicationId || ''), payload);
    },
    async claimProviderKeyApplication(payload = {}) {
      const user = auth.requireUser();
      const status = configStatus(runtimeRoot);
      if (!status.providerKeyApplicationEnabled) throw new Error('Provider Key 领取入口当前未开放。');
      if (status.configurationMode !== 'user-configurable') throw new Error('当前发行模式不支持领取自主配置 Key。');
      if (typeof claimProviderKeyApplication !== 'function' || typeof confirmProviderKeyClaim !== 'function') {
        throw new Error('Provider Key 领取服务尚未配置。');
      }
      const applicationId = String(payload.applicationId || '').trim();
      if (!applicationId) throw new Error('Provider Key 申请 ID 不能为空。');
      const claimed = await claimProviderKeyApplication(applicationId, user);
      const credential = claimed?.credential || {};
      if (!credential.baseUrl || !credential.apiKey) throw new Error('服务器返回的 Provider 配置不完整。');
      const savedStatus = saveConfig(runtimeRoot, {
        baseUrl: credential.baseUrl,
        apiKey: credential.apiKey,
        model: credential.model || status.model || 'gpt-5.6-sol',
        reviewModel: credential.model || status.reviewModel || status.model || 'gpt-5.6-sol',
        reasoningEffort: status.reasoningEffort || 'medium',
        adminProviderOverride: false,
      });
      const confirmed = await confirmProviderKeyClaim(applicationId, user);
      return { status: savedStatus, application: confirmed?.application || claimed?.application || null };
    },
  };
}

export function codexConfigForUser(config = {}, user = null) {
  if (codexConfigEditableByUser(config, user)) {
    if (!['embedded', 'development'].includes(config.credentialSource)) return config;
    return {
      ...config,
      baseUrl: '',
      authEnvKey: 'OPENAI_API_KEY',
    };
  }
  return {
    model: String(config.model || ''),
    reviewModel: String(config.reviewModel || ''),
    reasoningEffort: String(config.reasoningEffort || ''),
    hasApiKey: Boolean(config.hasApiKey),
    credentialSource: config.credentialSource === 'embedded' ? 'embedded' : config.hasApiKey ? 'managed' : 'missing',
    configurationMode: String(config.configurationMode || 'managed'),
  };
}

export function codexConfigEditableByUser(config = {}, user = null) {
  return Boolean(user) && (
    user.role === 'admin'
    || ['user-configurable', 'embedded-with-user-override'].includes(config.configurationMode)
  );
}

function requireConfigEditor(config, user) {
  if (codexConfigEditableByUser(config, user)) return user;
  throw new Error('当前账号不能修改模型 Provider 配置。');
}
