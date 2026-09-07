import { parseOrganizationInviteLink } from '../../../../shared/organizationInvites.js';

export function createFriendsController({
  api,
  state,
  render,
  notify,
  userErrorMessage,
  refreshSocialInbox,
  refreshSocialThreads,
  refreshAgentDelegations,
  openNetworkConversation,
  activateOrganizationWorkspace = async () => ({ switched: false, defaultSaved: false }),
  windowRef,
  documentRef,
}) {
  async function refreshFriends() {
    if (!state.currentUser) return;
    try {
      state.friendOverview = await api.friendsOverview();
      state.friendDirectoryError = '';
      await refreshSocialInbox(false);
      await refreshAgentDelegations(false);
      await refreshSocialThreads(false);
      render();
    } catch (error) {
      state.friendDirectoryError = userErrorMessage(error);
      notify(`\u5237\u65b0\u597d\u53cb\u5931\u8d25\uff1a${error.message || error}`, 'error');
      render();
    }
  }

  function showFriendDirectoryView(view = 'contacts') {
    state.friendDirectoryView = view === 'requests' ? 'requests' : 'contacts';
    state.friendDirectoryCategory = state.friendDirectoryView === 'requests' ? 'new' : (state.friendDirectoryCategory || 'internal');
    state.contactsActivePane = 'contacts';
    state.networkContactProfileOpen = false;
    state.networkGroupProfileOpen = false;
    state.networkSelectedGroupKind = '';
    state.networkSelectedGroupId = '';
    state.groupDirectoryProfileDetail = null;
    state.friendSearchQuery = '';
    state.contactDirectoryContextMenu = null;
    render();
  }

  function showFriendDirectoryCategory(category = 'internal') {
    const nextCategory = ['internal', 'external', 'new', 'starred', 'groups', 'organizations'].includes(category) ? category : 'internal';
    state.friendDirectoryCategory = nextCategory;
    state.contactsSelectedOrganizationId = '';
    state.friendDirectoryView = nextCategory === 'new' ? 'requests' : 'contacts';
    state.contactsActivePane = 'contacts';
    state.networkContactProfileOpen = false;
    state.networkGroupProfileOpen = false;
    state.networkSelectedGroupKind = '';
    state.networkSelectedGroupId = '';
    state.groupDirectoryProfileDetail = null;
    state.friendSearchQuery = '';
    state.contactDirectoryContextMenu = null;
    render();
  }

  function handleAddFriendClick() {
    openContactAddDialog('contact');
  }

  function clearFriendSearch({ focus = true } = {}) {
    state.friendSearchQuery = '';
    render();
    if (focus) {
      windowRef.requestAnimationFrame(() => documentRef.getElementById('friend-search-query')?.focus());
    }
  }

  function openContactAddDialog(tab = 'contact', { targetUserId = '' } = {}) {
    state.contactAddDialogOpen = true;
    state.contactAddDialogTab = ['contact', 'join-organization', 'create-organization'].includes(tab) ? tab : 'contact';
    if (state.contactAddDialogTab === 'contact' && targetUserId) {
      state.friendAddSearchQuery = contactSearchValue(targetUserId);
      state.friendSearchResults = [];
      state.friendSearchResultQuery = '';
      state.friendRequestTargetId = '';
      state.friendRequestMessage = '';
    }
    state.contactDirectoryContextMenu = null;
    state.networkContactProfileOpen = false;
    state.networkGroupProfileOpen = false;
    state.networkSelectedGroupKind = '';
    state.networkSelectedGroupId = '';
    state.groupDirectoryProfileDetail = null;
    render();
    windowRef.requestAnimationFrame(() => focusContactAddDialog(tab));
  }

  function switchContactAddDialogTab(tab = 'contact') {
    openContactAddDialog(tab);
  }

  function closeContactAddDialog({ focusDirectory = false } = {}) {
    state.contactAddDialogOpen = false;
    state.contactAddBusy = '';
    state.friendAddSearchQuery = '';
    state.friendSearchResults = [];
    state.friendSearchResultQuery = '';
    state.friendRequestTargetId = '';
    state.friendRequestMessage = '';
    state.organizationJoinDraft = { organizationNumber: '', verificationCode: '', shareLink: '', setAsDefault: true };
    state.organizationCreateDraft = { name: '', organizationNumber: '', verificationCode: '' };
    render();
    if (focusDirectory) windowRef.requestAnimationFrame(() => documentRef.getElementById('friend-search-query')?.focus());
  }

  function focusContactAddDialog(tab = state.contactAddDialogTab) {
    const selector = tab === 'join-organization'
      ? '#organization-join-number'
      : tab === 'create-organization'
        ? '#organization-create-name'
        : '#friend-add-search-query';
    documentRef.querySelector(selector)?.focus();
  }

  function friendNameById(userId = '') {
    const relationship = (state.friendOverview?.friends || []).find((item) => item.friend?.id === userId);
    const friend = relationship?.friend ||
      (state.friendSearchResults || []).find((item) => item.id === userId) || null;
    return relationship?.remark || friend?.remark || friend?.displayName || friend?.display_name || friend?.username || friend?.email || userId;
  }

  function contactSearchValue(userId = '') {
    const cleanUserId = String(userId || '').trim();
    const relationship = (state.friendOverview?.friends || [])
      .find((item) => String(item?.friend?.id || item?.user?.id || '') === cleanUserId);
    const organizationMember = (state.friendOverview?.organizations || [])
      .flatMap((organization) => organization?.members || [])
      .find((item) => String(item?.user?.id || item?.id || '') === cleanUserId);
    const user = relationship?.friend || relationship?.user || organizationMember?.user || organizationMember || {};
    return String(user.email || user.username || user.id || cleanUserId).trim();
  }

  async function createAgentDelegationForFriend(userId = '') {
    const recipientId = String(userId || '').trim();
    if (!recipientId || state.busy) return;
    const friendName = friendNameById(recipientId);
    const title = window.prompt(`\u59d4\u6258\u7ed9 ${friendName} \u7684\u79d8\u4e66 Agent\uff1a\u4efb\u52a1\u6807\u9898`, '');
    if (title === null) return;
    const instruction = window.prompt('\u8bf7\u8f93\u5165\u8981\u8ba9\u5bf9\u65b9\u79d8\u4e66 Agent \u5904\u7406\u7684\u4efb\u52a1\u5185\u5bb9', '');
    if (instruction === null) return;
    if (!String(instruction || '').trim()) {
      notify('\u4efb\u52a1\u5185\u5bb9\u4e0d\u80fd\u4e3a\u7a7a\u3002', 'warning');
      return;
    }
    try {
      const result = await api.createAgentDelegation({
        recipientId,
        title,
        instruction,
        senderAgentId: 'secretary_agent',
        recipientAgentId: 'secretary_agent',
      });
      state.agentDelegations = result?.delegations || await api.listAgentDelegations({ direction: 'all' });
      await refreshSocialInbox(false);
      state.networkPanelOpen = true;
      state.networkPanelView = 'messages';
      notify('\u5df2\u7531\u4f60\u7684\u79d8\u4e66 Agent \u5411\u5bf9\u65b9\u79d8\u4e66 Agent \u53d1\u51fa\u59d4\u6258\u3002', 'success');
      render();
    } catch (error) {
      notify(`\u59d4\u6258\u5931\u8d25\uff1a${error.message || error}`, 'error');
    }
  }

  async function startAgentDelegation(delegationId = '', permissionMode = 'full-access') {
    const cleanId = String(delegationId || '').trim();
    if (!cleanId || state.busy) return;
    state.busy = true;
    state.networkBusyDelegationId = cleanId;
    render();
    try {
      const result = await api.startAgentDelegation({
        delegationId: cleanId,
        model: currentModelValue(),
        reasoningEffort: currentReasoningValue(),
        sandboxPermission: permissionMode === 'auto-approve' ? 'auto-approve' : 'full-access',
      });
      state.agentDelegations = result?.delegations || await api.listAgentDelegations({ direction: 'all' });
      state.socialInbox = result?.inbox || await api.socialInbox();
      state.sessions = await api.listSessions();
      const delegation = state.agentDelegations.find((item) => item.id === cleanId);
      const currentUserId = state.currentUser?.id || '';
      const peerId = (delegation?.requesterUserId || delegation?.requester_user_id) === currentUserId
        ? (delegation?.recipientUserId || delegation?.recipient_user_id || '')
        : (delegation?.requesterUserId || delegation?.requester_user_id || '');
      if (peerId) state.networkConversationMessages = await api.socialConversation({ peerId });
      state.networkDelegationId = cleanId;
      state.networkPanelOpen = true;
      state.networkPanelView = 'tasks';
      notify(result?.cancelled ? '\u5df2\u53d6\u6d88\u59d4\u6258\u5904\u7406\u3002' : 'uBuddy 初步结果已生成，请在任务工作区确认、调整后再提交。', 'success');
    } catch (error) {
      await refreshAgentDelegations(false);
      await refreshSocialInbox(false);
      notify(`\u59d4\u6258\u5904\u7406\u5931\u8d25\uff1a${error.message || error}`, 'error');
    } finally {
      state.busy = false;
      state.networkBusyDelegationId = '';
      render();
    }
  }

  async function searchFriends(event) {
    event.preventDefault();
    const query = String(documentRef.getElementById('friend-add-search-query')?.value || state.friendAddSearchQuery || '').trim();
    if (!query) {
      state.friendAddSearchQuery = '';
      state.friendSearchResults = [];
      state.friendSearchResultQuery = '';
      state.friendRequestTargetId = '';
      state.friendRequestMessage = '';
      render();
      windowRef.requestAnimationFrame(() => documentRef.getElementById('friend-add-search-query')?.focus());
      return;
    }
    try {
      state.friendAddSearchQuery = query;
      state.friendSearchResults = await api.searchUsers({ query });
      state.friendSearchResultQuery = query;
      state.friendDirectoryError = '';
      if (state.friendRequestTargetId && !state.friendSearchResults.some((item) => item.id === state.friendRequestTargetId)) {
        closeFriendRequestComposer(false);
      }
      render();
    } catch (error) {
      state.friendDirectoryError = userErrorMessage(error);
      notify(`搜索用户失败：${error.message || error}`, 'error');
      render();
    }
  }

  async function updateFriendOverviewFromResult(result) {
    state.friendOverview = result?.overview || await api.friendsOverview();
    state.friendDirectoryError = '';
    if (state.friendSearchResultQuery) {
      state.friendSearchResults = await api.searchUsers({ query: state.friendSearchResultQuery });
    }
    render();
  }

  async function createOrganization(event) {
    event?.preventDefault?.();
    if (state.contactAddBusy) return;
    const draft = {
      name: documentRef.getElementById('organization-create-name')?.value || state.organizationCreateDraft?.name || '',
      organizationNumber: documentRef.getElementById('organization-create-number')?.value || state.organizationCreateDraft?.organizationNumber || '',
      verificationCode: documentRef.getElementById('organization-create-code')?.value || state.organizationCreateDraft?.verificationCode || '',
    };
    state.organizationCreateDraft = draft;
    state.contactAddBusy = 'create-organization';
    render();
    try {
      const result = await api.createOrganization(draft);
      state.friendOverview = result?.overview || await api.friendsOverview();
      let workspaceListRefreshed = false;
      if (typeof api.listAccountWorkspaces === 'function') {
        try {
          const workspaceState = await api.listAccountWorkspaces();
          if (Array.isArray(workspaceState?.workspaces)) {
            state.accountWorkspaces = workspaceState.workspaces;
            state.activeAccountWorkspace = workspaceState.activeWorkspace || state.activeAccountWorkspace;
            state.startupAccountWorkspace = workspaceState.startupWorkspace || state.startupAccountWorkspace;
            workspaceListRefreshed = true;
          }
        } catch {
          workspaceListRefreshed = false;
        }
      }
      state.friendDirectoryCategory = 'organizations';
      state.friendDirectoryView = 'contacts';
      state.contactsActivePane = 'contacts';
      state.contactAddDialogOpen = false;
      state.contactsSelectedOrganizationId = result?.organization?.id || '';
      state.organizationCreateDraft = { name: '', organizationNumber: '', verificationCode: '' };
      state.organizationJoinDraft = { organizationNumber: '', verificationCode: '', shareLink: '', setAsDefault: true };
      const organizationName = result?.organization?.name || draft.name;
      notify(workspaceListRefreshed
        ? `组织“${organizationName}”已创建，可从组织详情或左下角切换。`
        : `组织“${organizationName}”已创建，但工作空间列表刷新失败，请稍后重试。`, workspaceListRefreshed ? 'success' : 'warning');
    } catch (error) {
      notify(`创建组织失败：${userErrorMessage(error)}`, 'error');
    } finally {
      state.contactAddBusy = '';
      render();
    }
  }

  async function joinOrganization(event) {
    event?.preventDefault?.();
    if (state.contactAddBusy) return;
    const method = event?.currentTarget?.dataset?.organizationJoinMethod === 'share-link' ? 'share-link' : 'credentials';
    const draft = {
      organizationNumber: documentRef.getElementById('organization-join-number')?.value || state.organizationJoinDraft?.organizationNumber || '',
      verificationCode: documentRef.getElementById('organization-join-code')?.value || state.organizationJoinDraft?.verificationCode || '',
      shareLink: documentRef.getElementById('organization-join-link')?.value || state.organizationJoinDraft?.shareLink || '',
      setAsDefault: documentRef.getElementById('organization-join-default')?.checked ?? state.organizationJoinDraft?.setAsDefault !== false,
    };
    let joinPayload;
    if (method === 'share-link') {
      const invite = parseOrganizationInviteLink(draft.shareLink);
      if (!invite) {
        state.organizationJoinDraft = draft;
        notify('加入组织失败：请粘贴有效的 Janus 组织分享链接。', 'error');
        return;
      }
      joinPayload = {
        organizationNumber: invite.organizationNumber,
        verificationCode: invite.verificationCode,
      };
    } else {
      joinPayload = {
        organizationNumber: draft.organizationNumber,
        verificationCode: draft.verificationCode,
      };
    }
    state.organizationJoinDraft = draft;
    state.contactAddBusy = 'join-organization';
    render();
    try {
      const result = await api.joinOrganization(joinPayload);
      const activation = await activateOrganizationWorkspace(result?.organization, { setAsDefault: draft.setAsDefault });
      if (!activation?.switched) state.friendOverview = result?.overview || await api.friendsOverview();
      state.friendDirectoryCategory = 'organizations';
      state.friendDirectoryView = 'contacts';
      state.contactsActivePane = 'contacts';
      state.contactAddDialogOpen = false;
      state.contactsSelectedOrganizationId = result?.organization?.id || '';
      state.organizationJoinDraft = { organizationNumber: '', verificationCode: '', shareLink: '', setAsDefault: true };
      state.organizationCreateDraft = { name: '', organizationNumber: '', verificationCode: '' };
      const organizationName = result?.organization?.name || joinPayload.organizationNumber;
      notify(activation?.switched === false
        ? `已加入组织“${organizationName}”，但未能自动切换工作空间。`
        : `已加入并切换到组织“${organizationName}”${draft.setAsDefault && activation?.defaultSaved !== false ? '，已设为默认工作空间' : ''}。`, activation?.switched === false ? 'warning' : 'success');
    } catch (error) {
      notify(`加入组织失败：${userErrorMessage(error)}`, 'error');
    } finally {
      state.contactAddBusy = '';
      render();
    }
  }

  function openFriendRequestComposer(userId) {
    state.friendRequestTargetId = String(userId || '').trim();
    state.friendRequestMessage = '';
    render();
    requestAnimationFrame(() => documentRef.getElementById('friend-request-message')?.focus());
  }

  function closeFriendRequestComposer(renderAfter = true) {
    state.friendRequestTargetId = '';
    state.friendRequestMessage = '';
    if (renderAfter) render();
  }

  async function submitFriendRequest(event) {
    event.preventDefault();
    const userId = state.friendRequestTargetId;
    const message = documentRef.getElementById('friend-request-message')?.value || state.friendRequestMessage || '';
    await sendFriendRequest(userId, message);
  }

  async function sendFriendRequest(userId, message = '') {
    try {
      const result = await api.sendFriendRequest({ userId, message: String(message || '').trim().slice(0, 200) });
      closeFriendRequestComposer(false);
      await updateFriendOverviewFromResult(result);
      notify('好友申请已发送，等待对方同意。', 'success');
    } catch (error) {
      notify(`发送失败：${error.message || error}`, 'error');
    }
  }

  async function acceptFriendRequest(requestId) {
    const cleanId = String(requestId || '').trim();
    if (!cleanId || state.friendRequestActionId) return;
    state.friendRequestActionId = cleanId;
    render();
    try {
      const result = await api.acceptFriendRequest({ requestId: cleanId });
      await updateFriendOverviewFromResult(result);
      notify('已添加好友。', 'success');
    } catch (error) {
      notify(`处理失败：${error.message || error}`, 'error');
    } finally {
      state.friendRequestActionId = '';
      render();
    }
  }

  async function rejectFriendRequest(requestId) {
    const cleanId = String(requestId || '').trim();
    if (!cleanId || state.friendRequestActionId) return;
    state.friendRequestActionId = cleanId;
    render();
    try {
      const result = await api.rejectFriendRequest({ requestId: cleanId });
      await updateFriendOverviewFromResult(result);
      notify('已拒绝申请。', 'success');
    } catch (error) {
      notify(`处理失败：${error.message || error}`, 'error');
    } finally {
      state.friendRequestActionId = '';
      render();
    }
  }

  async function cancelFriendRequest(requestId) {
    const cleanId = String(requestId || '').trim();
    if (!cleanId || state.friendRequestActionId) return;
    state.friendRequestActionId = cleanId;
    render();
    try {
      const result = await api.cancelFriendRequest({ requestId: cleanId });
      await updateFriendOverviewFromResult(result);
      notify('已取消申请。', 'success');
    } catch (error) {
      notify(`取消失败：${error.message || error}`, 'error');
    } finally {
      state.friendRequestActionId = '';
      render();
    }
  }

  async function removeFriend(userId) {
    if (!windowRef.confirm('确定删除这个好友吗？')) return;
    try {
      const result = await api.removeFriend({ userId });
      await updateFriendOverviewFromResult(result);
      notify('好友已删除。', 'success');
    } catch (error) {
      notify(`删除失败：${error.message || error}`, 'error');
    }
  }

  function updateFriendRemark(userId) {
    const relationship = (state.friendOverview?.friends || []).find((item) => item.friend?.id === userId);
    const organizationMember = (state.friendOverview?.organizations || [])
      .flatMap((organization) => organization.members || [])
      .find((member) => String(member?.user?.id || '') === String(userId || ''));
    const friend = relationship?.friend || organizationMember?.user || null;
    if (!friend) return;
    const accountName = friend.displayName || friend.display_name || friend.username || friend.email || friend.id || '好友';
    state.socialEditDialog = {
      type: 'friend-remark',
      targetId: userId,
      subtitle: `为 ${accountName} 设置仅自己可见的备注`,
      draft: relationship?.remark || friend.remark || '',
    };
    render();
    requestAnimationFrame(() => documentRef.getElementById('social-edit-input')?.select());
  }

  async function saveFriendRemark(userId, value = '') {
    const remark = String(value || '').trim();
    if (remark.length > 40) {
      notify('好友备注不能超过 40 个字符。', 'warning');
      return;
    }
    try {
      const result = await api.updateFriendRemark({ userId, remark });
      state.socialEditDialog = null;
      await updateFriendOverviewFromResult(result);
      notify(remark ? '好友备注已更新。' : '好友备注已清除。', 'success');
    } catch (error) {
      notify(`更新备注失败：${userErrorMessage(error)}`, 'error');
    }
  }

  async function blockFriend(userId) {
    if (!windowRef.confirm('确定拉黑这个用户吗？拉黑后会取消相关好友关系和待处理申请。')) return;
    try {
      const result = await api.blockUser({ userId });
      await updateFriendOverviewFromResult(result);
      notify('已拉黑用户。', 'success');
    } catch (error) {
      notify(`拉黑失败：${error.message || error}`, 'error');
    }
  }


  return {
    refreshFriends,
    showFriendDirectoryView,
    showFriendDirectoryCategory,
    handleAddFriendClick,
    clearFriendSearch,
    openContactAddDialog,
    switchContactAddDialogTab,
    closeContactAddDialog,
    friendNameById,
    createAgentDelegationForFriend,
    startAgentDelegation,
    searchFriends,
    updateFriendOverviewFromResult,
    createOrganization,
    joinOrganization,
    openFriendRequestComposer,
    closeFriendRequestComposer,
    submitFriendRequest,
    sendFriendRequest,
    acceptFriendRequest,
    rejectFriendRequest,
    cancelFriendRequest,
    removeFriend,
    updateFriendRemark,
    saveFriendRemark,
    blockFriend,
  };
}
