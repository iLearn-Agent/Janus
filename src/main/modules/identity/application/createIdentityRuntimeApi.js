import { profileAvatarUrlValidation } from '../../../../shared/profileAvatar.js';
import { passwordValidationMessage } from '../../../../shared/passwordPolicy.js';

function requireCompliantNewPassword(password = '') {
  const message = passwordValidationMessage(password);
  if (message) throw new Error(message);
  return String(password || '');
}

export function createIdentityRuntimeApi({
  auth,
  socialRelay,
  cloudSync,
  currentUser,
  provisionUserDefaults = null,
  onAuthenticationBoundary = null,
}) {
  const syncCloudUser = () => {
    const user = auth.currentUser();
    const syncUserId = user?.remoteBound ? user.remoteId : '';
    const serverUrl = socialRelay.status?.().serverUrl || socialRelay.state?.()?.server_url || '';
    const cloudStatus = cloudSync.status();
    if (syncUserId && (cloudStatus.userId !== syncUserId || (serverUrl && cloudStatus.serverUrl !== serverUrl))) {
      cloudSync.saveConfig({ serverUrl, userId: syncUserId });
    }
  };
  const requestCloudSync = () => {
    const pending = cloudSync.requestAutoSync?.({ reason: 'auth_connected', delayMs: 0 });
    pending?.catch?.(() => null);
  };
  const provisionCurrentUser = () => {
    const user = auth.currentUser();
    if (user?.id && typeof provisionUserDefaults === 'function') provisionUserDefaults({ userId: user.id });
  };
  const completeAuthentication = (result) => {
    syncCloudUser();
    provisionCurrentUser();
    if (typeof onAuthenticationBoundary === 'function') onAuthenticationBoundary({ userId: auth.currentUser()?.id || '', authenticated: true });
    requestCloudSync();
    return result;
  };

  return {
    currentUser,
    authLogin(payload = {}) {
      if (payload.newPassword) requireCompliantNewPassword(payload.newPassword);
      if (socialRelay.enabled()) {
        return socialRelay.login(payload).then(completeAuthentication);
      }
      const result = auth.login(payload);
      return completeAuthentication(result);
    },
    authRegister(payload = {}) {
      requireCompliantNewPassword(payload.password);
      if (socialRelay.enabled()) {
        return socialRelay.register(payload).then(completeAuthentication);
      }
      const result = auth.register(payload);
      return completeAuthentication(result);
    },
    authSendEmailCode(payload = {}) {
      if (socialRelay.enabled()) return socialRelay.sendEmailCode(payload);
      return auth.sendEmailCode(payload);
    },
    authVerifyEmail(payload = {}) {
      if (socialRelay.connected()) return socialRelay.verifyEmail(payload);
      return auth.verifyEmail(payload);
    },
    authResetPasswordByEmail(payload = {}) {
      requireCompliantNewPassword(payload.newPassword);
      if (socialRelay.enabled()) return socialRelay.resetPassword(payload);
      return auth.resetPasswordByEmail(payload);
    },
    async authLogout() {
      const userId = auth.currentUser()?.id || '';
      if (socialRelay.connected()) await socialRelay.logout();
      const result = auth.logout();
      if (typeof onAuthenticationBoundary === 'function') onAuthenticationBoundary({ userId, authenticated: false });
      return result;
    },
    authProfile: () => auth.profile(),
    async authUpdateProfile(payload = {}) {
      const current = auth.requireUser();
      let scopedPayload = current.remoteBound
        ? { ...payload, email: current.email }
        : payload;
      const avatarProvided = Object.hasOwn(scopedPayload, 'avatarUrl') || Object.hasOwn(scopedPayload, 'avatar_url');
      const requestedAvatar = String(scopedPayload.avatarUrl ?? scopedPayload.avatar_url ?? '').trim();
      const currentAvatar = String(current.avatarUrl || current.avatar_url || '').trim();
      if (avatarProvided && requestedAvatar === currentAvatar && !profileAvatarUrlValidation(requestedAvatar).valid) {
        scopedPayload = { ...scopedPayload };
        delete scopedPayload.avatarUrl;
        delete scopedPayload.avatar_url;
      }
      if (socialRelay.connected()) {
        try {
          const updated = await socialRelay.updateProfile(scopedPayload);
          auth.markProfileUpdateCompleted?.(current.id);
          return updated;
        } catch (error) {
          if (!retryableProfileUpdateError(error)) throw error;
        }
      }
      const local = auth.updateProfile(scopedPayload);
      if (current.remoteBound && socialRelay.enabled()) {
        const portableAvatar = profileAvatarUrlValidation(local.avatarUrl || local.avatar_url || '');
        auth.queueProfileUpdate({ userId: current.id, payload: {
          displayName: local.displayName || local.display_name || '',
          email: local.email || current.email || '',
          username: local.username || '',
          ...(portableAvatar.valid ? { avatarUrl: portableAvatar.value } : {}),
        } });
      }
      return { ...local, profileSyncPending: Boolean(current.remoteBound && socialRelay.enabled()) };
    },
    authUpdatePassword(payload = {}) {
      requireCompliantNewPassword(payload.newPassword);
      if (socialRelay.connected()) return socialRelay.updatePassword(payload);
      return auth.updatePassword(payload);
    },
    adminListUsers: () => auth.listUsers(),
    adminUpdateUserRole: ({ userId = '', role = '' } = {}) => auth.updateUserRole(userId, role),
    adminResetUserPassword: ({ userId = '' } = {}) => auth.resetUserPassword(userId),
    adminDeleteUser: ({ userId = '' } = {}) => auth.deleteUser(userId),
  };
}

function retryableProfileUpdateError(error) {
  const status = Number(error?.status || 0);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  if (status >= 400 && status < 500) return false;
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();
  return ['econnreset', 'econnrefused', 'enotfound', 'eai_again', 'etimedout'].includes(code)
    || /fetch failed|network error|socket hang up|connection (?:closed|refused)|timed? out|temporarily unavailable/.test(message);
}
