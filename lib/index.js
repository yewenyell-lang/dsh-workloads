import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-workloads-local-ui1'
export const inject = ['webServer', 'sessions', 'sandboxPolicy']

const API_PATH = '/dsh-workloads/api'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const RUNTIME_BASE = path.join(DSH_HOME, 'runtime', 'workloads')
const RUNNER_PATH = fileURLToPath(new URL('./runner.mjs', import.meta.url))
const START_TIMEOUT_MS = 10000
const STOP_GRACE_MS = 5000
const STARTUP_GRACE_MS = 5000
const STALE_STARTING_MS = 30000
const HISTORY_DAYS = 30
const WORKLOAD_LIMIT = 100
const LOG_READ_LIMIT = 32768
const ACTIVE_PHASES = new Set(['starting', 'running', 'stopping'])
let processCache = { expiresAt: 0, rows: [] }

const now = () => new Date().toISOString()
function canonicalWorkspace(value) {
  if (!value || !path.isAbsolute(value)) throw new Error('workspace cwd must be an absolute path')
  const resolved = path.resolve(value)
  try { return fs.realpathSync.native(resolved) } catch { return resolved }
}
function normalized(value) { return canonicalWorkspace(value).replace(/[\\/]+$/, '').toLowerCase() }
function workspaceKey(root) { return crypto.createHash('sha256').update(normalized(root)).digest('hex').slice(0, 20) }
function workspaceDir(root, legacyProcessRoots = [], create = true) {
  const canonical = canonicalWorkspace(root)
  const dir = path.join(RUNTIME_BASE, workspaceKey(canonical))
  if (!create) return dir
  fs.mkdirSync(dir, { recursive: true })
  const marker = path.join(dir, 'workspace.json')
  if (!fs.existsSync(marker)) writeJson(marker, { schemaVersion: 1, workspace: canonical, workspaceKey: path.basename(dir), createdAt: now() })
  migrateLegacy(canonical, dir, legacyProcessRoots)
  return dir
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(temp, file)
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
function safeLabel(value) {
  const text = String(value || 'workload').trim() || 'workload'
  return text.replace(/[^\p{L}\p{N}_.:-]+/gu, '-').slice(0, 80)
}
function id(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return `${prefix}-${stamp}-${crypto.randomBytes(4).toString('hex')}`
}
function scrubbedEnv() {
  const result = {}
  const sensitive = /(?:^|_)(?:api_?key|token|secret|password|passwd|pwd|authorization|auth|credential|cookie)(?:$|_)/i
  for (const [key, value] of Object.entries(process.env)) {
    if (/^DSH_/i.test(key) || sensitive.test(key)) continue
    if (typeof value === 'string') result[key] = value
  }
  return result
}
function secretShaped(command) {
  return /(?:--?(?:password|passwd|pwd|token|secret|api[-_]?key|authorization|connection[-_]?string)\b\s*(?:=|\s)|\bbearer\s+[a-z0-9._-]+|\bredis-cli\b[^\r\n]*\s-a\s+|:\/\/[^\s/:]+:[^\s/@]+@|\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/i.test(String(command))
}
function splitCommand(command) {
  const parts = []
  let current = ''
  let quote = null
  for (const char of String(command).trim()) {
    if ((char === '"' || char === "'") && (!quote || quote === char)) { quote = quote ? null : char; continue }
    if (/\s/.test(char) && !quote) { if (current) parts.push(current); current = ''; continue }
    current += char
  }
  if (quote) throw new Error('command contains an unclosed quote')
  if (current) parts.push(current)
  return parts
}
function resolveLaunch(command, shell, shellType) {
  if (secretShaped(command)) throw new Error('command appears to contain a credential or token; use an approved local configuration source')
  if (/[\r\n\0]/.test(command)) throw new Error('command must be a single line')
  const parts = splitCommand(command)
  if (!parts.length) throw new Error('command is required')
  const first = parts[0].toLowerCase()
  const shellSyntax = /[|&<>;$()`]/.test(command)
  const shim = ['npm', 'npm.cmd', 'pnpm', 'pnpm.cmd', 'yarn', 'yarn.cmd'].includes(first) || first.endsWith('.cmd') || first.endsWith('.bat')
  const useShell = shell === true || shellSyntax || shim || first.endsWith('.ps1')
  if (!useShell) return { executable: parts[0], args: parts.slice(1), shell: false, shellType: null }
  const selected = shellType === 'cmd' || shim ? 'cmd' : 'pwsh'
  return selected === 'cmd'
    ? { executable: 'cmd.exe', args: ['/d', '/s', '/c', command], shell: true, shellType: 'cmd' }
    : { executable: 'pwsh.exe', args: ['-NoProfile', '-Command', command], shell: true, shellType: 'pwsh' }
}
function resolveCwd(root, requested) {
  const workspace = canonicalWorkspace(root)
  const candidate = requested ? (path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(workspace, requested)) : workspace
  const relative = path.relative(workspace, candidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`cwd must stay inside workspace: ${workspace}`)
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) throw new Error(`cwd does not exist or is not a directory: ${candidate}`)
  return candidate
}
function parseDate(value) { return typeof value === 'string' ? Date.parse(value) || 0 : 0 }
function processTable() {
  const current = Date.now()
  if (processCache.expiresAt > current) return processCache.rows
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name | ConvertTo-Json -Compress'
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-Command', script], { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  let parsed = []
  try { if (result.status === 0 && result.stdout.trim()) parsed = JSON.parse(result.stdout) } catch { parsed = [] }
  const rows = (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
    pid: Number(entry?.ProcessId), parentPid: Number(entry?.ParentProcessId) || null,
    createdAt: parseDate(entry?.CreationDate), name: typeof entry?.Name === 'string' ? entry.Name : '',
  })).filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0)
  processCache = { expiresAt: current + 750, rows }
  return rows
}
function descendants(rootPid, table) {
  const children = new Map()
  for (const row of table) {
    if (!row.parentPid) continue
    const list = children.get(row.parentPid) || []
    list.push(row); children.set(row.parentPid, list)
  }
  const queue = [rootPid]
  const seen = new Set(queue)
  const result = []
  while (queue.length) {
    const parent = queue.shift()
    for (const child of children.get(parent) || []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid); result.push(child); queue.push(child.pid)
    }
  }
  return result
}
function recordFile(dir, workloadId) {
  if (!/^wl-[A-Za-z0-9_.-]{1,180}$/.test(workloadId)) throw new Error('invalid workloadId')
  return path.join(dir, `${workloadId}.json`)
}
function reconcile(record, table) {
  const initial = JSON.stringify({ phase: record.phase, health: record.health, run: record.run })
  const run = record.run || {}
  const started = Date.parse(run.startedAt || run.createdAt || record.createdAt) || 0
  const pidRow = table.find((row) => row.pid === run.pid && (!row.createdAt || row.createdAt >= started - 5000))
  const runnerRow = table.find((row) => row.pid === run.runnerPid && (!row.createdAt || row.createdAt >= started - 5000))
  if (!pidRow && run.pid) {
    const adopted = descendants(run.pid, table)
      .filter((row) => !row.createdAt || row.createdAt >= started - 5000)
      .find((row) => !['cmd.exe', 'pwsh.exe', 'powershell.exe', 'conhost.exe'].includes(row.name.toLowerCase()))
    if (adopted) {
      run.pid = adopted.pid; run.adoptedAt = run.adoptedAt || now(); run.targetName = adopted.name
      if (['exited', 'failed', 'stopped', 'orphaned'].includes(record.phase)) record.phase = 'running'
    }
  }
  const effective = table.some((row) => row.pid === run.pid) || Boolean(runnerRow)
  if (record.phase === 'starting' && Date.now() - (Date.parse(record.updatedAt || record.createdAt) || 0) > STALE_STARTING_MS) {
    record.phase = 'failed'; record.health = 'unhealthy'; run.error = run.error || 'runner did not report running within 30 seconds'; run.endedAt = run.endedAt || now()
  } else if (['running', 'stopping'].includes(record.phase) && !effective && Date.now() - started >= STARTUP_GRACE_MS && table.length > 0) {
    record.phase = record.phase === 'stopping' ? 'stopped' : 'exited'; record.health = 'unknown'; run.endedAt = run.endedAt || now()
  }
  record.run = run
  if (JSON.stringify({ phase: record.phase, health: record.health, run: record.run }) !== initial) { record.updatedAt = now(); return true }
  return false
}
function redact(text) {
  return String(text)
    .replace(/\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, '[REDACTED_JWT]')
    .replace(/\b(Bearer)\s+[a-zA-Z0-9._~+\/-]+=*/gi, '$1 [REDACTED]')
    .replace(/\b(password|passwd|pwd|token|secret|api[-_]?key|authorization)\s*[:=]\s*([^\s;,]+)/gi, '$1=[REDACTED]')
    .replace(/(Password|Pwd)=[^;\r\n]*/gi, '$1=[REDACTED]')
    .replace(/:\/\/([^\s/:]+):([^\s/@]+)@/g, '://$1:[REDACTED]@')
}
function tail(file, maxBytes) {
  if (!file || !fs.existsSync(file)) return { text: '', truncated: false }
  const size = fs.statSync(file).size
  const length = Math.min(size, maxBytes)
  const fd = fs.openSync(file, 'r')
  try { const buffer = Buffer.alloc(length); fs.readSync(fd, buffer, 0, length, size - length); return { text: buffer.toString('utf8'), truncated: size > length } }
  finally { fs.closeSync(fd) }
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function killTree(pid, force) {
  const args = ['/PID', String(pid), '/T']; if (force) args.push('/F')
  return spawnSync('taskkill.exe', args, { windowsHide: true, encoding: 'utf8' })
}
function publicRecord(record) {
  const run = record.run || {}
  return {
    workloadId: record.workloadId, runId: record.currentRunId || null, generation: record.generation || 1, provider: record.provider,
    scope: { type: 'workspace', workspaceKey: record.scope.workspaceKey, cwd: record.scope.cwd },
    label: record.label, phase: record.phase, health: record.health,
    pid: Number.isInteger(run.pid) ? run.pid : null,
    createdAt: record.createdAt, startedAt: run.startedAt || null, endedAt: run.endedAt || null,
    exitCode: Number.isInteger(run.exitCode) ? run.exitCode : null,
    error: run.error ? redact(String(run.error)).slice(0, 500) : null,
    readiness: record.readiness || null,
    lastAction: record.lastAction ? { type: record.lastAction.type, source: record.lastAction.source, at: record.lastAction.at } : null,
    capabilities: { logs: true, stop: ACTIVE_PHASES.has(record.phase), restart: true, readiness: true },
    legacy: typeof record.migratedFrom === 'string',
  }
}
function phaseFromLegacy(status) {
  return ({ starting: 'starting', running: 'running', stopping: 'stopping', stopped: 'stopped', exited: 'exited', failed: 'failed' })[status] || 'orphaned'
}
function migrateLegacy(root, dir, legacyProcessRoots) {
  const marker = path.join(dir, '.legacy-process-v1.json')
  if (fs.existsSync(marker) || legacyProcessRoots.length === 0) return
  let migrated = 0
  const sources = []
  for (const base of legacyProcessRoots) {
    if (!base || !path.isAbsolute(base)) continue
    const legacy = path.join(path.resolve(base), workspaceKey(root))
    sources.push(legacy)
    if (!fs.existsSync(legacy)) continue
    for (const name of fs.readdirSync(legacy).filter((entry) => entry.endsWith('.json') && entry !== 'workspace.json')) {
      const old = readJson(path.join(legacy, name))
      if (!old?.jobId) continue
      const digest = crypto.createHash('sha256').update(String(old.jobId)).digest('hex').slice(0, 16)
      const workloadId = `wl-legacy-${digest}`
      const metaPath = recordFile(dir, workloadId)
      if (fs.existsSync(metaPath)) continue
      const runId = `wlr-legacy-${digest}`
      const logPath = path.join(dir, `${runId}.log`)
      if (old.logPath && fs.existsSync(old.logPath)) fs.copyFileSync(old.logPath, logPath)
      for (let index = 1; index <= 3; index += 1) if (old.logPath && fs.existsSync(`${old.logPath}.${index}`)) fs.copyFileSync(`${old.logPath}.${index}`, `${logPath}.${index}`)
      const readiness = old.readiness && typeof old.readiness === 'object' ? old.readiness : null
      writeJson(metaPath, {
        schemaVersion: 1, workloadId, currentRunId: runId, generation: 1, provider: 'local-process', migratedFrom: 'legacy-process-v1',
        scope: { type: 'workspace', workspaceKey: workspaceKey(root), cwd: root }, label: safeLabel(old.name),
        spec: { command: old.command || '', cwd: old.cwd || root, shell: old.shell === true, shellType: old.shellType || null },
        phase: phaseFromLegacy(old.status), health: readiness?.ready ? 'ready' : 'unknown', readiness,
        createdAt: old.createdAt || now(), updatedAt: old.updatedAt || old.createdAt || now(), history: [],
        run: {
          runId, pid: old.pid || null, runnerPid: old.launcherPid || null, createdAt: old.createdAt || now(),
          startedAt: old.startedAt || null, endedAt: old.endedAt || null, exitCode: old.exitCode ?? null,
          error: old.error || null, logPath,
        },
      })
      migrated += 1
    }
  }
  writeJson(marker, { schemaVersion: 1, migratedAt: now(), sources, count: migrated })
}

class LocalWorkloadRegistry {
  listeners = new Set()
  legacyProcessRoots
  constructor(options = {}) {
    this.legacyProcessRoots = Array.isArray(options.legacyProcessRoots)
      ? options.legacyProcessRoots.filter((value) => typeof value === 'string' && path.isAbsolute(value)).map((value) => path.resolve(value))
      : []
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  notify(root) { for (const listener of this.listeners) { try { listener(root) } catch {} } }
  list(root, options = {}) {
    const workspace = canonicalWorkspace(root)
    const dir = workspaceDir(workspace, this.legacyProcessRoots)
    const table = processTable()
    const rows = fs.readdirSync(dir).filter((name) => /^wl-.*\.json$/.test(name)).map((name) => ({ file: path.join(dir, name), record: readJson(path.join(dir, name)) })).filter((row) => row.record)
    for (const row of rows) if (reconcile(row.record, table)) writeJson(row.file, row.record)
    rows.sort((a, b) => Date.parse(b.record.updatedAt || b.record.createdAt) - Date.parse(a.record.updatedAt || a.record.createdAt))
    let records = rows.map((row) => row.record)
    if (options.activeOnly) records = records.filter((record) => ACTIVE_PHASES.has(record.phase))
    return { workspace, workspaceKey: workspaceKey(workspace), workloads: records.slice(0, WORKLOAD_LIMIT).map(publicRecord) }
  }
  record(root, workloadId) {
    const workspace = canonicalWorkspace(root)
    const dir = workspaceDir(workspace, this.legacyProcessRoots)
    const file = recordFile(dir, workloadId)
    const record = readJson(file)
    if (!record || record.scope?.workspaceKey !== workspaceKey(workspace)) throw new Error(`workload not found in workspace: ${workloadId}`)
    return { workspace, dir, file, record }
  }
  async start(root, args = {}, existing = null, control = {}) {
    const workspace = canonicalWorkspace(root)
    const dir = workspaceDir(workspace, this.legacyProcessRoots)
    const command = String(args.command || existing?.spec?.command || '').trim()
    const label = safeLabel(args.label || args.name || existing?.label || splitCommand(command)[0] || 'workload')
    const cwd = resolveCwd(workspace, args.cwd || existing?.spec?.cwd || workspace)
    const launch = resolveLaunch(command, args.shell ?? existing?.spec?.shell, args.shellType || args.shell_type || existing?.spec?.shellType)
    const active = this.list(workspace, { activeOnly: true }).workloads.find((item) => item.label === label)
    if (active && active.workloadId !== existing?.workloadId) throw new Error(`active workload already uses label ${label}: ${active.workloadId}`)
    const workloadId = existing?.workloadId || id('wl')
    const runId = id('wlr')
    const metaPath = recordFile(dir, workloadId)
    const logPath = path.join(dir, `${runId}.log`)
    const created = now()
    const history = existing ? [...(existing.history || []), existing.run].filter(Boolean).slice(-20) : []
    const record = {
      schemaVersion: 1, workloadId, currentRunId: runId, generation: (existing?.generation || 0) + 1, provider: 'local-process',
      scope: { type: 'workspace', workspaceKey: workspaceKey(workspace), cwd: workspace }, label,
      spec: { command, cwd, shell: launch.shell, shellType: launch.shellType },
      phase: 'starting', health: 'unknown', readiness: null,
      createdAt: existing?.createdAt || created, updatedAt: created, history,
      lastAction: { type: control.action || (existing ? 'restart' : 'start'), source: control.source || 'service', sessionId: control.sessionId || null, at: created },
      run: { runId, pid: null, runnerPid: null, createdAt: created, startedAt: null, endedAt: null, exitCode: null, error: null, logPath },
    }
    writeJson(metaPath, record)
    const payload = Buffer.from(JSON.stringify({ metaPath, logPath, runId, label, cwd, executable: launch.executable, args: launch.args }), 'utf8').toString('base64url')
    const runner = spawn(process.execPath, [RUNNER_PATH, payload], { cwd, env: scrubbedEnv(), windowsHide: true, detached: true, stdio: 'ignore' })
    runner.unref()
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(100)
      const current = readJson(metaPath)
      if (current?.phase === 'running') { this.notify(workspace); return publicRecord(current) }
      if (current && ['failed', 'exited'].includes(current.phase)) throw new Error(current.run?.error || `workload exited during startup (${current.run?.exitCode ?? 'unknown'})`)
    }
    throw new Error(`workload did not report running within ${START_TIMEOUT_MS}ms`)
  }
  async stop(root, workloadId, control = {}) {
    const row = this.record(root, workloadId)
    const record = row.record
    record.lastAction = { type: control.action || 'stop', source: control.source || 'service', sessionId: control.sessionId || null, at: now() }
    record.updatedAt = now()
    if (!ACTIVE_PHASES.has(record.phase)) { writeJson(row.file, record); return { ...publicRecord(record), forced: false, note: 'workload already terminal' } }
    // Never trust a cached process table here: start()/list() may have cached a
    // snapshot taken before this run's child was spawned, and the whole
    // start->wait->stopAll flow can complete faster than the 750 ms cache TTL,
    // which previously made stop() conclude "process already absent" and leave
    // the process tree running. Force a fresh identity probe so the recorded
    // runner/child PIDs are actually findable.
    processCache.expiresAt = 0
    const table = processTable()
    const started = Date.parse(record.run?.startedAt || record.run?.createdAt || record.createdAt) || 0
    if (table.length === 0) throw new Error('cannot verify process identity because the Windows process table is unavailable')
    const recordedPids = [record.run?.runnerPid, record.run?.pid].filter((pid) => Number.isInteger(pid) && pid > 0)
    const ambiguous = recordedPids.some((pid) => table.some((entry) => entry.pid === pid && (!entry.createdAt || entry.createdAt < started - 5000)))
    if (ambiguous) throw new Error('refusing to stop because PID creation time does not match the recorded workload run')
    const candidate = recordedPids.find((pid) => table.some((entry) => entry.pid === pid && entry.createdAt >= started - 5000))
    if (!candidate) {
      record.phase = 'stopped'; record.health = 'unknown'; record.run.endedAt = record.run.endedAt || now(); record.updatedAt = now(); writeJson(row.file, record)
      this.notify(row.workspace); return { ...publicRecord(record), forced: false, note: 'process already absent' }
    }
    record.phase = 'stopping'; record.run.stopRequestedAt = now(); record.updatedAt = now(); writeJson(row.file, record)
    killTree(candidate, false)
    const deadline = Date.now() + STOP_GRACE_MS
    while (Date.now() < deadline) {
      await sleep(150)
      processCache.expiresAt = 0
      const table = processTable()
      // An empty process table means the identity probe failed, not that the
      // process is gone: treat it as "still alive" so the grace loop always
      // escalates to a forced kill instead of claiming an early stop.
      const alive = table.length === 0 || table.some((entry) => entry.pid === candidate)
      if (!alive) {
        const current = readJson(row.file) || record; current.phase = 'stopped'; current.health = 'unknown'; current.run.endedAt = current.run.endedAt || now(); current.updatedAt = now(); writeJson(row.file, current)
        this.notify(row.workspace); return { ...publicRecord(current), forced: false }
      }
    }
    killTree(candidate, true); await sleep(250)
    const current = readJson(row.file) || record; current.phase = 'stopped'; current.health = 'unknown'; current.run.endedAt = current.run.endedAt || now(); current.updatedAt = now(); writeJson(row.file, current)
    this.notify(row.workspace); return { ...publicRecord(current), forced: true }
  }
  async stopAll(root, control = {}) {
    const workspace = canonicalWorkspace(root)
    const active = this.list(workspace, { activeOnly: true }).workloads
    const results = []
    for (const item of active) {
      try {
        const stopped = await this.stop(workspace, item.workloadId, control)
        results.push({ workloadId: item.workloadId, label: item.label, ok: true, phase: stopped.phase, forced: stopped.forced === true })
      } catch (error) {
        results.push({ workloadId: item.workloadId, label: item.label, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { requested: active.length, stopped: results.filter((item) => item.ok).length, results }
  }
  async restart(root, workloadId, control = {}) {
    const row = this.record(root, workloadId)
    const actor = { ...control, action: 'restart' }
    if (ACTIVE_PHASES.has(row.record.phase)) await this.stop(root, workloadId, actor)
    const latest = this.record(root, workloadId).record
    return this.start(root, {}, latest, actor)
  }
  logs(root, workloadId, maxBytes = 8192) {
    const row = this.record(root, workloadId)
    const logPath = row.record.run?.logPath
    const relative = logPath ? path.relative(row.dir, path.resolve(logPath)) : '..'
    if (!logPath || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('workload log path is outside its workspace runtime')
    const limit = Number.isInteger(maxBytes) ? Math.min(LOG_READ_LIMIT, Math.max(1024, maxBytes)) : 8192
    const result = tail(logPath, limit)
    return { workloadId, runId: row.record.currentRunId, label: row.record.label, phase: row.record.phase, truncated: result.truncated, log: redact(result.text) }
  }
  async wait(root, workloadId, args = {}, signal) {
    if (!args.port && !args.httpUrl && !args.http_url && !args.logText && !args.log_text) throw new Error('workload_wait requires logText, port, or httpUrl')
    const port = args.port === undefined ? null : Number(args.port)
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('port must be 1-65535')
    const httpValue = args.httpUrl || args.http_url
    const target = httpValue ? new URL(httpValue) : null
    if (target) {
      const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '')
      if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host) || target.username || target.password) throw new Error('httpUrl must be credential-free localhost http://')
    }
    const expectedStatus = Number(args.expectedStatus ?? args.expected_status ?? 200)
    const logText = args.logText || args.log_text
    const timeoutMs = Math.min(120000, Math.max(1000, Number(args.timeoutMs ?? args.timeout_ms) || 30000))
    const started = Date.now()
    const setReadiness = (ready, checking, evidence) => {
      const row = this.record(root, workloadId); row.record.health = checking ? 'checking' : (ready ? 'ready' : 'unhealthy'); row.record.readiness = { ready, checking, checkedAt: now(), evidence }; row.record.updatedAt = now(); writeJson(row.file, row.record); this.notify(row.workspace)
    }
    const baseEvidence = { logText: logText ? false : null, tcpPort: port, httpUrl: target ? `${target.protocol}//${target.host}${target.pathname}` : null, httpStatus: target ? expectedStatus : null }
    setReadiness(false, true, baseEvidence)
    while (Date.now() - started < timeoutMs) {
      if (signal?.aborted) throw signal.reason || new Error('workload_wait aborted')
      const row = this.record(root, workloadId)
      reconcile(row.record, processTable())
      if (!ACTIVE_PHASES.has(row.record.phase)) throw new Error(`workload became ${row.record.phase} before readiness`)
      const logReady = logText ? tail(row.record.run.logPath, 65536).text.includes(String(logText)) : true
      const portReady = port === null ? true : await new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port }); const finish = (value) => { socket.destroy(); resolve(value) }
        socket.setTimeout(1200, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false))
      })
      const httpReady = !target ? true : await new Promise((resolve) => {
        const request = http.get(target, { timeout: 1500 }, (response) => { response.resume(); response.once('end', () => resolve(response.statusCode === expectedStatus)) })
        request.once('timeout', () => request.destroy(new Error('readiness timeout'))); request.once('error', () => resolve(false))
      })
      if (logReady && portReady && httpReady) {
        const evidence = { ...baseEvidence, logText: logText ? true : null }
        setReadiness(true, false, evidence)
        return { workloadId, ready: true, elapsedMs: Date.now() - started, evidence }
      }
      await sleep(250)
    }
    setReadiness(false, false, baseEvidence)
    throw new Error(`workload ${workloadId} did not satisfy readiness within ${timeoutMs}ms`)
  }
}

async function body(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 65536) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
function send(res, status, value, head = false) {
  const text = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(head ? undefined : text)
}
function authorizedWorkspace(ctx, sessionId, requestedCwd) {
  if (!sessionId) throw new Error('sessionId is required')
  const session = ctx.sessions.get(String(sessionId))
  if (!session) throw new Error('session is not live')
  const policy = ctx.sandboxPolicy.resolve({ session })
  const authoritative = canonicalWorkspace(policy.workspaceRoot)
  if (requestedCwd && normalized(String(requestedCwd)) !== normalized(authoritative)) throw new Error('requested cwd does not match the session workspace')
  return { workspace: authoritative, sessionId: String(session.id || sessionId) }
}

export { LocalWorkloadRegistry }

export function apply(ctx, config = {}) {
  const workloads = new LocalWorkloadRegistry({ legacyProcessRoots: config.legacyProcessRoots })
  ctx.provide('workloads', workloads)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: API_PATH,
    async handler(req, res) {
      const head = req.method === 'HEAD'
      try {
        if (req.method === 'GET' || head) {
          const url = new URL(req.url || API_PATH, 'http://localhost')
          const op = url.searchParams.get('op') || 'list'
          const authority = authorizedWorkspace(ctx, url.searchParams.get('sessionId'), url.searchParams.get('cwd'))
          const cwd = authority.workspace
          if (op === 'list') { send(res, 200, { ok: true, value: workloads.list(cwd), observedAt: now() }, head); return }
          if (op === 'logs') { send(res, 200, { ok: true, value: workloads.logs(cwd, url.searchParams.get('workloadId') || '', LOG_READ_LIMIT), observedAt: now() }, head); return }
          send(res, 404, { ok: false, error: 'unknown operation' }, head); return
        }
        if (req.method === 'POST') {
          const input = await body(req)
          const authority = authorizedWorkspace(ctx, input.sessionId, input.cwd)
          const cwd = authority.workspace
          const control = { source: 'web', sessionId: authority.sessionId }
          if (input.op === 'stop') { send(res, 200, { ok: true, value: await workloads.stop(cwd, String(input.workloadId || ''), control) }); return }
          if (input.op === 'restart') { send(res, 200, { ok: true, value: await workloads.restart(cwd, String(input.workloadId || ''), control) }); return }
          if (input.op === 'stopAll') { send(res, 200, { ok: true, value: await workloads.stopAll(cwd, control) }); return }
          send(res, 404, { ok: false, error: 'unknown operation' }); return
        }
        send(res, 405, { ok: false, error: 'method not allowed' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(res, 400, { ok: false, error: redact(message).slice(0, 500) })
      }
    },
  }), 'dsh-workloads: web API')
}
