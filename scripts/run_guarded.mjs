#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lockRoot = path.join(repoRoot, '.codex-tmp')
const lockDir = path.join(lockRoot, 'resource-guard.lock')
const cpuCount = Math.max(1, os.availableParallelism?.() || os.cpus().length || 1)

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr
  stream.write(`Usage: node scripts/run_guarded.mjs [options] -- <command> [args...]\n\n`)
  stream.write(`Options:\n`)
  stream.write(`  --timeout-seconds <n>   Command timeout (default: 1200)\n`)
  stream.write(`  --max-start-load <n>    Refuse to start above this 1m load (default: ${(
    cpuCount * 1.5
  ).toFixed(1)})\n`)
  stream.write(`  --max-run-load <n>      Stop after sustained load above this value (default: ${(
    cpuCount * 2
  ).toFixed(1)})\n`)
  stream.write(`  --overload-seconds <n>  Sustained overload window (default: 30)\n`)
  stream.write(`  --min-available-mb <n>  Minimum available memory (default: 1024)\n`)
  stream.write(`  --help                  Show this help\n`)
  process.exit(exitCode)
}

function positiveNumber(value, option) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} requires a positive number`)
  }
  return parsed
}

function parseArgs(argv) {
  const separator = argv.indexOf('--')
  if (separator === -1 || separator === argv.length - 1) usage(1)

  const options = {
    timeoutSeconds: 1200,
    maxStartLoad: cpuCount * 1.5,
    maxRunLoad: cpuCount * 2,
    overloadSeconds: 30,
    minAvailableMb: 1024,
  }

  for (let index = 0; index < separator; index += 1) {
    const arg = argv[index]
    if (arg === '--help') usage(0)
    const value = argv[index + 1]
    if (!value || value === '--') throw new Error(`${arg} requires a value`)

    if (arg === '--timeout-seconds') options.timeoutSeconds = positiveNumber(value, arg)
    else if (arg === '--max-start-load') options.maxStartLoad = positiveNumber(value, arg)
    else if (arg === '--max-run-load') options.maxRunLoad = positiveNumber(value, arg)
    else if (arg === '--overload-seconds') options.overloadSeconds = positiveNumber(value, arg)
    else if (arg === '--min-available-mb') options.minAvailableMb = positiveNumber(value, arg)
    else throw new Error(`Unknown option: ${arg}`)
    index += 1
  }

  return { options, command: argv[separator + 1], commandArgs: argv.slice(separator + 2) }
}

function availableMemoryMb() {
  if (process.platform === 'linux') {
    try {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8')
      const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m)
      if (match) return Number(match[1]) / 1024
    } catch {
      // Fall through to the portable estimate.
    }
  }
  return os.freemem() / 1024 / 1024
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function acquireLock() {
  fs.mkdirSync(lockRoot, { recursive: true })
  try {
    fs.mkdirSync(lockDir)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    let owner = null
    try {
      owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'))
    } catch {
      // A partial or stale lock is handled below.
    }
    if (processExists(owner?.pid)) {
      throw new Error(
        `another guarded command is already running (guard pid ${owner.pid}, command: ${
          owner.command || 'unknown'
        })`,
      )
    }
    fs.rmSync(lockDir, { recursive: true, force: true })
    fs.mkdirSync(lockDir)
  }

  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
  )
}

function updateLock(command, commandArgs) {
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    `${JSON.stringify(
      {
        pid: process.pid,
        childPid: child?.pid || null,
        startedAt,
        command: [command, ...commandArgs].join(' '),
      },
      null,
      2,
    )}\n`,
  )
}

function releaseLock() {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'))
    if (owner?.pid === process.pid) fs.rmSync(lockDir, { recursive: true, force: true })
  } catch {
    // Never hide the command result because lock cleanup failed.
  }
}

function stopChild(signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // The process may have exited between the status check and the signal.
  }
}

let parsed
try {
  parsed = parseArgs(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`[resource-guard] ${error.message}\n`)
  usage(1)
}

const { options, command, commandArgs } = parsed
const initialLoad = os.loadavg()[0]
const initialAvailableMb = availableMemoryMb()

if (initialLoad > options.maxStartLoad) {
  process.stderr.write(
    `[resource-guard] refusing to start: load ${initialLoad.toFixed(2)} exceeds ${options.maxStartLoad.toFixed(
      2,
    )}\n`,
  )
  process.exit(75)
}
if (initialAvailableMb < options.minAvailableMb) {
  process.stderr.write(
    `[resource-guard] refusing to start: available memory ${Math.round(
      initialAvailableMb,
    )} MB is below ${options.minAvailableMb} MB\n`,
  )
  process.exit(75)
}

try {
  acquireLock()
} catch (error) {
  process.stderr.write(`[resource-guard] refusing to start: ${error.message}\n`)
  process.exit(75)
}

const startedAt = new Date().toISOString()
let child = null
let stoppingReason = null
let overloadSince = null
let lowMemorySince = null
let forceKillTimer = null

process.stdout.write(
  `[resource-guard] starting in ${repoRoot}; load=${initialLoad.toFixed(2)}, available=${Math.round(
    initialAvailableMb,
  )} MB, timeout=${options.timeoutSeconds}s\n`,
)

child = spawn(command, commandArgs, {
  cwd: repoRoot,
  stdio: 'inherit',
  detached: process.platform !== 'win32',
  env: process.env,
})
updateLock(command, commandArgs)

try {
  os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
} catch (error) {
  process.stderr.write(`[resource-guard] warning: could not lower child priority: ${error.message}\n`)
}

function requestStop(reason) {
  if (stoppingReason) return
  stoppingReason = reason
  process.stderr.write(`[resource-guard] stopping command: ${reason}\n`)
  stopChild('SIGTERM')
  forceKillTimer = setTimeout(() => stopChild('SIGKILL'), 5000)
  forceKillTimer.unref()
}

const timeoutTimer = setTimeout(
  () => requestStop(`timeout after ${options.timeoutSeconds} seconds`),
  options.timeoutSeconds * 1000,
)
timeoutTimer.unref()

const pressureTimer = setInterval(() => {
  const now = Date.now()
  const load = os.loadavg()[0]
  const availableMb = availableMemoryMb()

  overloadSince = load > options.maxRunLoad ? overloadSince || now : null
  lowMemorySince = availableMb < options.minAvailableMb ? lowMemorySince || now : null

  if (overloadSince && now - overloadSince >= options.overloadSeconds * 1000) {
    requestStop(
      `load ${load.toFixed(2)} stayed above ${options.maxRunLoad.toFixed(2)} for ${options.overloadSeconds}s`,
    )
  } else if (lowMemorySince && now - lowMemorySince >= 10_000) {
    requestStop(`available memory stayed below ${options.minAvailableMb} MB for 10s`)
  }
}, 2000)
pressureTimer.unref()

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => requestStop(`guard received ${signal}`))
}

child.on('error', (error) => {
  clearTimeout(timeoutTimer)
  clearInterval(pressureTimer)
  if (forceKillTimer) clearTimeout(forceKillTimer)
  releaseLock()
  process.stderr.write(`[resource-guard] failed to start command: ${error.message}\n`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  clearTimeout(timeoutTimer)
  clearInterval(pressureTimer)
  if (forceKillTimer) clearTimeout(forceKillTimer)
  releaseLock()

  if (stoppingReason) {
    process.stderr.write(`[resource-guard] command stopped (${stoppingReason})\n`)
    process.exitCode = 124
    return
  }
  if (signal) {
    process.stderr.write(`[resource-guard] command exited from signal ${signal}\n`)
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})
