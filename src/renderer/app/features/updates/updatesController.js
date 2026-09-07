export function createUpdatesController({ state, render, notify, appendStatus, windowRef, documentRef, requestFrame, isCurrentUserAdmin, effectiveJanusVersion, compareSemanticVersions }) {
  async function refreshReleaseStatus(showNotice = true) {
    if (!isCurrentUserAdmin()) return;
    try {
      const [dev, stable] = await Promise.all([
        windowRef.janus.latestRelease({ channel: 'dev' }),
        windowRef.janus.latestRelease({ channel: 'stable' }),
      ]);
      state.releaseDev = dev;
      state.releaseStable = stable;
      if (showNotice) {
        render();
        notify('Release status refreshed.', 'success');
      }
    } catch (error) {
      appendStatus(`Release refresh error: ${error.message || error}`);
      if (showNotice) notify(`Release refresh failed: ${error.message || error}`, 'error');
    }
  }

  async function checkAllUpdates() {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      const [appResult, agentResult] = await Promise.allSettled([
        windowRef.janus.checkForUpdates(),
        windowRef.janus.checkAgentUpdates(),
      ]);
      const failures = [];
      if (appResult.status === 'fulfilled') {
        state.updates = appResult.value || state.updates;
        if (state.updates?.lastError) failures.push(state.updates.lastError);
      } else {
        const message = appResult.reason?.message || String(appResult.reason || '未知错误');
        failures.push(message);
        appendStatus(`Software update check error: ${message}`);
      }
      if (agentResult.status === 'fulfilled') {
        state.agentUpdates = agentResult.value || state.agentUpdates;
        if (state.agentUpdates?.lastError) failures.push(state.agentUpdates.lastError);
      } else {
        const message = agentResult.reason?.message || String(agentResult.reason || '未知错误');
        failures.push(message);
        appendStatus(`Agent organization update check error: ${message}`);
      }
      const available = Boolean(
        state.updates?.available
        || state.updates?.downloaded
        || state.agentUpdates?.available
        || state.agentUpdates?.downloaded,
      );
      if (available) {
        notify(
          `发现 Janus 更新${failures.length ? `；部分检查失败：${failures.join('；')}` : ''}`,
          failures.length ? 'info' : 'success',
          5200,
          '',
          { label: '打开更新中心', onClick: handleAccountUpdateClick },
        );
      } else if (failures.length) {
        notify(`部分更新检查失败：${failures.join('；')}`, 'error');
      } else {
        notify('Janus 已是最新版本。', 'success');
      }
    } finally {
      state.busy = false;
      render();
    }
  }

  function handleAccountUpdateClick() {
    state.accountMenuOpen = false;
    state.accountMenuWorkspaceOpen = false;
    state.currentTab = 'settings';
    state.currentSettingsSection = 'account';
    render();
    requestFrame(() => documentRef.querySelector('#update-center')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  async function downloadUpdate() {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      state.updates = await windowRef.janus.downloadUpdate();
      if (state.updates?.lastError) {
        notify(`${state.updates.message || '更新下载失败'}：${state.updates.lastError}`, 'error');
      } else if (state.updates?.downloaded) {
        notify('更新已下载并通过校验，可在准备好后安装。', 'success', 5200, '', {
          label: '打开更新中心',
          onClick: handleAccountUpdateClick,
        });
      }
    } catch (error) {
      appendStatus(`Update download error: ${error.message || error}`);
      notify(`Update download failed: ${error.message || error}`, 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function installUpdate() {
    if (state.busy || !state.updates?.downloaded) return;
    if (!windowRef.confirm('安装更新需要关闭并重启 Janus。是否现在安装？')) return;
    state.busy = true;
    render();
    try {
      state.updates = await windowRef.janus.installUpdate();
    } catch (error) {
      appendStatus(`Update install error: ${error.message || error}`);
      notify(`启动更新安装失败：${error.message || error}`, 'error');
      state.busy = false;
      render();
    }
  }

  const pluginViewVisible = () => state.currentTab === 'plugins' || (state.currentTab === 'settings' && state.currentSettingsSection === 'skills');

  function pluginById(pluginId) {
    return (state.pluginCatalog || []).find((plugin) => plugin.id === pluginId) || null;
  }

  function applyPluginItem(pluginId, result) {
    const previous = pluginById(pluginId) || { id: pluginId };
    const item = result?.status ? result : { ...previous, status: result || {} };
    state.pluginCatalog = [
      ...(state.pluginCatalog || []).filter((plugin) => plugin.id !== pluginId),
      { ...previous, ...item, id: pluginId },
    ];
    if (pluginId === 'ppt_creation') state.pptxPluginStatus = item.status || result || {};
    return item;
  }

  async function refreshPluginRuntime() {
    const boot = await windowRef.janus.bootstrap();
    state.org = boot.org || state.org;
    state.employeeOverview = boot.employees || state.employeeOverview;
    if (Array.isArray(boot.plugins)) state.pluginCatalog = boot.plugins;
    if (boot.codexPlugins) state.codexPlugins = boot.codexPlugins;
    state.pptxPluginStatus = boot.pptxPluginStatus ?? state.pptxPluginStatus;
  }

  async function loadPluginCatalog({ forceRender = false } = {}) {
    if (state.pptxPluginStatusLoading) return;
    state.pptxPluginStatusLoading = true;
    if (forceRender && pluginViewVisible()) render();
    try {
      if (windowRef.janus.listPlugins) {
        state.pluginCatalog = await windowRef.janus.listPlugins() || [];
        const ppt = pluginById('ppt_creation');
        if (ppt) state.pptxPluginStatus = ppt.status || {};
      } else if (windowRef.janus.pptxPluginStatus) {
        applyPluginItem('ppt_creation', await windowRef.janus.pptxPluginStatus());
      }
      if (windowRef.janus.listAttachedSkills) {
        state.attachedSkillCatalog = await windowRef.janus.listAttachedSkills() || state.attachedSkillCatalog;
      }
      if (windowRef.janus.listCodexPlugins) {
        state.codexPlugins = await windowRef.janus.listCodexPlugins() || state.codexPlugins;
      }
    } catch (error) {
      applyPluginItem('ppt_creation', { installed: false, error: error.message || String(error) });
    } finally {
      state.pptxPluginStatusLoading = false;
      if (forceRender || pluginViewVisible()) render();
    }
  }

  async function importAttachedSkill() {
    const source = String(state.attachedSkillImportSource || '').trim();
    if (!source || state.attachedSkillBusy) return;
    state.attachedSkillBusy = 'import';
    state.attachedSkillError = '';
    render();
    try {
      const result = await windowRef.janus.importAttachedSkillPackage({ source });
      state.attachedSkillCatalog = result.catalog || await windowRef.janus.listAttachedSkills();
      state.attachedSkillImportSource = '';
      notify(`已安装 ${(result.package?.skills || []).length} 个 Skill。`, 'success');
    } catch (error) {
      state.attachedSkillError = error.message || String(error);
      notify(`Skill 安装失败：${state.attachedSkillError}`, 'error');
    } finally {
      state.attachedSkillBusy = '';
      render();
    }
  }

  async function pickAttachedSkillSource() {
    const result = await windowRef.janus.pickAttachedSkillSource?.();
    if (!result?.canceled && result?.source) {
      state.attachedSkillImportSource = result.source;
      render();
    }
  }

  async function disableAttachedSkillPackage(packageId = '') {
    if (!packageId || state.attachedSkillBusy) return;
    if (!windowRef.confirm('停用此 Skill 包后，所有员工将不再加载其中的 Skills。是否继续？')) return;
    state.attachedSkillBusy = `disable:${packageId}`;
    render();
    try {
      const result = await windowRef.janus.disableAttachedSkillPackage({ packageId });
      state.attachedSkillCatalog = result.catalog || await windowRef.janus.listAttachedSkills();
      notify('Skill 包已停用。', 'success');
    } catch (error) {
      notify(`停用 Skill 包失败：${error.message || error}`, 'error');
    } finally {
      state.attachedSkillBusy = '';
      render();
    }
  }

  async function setAttachedSkillAssignment({ skillId = '', target = '', enabled = true } = {}) {
    if (!skillId || !target || state.attachedSkillBusy) return;
    const separator = target.indexOf(':');
    const scopeType = separator > 0 ? target.slice(0, separator) : '';
    const scopeId = separator > 0 ? target.slice(separator + 1) : '';
    state.attachedSkillBusy = `${skillId}:${target}`;
    state.attachedSkillError = '';
    render();
    try {
      const result = await windowRef.janus.assignAttachedSkill({ skillId, scopeType, scopeId, enabled });
      state.attachedSkillCatalog = result.catalog || await windowRef.janus.listAttachedSkills();
      notify(`Skill 分配已${enabled ? '启用' : '禁用'}。`, 'success');
    } catch (error) {
      state.attachedSkillError = error.message || String(error);
      notify(`Skill 分配失败：${state.attachedSkillError}`, 'error');
    } finally {
      state.attachedSkillBusy = '';
      render();
    }
  }

  async function setAttachedSkillBatch({ skillIds = [], targets = [], enabled = true } = {}) {
    if (!skillIds.length || !targets.length || state.attachedSkillBusy) return;
    state.attachedSkillBusy = 'batch';
    state.attachedSkillError = '';
    render();
    try {
      const result = await windowRef.janus.assignAttachedSkillsBatch({ skillIds, targets, enabled });
      state.attachedSkillCatalog = result.catalog || await windowRef.janus.listAttachedSkills();
      notify(`已批量${enabled ? '启用' : '禁用'} ${result.count || skillIds.length * targets.length} 项 Skill 分配。`, 'success');
    } catch (error) {
      state.attachedSkillError = error.message || String(error);
      notify(`批量分配失败：${state.attachedSkillError}`, 'error');
    } finally {
      state.attachedSkillBusy = '';
      render();
    }
  }

  async function removeAttachedSkillAssignment({ skillId = '', scopeType = '', scopeId = '' } = {}) {
    if (!skillId || !scopeType || !scopeId || state.attachedSkillBusy) return;
    state.attachedSkillBusy = `${skillId}:${scopeType}:${scopeId}`;
    render();
    try {
      const result = await windowRef.janus.unassignAttachedSkill({ skillId, scopeType, scopeId });
      state.attachedSkillCatalog = result.catalog || await windowRef.janus.listAttachedSkills();
      notify('已移除 Skill 分配。', 'success');
    } catch (error) {
      notify(`移除 Skill 分配失败：${error.message || error}`, 'error');
    } finally {
      state.attachedSkillBusy = '';
      render();
    }
  }

  async function installManagedPlugin(pluginId = '') {
    if (!pluginId || state.pluginOperations?.[pluginId]?.busy || state.busy) return;
    const plugin = pluginById(pluginId) || { id: pluginId, name: pluginId };
    const progress = { pluginId, percent: 2, stage: 'starting', message: '正在准备安装…' };
    state.pluginOperations = { ...(state.pluginOperations || {}), [pluginId]: { busy: true, progress, error: '', completed: false } };
    if (pluginId === 'ppt_creation') {
      state.pluginInstalling = true;
      state.pluginInstallProgress = progress;
    }
    state.pluginMenuOpen = false;
    state.pluginMenuOpenId = '';
    state.pluginMenuPosition = null;
    render();
    try {
      const result = windowRef.janus.installPlugin
        ? await windowRef.janus.installPlugin(pluginId)
        : pluginId === 'ppt_creation' ? await windowRef.janus.downloadPptxPlugin?.() : null;
      if (result?.canceled) return;
      applyPluginItem(pluginId, result || {});
      await refreshPluginRuntime();
      state.pluginOperations = { ...(state.pluginOperations || {}), [pluginId]: { busy: false, progress: null, error: '', completed: true } };
      notify(`${plugin.name || '技能'}已安装，可立即使用。`, 'success');
    } catch (error) {
      applyPluginItem(pluginId, { ...(plugin.status || {}), installed: false, error: error.message || String(error) });
      state.pluginOperations = { ...(state.pluginOperations || {}), [pluginId]: { busy: false, progress: null, error: error.message || String(error), completed: false } };
      notify(`安装${plugin.name || '技能'}失败：${error.message || error}`, 'error');
    } finally {
      if (pluginId === 'ppt_creation') {
        state.pluginInstalling = false;
        state.pluginInstallProgress = null;
      }
      render();
    }
  }

  async function openManagedPluginFiles(pluginId = '') {
    if (!pluginId || state.busy) return;
    const plugin = pluginById(pluginId) || { name: pluginId };
    state.pluginMenuOpen = false;
    state.pluginMenuOpenId = '';
    state.pluginMenuPosition = null;
    render();
    try {
      const result = windowRef.janus.openPluginFiles
        ? await windowRef.janus.openPluginFiles(pluginId)
        : pluginId === 'ppt_creation' ? await windowRef.janus.openPptxSkillFile?.() : null;
      if (!result?.ok) throw new Error('系统未能打开插件安装目录。');
      notify(`已打开${plugin.name || '技能'}的本地安装目录。`, 'success');
    } catch (error) {
      notify(`访问${plugin.name || '技能'}文件失败：${error.message || error}`, 'error');
    }
  }

  async function uninstallManagedPlugin(pluginId = '') {
    if (!pluginId || state.pluginOperations?.[pluginId]?.busy || state.busy) return;
    const plugin = pluginById(pluginId) || { id: pluginId, name: pluginId };
    if (!windowRef.confirm(`确认卸载${plugin.name || '此技能'}？`)) return;
    state.pluginOperations = { ...(state.pluginOperations || {}), [pluginId]: { busy: true, progress: null, error: '', completed: false } };
    if (pluginId === 'ppt_creation') state.pluginUninstalling = true;
    state.pluginMenuOpen = false;
    state.pluginMenuOpenId = '';
    state.pluginMenuPosition = null;
    render();
    try {
      const result = windowRef.janus.uninstallPlugin
        ? await windowRef.janus.uninstallPlugin(pluginId)
        : pluginId === 'ppt_creation' ? await windowRef.janus.uninstallPptxPlugin?.() : null;
      applyPluginItem(pluginId, result || {});
      await refreshPluginRuntime();
      state.pluginOperations = { ...(state.pluginOperations || {}), [pluginId]: { busy: false, progress: null, error: '', completed: false } };
      notify(`${plugin.name || '技能'}已卸载。`, 'success');
    } catch (error) {
      state.pluginOperations = { ...(state.pluginOperations || {}), [pluginId]: { busy: false, progress: null, error: error.message || String(error), completed: false } };
      notify(`卸载${plugin.name || '技能'}失败：${error.message || error}`, 'error');
    } finally {
      if (pluginId === 'ppt_creation') state.pluginUninstalling = false;
      render();
    }
  }

  async function refreshCodexPlugins() {
    if (!windowRef.janus.listCodexPlugins) return;
    state.codexPlugins = await windowRef.janus.listCodexPlugins() || state.codexPlugins;
  }

  async function installCodexPlugin(pluginId = '') {
    if (!pluginId || state.codexPluginBusy) return;
    state.codexPluginBusy = pluginId;
    state.codexPluginError = '';
    render();
    try {
      state.codexPlugins = await windowRef.janus.installCodexPlugin(pluginId);
      notify('Codex 插件已安装并通过状态验证。', 'success');
    } catch (error) {
      state.codexPluginError = error.message || String(error);
      notify(`插件安装失败：${state.codexPluginError}`, 'error');
      await refreshCodexPlugins().catch(() => {});
    } finally {
      state.codexPluginBusy = '';
      render();
    }
  }

  async function removeCodexPlugin(pluginId = '') {
    if (!pluginId || state.codexPluginBusy) return;
    if (!windowRef.confirm(`确认卸载 Codex 插件 ${pluginId}？`)) return;
    state.codexPluginBusy = pluginId;
    render();
    try {
      state.codexPlugins = await windowRef.janus.removeCodexPlugin(pluginId);
      notify('Codex 插件已卸载。', 'success');
    } catch (error) {
      notify(`插件卸载失败：${error.message || error}`, 'error');
      await refreshCodexPlugins().catch(() => {});
    } finally {
      state.codexPluginBusy = '';
      render();
    }
  }

  async function pickCodexMarketplaceSource() {
    const result = await windowRef.janus.pickCodexPluginMarketplaceSource?.();
    if (!result?.canceled && result?.source) {
      state.codexMarketplaceSource = result.source;
      render();
    }
  }

  async function addCodexMarketplace() {
    const source = String(state.codexMarketplaceSource || '').trim();
    if (!source || state.codexPluginBusy) return;
    if (!windowRef.confirm(`第三方 marketplace 可向 Codex 提供可执行能力。确认信任并添加此来源？\n\n${source}`)) return;
    state.codexPluginBusy = 'marketplace:add';
    render();
    try {
      state.codexPlugins = await windowRef.janus.addCodexPluginMarketplace({ source, confirmed: true });
      state.codexMarketplaceSource = '';
      notify('Marketplace 已添加。', 'success');
    } catch (error) {
      notify(`Marketplace 添加失败：${error.message || error}`, 'error');
    } finally {
      state.codexPluginBusy = '';
      render();
    }
  }

  async function upgradeCodexMarketplace(marketplace = '') {
    if (!marketplace || state.codexPluginBusy) return;
    state.codexPluginBusy = `marketplace:${marketplace}`;
    render();
    try {
      state.codexPlugins = await windowRef.janus.upgradeCodexPluginMarketplace(marketplace);
      notify('Marketplace 已更新。', 'success');
    } catch (error) {
      notify(`Marketplace 更新失败：${error.message || error}`, 'error');
    } finally {
      state.codexPluginBusy = '';
      render();
    }
  }

  async function removeCodexMarketplace(marketplace = '') {
    if (!marketplace || state.codexPluginBusy) return;
    if (!windowRef.confirm(`确认移除 marketplace ${marketplace}？已安装插件必须先卸载。`)) return;
    state.codexPluginBusy = `marketplace:${marketplace}`;
    render();
    try {
      state.codexPlugins = await windowRef.janus.removeCodexPluginMarketplace(marketplace);
      notify('Marketplace 已移除。', 'success');
    } catch (error) {
      notify(`Marketplace 移除失败：${error.message || error}`, 'error');
    } finally {
      state.codexPluginBusy = '';
      render();
    }
  }

  const loadPptxPluginStatus = loadPluginCatalog;
  const downloadPptxPlugin = () => installManagedPlugin('ppt_creation');
  const openPptxSkillFile = () => openManagedPluginFiles('ppt_creation');
  const uninstallPptxPlugin = () => uninstallManagedPlugin('ppt_creation');

  return {
    refreshReleaseStatus,
    checkAllUpdates,
    handleAccountUpdateClick,
    downloadUpdate,
    installUpdate,
    loadPluginCatalog,
    installManagedPlugin,
    openManagedPluginFiles,
    uninstallManagedPlugin,
    importAttachedSkill,
    pickAttachedSkillSource,
    disableAttachedSkillPackage,
    setAttachedSkillAssignment,
    setAttachedSkillBatch,
    removeAttachedSkillAssignment,
    refreshCodexPlugins,
    installCodexPlugin,
    removeCodexPlugin,
    pickCodexMarketplaceSource,
    addCodexMarketplace,
    upgradeCodexMarketplace,
    removeCodexMarketplace,
    loadPptxPluginStatus,
    downloadPptxPlugin,
    openPptxSkillFile,
    uninstallPptxPlugin,
  };
}
