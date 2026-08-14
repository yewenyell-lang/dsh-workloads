import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const MAX_LOG_BYTES = 8 * 1024 * 1024
const LOG_COPIES = 3
const now = () => new Date().toISOString()
let expectedRunId = null

function readRecord(metaPath) { return JSON.parse(fs.readFileSync(metaPath, 'utf8')) }
function writeRecord(metaPath, updater) {
  const current = readRecord(metaPath)
  if (expectedRunId && current.currentRunId !== expectedRunId) return false
  const next = typeof updater === 'function' ? updater(current) : updater
  next.updatedAt = now()
  const temp = `${metaPath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8')
  fs.renameSync(temp, metaPath)
}
function rotate(logPath) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size < MAX_LOG_BYTES) return
    for (let index = LOG_COPIES - 1; index >= 1; index -= 1) {
      const source = `${logPath}.${index}`
      const target = `${logPath}.${index + 1}`
      if (fs.existsSync(target)) fs.rmSync(target, { force: true })
      if (fs.existsSync(source)) fs.renameSync(source, target)
    }
    if (fs.existsSync(`${logPath}.1`)) fs.rmSync(`${logPath}.1`, { force: true })
    fs.renameSync(logPath, `${logPath}.1`)
  } catch {}
}
function append(logPath, stream, chunk) {
  rotate(logPath)
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
  fs.appendFileSync(logPath, `[${now()}] [${stream}] ${text}`, 'utf8')
}
function payload() {
  if (!process.argv[2]) throw new Error('Missing workload payload')
  return JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'))
}
function killTree(pid, force = false) {
  if (!pid || process.platform !== 'win32') return
  const args = ['/PID', String(pid), '/T']
  if (force) args.push('/F')
  try { spawn('taskkill.exe', args, { windowsHide: true, stdio: 'ignore' }).unref() } catch {}
}

async function main() {
  const input = payload()
  expectedRunId = input.runId
  fs.mkdirSync(path.dirname(input.logPath), { recursive: true })
  fs.appendFileSync(input.logPath, `[${now()}] [manager] starting ${input.label} run=${input.runId}\n`, 'utf8')
  writeRecord(input.metaPath, (record) => ({
    ...record,
    phase: 'starting',
    health: 'unknown',
    run: { ...record.run, runnerPid: process.pid, runnerStartedAt: now() },
  }))
  const child = spawn(input.executable, input.args, {
    cwd: input.cwd,
    env: process.env,
    windowsHide: true,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stopping = false
  child.once('spawn', () => writeRecord(input.metaPath, (record) => ({
    ...record,
    phase: 'running',
    health: 'unknown',
    run: { ...record.run, pid: child.pid ?? null, startedAt: now(), error: null },
  })))
  child.stdout?.on('data', (chunk) => append(input.logPath, 'stdout', chunk))
  child.stderr?.on('data', (chunk) => append(input.logPath, 'stderr', chunk))
  child.once('error', (error) => {
    append(input.logPath, 'manager', `spawn failed: ${error.message}\n`)
    writeRecord(input.metaPath, (record) => ({
      ...record,
      phase: 'failed',
      health: 'unhealthy',
      run: { ...record.run, endedAt: now(), error: error.message },
    }))
  })
  child.once('exit', (code, signal) => {
    append(input.logPath, 'manager', `process exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`)
    writeRecord(input.metaPath, (record) => ({
      ...record,
      phase: stopping ? 'stopped' : (code === 0 ? 'exited' : 'failed'),
      health: 'unknown',
      run: { ...record.run, exitCode: code, signal, endedAt: now() },
    }))
  })
  const stop = () => {
    if (stopping) return
    stopping = true
    try {
      writeRecord(input.metaPath, (record) => ({ ...record, phase: 'stopping', run: { ...record.run, stopRequestedAt: now() } }))
    } catch {}
    killTree(child.pid, false)
    setTimeout(() => killTree(child.pid, true), 4000).unref()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((error) => {
  try {
    const input = payload()
    expectedRunId = input.runId
    fs.appendFileSync(input.logPath, `[${now()}] [manager] fatal: ${error.message}\n`, 'utf8')
    writeRecord(input.metaPath, (record) => ({
      ...record,
      phase: 'failed',
      health: 'unhealthy',
      run: { ...record.run, endedAt: now(), error: error.message },
    }))
  } catch {}
  process.exitCode = 1
})
