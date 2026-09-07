export function socialRelayMutationMode({ socialRelay = null, user = null } = {}) {
  if (socialRelay?.connected?.()) return 'remote';
  const cloudIdentityBound = user?.authProvider === 'cloud' || user?.remoteBound === true;
  return cloudIdentityBound ? 'unavailable' : 'local';
}

export function socialRelayUnavailableError() {
  const error = new Error('当前未连接云端，任务尚未发送，请恢复登录或网络连接后重试。');
  error.code = 'social_relay_offline';
  return error;
}
