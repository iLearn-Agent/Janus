import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  socialRelayMutationMode,
  socialRelayUnavailableError,
} from '../src/main/modules/collaboration/application/socialRelayMutationPolicy.js';

assert.equal(socialRelayMutationMode({
  socialRelay: { connected: () => true },
  user: { authProvider: 'cloud', remoteBound: true },
}), 'remote');

assert.equal(socialRelayMutationMode({
  socialRelay: { connected: () => false },
  user: { authProvider: 'local_mock', remoteBound: false },
}), 'local');

assert.equal(socialRelayMutationMode({
  socialRelay: { connected: () => false },
  user: { authProvider: 'cloud', remoteBound: true },
}), 'unavailable');

const unavailable = socialRelayUnavailableError();
assert.equal(unavailable.code, 'social_relay_offline');
assert.match(unavailable.message, /尚未发送/);

for (const file of [
  'src/main/modules/collaboration/application/createDelegationRuntimeApi.js',
  'src/main/modules/collaboration/application/createCollaborationGroupRuntimeApi.js',
]) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /workspace\?\.kind\s*!==\s*['"]organization['"]/);
  assert.match(source, /socialRelayMutationMode\(\{ socialRelay, user \}\)/);
  assert.match(source, /deliveryMode === ['"]unavailable['"]\) throw socialRelayUnavailableError\(\)/);
}

console.log('Social Relay mutation policy smoke passed.');
