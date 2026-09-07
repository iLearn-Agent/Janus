import assert from 'node:assert/strict';
import fs from 'node:fs';

import { normalizeFilePayload } from '../src/renderer/app/utils/filePayload.js';
import { resolveLinkedMessageArtifact } from '../src/renderer/app/utils/messageArtifactLinks.js';

const remoteAttachment = {
  name: 'Agent系统技术地图.md',
  workspace_relative_path: 'reports/Agent系统技术地图.md',
  remote_file_id: 'collab_file_agent_map',
  remote_file_kind: 'collaboration_task',
};
const messages = [{
  id: 'generated-files-message',
  role: 'system',
  metadata: {
    candidateMessageId: 'delivery-draft-message',
    generatedTaskFiles: true,
    attachments: [remoteAttachment],
  },
}];

assert.equal(
  resolveLinkedMessageArtifact('reports/Agent系统技术地图.md', {
    messageId: 'delivery-draft-message', messages,
  }),
  remoteAttachment,
);
assert.equal(
  resolveLinkedMessageArtifact('Agent系统技术地图.md', {
    messageId: 'delivery-draft-message', messages,
  }),
  remoteAttachment,
);
assert.equal(resolveLinkedMessageArtifact('Agent系统技术地图.md', {
  messageId: 'unrelated-message', messages,
}), null);
assert.equal(normalizeFilePayload(remoteAttachment).relative_path, 'reports/Agent系统技术地图.md');

const controllerSource = fs.readFileSync(new URL('../src/renderer/app/features/chat/chatRunController.js', import.meta.url), 'utf8');
const workspaceFilesSource = fs.readFileSync(new URL('../src/main/modules/collaboration/infrastructure/delegationWorkspaceFiles.js', import.meta.url), 'utf8');
assert.match(controllerSource, /\.message-output-artifacts \[data-preview-file\], \.message-attachments \[data-preview-file\]/);
assert.match(controllerSource, /messageId: registeredArtifact\.messageId \|\| ''/);
assert.match(workspaceFilesSource, /relative_path: attachment\.relative_path \|\| attachment\.relativePath[\s\S]*attachment\.workspace_relative_path/);

console.log('delegation Markdown file link smoke passed');
