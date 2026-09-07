import { all, run } from './db.js';
import { createHash } from 'node:crypto';
import { newId, nowIso, safeJsonParse } from './utils.js';

const NEGATION_TERMS = ['not', 'never', 'avoid', 'without', '禁止', '不要', '不得', '避免', '不能'];

export function normalizeMemoryContent(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[\W_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function memoryTokens(text) {
  const normalized = normalizeMemoryContent(text);
  const tokens = normalized.match(/[a-z0-9]{3,}|[\u4e00-\u9fff]{2,}/g) || [];
  const stop = new Set(['the', 'and', 'for', 'that', 'with', 'from', 'into', 'when', 'should', 'must', 'avoid', 'none', 'yet']);
  return new Set(tokens.filter((token) => !stop.has(token)));
}

export function memorySimilarity(left, right) {
  const leftTokens = memoryTokens(left);
  const rightTokens = memoryTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const jaccard = overlap / Math.max(1, union);
  const containment = overlap / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
  return Number(Math.max(jaccard, containment * 0.92).toFixed(3));
}

function hasNegation(text) {
  const normalized = normalizeMemoryContent(text);
  return NEGATION_TERMS.some((term) => normalized.includes(term));
}

export function entailmentRelation(left, right) {
  const leftTokens = memoryTokens(left);
  const rightTokens = memoryTokens(right);
  if (!leftTokens.size || !rightTokens.size) {
    return { relation: 'none', confidence: 0, reason: 'no_comparable_tokens' };
  }
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const containment = overlap / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
  if (containment >= 0.5 && hasNegation(left) !== hasNegation(right)) {
    return { relation: 'conflict', confidence: Number(containment.toFixed(3)), reason: 'polarity_mismatch' };
  }
  if (normalizeMemoryContent(left) === normalizeMemoryContent(right)) {
    return { relation: 'equivalent', confidence: 1, reason: 'normalized_exact_match' };
  }
  if (containment >= 0.92) {
    return {
      relation: leftTokens.size >= rightTokens.size ? 'left_entails_right' : 'right_entails_left',
      confidence: Number(containment.toFixed(3)),
      reason: 'token_containment',
    };
  }
  return { relation: 'none', confidence: Number(containment.toFixed(3)), reason: 'below_entailment_threshold' };
}

export function memoryMergeDecision(left, right, { lexicalThreshold = 0.82 } = {}) {
  const lexical = memorySimilarity(left, right);
  const entailment = entailmentRelation(left, right);
  const relation = entailment.relation || 'none';
  let merge = false;
  let method = 'distinct';
  if (relation === 'conflict') {
    method = 'blocked_conflict';
  } else if (normalizeMemoryContent(left) === normalizeMemoryContent(right)) {
    merge = true;
    method = 'exact';
  } else if (lexical >= lexicalThreshold) {
    merge = true;
    method = 'lexical';
  } else if (['equivalent', 'left_entails_right', 'right_entails_left'].includes(relation) && entailment.confidence >= 0.9) {
    merge = true;
    method = 'entailment';
  }
  return {
    merge,
    method,
    lexical_similarity: lexical,
    entailment,
  };
}

export function classifyPrivacy(content, memoryType = '') {
  const raw = String(content || '');
  const text = normalizeMemoryContent(raw);
  if (memoryType === 'do_not_store') return 'privacy_policy';
  const secretMaterial = [
    /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i,
    /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+\S+/i,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\b\s*[:=]\s*['"]?[^\s'"]{6,}/i,
    /\b(?:sk|rk|pk)-[a-z0-9_-]{12,}\b/i,
    /\bgh[opurs]_[a-z0-9]{20,}\b/i,
    /\bAKIA[0-9A-Z]{16}\b/,
  ].some((pattern) => pattern.test(raw));
  const privateContext = /(collaborator|unpublished|confidential|private project|internal only|budget|institution|raw project|user identity|个人身份|用户身份|合作者|未发表|未公开|保密|内部资料|密钥|密码|令牌|预算|机构|隐私)/i.test(text);
  if (secretMaterial || privateContext) {
    return 'blocked_private';
  }
  return 'public_reusable';
}

export function privateMemoryMarker(content, privacy = 'blocked_private') {
  if (/^\[REDACTED (?:blocked_private|privacy_policy); sha256:[a-f0-9]{16}\]$/.test(String(content || ''))) {
    return String(content);
  }
  const fingerprint = createHash('sha256').update(String(content || ''), 'utf8').digest('hex').slice(0, 16);
  return `[REDACTED ${privacy}; sha256:${fingerprint}]`;
}

export function upsertTypedMemory(db, record) {
  const privacy = classifyPrivacy(record.content, record.memoryType);
  if (privacy === 'blocked_private') {
    return { status: 'blocked_private', fingerprint: privateMemoryMarker(record.content, privacy) };
  }
  const status = privacy === 'privacy_policy' ? 'blocked' : 'active';
  const storedContent = status === 'blocked'
    ? privateMemoryMarker(record.content, privacy)
    : record.content;
  const candidates = all(
    db,
    `SELECT * FROM typed_memories
     WHERE owner_id = ? AND memory_type = ? AND status = ?
       AND (? = '' OR user_id = ?)
       AND (? = '' OR agent_instance_id = ?)
     ORDER BY updated_at DESC LIMIT 50`,
    [
      record.ownerId,
      record.memoryType,
      status,
      record.userId || '',
      record.userId || '',
      record.agentInstanceId || '',
      record.agentInstanceId || '',
    ],
  );
  for (const candidate of candidates) {
    const decision = memoryMergeDecision(candidate.content, storedContent);
    if (!decision.merge) continue;
    const confidence = Math.min(0.95, Number(candidate.confidence || 0.5) + 0.03);
    run(
      db,
      `UPDATE typed_memories
       SET confidence = ?, evidence_count = evidence_count + ?, hit_count = hit_count + 1,
           source_kind = ?, source_id = ?, merge_result_json = ?, entailment_status = ?, updated_at = ?
       WHERE id = ?`,
      [
        confidence,
        Number(record.evidenceCount || 0),
        `evolution:semantic_duplicate:${decision.lexical_similarity}`,
        record.sourceId || '',
        JSON.stringify(decision),
        decision.entailment?.relation || '',
        nowIso(),
        candidate.id,
      ],
    );
    return { status: 'merged', id: candidate.id, decision };
  }
  const id = newId('mem');
  run(
    db,
    `INSERT INTO typed_memories (
      id, scope, owner_id, user_id, department_id, agent_id, agent_instance_id,
      memory_document_id, task_run_id, relationship_id, memory_type, content,
      privacy_level, confidence, evidence_count, status, source_kind, source_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      record.scope || 'agent',
      record.ownerId,
      record.userId || '',
      record.departmentId || '',
      record.agentId || '',
      record.agentInstanceId || '',
      record.memoryDocumentId || '',
      record.taskRunId || '',
      record.relationshipId || '',
      record.memoryType,
      storedContent,
      privacy,
      Number(record.confidence || 0.64),
      Number(record.evidenceCount || 0),
      status,
      record.sourceKind || 'evolution',
      record.sourceId || '',
    ],
  );
  return { status: status === 'blocked' ? 'inserted_blocked' : 'inserted', id };
}

const MEMORY_SECTION_TYPES = {
  'Stable Learnings': 'stable_learning',
  'Reusable Preferences': 'preference',
  'Failure Modes': 'failure_mode',
  'Workflow Notes': 'workflow_note',
  'Topic Files': 'topic_file',
  'Do Not Store': 'do_not_store',
};

const MEMORY_TYPE_SECTIONS = Object.fromEntries(
  Object.entries(MEMORY_SECTION_TYPES).map(([section, type]) => [type, section]),
);

export function memoryTypeFromPatchLabel(label) {
  const normalized = String(label || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  for (const [section, type] of Object.entries(MEMORY_SECTION_TYPES)) {
    if (normalized === section.toLowerCase()) return type;
    if (normalized === type.replace(/_/g, ' ')) return type;
  }
  return '';
}

export function applyMemoryPatchToSchema(memoryText, patchText) {
  let next = String(memoryText || '').trimEnd();
  const fallback = [];
  for (const rawLine of String(patchText || '').split(/\r?\n/)) {
    const bullet = rawLine.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (!bullet) {
      if (rawLine.trim() && !/^no-op$/i.test(rawLine.trim())) fallback.push(rawLine);
      continue;
    }
    const value = bullet[1].trim();
    const labeled = value.match(/^([^:：]{2,40})\s*[:：]\s*(.+)$/);
    if (!labeled) {
      fallback.push(rawLine);
      continue;
    }
    const memoryType = memoryTypeFromPatchLabel(labeled[1]);
    const section = MEMORY_TYPE_SECTIONS[memoryType];
    if (!section) {
      fallback.push(rawLine);
      continue;
    }
    next = appendBulletToMemorySection(next, section, labeled[2].trim());
  }
  if (fallback.length) {
    next = `${next}\n\n## Evolution Patch\n${fallback.join('\n')}\n`.trimEnd();
  }
  return `${next.trimEnd()}\n`;
}

function appendBulletToMemorySection(memoryText, section, content) {
  if (!content) return memoryText;
  const heading = `## ${section}`;
  const lines = String(memoryText || '').split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex === -1) {
    return `${memoryText.trimEnd()}\n${heading}\n- ${content}\n`;
  }
  let insertAt = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      insertAt = index;
      break;
    }
  }
  lines.splice(insertAt, 0, `- ${content}`);
  return lines.join('\n');
}

export function extractTypedMemoryRecords(memoryText, {
  ownerId, userId = '', departmentId, agentId, agentInstanceId = '', memoryDocumentId = '', taskRunId = '', relationshipId = '', sourceId, evidenceCount = 0,
} = {}) {
  const records = [];
  const lines = String(memoryText || '').split(/\r?\n/);
  let currentType = '';
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      currentType = MEMORY_SECTION_TYPES[heading[1].trim()] || '';
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (!bullet || !currentType) continue;
    const content = bullet[1].trim();
    if (!content || /^none\.?$/i.test(content)) continue;
    let confidence = ['failure_mode', 'workflow_note', 'stable_learning'].includes(currentType) ? 0.72 : 0.64;
    if (evidenceCount >= 20) confidence += 0.06;
    else if (evidenceCount >= 8) confidence += 0.03;
    records.push({
      scope: 'agent',
      ownerId,
      userId,
      departmentId,
      agentId,
      agentInstanceId,
      memoryDocumentId,
      taskRunId,
      relationshipId,
      memoryType: currentType,
      content,
      confidence: Math.min(0.95, confidence),
      evidenceCount,
      sourceKind: 'evolution',
      sourceId,
    });
  }
  return records;
}

export function extractTypedMemoryRecordsFromPatch(patchText, {
  ownerId, userId = '', departmentId, agentId, agentInstanceId = '', memoryDocumentId = '', taskRunId = '', relationshipId = '', sourceId, evidenceCount = 0,
} = {}) {
  const records = [];
  for (const rawLine of String(patchText || '').split(/\r?\n/)) {
    const bullet = rawLine.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (!bullet) continue;
    const labeled = bullet[1].trim().match(/^([^:：]{2,40})\s*[:：]\s*(.+)$/);
    if (!labeled) continue;
    const memoryType = memoryTypeFromPatchLabel(labeled[1]);
    if (!memoryType) continue;
    const content = labeled[2].trim();
    if (!content || /^none\.?$/i.test(content)) continue;
    let confidence = ['failure_mode', 'workflow_note', 'stable_learning'].includes(memoryType) ? 0.72 : 0.64;
    if (evidenceCount >= 20) confidence += 0.06;
    else if (evidenceCount >= 8) confidence += 0.03;
    records.push({
      scope: 'agent',
      ownerId,
      userId,
      departmentId,
      agentId,
      agentInstanceId,
      memoryDocumentId,
      taskRunId,
      relationshipId,
      memoryType,
      content,
      confidence: Math.min(0.95, confidence),
      evidenceCount,
      sourceKind: 'evolution',
      sourceId,
    });
  }
  return records;
}

export function parseMemoryJson(value) {
  return safeJsonParse(value, {});
}
