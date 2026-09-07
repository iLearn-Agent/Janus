import { installCollaborationGroupMethods } from './application/collaborationGroupMethods.js';
import { installChatGroupMethods } from './application/chatGroupMethods.js';
import { installConversationPreferenceMethods } from './application/conversationPreferenceMethods.js';
import { installDelegationMethods } from './application/delegationMethods.js';
import { installFriendMessagingMethods } from './application/friendMessagingMethods.js';
import { installFriendshipMethods } from './application/friendshipMethods.js';
import { installOrganizationMethods } from './application/organizationMethods.js';
import { installUBuddyCapabilityProfileMethods } from './application/uBuddyCapabilityProfileMethods.js';
import { installEmojiFavoriteMethods } from './application/emojiFavoriteMethods.js';

export { publicUser } from './domain/socialRecords.js';

export function installAuthSocialMethods(prototype) {
  installFriendMessagingMethods(prototype);
  installChatGroupMethods(prototype);
  installCollaborationGroupMethods(prototype);
  installConversationPreferenceMethods(prototype);
  installDelegationMethods(prototype);
  installFriendshipMethods(prototype);
  installOrganizationMethods(prototype);
  installUBuddyCapabilityProfileMethods(prototype);
  installEmojiFavoriteMethods(prototype);
}
