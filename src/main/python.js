import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function configuredPython() {
  const value = String(process.env.JANUS_PYTHON || process.env.PYTHON || '').trim();
  return value || '';
}

export function packagedPythonExecutable(resourcesPath = process.resourcesPath || '') {
  const root = String(resourcesPath || '').trim();
  if (!root || process.platform !== 'win32') return '';
  const executable = path.join(root, 'python', 'python.exe');
  return fs.existsSync(executable) ? executable : '';
}

function pythonCandidates() {
  const packaged = packagedPythonExecutable();
  const configured = configuredPython();
  const preferred = [
    ...(packaged ? [{ command: packaged, prefixArgs: [], packaged: true }] : []),
    ...(configured && configured !== packaged ? [{ command: configured, prefixArgs: [], configured: true }] : []),
  ];
  if (process.platform === 'win32') {
    return [
      ...preferred,
      { command: 'python', prefixArgs: [] },
      { command: 'py', prefixArgs: ['-3'] },
      { command: 'python3', prefixArgs: [] },
    ];
  }
  return [
    ...preferred,
    { command: 'python3', prefixArgs: [] },
    { command: 'python', prefixArgs: [] },
  ];
}

export function canRunPython(candidate, root = '', requiredModules = []) {
  const modules = [...new Set((Array.isArray(requiredModules) ? requiredModules : [])
    .map((item) => String(item || '').trim()).filter(Boolean))];
  const probeArgs = modules.length
    ? ['-c', `import ${modules.join(', ')}`]
    : ['--version'];
  const result = spawnSync(candidate.command, [...candidate.prefixArgs, ...probeArgs], {
    env: pythonEnvironment({}, { root, packaged: candidate.packaged }),
    stdio: 'ignore',
    timeout: modules.length ? 15_000 : 5_000,
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

export function resolvePythonInvocation(args = [], {
  required = false,
  root = '',
  requiredModules = [],
  allowPackaged = true,
} = {}) {
  const candidates = pythonCandidates().filter((candidate) => allowPackaged || !candidate.packaged);
  const modules = [...new Set((Array.isArray(requiredModules) ? requiredModules : [])
    .map((item) => String(item || '').trim()).filter(Boolean))];
  const resolved = candidates.find((candidate) => canRunPython(candidate, root, modules));
  if (resolved) {
    return {
      command: resolved.command,
      args: [...resolved.prefixArgs, ...args],
      packaged: Boolean(resolved.packaged),
    };
  }
  if (required) {
    const requirement = modules.length ? ` with required modules: ${modules.join(', ')}` : '';
    throw new Error(
      `Python runtime not found${requirement}. Install Python 3, or repair the PPT creation skill.`,
    );
  }
  const fallback = candidates[0] || { command: 'python', prefixArgs: [] };
  return {
    command: fallback.command,
    args: [...fallback.prefixArgs, ...args],
    packaged: Boolean(fallback.packaged),
  };
}

export function pythonPackageStatus({ packageName, moduleName = packageName, root = '' } = {}) {
  const outputRoot = root ? path.join(path.resolve(root), '.janus', 'tmp', 'python-probes') : os.tmpdir();
  fs.mkdirSync(outputRoot, { recursive: true });
  const outputPath = path.join(outputRoot, `python-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const script = `
import importlib
import importlib.metadata
import json
import pathlib
import sys

package_name = ${JSON.stringify(packageName || '')}
module_name = ${JSON.stringify(moduleName || packageName || '')}
payload = {
    "packageName": package_name,
    "moduleName": module_name,
    "python": sys.executable,
    "pythonVersion": sys.version.split()[0],
    "installed": False,
    "version": "",
    "error": "",
}
try:
    importlib.import_module(module_name)
    payload["installed"] = True
    try:
        payload["version"] = importlib.metadata.version(package_name)
    except Exception:
        payload["version"] = "installed"
except Exception as exc:
    payload["error"] = str(exc)
pathlib.Path(sys.argv[1]).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
`;
  let invocation;
  try {
    invocation = resolvePythonInvocation(['-c', script, outputPath], {
      required: true,
      root,
      requiredModules: [moduleName],
    });
  } catch (error) {
    return {
      packageName,
      moduleName,
      installed: false,
      version: '',
      python: '',
      pythonVersion: '',
      error: error.message || String(error),
    };
  }
  const result = spawnSync(invocation.command, invocation.args, {
    env: pythonEnvironment({}, { root, packaged: invocation.packaged }),
    stdio: 'ignore',
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    try { fs.rmSync(outputPath, { force: true }); } catch {}
    return {
      packageName,
      moduleName,
      installed: false,
      version: '',
      python: invocation.command,
      pythonVersion: '',
      error: result.error?.message || `Python exited with code ${result.status}`,
    };
  }
  try {
    return JSON.parse(fs.readFileSync(outputPath, 'utf8') || '{}');
  } catch (error) {
    return {
      packageName,
      moduleName,
      installed: false,
      version: '',
      python: invocation.command,
      pythonVersion: '',
      error: error.message || String(error),
    };
  } finally {
    try { fs.rmSync(outputPath, { force: true }); } catch {}
  }
}

export function managedPythonSitePackages(root = '') {
  const explicit = String(process.env.JANUS_PYTHON_SITE_PACKAGES || '').trim();
  if (explicit) return path.resolve(explicit);
  const runtimeRoot = String(root || '').trim();
  return runtimeRoot ? path.join(path.resolve(runtimeRoot), '.janus', 'python-site-packages') : '';
}

export function pythonEnvironment(extra = {}, { root = '', packaged = false } = {}) {
  const managedSite = packaged ? '' : managedPythonSitePackages(root);
  const pythonPath = [managedSite, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  const {
    PYTHONHOME: _ignoredPythonHome,
    PYTHONPATH: _ignoredPythonPath,
    PYTHONUSERBASE: _ignoredPythonUserBase,
    PYTHONEXECUTABLE: _ignoredPythonExecutable,
    PYTHONNOUSERSITE: _ignoredUserSiteOverride,
    ...baseEnvironment
  } = process.env;
  return {
    ...baseEnvironment,
    PYTHONUTF8: '1',
    ...(packaged ? { PYTHONNOUSERSITE: '1' } : {}),
    ...(!packaged && pythonPath ? { PYTHONPATH: pythonPath } : {}),
    ...extra,
  };
}

export function pptDependencyStatus(root = '') {
  const pptx = pythonPackageStatus({ packageName: 'python-pptx', moduleName: 'pptx', root });
  const pillow = pythonPackageStatus({ packageName: 'Pillow', moduleName: 'PIL', root });
  const pymupdf = pythonPackageStatus({ packageName: 'PyMuPDF', moduleName: 'fitz', root });
  const libreOffice = commandStatus(['soffice', 'libreoffice']);
  const powerpointCom = process.platform === 'win32'
    ? windowsPowerPointComStatus(root)
    : {
        installed: false,
        available: false,
        command: '',
        error: 'PowerPoint COM preview is only available on Windows.',
      };
  const required = [pptx, pillow, pymupdf];
  let rendererInvocation = null;
  let rendererRuntimeError = '';
  let externalRepairInvocation = null;
  try {
    rendererInvocation = resolvePythonInvocation([], {
      required: true,
      root,
      requiredModules: ['pptx', 'PIL', 'fitz', 'lxml'],
    });
  } catch (error) {
    rendererRuntimeError = error.message || String(error);
  }
  try {
    externalRepairInvocation = resolvePythonInvocation([], {
      required: true,
      root,
      allowPackaged: false,
    });
  } catch {
    externalRepairInvocation = null;
  }
  const installed = required.every((item) => item.installed) && Boolean(rendererInvocation);
  const missing = required
    .filter((item) => !item.installed)
    .map((item) => item.packageName || item.moduleName)
    .join(', ');
  const packagedExecutable = packagedPythonExecutable();
  const rendererPython = rendererInvocation?.command || externalRepairInvocation?.command || pptx.python || '';
  const packagedRuntime = Boolean(packagedExecutable && rendererPython
    && path.resolve(rendererPython) === path.resolve(packagedExecutable));
  const runtimeMode = packagedRuntime ? 'bundled' : rendererPython ? 'system' : 'missing';
  const runtimeError = installed ? '' : pptRuntimeError({
    missing,
    probeError: rendererRuntimeError || pptx.error,
    runtimeMode,
  });
  return {
    ...pptx,
    python: rendererPython,
    installed,
    version: pptx.version,
    error: runtimeError,
    platform: process.platform,
    architecture: process.arch,
    runtimeMode,
    packagedRuntime,
    repairableWithExternalPython: Boolean(externalRepairInvocation),
    dependencies: [
      { id: 'python-pptx', required: true, ...pptx },
      { id: 'pillow', required: true, ...pillow },
      { id: 'pymupdf', required: true, ...pymupdf },
    ],
    previewExporters: {
      libreOffice,
      powerpointCom,
    },
  };
}

function pptRuntimeError({ missing = '', probeError = '', runtimeMode = 'missing' } = {}) {
  if (runtimeMode === 'missing') {
    if (process.platform === 'win32') return 'Windows 内置 PPT Python 运行时缺失或损坏，请重新安装或更新 Janus。';
    if (process.platform === 'darwin') return 'macOS 未检测到可用的 Python 3；请先安装 Python 3，再重新安装 PPT 制作技能。';
    return 'Linux 未检测到可用的 Python 3；请先安装 Python 3 和 pip，再重新安装 PPT 制作技能。';
  }
  const detail = missing || String(probeError || '').trim() || 'unknown';
  return `PPT 制作技能缺少必要 Python 组件：${detail}`;
}

function commandStatus(commands = []) {
  for (const command of commands) {
    const result = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      return {
        installed: true,
        available: true,
        command,
        version: (result.stdout || result.stderr || '').split(/\r?\n/)[0] || 'available',
        error: '',
      };
    }
  }
  return {
    installed: false,
    available: false,
    command: commands[0] || '',
    version: '',
    error: `${commands.join(' or ')} not found.`,
  };
}

function windowsPowerPointComStatus(root = '') {
  const win32com = pythonPackageStatus({ packageName: 'pywin32', moduleName: 'win32com.client', root });
  const pythoncom = pythonPackageStatus({ packageName: 'pywin32', moduleName: 'pythoncom', root });
  const installed = win32com.installed && pythoncom.installed;
  return {
    installed,
    available: installed,
    command: 'PowerPoint COM',
    version: win32com.version || pythoncom.version || '',
    error: installed ? '' : [win32com.error, pythoncom.error].filter(Boolean).join('; '),
  };
}

export function installPythonPackage({ packageName, root = '', timeoutMs = 300_000 } = {}) {
  if (!packageName) throw new Error('Python package name is required.');
  const installRoot = managedPythonSitePackages(root);
  if (!installRoot) throw new Error('Janus runtime root is required to install Python packages.');
  fs.mkdirSync(installRoot, { recursive: true });
  const installArgs = ['-m', 'pip', 'install', '--target', installRoot, packageName];
  const probe = resolvePythonInvocation(['-m', 'pip', 'install', '--help'], {
    required: true,
    root,
    allowPackaged: false,
  });
  const help = spawnSync(probe.command, probe.args, {
    encoding: 'utf8',
    env: pythonEnvironment({}, { root, packaged: probe.packaged }),
    timeout: 10_000,
    windowsHide: true,
  });
  if (`${help.stdout || ''}${help.stderr || ''}`.includes('--break-system-packages')) {
    installArgs.splice(3, 0, '--break-system-packages');
  }
  const invocation = resolvePythonInvocation(installArgs, { required: true, root, allowPackaged: false });
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: pythonEnvironment({}, { root, packaged: invocation.packaged }),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(`pip install timed out after ${Math.round(timeoutMs / 1000)}s.`));
        }, timeoutMs)
      : null;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout || `pip exited with code ${code}`).slice(-4000)));
        return;
      }
      resolve({
        ok: true,
        packageName,
        command: invocation.command,
        output: (stdout || stderr || '').slice(-4000),
      });
    });
  });
}

export function uninstallPythonPackage({ packageName, root = '', timeoutMs = 300_000 } = {}) {
  if (!packageName) throw new Error('Python package name is required.');
  const invocation = resolvePythonInvocation(['-m', 'pip', 'uninstall', '-y', packageName], { required: true, root });
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: pythonEnvironment({}, { root, packaged: invocation.packaged }),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(`pip uninstall timed out after ${Math.round(timeoutMs / 1000)}s.`));
        }, timeoutMs)
      : null;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout || `pip uninstall exited with code ${code}`).slice(-4000)));
        return;
      }
      resolve({
        ok: true,
        packageName,
        command: invocation.command,
        output: (stdout || stderr || '').slice(-4000),
      });
    });
  });
}
