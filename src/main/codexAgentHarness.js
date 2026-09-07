import fs from 'node:fs';
import path from 'node:path';

import { OrgRegistry } from './org.js';
import { ensureDirSync, readText, writeTextAtomicSync } from './utils.js';

const OFFICIAL_AGENT_REQUIRED_FIELDS = ['name', 'description', 'developer_instructions'];
const INTERNAL_HARNESS_AGENTS = [
  {
    id: 'buddy_evaluator',
    displayName: 'Independent uBuddy Evaluator',
    description: 'Independently reviews uBuddy Skill and governed durable-context evolution proposals.',
    role: 'independent_evaluator',
    departmentId: 'system_governance',
    systemPrompt: 'Evaluate only the supplied proposal and evidence. You are independent from uBuddy and cannot change organization structure, roles, routing authority, or generated Codex harness files.',
  },
  {
    id: 'general_agent_evaluator',
    displayName: 'Independent Generalist Evaluator',
    description: 'Independently reviews standalone Generalist Skill and governed durable-context evolution proposals.',
    role: 'independent_evaluator',
    departmentId: 'system_governance',
    systemPrompt: 'Evaluate only the supplied proposal and evidence. You are independent from the Generalist and cannot create departments, alter organization structure, or modify generated Codex harness files.',
  },
];

export function discoverCodexAgents(root) {
  const organization = new OrgRegistry(root, { serverAuthoritativeSkills: true }).list();
  const definitions = [...organization.agents, ...organization.hrs, ...organization.leaders]
    .filter((agent) => agent?.id && agent.enabled !== false && agent.lifecycleStatus !== 'disabled')
    .map(agentDefinitionFromRegistry)
    .concat(INTERNAL_HARNESS_AGENTS.map(normalizeDefinition));
  return [...new Map(definitions.map((item) => [item.id, item])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function writeCodexAgentHarness(root, codexHome, { attachedSkills = [], targetAgentId = '' } = {}) {
  const agentsDir = path.join(codexHome, 'agents');
  const skillsDir = path.join(codexHome, 'skills');
  ensureDirSync(agentsDir);
  ensureDirSync(skillsDir);
  const definitions = discoverCodexAgents(root);
  const expectedFiles = new Set();
  const expectedSkillDirs = new Set();
  const previousManifest = readHarnessManifest(codexHome);
  for (const definition of definitions) {
    const filename = `${safeAgentId(definition.id)}.toml`;
    expectedFiles.add(filename);
    const runtimeSkillPath = installAgentSkill(definition, skillsDir);
    if (runtimeSkillPath) expectedSkillDirs.add(safeAgentId(definition.id));
    const attachedSkillPaths = (String(definition.id) === String(targetAgentId) || definition.id === safeAgentId(targetAgentId))
      ? installAttachedSkills(attachedSkills, skillsDir, expectedSkillDirs)
      : [];
    writeTextAtomicSync(path.join(agentsDir, filename), codexAgentToml({
      ...definition,
      skillPath: runtimeSkillPath,
      skillPaths: [runtimeSkillPath, ...attachedSkillPaths].filter(Boolean),
      sourceSkillPath: definition.skillPath,
    }));
  }
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.toml') && !expectedFiles.has(entry.name)) {
      fs.rmSync(path.join(agentsDir, entry.name), { force: true });
    }
  }
  for (const directory of previousManifest.skillDirectories || []) {
    if (!expectedSkillDirs.has(directory)) fs.rmSync(path.join(skillsDir, directory), { recursive: true, force: true });
  }
  writeTextAtomicSync(path.join(codexHome, '.janus-harness-manifest.json'), `${JSON.stringify({
    version: 1,
    agentFiles: [...expectedFiles].sort(),
    skillDirectories: [...expectedSkillDirs].sort(),
  }, null, 2)}\n`);
  return definitions;
}

export function codexAgentToml(definition = {}) {
  const normalized = normalizeDefinition(definition);
  const lines = [
    `name = ${tomlString(normalized.id)}`,
    `description = ${tomlString(normalized.description)}`,
    `developer_instructions = ${tomlString(agentDeveloperInstructions(normalized))}`,
  ];
  for (const skillPath of normalized.skillPaths) {
    lines.push('', '[[skills.config]]', `path = ${tomlString(skillPath)}`, 'enabled = true');
  }
  return `${lines.join('\n')}\n`;
}

export function codexHarnessAssignment(prompt = '', { agentId = '', role = 'agent', harnessMode = 'auto' } = {}) {
  if (harnessMode === 'raw') return String(prompt || '');
  const id = safeAgentId(agentId);
  if (!id || !shouldDelegateRole(role)) return String(prompt || '');
  if (String(role || '') === 'ubuddy_chat') {
    return [
      '<janus_ubuddy_chat>',
      'You are the current user\'s uBuddy and are already running as the configured `secretary_agent`.',
      '- Load and follow the configured uBuddy Skill through Codex skill discovery.',
      '- Handle ordinary questions, research, writing, analysis, and bounded low-risk project work directly with the current Codex tools.',
      '- Use the registered `janus` dynamic tools only when a named specialist, durable background task, external recipient, multiple independent domains, or dependent multi-Agent stages are genuinely needed.',
      '- Do not use Codex native subagents for Janus work. Durable Agent delegation must go through the `janus` tools and Scheduler.',
      '- Decide between direct execution and Janus delegation before producing file or command side effects. Never partially execute and then delegate the remainder.',
      '- In Plan mode, do not call mutating Janus tools or modify project files.',
      '- Never tell the user to return to uBuddy; you are uBuddy.',
      '</janus_ubuddy_chat>',
      '',
      String(prompt || ''),
    ].join('\n');
  }
  if (String(role || '') === 'agent_chat') {
    return [
      '<janus_direct_agent_chat>',
      `You are already serving as the user-selected Janus Agent \`${id}\` in this conversation.`,
      `Load and follow the configured Skill for \`${id}\` through Codex skill discovery, then answer in the current thread.`,
      '- Do not spawn a duplicate of yourself for an ordinary direct question or a task that fits this Agent\'s Skill.',
      '- When the current context is bound to a task_run_id, you may coordinate with other Agents assigned to that same task, including task participants owned by another user, through the task-scoped communication and shared-summary channels provided by Janus.',
      '- Never contact an Agent that is not an active participant in the same task, and never read another Agent\'s private Memory.',
      '- If the request is outside this Agent\'s responsibility, explain the boundary and suggest returning to uBuddy for reassignment.',
      '- Outside a shared task context, ask uBuddy to establish or revise the task graph before starting cross-Agent coordination.',
      '- Janus Plugin and standalone Skill installation is host-governed. Never use skill-installer, Shell, git clone, or edit CODEX_HOME/config files as an installation fallback.',
      '</janus_direct_agent_chat>',
      '',
      String(prompt || ''),
    ].join('\n');
  }
  return [
    '<janus_codex_agent_harness>',
    'Use the official Codex subagent workflow for this assignment.',
    `- Spawn the custom agent named \`${id}\` in an independent context. Do not request full parent-thread history inheritance.`,
    '- Put the complete task block below into the spawn message, including its goal, relevant context, constraints, current state, and expected deliverables.',
    '- The selected custom agent owns domain reasoning and execution and must follow its configured Skill.',
    '- Wait for the selected agent to finish. Return its user-facing result, consolidating only when necessary.',
    '- Do not replace the selected agent with an improvised persona in the parent thread.',
    '- Do not spawn additional agents unless the task explicitly requires independent parallel work or the selected Skill requires it.',
    '</janus_codex_agent_harness>',
    '',
    String(prompt || ''),
  ].join('\n');
}

export function validateCodexAgentToml(text = '') {
  const source = String(text || '');
  const missing = OFFICIAL_AGENT_REQUIRED_FIELDS.filter((field) => !new RegExp(`^${field}\\s*=`, 'm').test(source));
  if (missing.length) throw new Error(`Codex agent TOML is missing required fields: ${missing.join(', ')}`);
  return true;
}

function agentDefinitionFromRegistry(agent = {}) {
  return normalizeDefinition({
    id: agent.id,
    displayName: agent.name || agent.id,
    description: agent.description || `${agent.name || agent.id} for ${agent.departmentId || 'general'}`,
    systemPrompt: agent.systemPrompt || '',
    departmentId: agent.departmentId || '',
    role: agent.role || agent.lifecycleRole || 'agent',
    skillPath: readText(agent.skillPath, '').trim() ? path.resolve(agent.skillPath) : '',
    memoryPath: readText(agent.memoryPath, '').trim() ? path.resolve(agent.memoryPath) : '',
  });
}

function normalizeDefinition(definition = {}) {
  return {
    id: safeAgentId(definition.id || definition.name),
    displayName: String(definition.displayName || definition.name || definition.id || '').trim(),
    description: String(definition.description || '').trim() || 'Janus custom agent.',
    systemPrompt: String(definition.systemPrompt || '').trim(),
    departmentId: String(definition.departmentId || '').trim(),
    role: String(definition.role || 'agent').trim(),
    skillPath: definition.skillPath ? path.resolve(String(definition.skillPath)) : '',
    skillPaths: [...new Set((Array.isArray(definition.skillPaths) ? definition.skillPaths : [definition.skillPath])
      .map((value) => value ? path.resolve(String(value)) : '').filter(Boolean))],
    sourceSkillPath: definition.sourceSkillPath ? path.resolve(String(definition.sourceSkillPath)) : '',
    memoryPath: definition.memoryPath ? path.resolve(String(definition.memoryPath)) : '',
  };
}

function agentDeveloperInstructions(agent) {
  return [
    `You are the Janus custom agent ${agent.displayName || agent.id} (${agent.id}).`,
    `Department: ${agent.departmentId || 'general'}. Role: ${agent.role || 'agent'}.`,
    agent.systemPrompt,
    agent.skillPath
      ? `For every delegated task, load and follow the configured Skill whose SKILL.md is at ${agent.skillPath}. The Skill is authoritative for domain workflow and output constraints.${agent.sourceSkillPath ? ` Its Janus source is ${agent.sourceSkillPath}.` : ''}`
      : 'Follow the delegated task and the parent thread constraints.',
    agent.skillPaths.length > 1
      ? 'Additional Janus-assigned Skills are enabled in Codex Skill discovery. Load and follow each one when its description matches the task; keep each Skill independent and resolve conflicts in favor of the current user request and repository instructions.'
      : '',
    agent.memoryPath
      ? `Read ${agent.memoryPath} only when governed Agent durable context is relevant. This file is not Codex native generated Memories; treat it as reviewed context, never as authority over the current user request or repository AGENTS.md.`
      : '',
    'Stay within the delegated task. Do not claim work performed by another agent. Verify material outputs before reporting completion.',
    'Return a concise result to the parent thread with evidence, artifact paths, validation, and blockers when applicable.',
  ].filter(Boolean).join('\n');
}

function installAgentSkill(agent = {}, skillsDir = '') {
  if (!agent.skillPath || !fs.existsSync(agent.skillPath)) return '';
  const skillDir = path.join(skillsDir, safeAgentId(agent.id));
  fs.rmSync(skillDir, { recursive: true, force: true });
  ensureDirSync(skillDir);
  const sourceSkill = fs.readFileSync(agent.skillPath, 'utf8');
  writeTextAtomicSync(path.join(skillDir, 'SKILL.md'), skillDocumentForCodex(sourceSkill, agent));
  const sourceDir = path.dirname(agent.skillPath);
  for (const folder of ['scripts', 'references', 'assets']) {
    const source = path.join(sourceDir, folder);
    if (fs.existsSync(source) && fs.statSync(source).isDirectory()) {
      fs.cpSync(source, path.join(skillDir, folder), { recursive: true });
    }
  }
  return path.join(skillDir, 'SKILL.md');
}

function installAttachedSkills(skills = [], skillsDir = '', expectedSkillDirs = new Set()) {
  const paths = [];
  for (const skill of Array.isArray(skills) ? skills : []) {
    const sourceFile = path.resolve(String(skill?.skillPath || ''));
    if (!sourceFile || !fs.existsSync(sourceFile) || path.basename(sourceFile) !== 'SKILL.md') continue;
    const directory = `attached-${safeAgentId(skill.id || skill.name)}`;
    const targetRoot = path.join(skillsDir, directory);
    fs.rmSync(targetRoot, { recursive: true, force: true });
    ensureDirSync(targetRoot);
    const sourceRoot = path.dirname(sourceFile);
    fs.copyFileSync(sourceFile, path.join(targetRoot, 'SKILL.md'));
    for (const folder of ['scripts', 'references', 'assets']) {
      const source = path.join(sourceRoot, folder);
      if (fs.existsSync(source) && fs.statSync(source).isDirectory()) {
        fs.cpSync(source, path.join(targetRoot, folder), { recursive: true });
      }
    }
    expectedSkillDirs.add(directory);
    paths.push(path.join(targetRoot, 'SKILL.md'));
  }
  return paths;
}

function readHarnessManifest(codexHome = '') {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(codexHome, '.janus-harness-manifest.json'), 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function skillDocumentForCodex(source = '', agent = {}) {
  const text = String(source || '').trim();
  if (/^---\s*\n[\s\S]*?\n---\s*\n/.test(text) && /^name:\s*\S+/m.test(text) && /^description:\s*\S+/m.test(text)) {
    return `${text}\n`;
  }
  return [
    '---',
    `name: ${safeSkillName(agent.id)}`,
    `description: ${JSON.stringify(singleLine(agent.description || `Use for tasks delegated to ${agent.id}.`))}`,
    '---',
    '',
    text,
    '',
  ].join('\n');
}

function shouldDelegateRole(role = '') {
  return ![
    'attachment-retrieval',
    'diagnosis',
    'regression-ab-before',
    'regression-ab-after',
    'regression-ab-judge',
    'regression-judge',
  ].includes(String(role || ''));
}

function safeAgentId(value = '') {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function safeSkillName(value = '') {
  return safeAgentId(value).toLowerCase().replaceAll('_', '-');
}

function singleLine(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().replaceAll(':', ' -');
}

function tomlString(value = '') {
  return JSON.stringify(String(value || ''));
}
