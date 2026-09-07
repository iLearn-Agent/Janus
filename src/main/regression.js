import path from 'node:path';

import { all, run } from './db.js';
import { extractMarkdownSection } from './gate.js';
import { readText, safeJsonParse, sha256Text } from './utils.js';

export function splitEvalCase(line) {
  let value = String(line || '').trim().replace(/^\s*[-*]\s+/, '').replace(/^\s*\d+[.)]\s+/, '');
  if (!value) return ['', ''];
  for (const pattern of [/\bExpected\s*:\s*/i, /\bExpect\s*:\s*/i, /\bOutcome\s*:\s*/i, /预期\s*[:：]\s*/, /期望\s*[:：]\s*/]) {
    const match = pattern.exec(value);
    if (match) return [value.slice(0, match.index).trim().replace(/[ -;；。]+$/g, ''), value.slice(match.index + match[0].length).trim()];
  }
  return [value, ''];
}

export function parseEvalCaseFields(text) {
  const value = String(text || '').trim().replace(/^\s*[-*]\s+/, '').replace(/^\s*\d+[.)]\s+/, '').trim();
  const fields = { caseText: value, inputText: '', expectedText: '', replaySpec: {} };
  if (!value) return fields;
  const markers = {
    input: /\b(?:Input|Prompt|Task)\s*:\s*|输入\s*[:：]\s*|任务\s*[:：]\s*/gi,
    expected: /\b(?:Expected|Expect|Outcome)\s*:\s*|预期\s*[:：]\s*|期望\s*[:：]\s*/gi,
    replay: /\bReplay\s*:\s*|回放\s*[:：]\s*/gi,
  };
  const matches = [];
  for (const [name, pattern] of Object.entries(markers)) {
    for (const match of value.matchAll(pattern)) {
      matches.push({ start: match.index, end: match.index + match[0].length, name });
    }
  }
  matches.sort((left, right) => left.start - right.start);
  if (!matches.length) {
    const [caseText, expectedText] = splitEvalCase(value);
    fields.caseText = caseText;
    fields.expectedText = expectedText;
    return fields;
  }
  fields.caseText = value.slice(0, matches[0].start).trim().replace(/[ -;；。]+$/g, '');
  matches.forEach((match, index) => {
    const nextStart = matches[index + 1]?.start ?? value.length;
    const body = value.slice(match.end, nextStart).trim().replace(/[ -;；。]+$/g, '');
    if (match.name === 'input') fields.inputText = body;
    if (match.name === 'expected') fields.expectedText = body;
    if (match.name === 'replay') {
      try {
        fields.replaySpec = JSON.parse(body);
      } catch {
        fields.replaySpec = { kind: body };
      }
    }
  });
  if (!fields.caseText) fields.caseText = fields.inputText || value;
  return fields;
}

export function extractEvalCases(markdown, { limit = 12 } = {}) {
  const section = extractMarkdownSection(markdown, 'Eval cases');
  const cases = [];
  for (const rawLine of section.split(/\r?\n/)) {
    if (!/^\s*[-*]\s+/.test(rawLine) && !/^\s*\d+[.)]\s+/.test(rawLine)) continue;
    const fields = parseEvalCaseFields(rawLine);
    if (!fields.caseText) continue;
    cases.push({
      caseText: fields.caseText.slice(0, 2000),
      inputText: fields.inputText.slice(0, 4000),
      expectedText: fields.expectedText.slice(0, 2000),
      replaySpec: fields.replaySpec,
    });
    if (cases.length >= limit) break;
  }
  if (!cases.length && section.trim()) {
    const fields = parseEvalCaseFields(section.trim().split(/\r?\n/)[0]);
    if (fields.caseText) cases.push(fields);
  }
  return cases;
}

export function staticContractScore({ caseText, expectedText, skillPath, memoryPath }) {
  const checks = {
    case_present: Boolean(caseText.trim()),
    skill_exists: Boolean(skillPath && readText(skillPath, null) !== null),
    memory_exists: Boolean(memoryPath && readText(memoryPath, null) !== null),
    expected_present: Boolean(expectedText.trim()),
  };
  const required = checks.case_present && checks.skill_exists && checks.memory_exists;
  const score = required && checks.expected_present ? 1 : required ? 0.75 : 0;
  return { status: score >= 0.75 ? 'passed' : 'failed', score, result: { checks } };
}

export function heuristicBehaviorScore({ caseText, expectedText, skillText, memoryText }) {
  const combined = `${skillText}\n${memoryText}`.toLowerCase();
  const expectation = String(expectedText || caseText || '').toLowerCase();
  const tokens = [...new Set((expectation.match(/[a-z0-9]{4,}|[\u4e00-\u9fff]{2,}/g) || []).filter(
    (token) => !['expected', 'user', 'asks', 'with', 'when', 'should', 'must', 'private'].includes(token),
  ))];
  if (!tokens.length) return { status: 'passed', score: 0.75, result: { checks: { has_behavior_tokens: false } } };
  const checked = tokens.slice(0, 24);
  const hits = checked.filter((token) => combined.includes(token));
  const score = Number((hits.length / Math.max(1, checked.length)).toFixed(3));
  return {
    status: score >= 0.35 ? 'passed' : 'failed',
    score,
    result: { checks: { tokens_checked: checked, tokens_hit: hits, hit_ratio: score } },
  };
}

export function parseLlmJudgeResult(raw) {
  let text = String(raw || '').trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  const parsed = safeJsonParse(text, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'failed', score: 0, rationale: 'judge returned non-json', checks: {} };
  }
  const score = Math.max(0, Math.min(1, Number(parsed.score || 0)));
  const requestedStatus = String(parsed.status || '').toLowerCase();
  const status = ['passed', 'failed'].includes(requestedStatus)
    ? requestedStatus
    : score >= 0.7 ? 'passed' : 'failed';
  return {
    status,
    score: Number(score.toFixed(3)),
    rationale: String(parsed.rationale || '').slice(0, 1000),
    checks: parsed.checks && typeof parsed.checks === 'object' && !Array.isArray(parsed.checks)
      ? parsed.checks
      : {},
  };
}

export function buildLlmJudgePrompt({ agentId, caseText, inputText, expectedText, skillText, memoryText }) {
  return `You are judging an applied self-evolution regression case.

Return only compact JSON with:
{"status":"passed|failed","score":0.0-1.0,"rationale":"short reason","checks":{}}

Judge whether the updated SKILL.md and MEMORY.md contain enough reusable guidance
to satisfy the eval case. Do not reward private task memorization.

Agent: ${agentId}

Case:
${caseText}

Replay/user input, if provided:
${inputText || '(none)'}

Expected behavior:
${expectedText || '(none)'}

Updated SKILL.md excerpt:
${String(skillText || '').slice(0, 12000)}

Updated MEMORY.md excerpt:
${String(memoryText || '').slice(0, 6000)}
`;
}

export function recordRegressionEvalCases(db, { runId, agent, proposal, proposalHash, skillPath, memoryPath }) {
  const cases = extractEvalCases(proposal);
  run(db, 'DELETE FROM evolution_regression_evals WHERE run_id = ?', [runId]);
  cases.forEach((item, index) => {
    run(
      db,
      `INSERT INTO evolution_regression_evals (
        id, run_id, agent_id, department_id, case_index, case_text, input_text,
        expected_text, replay_spec_json, source_proposal_hash, skill_hash, memory_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `eval_${cryptoRandom()}`,
        runId,
        agent.id,
        agent.departmentId,
        index,
        item.caseText,
        item.inputText,
        item.expectedText,
        JSON.stringify(item.replaySpec || {}),
        proposalHash,
        sha256Text(readText(skillPath, '')),
        sha256Text(readText(memoryPath, '')),
      ],
    );
  });
  return cases.length;
}

export function runRegressionEvalCases(db, options = {}) {
  return runRegressionEvalCasesInternal(db, options, false);
}

export async function runRegressionEvalCasesAsync(db, options = {}) {
  return runRegressionEvalCasesInternal(db, options, true);
}

function runRegressionEvalCasesInternal(db, {
  runId = '',
  limit = 100,
  root = '',
  agentLookup = {},
  replayRunner = null,
  judgeRunner = null,
} = {}, allowAsync) {
  const rows = all(
    db,
    `SELECT * FROM evolution_regression_evals
     WHERE (? = '' OR run_id = ?)
     ORDER BY created_at DESC LIMIT ?`,
    [runId, runId, limit],
  );
  const stats = { total: 0, passed: 0, failed: 0, skipped: 0, replayed: 0, llm_judged: 0, results: [] };
  if (allowAsync) {
    return (async () => {
      for (const row of rows) await evaluateAndPersistRegressionRow({
        db,
        row,
        root,
        agentLookup,
        replayRunner,
        judgeRunner,
        stats,
        allowAsync: true,
      });
      return stats;
    })();
  }
  for (const row of rows) {
    evaluateAndPersistRegressionRow({
      db,
      row,
      root,
      agentLookup,
      replayRunner,
      judgeRunner,
      stats,
      allowAsync: false,
    });
  }
  return stats;
}

async function evaluateAndPersistRegressionRow({
  db,
  row,
  root,
  agentLookup,
  replayRunner,
  judgeRunner,
  stats,
  allowAsync,
}) {
  stats.total += 1;
  const paths = resolveAgentPaths(row, { root, agentLookup });
  if (!paths.skillPath && !paths.memoryPath) {
    stats.skipped += 1;
    stats.results.push({ id: row.id, status: 'skipped', score: 0, reason: 'agent_paths_unresolved' });
    return;
  }
  const skillText = readText(paths.skillPath, '');
  const memoryText = readText(paths.memoryPath, '');
  const staticScore = staticContractScore({
    caseText: row.case_text,
    expectedText: row.expected_text,
    skillPath: paths.skillPath,
    memoryPath: paths.memoryPath,
  });
  const heuristicScore = heuristicBehaviorScore({
    caseText: row.case_text,
    expectedText: row.expected_text,
    skillText,
    memoryText,
  });
  let replayResult = { status: 'skipped', score: 0, reason: 'no_replay_runner_or_spec' };
  const replaySpec = parseReplaySpec(row.replay_spec_json);
  if (replayRunner && Object.keys(replaySpec).length) {
    try {
      replayResult = replayRunner({
        id: row.id,
        runId: row.run_id,
        agentId: row.agent_id,
        departmentId: row.department_id,
        caseText: row.case_text,
        inputText: row.input_text,
        expectedText: row.expected_text,
        replaySpec,
        skillPath: paths.skillPath,
        memoryPath: paths.memoryPath,
        root,
      });
      if (allowAsync && replayResult && typeof replayResult.then === 'function') replayResult = await replayResult;
      if (!allowAsync && replayResult && typeof replayResult.then === 'function') throw new Error('async replayRunner requires runRegressionEvalCasesAsync');
    } catch (error) {
      replayResult = { status: 'failed', score: 0, error: String(error.message || error).slice(0, 1000) };
    }
    replayResult = normalizeEvalComponent(replayResult);
    stats.replayed += 1;
  }

  let judgeResult = { status: 'skipped', score: 0, reason: 'llm_judge_disabled' };
  if (judgeRunner) {
    try {
      judgeResult = judgeRunner({
        id: row.id,
        runId: row.run_id,
        agentId: row.agent_id,
        departmentId: row.department_id,
        caseText: row.case_text,
        inputText: row.input_text,
        expectedText: row.expected_text,
        skillText,
        memoryText,
        skillPath: paths.skillPath,
        memoryPath: paths.memoryPath,
        root,
      });
      if (allowAsync && judgeResult && typeof judgeResult.then === 'function') judgeResult = await judgeResult;
      if (!allowAsync && judgeResult && typeof judgeResult.then === 'function') throw new Error('async judgeRunner requires runRegressionEvalCasesAsync');
    } catch (error) {
      judgeResult = { status: 'failed', score: 0, error: String(error.message || error).slice(0, 1000) };
    }
    judgeResult = normalizeEvalComponent(judgeResult);
    stats.llm_judged += 1;
  }

  const components = [
    { name: 'static_contract', status: staticScore.status, score: staticScore.score, weight: 0.25 },
    { name: 'heuristic_behavior', status: heuristicScore.status, score: heuristicScore.score, weight: 0.35 },
  ];
  if (replayResult.status !== 'skipped') components.push({ name: 'task_replay', status: replayResult.status, score: replayResult.score, weight: 0.2 });
  if (judgeResult.status !== 'skipped') components.push({ name: 'llm_judge', status: judgeResult.status, score: judgeResult.score, weight: 0.4 });
  const weightSum = components.reduce((sum, item) => sum + item.weight, 0) || 1;
  const score = Number((components.reduce((sum, item) => sum + item.score * item.weight, 0) / weightSum).toFixed(3));
  let requiredPassed = staticScore.status === 'passed' && heuristicScore.status === 'passed';
  if (!['skipped', 'passed'].includes(replayResult.status)) requiredPassed = false;
  if (!['skipped', 'passed'].includes(judgeResult.status)) requiredPassed = false;
  const status = requiredPassed && score >= 0.6 ? 'passed' : 'failed';
  const evaluatorParts = ['static', 'heuristic'];
  if (replayResult.status !== 'skipped') evaluatorParts.push('replay');
  if (judgeResult.status !== 'skipped') evaluatorParts.push('llm_judge');
  const result = {
    static_contract: staticScore,
    heuristic_behavior: heuristicScore,
    task_replay: replayResult,
    llm_judge: judgeResult,
    combined_score: score,
  };
    run(
      db,
      `UPDATE evolution_regression_evals
       SET evaluator_type = ?, status = ?, score = ?, result_json = ?, judge_result_json = ?,
           run_count = run_count + 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
      [
        evaluatorParts.join('_plus_'),
        status,
        score,
        JSON.stringify(result),
        JSON.stringify(judgeResult),
        row.id,
      ],
    );
  stats[status] += 1;
  stats.results.push({ id: row.id, status, score, evaluatorType: evaluatorParts.join('_plus_') });
}

function resolveAgentPaths(row, { root, agentLookup }) {
  const lookup =
    agentLookup?.[`${row.department_id}:${row.agent_id}`] ||
    agentLookup?.[row.agent_id] ||
    null;
  const skillPath = lookup?.skillPath || lookup?.skill_path || lookup?.[1] || '';
  const memoryPath = lookup?.memoryPath || lookup?.memory_path || lookup?.[2] || '';
  if (skillPath || memoryPath) return { skillPath, memoryPath };
  if (!root || !row.department_id || !row.agent_id) return { skillPath: '', memoryPath: '' };
  const agentDir = path.join(root, 'departments', row.department_id, 'agents', row.agent_id);
  return {
    skillPath: path.join(agentDir, 'SKILL.md'),
    memoryPath: path.join(agentDir, 'MEMORY.md'),
  };
}

function parseReplaySpec(value) {
  const parsed = safeJsonParse(value || '{}', {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function normalizeEvalComponent(value) {
  const result = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  const score = Math.max(0, Math.min(1, Number(result.score || 0)));
  const rawStatus = String(result.status || '').toLowerCase();
  const status = ['passed', 'failed', 'skipped'].includes(rawStatus)
    ? rawStatus
    : score >= 0.7 ? 'passed' : 'failed';
  return {
    ...result,
    status,
    score: Number(score.toFixed(3)),
  };
}

function cryptoRandom() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}
