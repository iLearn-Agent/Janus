export function createCollaborationController({
  api,
  state,
  render,
  renderPreservingNetworkComposer,
  userErrorMessage,
  notify,
  preserveChatDraftFromInput,
  restoreComposerDraft = () => {},
  scrollMessagesToBottom,
  documentRef,
  windowRef,
  noteDirectoryGroups,
}) {
  let collaborationGroupLoadSequence = 0;
  async function refreshSocialInbox(renderAfter = true) {
    if (!state.currentUser || !api.socialInbox) return;
    const workspaceGeneration = state.workspaceSwitchGeneration;
    const workspaceId = state.activeAccountWorkspace?.id || 'workspace_personal';
    try {
      const nextInbox = await api.socialInbox();
      if (workspaceGeneration !== state.workspaceSwitchGeneration
        || workspaceId !== (state.activeAccountWorkspace?.id || 'workspace_personal')) return;
      state.socialInbox = nextInbox;
      if (renderAfter) render();
    } catch (error) {
      notify(`\u5237\u65b0\u597d\u53cb\u6d88\u606f\u5931\u8d25\uff1a${error.message || error}`, 'error');
    }
  }

  async function refreshSocialThreads(renderAfter = true) {
    if (!state.currentUser || !api.socialConversation) return;
    const workspaceGeneration = state.workspaceSwitchGeneration;
    const workspaceId = state.activeAccountWorkspace?.id || 'workspace_personal';
    try {
      if (typeof api.socialConversationSummaries === 'function') {
        const result = await api.socialConversationSummaries({ messagesPerThread: 100, limit: 100 });
        if (workspaceGeneration !== state.workspaceSwitchGeneration
          || workspaceId !== (state.activeAccountWorkspace?.id || 'workspace_personal')) return;
        state.socialThreads = Array.isArray(result?.threads) ? result.threads : [];
        if (renderAfter) renderPreservingNetworkComposer();
        return;
      }
      const relationships = [...(state.friendOverview?.friends || [])];
      if (state.currentUser?.id && !relationships.some((item) => item?.friend?.id === state.currentUser.id)) {
        relationships.push({
          friend: {
            ...state.currentUser,
            remark: '',
          },
          self: true,
        });
      }
      const threads = await Promise.all(relationships.map(async (relationship) => {
        const friend = relationship.friend || {};
        if (!friend.id) return null;
        const messages = await api.socialConversation({ peerId: friend.id });
        if (!messages?.length) return null;
        return { friend, messages };
      }));
      if (workspaceGeneration !== state.workspaceSwitchGeneration
        || workspaceId !== (state.activeAccountWorkspace?.id || 'workspace_personal')) return;
      state.socialThreads = threads.filter(Boolean);
      if (renderAfter) renderPreservingNetworkComposer();
    } catch (error) {
      if (renderAfter) notify(`刷新聊天记录失败：${error.message || error}`, 'error');
    }
  }

  async function refreshAgentDelegations(renderAfter = true) {
    if (!state.currentUser || !api.listAgentDelegations) return;
    const workspaceGeneration = state.workspaceSwitchGeneration;
    const workspaceId = state.activeAccountWorkspace?.id || 'workspace_personal';
    try {
      const nextDelegations = await api.listAgentDelegations({ direction: 'all' });
      if (workspaceGeneration !== state.workspaceSwitchGeneration
        || workspaceId !== (state.activeAccountWorkspace?.id || 'workspace_personal')) return;
      state.agentDelegations = nextDelegations;
      if (renderAfter) render();
    } catch (error) {
      notify(`\u5237\u65b0\u79d8\u4e66\u59d4\u6258\u5931\u8d25\uff1a${error.message || error}`, 'error');
    }
  }

  async function refreshCollaborationOverview(renderAfter = true) {
    if (!state.currentUser || !api.collaborationOverview) return;
    const workspaceGeneration = state.workspaceSwitchGeneration;
    const workspaceId = state.activeAccountWorkspace?.id || 'workspace_personal';
    try {
      const nextOverview = await api.collaborationOverview() || { groups: [], tasks: [] };
      if (workspaceGeneration !== state.workspaceSwitchGeneration
        || workspaceId !== (state.activeAccountWorkspace?.id || 'workspace_personal')) return;
      noteDirectoryGroups?.(nextOverview);
      state.collaborationOverview = nextOverview;
      if (state.collaborationOverview.tasks?.length) state.agentDelegations = state.collaborationOverview.tasks;
      if (renderAfter) renderPreservingNetworkComposer();
    } catch (error) {
      if (renderAfter) notify(`刷新任务群失败：${userErrorMessage(error)}`, 'error');
    }
  }

  function collaborationGroupRequest(groupId = '') {
    const id = String(groupId || '').trim();
    const group = (state.collaborationOverview?.groups || []).find((item) => String(item?.id || '') === id) || {};
    return {
      groupId: id,
      workspaceId: group.workspaceId || group.accountWorkspaceId || state.activeAccountWorkspace?.id || 'workspace_personal',
      localHistoryOnly: group.localHistoryOnly === true || group.metadata?.localHistoryOnly === true,
    };
  }

  async function refreshCollaborationGroupDetail(groupId = state.collaborationGroupId, renderAfter = true) {
    const id = String(groupId || '').trim();
    if (!id || !api.collaborationGroup) return null;
    const previousDetail = state.collaborationGroupDetail;
    const loadSequence = ++collaborationGroupLoadSequence;
    try {
      const nextDetail = await api.collaborationGroup(collaborationGroupRequest(id));
      if (
        loadSequence !== collaborationGroupLoadSequence
        || String(state.collaborationGroupId || '') !== id
        || state.collaborationGroupDetail !== previousDetail
      ) return null;
      if (nextDetail && typeof nextDetail === 'object') {
        state.collaborationGroupDetail = nextDetail;
        state.collaborationGroupWorkspace = { ...(nextDetail.workspace || {}), ...(state.collaborationGroupWorkspace || {}) };
      }
      return state.collaborationGroupDetail;
    } catch {
      // A background refresh must never blank an already visible group conversation.
      return null;
    } finally {
      if (
        renderAfter
        && loadSequence === collaborationGroupLoadSequence
        && String(state.collaborationGroupId || '') === id
      ) renderPreservingNetworkComposer();
    }
  }

  async function openCollaborationGroup(groupId = '') {
    const id = String(groupId || '').trim();
    if (!id) return;
    preserveChatDraftFromInput();
    state.currentTab = 'chat';
    // Keep the message list visible beside the selected task-group chat,
    // matching the uBuddy/private-chat workspace layout.
    state.networkPanelOpen = true;
    state.networkPanelView = 'messages';
    state.networkMessageHomeOpen = false;
    state.messageActivePane = 'conversation';
    state.networkConversationPeerId = '';
    state.networkConversationGroupId = '';
    state.networkDelegationId = '';
    state.collaborationGroupId = id;
    state.collaborationGroupDetail = null;
    state.chatGroupId = '';
    state.chatGroupDetail = null;
    state.collaborationGroupWorkspace = null;
    state.collaborationGroupWorkspaceBusy = false;
    state.collaborationAddMemberOpen = false;
    state.collaborationAddMemberUserId = '';
    state.collaborationAddMemberAssignment = '';
    state.collaborationRoutingConfirmation = null;
    state.collaborationPaneByGroupId = { ...(state.collaborationPaneByGroupId || {}), [id]: 'group' };
    state.collaborationMobilePaneByGroupId = { ...(state.collaborationMobilePaneByGroupId || {}), [id]: 'group' };
    state.collaborationSearchOpen = false;
    state.collaborationSearchQuery = '';
    state.collaborationSearchActiveIndex = 0;
    state.collaborationMembersOpen = false;
    state.networkConversationBusy = true;
    state.messages = [];
    state.currentSessionId = '';
    state.currentChatKey = `collaboration:${id}`;
    state.currentAgentInstanceId = '';
    state.contextUsage = null;
    state.homeMode = 'department';
    restoreComposerDraft(`collaboration:${id}`, {
      fallbackText: state.networkConversationDrafts?.[`collaboration:${id}`] || '',
    });
    state.collaborationOverview = {
      ...(state.collaborationOverview || {}),
      groups: (state.collaborationOverview?.groups || []).map((group) => (
        String(group?.id || '') === id ? { ...group, unreadCount: 0 } : group
      )),
    };
    const loadSequence = ++collaborationGroupLoadSequence;
    render();
    try {
      const nextDetail = await api.collaborationGroup(collaborationGroupRequest(id));
      if (loadSequence !== collaborationGroupLoadSequence || state.collaborationGroupId !== id) return;
      state.collaborationGroupDetail = nextDetail;
      state.collaborationGroupWorkspace = nextDetail?.workspace || null;
      await refreshCollaborationOverview(false);
    } catch (error) {
      if (loadSequence !== collaborationGroupLoadSequence || state.collaborationGroupId !== id) return;
      state.collaborationGroupId = '';
      state.collaborationGroupDetail = null;
      state.collaborationGroupWorkspace = null;
      state.networkPanelOpen = true;
      state.networkPanelView = 'messages';
      state.networkMessageHomeOpen = true;
      state.messageActivePane = 'list';
      state.networkConversationBusy = false;
      notify(`打开任务群失败：${userErrorMessage(error)}`, 'error');
      render();
    } finally {
      if (loadSequence === collaborationGroupLoadSequence && state.collaborationGroupId === id) {
        state.networkConversationBusy = false;
        render();
        scrollMessagesToBottom({ force: true });
      }
    }
  }

  async function openCollaborationGroupWorkspace() {
    const groupId = String(state.collaborationGroupId || '').trim();
    if (!groupId || !api.collaborationGroupWorkspace || state.collaborationGroupWorkspaceBusy) return;
    state.collaborationGroupWorkspaceBusy = true;
    render();
    try {
      const readOnly = state.collaborationGroupDetail?.group?.status === 'closed' || state.collaborationGroupDetail?.workspace?.readOnly;
      const workspace = await api.collaborationGroupWorkspace({ groupId, mode: readOnly ? 'pull' : 'both' });
      state.collaborationGroupWorkspace = { ...(state.collaborationGroupDetail?.workspace || {}), ...(workspace || {}) };
      const workspaceRoot = String(workspace?.workspaceRoot || '').trim();
      if (!workspaceRoot) throw new Error('共享工作区目录不可用。');
      const error = await api.openPath(workspaceRoot);
      if (error) throw new Error(error);
      if (workspace?.syncStatus === 'conflict') notify('共享工作区存在冲突副本，请检查后再继续修改。', 'warning');
    } catch (error) {
      notify(`打开共享工作区失败：${userErrorMessage(error)}`, 'error');
    } finally {
      state.collaborationGroupWorkspaceBusy = false;
      render();
    }
  }

  async function closeCollaborationGroup() {
    const groupId = state.collaborationGroupId;
    const withdrawableStatuses = new Set([
      'assigned', 'preparing', 'awaiting_approval', 'accepted', 'running', 'working',
      'draft_ready', 'submitted', 'revision_requested', 'blocked', 'failed',
    ]);
    const openTasks = (state.collaborationGroupDetail?.tasks || [])
      .filter((task) => withdrawableStatuses.has(String(task.status || '')));
    const warning = openTasks.length
      ? `将停止 ${openTasks.length} 项未完成任务，并把工作群归档为只读。已完成内容会保留，确定继续吗？`
      : '所有任务均已结束。工作群归档后将变为只读，确定继续吗？';
    if (!groupId || !windowRef.confirm(warning)) return;
    try {
      state.collaborationGroupDetail = await api.updateCollaborationGroup({ groupId, action: 'close' });
      await refreshCollaborationOverview(false);
      const stopped = Number(state.collaborationGroupDetail?.terminationSummary?.withdrawnCount || 0);
      notify(stopped ? `已停止 ${stopped} 项任务并归档工作群。` : '工作群已归档。', 'success');
    } catch (error) {
      notify(`结束工作群失败：${userErrorMessage(error)}`, 'error');
    } finally {
      render();
    }
  }

  function renameCollaborationGroup() {
    const group = state.collaborationGroupDetail?.group || {};
    const groupId = String(state.collaborationGroupId || group.id || '').trim();
    if (!groupId || group.ownerUserId !== state.currentUser?.id || group.status === 'closed') return;
    state.socialEditDialog = {
      type: 'collaboration-group-rename',
      targetId: groupId,
      subtitle: '仅群主可以修改群聊名称',
      draft: group.title || 'uBuddy 任务群',
    };
    render();
    requestAnimationFrame(() => documentRef.getElementById('social-edit-input')?.select());
  }

  async function saveCollaborationGroupName(groupId, value = '') {
    const group = state.collaborationGroupDetail?.group || {};
    if (!groupId || group.id !== groupId || group.ownerUserId !== state.currentUser?.id || group.status === 'closed') return;
    const nextTitle = String(value || '').trim();
    if (!nextTitle) {
      notify('群聊名称不能为空。', 'warning');
      return;
    }
    if (nextTitle === group.title) {
      state.socialEditDialog = null;
      render();
      return;
    }
    if (nextTitle.length > 80) {
      notify('群聊名称不能超过 80 个字符。', 'warning');
      return;
    }
    try {
      state.collaborationGroupDetail = await api.updateCollaborationGroup({ groupId, action: 'rename', title: nextTitle });
      state.socialEditDialog = null;
      await refreshCollaborationOverview(false);
      notify('群聊名称已修改。', 'success');
    } catch (error) {
      notify(`修改群名失败：${userErrorMessage(error)}`, 'error');
    } finally {
      render();
    }
  }

  async function addCollaborationGroupMember() {
    if (!state.collaborationGroupId) return;
    const memberIds = new Set((state.collaborationGroupDetail?.members || []).filter((item) => item.status === 'active').map((item) => item.userId));
    const firstCandidate = (state.friendOverview?.friends || []).map((item) => item.friend || {}).find((friend) => friend.id && !memberIds.has(friend.id));
    state.collaborationAddMemberOpen = !state.collaborationAddMemberOpen;
    state.collaborationAddMemberUserId = state.collaborationAddMemberOpen ? (state.collaborationAddMemberUserId || firstCandidate?.id || '') : '';
    if (!state.collaborationAddMemberOpen) state.collaborationAddMemberAssignment = '';
    render();
  }

  function closeCollaborationAddMemberPanel() {
    state.collaborationAddMemberOpen = false;
    state.collaborationAddMemberUserId = '';
    state.collaborationAddMemberAssignment = '';
    render();
  }

  async function confirmCollaborationGroupMember() {
    const groupId = state.collaborationGroupId;
    const selected = documentRef.querySelector('[data-collaboration-add-member-user]:checked')?.value || state.collaborationAddMemberUserId || '';
    const assignment = String(documentRef.getElementById('collaboration-add-member-assignment')?.value || state.collaborationAddMemberAssignment || '').trim();
    if (!groupId || !selected) {
      notify('请先选择要添加的好友。', 'warning');
      return;
    }
    if (!assignment) {
      notify('请填写交给对方 uBuddy 的任务说明。', 'warning');
      return;
    }
    try {
      state.collaborationGroupDetail = await api.updateCollaborationGroup({
        groupId,
        action: 'add_member',
        userId: selected,
        assignment: {
          title: `${state.collaborationGroupDetail?.group?.title || 'uBuddy 任务群'} · 新成员任务`,
          instruction: assignment,
        },
      });
      state.collaborationAddMemberOpen = false;
      state.collaborationAddMemberUserId = '';
      state.collaborationAddMemberAssignment = '';
      await refreshCollaborationOverview(false);
      notify('成员及其 uBuddy 已加入任务群，任务说明已派发。', 'success');
    } catch (error) {
      notify(`添加成员失败：${userErrorMessage(error)}`, 'error');
    } finally {
      render();
    }
  }

  async function removeCollaborationGroupMember(userId = '') {
    const groupId = state.collaborationGroupId;
    if (!groupId || !userId || !windowRef.confirm('移除后，该成员将无法查看新消息，其未完成任务会被撤回。确定继续吗？')) return;
    try {
      state.collaborationGroupDetail = await api.updateCollaborationGroup({ groupId, action: 'remove_member', userId });
      await refreshCollaborationOverview(false);
      notify('成员已移除，历史记录仍保留用于审计。', 'success');
    } catch (error) {
      notify(`移除成员失败：${userErrorMessage(error)}`, 'error');
    } finally {
      render();
    }
  }

  function setCollaborationTaskActionBusy(delegationId = '', action = '') {
    const id = String(delegationId || '').trim();
    if (!id) return;
    const current = state.collaborationTaskActionBusyById || {};
    if (action) state.collaborationTaskActionBusyById = { ...current, [id]: action };
    else {
      const next = { ...current };
      delete next[id];
      state.collaborationTaskActionBusyById = next;
    }
  }

  function applyCollaborationTaskActionResult(delegation = null) {
    const id = String(delegation?.id || '').trim();
    if (!id) return;
    const replace = (items = []) => (Array.isArray(items)
      ? items.map((item) => String(item?.id || '') === id ? delegation : item)
      : items);
    state.agentDelegations = replace(state.agentDelegations);
    state.collaborationOverview = {
      ...(state.collaborationOverview || {}),
      tasks: replace(state.collaborationOverview?.tasks || []),
    };
    if (state.collaborationGroupDetail) {
      state.collaborationGroupDetail = {
        ...state.collaborationGroupDetail,
        tasks: replace(state.collaborationGroupDetail.tasks || []),
      };
    }
  }

  async function reconcileCollaborationTaskAction(delegationId = '') {
    await refreshCollaborationOverview(false);
    const groupId = String(state.collaborationGroupId || '').trim();
    if (groupId) await refreshCollaborationGroupDetail(groupId, false);
    renderPreservingNetworkComposer();
    return (state.collaborationOverview?.tasks || []).find((item) => String(item?.id || '') === String(delegationId || '')) || null;
  }

  async function handleCollaborationTaskAction(delegationId = '', action = '') {
    if (!delegationId || !action) return;
    if (state.collaborationTaskActionBusyById?.[delegationId]) return;
    let content = '';
    if (action === 'request_revision') {
      content = String(windowRef.prompt('请填写需要修改的方向') || '').trim();
      if (!content) return;
    }
    if (action === 'withdraw') {
      const task = (state.collaborationGroupDetail?.tasks || []).find((item) => String(item.id || '') === String(delegationId));
      const label = task?.status === 'failed' ? '撤回并归档这项失败任务' : '停止这项任务';
      if (!windowRef.confirm(`${label}？已完成内容会保留，未完成步骤不会继续。`)) return;
      content = '发起人已停止这项任务。';
    }
    setCollaborationTaskActionBusy(delegationId, action);
    render();
    let actionResult = null;
    try {
      actionResult = await api.collaborationTaskAction({ delegationId, action, content });
    } catch (error) {
      if (action === 'accept_result') {
        const authoritative = await reconcileCollaborationTaskAction(delegationId);
        if (String(authoritative?.status || '') === 'result_accepted') {
          actionResult = { ok: true, idempotent: true, delegation: authoritative };
        }
      }
      if (!actionResult) {
        setCollaborationTaskActionBusy(delegationId, '');
        render();
        notify(`更新任务失败：${userErrorMessage(error)}`, 'error');
        return;
      }
    }
    applyCollaborationTaskActionResult(actionResult?.delegation);
    setCollaborationTaskActionBusy(delegationId, '');
    render();
    notify(action === 'accept_result'
      ? (actionResult?.idempotent ? '任务已经确认结束。' : '已确认任务结束。')
      : action === 'withdraw' ? '停止指令已发送，任务已撤回。'
        : '重做要求已同步到对方任务工作区。', 'success');
    await reconcileCollaborationTaskAction(delegationId);
  }


    return {
    refreshSocialInbox,
    refreshSocialThreads,
    refreshAgentDelegations,
    refreshCollaborationOverview,
    refreshCollaborationGroupDetail,
    openCollaborationGroup,
    openCollaborationGroupWorkspace,
    closeCollaborationGroup,
    renameCollaborationGroup,
    saveCollaborationGroupName,
    addCollaborationGroupMember,
    closeCollaborationAddMemberPanel,
    confirmCollaborationGroupMember,
    removeCollaborationGroupMember,
    handleCollaborationTaskAction,
  };
}

function mergePublishedDelegations(existing = [], published = []) {
  const merged = new Map((Array.isArray(existing) ? existing : []).filter((task) => task?.id).map((task) => [task.id, task]));
  for (const task of Array.isArray(published) ? published : []) {
    if (!task?.id) continue;
    const previous = merged.get(task.id) || {};
    merged.set(task.id, {
      ...previous,
      ...task,
      metadata: { ...(previous.metadata || {}), ...(task.metadata || {}) },
    });
  }
  return [...merged.values()];
}

function mergePublishedMessages(existing = [], published = []) {
  const merged = new Map((Array.isArray(existing) ? existing : []).filter((message) => message?.id).map((message) => [message.id, message]));
  for (const message of Array.isArray(published) ? published : []) {
    if (!message?.id) continue;
    const previous = merged.get(message.id) || {};
    merged.set(message.id, {
      ...previous,
      ...message,
      metadata: { ...(previous.metadata || {}), ...(message.metadata || {}) },
    });
  }
  return [...merged.values()];
}
