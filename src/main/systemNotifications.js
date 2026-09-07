import { execFile } from 'node:child_process';
import { normalizeUiLanguage } from '../shared/uiLanguage.js';

const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off']);

export function createSystemNotificationAvailabilityChecker({
  notificationApi,
  platform = process.platform,
  env = process.env,
  execFileFn = execFile,
  now = () => Date.now(),
  cacheMs = 60_000,
} = {}) {
  let cachedAt = 0;
  let cachedValue = false;
  let pending = null;

  return async function systemNotificationsAvailable() {
    if (DISABLED_VALUES.has(String(env.JANUS_DESKTOP_NOTIFICATIONS || '').trim().toLowerCase())) return false;
    try {
      if (!notificationApi?.isSupported?.()) return false;
    } catch {
      return false;
    }
    if (platform !== 'linux') return true;
    if (!String(env.DBUS_SESSION_BUS_ADDRESS || '').trim()) return false;
    const timestamp = Number(now()) || Date.now();
    if (cachedAt && timestamp - cachedAt < cacheMs) return cachedValue;
    if (pending) return pending;
    pending = probeLinuxNotificationService(execFileFn).then((available) => {
      cachedAt = Number(now()) || Date.now();
      cachedValue = Boolean(available);
      pending = null;
      return cachedValue;
    });
    return pending;
  };
}

export function createNativeNotificationOptions({
  title = 'Janus',
  body = '',
  platform = process.platform,
  icon = '',
} = {}) {
  const options = {
    title: String(title || 'Janus'),
    body: String(body || ''),
    silent: false,
  };
  if (platform === 'darwin') return { ...options, subtitle: 'Janus' };
  if (icon) options.icon = icon;
  if (platform === 'win32') return { ...options, timeoutType: 'default' };
  if (platform === 'linux') return { ...options, urgency: 'normal', timeoutType: 'default' };
  return options;
}

async function probeLinuxNotificationService(execFileFn) {
  const ownerProbes = [
    {
      file: 'gdbus',
      args: [
        'call', '--session',
        '--dest', 'org.freedesktop.DBus',
        '--object-path', '/org/freedesktop/DBus',
        '--method', 'org.freedesktop.DBus.NameHasOwner',
        'org.freedesktop.Notifications',
      ],
    },
    {
      file: 'dbus-send',
      args: [
        '--session', '--print-reply',
        '--dest=org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus.NameHasOwner',
        'string:org.freedesktop.Notifications',
      ],
    },
  ];
  for (const ownerProbe of ownerProbes) {
    const owner = await executeNotificationProbe(execFileFn, ownerProbe);
    if (owner.available === null) continue;
    return owner.available;
  }
  return false;
}

function executeNotificationProbe(execFileFn, probe) {
  return new Promise((resolve) => {
    try {
      execFileFn(
        probe.file,
        probe.args,
        { timeout: 1500, windowsHide: true },
        (error, stdout = '') => {
          if (error) {
            const missing = String(error.code || '').toUpperCase() === 'ENOENT';
            resolve({ available: missing ? null : false });
            return;
          }
          const matches = typeof probe.matches === 'function'
            ? probe.matches(stdout)
            : /\btrue\b/i.test(String(stdout));
          resolve({ available: Boolean(matches) });
        },
      );
    } catch (error) {
      resolve({ available: String(error?.code || '').toUpperCase() === 'ENOENT' ? null : false });
    }
  });
}

export function compactNotificationText(value = '', maxLength = 160) {
  const normalized = String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const limit = Math.max(24, Number(maxLength) || 160);
  return normalized.length > limit ? `${normalized.slice(0, limit - 1).trimEnd()}\u2026` : normalized;
}

export function collaborationTaskNotificationContent(task = {}, language = 'zh-CN') {
  const english = normalizeUiLanguage(language) === 'en';
  const status = String(task.status || '');
  const metadata = task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const untitledTask = english ? 'Untitled Task' : '\u672a\u547d\u540d\u4efb\u52a1';
  const taskTitle = compactNotificationText(task.title || task.instruction || untitledTask, 42) || untitledTask;
  const requester = notificationActorName(task.requester, '');
  const instruction = compactNotificationText(task.instruction || '', 150);
  const failure = compactNotificationText(metadata.publicFailure?.message || task.lastError || task.last_error || '', 150);
  const revision = compactNotificationText(
    metadata.revisionRequest || metadata.revisionInstruction || metadata.requesterFeedback || metadata.feedback || '',
    150,
  );
  const resultSummary = compactNotificationText(
    metadata.preliminaryResult || metadata.resultSummary || metadata.deliverySummary || '',
    150,
  );
  if (status === 'revision_requested') return {
    title: english ? `Revision requested: ${taskTitle}` : `\u4efb\u52a1\u9700\u4fee\u6539\uff1a${taskTitle}`,
    body: revision || (english
      ? `${requester ? `${requester} requested changes. ` : 'Changes were requested. '}Click to view the details.`
      : `${requester ? `${requester}\u5df2\u63d0\u51fa\u4fee\u6539\u8981\u6c42\u3002` : '\u5df2\u6536\u5230\u4fee\u6539\u8981\u6c42\u3002'}\u70b9\u51fb\u67e5\u770b\u5177\u4f53\u5185\u5bb9\u3002`),
  };
  if (['blocked', 'failed'].includes(status)) return {
    title: english ? `Task failed: ${taskTitle}` : `\u4efb\u52a1\u5904\u7406\u5931\u8d25\uff1a${taskTitle}`,
    body: failure || (english ? 'The task encountered a problem. Click to review the failed stage and recovery options.' : '\u4efb\u52a1\u5728\u6267\u884c\u4e2d\u9047\u5230\u95ee\u9898\uff0c\u70b9\u51fb\u67e5\u770b\u5931\u8d25\u9636\u6bb5\u548c\u53ef\u6062\u590d\u64cd\u4f5c\u3002'),
  };
  if (status === 'draft_ready') return {
    title: english ? `Task ready for delivery: ${taskTitle}` : `\u4efb\u52a1\u5f85\u4ea4\u4ed8\uff1a${taskTitle}`,
    body: resultSummary || (english ? 'uBuddy finished the task. Click to review the deliverables.' : 'uBuddy \u5df2\u5b8c\u6210\u5904\u7406\uff0c\u70b9\u51fb\u67e5\u770b\u4ea4\u4ed8\u5185\u5bb9\u3002'),
  };
  if (status === 'preparing') return {
    title: english ? `Task started: ${taskTitle}` : `\u4efb\u52a1\u5df2\u5f00\u59cb\uff1a${taskTitle}`,
    body: english ? 'The assigned uBuddy is working. Click to view live progress.' : '\u8d1f\u8d23\u7684 uBuddy \u6b63\u5728\u5904\u7406\uff0c\u70b9\u51fb\u53ef\u67e5\u770b\u5b9e\u65f6\u8fdb\u5ea6\u3002',
  };
  return {
    title: english ? `New task: ${taskTitle}` : `\u65b0\u4efb\u52a1\uff1a${taskTitle}`,
    body: compactNotificationText(`${requester ? `${requester}${english ? ': ' : '\uff1a'}` : ''}${instruction || (english ? 'Click to view the task requirements.' : '\u70b9\u51fb\u67e5\u770b\u4efb\u52a1\u8981\u6c42\u3002')}`, 160),
  };
}

export function socialMessageNotificationContent(message = {}, language = 'zh-CN') {
  const english = normalizeUiLanguage(language) === 'en';
  const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  const senderName = notificationActorName(message.sender, english ? 'Contact' : '\u8054\u7cfb\u4eba');
  const fromAgent = Boolean(message.senderAgentId || message.sender_agent_id);
  const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
  const withdrawn = metadata.withdrawn === true;
  const content = compactNotificationText(message.content || '', 150);
  const attachmentText = attachments.length ? `${attachments.length} ${english ? (attachments.length === 1 ? 'attachment' : 'attachments') : '\u4e2a\u9644\u4ef6'}` : '';
  return {
    title: english ? (fromAgent ? `${senderName}’s uBuddy sent a message` : `${senderName} sent a message`)
      : (fromAgent ? `${senderName}\u7684 uBuddy \u53d1\u6765\u6d88\u606f` : `${senderName}\u53d1\u6765\u6d88\u606f`),
    body: withdrawn
      ? (english ? 'The sender withdrew a message.' : '\u5bf9\u65b9\u64a4\u56de\u4e86\u4e00\u6761\u6d88\u606f\u3002')
      : compactNotificationText([content, attachmentText].filter(Boolean).join(' \u00b7 '), 160) || (english ? 'Click to open the conversation.' : '\u70b9\u51fb\u6253\u5f00\u5bf9\u8bdd\u3002'),
  };
}

export function agentDeliveryNotificationContent(payload = {}, language = 'zh-CN') {
  const english = normalizeUiLanguage(language) === 'en';
  const receipt = payload.receipt || {};
  const status = String(receipt.deliveryStatus || '');
  if (!['completed', 'failed', 'cancelled'].includes(status)) return null;
  const agentName = compactNotificationText(
    payload.agent?.name || payload.session?.title || payload.notification?.metadata?.targetAgentId || (english ? 'Background Agent' : '\u540e\u53f0 Agent'),
    38,
  );
  const taskName = compactNotificationText(payload.sourceSession?.title || '', 46);
  let detail = compactNotificationText(
    payload.notification?.content || payload.result?.answer || payload.result?.message?.content || payload.error || receipt.metadata?.error || '',
    180,
  );
  detail = detail.replace(/^.{0,80}?(?:\u5df2\u5b8c\u6210\u4efb\u52a1|\u7684\u7ed3\u679c\u9700\u8981\u4fee\u6b63|\u6267\u884c\u5931\u8d25|\u7684\u4efb\u52a1\u5df2\u505c\u6b62)[\uff1a:]\s*/u, '');
  const fallback = status === 'completed'
    ? (english ? 'The result is ready. Click to view the details.' : '\u5de5\u4f5c\u7ed3\u679c\u5df2\u8fd4\u56de\uff0c\u70b9\u51fb\u67e5\u770b\u8be6\u60c5\u3002')
    : status === 'cancelled'
      ? (english ? 'The task was stopped.' : '\u4efb\u52a1\u5df2\u505c\u6b62\u3002')
      : (english ? 'Execution failed. Click to review the cause and recovery options.' : '\u6267\u884c\u5931\u8d25\uff0c\u70b9\u51fb\u67e5\u770b\u539f\u56e0\u548c\u6062\u590d\u64cd\u4f5c\u3002');
  return {
    title: english
      ? (status === 'completed' ? `${agentName} completed the work` : status === 'cancelled' ? `${agentName}’s work was stopped` : `${agentName} failed`)
      : status === 'completed'
      ? `${agentName} \u5df2\u5b8c\u6210\u5de5\u4f5c`
      : status === 'cancelled' ? `${agentName} \u7684\u5de5\u4f5c\u5df2\u505c\u6b62` : `${agentName} \u6267\u884c\u5931\u8d25`,
    body: compactNotificationText(`${taskName ? `${taskName}${english ? ': ' : '\uff1a'}` : ''}${detail || fallback}`, 180),
  };
}

export function applicationUpdateNotificationContent(current = {}, previous = {}, language = 'zh-CN') {
  const english = normalizeUiLanguage(language) === 'en';
  const version = compactNotificationText(current.version || '', 30);
  if (current.downloaded && !previous.downloaded) return {
    title: english ? `Janus ${version ? `${version} ` : ''}is ready to install` : `Janus ${version ? `${version} ` : ''}\u5df2\u51c6\u5907\u5b89\u88c5`,
    body: english ? 'Download and signature verification are complete. Click to open Update Center and install.' : '\u4e0b\u8f7d\u548c\u7b7e\u540d\u6821\u9a8c\u5df2\u5b8c\u6210\uff0c\u70b9\u51fb\u6253\u5f00\u66f4\u65b0\u4e2d\u5fc3\u5b89\u88c5\u3002',
  };
  if (current.available && !previous.available) return {
    title: english ? `Janus ${version ? `${version} ` : ''}update available` : `\u53d1\u73b0 Janus ${version ? `${version} ` : ''}\u66f4\u65b0`,
    body: current.autoDownload
      ? (english ? 'The update is downloading in the background. Click to view progress.' : '\u5df2\u5f00\u59cb\u5728\u540e\u53f0\u4e0b\u8f7d\uff0c\u70b9\u51fb\u67e5\u770b\u66f4\u65b0\u8fdb\u5ea6\u3002')
      : (english ? 'Click to open Update Center, review the version, and download.' : '\u70b9\u51fb\u6253\u5f00\u66f4\u65b0\u4e2d\u5fc3\uff0c\u67e5\u770b\u7248\u672c\u4fe1\u606f\u5e76\u4e0b\u8f7d\u3002'),
  };
  return null;
}

export function agentBundleUpdateNotificationContent(current = {}, previous = {}, language = 'zh-CN') {
  const english = normalizeUiLanguage(language) === 'en';
  const currentBundle = current.current || {};
  const previousBundle = previous.current || {};
  const applied = Boolean(previous.applying && !current.applying && currentBundle.bundleId
    && currentBundle.bundleId !== previousBundle.bundleId);
  if (applied) {
    const version = compactNotificationText(currentBundle.releaseVersion || currentBundle.bundleId || '', 30);
    return {
      title: english ? `Agent organization updated${version ? ` to ${version}` : ''}` : `Agent \u7ec4\u7ec7\u5df2\u66f4\u65b0${version ? `\u81f3 ${version}` : ''}`,
      body: english ? 'New conversations will use the updated Agent organization and capabilities.' : '\u65b0\u5bf9\u8bdd\u5c06\u4f7f\u7528\u66f4\u65b0\u540e\u7684 Agent \u7ec4\u7ec7\u4e0e\u80fd\u529b\u914d\u7f6e\u3002',
    };
  }
  if (current.available && !previous.available) {
    const artifact = current.candidate?.artifact || {};
    const version = compactNotificationText(artifact.releaseVersion || current.candidate?.manifest?.version || artifact.bundleId || '', 30);
    return {
      title: english ? `Agent organization update available${version ? ` ${version}` : ''}` : `\u53d1\u73b0 Agent \u7ec4\u7ec7\u66f4\u65b0${version ? ` ${version}` : ''}`,
      body: english ? 'The update will download, verify, and apply automatically in the background. Click to view progress.' : '\u66f4\u65b0\u5c06\u5728\u540e\u53f0\u4e0b\u8f7d\u3001\u6821\u9a8c\u5e76\u81ea\u52a8\u5e94\u7528\uff0c\u70b9\u51fb\u67e5\u770b\u8fdb\u5ea6\u3002',
    };
  }
  return null;
}

function notificationActorName(user = null, fallback = '\u7528\u6237') {
  return compactNotificationText(
    user?.remark || user?.displayName || user?.display_name || user?.username || user?.email || fallback,
    36,
  ) || fallback;
}
