import fs from 'node:fs';
import path from 'node:path';

import { projectMemoryPath } from '../../../paths.js';
import { readText, writeTextAtomicSync } from '../../../utils.js';

export function canonicalProjectWorkspace(value = '') {
  const requested = String(value || '').trim();
  if (!requested) throw new Error('缺少项目工作目录。');
  const absolute = path.resolve(requested);
  let stats;
  try {
    stats = fs.statSync(absolute);
  } catch {
    throw new Error('所选项目目录不存在或当前不可访问。');
  }
  if (!stats.isDirectory()) throw new Error('所选项目必须是文件夹。');
  return fs.realpathSync(absolute);
}

export function assertProjectWorkspaceDirectory(value = '') {
  canonicalProjectWorkspace(value);
}

export function ensureProjectMemory(root, store) {
  const file = projectMemoryPath(root);
  if (!readText(file, '').trim()) {
    writeTextAtomicSync(file, `# Legacy Project Context: Janus

> This is Janus-governed project context, not Codex native generated Memories.
> Required repository rules belong in AGENTS.md or checked-in documentation.

## Stable Architecture
- Janus is a local-first cross-platform desktop workspace with Codex-backed agents, governed self-evolution, and auditable memory.

## Cross-Department Protocols
- Complex tasks should use task graphs, explicit dependencies, structured agent communication, and task retrospectives.

## Global Preferences
- Keep durable memory short, reusable, privacy-safe, and reviewed before promotion to long-term influence.

## Do Not Store
- Raw private chats, credentials, unpublished data, user identities, and one-off task facts.
`);
  }
  store.upsertMemoryEntry({
    scope: 'project',
    ownerId: 'janus',
    memoryType: 'project_rule',
    content: 'Janus uses governed self-evolution over skill, memory, and organization metadata; it does not train model weights.',
    lifecycleState: 'active',
    confidence: 0.9,
    sourceKind: 'bootstrap',
    sourceId: 'project_memory',
    reviewStatus: 'system_seeded',
  });
}
