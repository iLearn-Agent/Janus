#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const renderer = read('src/renderer/multiPartyCallWindow.js');
const server = read('cloud/src/server.mjs');
const client = read('network/clients/socialClient.js');
const html = read('src/renderer/multiPartyCallWindow.html');

assert.match(renderer, /janus: 'keepalive'/);
assert.match(renderer, /request: 'leave'/);
assert.match(renderer, /getDisplayMedia/);
assert.match(renderer, /MediaRecorder/);
assert.match(renderer, /sendVoiceCallChat/);
assert.match(renderer, /inviteVoiceCallParticipant/);
assert.match(renderer, /kickVoiceCallParticipant/);
assert.match(renderer, /onVoiceCallEvent/);
assert.match(server, /\/api\/social\/voice-call\/invite/);
assert.match(server, /\/api\/social\/voice-call\/kick/);
assert.match(server, /\/api\/social\/voice-call\/chat/);
assert.match(server, /voice_call\.participant_left/);
assert.match(server, /voice_call\.ended/);
assert.match(client, /inviteVoiceCallParticipant/);
assert.match(client, /kickVoiceCallParticipant/);
assert.match(client, /sendVoiceCallChat/);
assert.match(html, /id="share"/);
assert.match(html, /id="invite"/);
assert.match(html, /id="kick"/);
assert.match(html, /id="record"/);

console.log('multi-party call contract smoke passed');
