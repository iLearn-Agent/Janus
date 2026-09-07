import { avatarLabelFromName, userInitials } from '../state.js';
import { escapeAttr, escapeHtml } from './format.js';
import { normalizeProfileAvatarUrl } from '../../../shared/profileAvatar.js';

export function userAvatarUrl(user = {}) {
  return normalizeProfileAvatarUrl(user?.avatarUrl || user?.avatar_url || '');
}

export function renderUserAvatar(user = {}, {
  className = 'avatar',
  title = '',
  fallbackLabel = '',
  viewerUserId = '',
} = {}) {
  const name = title || user?.remark || user?.displayName || user?.display_name || user?.username || user?.email || user?.id || fallbackLabel || 'User';
  const avatarSource = user?.remark || user?.displayName || user?.display_name || user?.username || user?.email || user?.id || fallbackLabel || name;
  const label = avatarLabelFromName(avatarSource);
  const src = userAvatarUrl(user);
  const interactive = Boolean(String(viewerUserId || '').trim());
  const tag = interactive ? 'button' : 'span';
  const baseAttrs = `class="${escapeAttr(className)}${src ? ' has-custom-avatar' : ''}${interactive ? ' avatar-viewer-trigger' : ''}" title="${escapeAttr(name)}" aria-label="${escapeAttr(interactive ? `查看${name}的头像` : `${name} avatar`)}"${interactive ? ` type="button" data-avatar-viewer-user="${escapeAttr(viewerUserId)}"` : ''}`;
  if (!src) return `<${tag} ${baseAttrs}><span class="avatar-fallback-label" data-no-localize>${escapeHtml(label)}</span></${tag}>`;
  return `<${tag} ${baseAttrs}><img src="${escapeAttr(src)}" alt="" loading="lazy" decoding="async" data-user-avatar-image /><span class="avatar-fallback-label" data-no-localize>${escapeHtml(label)}</span></${tag}>`;
}

export function wireUserAvatarFallbacks(root = globalThis.document) {
  root?.querySelectorAll?.('[data-user-avatar-image]').forEach((image) => {
    const fallback = () => {
      const parent = image.parentElement;
      image.remove();
      parent?.classList.remove('has-custom-avatar');
    };
    image.addEventListener('error', fallback, { once: true });
    if (image.complete && !image.naturalWidth) fallback();
  });
}

export function renderAccountAvatar(user = {}, { className = '', title = '', fallbackLabel = '' } = {}) {
  const extraClass = String(className || '').trim();
  return renderUserAvatar(user, {
    className: `avatar account-avatar${extraClass ? ` ${extraClass}` : ''}`,
    title,
    fallbackLabel,
  });
}
