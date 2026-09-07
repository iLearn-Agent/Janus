export function createProjectComposerController({
  api,
  state,
  notify,
  render,
  normalizePathKey,
  pathBasename,
  saveSandboxPermission,
  focusChatInputAtEnd,
  currentChatRun,
  isUBuddyComposerMode,
  preserveChatDraftFromInput,
  upsertRecentSession,
  projectById,
}) {
  async function attachProjectToCurrentChat(project = {}, successMessage = '') {
    if (!project?.id) return false;
    if (state.busy || currentChatRun()) {
      notify('当前对话仍在运行，结束后再选择项目。', 'warning');
      return false;
    }
    preserveChatDraftFromInput();
    const previous = {
      activeProjectId: state.activeProjectId,
      workspaceRoot: state.workspaceRoot,
      workspaceDetached: state.workspaceDetached,
      expandedProjectIds: [...(state.expandedProjectIds || [])],
      composerFileReferences: [...(state.composerFileReferences || [])],
    };
    const currentSessionId = state.currentSessionId;
    const workspaceRoot = project.workspaceRoot || project.workspace_root || '';
    state.workspaceMenuOpen = false;
    state.workspaceCreateMenuOpen = false;
    state.workspaceDetached = false;
    state.activeProjectId = project.id;
    state.workspaceRoot = workspaceRoot;
    if (previous.activeProjectId && previous.activeProjectId !== project.id && (state.composerFileReferences || []).length) {
      state.composerFileReferences = [];
      notify('项目已切换，未发送的旧项目文件引用已失效。', 'warning');
    }
    if (!(state.expandedProjectIds || []).includes(project.id)) {
      state.expandedProjectIds = [...(state.expandedProjectIds || []), project.id];
    }
    state.sandboxPermission = 'request-approval';
    saveSandboxPermission(state.sandboxPermission);
    render();
    focusChatInputAtEnd();
    try {
      if (currentSessionId) {
        const updated = await api.updateSession({
          sessionId: currentSessionId,
          projectId: project.id,
          workspaceRoot,
        });
        upsertRecentSession({
          ...(updated || {}),
          id: updated?.id || currentSessionId,
          projectId: project.id,
          workspaceRoot,
        });
        render();
        focusChatInputAtEnd();
      }
      if (successMessage) notify(successMessage, 'success');
      return true;
    } catch (error) {
      state.activeProjectId = previous.activeProjectId;
      state.workspaceRoot = previous.workspaceRoot;
      state.workspaceDetached = previous.workspaceDetached;
      state.expandedProjectIds = previous.expandedProjectIds;
      state.composerFileReferences = previous.composerFileReferences;
      notify(`选择项目失败：${error.message || error}`, 'error');
      render();
      focusChatInputAtEnd();
      return false;
    }
  }

  async function selectWorkspaceDirectory() {
    if (state.busy) {
      notify('当前对话仍在运行，结束后再选择项目。', 'warning');
      return null;
    }
    if (!api.selectWorkspace) {
      notify('当前版本不支持选择项目。', 'warning');
      return null;
    }
    try {
      const result = await api.selectWorkspace();
      if (result?.canceled) return null;
      const workspaceRoot = result.workspaceRoot || result.workspace_root || result.root || '';
      state.pendingWorkspaceRoot = '';
      state.projects = await api.listProjects();
      let project = state.projects.find((item) => (
        normalizePathKey(item.workspaceRoot || item.workspace_root) === normalizePathKey(workspaceRoot)
      ));
      const reusedProject = Boolean(project);
      if (!project) {
        project = await api.createProject({
          workspaceRoot,
          title: pathBasename(workspaceRoot),
        });
        state.projects = await api.listProjects();
      }
      const attached = await attachProjectToCurrentChat(
        project,
        reusedProject ? `已选择项目：${project.title || pathBasename(workspaceRoot)}` : `已创建并选择项目：${project.title || pathBasename(workspaceRoot)}`,
      );
      return attached ? project : null;
    } catch (error) {
      notify(`选择项目失败：${error.message || error}`, 'error');
      return null;
    }
  }

  async function setComposerInteractionMode(requestedMode = '') {
    const cleanMode = ['goal', 'plan'].includes(requestedMode) ? requestedMode : '';
    const nextMode = cleanMode && state.interactionMode === cleanMode ? '' : cleanMode;
    const previousMode = state.interactionMode;
    if (state.busy || currentChatRun()) {
      notify('当前对话仍在运行，结束后再切换模式。', 'warning');
      return;
    }
    const uBuddyComposer = isUBuddyComposerMode();
    const unsupportedSurface = state.homeMode === 'image' || state.composerImageMode
      || state.homeMode === 'collaboration' || uBuddyComposer;
    if (nextMode && unsupportedSurface) {
      state.composerToolMenuOpen = false;
      notify('目标和计划模式目前用于项目中的普通或专业 Agent 对话。', 'warning');
      render();
      return;
    }
    preserveChatDraftFromInput();
    state.interactionMode = nextMode;
    const resetsGoal = previousMode === 'goal' || nextMode === 'goal';
    state.composerToolMenuOpen = false;
    if (nextMode) {
      state.sandboxPermission = 'request-approval';
      saveSandboxPermission(state.sandboxPermission);
    }
    if (state.currentSessionId) {
      try {
        const updated = await api.updateSession({
          sessionId: state.currentSessionId,
          interactionMode: nextMode,
          ...(resetsGoal ? { goal: null } : {}),
        });
        if (updated?.id) upsertRecentSession(updated);
      } catch (error) {
        state.interactionMode = previousMode;
        notify(`切换模式失败：${error.message || error}`, 'error');
        render();
        return;
      }
    }
    render();
    focusChatInputAtEnd();
  }

  async function selectWorkspaceProject(projectId = '') {
    const project = projectById(projectId);
    if (!project) return;
    await attachProjectToCurrentChat(project, `已选择项目：${project.title || pathBasename(project.workspaceRoot || project.workspace_root || '')}`);
  }

  async function clearWorkspaceSelection() {
    const clearsGoal = state.interactionMode === 'goal';
    state.workspaceMenuOpen = false;
    state.composerToolMenuOpen = false;
    state.workspaceDetached = true;
    state.workspaceRoot = '';
    state.activeProjectId = '';
    state.interactionMode = '';
    if ((state.composerFileReferences || []).length) {
      state.composerFileReferences = [];
      notify('已移出项目，未发送的项目文件引用已失效。', 'warning');
    }
    if (state.currentSessionId) {
      try {
        const updated = await api.updateSession({
          sessionId: state.currentSessionId,
          projectId: '',
          workspaceRoot: '',
          interactionMode: '',
          ...(clearsGoal ? { goal: null } : {}),
        });
        if (updated?.id) upsertRecentSession(updated);
      } catch (error) {
        notify(`移出项目失败：${error.message || error}`, 'error');
        return;
      }
    }
    render();
    focusChatInputAtEnd();
  }

  async function removeWorkspaceProject(projectId = '') {
    const project = projectById(projectId);
    if (!project) return;
    if (state.busy || currentChatRun()) {
      notify('当前对话仍在运行，结束后再移出项目。', 'warning');
      return;
    }
    preserveChatDraftFromInput();
    const currentSession = (state.sessions || []).find((item) => item.id === state.currentSessionId);
    const removesCurrentSelection = state.activeProjectId === projectId || currentSession?.projectId === projectId;
    try {
      await api.updateProject({ projectId, action: 'remove' });
      state.projects = await api.listProjects();
      state.sessions = await api.listSessions();
      state.expandedProjectIds = (state.expandedProjectIds || []).filter((id) => id !== projectId);
      state.workspaceMenuOpen = false;
      state.workspaceCreateMenuOpen = false;
      if (removesCurrentSelection) {
        state.workspaceDetached = true;
        state.activeProjectId = '';
        state.workspaceRoot = '';
        state.pendingWorkspaceRoot = '';
        state.interactionMode = '';
        state.composerFileReferences = [];
        const refreshedSession = (state.sessions || []).find((item) => item.id === state.currentSessionId);
        if (refreshedSession?.id) upsertRecentSession(refreshedSession);
      }
      notify('项目已从工作区移出；聊天记录和本地文件均已保留。', 'success');
      render();
      focusChatInputAtEnd();
    } catch (error) {
      notify(`移出项目失败：${error.message || error}`, 'error');
      render();
    }
  }

  return {
    clearWorkspaceSelection,
    removeWorkspaceProject,
    selectWorkspaceDirectory,
    selectWorkspaceProject,
    setComposerInteractionMode,
  };
}
