import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';

import { ensureDirSync } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundledProjectRoot = path.resolve(__dirname, '../..');
export const projectRoot = bundledProjectRoot.endsWith(`${path.sep}app.asar`)
  ? `${bundledProjectRoot}.unpacked`
  : bundledProjectRoot;
export const assetRoot = path.join(projectRoot, 'assets');

export function codexStyleUserDataRoot({ explicitRoot = '', homeDir = os.homedir(), directoryName = '.janus' } = {}) {
  return path.resolve(explicitRoot || path.join(homeDir, directoryName));
}

export function prepareCodexStyleUserDataRoot({ legacyUserDataDir = '', explicitRoot = '', homeDir = os.homedir(), directoryName = '.janus' } = {}) {
  const targetRoot = codexStyleUserDataRoot({ explicitRoot, homeDir, directoryName });
  const legacyRuntimeRoot = legacyUserDataDir ? path.resolve(legacyUserDataDir, 'workspace') : '';
  if (legacyRuntimeRoot && legacyRuntimeRoot !== targetRoot && fs.existsSync(legacyRuntimeRoot) && directoryIsEmpty(targetRoot)) {
    fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
    if (fs.existsSync(targetRoot)) fs.rmSync(targetRoot, { recursive: true, force: true });
    try {
      fs.renameSync(legacyRuntimeRoot, targetRoot);
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error;
      fs.cpSync(legacyRuntimeRoot, targetRoot, { recursive: true, errorOnExist: true });
    }
  }
  ensureDirSync(targetRoot);
  return targetRoot;
}

export function resolveRuntimeRoot({ explicitRoot, isDev = false, userDataDir = '' } = {}) {
  const root =
    explicitRoot ||
    process.env.JANUS_HOME ||
    (isDev
      ? path.join(projectRoot, 'workspace')
      : userDataDir || codexStyleUserDataRoot());
  ensureDirSync(root);
  return root;
}

function directoryIsEmpty(directory) {
  if (!fs.existsSync(directory)) return true;
  return fs.statSync(directory).isDirectory() && fs.readdirSync(directory).length === 0;
}

export function dataDir(root) {
  return path.join(root, 'data');
}

export function dbPath(root) {
  return path.join(dataDir(root), 'janus.db');
}

export function tmpDir(root) {
  return path.join(root, '.janus', 'tmp');
}

export function codexTemplateDir(root) {
  return path.join(root, 'config', 'codex');
}

export function departmentsDir(root) {
  return path.join(root, 'departments');
}

export function systemAgentsDir(root) {
  return path.join(root, 'system_agents');
}

export function skillsDir(root) {
  return path.join(root, 'skills');
}

export function pptSkillAgentsDir(root) {
  return path.join(skillsDir(root), 'ppt_creation', 'departments', 'ppt_department', 'agents');
}

export function pptAgentSkillPath(root, agentId) {
  return path.join(pptSkillAgentsDir(root), agentId, 'SKILL.md');
}

export function codexHomeForSession(root, sessionId) {
  return path.join(dataDir(root), 'codex_backend_sessions', sessionId);
}

export function codexMemoriesDir(root) {
  return path.join(dataDir(root), 'codex_memories');
}

export function agentDir(root, departmentId, agentId) {
  return path.join(departmentsDir(root), departmentId, 'agents', agentId);
}

export function hrDir(root, departmentId) {
  return path.join(departmentsDir(root), departmentId, 'hr');
}

export function agentMemoryPath(root, agent) {
  if (agent?.memoryPath) return agent.memoryPath;
  return path.join(agentDir(root, agent.departmentId, agent.id), 'MEMORY.md');
}

export function agentSkillPath(root, agent) {
  if (agent?.skillPath) return agent.skillPath;
  return path.join(agentDir(root, agent.departmentId, agent.id), 'SKILL.md');
}

export function evolutionDir(root, agent) {
  if (agent?.path) return path.join(agent.path, 'evolution');
  return path.join(agentDir(root, agent.departmentId, agent.id), 'evolution');
}

export function skillVersionsDir(root, agent) {
  if (agent?.path) return path.join(agent.path, 'skill_versions');
  return path.join(agentDir(root, agent.departmentId, agent.id), 'skill_versions');
}

export function hrMemoryPath(root, departmentId) {
  return path.join(hrDir(root, departmentId), 'MEMORY.md');
}

export function hrReviewDir(root, departmentId) {
  return path.join(hrDir(root, departmentId), 'reviews');
}

export function projectMemoryPath(root) {
  return path.join(root, 'PROJECT_MEMORY.md');
}
