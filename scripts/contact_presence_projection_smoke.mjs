import assert from 'node:assert/strict';
import fs from 'node:fs';

import { mergeCloudPresence } from '../src/main/modules/social/application/collaborationGroupMethods.js';
import { SocialRelayService } from '../src/main/socialRelay.js';
import { contactDirectoryRelationships, contactPresenceDisplayState, organizationMemberRelationship } from '../src/renderer/app/views/networkView.js';

const localOverview = {
  friends: [{
    id: 'local-friendship',
    online: false,
    friend: { id: 'local-bob', remoteId: 'remote-bob', displayName: 'Bob' },
  }],
  organizations: [{
    id: 'local-organization',
    members: [
      { role: 'owner', user: { id: 'local-alice', remoteId: 'remote-alice', displayName: 'Alice' } },
      { role: 'member', user: { id: 'local-bob', remoteId: 'remote-bob', displayName: 'Bob' } },
    ],
  }],
};

const cloudOverview = {
  friends: [{
    id: 'remote-friendship',
    online: true,
    lastSeenAt: '2026-08-13T10:00:00.000Z',
    friend: { id: 'remote-bob', online: true },
  }],
  organizations: [{
    id: 'remote-organization',
    members: [
      { online: true, lastSeenAt: '2026-08-13T10:00:01.000Z', user: { id: 'remote-alice', online: true } },
      { online: true, lastSeenAt: '2026-08-13T10:00:00.000Z', user: { id: 'remote-bob', online: true } },
    ],
  }],
};

const projected = mergeCloudPresence(localOverview, cloudOverview);
assert.equal(projected.friends[0].online, true);
assert.equal(projected.friends[0].presenceKnown, true);
assert.equal(projected.friends[0].friend.online, true);
assert.equal(projected.friends[0].friend.presenceKnown, true);
assert.equal(projected.friends[0].lastSeenAt, '2026-08-13T10:00:00.000Z');
assert.equal(projected.organizations[0].members[0].online, true);
assert.equal(projected.organizations[0].members[0].presenceKnown, true);
assert.equal(projected.organizations[0].members[0].user.online, true);
assert.equal(projected.organizations[0].members[0].lastSeenAt, '2026-08-13T10:00:01.000Z');
assert.equal(projected.organizations[0].members[1].online, true);

assert.deepEqual(contactPresenceDisplayState(localOverview.friends[0], { loading: true }), {
  label: '同步中', className: 'is-unknown', known: false, online: false,
});
assert.deepEqual(contactPresenceDisplayState(localOverview.friends[0]), {
  label: '状态未知', className: 'is-unknown', known: false, online: false,
});
assert.deepEqual(contactPresenceDisplayState(projected.friends[0]), {
  label: '在线', className: 'is-online', known: true, online: true,
});
assert.deepEqual(contactPresenceDisplayState({ presenceKnown: true, online: false, friend: {} }), {
  label: '离线', className: 'is-offline', known: true, online: false,
});
const organizationRelationships = contactDirectoryRelationships(projected, 'nobody-filtered');
const projectedOrganizationSelf = organizationRelationships.find((item) => item.friend?.id === 'local-alice');
assert.equal(projectedOrganizationSelf?.presenceKnown, true);
assert.equal(projectedOrganizationSelf?.online, true);
assert.equal(contactPresenceDisplayState(projectedOrganizationSelf).label, '在线');
const directOrganizationSelf = organizationMemberRelationship(projected.organizations[0].members[0], 'local-alice');
assert.equal(directOrganizationSelf.selfContact, true);
assert.equal(contactPresenceDisplayState(directOrganizationSelf).label, '在线');

const requestOrder = [];
const relayHarness = {
  auth: {
    currentUser: () => ({ id: 'local-alice' }),
    organizationOverview: () => ({ organizations: [] }),
    importCloudFriendsOverview: (overview) => overview,
  },
  friendsPresenceProjection: null,
  state: () => ({ remote_user_id: 'remote-alice', server_url: 'https://social.example/' }),
  presenceHeartbeat: async () => { requestOrder.push('heartbeat'); },
  withRefresh: async (callback) => callback({}),
  client: { friends: async () => { requestOrder.push('friends'); return { friends: [], organizations: [] }; } },
  rememberFriendsPresenceProjection: SocialRelayService.prototype.rememberFriendsPresenceProjection,
  friendsPresenceIdentityKey: SocialRelayService.prototype.friendsPresenceIdentityKey,
};
await SocialRelayService.prototype.friendsOverview.call(relayHarness);
assert.deepEqual(requestOrder, ['heartbeat', 'friends']);

relayHarness.rememberFriendsPresenceProjection(projected);
assert.equal(
  SocialRelayService.prototype.friendsOverviewWithCachedPresence.call(relayHarness, localOverview),
  projected,
);
relayHarness.auth.currentUser = () => ({ id: 'another-user' });
assert.equal(
  SocialRelayService.prototype.friendsOverviewWithCachedPresence.call(relayHarness, localOverview),
  localOverview,
);
relayHarness.auth.currentUser = () => ({ id: 'local-alice' });
relayHarness.friendsPresenceProjection.storedAt = Date.now() - 46_000;
assert.equal(
  SocialRelayService.prototype.friendsOverviewWithCachedPresence.call(relayHarness, localOverview),
  localOverview,
);

const relaySource = fs.readFileSync(new URL('../src/main/socialRelay.js', import.meta.url), 'utf8');
const delegationRuntimeSource = fs.readFileSync(new URL('../src/main/modules/collaboration/application/createDelegationRuntimeApi.js', import.meta.url), 'utf8');
const networkViewSource = fs.readFileSync(new URL('../src/renderer/app/views/networkView.js', import.meta.url), 'utf8');
const workspaceControllerSource = fs.readFileSync(new URL('../src/renderer/app/features/network/workspaceController.js', import.meta.url), 'utf8');
assert.match(relaySource, /async friendsOverview\(\) \{[\s\S]*?await this\.presenceHeartbeat\(\);[\s\S]*?this\.client\.friends/);
assert.match(relaySource, /async poll\([^)]*\) \{[\s\S]*?await this\.presenceHeartbeat\(\);[\s\S]*?const friendsPromise/);
assert.match(relaySource, /friends: projectedFriends/);
assert.match(delegationRuntimeSource, /friends: projection\?\.friends \|\| socialRelay\.friendsOverviewWithCachedPresence/);
assert.match(delegationRuntimeSource, /friends: result\?\.friends \|\| socialRelay\.friendsOverviewWithCachedPresence/);
assert.match(networkViewSource, /contactPresenceDisplayState\(item, \{ loading: state\.networkPanelLoading \}\)/);
assert.match(workspaceControllerSource, /const friendsPromise = nextView === 'friends' && api\.friendsOverview/);
assert.match(workspaceControllerSource, /state\.friendOverview = freshFriends;\s+render\(\)/);

console.log('contact presence projection smoke passed');
