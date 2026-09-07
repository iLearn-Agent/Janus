import fs from 'node:fs';
import path from 'node:path';

import { assetRoot, pptSkillAgentsDir } from './paths.js';
import { installPythonPackage, pptDependencyStatus } from './python.js';
import { readText } from './utils.js';
import {
  isSkillPackageInstalled,
  readCachedSkillPackage,
  setSkillPackageInstalled,
  skillPackageInstallRoot,
  skillPackageState,
} from '../shared/skillPackages.js';
import { normalizePptStyleId } from '../shared/pptAgents.js';

const PPT_SKILL_PACKAGE_ID = 'ppt_creation';

const PPT_STYLE_SKILLS = Object.freeze({
  general: Object.freeze({
    id: 'ppt-style-general',
    label: '通用PPT风格',
    skillName: 'ppt-general',
    relativePath: path.join('ppt', 'styles', 'ppt-general', 'SKILL.md'),
  }),
  academic_report: Object.freeze({
    id: 'ppt-style-academic-report',
    label: '学术汇报风格',
    skillName: 'ppt-academic-report',
    relativePath: path.join('ppt', 'styles', 'ppt-academic-report', 'SKILL.md'),
  }),
  major_project: Object.freeze({
    id: 'ppt-style-major-project',
    label: '重大项目风格',
    skillName: 'ppt-major-project',
    relativePath: path.join('ppt', 'styles', 'ppt-major-project', 'SKILL.md'),
  }),
});

const PPT_SKILL_FILES = Object.freeze([
  Object.freeze({ id: 'ppt', label: 'PPT 公共技能', skillName: 'ppt', relativePath: path.join('ppt', 'SKILL.md') }),
  ...Object.values(PPT_STYLE_SKILLS),
]);

const PPT_STYLE_SKILL_START = '<!-- JANUS PPT STYLE SKILL START -->';
const PPT_STYLE_SKILL_END = '<!-- JANUS PPT STYLE SKILL END -->';

function pptBundledPackageRoot() {
  return path.join(assetRoot, 'skills', PPT_SKILL_PACKAGE_ID);
}

function pptSkillBundleRoot() {
  return path.join(pptBundledPackageRoot(), 'departments', 'ppt_department', 'agents');
}

function pptSkillSource(root) {
  const cached = readCachedSkillPackage(root, PPT_SKILL_PACKAGE_ID);
  const cachedAgentsRoot = cached ? path.join(cached.root, 'departments', 'ppt_department', 'agents') : '';
  const cachedComplete = cached && PPT_SKILL_FILES.every((item) => validSkillDocument(
    readText(path.join(cachedAgentsRoot, item.relativePath), ''),
    item.skillName,
  ));
  return cachedComplete
    ? { root: cached.root, agentsRoot: cachedAgentsRoot, source: 'server', version: cached.releaseVersion || cached.bundleId || '' }
    : { root: pptBundledPackageRoot(), agentsRoot: pptSkillBundleRoot(), source: 'bundled', version: 'bundled' };
}

function bundleSkillPath(root, relativePath) {
  return path.join(pptSkillSource(root).agentsRoot, relativePath);
}

function targetSkillPath(root, relativePath) {
  return path.join(pptSkillAgentsDir(root), relativePath);
}

export function pptSkillInstallRoot(root) {
  return pptSkillAgentsDir(root);
}

function skillFileStatus(root, descriptor) {
  const sourcePath = bundleSkillPath(root, descriptor.relativePath);
  const targetPath = targetSkillPath(root, descriptor.relativePath);
  const sourceText = readText(sourcePath, '');
  const targetText = readText(targetPath, '');
  return {
    id: descriptor.id,
    label: descriptor.label,
    available: validSkillDocument(sourceText, descriptor.skillName),
    installed: validSkillDocument(targetText, descriptor.skillName),
    sourcePath,
    targetPath,
    size: Buffer.byteLength(targetText, 'utf8'),
  };
}

export function pptSkillStatus(root, { appVersion = '' } = {}) {
  const files = PPT_SKILL_FILES.map((descriptor) => skillFileStatus(root, descriptor));
  const available = files.every((item) => item.available);
  const installed = isSkillPackageInstalled(root, PPT_SKILL_PACKAGE_ID) && files.every((item) => item.installed);
  const missing = files.filter((item) => !item.installed).map((item) => item.label).join(', ');
  const dependencies = pptDependencyStatus(root);
  const ready = installed && dependencies.installed;
  const source = pptSkillSource(root);
  const localState = skillPackageState(root, PPT_SKILL_PACKAGE_ID);
  const publicVersion = String(appVersion || '').trim() || localState.version || source.version;
  return {
    id: 'ppt_creation',
    name: 'PPT 制作技能',
    installed,
    available,
    downloaded: installed,
    ready,
    version: publicVersion,
    source: localState.source || source.source,
    availableVersion: String(appVersion || '').trim() || source.version,
    packageVersion: localState.version || source.version,
    error: available ? dependencies.error : 'PPT 制作技能包缺失。',
    missing: ready ? '' : [missing, dependencies.error].filter(Boolean).join('；'),
    python: dependencies.python,
    pythonVersion: dependencies.pythonVersion,
    platform: dependencies.platform,
    architecture: dependencies.architecture,
    runtimeMode: dependencies.runtimeMode,
    packagedRuntime: dependencies.packagedRuntime,
    dependencies: dependencies.dependencies,
    previewExporters: dependencies.previewExporters,
    skillFiles: files.map(({ id, label, available: itemAvailable, installed: itemInstalled, size }) => ({
      id,
      label,
      available: itemAvailable,
      installed: itemInstalled,
      size,
    })),
  };
}

export function resolvePptStyleSkill(root, styleId = 'general') {
  const requestedStyleId = normalizePptStyleId(styleId);
  const requested = PPT_STYLE_SKILLS[requestedStyleId] || PPT_STYLE_SKILLS.general;
  const general = PPT_STYLE_SKILLS.general;
  const packageSource = pptSkillSource(root);
  const candidates = [
    { descriptor: requested, path: targetSkillPath(root, requested.relativePath), source: 'installed', fallback: false },
    { descriptor: requested, path: path.join(packageSource.agentsRoot, requested.relativePath), source: packageSource.source, fallback: false },
    ...(requested === general ? [] : [
      { descriptor: general, path: targetSkillPath(root, general.relativePath), source: 'installed', fallback: true },
      { descriptor: general, path: path.join(packageSource.agentsRoot, general.relativePath), source: packageSource.source, fallback: true },
    ]),
  ];
  for (const candidate of candidates) {
    const content = readText(candidate.path, '');
    if (!validSkillDocument(content, candidate.descriptor.skillName)) continue;
    return {
      requestedStyleId,
      styleId: styleIdForDescriptor(candidate.descriptor),
      label: candidate.descriptor.label,
      path: candidate.path,
      source: candidate.source,
      fallback: candidate.fallback,
      content,
    };
  }
  return {
    requestedStyleId,
    styleId: 'general',
    label: general.label,
    path: '',
    source: 'missing',
    fallback: requestedStyleId !== 'general',
    content: '',
  };
}

export function composePptStyleSkill(root, baseSkill = '', styleId = 'general') {
  const base = stripLegacyPptStyleProfiles(baseSkill).trimEnd();
  const resolved = resolvePptStyleSkill(root, styleId);
  const body = skillDocumentBody(resolved.content);
  if (!body) return base;
  return [
    base,
    '',
    PPT_STYLE_SKILL_START,
    `# Active PPT Style Skill: ${resolved.styleId}`,
    '',
    `Requested styleId: \`${resolved.requestedStyleId}\`. Effective styleId: \`${resolved.styleId}\`.`,
    ...(resolved.fallback ? ['The requested style Skill was unavailable or invalid, so the general style Skill is active.'] : []),
    '',
    body,
    PPT_STYLE_SKILL_END,
    '',
    '## Effective PPT Skill Precedence',
    '',
    '- The common PPT Skill remains authoritative for scope, renderer protocol, output schema, editability, factual integrity, privacy, dependency handling, and final delivery.',
    '- The active style Skill may specialize only narrative, layout preference, evidence emphasis, and visual tone.',
    '- User instructions and selected-template branding take precedence over stylistic preferences, but never over the common Skill hard rules.',
  ].join('\n');
}

function validSkillDocument(text, expectedName) {
  const value = String(text || '').trim();
  if (!value) return false;
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(value);
  if (!frontmatter) return false;
  const name = /^name:\s*([^\r\n]+)\s*$/m.exec(frontmatter[1])?.[1]?.trim();
  const description = /^description:\s*([^\r\n]+)\s*$/m.exec(frontmatter[1])?.[1]?.trim();
  return name === expectedName && Boolean(description) && Boolean(skillDocumentBody(value));
}

function skillDocumentBody(text) {
  return String(text || '').replace(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
}

function stripLegacyPptStyleProfiles(text) {
  return String(text || '').replace(
    /\r?\n## Style Profiles\s*\r?\n[\s\S]*?(?=\r?\n## Internal Research Role\s*\r?\n|\r?\n<!-- JANUS PERSONAL OVERLAY START -->|$)/,
    '\n',
  );
}

function styleIdForDescriptor(descriptor) {
  return Object.entries(PPT_STYLE_SKILLS).find(([, item]) => item === descriptor)?.[0] || 'general';
}

export async function installPptSkill(root, { onProgress = null, appVersion = '' } = {}) {
  const emitProgress = (percent, stage, message) => onProgress?.({
    percent: Math.max(0, Math.min(100, Number(percent) || 0)),
    stage,
    message,
  });
  emitProgress(5, 'checking', '正在检查技能包和运行环境…');
  const status = pptSkillStatus(root, { appVersion });
  if (!status.available) throw new Error(status.error || 'PPT 制作技能包缺失。');
  if (status.runtimeMode === 'missing') throw new Error(status.error || status.missing || 'PPT Python 运行环境不可用。');
  const source = pptSkillSource(root);
  const targetRoot = skillPackageInstallRoot(root, PPT_SKILL_PACKAGE_ID);
  emitProgress(18, 'copying', `正在安装${source.source === 'server' ? '服务器最新版' : '内置'} PPT 技能包…`);
  await fs.promises.rm(targetRoot, { recursive: true, force: true });
  await fs.promises.mkdir(path.dirname(targetRoot), { recursive: true });
  await fs.promises.cp(source.root, targetRoot, { recursive: true });
  emitProgress(52, 'copying', 'PPT 技能文件安装完成。');
  const dependencies = (status.dependencies || []).filter((dependency) => dependency.required && !dependency.installed);
  for (let index = 0; index < dependencies.length; index += 1) {
    const dependency = dependencies[index];
    if (dependency.required && !dependency.installed) {
      const percent = 55 + Math.round((index / Math.max(1, dependencies.length)) * 35);
      emitProgress(percent, 'dependencies', `正在安装运行依赖 ${dependency.packageName || dependency.id}…`);
      await installPythonPackage({ packageName: dependency.packageName || dependency.id, root });
    }
  }
  setSkillPackageInstalled(root, PPT_SKILL_PACKAGE_ID, true, {
    source: source.source,
    version: String(appVersion || '').trim() || source.version,
  });
  emitProgress(95, 'verifying', '正在验证技能安装结果…');
  const result = pptSkillStatus(root, { appVersion });
  if (!result.ready) {
    setSkillPackageInstalled(root, PPT_SKILL_PACKAGE_ID, false, {
      source: source.source,
      version: String(appVersion || '').trim() || source.version,
    });
    throw new Error(result.missing || result.error || 'PPT 制作技能安装后未通过运行环境验证。');
  }
  emitProgress(100, 'complete', '技能下载完成');
  return result;
}

export async function downloadPptSkill(root, options = {}) {
  const status = await installPptSkill(root, options);
  return {
    ...status,
    ok: true,
  };
}

export async function uninstallPptSkill(root, { appVersion = '' } = {}) {
  await fs.promises.rm(skillPackageInstallRoot(root, PPT_SKILL_PACKAGE_ID), { recursive: true, force: true });
  setSkillPackageInstalled(root, PPT_SKILL_PACKAGE_ID, false);
  return pptSkillStatus(root, { appVersion });
}
