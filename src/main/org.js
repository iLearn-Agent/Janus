import fs from 'node:fs';
import path from 'node:path';

import { assetRoot, departmentsDir, pptAgentSkillPath, systemAgentsDir } from './paths.js';
import { listDirs, parseJsonFile, readText, syncDirFromSeed, writeTextAtomicSync } from './utils.js';
import { isRetiredDepartmentId } from '../shared/departments.js';
import { isSkillPackageInstalled } from '../shared/skillPackages.js';

const seedManifestCache = new Map();
const INSTALLABLE_PPT_AGENT_IDS = new Set(['ppt']);

export class OrgRegistry {
  constructor(root, { serverAuthoritativeSkills = false } = {}) {
    this.root = root;
    this.serverAuthoritativeSkills = serverAuthoritativeSkills;
  }

  async seedFromAssets() {
    const source = path.join(assetRoot, 'departments');
    const target = departmentsDir(this.root);
    if (!fs.existsSync(source)) {
      throw new Error(`Missing seeded departments at ${source}`);
    }
    const manifestPath = path.join(target, '.janus-seed-manifest.json');
    const previousManifest = parseJsonFile(manifestPath, { hashes: {} });
    const syncResult = await syncDirFromSeed(source, target, {
      previousHashes: previousManifest?.hashes || {},
    });
    const seedFiles = syncResult.files.filter((relative) => fs.existsSync(path.join(target, relative)));
    writeTextAtomicSync(manifestPath, `${JSON.stringify({
      version: 2,
      source: 'assets/departments',
      files: seedFiles,
      hashes: syncResult.hashes,
      preserved: syncResult.preserved,
    }, null, 2)}\n`);
    seedManifestCache.delete(target);

    const systemSource = path.join(assetRoot, 'system_agents');
    const systemTarget = systemAgentsDir(this.root);
    if (fs.existsSync(systemSource)) {
      const systemManifestPath = path.join(systemTarget, '.janus-seed-manifest.json');
      const previousSystemManifest = parseJsonFile(systemManifestPath, { hashes: {} });
      const systemSync = await syncDirFromSeed(systemSource, systemTarget, {
        previousHashes: previousSystemManifest?.hashes || {},
      });
      writeTextAtomicSync(systemManifestPath, `${JSON.stringify({
        version: 1,
        source: 'assets/system_agents',
        files: systemSync.files,
        hashes: systemSync.hashes,
        preserved: systemSync.preserved,
      }, null, 2)}\n`);
    }
  }

  async seedSkillPackagesFromAssets() {
    const source = path.join(assetRoot, 'skills');
    const target = path.join(this.root, 'skills');
    if (!fs.existsSync(source)) throw new Error(`Missing seeded skills at ${source}`);
    const manifestPath = path.join(target, '.janus-seed-manifest.json');
    const previousManifest = parseJsonFile(manifestPath, { hashes: {} });
    const syncResult = await syncDirFromSeed(source, target, {
      previousHashes: previousManifest?.hashes || {},
    });
    writeTextAtomicSync(manifestPath, `${JSON.stringify({
      version: 1,
      source: 'assets/skills',
      files: syncResult.files,
      hashes: syncResult.hashes,
      preserved: syncResult.preserved,
    }, null, 2)}\n`);
  }

  list() {
    const departments = [];
    const agents = [];
    const hrs = [];
    const leaders = [];
    for (const departmentPath of listDirs(departmentsDir(this.root))) {
      const department = parseJsonFile(path.join(departmentPath, 'department.json'), null);
      if (!department?.id) continue;
      if (isRetiredDepartmentId(department.id)) continue;
      departments.push({
        id: department.id,
        name: department.name || department.id,
        description: department.description || '',
        path: departmentPath,
      });

      const hr = this.readHr(department.id);
      if (hr) hrs.push(hr);

      const leader = this.readLeader(department.id);
      if (leader) leaders.push(leader);

      const agentsPath = path.join(departmentPath, 'agents');
      for (const agentPath of listDirs(agentsPath)) {
        const agent = this.readAgent(department.id, path.basename(agentPath));
        if (agent) agents.push(agent);
      }
    }
    for (const agentPath of listDirs(systemAgentsDir(this.root))) {
      const agent = this.readSystemAgent(path.basename(agentPath));
      if (agent) agents.push(agent);
    }
    return { departments, agents, hrs, leaders };
  }

  department(departmentId) {
    return this.list().departments.find((department) => department.id === departmentId) || null;
  }

  readAgent(departmentId, agentId) {
    const agentPath = path.join(departmentsDir(this.root), departmentId, 'agents', agentId);
    const raw = parseJsonFile(path.join(agentPath, 'agent.json'), null);
    if (!raw?.id) return null;
    const lifecycle = parseJsonFile(path.join(agentPath, 'lifecycle.json'), {});
    const installablePptSkill = departmentId === 'ppt_department' && INSTALLABLE_PPT_AGENT_IDS.has(agentId);
    const skillPath = installablePptSkill ? pptAgentSkillPath(this.root, agentId) : path.join(agentPath, 'SKILL.md');
    const normalized = normalizeAgent(raw, {
      departmentId,
      role: 'agent',
      path: agentPath,
      skillPath,
      memoryPath: path.join(agentPath, 'MEMORY.md'),
      evolutionSummary: readAgentEvolutionSummary(agentPath),
    }, lifecycle);
    if (!installablePptSkill) return normalized;
    const skillInstalled = this.serverAuthoritativeSkills
      ? Boolean(readText(skillPath, '').trim())
      : isSkillPackageInstalled(this.root, 'ppt_creation');
    return {
      ...normalized,
      skillPackageId: 'ppt_creation',
      skillInstalled,
      enabled: normalized.enabled && skillInstalled,
      routable: normalized.routable && skillInstalled,
    };
  }

  readHr(departmentId) {
    const hrPath = path.join(departmentsDir(this.root), departmentId, 'hr');
    const raw = parseJsonFile(path.join(hrPath, 'agent.json'), null);
    if (!raw?.id) return null;
    return normalizeAgent(raw, {
      departmentId,
      role: 'hr',
      path: hrPath,
      skillPath: path.join(hrPath, 'SKILL.md'),
      memoryPath: path.join(hrPath, 'MEMORY.md'),
    });
  }

  readSystemAgent(agentId) {
    const agentPath = path.join(systemAgentsDir(this.root), agentId);
    const raw = parseJsonFile(path.join(agentPath, 'agent.json'), null);
    if (!raw?.id) return null;
    return normalizeAgent(raw, {
      departmentId: 'general',
      role: 'system_agent',
      path: agentPath,
      skillPath: path.join(agentPath, 'SKILL.md'),
      memoryPath: path.join(agentPath, 'MEMORY.md'),
      evolutionSummary: readAgentEvolutionSummary(agentPath),
      standalone: true,
    }, parseJsonFile(path.join(agentPath, 'lifecycle.json'), {}));
  }

  readLeader(departmentId) {
    const leaderPath = path.join(departmentsDir(this.root), departmentId, 'leader');
    const raw = parseJsonFile(path.join(leaderPath, 'agent.json'), null);
    if (!raw?.id) return null;
    return normalizeAgent(raw, {
      departmentId,
      role: 'department_leader',
      path: leaderPath,
      skillPath: path.join(leaderPath, 'SKILL.md'),
      memoryPath: path.join(leaderPath, 'MEMORY.md'),
    }, {
      status: raw.enabled === false ? 'disabled' : 'active',
      routing_state: 'lead_only',
      role: 'lead_specialist',
      rank: 'lead',
      automatic_routing: false,
    });
  }

  agent(agentId) {
    return this.list().agents.find((agent) => agent.id === agentId) || null;
  }

  agentsForDepartment(departmentId, { routableOnly = false } = {}) {
    return this.list().agents.filter((agent) => (
      agent.departmentId === departmentId &&
      (!routableOnly || agent.routable)
    ));
  }

  routableAgentsForDepartment(departmentId) {
    return this.agentsForDepartment(departmentId, { routableOnly: true });
  }

  hrForDepartment(departmentId) {
    return this.list().hrs.find((hr) => hr.departmentId === departmentId) || null;
  }

  leaderForDepartment(departmentId) {
    return this.list().leaders.find((leader) => leader.departmentId === departmentId) || null;
  }

  highestLeadAgents() {
    const organization = this.list();
    const candidates = [
      ...organization.leaders,
      ...organization.agents.filter((agent) => agent.rank === 'lead' || agent.lifecycleRole === 'lead_specialist'),
    ];
    return [...new Map(candidates
      .filter((agent) => agent.enabled !== false && agent.lifecycleStatus !== 'disabled')
      .map((agent) => [agent.id, agent])).values()];
  }

  readSkill(agent) {
    return readText(agent.skillPath, '');
  }

  readMemory(agent) {
    return readText(agent.memoryPath, '');
  }
}

function normalizeAgent(raw, extra, lifecycleFile = {}) {
  const evolution = raw.evolution || {};
  const lifecycle = normalizeLifecycle(raw, lifecycleFile, extra.role);
  return {
    id: raw.id,
    name: raw.name || raw.id,
    description: raw.description || '',
    skills: Array.isArray(raw.skills) ? raw.skills : [],
    systemPrompt: raw.system_prompt || raw.systemPrompt || '',
    selfEvolutionPrompt: raw.self_evolution_prompt || raw.selfEvolutionPrompt || '',
    debatePrompt: raw.debate_prompt || raw.debatePrompt || '',
    evolutionIntervalHours: Number(evolution.interval_hours || evolution.intervalHours || 24),
    minMessagesForEvolution: Number(evolution.min_messages || evolution.minMessages || 5),
    enabled: lifecycle.enabled,
    lifecycle,
    lifecycleStatus: lifecycle.status,
    routingState: lifecycle.routingState,
    lifecycleRole: lifecycle.role,
    rank: lifecycle.rank,
    probationUntil: lifecycle.probationUntil,
    permissions: lifecycle.permissions,
    routable: lifecycle.routable,
    evolutionSummary: extra.evolutionSummary || null,
    ...extra,
  };
}

function readAgentEvolutionSummary(agentPath) {
  const evolutionPath = path.join(agentPath, 'evolution');
  const skillVersionsPath = path.join(agentPath, 'skill_versions');
  const snapshotsPath = path.join(agentPath, 'evolution_archive', 'snapshots');
  const proposals = listMarkdownFiles(evolutionPath);
  const skillVersions = listMarkdownFiles(skillVersionsPath);
  const snapshots = listMarkdownFiles(snapshotsPath);
  const memorySnapshots = snapshots.filter((item) => item.name.includes('memory-'));
  const skillSnapshots = snapshots.filter((item) => item.name.includes('skill-'));
  const runtimeProposals = proposals.filter((item) => item.sourceKind === 'runtime_real');
  const runtimeSkillVersions = skillVersions.filter((item) => item.sourceKind === 'runtime_real');
  const runtimeMemorySnapshots = memorySnapshots.filter((item) => item.sourceKind === 'runtime_real');
  const runtimeSkillSnapshots = skillSnapshots.filter((item) => item.sourceKind === 'runtime_real');
  const latest = runtimeProposals[0] || null;
  const latestText = latest ? readText(latest.path, '') : '';
  return {
    proposalCount: runtimeProposals.length,
    totalProposalCount: proposals.length,
    runtimeProposalCount: runtimeProposals.length,
    seedProposalCount: proposals.filter((item) => item.sourceKind.startsWith('seed')).length,
    skillVersionCount: runtimeSkillVersions.length,
    totalSkillVersionCount: skillVersions.length,
    runtimeSkillVersionCount: runtimeSkillVersions.length,
    seedSkillVersionCount: skillVersions.filter((item) => item.sourceKind.startsWith('seed')).length,
    snapshotCount: snapshots.length,
    memorySnapshotCount: memorySnapshots.length,
    skillSnapshotCount: skillSnapshots.length,
    latestProposalPath: latest?.path || '',
    latestProposalName: latest?.name || '',
    latestEvolutionAt: latest?.mtimeIso || runtimeSkillVersions[0]?.mtimeIso || runtimeSkillSnapshots[0]?.mtimeIso || '',
    latestSourceKind: latest?.sourceKind || runtimeSkillVersions[0]?.sourceKind || runtimeSkillSnapshots[0]?.sourceKind || '',
    latestSummary: clipText(extractMarkdownSection(latestText, 'Summary') || firstMeaningfulLine(latestText), 420),
    memoryChanged: /proposed memory|memory patch|memory replacement/i.test(latestText) || runtimeMemorySnapshots.length > 0,
    skillChanged: /proposed skill|skill patch|add to \*\*|skill_versions/i.test(latestText) || runtimeSkillVersions.length > 0 || runtimeSkillSnapshots.length > 0,
  };
}

function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => {
      const filePath = path.join(dir, entry.name);
      const stat = fs.statSync(filePath);
      return {
        name: entry.name,
        path: filePath,
        mtimeMs: stat.mtimeMs,
        mtimeIso: stat.mtime.toISOString(),
        sourceKind: evolutionFileSourceKind(filePath),
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function evolutionFileSourceKind(filePath) {
  const marker = `${path.sep}departments${path.sep}`;
  const index = filePath.indexOf(marker);
  if (index < 0) return 'runtime_real';
  const relative = filePath.slice(index + marker.length);
  const departmentsRoot = filePath.slice(0, index + `${path.sep}departments`.length);
  const manifest = seedManifestFor(departmentsRoot);
  const seededPath = path.join(assetRoot, 'departments', relative);
  if (!manifest.has(relative) || !fs.existsSync(seededPath)) return 'runtime_real';
  try {
    return fs.readFileSync(filePath).equals(fs.readFileSync(seededPath)) ? 'seed' : 'seed_modified';
  } catch {
    return 'seed';
  }
}

function seedManifestFor(departmentsRoot) {
  if (seedManifestCache.has(departmentsRoot)) return seedManifestCache.get(departmentsRoot);
  const parsed = parseJsonFile(path.join(departmentsRoot, '.janus-seed-manifest.json'), { files: [] });
  const files = new Set(Array.isArray(parsed?.files) ? parsed.files.map(String) : []);
  seedManifestCache.set(departmentsRoot, files);
  return files;
}

function extractMarkdownSection(text, heading) {
  if (!text) return '';
  const lines = String(text).split(/\r?\n/);
  const target = String(heading || '').trim().toLowerCase();
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index]);
    if (!match) continue;
    if (match[2].trim().toLowerCase() === target) {
      start = index + 1;
      level = match[1].length;
      break;
    }
  }
  if (start < 0) return '';
  const body = [];
  for (let index = start; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+/.exec(lines[index]);
    if (match && match[1].length <= level) break;
    body.push(lines[index]);
  }
  return body.join('\n').trim();
}

function firstMeaningfulLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line && !line.startsWith('---')) || '';
}

function clipText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}...` : text;
}

function normalizeLifecycle(raw, lifecycleFile = {}, orgRole = 'agent') {
  const rawLifecycle = isObject(raw.lifecycle) ? raw.lifecycle : {};
  const canary = isObject(raw.canary) ? raw.canary : {};
  const disabledReason = normalizeState(raw.disabled_reason || raw.disabledReason);
  const enabled = raw.enabled !== false && lifecycleFile.enabled !== false && rawLifecycle.enabled !== false;
  let status = normalizeState(firstText(
    lifecycleFile.status,
    rawLifecycle.status,
    canary.state,
    raw.routing_state,
    raw.routingState,
    enabled ? 'active' : disabledReason,
  ));
  if (!enabled && (!status || status === 'active')) status = disabledReason || 'disabled';
  const routingState = normalizeState(firstText(
    lifecycleFile.routing_state,
    lifecycleFile.routingState,
    rawLifecycle.routing_state,
    rawLifecycle.routingState,
    raw.routing_state,
    raw.routingState,
    canary.state,
    status,
  )) || 'active';
  const blockedStates = new Set(['shadow', 'canary', 'paused', 'retired', 'merged', 'disabled', 'inactive', 'rejected']);
  const role = normalizeLifecycleRole(firstText(
    lifecycleFile.role,
    lifecycleFile.lifecycle_role,
    lifecycleFile.lifecycleRole,
    rawLifecycle.role,
    rawLifecycle.lifecycle_role,
    rawLifecycle.lifecycleRole,
    canary.role,
  ), status, orgRole);
  return {
    status: status || 'active',
    routingState,
    role,
    rank: normalizeState(firstText(lifecycleFile.rank, rawLifecycle.rank, raw.rank)) || (role === 'lead_specialist' ? 'lead' : 'specialist'),
    probationUntil: firstText(lifecycleFile.probation_until, lifecycleFile.probationUntil, rawLifecycle.probation_until, rawLifecycle.probationUntil),
    permissions: normalizePermissions(firstObject(
      lifecycleFile.permissions,
      rawLifecycle.permissions,
      raw.permissions,
    ), role, status, routingState, enabled),
    enabled,
    routable: enabled && !blockedStates.has(status) && !blockedStates.has(routingState),
    startedByReviewId: firstText(
      lifecycleFile.started_by_review_id,
      rawLifecycle.started_by_review_id,
      rawLifecycle.startedByReviewId,
      canary.started_by_hr_review,
      raw.created_by_hr_review,
    ),
    baselineAgentId: firstText(lifecycleFile.baseline_agent_id, rawLifecycle.baseline_agent_id, rawLifecycle.baselineAgentId),
    sourceAgents: Array.isArray(lifecycleFile.source_agents)
      ? lifecycleFile.source_agents
      : Array.isArray(raw.source_agents)
        ? raw.source_agents
        : Array.isArray(rawLifecycle.source_agents)
          ? rawLifecycle.source_agents
          : [],
    targetAgents: Array.isArray(lifecycleFile.target_agents)
      ? lifecycleFile.target_agents
      : Array.isArray(rawLifecycle.target_agents)
        ? rawLifecycle.target_agents
        : [],
    promotionRule: firstText(lifecycleFile.promotion_rule, rawLifecycle.promotion_rule, canary.promotion_rule),
  };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstObject(...values) {
  return values.find((value) => isObject(value)) || {};
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function normalizeState(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function normalizeLifecycleRole(value, status, orgRole) {
  const role = normalizeState(value);
  if (role) return role;
  if (orgRole === 'hr') return 'department_hr';
  if (status === 'canary' || status === 'shadow') return 'probationary_specialist';
  if (status === 'retired' || status === 'merged' || status === 'disabled' || status === 'rejected') return 'archived_specialist';
  return 'specialist';
}

function normalizePermissions(raw, role, status, routingState, enabled) {
  const base = defaultPermissions(role, status, routingState, enabled);
  const merged = { ...base };
  for (const [key, value] of Object.entries(raw || {})) {
    if (!key) continue;
    merged[normalizePermissionKey(key)] = value;
  }
  merged.automaticRouting = Boolean(merged.automaticRouting);
  merged.canWriteLongTermMemory = Boolean(merged.canWriteLongTermMemory);
  merged.canSelfEvolve = Boolean(merged.canSelfEvolve);
  merged.canLeadTask = Boolean(merged.canLeadTask);
  merged.canReviewEvolution = Boolean(merged.canReviewEvolution);
  merged.canManageRoster = Boolean(merged.canManageRoster);
  merged.canChangeOrganization = Boolean(merged.canChangeOrganization);
  merged.canCalibrateGate = Boolean(merged.canCalibrateGate);
  merged.routingPriority = Number.isFinite(Number(merged.routingPriority)) ? Number(merged.routingPriority) : base.routingPriority;
  merged.memoryWritePolicy = String(merged.memoryWritePolicy || base.memoryWritePolicy || 'reviewed');
  return merged;
}

function defaultPermissions(role, status, routingState, enabled) {
  const activeRouting = enabled && status === 'active' && routingState === 'active';
  if (role === 'department_hr') {
    return {
      automaticRouting: true,
      canWriteLongTermMemory: true,
      memoryWritePolicy: 'hr_reviewed',
      canSelfEvolve: true,
      canLeadTask: true,
      canReviewEvolution: true,
      canManageRoster: true,
      canChangeOrganization: true,
      canCalibrateGate: true,
      routingPriority: 5,
    };
  }
  if (role === 'probationary_specialist' || status === 'canary' || routingState === 'canary') {
    return {
      automaticRouting: false,
      canWriteLongTermMemory: false,
      memoryWritePolicy: 'hr_review_required',
      canSelfEvolve: false,
      canLeadTask: false,
      canReviewEvolution: false,
      canManageRoster: false,
      canChangeOrganization: false,
      canCalibrateGate: false,
      routingPriority: 80,
    };
  }
  if (!enabled || role === 'archived_specialist') {
    return {
      automaticRouting: false,
      canWriteLongTermMemory: false,
      memoryWritePolicy: 'archived',
      canSelfEvolve: false,
      canLeadTask: false,
      canReviewEvolution: false,
      canManageRoster: false,
      canChangeOrganization: false,
      canCalibrateGate: false,
      routingPriority: 100,
    };
  }
  return {
    automaticRouting: activeRouting,
    canWriteLongTermMemory: true,
    memoryWritePolicy: 'reviewed',
    canSelfEvolve: true,
    canLeadTask: false,
    canReviewEvolution: false,
    canManageRoster: false,
    canChangeOrganization: false,
    canCalibrateGate: false,
    routingPriority: 50,
  };
}

function normalizePermissionKey(key) {
  const text = String(key || '').trim();
  return text.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
}
