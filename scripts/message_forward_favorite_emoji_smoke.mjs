import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');

assert.match(source, /function messageForwardAttachments\(message = null\)/);
assert.match(source, /attachments: messageForwardAttachments\(message\)/);
assert.match(source, /favoriteEmoji: message\.metadata\?\.favoriteEmoji === true/);
assert.match(source, /async function materializeForwardAttachments\(attachments = \[\]\)/);
assert.match(source, /window\.janus\.uploadFile\(\{[\s\S]*dataBase64: match\[2\]/);
assert.match(source, /remote_file_id: ''[\s\S]*remote_file_kind: ''/);
assert.match(source, /attachments: forwardAttachments/);
assert.match(source, /content: forwardedContent \|\| \(sourceAttachments\.length \? '\\u200b' : ''\)/);
assert.match(source, /favoriteEmoji \|\| \(forwardAttachments\.length && forwardAttachments\.every/);
assert.match(source, /const canForwardImage = Boolean\(sourceMessage && messageHasForwardableContent\(sourceMessage\)\)/);

console.log('favorite emoji message forwarding smoke passed');
