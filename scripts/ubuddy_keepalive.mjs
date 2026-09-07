#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises'
import { watchFile, unwatchFile } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultStatusFile = path.join(repoRoot, 'workspace', 'ubuddy-progress.md')

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr
  stream.write(`Usage: node scripts/ubuddy_keepalive.mjs [options]\n\n`)
  stream.write(`Options:\n`)
  stream.write(`  --status-file <path>       Progress snapshot file (default: workspace/ubuddy-progress.md)\n`)
  stream.write(`  --interval-seconds <n>     Heartbeat interval in seconds (default: 300)\n`)
  stream.write(`  --once                     Print one snapshot and exit\n`)
  stream.write(`  --help                     Show this help\n`)
  process.exit(exitCode)
}

function positiveInteger(value, option) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || Math.floor(parsed) !== parsed) {
    throw new Error(`${option} requires a positive integer`)
  }
  return parsed
}

function parseArgs(argv) {
  const options = {
    statusFile: defaultStatusFile,
    intervalSeconds: 300,
    once: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help') usage(0)
    if (arg === '--once') {
      options.once = true
      continue
    }

    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    if (arg === '--status-file') options.statusFile = path.resolve(repoRoot, value)
    else if (arg === '--interval-seconds') options.intervalSeconds = positiveInteger(value, arg)
    else throw new Error(`Unknown option: ${arg}`)
    index += 1
  }

  return options
}

function trimTrailingBlankLines(lines) {
  const copy = [...lines]
  while (copy.length && !String(copy.at(-1) || '').trim()) copy.pop()
  return copy
}

async function readStatusSnapshot(statusFile) {
  try {
    const [content, fileStat] = await Promise.all([readFile(statusFile, 'utf8'), stat(statusFile)])
    const lines = trimTrailingBlankLines(content.split(/\r?\n/))
    return {
      exists: true,
      mtime: fileStat.mtime.toISOString(),
      lines: lines.length ? lines : ['(status file is empty)'],
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        exists: false,
        mtime: '',
        lines: [
          '(status file does not exist yet)',
          `Create ${path.relative(repoRoot, statusFile)} to publish a live ubuddy summary.`,
        ],
      }
    }
    throw error
  }
}

function formatSnapshot(snapshot, intervalSeconds, tick, changed) {
  const timestamp = new Date().toISOString()
  const header = [
    `[ubuddy-watchdog] ${timestamp}`,
    `状态: ${changed ? '已更新' : '无新增变化'} | 风险: 远程会话可能因空闲断联 | 下一步: 继续监控并刷新进度 | 阻塞项: 无`,
    `心跳: 第 ${tick} 次 | 间隔 ${intervalSeconds}s | 数据源 ${snapshot.exists ? '已存在' : '缺失'}`,
    `状态文件最近修改: ${snapshot.mtime || 'n/a'}`,
  ]
  return [...header, ...snapshot.lines].join('\n')
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`[ubuddy-watchdog] ${error.message}\n`)
    usage(1)
  }

  let tick = 0
  let lastSignature = ''
  let stopped = false

  const emit = async () => {
    if (stopped) return
    tick += 1
    const snapshot = await readStatusSnapshot(options.statusFile)
    const signature = `${snapshot.exists ? '1' : '0'}:${snapshot.mtime}:${snapshot.lines.join('\n')}`
    const changed = signature !== lastSignature
    process.stdout.write(`${formatSnapshot(snapshot, options.intervalSeconds, tick, changed)}\n\n`)
    lastSignature = signature
  }

  await emit()
  if (options.once) return

  watchFile(options.statusFile, { interval: 15_000 }, async (current, previous) => {
    if (stopped) return
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return
    try {
      await emit()
    } catch (error) {
      process.stderr.write(`[ubuddy-watchdog] ${error.message}\n`)
    }
  })

  const timer = setInterval(() => {
    void emit().catch((error) => {
      process.stderr.write(`[ubuddy-watchdog] ${error.message}\n`)
    })
  }, options.intervalSeconds * 1000)

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stopped = true
      clearInterval(timer)
      try {
        unwatchFile(options.statusFile)
      } catch {
        // Best effort cleanup.
      }
      process.stdout.write(`[ubuddy-watchdog] stopped by ${signal}\n`)
      process.exit(0)
    })
  }
}

await main()
