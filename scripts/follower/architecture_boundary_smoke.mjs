import assert from 'node:assert/strict';
import fs from 'node:fs';

for (const file of ['src/main/runtime.js','src/main/main.js','src/renderer/app/views/networkView.js']) {
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /CREATE TABLE IF NOT EXISTS follower_|INSERT INTO follower_reports|SELECT \* FROM follower_reports/,
    `${file} must not contain Follower SQL`);
}
const runtime = fs.readFileSync('src/main/runtime.js', 'utf8');
assert.match(runtime, /createFollowerModule/);
const network = fs.readFileSync('src/renderer/app/views/networkView.js', 'utf8');
assert.match(network, /data-message-system-entry="follower"/);
const asset = JSON.parse(fs.readFileSync('assets/system_agents/follower_agent/agent.json', 'utf8'));
assert.equal(asset.runtime_surface, 'follower_service');
assert.equal(asset.routable, false);
assert.equal(asset.recruitable, false);
console.log('Follower architecture boundary smoke passed');
