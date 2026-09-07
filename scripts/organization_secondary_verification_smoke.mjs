import assert from 'node:assert/strict';

import { SocialRelayService } from '../src/main/socialRelay.js';

const requests = [];
let clearCalls = 0;
let loginCalls = 0;
const relay = Object.create(SocialRelayService.prototype);
relay.organizationSecondaryVerificationGrants = new Map();
relay.auth = {
  clearOrganizationSecondaryVerification() { clearCalls += 1; },
  currentUser: () => ({ id: 'local-user' }),
};
relay.client = {
  async organizationAction(_state, organizationId, payload) {
    requests.push({ organizationId, payload: { ...payload } });
    if (payload.secondaryVerificationExpected && payload.secondaryVerificationGrant === 'expired-grant') {
      throw Object.assign(new Error('本次登录的二次验证已失效，请重新验证。'), {
        status: 403,
        code: 'organization_secondary_verification_expired',
      });
    }
    return payload.rememberSecondaryVerification
      ? { ok: true, secondaryVerificationRemembered: true, secondaryVerificationGrant: 'main-only-grant' }
      : { ok: true };
  },
  async login() {
    loginCalls += 1;
    return { user: { id: 'remote-user' }, accessToken: 'new-access', refreshToken: 'new-refresh' };
  },
};
relay.withRefresh = async (callback) => callback({ access_token: 'access' });
relay.state = () => ({});
relay.saveSession = (session) => session;
relay.syncProfileUpdateOutbox = async () => ({ processed: 0 });

const first = await relay.organizationAction('action', {
  action: 'promote_admin', organizationId: 'organization-a', targetUserId: 'member-a',
  verificationCode: 'organization-code', accountPassword: 'account-password',
  rememberSecondaryVerification: true,
});
assert.equal(first.secondaryVerificationRemembered, true);
assert.equal(Object.hasOwn(first, 'secondaryVerificationGrant'), false,
  'the renderer-facing result must never expose the reusable verification grant');
assert.equal(relay.organizationSecondaryVerificationGrants.get('organization-a'), 'main-only-grant');

await relay.organizationAction('action', {
  action: 'revoke_admin', organizationId: 'organization-a', targetUserId: 'member-a',
  secondaryVerificationExpected: true,
});
assert.equal(requests.at(-1).payload.secondaryVerificationGrant, 'main-only-grant');
assert.equal(requests.at(-1).payload.verificationCode || '', '');
assert.equal(requests.at(-1).payload.accountPassword || '', '');

relay.organizationSecondaryVerificationGrants.set('organization-a', 'expired-grant');
await assert.rejects(() => relay.organizationAction('action', {
  action: 'promote_admin', organizationId: 'organization-a', targetUserId: 'member-a',
  secondaryVerificationExpected: true,
}), /二次验证已失效/);
assert.equal(relay.organizationSecondaryVerificationGrants.has('organization-a'), false);

relay.organizationSecondaryVerificationGrants.set('organization-a', 'grant-before-login');
await relay.login({ identifier: 'remote-user', password: 'password' });
assert.equal(loginCalls, 1);
assert.equal(clearCalls, 1);
assert.equal(relay.organizationSecondaryVerificationGrants.size, 0,
  'a successful new login must clear every remembered organization verification grant');

console.log('organization secondary verification smoke passed');
