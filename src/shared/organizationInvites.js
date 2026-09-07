const ORGANIZATION_INVITE_PROTOCOL = 'janus:';
const ORGANIZATION_INVITE_HOST = 'organization';
const ORGANIZATION_INVITE_PATH = '/join';
const ORGANIZATION_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9_-]{3,31}$/;

export function buildOrganizationInviteLink({ organizationNumber = '', verificationCode = '', organizationName = '', ownerName = '' } = {}) {
  const number = normalizeInviteOrganizationNumber(organizationNumber);
  const code = normalizeInviteVerificationCode(verificationCode);
  const name = String(organizationName || '').trim().slice(0, 60);
  const owner = String(ownerName || '').trim().slice(0, 60);
  const url = new URL(`${ORGANIZATION_INVITE_PROTOCOL}//${ORGANIZATION_INVITE_HOST}${ORGANIZATION_INVITE_PATH}`);
  url.searchParams.set('organization', number);
  url.searchParams.set('code', code);
  if (name) url.searchParams.set('name', name);
  if (owner) url.searchParams.set('owner', owner);
  url.searchParams.set('v', '1');
  return url.toString();
}

export function parseOrganizationInviteLink(value = '') {
  const text = String(value || '').trim();
  if (!text) return null;
  const candidates = [text, ...organizationInviteLinkMatches(text)];
  for (const candidate of candidates) {
    try {
      const url = new URL(trimInviteLinkCandidate(candidate));
      if (url.protocol !== ORGANIZATION_INVITE_PROTOCOL
        || url.hostname.toLowerCase() !== ORGANIZATION_INVITE_HOST
        || url.pathname.replace(/\/+$/, '') !== ORGANIZATION_INVITE_PATH) continue;
      const organizationNumber = normalizeInviteOrganizationNumber(url.searchParams.get('organization') || url.searchParams.get('number') || '');
      const verificationCode = normalizeInviteVerificationCode(url.searchParams.get('code') || url.searchParams.get('invitation') || '');
      return {
        organizationNumber,
        verificationCode,
        organizationName: String(url.searchParams.get('name') || '').trim().slice(0, 60),
        ownerName: String(url.searchParams.get('owner') || '').trim().slice(0, 60),
        version: String(url.searchParams.get('v') || '1').trim().slice(0, 8),
        link: buildOrganizationInviteLink({
          organizationNumber,
          verificationCode,
          organizationName: url.searchParams.get('name') || '',
          ownerName: url.searchParams.get('owner') || '',
        }),
      };
    } catch {
      // Ignore unrelated or malformed clipboard text.
    }
  }
  return null;
}

function organizationInviteLinkMatches(value = '') {
  return String(value || '').match(/janus:\/\/organization\/join\?[^\s<>"']+/gi) || [];
}

function trimInviteLinkCandidate(value = '') {
  return String(value || '').trim().replace(/[),.;!?，。；！？）】》]+$/u, '');
}

function normalizeInviteOrganizationNumber(value = '') {
  const number = String(value || '').trim().toUpperCase();
  if (!ORGANIZATION_NUMBER_PATTERN.test(number)) throw new Error('邀请链接中的组织号无效。');
  return number;
}

function normalizeInviteVerificationCode(value = '') {
  const code = String(value || '').trim();
  if (code.length < 6 || code.length > 128) throw new Error('邀请链接中的邀请码无效。');
  return code;
}
