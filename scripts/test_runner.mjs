#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { appendDiagnosticEvent } from '../src/shared/diagnostics.js';
import { redactDiagnosticText, redactDiagnosticValue } from './lib/testDiagnostics.mjs';
import { pruneTestRuns } from './lib/testRunStorage.mjs';
import { TEST_CASES, testCasesForSuite } from './testManifest.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runsRoot = path.join(repoRoot, 'test-artifacts', 'runs');
const options = parseArgs(process.argv.slice(2));

if (options.list) {
  for (const test of TEST_CASES) process.stdout.write(`${test.id}\t${test.group}\t${test.suites.join(',')}\n`);
  process.exit(0);
}

await pruneTestRuns(runsRoot);
const selected = selectCases(options);
if (!selected.length) throw new Error('No test cases matched the requested selection. Use --list to inspect available cases.');

const git = gitMetadata();
const runId = options.runId || createRunId(git.commit);
const runDir = path.join(runsRoot, runId);
const casesDir = path.join(runDir, 'cases');
const rootEventsPath = path.join(runDir, 'events.jsonl');
await fsp.mkdir(casesDir, { recursive: true });

const startedAt = new Date().toISOString();
const runMetadata = {
  schemaVersion: 1,
  runId,
  status: 'running',
  suite: options.suite,
  selection: { caseId: options.caseId, group: options.group, rerunFailed: options.rerunFailed },
  startedAt,
  git,
  runtime: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    electron: packageVersion('electron'),
    cpuCount: os.availableParallelism?.() || os.cpus().length,
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    ci: Boolean(process.env.CI),
    githubRunId: String(process.env.GITHUB_RUN_ID || ''),
  },
  caseIds: selected.map((test) => test.id),
};
await writeJson(path.join(runDir, 'run.json'), runMetadata);
await writeJson(path.join(runsRoot, 'latest.json'), { runId, startedAt });

appendDiagnosticEvent(rootEventsPath, { source: 'runner', runId, event: 'run_start', message: `Starting ${selected.length} tests`, data: runMetadata });
process.stdout.write(`\n[test-runner] run=${runId} suite=${options.suite} cases=${selected.length}\n`);
process.stdout.write(`[test-runner] diagnostics=${path.relative(repoRoot, runDir)}\n\n`);

let currentChild = null;
let interruptedSignal = '';
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => {
    interruptedSignal = signal;
    process.stderr.write(`\n[test-runner] received ${signal}; stopping current test\n`);
    stopProcessTree(currentChild, 'SIGTERM');
  });
}

const results = [];
for (let index = 0; index < selected.length; index += 1) {
  const test = selected[index];
  const resource = resourceSnapshot();
  if (resource.availableMemoryMb < options.minAvailableMb) {
    const result = infrastructureResult(test, `available memory ${Math.round(resource.availableMemoryMb)} MB is below ${options.minAvailableMb} MB`);
    results.push(result);
    appendDiagnosticEvent(rootEventsPath, { source: 'runner', runId, caseId: test.id, level: 'error', event: 'infrastructure_error', message: result.failureMessage, data: resource });
    break;
  }
  if (interruptedSignal) {
    results.push(infrastructureResult(test, `test run interrupted by ${interruptedSignal}`));
    break;
  }

  process.stdout.write(`[test-runner] (${index + 1}/${selected.length}) START ${test.id}\n`);
  const result = await runCase(test, { runId, runDir, rootEventsPath, resource, setChild: (child) => { currentChild = child; } });
  currentChild = null;
  results.push(result);
  process.stdout.write(`[test-runner] (${index + 1}/${selected.length}) ${result.status.toUpperCase()} ${test.id} (${formatDuration(result.durationMs)})\n\n`);
  if (result.status !== 'passed' && (options.failFast || result.status === 'infrastructure_error')) break;
}

const endedAt = new Date().toISOString();
const status = results.some((item) => item.status === 'infrastructure_error')
  ? 'infrastructure_error'
  : results.some((item) => item.status !== 'passed')
    ? 'failed'
    : 'passed';
const summary = buildSummary({ runId, startedAt, endedAt, status, selected, results, git, runDir });
await writeJson(path.join(runDir, 'summary.json'), summary);
await fsp.writeFile(path.join(runDir, 'summary.md'), renderSummaryMarkdown(summary), 'utf8');
await fsp.writeFile(path.join(runDir, 'junit.xml'), renderJunit(summary), 'utf8');
if (status !== 'passed') await collectServerJournal(runDir, startedAt, endedAt);
await writeJson(path.join(runDir, 'run.json'), { ...runMetadata, status, endedAt, durationMs: summary.durationMs, counts: summary.counts });
appendDiagnosticEvent(rootEventsPath, { source: 'runner', runId, event: 'run_end', level: status === 'passed' ? 'info' : 'error', message: `Run ${status}`, durationMs: summary.durationMs, data: summary.counts });

if (status !== 'passed') {
  await writeJson(path.join(runsRoot, 'latest-failed.json'), {
    runId,
    endedAt,
    failedCaseIds: results.filter((item) => item.status !== 'passed').map((item) => item.caseId),
  });
} else if (options.rerunFailed || (!options.caseId && !options.group)) {
  await fsp.rm(path.join(runsRoot, 'latest-failed.json'), { force: true });
}

if (process.env.GITHUB_STEP_SUMMARY) {
  await fsp.appendFile(process.env.GITHUB_STEP_SUMMARY, `${renderSummaryMarkdown(summary)}\n`, 'utf8').catch(() => {});
}
await pruneTestRuns(runsRoot);

process.stdout.write(`${renderConsoleSummary(summary)}\n`);
process.exitCode = status === 'passed' ? 0 : status === 'infrastructure_error' ? 75 : 1;

async function runCase(test, context) {
  const caseDir = path.join(casesDir, sanitizeId(test.id));
  await fsp.mkdir(path.join(caseDir, 'artifacts'), { recursive: true });
  const caseTempDir = path.join(caseDir, 'artifacts', 'tmp');
  await fsp.mkdir(caseTempDir, { recursive: true });
  const output = new CaseOutput(caseDir, test.id, context.runId);
  const caseStartedAt = new Date().toISOString();
  const started = Date.now();
  appendDiagnosticEvent(context.rootEventsPath, {
    source: 'runner', runId: context.runId, caseId: test.id, event: 'case_start', message: test.title,
    data: { command: relativeCommand(test.command), args: test.args, timeoutSeconds: test.timeoutSeconds, resource: context.resource },
  });

  const env = {
    ...process.env,
    JANUS_TEST_RUN_ID: context.runId,
    JANUS_TEST_CASE_ID: test.id,
    JANUS_TEST_ARTIFACT_DIR: caseDir,
    JANUS_TEST_DIAGNOSTICS: '1',
    TMPDIR: caseTempDir,
    TEMP: caseTempDir,
    TMP: caseTempDir,
    ...resolvedCaseEnv(test.env, caseDir),
  };
  let child;
  let childPid = null;
  let timedOut = false;
  let spawnError = null;
  let exitCode = null;
  let signal = null;

  const completion = new Promise((resolve) => {
    let completed = false;
    const finish = (details) => {
      if (completed) return;
      completed = true;
      resolve(details);
    };
    try {
      child = spawn(test.command, test.args, {
        cwd: repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      context.setChild(child);
      childPid = child.pid || null;
      child.stdout.on('data', (chunk) => output.write('stdout', chunk));
      child.stderr.on('data', (chunk) => output.write('stderr', chunk));
      child.once('error', (error) => {
        spawnError = error;
        finish({ code: null, signal: null });
      });
      child.once('close', (code, closeSignal) => finish({ code, signal: closeSignal }));
    } catch (error) {
      spawnError = error;
      finish({ code: null, signal: null });
    }
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    output.write('stderr', `Test timed out after ${test.timeoutSeconds} seconds.\n`);
    stopProcessTree(child, 'SIGTERM');
    const forceTimer = setTimeout(() => stopProcessTree(child, 'SIGKILL'), 5_000);
    forceTimer.unref?.();
  }, test.timeoutSeconds * 1000);
  timeout.unref?.();

  const completionResult = await completion;
  clearTimeout(timeout);
  exitCode = completionResult.code;
  signal = completionResult.signal;
  output.flush();

  const durationMs = Date.now() - started;
  const status = spawnError ? 'infrastructure_error' : timedOut ? 'timeout' : exitCode === 0 ? 'passed' : 'failed';
  const failureMessage = spawnError
    ? `Unable to start test: ${spawnError.message}`
    : timedOut
      ? `Timed out after ${test.timeoutSeconds} seconds`
      : status === 'failed'
        ? `Exited with ${signal ? `signal ${signal}` : `code ${exitCode}`}`
        : '';
  const retainedSuccessArtifacts = status === 'passed'
    ? await existingDeclaredArtifacts(caseDir, test.successArtifacts)
    : [];
  const primaryReport = status === 'passed'
    ? retainedSuccessArtifacts.find((item) => item === safeRelativeArtifact(test.primaryReport)) || ''
    : '';
  const result = redactDiagnosticValue({
    schemaVersion: 1,
    runId: context.runId,
    caseId: test.id,
    title: test.title,
    group: test.group,
    status,
    startedAt: caseStartedAt,
    endedAt: new Date().toISOString(),
    durationMs,
    exitCode,
    signal,
    processId: childPid,
    timedOut,
    failureMessage,
    rootCause: status === 'passed' ? '' : rootCauseFromTail(output.tail()),
    outputTail: status === 'passed' ? [] : output.tail(),
    reproduction: `npm run test:diagnostic -- --case ${test.id}`,
    artifacts: status === 'passed' ? retainedSuccessArtifacts : await listRelativeFiles(caseDir),
    primaryReport,
  });
  await writeJson(path.join(caseDir, 'result.json'), result);
  if (status !== 'passed') await fsp.writeFile(path.join(caseDir, 'failure.md'), renderFailureMarkdown(result), 'utf8');

  appendDiagnosticEvent(context.rootEventsPath, {
    source: 'runner', runId: context.runId, caseId: test.id,
    event: 'case_end', level: status === 'passed' ? 'info' : 'error', message: status,
    durationMs, data: { processId: childPid, exitCode, signal, timedOut, failureMessage, rootCause: result.rootCause },
    error: spawnError || undefined,
  });
  output.close();
  if (status === 'passed' && !options.keepSuccessArtifacts) {
    if (retainedSuccessArtifacts.length) {
      await retainCaseArtifacts(caseDir, ['result.json', ...retainedSuccessArtifacts]);
    } else {
      await fsp.rm(caseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  return result;
}

function CaseOutput(caseDir, caseId, runId) {
  this.caseId = caseId;
  this.runId = runId;
  this.buffers = { stdout: '', stderr: '' };
  this.tailLines = [];
  this.diskBytes = 0;
  this.diskLimit = 200 * 1024 * 1024;
  this.truncated = false;
  this.files = {
    stdout: new RotatingFile(path.join(caseDir, 'stdout.log')),
    stderr: new RotatingFile(path.join(caseDir, 'stderr.log')),
    combined: new RotatingFile(path.join(caseDir, 'combined.log')),
    events: new RotatingFile(path.join(caseDir, 'events.jsonl')),
  };
  this.write = (channel, chunk) => {
    this.buffers[channel] += String(chunk || '');
    const lines = this.buffers[channel].split(/\r?\n/);
    this.buffers[channel] = lines.pop() || '';
    for (const line of lines) this.writeLine(channel, line);
  };
  this.writeLine = (channel, value) => {
    const line = redactDiagnosticText(value, { maxLength: 16_384 });
    const timestamp = new Date().toISOString();
    const channelLine = `${timestamp} ${line}\n`;
    const combinedLine = `${timestamp} [${channel}] ${line}\n`;
    this.persist(this.files.combined, combinedLine);
    this.persist(this.files[channel], channelLine);
    this.persist(this.files.events, `${JSON.stringify({
      schemaVersion: 1,
      timestamp,
      level: channel === 'stderr' ? 'warn' : 'info',
      source: 'test-process',
      runId: this.runId,
      caseId: this.caseId,
      stepId: '',
      event: 'process_output',
      message: line,
      data: { channel },
    })}\n`);
    const terminal = channel === 'stderr' ? process.stderr : process.stdout;
    terminal.write(`[${this.caseId}][${channel}] ${line}\n`);
    this.tailLines.push(`[${channel}] ${line}`);
    if (this.tailLines.length > 200) this.tailLines.shift();
  };
  this.persist = (file, value) => {
    if (this.diskBytes >= this.diskLimit) {
      if (!this.truncated) {
        this.truncated = true;
        process.stderr.write(`[${this.caseId}] diagnostic logs reached 200 MB and were truncated\n`);
      }
      return;
    }
    file.write(value);
    this.diskBytes += Buffer.byteLength(value);
  };
  this.flush = () => {
    for (const channel of ['stdout', 'stderr']) {
      if (this.buffers[channel]) this.writeLine(channel, this.buffers[channel]);
      this.buffers[channel] = '';
    }
  };
  this.tail = () => [...this.tailLines];
  this.close = () => Object.values(this.files).forEach((file) => file.close());
}

function RotatingFile(filePath, maxBytes = 50 * 1024 * 1024) {
  this.filePath = filePath;
  this.maxBytes = maxBytes;
  this.size = 0;
  this.write = (value) => {
    const bytes = Buffer.byteLength(value);
    if (this.size + bytes > this.maxBytes) this.rotate();
    fs.appendFileSync(this.filePath, value, 'utf8');
    this.size += bytes;
  };
  this.rotate = () => {
    const previous = `${this.filePath}.1`;
    try { fs.rmSync(previous, { force: true }); } catch {}
    try { fs.renameSync(this.filePath, previous); } catch {}
    this.size = 0;
  };
  this.close = () => {};
}

function selectCases(parsed) {
  let cases = testCasesForSuite(parsed.suite);
  if (parsed.caseId) cases = TEST_CASES.filter((item) => item.id === parsed.caseId);
  if (parsed.group) cases = cases.filter((item) => item.group === parsed.group);
  if (parsed.rerunFailed) {
    const pointer = readJson(path.join(runsRoot, parsed.rerunFailed === 'latest' ? 'latest-failed.json' : parsed.rerunFailed, 'summary.json'))
      || readJson(path.join(runsRoot, 'latest-failed.json'));
    const ids = new Set(pointer?.failedCaseIds || pointer?.results?.filter((item) => item.status !== 'passed').map((item) => item.caseId) || []);
    cases = TEST_CASES.filter((item) => ids.has(item.id));
  }
  return cases;
}

function parseArgs(argv) {
  const parsed = { suite: 'check', caseId: '', group: '', runId: '', rerunFailed: '', failFast: false, keepSuccessArtifacts: false, list: false, minAvailableMb: Number(process.env.JANUS_TEST_MIN_AVAILABLE_MB || 512) };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--suite') parsed.suite = requiredValue(argv, ++index, arg);
    else if (arg === '--case') parsed.caseId = requiredValue(argv, ++index, arg);
    else if (arg === '--group') parsed.group = requiredValue(argv, ++index, arg);
    else if (arg === '--run-id') parsed.runId = sanitizeId(requiredValue(argv, ++index, arg));
    else if (arg === '--rerun-failed') parsed.rerunFailed = requiredValue(argv, ++index, arg);
    else if (arg === '--min-available-mb') parsed.minAvailableMb = Number(requiredValue(argv, ++index, arg));
    else if (arg === '--fail-fast') parsed.failFast = true;
    else if (arg === '--keep-success-artifacts') parsed.keepSuccessArtifacts = true;
    else if (arg === '--list') parsed.list = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isFinite(parsed.minAvailableMb) || parsed.minAvailableMb < 0) throw new Error('--min-available-mb must be a non-negative number');
  return parsed;
}

function requiredValue(argv, index, option) {
  if (!argv[index]) throw new Error(`${option} requires a value`);
  return argv[index];
}

function buildSummary({ runId, startedAt: start, endedAt: end, status, selected: cases, results: caseResults, git: gitInfo, runDir: directory }) {
  const durationMs = Math.max(0, Date.parse(end) - Date.parse(start));
  const counts = {
    selected: cases.length,
    executed: caseResults.length,
    passed: caseResults.filter((item) => item.status === 'passed').length,
    failed: caseResults.filter((item) => item.status === 'failed').length,
    timeout: caseResults.filter((item) => item.status === 'timeout').length,
    infrastructureError: caseResults.filter((item) => item.status === 'infrastructure_error').length,
    notRun: Math.max(0, cases.length - caseResults.length),
  };
  return redactDiagnosticValue({ schemaVersion: 1, runId, status, startedAt: start, endedAt: end, durationMs, counts, git: gitInfo, artifactDirectory: path.relative(repoRoot, directory), results: caseResults });
}

function renderSummaryMarkdown(summary) {
  const failed = summary.results.filter((item) => item.status !== 'passed');
  const slowest = [...summary.results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
  const lines = [
    `# Janus test run ${summary.runId}`,
    '',
    `- Status: **${summary.status}**`,
    `- Duration: ${formatDuration(summary.durationMs)}`,
    `- Passed: ${summary.counts.passed}/${summary.counts.selected}`,
    `- Failed: ${summary.counts.failed + summary.counts.timeout + summary.counts.infrastructureError}`,
    `- Diagnostics: \`${summary.artifactDirectory}\``,
    '',
  ];
  if (failed.length) {
    lines.push('## Failures', '');
    for (const item of failed) {
      lines.push(`- **${item.caseId}** — ${item.status}: ${item.rootCause || item.failureMessage || 'unknown failure'}`);
      lines.push(`  - Reproduce: \`${item.reproduction}\``);
    }
    lines.push('');
  }
  const reports = summary.results.filter((item) => item.primaryReport);
  if (reports.length) {
    lines.push('## Retained reports', '');
    for (const item of reports) {
      const relative = `cases/${sanitizeId(item.caseId)}/${item.primaryReport}`;
      lines.push(`- **${item.caseId}** — [${item.primaryReport}](${relative})`);
    }
    lines.push('');
  }
  lines.push('## Slowest cases', '', '| Case | Status | Duration |', '| --- | --- | ---: |');
  for (const item of slowest) lines.push(`| ${item.caseId} | ${item.status} | ${formatDuration(item.durationMs)} |`);
  return `${lines.join('\n')}\n`;
}

function renderFailureMarkdown(result) {
  return `# ${result.caseId} failure\n\n- Status: **${result.status}**\n- Root cause: ${result.rootCause || result.failureMessage || 'unknown'}\n- Duration: ${formatDuration(result.durationMs)}\n- Reproduce: \`${result.reproduction}\`\n\n## Output tail\n\n\`\`\`text\n${(result.outputTail || []).join('\n')}\n\`\`\`\n`;
}

function renderJunit(summary) {
  const failures = summary.results.filter((item) => item.status !== 'passed').length;
  const cases = summary.results.map((item) => {
    const body = item.status === 'passed' ? '' : `<failure message="${xmlEscape(item.rootCause || item.failureMessage || item.status)}">${xmlEscape((item.outputTail || []).join('\n'))}</failure>`;
    return `  <testcase classname="janus.${xmlEscape(item.group || 'test')}" name="${xmlEscape(item.caseId)}" time="${(item.durationMs / 1000).toFixed(3)}">${body}</testcase>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="janus" tests="${summary.results.length}" failures="${failures}" time="${(summary.durationMs / 1000).toFixed(3)}">\n${cases}\n</testsuite>\n`;
}

function renderConsoleSummary(summary) {
  const failed = summary.results.filter((item) => item.status !== 'passed');
  const lines = [`[test-runner] ${summary.status.toUpperCase()} run=${summary.runId} passed=${summary.counts.passed}/${summary.counts.selected} duration=${formatDuration(summary.durationMs)}`];
  for (const item of failed) lines.push(`[test-runner] failure ${item.caseId}: ${item.rootCause || item.failureMessage}`);
  for (const item of summary.results.filter((entry) => entry.primaryReport)) {
    lines.push(`[test-runner] report ${item.caseId}: ${summary.artifactDirectory}/cases/${sanitizeId(item.caseId)}/${item.primaryReport}`);
  }
  lines.push(`[test-runner] summary=${summary.artifactDirectory}/summary.md`);
  return lines.join('\n');
}

function infrastructureResult(test, message) {
  return {
    schemaVersion: 1, caseId: test.id, title: test.title, group: test.group, status: 'infrastructure_error',
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 0,
    exitCode: null, signal: null, timedOut: false, failureMessage: message, rootCause: message,
    outputTail: [], reproduction: `npm run test:diagnostic -- --case ${test.id}`, artifacts: [],
  };
}

function rootCauseFromTail(lines) {
  const candidates = [...lines].reverse();
  return candidates.find((line) => /AssertionError[^:]*:/i.test(line))?.slice(0, 1000)
    || candidates.find((line) => /(?:^|\]\s)(?:[A-Za-z]+)?Error:/i.test(line))?.slice(0, 1000)
    || candidates.find((line) => /timed out|timeout|failed/i.test(line))?.slice(0, 1000)
    || candidates.find((line) => /ERR_[A-Z_]+/i.test(line))?.slice(0, 1000)
    || candidates.find((line) => line.trim())?.slice(0, 1000)
    || 'Test failed without diagnostic output.';
}

function stopProcessTree(child, signal) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {}
}

function resourceSnapshot() {
  return { load1m: os.loadavg()[0], availableMemoryMb: availableMemoryMb(), freeMemoryMb: os.freemem() / 1024 / 1024 };
}

function availableMemoryMb() {
  if (process.platform === 'linux') {
    try {
      const match = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB$/m);
      if (match) return Number(match[1]) / 1024;
    } catch {}
  }
  return os.freemem() / 1024 / 1024;
}

function gitMetadata() {
  const commit = commandOutput('git', ['rev-parse', '--short=12', 'HEAD']);
  const branch = commandOutput('git', ['branch', '--show-current']);
  const dirty = Boolean(commandOutput('git', ['status', '--porcelain']));
  return { commit, branch, dirty };
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function packageVersion(name) {
  const packagePath = path.join(repoRoot, 'node_modules', name, 'package.json');
  return readJson(packagePath)?.version || '';
}

function createRunId(commit = '') {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return sanitizeId(`${stamp}-${commit || 'nogit'}-${process.pid}`);
}

function sanitizeId(value) { return String(value || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180); }
function resolvedCaseEnv(values = {}, artifactDir = '') {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value).replaceAll('{artifactDir}', artifactDir)]));
}
function relativeCommand(command) { return command === process.execPath ? 'node' : path.isAbsolute(command) ? path.relative(repoRoot, command) || command : command; }
function formatDuration(ms) { return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`; }
function xmlEscape(value) { return String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, filePath);
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

async function listRelativeFiles(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.isFile()) files.push(path.relative(directory, entryPath));
    }
  }
  await walk(directory);
  return files.slice(0, 500);
}

async function existingDeclaredArtifacts(caseDir, declared = []) {
  const found = [];
  for (const item of Array.isArray(declared) ? declared : []) {
    const relative = safeRelativeArtifact(item);
    if (!relative) continue;
    const target = path.resolve(caseDir, relative);
    if (!target.startsWith(`${path.resolve(caseDir)}${path.sep}`)) continue;
    const stat = await fsp.stat(target).catch(() => null);
    if (stat?.isFile()) found.push(relative);
  }
  return [...new Set(found)];
}

function safeRelativeArtifact(value = '') {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return '';
  return normalized.split('/').filter(Boolean).join('/').slice(0, 500);
}

async function retainCaseArtifacts(caseDir, relativeFiles = []) {
  const keep = new Set(relativeFiles.map(safeRelativeArtifact).filter(Boolean));
  const root = path.resolve(caseDir);
  async function prune(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        await prune(target);
        const remaining = await fsp.readdir(target).catch(() => []);
        if (!remaining.length) await fsp.rm(target, { recursive: true, force: true });
      } else if (entry.isFile() && !keep.has(relative)) {
        await fsp.rm(target, { force: true });
      }
    }
  }
  await prune(root);
}

async function collectServerJournal(directory, since, until) {
  if (process.platform !== 'linux' || String(process.env.JANUS_TEST_COLLECT_JOURNAL || '') !== '1') return;
  const units = ['janus-cloud.service', 'janus-evolution-worker.service'];
  const output = [];
  for (const unit of units) {
    const result = spawnSync('journalctl', ['-u', unit, '--since', since, '--until', until, '--no-pager', '-o', 'short-iso'], {
      cwd: repoRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    output.push(`===== ${unit} =====`);
    output.push(result.status === 0 ? result.stdout : `journal unavailable: ${result.stderr || `exit ${result.status}`}`);
  }
  const redacted = redactDiagnosticText(output.join('\n'), { maxLength: 5 * 1024 * 1024 });
  await fsp.writeFile(path.join(directory, 'server-journal.log'), `${redacted}\n`, 'utf8');
}
