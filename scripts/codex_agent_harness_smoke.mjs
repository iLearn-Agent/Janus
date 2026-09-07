import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import {
  codexAgentToml,
  codexHarnessAssignment,
  discoverCodexAgents,
  validateCodexAgentToml,
  writeCodexAgentHarness,
} from '../src/main/codexAgentHarness.js';
import { validateAgentProposal } from '../src/main/gate.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-codex-harness-'));
const codexHome = path.join(root, 'codex-home');
const runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });

try {
  const agents = discoverCodexAgents(root);
  for (const id of [
    'general_agent',
    'secretary_agent',
    'ppt',
    'ppt_hr',
    'ppt_leader',
    'buddy_evaluator',
    'general_agent_evaluator',
  ]) {
    assert.ok(agents.some((agent) => agent.id === id), `missing official Codex agent definition: ${id}`);
  }

  writeCodexAgentHarness(root, codexHome);
  for (const agent of agents) {
    const agentTomlPath = path.join(codexHome, 'agents', `${agent.id}.toml`);
    const skillPath = path.join(codexHome, 'skills', agent.id, 'SKILL.md');
    assert.ok(fs.existsSync(agentTomlPath), `missing TOML for ${agent.id}`);
    assert.equal(validateCodexAgentToml(fs.readFileSync(agentTomlPath, 'utf8')), true);
    assert.equal(validateCodexAgentToml(codexAgentToml(agent)), true);
    if (agent.skillPath) {
      assert.ok(fs.existsSync(skillPath), `missing installed Skill for ${agent.id}`);
      const skill = fs.readFileSync(skillPath, 'utf8');
      assert.match(skill, /^---\n[\s\S]*?^name:\s*\S+/m);
      assert.match(skill, /^description:\s*\S+/m);
    }
  }

  const secretarySkillPath = path.join(codexHome, 'skills', 'secretary_agent', 'SKILL.md');
  const secretaryProtocolPath = path.join(codexHome, 'skills', 'secretary_agent', 'references', 'operating-protocol.md');
  const secretarySkill = fs.readFileSync(secretarySkillPath, 'utf8');
  assert.ok(fs.existsSync(secretaryProtocolPath), 'secretary operating protocol was not installed with the Codex Skill');
  assert.match(secretarySkill, /Context-first decision workflow/);
  assert.match(secretarySkill, /Result-version discipline/);
  assert.match(secretarySkill, /Completion is defined by the task outcome, not by an arbitrary elapsed time/);
  assert.match(fs.readFileSync(secretaryProtocolPath, 'utf8'), /按任务群里的两条要求完成结果，生成可提交版本/);
  assert.match(fs.readFileSync(secretaryProtocolPath, 'utf8'), /提交 the successful retry|Submit the successful retry/i);

  const assignment = codexHarnessAssignment('Complete the task.', {
    agentId: 'general_agent',
    role: 'agent_chat',
  });
  assert.match(assignment, /already serving as the user-selected Janus Agent `general_agent`/);
  assert.match(assignment, /same task/);
  assert.doesNotMatch(assignment, /Spawn the custom agent named/);

  const delegatedAssignment = codexHarnessAssignment('TASK_CONTRACT_SENTINEL', {
    agentId: 'general_agent',
    role: 'task-worker',
  });
  assert.match(delegatedAssignment, /Spawn the custom agent named `general_agent` in an independent context/);
  assert.match(delegatedAssignment, /Do not request full parent-thread history inheritance/);
  assert.match(delegatedAssignment, /Put the complete task block below into the spawn message/);
  assert.match(delegatedAssignment, /goal, relevant context, constraints, current state, and expected deliverables/);
  assert.match(delegatedAssignment, /TASK_CONTRACT_SENTINEL$/);

  const pythonHarnessSource = fs.readFileSync(
    new URL('../src/main/ppt_service/janus_lab/codex_runner.py', import.meta.url),
    'utf8',
  );
  assert.match(pythonHarnessSource, /in an independent context/);
  assert.match(pythonHarnessSource, /Do not request full parent-thread history inheritance/);
  assert.match(pythonHarnessSource, /Put the complete task block below into the spawn message/);
  const invalidEvolution = `## Summary\nUnsafe harness edit.\n\n## Proposed memory replacement\nno-op\n\n## Proposed memory patch\n- Workflow Notes: edit $CODEX_HOME/agents/general_agent.toml developer_instructions\n\n## Proposed skill patch\nno-op\n\n## Eval cases\nInput: test\nExpected: reject\n\n## HR notes\nnone\n\n## Risks\nGenerated harness mutation.`;
  assert.ok(validateAgentProposal({ id: 'general_agent' }, invalidEvolution).some((error) => error.includes('generated or authoritative Codex harness surface')));
  console.log('Codex agent harness smoke passed.');
} finally {
  runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
}
