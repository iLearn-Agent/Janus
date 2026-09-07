import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.cache']);
const MAX_FILES = 10_000;
const MAX_SKILL_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;

export async function importAttachedSkillPackage({ root = '', ownerUserId = '', source = '', sourceRevision = '', allowInboxSource = false } = {}) {
  const cleanRoot = path.resolve(String(root || ''));
  const cleanOwner = String(ownerUserId || '').trim();
  const cleanSource = String(source || '').trim();
  if (!cleanRoot || !cleanOwner || !cleanSource) throw attachedSkillError('attached_skill_import_input_required', '缺少 Skill 导入来源或用户。');
  const stagingParent = path.join(cleanRoot, 'tmp', 'attached-skill-imports');
  const installParent = path.join(cleanRoot, 'attached-skills');
  await fs.promises.mkdir(stagingParent, { recursive: true });
  await fs.promises.mkdir(installParent, { recursive: true });
  const stagingRoot = await fs.promises.mkdtemp(path.join(stagingParent, 'import-'));
  let sourceRoot = stagingRoot;
  let sourceType = 'local';
  const githubSource = parseGithubSource(cleanSource);
  let revision = String(sourceRevision || githubSource?.revision || '').trim();
  try {
    if (githubSource) {
      sourceType = 'github';
      sourceRoot = path.join(stagingRoot, 'repository');
      if (githubSource.subdir) await downloadGithubArchive(githubSource.url, sourceRoot, revision || 'main');
      else await cloneGithubSource(githubSource.url, sourceRoot, revision);
      revision = revision || await gitRevision(sourceRoot).catch(() => 'main');
      if (githubSource.subdir) {
        sourceRoot = path.join(sourceRoot, githubSource.subdir);
        const subdirStat = await fs.promises.stat(sourceRoot).catch(() => null);
        if (!subdirStat?.isDirectory()) {
          throw attachedSkillError('attached_skill_source_missing', `GitHub Skill 子目录不存在：${githubSource.subdir}`);
        }
      }
    } else {
      sourceRoot = path.resolve(cleanSource);
      const stat = await fs.promises.lstat(sourceRoot).catch(() => null);
      if (stat?.isSymbolicLink()) throw attachedSkillError('attached_skill_symlink_forbidden', 'Skill 来源目录不能是符号链接。');
      if (!stat?.isDirectory()) throw attachedSkillError('attached_skill_source_missing', 'Skill 来源目录不存在。');
      const inboxRoot = path.join(cleanRoot, '.skill');
      const sourceIsInbox = allowInboxSource && (sourceRoot === inboxRoot || containsPath(inboxRoot, sourceRoot));
      if (!sourceIsInbox && (containsPath(sourceRoot, cleanRoot) || containsPath(cleanRoot, sourceRoot))) {
        throw attachedSkillError('attached_skill_managed_path_forbidden', 'Skill 来源不能与 Janus 管理目录重叠。');
      }
    }
    const discovered = await discoverAttachedSkills(sourceRoot);
    if (!discovered.length) throw attachedSkillError('attached_skill_not_found', '来源中没有找到有效的 SKILL.md。');
    const packageHash = await hashPackageTree(sourceRoot);
    const packageId = stableId('skillpkg', `${cleanOwner}\n${sourceType}\n${normalizeSource(cleanSource)}`);
    const packageInstallRoot = path.join(installParent, packageId);
    const installRoot = path.join(packageInstallRoot, packageHash);
    const nextRoot = `${installRoot}.next-${process.pid}-${Date.now()}`;
    await copyPackageTree(sourceRoot, nextRoot);
    const copiedHash = await hashPackageTree(nextRoot);
    if (copiedHash !== packageHash) {
      await fs.promises.rm(nextRoot, { recursive: true, force: true });
      throw attachedSkillError('attached_skill_source_changed', '导入期间 Skill 来源发生变化，请重试。');
    }
    const installedStat = await fs.promises.stat(installRoot).catch(() => null);
    const installedHash = installedStat?.isDirectory() ? await hashPackageTree(installRoot).catch(() => '') : '';
    const alreadyInstalled = installedHash === packageHash;
    if (alreadyInstalled) {
      await fs.promises.rm(nextRoot, { recursive: true, force: true });
    } else {
      await fs.promises.mkdir(packageInstallRoot, { recursive: true });
      await fs.promises.rm(installRoot, { recursive: true, force: true });
      await fs.promises.rename(nextRoot, installRoot);
    }
    return {
      package: {
        id: packageId,
        ownerUserId: cleanOwner,
        sourceType,
        sourceUri: cleanSource,
        sourceRevision: revision,
        installRoot,
        status: 'installed',
        contentHash: packageHash,
        metadata: { skillCount: discovered.length, importedAt: new Date().toISOString() },
      },
      skills: discovered.map((skill) => ({
        ...skill,
        id: stableId('skill', `${packageId}\n${skill.skillKey}`),
        packageId,
        absolutePath: path.join(installRoot, skill.relativePath),
      })),
      alreadyInstalled,
    };
  } finally {
    await fs.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function discoverAttachedSkills(sourceRoot = '') {
  const root = path.resolve(String(sourceRoot || ''));
  const files = [];
  await walk(root, root, files);
  const skills = [];
  for (const file of files.filter((entry) => path.basename(entry) === 'SKILL.md').sort()) {
    const stat = await fs.promises.stat(file);
    if (stat.size > MAX_SKILL_BYTES) throw attachedSkillError('attached_skill_too_large', `Skill 文件过大：${path.relative(root, file)}`);
    const text = await fs.promises.readFile(file, 'utf8');
    const parsed = parseSkillDocument(text, path.relative(root, file));
    const skillRoot = path.dirname(file);
    const relativePath = safeRelative(root, file);
    skills.push({
      skillKey: parsed.name,
      name: parsed.name,
      description: parsed.description,
      relativePath,
      contentHash: sha256(text),
      status: 'ready',
      metadata: {
        skillRoot: safeRelative(root, skillRoot) || '.',
        folders: (await Promise.all(['scripts', 'references', 'assets'].map(async (folder) => (
          await isDirectory(path.join(skillRoot, folder)) ? folder : ''
        )))).filter(Boolean),
        ...(parsed.displayNameEn ? { displayNameEn: parsed.displayNameEn } : {}),
        ...(parsed.displayNameZhCn ? { displayNameZhCn: parsed.displayNameZhCn } : {}),
        ...(parsed.descriptionEn ? { descriptionEn: parsed.descriptionEn } : {}),
        ...(parsed.descriptionZhCn ? { descriptionZhCn: parsed.descriptionZhCn } : {}),
      },
    });
  }
  const duplicate = skills.find((skill, index) => skills.findIndex((item) => item.skillKey === skill.skillKey) !== index);
  if (duplicate) throw attachedSkillError('attached_skill_duplicate_name', `同一包内存在重复 Skill 名称：${duplicate.name}`);
  return skills;
}

export function parseSkillDocument(text = '', relativePath = 'SKILL.md') {
  const value = String(text || '').replace(/^\uFEFF/, '');
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(value);
  if (!match) throw attachedSkillError('attached_skill_frontmatter_required', `${relativePath} 缺少 YAML frontmatter。`);
  const name = frontmatterScalar(match[1], 'name');
  const description = frontmatterScalar(match[1], 'description');
  const displayNameEn = frontmatterScalar(match[1], 'display_name_en', 'displayNameEn');
  const displayNameZhCn = frontmatterScalar(match[1], 'display_name_zh_cn', 'displayNameZhCn', 'display_name_zh');
  const descriptionEn = frontmatterScalar(match[1], 'description_en', 'descriptionEn');
  const descriptionZhCn = frontmatterScalar(match[1], 'description_zh_cn', 'descriptionZhCn', 'description_zh');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw attachedSkillError('attached_skill_name_invalid', `${relativePath} 的 name 必须是小写字母、数字和连字符。`);
  }
  if (!description) throw attachedSkillError('attached_skill_description_required', `${relativePath} 缺少 description。`);
  if (!value.slice(match[0].length).trim()) throw attachedSkillError('attached_skill_body_required', `${relativePath} 没有 Skill 正文。`);
  return { name, description, displayNameEn, displayNameZhCn, descriptionEn, descriptionZhCn };
}

function frontmatterScalar(frontmatter = '', ...keys) {
  for (const key of keys) {
    const escaped = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const raw = new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, 'm').exec(frontmatter)?.[1]?.trim() || '';
    if (raw) return raw.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  }
  return '';
}

async function walk(root, directory, files) {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= MAX_FILES) throw attachedSkillError('attached_skill_package_too_large', 'Skill 包文件数量超过限制。');
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    const stat = await fs.promises.lstat(target);
    if (stat.isSymbolicLink()) throw attachedSkillError('attached_skill_symlink_forbidden', `Skill 包不允许符号链接：${safeRelative(root, target)}`);
    if (stat.isDirectory()) await walk(root, target, files);
    else if (stat.isFile()) files.push(target);
  }
}

async function packageFiles(root) {
  const files = [];
  await walk(root, root, files);
  let totalBytes = 0;
  const manifest = [];
  for (const file of files.sort()) {
    const stat = await fs.promises.stat(file);
    totalBytes += stat.size;
    if (totalBytes > MAX_PACKAGE_BYTES) {
      throw attachedSkillError('attached_skill_package_too_large', 'Skill 包总大小超过 100 MB 限制。');
    }
    manifest.push({ relativePath: safeRelative(root, file), contentHash: await hashFile(file) });
  }
  return manifest;
}

async function copyPackageTree(sourceRoot, targetRoot) {
  await fs.promises.rm(targetRoot, { recursive: true, force: true });
  await fs.promises.mkdir(targetRoot, { recursive: true });
  const copy = async (source, target) => {
    const entries = await fs.promises.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const from = path.join(source, entry.name);
      const to = path.join(target, entry.name);
      const stat = await fs.promises.lstat(from);
      if (stat.isSymbolicLink()) throw attachedSkillError('attached_skill_symlink_forbidden', `Skill 包不允许符号链接：${entry.name}`);
      if (stat.isDirectory()) { await fs.promises.mkdir(to, { recursive: true }); await copy(from, to); }
      else if (stat.isFile()) await fs.promises.copyFile(from, to);
    }
  };
  await copy(sourceRoot, targetRoot);
}

async function cloneGithubSource(source, target, revision = '') {
  const url = String(source || '').trim();
  if (!url) throw attachedSkillError('attached_skill_clone_failed', 'GitHub Skill 仓库地址为空。');
  const args = ['clone', '--filter=blob:none', '--depth', '1'];
  if (revision) args.push('--branch', revision);
  args.push('--', url, target);
  try {
    await execFileAsync('git', args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    // Some GitHub proxies reject partial-clone filters. Retry with a normal
    // shallow clone before surfacing the download error to the user.
    await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {});
    const fallbackArgs = ['clone', '--depth', '1'];
    if (revision) fallbackArgs.push('--branch', revision);
    fallbackArgs.push('--', url, target);
    try {
      await execFileAsync('git', fallbackArgs, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    } catch (fallbackError) {
      // Last fallback for environments where git transport is blocked: use
      // GitHub's codeload archive endpoint, which works through standard HTTPS.
      try {
        await downloadGithubArchive(url, target, revision || 'main');
      } catch (archiveError) {
        throw attachedSkillError('attached_skill_clone_failed', `无法下载 Skill 仓库：${String(archiveError.stderr || archiveError.message || fallbackError.stderr || error).trim()}`);
      }
    }
  }
}

async function downloadGithubArchive(source, target, revision = 'main') {
  const archiveRoot = `${target}.archive`;
  const archiveFile = `${archiveRoot}.zip`;
  const repoUrl = String(source || '').replace(/\.git$/i, '');
  const ref = encodeURIComponent(revision || 'main');
  const archiveUrl = repoUrl.replace('https://github.com/', 'https://codeload.github.com/') + `/zip/refs/heads/${ref}`;
  try {
    await execFileAsync('curl', ['-L', '--fail', '--silent', '--show-error', '--max-time', '120', archiveUrl, '-o', archiveFile], { timeout: 130_000, maxBuffer: 4 * 1024 * 1024 });
    await fs.promises.mkdir(archiveRoot, { recursive: true });
    await execFileAsync('unzip', ['-q', archiveFile, '-d', archiveRoot], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    const entries = await fs.promises.readdir(archiveRoot, { withFileTypes: true });
    const extracted = entries.find((entry) => entry.isDirectory());
    if (!extracted) throw new Error('archive root missing');
    await fs.promises.rm(target, { recursive: true, force: true });
    await fs.promises.rename(path.join(archiveRoot, extracted.name), target);
  } finally {
    await fs.promises.rm(archiveFile, { force: true }).catch(() => {});
    await fs.promises.rm(archiveRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function gitRevision(directory) {
  const result = await execFileAsync('git', ['-C', directory, 'rev-parse', 'HEAD'], { timeout: 10_000 });
  return String(result.stdout || '').trim();
}

function isGithubSource(source) {
  return Boolean(parseGithubSource(source));
}

export function parseGithubSource(source) {
  const value = String(source || '').trim();
  const shorthand = /^([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:@([^\s]+))?$/.exec(value);
  if (shorthand) return { url: `https://github.com/${shorthand[1]}.git`, revision: shorthand[2] || '' };
  const treeUrl = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.*))?\/?$/i.exec(value);
  if (treeUrl) {
    return {
      url: `https://github.com/${treeUrl[1]}/${treeUrl[2].replace(/\.git$/i, '')}.git`,
      revision: decodeURIComponent(treeUrl[3]),
      subdir: treeUrl[4] ? treeUrl[4].split('/').filter(Boolean).map((part) => decodeURIComponent(part)).join(path.sep) : '',
    };
  }
  const httpsRepo = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(value);
  if (httpsRepo) return { url: `https://github.com/${httpsRepo[1]}/${httpsRepo[2]}.git`, revision: '' };
  const sshRepo = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(value);
  if (sshRepo) return { url: `git@github.com:${sshRepo[1]}/${sshRepo[2]}.git`, revision: '' };
  return null;
}

function normalizeSource(source) {
  const github = parseGithubSource(source);
  return github ? github.url.replace(/\.git$/i, '').toLowerCase() : path.resolve(source);
}

function safeRelative(root, target) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw attachedSkillError('attached_skill_path_escape', 'Skill 文件路径越过了包边界。');
  }
  return relative.split(path.sep).join('/');
}

function containsPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function hashPackageTree(root) {
  const manifest = await packageFiles(root);
  return sha256(manifest.map((file) => `${file.relativePath}\n${file.contentHash}`).join('\n'));
}

function stableId(prefix, value) {
  return `${prefix}_${sha256(value).slice(0, 40)}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const input = fs.createReadStream(file);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest('hex');
}

async function isDirectory(target) {
  return Boolean((await fs.promises.stat(target).catch(() => null))?.isDirectory());
}

function attachedSkillError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
