export function createCloudRuntimeApi({ auth, cloudSync, triggerAutoSync }) {
  return {
    cloudStatus() {
      auth.requireAdmin();
      return cloudSync.status();
    },
    saveCloudConfig(payload = {}) {
      auth.requireAdmin();
      return cloudSync.saveConfig(payload);
    },
    syncCloudNow(payload = {}) {
      auth.requireAdmin();
      return cloudSync.syncNow({ reason: payload.reason || 'manual', auto: false });
    },
    uploadCompliance(payload = {}) {
      auth.requireAdmin();
      return cloudSync.uploadCompliance(payload);
    },
    suspendCloudUser(payload = {}) {
      auth.requireAdmin();
      return cloudSync.suspendCloudUser(payload);
    },
    reactivateCloudUser(payload = {}) {
      auth.requireAdmin();
      return cloudSync.reactivateCloudUser(payload);
    },
    traceCloudFile(payload = {}) {
      auth.requireAdmin();
      return cloudSync.traceFile(payload);
    },
    traceCloudConversation(payload = {}) {
      auth.requireAdmin();
      return cloudSync.traceConversation(payload);
    },
    latestRelease(payload = {}) {
      auth.requireAdmin();
      return cloudSync.latestRelease(payload);
    },
    triggerAutoSync,
  };
}
