import assert from 'node:assert/strict';
import fs from 'node:fs';

const view = fs.readFileSync(new URL('../../src/renderer/app/views/networkView.js', import.meta.url), 'utf8');
const shortcutBlock = view.slice(view.indexOf('<div class="im-message-shortcuts"'), view.indexOf('</div>', view.indexOf('<div class="im-message-shortcuts"')));
assert.ok(shortcutBlock.indexOf('renderUBuddyMessageShortcut()') < shortcutBlock.indexOf('renderPrivateAssistantMessageShortcut()'));
assert.ok(shortcutBlock.indexOf('renderPrivateAssistantMessageShortcut()') < shortcutBlock.indexOf('renderFollowerMessageShortcut()'));
assert.match(view, /data-message-system-entry="follower"/);
assert.match(view, /im-message-shortcut-beta[^>]*>Beta</);
assert.doesNotMatch(view, /data-network-peer="self-follower"/);
const css = fs.readFileSync(new URL('../../src/renderer/app/features/network/styles.css', import.meta.url), 'utf8');
assert.match(css, /grid-template-columns:\s*repeat\(3,\s*36px\)/);
assert.match(css, /is-follower[\s\S]*#0f9f91/);
assert.match(css, /im-message-shortcut-beta/);
console.log('Follower renderer shortcut smoke passed');
