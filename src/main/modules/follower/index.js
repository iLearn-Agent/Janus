import { FollowerService } from './application/FollowerService.js';
import { FollowerCloudService } from './application/FollowerCloudService.js';
import { FollowerContextBroker } from './infrastructure/context/FollowerContextBroker.js';

export function createFollowerModule(options = {}) {
  const cloudService = options.cloudService || (options.cloudSync ? new FollowerCloudService({
    root: options.root, store: options.store, cloudSync: options.cloudSync, appVersion: options.appVersion,
    deviceId: options.deviceId,
  }) : null);
  const service = new FollowerService({
    ...options,
    cloudService,
    contextBroker: options.contextBroker || new FollowerContextBroker({ store: options.store, org: options.org }),
  });
  return {
    service,
    api: {
      followerOverview: (payload = {}) => service.overview(payload),
      followerAccessUpdate: (payload = {}) => service.updateAccess(payload),
      followerPreferencesUpdate: (payload = {}) => service.updatePreferences(payload),
      followerScheduleUpsert: (payload = {}) => service.upsertSchedule(payload),
      followerSchedulesList: (payload = {}) => service.schedules(payload),
      followerRunCancel: (payload = {}) => service.cancelRun(payload),
      followerRunsList: (payload = {}) => service.runs(payload),
      followerReportsList: (payload = {}) => service.reports(payload),
      followerReportOpen: (payload = {}) => service.report(payload),
      followerReportSources: (payload = {}) => service.reportSources(payload),
      followerReportMarkRead: (payload = {}) => service.markReportRead(payload),
      followerReportDelete: (payload = {}) => service.deleteReport(payload),
      followerFollowupOpen: (payload = {}) => service.openFollowup(payload),
      followerFollowupSend: (payload = {}) => service.sendFollowup(payload),
      followerFollowupCancel: (payload = {}) => service.cancelFollowup(payload),
      followerFollowupDelete: (payload = {}) => service.deleteFollowup(payload),
      followerCloudSettingsUpdate: (payload = {}) => service.updateCloudSettings(payload),
      followerCloudSync: (payload = {}) => service.syncCloud(payload),
      followerFeedbackRecord: (payload = {}) => service.recordFeedback(payload),
      followerEvolutionStatus: (payload = {}) => service.evolutionStatus(payload),
      followerEvolutionRollback: (payload = {}) => service.rollbackEvolution(payload),
      followerEvolutionDecide: (payload = {}) => service.decideEvolution(payload),
      followerNotificationIntents: (payload = {}) => {
        const context = service.context(payload);
        return service.store.listWorkNotificationIntents({ ownerUserId: context.ownerUserId, statuses: payload.statuses || ['pending'], limit: payload.limit || 100 });
      },
      followerNotificationSettle: (payload = {}) => service.store.settleWorkNotificationIntent(payload),
    },
    close: () => service.close(),
  };
}

export { FollowerService } from './application/FollowerService.js';
export { FollowerCloudService } from './application/FollowerCloudService.js';
