import { createBufferedSubscriber } from './bufferedSubscriber.js';

export function createFollowerPreloadBridge(ipcRenderer) {
  const updates = createBufferedSubscriber();
  ipcRenderer.on('follower:updated', (_event, payload) => updates.emit(payload));
  return {
    followerOverview: (payload = {}) => ipcRenderer.invoke('follower:overview', payload),
    followerAccessUpdate: (payload = {}) => ipcRenderer.invoke('follower:access-update', payload),
    followerPreferencesUpdate: (payload = {}) => ipcRenderer.invoke('follower:preferences-update', payload),
    followerScheduleUpsert: (payload = {}) => ipcRenderer.invoke('follower:schedule-upsert', payload),
    followerSchedulesList: (payload = {}) => ipcRenderer.invoke('follower:schedules-list', payload),
    followerRunCancel: (payload = {}) => ipcRenderer.invoke('follower:run-cancel', payload),
    followerRunsList: (payload = {}) => ipcRenderer.invoke('follower:runs-list', payload),
    followerReportsList: (payload = {}) => ipcRenderer.invoke('follower:reports-list', payload),
    followerReportOpen: (payload = {}) => ipcRenderer.invoke('follower:report-open', payload),
    followerReportSources: (payload = {}) => ipcRenderer.invoke('follower:report-sources', payload),
    followerReportMarkRead: (payload = {}) => ipcRenderer.invoke('follower:report-mark-read', payload),
    followerReportDelete: (payload = {}) => ipcRenderer.invoke('follower:report-delete', payload),
    followerFollowupOpen: (payload = {}) => ipcRenderer.invoke('follower:followup-open', payload),
    followerFollowupSend: (payload = {}) => ipcRenderer.invoke('follower:followup-send', payload),
    followerFollowupCancel: (payload = {}) => ipcRenderer.invoke('follower:followup-cancel', payload),
    followerFollowupDelete: (payload = {}) => ipcRenderer.invoke('follower:followup-delete', payload),
    followerCloudSettingsUpdate: (payload = {}) => ipcRenderer.invoke('follower:cloud-settings-update', payload),
    followerCloudSync: (payload = {}) => ipcRenderer.invoke('follower:cloud-sync', payload),
    followerFeedbackRecord: (payload = {}) => ipcRenderer.invoke('follower:feedback-record', payload),
    followerEvolutionStatus: (payload = {}) => ipcRenderer.invoke('follower:evolution-status', payload),
    followerEvolutionRollback: (payload = {}) => ipcRenderer.invoke('follower:evolution-rollback', payload),
    followerEvolutionDecide: (payload = {}) => ipcRenderer.invoke('follower:evolution-decide', payload),
    onFollowerUpdated: (callback) => updates.subscribe(callback),
  };
}
