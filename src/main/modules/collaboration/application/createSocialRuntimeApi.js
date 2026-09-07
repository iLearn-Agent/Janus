import { uploadRemoteMessageAttachments } from './messageFileTransfer.js';
import fs from 'node:fs';

export function createSocialRuntimeApi({ auth, store, socialRelay, runtimeRoot = '', uBuddyFeatureFlags = null, profileProvider = null }) {
  const activeWorkspace = () => {
    const user = auth.requireUser();
    return store.activeAccountWorkspace({ userId: user.id, deviceId: store.contextDeviceId?.() || 'local' });
  };
  const accountGlobalDirectState = (result = {}, peerId = '', workspaceId = '') => ({
    ...(result || {}),
    inbox: auth.socialInbox({ workspaceId: workspaceId || activeWorkspace()?.id }),
    ...(peerId ? { conversation: auth.socialConversation({ peerId, workspaceId: workspaceId || activeWorkspace()?.id }) } : {}),
  });
  const profilePublicationEnabled = () => {
    const user = auth.requireUser();
    return Boolean(uBuddyFeatureFlags?.snapshot?.({ userId: user.id, workspaceId: activeWorkspace()?.id })?.profilePublication);
  };
  const requireProfilePublicationEnabled = () => {
    if (profilePublicationEnabled()) return;
    const error = new Error('uBuddy 简介发布功能尚未启用。');
    error.code = 'ubuddy_profile_publication_disabled';
    throw error;
  };
  const profileHistoryEnabled = () => {
    const user = auth.requireUser();
    return Boolean(uBuddyFeatureFlags?.snapshot?.({ userId: user.id, workspaceId: activeWorkspace()?.id })?.profileHistory);
  };
  const requireProfileHistoryEnabled = () => {
    if (profileHistoryEnabled()) return;
    const error = new Error('uBuddy 简介历史功能尚未启用。');
    error.code = 'ubuddy_profile_history_disabled';
    throw error;
  };
  const purgeProfileCacheForUsers = (userIds = []) => auth.purgeUBuddyCapabilityProfileCache?.({
    userIds, remoteUserIds: userIds.map((id) => socialRelay.remoteUserId?.(id) || id), serverOriginHash: socialRelay.serverOriginHash?.() || '',
  });
  return {
    async listEmojiFavorites() {
      const local = auth.listEmojiFavorites();
      if (!socialRelay.connected()) return local;
      try {
        for (const entry of auth.listEmojiFavoriteOutbox?.() || []) {
          try {
            const payload = entry.payload || {};
            if (entry.operation_kind === 'delete') await socialRelay.deleteEmojiFavorite(payload.id);
            else if (entry.operation_kind === 'order') await socialRelay.reorderEmojiFavorites(payload.ids || []);
            else if (entry.operation_kind === 'upsert') {
              const item = local.find((candidate) => candidate.id === payload.id);
              if (item?.kind === 'image' && item.value?.startsWith('data:')) await socialRelay.uploadEmojiFavorite(item.id, { kind: 'image', filename: item.filename, contentType: item.contentType, sha256: item.sha256, body: Buffer.from(item.value.split(',', 2)[1] || '', 'base64'), sortOrder: item.sortOrder });
              else if (item?.kind === 'unicode') await socialRelay.uploadEmojiFavorite(item.id, { kind: 'unicode', value: item.value, sha256: item.sha256, sortOrder: item.sortOrder, body: Buffer.alloc(0) });
            }
            auth.markEmojiFavoriteOutbox?.({ id: entry.id, status: 'completed' });
          } catch (error) { auth.markEmojiFavoriteOutbox?.({ id: entry.id, status: 'failed', error: error?.message || error }); }
        }
        const remote = await socialRelay.emojiFavorites();
        const items = Array.isArray(remote?.items) ? remote.items : [];
        const pendingDeleteIds = new Set((auth.listEmojiFavoriteOutbox?.() || []).filter((entry) => entry.operation_kind === 'delete').map((entry) => String(entry.payload?.id || '')));
        const byKey = new Map();
        for (const item of local) byKey.set(`${item.kind}:${item.sha256 || item.value || item.id}`, item);
        for (const item of items.slice(0, 300)) {
          if (pendingDeleteIds.has(String(item.id || ''))) continue;
          const key = `${item.kind}:${item.sha256 || item.value || item.id}`;
          byKey.set(key, item);
        }
        const merged = [...byKey.values()].slice(0, 300);
        if (merged.length) {
          const hydrated = [];
          for (const item of merged) {
            if (item.kind !== 'image' || item.url?.startsWith('data:')) {
              if (item.kind === 'unicode') auth.importEmojiFavorite?.(item);
              hydrated.push(item);
              continue;
            }
            try {
              const bytes = Buffer.from(await socialRelay.downloadEmojiFavorite(item.id));
              const dataUrl = `data:${item.content_type || item.contentType || 'image/png'};base64,${bytes.toString('base64')}`;
              const hydratedItem = { ...item, value: dataUrl, url: dataUrl };
              auth.importEmojiFavorite?.({ ...hydratedItem, dataBase64: bytes.toString('base64') });
              hydrated.push(hydratedItem);
            } catch { hydrated.push(item); }
          }
          return hydrated;
        }
      } catch {}
      return local;
    },
    async addEmojiFavorite(payload = {}) {
      const favorite = { ...payload };
      if (favorite.path && !favorite.dataBase64) {
        favorite.dataBase64 = fs.readFileSync(String(favorite.path)).toString('base64');
      }
      const local = auth.addEmojiFavorite(favorite);
      if (socialRelay.connected() && ((local.kind === 'image' && favorite.dataBase64) || local.kind === 'unicode')) {
        try {
          const uploaded = await socialRelay.uploadEmojiFavorite(local.id, {
            kind: local.kind, value: local.value, filename: local.filename, contentType: local.contentType, sha256: local.sha256,
            body: Buffer.from(String(favorite.dataBase64 || ''), 'base64'), sortOrder: local.sortOrder,
          });
          const remoteItem = uploaded?.item || {};
          // The cloud API intentionally limits the metadata `value` header.  Keep
          // the complete local data URL in the renderer result; otherwise a newly
          // added favorite can be replaced by the first ~100 characters of its
          // Base64 payload and later be sent as a tiny, truncated PNG.
          const hasCompleteLocalImage = local.kind === 'image'
            && String(local.value || '').startsWith('data:image/')
            && String(favorite.dataBase64 || '').length > 0;
          return {
            ...local,
            ...remoteItem,
            ...(hasCompleteLocalImage ? { value: local.value, url: local.value } : {
              url: remoteItem.url || local.url,
            }),
          };
        } catch {}
      }
      return local;
    },
    async removeEmojiFavorite(payload = {}) {
      const local = auth.removeEmojiFavorite(payload);
      if (socialRelay.connected()) await socialRelay.deleteEmojiFavorite(payload.id).catch(() => {});
      return local;
    },
    async reorderEmojiFavorites(payload = {}) {
      const local = auth.reorderEmojiFavorites(payload);
      if (socialRelay.connected()) await socialRelay.reorderEmojiFavorites(payload.ids || []).catch(() => {});
      return local;
    },
    async chatGroupsOverview() {
      const workspace = activeWorkspace();
      if (socialRelay.connected()) {
        try {
          if (!await remoteChatGroupsSupported(socialRelay)) {
            return { ...auth.chatGroupsOverview(), remoteEnabled: false, reason: 'server_capability_missing' };
          }
        } catch (error) {
          if (!isTransientSocialFetchError(error)) throw error;
          return { ...auth.chatGroupsOverview(), remoteEnabled: null };
        }
        await flushChatGroupOutbox({ auth, socialRelay, runtimeRoot, workspaceId: workspace?.id });
        try {
          return await socialRelay.chatGroupsOverview({ workspaceId: workspace?.id });
        } catch (error) {
          if (!isTransientSocialFetchError(error)) throw error;
        }
      }
      return { ...auth.chatGroupsOverview(), remoteEnabled: null };
    },
    async chatGroup(payload = {}) {
      const workspace = activeWorkspace();
      const groupId = String(payload.groupId || payload.id || '').trim();
      if (!groupId) throw new Error('缺少群聊 ID。');
      if (socialRelay.connected()) {
        try {
          if (!await remoteChatGroupsSupported(socialRelay)) return auth.chatGroup(groupId);
        } catch (error) {
          if (!isTransientSocialFetchError(error)) throw error;
          return auth.chatGroup(groupId);
        }
        await flushChatGroupOutbox({ auth, socialRelay, runtimeRoot, workspaceId: workspace?.id });
        try { return await socialRelay.chatGroup(groupId, { workspaceId: workspace?.id }); } catch (error) {
          if (!isTransientSocialFetchError(error)) throw error;
        }
      }
      return auth.chatGroup(groupId);
    },
    async createChatGroup(payload = {}) {
      const workspace = activeWorkspace();
      if (socialRelay.connected()) {
        try {
          if (!await remoteChatGroupsSupported(socialRelay)) throw chatGroupsServerUpdateRequired();
        } catch (error) {
          if (!isTransientSocialFetchError(error)) throw error;
        }
      }
      const local = auth.createChatGroup({ ...payload, workspaceId: workspace?.id });
      if (socialRelay.connected()) await flushChatGroupOutbox({ auth, socialRelay, runtimeRoot, workspaceId: workspace?.id });
      return auth.chatGroup(local.group.id, { markRead: false });
    },
    async sendChatGroupMessage(payload = {}) {
      const workspace = activeWorkspace();
      if (socialRelay.connected() && !await remoteChatGroupsSupported(socialRelay)) throw chatGroupsServerUpdateRequired();
      let outgoing = { ...payload, workspaceId: workspace?.id };
      const metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? { ...payload.metadata }
        : {};
      if (socialRelay.connected() && Array.isArray(metadata.attachments) && metadata.attachments.length) {
        if (!await remoteChatGroupFilesSupported(socialRelay)) throw chatGroupFilesServerUpdateRequired();
        const attachments = await uploadRemoteMessageAttachments({
          runtimeRoot,
          socialRelay,
          userId: auth.requireUser().id,
          scopeKind: 'chat_group',
          scopeId: String(payload.groupId || '').trim(),
          accountWorkspaceId: workspace?.id || 'workspace_personal',
          attachments: metadata.attachments,
        });
        outgoing = { ...outgoing, metadata: { ...metadata, attachments } };
      }
      const local = auth.sendChatGroupMessage(outgoing);
      if (socialRelay.connected()) await flushChatGroupOutbox({ auth, socialRelay, runtimeRoot, workspaceId: workspace?.id });
      return auth.chatGroup(local.group.id);
    },
    async markChatGroupRead(payload = {}) {
      const workspace = activeWorkspace();
      const local = auth.markChatGroupRead({ ...payload, workspaceId: workspace?.id });
      if (socialRelay.connected()) {
        try { await socialRelay.markChatGroupRead(payload.groupId, { ...payload, workspaceId: workspace?.id }); }
        catch (error) { if (!isTransientSocialFetchError(error)) throw error; }
      }
      return local;
    },
    async updateChatGroup(payload = {}) {
      const workspace = activeWorkspace();
      if (socialRelay.connected() && !await remoteChatGroupsSupported(socialRelay)) throw chatGroupsServerUpdateRequired();
      if (socialRelay.connected() && payload.action === 'set_remark' && !await remoteChatGroupRemarksSupported(socialRelay)) {
        const error = new Error('当前通信服务尚未支持群聊备注，请先更新并重启云端服务。');
        error.code = 'chat_group_remarks_server_update_required';
        throw error;
      }
      if (socialRelay.connected() && payload.action === 'withdraw_message' && !await remoteChatGroupMessageWithdrawSupported(socialRelay)) {
        const error = new Error('当前通信服务尚未支持群聊消息撤回，请先更新并重启云端服务。');
        error.code = 'chat_group_message_withdraw_server_update_required';
        throw error;
      }
      const local = auth.updateChatGroup({ ...payload, workspaceId: workspace?.id });
      if (socialRelay.connected()) await flushChatGroupOutbox({ auth, socialRelay, runtimeRoot, workspaceId: workspace?.id });
      return auth.chatGroup(local.group.id, { markRead: false });
    },
    async setConversationArchived(payload = {}) {
      const workspace = activeWorkspace();
      const outgoing = {
        ...payload,
        archived: Boolean(payload.archived || payload.removed),
        removed: false,
        workspaceId: payload.workspaceId || payload.accountWorkspaceId || workspace?.id || 'workspace_personal',
        sourceDeviceId: socialRelay.status?.().deviceId || 'local',
      };
      let local = null;
      try {
        local = auth.setConversationArchived(outgoing);
      } catch (error) {
        if (error?.code !== 'conversation_preference_not_found') throw error;
        if (!socialRelay.connected()) {
          const syncRequired = new Error('需要联网同步这个群聊后才能归档。');
          syncRequired.code = 'conversation_preference_sync_required';
          throw syncRequired;
        }
        const remote = await socialRelay.setConversationPreference(outgoing);
        return {
          preference: remote?.preference || auth.conversationPreference({
            conversationKind: outgoing.conversationKind,
            conversationId: outgoing.conversationId,
          }),
          overview: auth.conversationPreferencesOverview(),
          remoteFirst: true,
        };
      }
      if (socialRelay.connected()) await socialRelay.syncConversationPreferences().catch(() => null);
      return {
        ...local,
        overview: auth.conversationPreferencesOverview(),
      };
    },
    conversationPreferencesOverview() {
      return auth.conversationPreferencesOverview();
    },
    friendsOverview() {
      const workspace = activeWorkspace();
      if (socialRelay.connected()) {
        return Promise.resolve().then(() => socialRelay.friendsOverview()).catch((error) => {
          if (!isTransientSocialFetchError(error)) throw error;
          return socialRelay.friendsOverviewWithCachedPresence(auth.friendsOverview({ workspaceId: workspace?.id }));
        });
      }
      return socialRelay.friendsOverviewWithCachedPresence(auth.friendsOverview({ workspaceId: workspace?.id }));
    },
    socialInbox: (payload = {}) => auth.socialInbox({ ...payload, workspaceId: payload.workspaceId || activeWorkspace()?.id }),
    socialSendMessage(payload = {}) {
      const user = auth.requireUser();
      const workspace = activeWorkspace();
      const scopedPayload = { ...payload, workspaceId: payload.workspaceId || workspace?.id };
      const recipientId = String(payload.recipientId || payload.userId || '').trim();
      const relayStatus = socialRelay.status?.() || {};
      const selfIds = new Set([
        user.id,
        user.remoteId,
        user.remote_id,
        relayStatus.remoteUserId,
        relayStatus.remote_user_id,
      ].map((value) => String(value || '').trim()).filter(Boolean));
      const localRecipientId = typeof socialRelay.localUserId === 'function'
        ? String(socialRelay.localUserId(recipientId) || '').trim()
        : recipientId;
      if (recipientId && (selfIds.has(recipientId) || localRecipientId === user.id)) {
        const metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
          ? { ...payload.metadata, type: 'direct_message' }
          : { type: 'direct_message' };
        return accountGlobalDirectState(auth.socialSendMessage({
          ...scopedPayload,
          recipientId: user.id,
          userId: user.id,
          kind: 'friend',
          senderAgentId: '',
          recipientAgentId: '',
          metadata,
        }), user.id, scopedPayload.workspaceId);
      }
      if (socialRelay.connected()) {
        const metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
          ? { ...payload.metadata }
          : {};
        return uploadRemoteMessageAttachments({
          runtimeRoot,
          socialRelay,
          userId: user.id,
          scopeKind: 'social',
          scopeId: String(payload.recipientId || payload.userId || '').trim(),
          accountWorkspaceId: workspace?.id || 'workspace_personal',
          attachments: metadata.attachments,
        }).then((attachments) => {
          const outgoing = { ...scopedPayload, metadata: { ...metadata, ...(attachments.length ? { attachments } : {}) } };
          return socialRelay.sendMessage(outgoing).then((result) => accountGlobalDirectState(
            result,
            outgoing.recipientId || outgoing.userId,
            outgoing.workspaceId,
          ));
        });
      }
      return accountGlobalDirectState(auth.socialSendMessage(scopedPayload), recipientId, scopedPayload.workspaceId);
    },
    socialUpdateMessage(payload = {}) {
      const messageId = String(payload.messageId || payload.id || '').trim();
      if (!messageId) throw new Error('缺少消息 ID。');
      const workspace = activeWorkspace();
      const localMessage = auth.socialMessageById(messageId, { workspaceId: workspace?.id });
      const messageWorkspaceId = localMessage?.workspaceId || localMessage?.accountWorkspaceId || workspace?.id;
      if (socialRelay.connected()) {
        return socialRelay.updateMessage(messageId, { ...payload, workspaceId: messageWorkspaceId })
          .then((result) => accountGlobalDirectState(result));
      }
      return auth.socialUpdateMessage({ ...payload, messageId, workspaceId: workspace?.id });
    },
    socialMarkRead(payload = {}) {
      const workspace = activeWorkspace();
      const localMessage = auth.socialMessageById(payload.messageId, { workspaceId: workspace?.id });
      const scopedPayload = { ...payload, workspaceId: localMessage?.workspaceId || localMessage?.accountWorkspaceId || workspace?.id };
      if (socialRelay.connected()) {
        return socialRelay.markMessageRead(payload.messageId, scopedPayload)
          .then(() => auth.socialMarkRead({ messageId: payload.messageId, workspaceId: workspace?.id }));
      }
      return auth.socialMarkRead({ messageId: payload.messageId, workspaceId: workspace?.id });
    },
    async socialToggleMessageReaction(payload = {}) {
      const messageId = String(payload.messageId || payload.id || '').trim();
      if (!messageId) throw new Error('缺少消息 ID。');
      const workspace = activeWorkspace();
      const localMessage = auth.socialMessageById(messageId, { workspaceId: payload.workspaceId || workspace?.id, accountGlobal: true });
      const messageWorkspaceId = localMessage?.workspaceId || localMessage?.accountWorkspaceId || payload.workspaceId || workspace?.id;
      const localResult = auth.socialToggleMessageReaction({ ...payload, messageId, workspaceId: messageWorkspaceId });
      if (!socialRelay.connected()) return localResult;
      const remoteMessageId = String(localMessage?.remoteId || localMessage?.remote_id || '').trim();
      if (!remoteMessageId) return accountGlobalDirectState(localResult);
      try {
        const result = await socialRelay.toggleMessageReaction(remoteMessageId, { ...payload, messageId: remoteMessageId, workspaceId: messageWorkspaceId });
        return accountGlobalDirectState(result);
      } catch (error) {
        if (Number(error?.status || 0) === 404 || error?.code === 'message_not_found') return accountGlobalDirectState(localResult);
        throw error;
      }
    },
    socialConversation: (payload = {}) => auth.socialConversation({ ...payload, workspaceId: payload.workspaceId || activeWorkspace()?.id }),
    socialConversationSummaries: (payload = {}) => auth.socialConversationSummaries({ ...payload, workspaceId: payload.workspaceId || activeWorkspace()?.id }),
    agentDelegations: (payload = {}) => auth.agentDelegations({ ...payload, workspaceId: activeWorkspace()?.id }),
    friendSearch(payload = {}) {
      if (socialRelay.connected()) return socialRelay.searchUsers(payload.query || '');
      return auth.searchUsers(payload);
    },
    friendSendRequest(payload = {}) {
      if (socialRelay.connected()) return socialRelay.friendAction('send', payload);
      return auth.sendFriendRequest(payload);
    },
    friendAcceptRequest(payload = {}) {
      if (socialRelay.connected()) return socialRelay.friendAction('accept', payload);
      return auth.acceptFriendRequest(payload);
    },
    friendRejectRequest(payload = {}) {
      if (socialRelay.connected()) return socialRelay.friendAction('reject', payload);
      return auth.rejectFriendRequest(payload);
    },
    friendCancelRequest(payload = {}) {
      if (socialRelay.connected()) return socialRelay.friendAction('cancel', payload);
      return auth.cancelFriendRequest(payload);
    },
    async friendRemove(payload = {}) {
      const result = socialRelay.connected() ? await socialRelay.friendAction('remove', payload) : auth.removeFriend(payload);
      purgeProfileCacheForUsers([payload.userId]);
      return result;
    },
    friendUpdateRemark(payload = {}) {
      if (socialRelay.connected()) return socialRelay.friendAction('remark', payload);
      return auth.updateFriendRemark(payload);
    },
    async friendBlock(payload = {}) {
      const result = socialRelay.connected() ? await socialRelay.friendAction('block', payload) : auth.blockUser(payload);
      purgeProfileCacheForUsers([payload.userId]);
      return result;
    },
    organizationCreate(payload = {}) {
      const user = auth.requireUser();
      const result = socialRelay.connected() ? socialRelay.organizationAction('create', payload) : auth.createOrganization(payload);
      return finalizeOrganizationMutation(result, { store, user });
    },
    organizationJoin(payload = {}) {
      const user = auth.requireUser();
      const result = socialRelay.connected() ? socialRelay.organizationAction('join', payload) : auth.joinOrganization(payload);
      return finalizeOrganizationMutation(result, { store, user });
    },
    organizationAction(payload = {}) {
      const user = auth.requireUser();
      const invoke = () => socialRelay.connected() ? socialRelay.organizationAction('action', payload) : auth.organizationAction(payload);
      const result = String(payload.action || '').trim().toLowerCase() === 'validate_invitation_code'
        ? optionalInvitationCodeValidation(invoke)
        : invoke();
      const finalized = finalizeOrganizationMutation(result, { store, user });
      if (organizationMutationRemovesProfileAccess(payload)) {
        return Promise.resolve(finalized).then((value) => {
          auth.purgeUBuddyCapabilityProfileCache?.({ serverOriginHash: socialRelay.serverOriginHash?.() || '', allForServer: true });
          return value;
        });
      }
      return finalized;
    },
    async queryUBuddyCapabilityProfiles(payload = {}) {
      if (!profilePublicationEnabled()) return { enabled: false, profiles: [], reason: 'feature_flag_disabled' };
      const result = await socialRelay.queryUBuddyCapabilityProfiles({
        userIds: payload.userIds || [], cachedOnly: payload.cachedOnly === true,
      });
      return { enabled: true, ...result };
    },
    async uBuddyCapabilityProfilePublicationStatus() {
      const enabled = profilePublicationEnabled();
      return {
        enabled,
        providerAvailable: Boolean(profileProvider?.getActiveUBuddyCapabilityProfile),
        connected: socialRelay.connected(),
        serverSupported: enabled && socialRelay.connected()
          ? await socialRelay.uBuddyCapabilityProfilesSupported().catch(() => false)
          : null,
        outbox: enabled ? auth.listUBuddyCapabilityProfilePublicationOutbox?.({ limit: 100 }) || [] : [],
      };
    },
    async uBuddyCapabilityProfileHistory({ limit = 100 } = {}) {
      requireProfileHistoryEnabled();
      const user = auth.requireUser();
      profileProvider?.reconcileUBuddyCapabilityProfile?.({ userId: user.id, trigger: 'settings_opened' });
      return {
        enabled: true,
        profiles: profileProvider?.listUBuddyCapabilityProfileHistory?.({ userId: user.id, limit }) || [],
        preference: profileProvider?.getUBuddyProfilePublicationPreference?.({ userId: user.id }) || null,
      };
    },
    async regenerateUBuddyCapabilityProfile() {
      requireProfileHistoryEnabled();
      const user = auth.requireUser();
      return profileProvider?.scheduleUBuddyCapabilityProfileGeneration?.({
        userId: user.id, trigger: 'user_requested', force: true,
      }) || { status: 'unavailable' };
    },
    async reviewUBuddyCapabilityProfile(payload = {}) {
      requireProfileHistoryEnabled();
      const user = auth.requireUser();
      if (typeof profileProvider?.reviewUBuddyCapabilityProfile !== 'function') throw profileSourceUnavailableError();
      return profileProvider.reviewUBuddyCapabilityProfile({
        userId: user.id,
        profileRevision: payload.profileRevision || 0,
        decision: payload.decision || '',
        visibility: payload.visibility || 'friends',
      });
    },
    async updateUBuddyCapabilityProfilePublicationPreference(payload = {}) {
      requireProfileHistoryEnabled();
      const user = auth.requireUser();
      const preference = profileProvider?.setUBuddyProfilePublicationPreference?.({
        userId: user.id, enabled: payload.enabled, visibility: payload.visibility || '',
      }) || null;
      if (payload.enabled === false && profilePublicationEnabled()) {
        const queued = auth.queueUBuddyCapabilityProfilePublication({ operationKind: 'unpublish' });
        const sync = await socialRelay.syncUBuddyCapabilityProfilePublication();
        return { preference, queued, sync };
      }
      return { preference };
    },
    async publishUBuddyCapabilityProfile(payload = {}) {
      requireProfilePublicationEnabled();
      if (typeof profileProvider?.getActiveUBuddyCapabilityProfile !== 'function') throw profileSourceUnavailableError();
      const user = auth.requireUser();
      const profile = await profileProvider.getActiveUBuddyCapabilityProfile({ userId: user.id });
      if (!profile) throw profileNotFoundError();
      profileProvider.authorizeUBuddyProfilePublication?.({
        userId: user.id,
        visibility: payload.visibility || profile.visibility || 'friends',
        profileRevision: profile.profileRevision || 0,
      });
      const preference = typeof profileProvider?.getUBuddyProfilePublicationPreference === 'function'
        ? await profileProvider.getUBuddyProfilePublicationPreference({ userId: user.id })
        : null;
      const visibility = String(payload.visibility || preference?.visibility || profile.visibility || 'private').trim().toLowerCase();
      const operationKind = preference?.enabled === false || visibility === 'private' ? 'unpublish' : 'publish';
      const queued = auth.queueUBuddyCapabilityProfilePublication({
        operationKind,
        profile: operationKind === 'publish' ? { ...profile, ownerUserId: user.id, visibility, publicationState: 'active' } : null,
        commandId: payload.commandId || '',
        expectedCloudStateRevision: payload.expectedCloudStateRevision || payload.expectedStateRevision || 0,
      });
      const sync = await socialRelay.syncUBuddyCapabilityProfilePublication();
      return { queued, sync };
    },
    async unpublishUBuddyCapabilityProfile(payload = {}) {
      requireProfilePublicationEnabled();
      const user = auth.requireUser();
      profileProvider?.setUBuddyProfilePublicationPreference?.({
        userId: user.id, enabled: false, visibility: 'private',
      });
      const queued = auth.queueUBuddyCapabilityProfilePublication({
        operationKind: 'unpublish', commandId: payload.commandId || '',
        expectedCloudStateRevision: payload.expectedCloudStateRevision || payload.expectedStateRevision || 0,
      });
      const sync = await socialRelay.syncUBuddyCapabilityProfilePublication();
      return { queued, sync };
    },
    async retryUBuddyCapabilityProfilePublication() {
      requireProfilePublicationEnabled();
      return socialRelay.syncUBuddyCapabilityProfilePublication();
    },
    socialStatus: () => ({ ...socialRelay.status(), chatGroups: { enabled: true, capability: 'chat-groups-v2' } }),
  };
}

function profileSourceUnavailableError() {
  const error = new Error('uBuddy 简介服务当前不可用。');
  error.code = 'profile_source_unavailable';
  return error;
}

function profileNotFoundError() {
  const error = new Error('当前没有已生效且可发布的 uBuddy 简介，请先完成生成和审核。');
  error.code = 'ubuddy_profile_not_found';
  return error;
}

function organizationMutationRemovesProfileAccess(payload = {}) {
  return ['remove_member', 'request_exit', 'resolve_exit', 'owner_exit', 'dismiss']
    .includes(String(payload.action || '').trim().toLowerCase());
}

async function flushChatGroupOutbox({ auth, socialRelay, runtimeRoot = '', workspaceId = '' } = {}) {
  if (!socialRelay.connected()) return { flushed: 0 };
  let flushed = 0;
  for (const row of auth.listChatGroupOutbox({ workspaceId, limit: 100 })) {
    try {
      if (row.operation_kind === 'create_group') await socialRelay.createChatGroup(row.payload);
      else if (row.operation_kind === 'send_message') {
        const metadata = row.payload?.metadata && typeof row.payload.metadata === 'object' && !Array.isArray(row.payload.metadata)
          ? { ...row.payload.metadata }
          : {};
        const hasAttachments = Array.isArray(metadata.attachments) && metadata.attachments.length;
        if (hasAttachments && !metadata.attachments.every((item) => item?.remote_file_id || item?.remoteFileId)
          && !await remoteChatGroupFilesSupported(socialRelay)) continue;
        const attachments = hasAttachments
          ? await uploadRemoteMessageAttachments({
            runtimeRoot,
            socialRelay,
            userId: auth.requireUser().id,
            scopeKind: 'chat_group',
            scopeId: row.aggregate_id,
            accountWorkspaceId: row.account_workspace_id || workspaceId || 'workspace_personal',
            attachments: metadata.attachments,
          })
          : [];
        await socialRelay.sendChatGroupMessage(row.aggregate_id, {
          ...row.payload,
          metadata: { ...metadata, ...(attachments.length ? { attachments } : {}) },
        });
      }
      else if (row.operation_kind === 'update_group') await socialRelay.updateChatGroup(row.aggregate_id, row.payload);
      auth.markChatGroupOutbox({ id: row.id, status: 'completed' });
      flushed += 1;
    } catch (error) {
      auth.markChatGroupOutbox({ id: row.id, status: 'failed', error: error?.message || error });
      if (!isTransientSocialFetchError(error)) throw error;
      break;
    }
  }
  return { flushed };
}

async function remoteChatGroupsSupported(socialRelay) {
  try {
    const capabilities = await socialRelay.socialCapabilities();
    return Array.isArray(capabilities?.capabilities) && capabilities.capabilities.includes('chat-groups-v2');
  } catch (error) {
    const status = Number(error?.status || error?.body?.status || 0);
    const code = String(error?.code || error?.body?.error?.code || '').toLowerCase();
    if (status === 404 || ['not_found', 'route_not_found'].includes(code)) return false;
    throw error;
  }
}

async function remoteChatGroupFilesSupported(socialRelay) {
  try {
    const capabilities = await socialRelay.socialCapabilities();
    return Array.isArray(capabilities?.capabilities) && capabilities.capabilities.includes('chat-group-files-v1');
  } catch (error) {
    if (!isTransientSocialFetchError(error)) throw error;
    return false;
  }
}

async function remoteChatGroupRemarksSupported(socialRelay) {
  try {
    const capabilities = await socialRelay.socialCapabilities();
    return Array.isArray(capabilities?.capabilities) && capabilities.capabilities.includes('chat-group-remarks-v1');
  } catch (error) {
    if (!isTransientSocialFetchError(error)) throw error;
    return false;
  }
}

async function remoteChatGroupMessageWithdrawSupported(socialRelay) {
  try {
    const capabilities = await socialRelay.socialCapabilities();
    return Array.isArray(capabilities?.capabilities) && capabilities.capabilities.includes('chat-group-message-withdraw-v1');
  } catch (error) {
    const status = Number(error?.status || error?.body?.status || 0);
    const code = String(error?.code || error?.body?.error?.code || '').toLowerCase();
    if (status === 404 || ['not_found', 'route_not_found'].includes(code)) return false;
    throw error;
  }
}

function chatGroupsServerUpdateRequired() {
  const error = new Error('当前通信服务尚未支持群聊，请先更新并重启云端服务。');
  error.code = 'chat_groups_server_update_required';
  return error;
}

function chatGroupFilesServerUpdateRequired() {
  const error = new Error('当前通信服务尚未支持联系人群聊附件，请先更新并重启云端服务。');
  error.code = 'chat_group_files_server_update_required';
  return error;
}

function finalizeOrganizationMutation(result, { store, user }) {
  const finalize = (value) => {
    store.ensureAccountWorkspaces({ user });
    return value;
  };
  return result && typeof result.then === 'function'
    ? Promise.resolve(result).then(finalize)
    : finalize(result);
}

function optionalInvitationCodeValidation(invoke) {
  const recover = (error) => {
    if (!isInvitationCodeValidationUnavailable(error)) throw error;
    return {
      ok: true,
      invitationCodeValid: null,
      invitationCodeValidation: 'deferred',
      validationUnavailable: true,
    };
  };
  try {
    const result = invoke();
    return result && typeof result.then === 'function'
      ? Promise.resolve(result).catch(recover)
      : result;
  } catch (error) {
    return recover(error);
  }
}

function isInvitationCodeValidationUnavailable(error) {
  const code = String(error?.code || error?.body?.error?.code || error?.body?.code || '').trim().toLowerCase();
  const status = Number(error?.status || error?.body?.status || 0);
  const message = String(error?.message || error?.body?.error?.message || error || '').trim().toLowerCase();
  if (['organization_not_found', 'organization_verification_code_invalid'].includes(code)) return false;
  return ['not_found', 'route_not_found', 'organization_action_invalid'].includes(code)
    || (status === 404 && /接口不存在|route not found|endpoint not found|cannot (?:post|find)/i.test(message))
    || /接口不存在|不支持的组织操作|unsupported organization action|organization action (?:is )?not supported/i.test(message);
}

function isTransientSocialFetchError(error) {
  const code = String(error?.code || error?.cause?.code || '').toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();
  return ['econnreset', 'econnrefused', 'enotfound', 'eai_again', 'etimedout', 'account_workspace_forbidden'].includes(code)
    || /工作空间不存在或你已不在该工作空间中|account workspace (?:is )?(?:forbidden|not found)/.test(message)
    || /fetch failed|network error|socket hang up|connection (?:closed|refused)|timed? out|temporarily unavailable|bad gateway|gateway timeout|\b(?:502|503|504)\b/.test(message);
}
