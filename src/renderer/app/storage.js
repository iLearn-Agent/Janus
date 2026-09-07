const COMPOSER_RECENT_EMOJIS_KEY = 'janus-composer-recent-emojis';
const COMPOSER_FAVORITE_EMOJIS_KEY = 'janus-composer-favorite-emojis-v1';

export function loadComposerFavoriteEmojis() {
  try {
    const value = JSON.parse(window.localStorage?.getItem(COMPOSER_FAVORITE_EMOJIS_KEY) || '[]');
    return Array.isArray(value) ? value.slice(0, 300) : [];
  } catch {
    return [];
  }
}

export function saveComposerFavoriteEmojis(value = []) {
  try {
    window.localStorage?.setItem(COMPOSER_FAVORITE_EMOJIS_KEY, JSON.stringify((Array.isArray(value) ? value : []).slice(0, 300)));
  } catch {
    // Local storage can be unavailable in restricted renderer contexts.
  }
}

export function loadComposerRecentEmojis() {
  try {
    const value = JSON.parse(window.localStorage?.getItem(COMPOSER_RECENT_EMOJIS_KEY) || '[]');
    return Array.isArray(value)
      ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 24)
      : [];
  } catch {
    return [];
  }
}

export function saveComposerRecentEmojis(value = []) {
  try {
    const safeValue = [...new Set((Array.isArray(value) ? value : [])
      .map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 24);
    window.localStorage?.setItem(COMPOSER_RECENT_EMOJIS_KEY, JSON.stringify(safeValue));
  } catch {
    // Local storage can be unavailable in restricted renderer contexts.
  }
}

export function loadThemeMode() {
  try {
    return window.localStorage?.getItem('janus-theme-mode') === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function saveThemeMode(value) {
  try {
    window.localStorage?.setItem('janus-theme-mode', value);
  } catch {
    // Local storage can be unavailable in restricted renderer contexts.
  }
}

export function loadLanguageMode() {
  try {
    const declaredDefault = document.documentElement?.dataset?.defaultLanguage;
    if (!declaredDefault) return 'zh-CN';
    const stored = window.localStorage?.getItem('janus-language-mode');
    if (stored === 'zh-CN' || stored === 'en') return stored;
    return declaredDefault === 'en' ? 'en' : 'zh-CN';
  } catch {
    return 'en';
  }
}

export function saveLanguageMode(value) {
  try {
    if (['en', 'zh-CN'].includes(value)) window.localStorage?.setItem('janus-language-mode', value);
  } catch {
    // Local storage can be unavailable in restricted renderer contexts.
  }
}

const UPDATE_ANNOUNCEMENT_PREFERENCES_KEY = 'janus-update-announcement-preferences-v1';

export function loadUpdateAnnouncementPreferences() {
  try {
    const value = JSON.parse(window.localStorage?.getItem(UPDATE_ANNOUNCEMENT_PREFERENCES_KEY) || '{}');
    return {
      autoPopup: value?.autoPopup !== false,
      lastSeenInstalledVersion: String(value?.lastSeenInstalledVersion || '').trim().slice(0, 40),
      lastSeenAvailableVersion: String(value?.lastSeenAvailableVersion || '').trim().slice(0, 40),
    };
  } catch {
    return { autoPopup: true, lastSeenInstalledVersion: '', lastSeenAvailableVersion: '' };
  }
}

export function saveUpdateAnnouncementPreferences(value = {}) {
  try {
    window.localStorage?.setItem(UPDATE_ANNOUNCEMENT_PREFERENCES_KEY, JSON.stringify({
      autoPopup: value.autoPopup !== false,
      lastSeenInstalledVersion: String(value.lastSeenInstalledVersion || '').trim().slice(0, 40),
      lastSeenAvailableVersion: String(value.lastSeenAvailableVersion || '').trim().slice(0, 40),
    }));
  } catch {
    // Update announcement preferences are best-effort in restricted renderer contexts.
  }
}

export function loadRunLogVisible() {
  try {
    return window.localStorage?.getItem('janus-run-log-visible') !== 'false';
  } catch {
    return true;
  }
}

export function saveRunLogVisible(value) {
  try {
    window.localStorage?.setItem('janus-run-log-visible', value ? 'true' : 'false');
  } catch {
    // Local storage can be unavailable in restricted renderer contexts.
  }
}

export function loadSandboxPermission() {
  try {
    const value = window.localStorage?.getItem('janus-sandbox-permission');
    return ['request-approval', 'auto-approve', 'full-access'].includes(value) ? value : 'request-approval';
  } catch {
    return 'request-approval';
  }
}

export function saveSandboxPermission(value) {
  try {
    if (['request-approval', 'auto-approve', 'full-access'].includes(value)) {
      window.localStorage?.setItem('janus-sandbox-permission', value);
    }
  } catch {
    // Local storage can be unavailable in restricted renderer contexts.
  }
}

export function loadPrivateAssistantPermission() {
  try {
    const value = window.localStorage?.getItem('janus-private-assistant-permission');
    return ['request-approval', 'task-workspace'].includes(value) ? value : 'request-approval';
  } catch {
    return 'request-approval';
  }
}

export function savePrivateAssistantPermission(value) {
  try {
    if (['request-approval', 'task-workspace'].includes(value)) {
      window.localStorage?.setItem('janus-private-assistant-permission', value);
    }
  } catch {
    // Local storage can be unavailable in restricted renderer contexts.
  }
}

const NETWORK_DIRECTORY_SECTIONS_KEY = 'janus-network-directory-sections-v1';

export function loadNetworkDirectorySectionsOpen() {
  const defaults = { requests: true, groups: false, contacts: true };
  try {
    const value = JSON.parse(window.localStorage?.getItem(NETWORK_DIRECTORY_SECTIONS_KEY) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
    return {
      requests: value.requests !== false,
      groups: value.groups === true,
      contacts: value.contacts !== false,
    };
  } catch {
    return defaults;
  }
}

export function saveNetworkDirectorySectionsOpen(value = {}) {
  try {
    window.localStorage?.setItem(NETWORK_DIRECTORY_SECTIONS_KEY, JSON.stringify({
      requests: value.requests !== false,
      groups: value.groups === true,
      contacts: value.contacts !== false,
    }));
  } catch {
    // Directory preferences are best-effort in restricted renderer contexts.
  }
}

const DIRECTORY_STARS_STORAGE_KEY = 'janus-directory-stars-v1';
const GROUP_DIRECTORY_PREFERENCES_KEY = 'janus-group-directory-preferences-v1';
const RECENT_ACCOUNT_WORKSPACES_STORAGE_KEY = 'janus-recent-account-workspaces-v1';

function recentAccountWorkspacesStorageKey(userId = '') {
  const scope = String(userId || '').trim().replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 160);
  return scope ? `${RECENT_ACCOUNT_WORKSPACES_STORAGE_KEY}:${scope}` : '';
}

function normalizeRecentAccountWorkspaceIds(value = []) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim().slice(0, 200))
    .filter(Boolean))].slice(0, 100);
}

export function loadRecentAccountWorkspaceIds(userId = '') {
  try {
    const key = recentAccountWorkspacesStorageKey(userId);
    if (!key) return [];
    return normalizeRecentAccountWorkspaceIds(JSON.parse(window.localStorage?.getItem(key) || '[]'));
  } catch {
    return [];
  }
}

export function saveRecentAccountWorkspaceIds(userId = '', value = []) {
  try {
    const key = recentAccountWorkspacesStorageKey(userId);
    if (!key) return;
    window.localStorage?.setItem(key, JSON.stringify(normalizeRecentAccountWorkspaceIds(value)));
  } catch {
    // Recent workspaces are best-effort local navigation data.
  }
}

function directoryStarsStorageKey(userId = '') {
  const scope = String(userId || '').trim().replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 160);
  return scope ? `${DIRECTORY_STARS_STORAGE_KEY}:${scope}` : '';
}

function normalizeDirectoryStarIds(value = []) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim().slice(0, 160))
    .filter(Boolean))].slice(0, 500);
}

function normalizeContactStarOverrides(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([id, starred]) => [String(id || '').trim().slice(0, 160), starred])
    .filter(([id, starred]) => id && typeof starred === 'boolean')
    .slice(0, 500));
}

export function loadDirectoryStars(userId = '') {
  try {
    const key = directoryStarsStorageKey(userId);
    if (!key) return { contacts: {}, employees: [] };
    const value = JSON.parse(window.localStorage?.getItem(key) || '{}');
    return {
      contacts: normalizeContactStarOverrides(value?.contacts),
      employees: normalizeDirectoryStarIds(value?.employees),
    };
  } catch {
    return { contacts: {}, employees: [] };
  }
}

export function saveDirectoryStars(userId = '', value = {}) {
  try {
    const key = directoryStarsStorageKey(userId);
    if (!key) return;
    window.localStorage?.setItem(key, JSON.stringify({
      contacts: normalizeContactStarOverrides(value?.contacts),
      employees: normalizeDirectoryStarIds(value?.employees),
    }));
  } catch {
    // Directory star preferences are best-effort in restricted renderer contexts.
  }
}

function groupDirectoryPreferencesStorageKey(userId = '') {
  const scope = String(userId || '').trim().replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 160);
  return scope ? `${GROUP_DIRECTORY_PREFERENCES_KEY}:${scope}` : '';
}

function normalizeGroupPreferenceMap(value = {}, { booleanValues = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([id, preference]) => {
    const cleanId = String(id || '').trim().slice(0, 200);
    const cleanValue = booleanValues ? preference === true : String(preference || '').trim().slice(0, 80);
    return [cleanId, cleanValue];
  }).filter(([id, preference]) => id && (booleanValues ? preference === true : Boolean(preference))).slice(0, 500));
}

export function loadGroupDirectoryPreferences(userId = '') {
  try {
    const key = groupDirectoryPreferencesStorageKey(userId);
    if (!key) return { starred: {}, remarks: {} };
    const value = JSON.parse(window.localStorage?.getItem(key) || '{}');
    return {
      starred: normalizeGroupPreferenceMap(value?.starred, { booleanValues: true }),
      remarks: normalizeGroupPreferenceMap(value?.remarks),
    };
  } catch {
    return { starred: {}, remarks: {} };
  }
}

export function saveGroupDirectoryPreferences(userId = '', value = {}) {
  try {
    const key = groupDirectoryPreferencesStorageKey(userId);
    if (!key) return;
    window.localStorage?.setItem(key, JSON.stringify({
      starred: normalizeGroupPreferenceMap(value?.starred, { booleanValues: true }),
      remarks: normalizeGroupPreferenceMap(value?.remarks),
    }));
  } catch {
    // Group directory preferences are best-effort in restricted renderer contexts.
  }
}

export function loadRememberedLoginIdentifier() {
  try {
    return String(window.localStorage?.getItem('janus-last-login-identifier') || '').trim().slice(0, 254);
  } catch {
    return '';
  }
}

export function saveRememberedLoginIdentifier(value) {
  try {
    const identifier = String(value || '').trim().slice(0, 254);
    if (identifier) window.localStorage?.setItem('janus-last-login-identifier', identifier);
  } catch {
    // Local storage can be unavailable in restricted renderer contexts.
  }
}

const COMPOSER_DRAFTS_STORAGE_KEY = 'janus-composer-drafts-v1';

function composerDraftsStorageKey(userId = '') {
  const scope = String(userId || '').trim().replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 160);
  return scope ? `${COMPOSER_DRAFTS_STORAGE_KEY}:${scope}` : '';
}

export function loadComposerDrafts(userId = '') {
  try {
    const key = composerDraftsStorageKey(userId);
    if (!key) return {};
    const value = JSON.parse(window.localStorage?.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function saveComposerDrafts(userId = '', value = {}) {
  try {
    const key = composerDraftsStorageKey(userId);
    if (!key) return;
    const safeValue = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    window.localStorage?.setItem(key, JSON.stringify(safeValue));
  } catch {
    // Draft persistence is best-effort in restricted renderer contexts.
  }
}

const COMPLETED_CONVERSATIONS_STORAGE_KEY = 'janus-completed-conversations-v1';
const COMPLETED_CONVERSATION_TIMES_STORAGE_KEY = 'janus-completed-conversation-times-v1';

function completedConversationsStorageKey(userId = '') {
  const scope = String(userId || '').trim().replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 160);
  return scope ? `${COMPLETED_CONVERSATIONS_STORAGE_KEY}:${scope}` : '';
}

export function loadCompletedConversationKeys(userId = '') {
  try {
    const key = completedConversationsStorageKey(userId);
    if (!key) return [];
    const value = JSON.parse(window.localStorage?.getItem(key) || '[]');
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 500);
  } catch {
    return [];
  }
}

export function saveCompletedConversationKeys(userId = '', value = []) {
  try {
    const key = completedConversationsStorageKey(userId);
    if (!key) return;
    const safeValue = [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 500);
    window.localStorage?.setItem(key, JSON.stringify(safeValue));
  } catch {
    // Conversation grouping is best-effort in restricted renderer contexts.
  }
}

export function loadCompletedConversationTimes(userId = '') {
  try {
    const scope = String(userId || '').trim().replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 160);
    if (!scope) return {};
    const value = JSON.parse(window.localStorage?.getItem(`${COMPLETED_CONVERSATION_TIMES_STORAGE_KEY}:${scope}`) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value)
      .map(([key, timestamp]) => [String(key || '').trim(), Number(timestamp || 0)])
      .filter(([key, timestamp]) => key && Number.isFinite(timestamp) && timestamp > 0)
      .slice(0, 500));
  } catch {
    return {};
  }
}

export function saveCompletedConversationTimes(userId = '', value = {}) {
  try {
    const scope = String(userId || '').trim().replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 160);
    if (!scope) return;
    const safeValue = Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
      .map(([key, timestamp]) => [String(key || '').trim(), Number(timestamp || 0)])
      .filter(([key, timestamp]) => key && Number.isFinite(timestamp) && timestamp > 0)
      .slice(0, 500));
    window.localStorage?.setItem(`${COMPLETED_CONVERSATION_TIMES_STORAGE_KEY}:${scope}`, JSON.stringify(safeValue));
  } catch {
    // Conversation grouping is best-effort in restricted renderer contexts.
  }
}

const CONVERSATION_GROUPS_STORAGE_KEY = 'janus-conversation-groups-v1';

function conversationGroupsStorageKey(userId = '') {
  const scope = String(userId || '').trim().replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 160);
  return scope ? `${CONVERSATION_GROUPS_STORAGE_KEY}:${scope}` : '';
}

function normalizeConversationKeys(value = []) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 500);
}

export function loadConversationGroups(userId = '') {
  try {
    const key = conversationGroupsStorageKey(userId);
    if (!key) return { marked: [], unread: [] };
    const value = JSON.parse(window.localStorage?.getItem(key) || '{}');
    return {
      marked: normalizeConversationKeys(value?.marked),
      unread: normalizeConversationKeys(value?.unread),
    };
  } catch {
    return { marked: [], unread: [] };
  }
}

export function saveConversationGroups(userId = '', value = {}) {
  try {
    const key = conversationGroupsStorageKey(userId);
    if (!key) return;
    window.localStorage?.setItem(key, JSON.stringify({
      marked: normalizeConversationKeys(value?.marked),
      unread: normalizeConversationKeys(value?.unread),
    }));
  } catch {
    // Conversation grouping is best-effort in restricted renderer contexts.
  }
}

const MESSAGE_PANEL_WIDTH_STORAGE_KEY = 'janus-message-panel-width-v1';
const CONVERSATION_ZOOM_STORAGE_KEY = 'janus-conversation-zoom-v1';
const MESSAGE_DEFAULT_ORDER_STORAGE_KEY = 'janus-message-default-order-v1';

function messageDefaultOrderStorageKey(scope = '') {
  const normalized = String(scope || '').trim().replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 200);
  return normalized ? `${MESSAGE_DEFAULT_ORDER_STORAGE_KEY}:${normalized}` : '';
}

function normalizeMessageDefaultOrder(value = []) {
  const normalized = [...new Set((Array.isArray(value) ? value : [])
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0 && item < 3))];
  for (let index = 0; index < 3; index += 1) {
    if (!normalized.includes(index)) normalized.push(index);
  }
  return normalized.slice(0, 3);
}

export function loadMessageDefaultOrder(scope = '') {
  try {
    const key = messageDefaultOrderStorageKey(scope);
    if (!key) return [0, 1, 2];
    return normalizeMessageDefaultOrder(JSON.parse(window.localStorage?.getItem(key) || '[]'));
  } catch {
    return [0, 1, 2];
  }
}

export function saveMessageDefaultOrder(scope = '', value = []) {
  try {
    const key = messageDefaultOrderStorageKey(scope);
    if (!key) return;
    window.localStorage?.setItem(key, JSON.stringify(normalizeMessageDefaultOrder(value)));
  } catch {
    // Message Home ordering is a best-effort Workspace preference.
  }
}

export function loadConversationZoomPercent() {
  try {
    const value = Number(window.localStorage?.getItem(CONVERSATION_ZOOM_STORAGE_KEY));
    return [80, 90, 100, 110, 125, 140, 160].includes(value) ? value : 100;
  } catch {
    return 100;
  }
}

export function saveConversationZoomPercent(value) {
  try {
    const zoom = [80, 90, 100, 110, 125, 140, 160].includes(Number(value)) ? Number(value) : 100;
    window.localStorage?.setItem(CONVERSATION_ZOOM_STORAGE_KEY, String(zoom));
  } catch {
    // Conversation reading preferences are best-effort in restricted renderer contexts.
  }
}

export function loadMessagePanelWidth() {
  try {
    const value = Number(window.localStorage?.getItem(MESSAGE_PANEL_WIDTH_STORAGE_KEY));
    return Number.isFinite(value) ? Math.min(520, Math.max(280, Math.round(value))) : 360;
  } catch {
    return 360;
  }
}

export function saveMessagePanelWidth(value) {
  try {
    const width = Math.min(520, Math.max(280, Math.round(Number(value) || 360)));
    window.localStorage?.setItem(MESSAGE_PANEL_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Layout preference persistence is best-effort in restricted renderer contexts.
  }
}

const CONTACTS_LIST_RATIO_STORAGE_KEY = 'janus-contacts-list-ratio-v1';

export function loadContactsListRatio() {
  try {
    const stored = window.localStorage?.getItem(CONTACTS_LIST_RATIO_STORAGE_KEY);
    if (stored === null || stored === undefined || stored === '') return .38;
    const value = Number(stored);
    return Number.isFinite(value) ? Math.min(.72, Math.max(.18, value)) : .38;
  } catch {
    return .38;
  }
}

export function saveContactsListRatio(value) {
  try {
    const ratio = Math.min(.72, Math.max(.18, Number(value) || .38));
    window.localStorage?.setItem(CONTACTS_LIST_RATIO_STORAGE_KEY, String(ratio));
  } catch {
    // Layout preference persistence is best-effort in restricted renderer contexts.
  }
}

const ORGANIZATION_SHARE_LINKS_STORAGE_KEY = 'janus-organization-share-links-v1';

function organizationShareLinksStorageKey(userId = '') {
  const scope = String(userId || '').trim().replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 160);
  return scope ? `${ORGANIZATION_SHARE_LINKS_STORAGE_KEY}:${scope}` : '';
}

export function loadOrganizationShareLinks(userId = '') {
  try {
    const key = organizationShareLinksStorageKey(userId);
    if (!key) return {};
    const stored = JSON.parse(window.localStorage?.getItem(key) || '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored)
      .map(([organizationId, link]) => [String(organizationId || '').trim(), String(link || '').trim()])
      .filter(([organizationId, link]) => organizationId && link.startsWith('janus://organization/join?'))
      .slice(0, 100));
  } catch {
    return {};
  }
}

export function saveOrganizationShareLinks(userId = '', value = {}) {
  try {
    const key = organizationShareLinksStorageKey(userId);
    if (!key) return;
    const safeValue = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    window.localStorage?.setItem(key, JSON.stringify(Object.fromEntries(Object.entries(safeValue)
      .map(([organizationId, link]) => [String(organizationId || '').trim(), String(link || '').trim()])
      .filter(([organizationId, link]) => organizationId && link.startsWith('janus://organization/join?'))
      .slice(0, 100))));
  } catch {
    // Organization share links are best-effort local convenience data.
  }
}
