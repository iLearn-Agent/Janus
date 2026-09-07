import { RELEASE_ANNOUNCEMENTS, releaseAnnouncementForVersion, releaseAnnouncementsThrough } from '../../../shared/releaseAnnouncements.js';
import { state } from '../state.js';
import { iconSvg } from '../ui/icons.js';
import { escapeAttr, escapeHtml } from '../utils/format.js';

export function renderUpdateAnnouncementDialog() {
  const dialog = state.updateAnnouncementDialog;
  if (!dialog) return '';
  const version = String(dialog.version || state.updates?.version || state.appVersion || '').trim();
  const localAnnouncement = releaseAnnouncementForVersion(version);
  const fallback = remoteReleaseAnnouncement(version, state.updates?.releaseNotes);
  const detailed = dialog.detail === true;
  const mode = String(dialog.mode || 'history');
  const announcement = localizedAnnouncement(withCurrentReleaseDate(
    localAnnouncement || fallback || fallbackReleaseAnnouncement(version, mode),
    version,
  ));
  const title = mode === 'available'
    ? `发现 Janus ${version || '新版本'}`
    : mode === 'installed'
      ? `Janus ${version || ''} 已更新`
      : 'Janus 更新日志';
  return `<div class="update-announcement-overlay" data-update-announcement-dismiss>
    <section class="update-announcement-dialog ${detailed ? 'is-detailed' : 'is-summary'}" role="dialog" aria-modal="true" aria-labelledby="update-announcement-title">
      <header>
        <span class="update-announcement-icon">${iconSvg(mode === 'installed' ? 'check' : 'spark')}</span>
        <div><small>${mode === 'available' ? '软件更新' : mode === 'installed' ? '更新完成' : '版本记录'}</small><h2 id="update-announcement-title">${escapeHtml(title)}</h2></div>
        <button type="button" data-update-announcement-close aria-label="关闭">${iconSvg('x')}</button>
      </header>
      ${detailed ? renderDetailedReleaseNotes(version, announcement) : renderReleaseSummary(version, announcement, mode)}
      <footer>
        <label class="update-announcement-popup-choice"><input type="checkbox" data-update-announcement-auto-popup ${state.updateAnnouncementAutoPopup ? 'checked' : ''}><span>检测到更新时自动显示公告</span></label>
        <div>
          ${detailed && mode !== 'history' ? '<button class="btn secondary" type="button" data-update-announcement-summary>返回摘要</button>' : ''}
          ${detailed ? '' : '<button class="btn secondary" type="button" data-update-announcement-details>查看详细更新日志</button>'}
          ${renderUpdateAction(mode)}
          <button class="btn ${mode === 'history' || detailed ? 'primary' : 'secondary'}" type="button" data-update-announcement-close>${mode === 'history' ? '完成' : '稍后'}</button>
        </div>
      </footer>
    </section>
  </div>`;
}

function renderReleaseSummary(version = '', announcement = null, mode = 'history') {
  const summary = announcement?.summary || (mode === 'available'
    ? '新版本已经可以获取，可在这里直接开始更新，也可以稍后前往设置中的更新中心。'
    : '本次更新已经安装完成，下面是主要变化。');
  const highlights = Array.isArray(announcement?.highlights) ? announcement.highlights.slice(0, 6) : [];
  return `<div class="update-announcement-summary">
    <div class="update-announcement-version"><strong>${escapeHtml(announcement?.title || `Janus ${version}`)}</strong>${renderReleaseDate(announcement?.date)}</div>
    <p>${escapeHtml(summary)}</p>
    ${highlights.length ? `<ul>${highlights.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
    ${mode === 'available' ? renderUpdateReadiness() : ''}
  </div>`;
}

function renderDetailedReleaseNotes(version = '', currentAnnouncement = null) {
  const announcements = releaseAnnouncementsThrough(version)
    .map((announcement) => withCurrentReleaseDate(announcement, announcement.version))
    .map(localizedAnnouncement);
  const entries = currentAnnouncement && !releaseAnnouncementForVersion(currentAnnouncement.version)
    ? [currentAnnouncement, ...announcements]
    : announcements.length ? announcements : [...RELEASE_ANNOUNCEMENTS].map(localizedAnnouncement);
  return `<div class="update-announcement-details" data-preserve-scroll data-scroll-key="update-changelog">
    ${entries.map((announcement) => `<article class="update-release-entry ${announcement.version === version ? 'is-current' : ''}">
      <header><div><span>版本 ${escapeHtml(announcement.version || '')}</span><h3>${escapeHtml(announcement.title || '版本更新')}</h3></div>${renderReleaseDate(announcement.date)}</header>
      <p>${escapeHtml(announcement.summary || '')}</p>
      ${(announcement.sections || []).map((section) => `<section><h4>${escapeHtml(section.title || '更新内容')}</h4><ul>${(section.items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>`).join('')}
    </article>`).join('')}
  </div>`;
}

function renderUpdateReadiness() {
  const update = state.updates || {};
  if (update.installing) return '<div class="update-announcement-readiness is-working">正在启动安装，Janus 即将重启。</div>';
  if (update.downloaded) return '<div class="update-announcement-readiness is-ready">更新包已下载并通过校验，可以安装。</div>';
  if (update.downloading) return `<div class="update-announcement-readiness is-working">正在下载更新${Number.isFinite(update.downloadProgress) ? ` · ${Math.round(update.downloadProgress)}%` : ''}</div>`;
  return '<div class="update-announcement-readiness">更新可用，下载期间仍可继续使用 Janus。</div>';
}

function renderUpdateAction(mode = 'history') {
  if (mode !== 'available') return '';
  const update = state.updates || {};
  if (update.installing) return '<button class="btn primary" type="button" disabled>正在安装</button>';
  if (update.downloaded) return '<button class="btn primary" type="button" data-update-announcement-install>安装并重启</button>';
  if (update.downloading) return `<button class="btn primary" type="button" disabled>下载中${Number.isFinite(update.downloadProgress) ? ` ${Math.round(update.downloadProgress)}%` : ''}</button>`;
  return '<button class="btn primary" type="button" data-update-announcement-download>下载更新</button>';
}

function remoteReleaseAnnouncement(version = '', releaseNotes = null) {
  const lines = normalizeRemoteReleaseNotes(releaseNotes);
  if (!lines.length) return null;
  return {
    version,
    title: `Janus ${version}`,
    summary: lines[0],
    highlights: lines.slice(0, 6),
    sections: [{ title: '更新内容', items: lines }],
  };
}

function fallbackReleaseAnnouncement(version = '', mode = 'history') {
  return {
    version,
    title: `Janus ${version}`,
    summary: mode === 'available'
      ? '新版本已经可以获取，可在这里直接开始更新，也可以稍后前往设置中的更新中心。'
      : '本次更新包含产品体验改进与可靠性修复。',
    highlights: [],
    sections: [],
  };
}

function withCurrentReleaseDate(announcement = null, version = '') {
  if (!announcement) return announcement;
  const currentVersion = String(state.updates?.version || '').trim().replace(/^v/i, '');
  const requestedVersion = String(version || announcement.version || '').trim().replace(/^v/i, '');
  const remoteDate = currentVersion && currentVersion === requestedVersion
    ? String(state.updates?.releaseDate || '').trim()
    : '';
  return {
    ...announcement,
    version: announcement.version || version,
    date: remoteDate || announcement.date || '',
  };
}

function renderReleaseDate(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const formatted = formatReleaseDate(raw);
  const label = state.languageMode === 'en' ? 'Released' : '发布时间';
  const separator = state.languageMode === 'en' ? ': ' : '：';
  return `<time datetime="${escapeAttr(raw)}">${escapeHtml(label)}${separator}${escapeHtml(formatted)}</time>`;
}

export function formatReleaseDate(value = '', now = new Date()) {
  const raw = String(value || '').trim();
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;

  // A date-only announcement has no trustworthy release time. Keep it as a
  // calendar date instead of presenting midnight as an exact publication time.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    if (state.languageMode !== 'en') {
      return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
    }
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  }

  const reference = now instanceof Date ? now : new Date(now);
  const sameDay = !Number.isNaN(reference.getTime())
    && date.getFullYear() === reference.getFullYear()
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return time;

  if (state.languageMode !== 'en') {
    const year = date.getFullYear() === reference.getFullYear() ? '' : `${date.getFullYear()}年`;
    return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  }
  const dateOptions = date.getFullYear() === reference.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  return `${new Intl.DateTimeFormat('en-US', dateOptions).format(date)}, ${time}`;
}

export const ENGLISH_RELEASES = Object.freeze({
  '1.1.0': {
    title: 'Follower Beta and a Rebuilt Collaboration Experience',
    summary: 'Introducing Follower Beta, a rebuilt uBuddy interface and workflow, more reliable PPT delivery, customizable desktop behavior, and a broad set of product and UI fixes.',
    highlights: [
      'Introducing Follower Beta for on-demand or scheduled daily briefs, weekly reviews, and growth guidance based on tasks, conversations, and project activity.',
      'Rebuilt the connection between uBuddy UI state and task workflows for clearer, more reliable planning, execution, progress, clarification, and delivery.',
      'Fixed issues across PPT content generation, imagery, rendering, preview, and file delivery, with stronger failure recovery.',
      'Added customizable window-close behavior: keep Janus running in the background or quit the app.',
      'Improved messaging, tasks, contacts, file previews, notification navigation, and localization while fixing a broad set of functional and UI issues.',
    ],
    sections: [
      {
        title: 'Follower Beta',
        items: [
          'Added the Follower Beta assistant to surface important progress from Agent tasks, conversations, and project changes you are allowed to access.',
          'Generate daily briefs, weekly reviews, and growth guidance on demand or on a local schedule, with report history and unread notifications in one place.',
          'Review the sources behind report claims and suggestions. Follower has read-only access to visible content and never changes original tasks, messages, or files.',
          'Ask follow-up questions, rate report usefulness, and sync reports and preference-evolution state when cloud services are connected.',
        ],
      },
      {
        title: 'Rebuilt uBuddy Collaboration',
        items: [
          'Reworked the coupling between uBuddy UI state and task behavior to prevent stale, misplaced, or duplicate feedback after conversation switches, refreshes, and task transitions.',
          'Unified status presentation across intake, clarification, planning, Agent allocation, execution, quality review, and final delivery.',
          'Improved task drafts, private workspaces, source-message navigation, progress updates, and recovery from long-running tasks or network interruptions.',
          'Refined uBuddy entry points, collaboration state, and delivery review across contacts, workgroups, and cross-user delegation.',
        ],
      },
      {
        title: 'PPT Agent and File Delivery',
        items: [
          'Fixed failures and compatibility issues across PPT content parsing, layout generation, imagery, rendering, and preview.',
          'Unified Provider and allowance state between image generation and PPT creation, while preserving usable content when imagery cannot be generated.',
          'Added simplified-layout retries, clearer rendering progress, and better diagnostics to improve completion across complex content and desktop environments.',
          'Improved validation, preview, opening, and collaborative delivery for PPTX and other Office files.',
        ],
      },
      {
        title: 'Customizable Desktop Behavior',
        items: [
          'When closing the last window for the first time, choose whether Janus keeps running in the background or quits, and optionally remember the choice.',
          'Change this behavior at any time in Settings. Background mode keeps local tasks active and lets you reopen Janus from the macOS Dock or menu bar.',
          'Improved notification navigation, single-instance activation, and window restoration for a smoother return to completed background work.',
        ],
      },
      {
        title: 'More Product, UI, and Reliability Fixes',
        items: [
          'Refined interaction and display details across messages, composer drafts, conversation switching, task details, contacts, and workgroups.',
          'Improved resilience for file previews, attachments, notification navigation, settings state, and cloud sync during errors or network interruptions.',
          'Updated both Chinese and English UI coverage and fixed dark-mode, layout, status-message, and transient-display issues.',
        ],
      },
    ],
  },
  '0.3.0': {
    title: 'Complete Task Collaboration and Delivery Review',
    summary: 'A broad upgrade to messaging, task tracking, cross-user delivery, Office previews, Agent identity, and model-service reliability.',
    highlights: [
      'Improved messaging, dark mode, chat search, keyboard shortcuts, text zoom, and input stability.',
      'Added a uBuddy task strip with progress filters, recovery status, source-message navigation, and new-activity indicators.',
      'Added recipient delivery, requester acceptance or rework, version history, and consistent workgroup status.',
      'Improved validation, preview conversion, and file actions for DOCX, XLSX, PPTX, images, and documents.',
      'Preserved local Agent identity and enabled-state when connecting cloud accounts.',
      'Added a built-in model-service fallback and safer activation rules for custom Providers.',
    ],
  },
  '0.2.28': {
    title: 'Task Understanding, Model Compatibility, and Social UX',
    summary: 'Improved everyday interaction while making uBuddy more resilient with long context, slow Providers, and changing model catalogs.',
    highlights: [
      'Refined chat, settings, update notices, task details, Janus change reviews, context usage, and navigation.',
      'Added profile popovers from direct and group-chat avatars, including quick direct-message actions.',
      'Improved uBuddy task understanding for long conversations, attachments, and project context.',
      'Filtered the model catalog to models actually supported by the active Provider.',
      'Separated Provider timeouts from missing local runtime components.',
      'Refreshed model and reasoning options immediately after claiming a Provider Key.',
    ],
  },
  '0.2.27': {
    title: 'uBuddy Recovery, Unified Execution, and Open Provider Configuration',
    summary: 'Unified background execution, added bounded failure recovery, fixed task/message races, and moved production builds to open Provider configuration.',
    highlights: [
      'Background tasks now use isolated task-workspace permissions.',
      'Ordinary failures trigger bounded uBuddy recovery before asking the user for help.',
      'Fixed new file requests being confused with previous task-result queries.',
      'Added in-app Provider Key application, review, and claim workflows.',
    ],
  },
  '0.2.26': {
    title: 'uBuddy Delivery, Identity Isolation, and Desktop Reliability',
    summary: 'Improved bounded delivery review, Workspace and Agent identity isolation, social messaging, artifacts, and cross-platform release reliability.',
    highlights: [
      'Unified single- and multi-Agent tasks under bounded delivery review.',
      'Strengthened account, organization, Workspace, Agent-family, and instance isolation.',
      'Improved friends, chats, workgroups, files, task status, and release validation.',
    ],
  },
  '0.2.21': {
    title: 'uBuddy Scheduling, Collaboration Files, and Workspace Stability',
    summary: 'Reworked uBuddy planning and Agent allocation, added reliable collaborative file transfer, and fixed Workspace and delivery-review issues.',
    highlights: [
      'Added persistent background planning and direct-answer, clarification, or task-graph decisions.',
      'Added busy-Agent queues, automatic allocation, and leader-coordinated multi-Agent delivery.',
      'Added verified, resumable file transfer and offline caching for chats and collaborative tasks.',
    ],
  },
  '0.2.20': {
    title: 'Unified Messaging, Organizations, and Updates',
    summary: 'Unified message interaction, Workspace navigation, organization settings, and software update notices.',
    highlights: [
      'Added update notices, detailed release notes, and an Update Center-only preference.',
      'Improved Workspace switching, organization contacts, uBuddy entry points, and talent layout.',
      'Unified message lists, group-chat composition, activity views, and context menus.',
    ],
  },
  '0.2.19': {
    title: 'Workspace and Organization Collaboration',
    summary: 'Introduced account Workspaces, isolated organization conversations and tasks, and strengthened invitations, membership, and historical repair.',
    highlights: [
      'Added Workspace switching with isolated messages, contacts, and tasks.',
      'Completed organization sharing, invitation, membership, exit, and ownership flows.',
      'Improved historical database repair for conversations, workgroups, and Workspace consistency.',
    ],
  },
  '0.2.18': {
    title: 'PPT, File Preview, and Message Interaction',
    summary: 'Improved PPT generation, Office and image previews, message actions, and goal/plan-mode controls.',
    highlights: [
      'Improved PPT image generation, templates, previews, and validation.',
      'Added Word, Excel, image, and richer attachment previews.',
      'Added reply, forward, withdraw, goal mode, plan mode, and private-assistant controls.',
    ],
  },
});

function localizedAnnouncement(announcement = null) {
  if (!announcement || state.languageMode !== 'en') return announcement;
  const version = String(announcement.version || '').trim();
  const english = ENGLISH_RELEASES[version];
  if (!english) return {
    ...announcement,
    title: `Janus ${version || 'Update'}`,
    summary: 'This release includes product improvements and reliability fixes.',
    highlights: [],
    sections: [{ title: 'Highlights', items: ['See the official changelog for complete release details.'] }],
  };
  return {
    ...announcement,
    ...english,
    sections: english.sections || [{ title: 'Highlights', items: english.highlights }],
  };
}

function normalizeRemoteReleaseNotes(value) {
  const source = Array.isArray(value)
    ? value.flatMap((item) => typeof item === 'string' ? [item] : [item?.note || item?.notes || ''])
    : [String(value || '')];
  const lines = source.flatMap((item) => String(item || '').split(/\r?\n/))
    .map((item) => item.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 20);
  if (state.languageMode !== 'en') return lines;
  return lines.filter((item) => !/[\u3400-\u9fff]/.test(item));
}
