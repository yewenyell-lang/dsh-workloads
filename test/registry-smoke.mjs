import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workloads-smoke-'))
const workspace = path.join(temp, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
process.env.DSH_HOME = path.join(temp, 'dsh-home')
const canonicalWorkspace = fs.realpathSync.native(workspace)
const hash = crypto.createHash('sha256').update(canonicalWorkspace.replace(/[\\/]+$/, '').toLowerCase()).digest('hex').slice(0, 20)
const legacyRoot = path.join(temp, 'legacy-processes')
const legacyDir = path.join(legacyRoot, hash)
fs.mkdirSync(legacyDir, { recursive: true })
const legacyLog = path.join(legacyDir, 'legacy.log')
fs.writeFileSync(legacyLog, 'legacy output\n')
fs.writeFileSync(path.join(legacyDir, 'legacy-job.json'), JSON.stringify({ jobId:'legacy-job', name:'legacy:1', status:'stopped', cwd:workspace, command:'node legacy.js', logPath:legacyLog, createdAt:new Date().toISOString(), readiness:{ready:true,checking:false,checkedAt:new Date().toISOString(),evidence:{logText:true,tcpPort:null,httpUrl:null,httpStatus:null}} }, null, 2))

const { LocalWorkloadRegistry } = await import(pathToFileURL(path.join(here, '..', 'lib', 'index.js')).href + '?smoke=' + Date.now())
const registry = new LocalWorkloadRegistry({ legacyProcessRoots: [legacyRoot] })
const migrated = registry.list(workspace)
if (migrated.workloads.length !== 1 || !migrated.workloads[0].legacy) throw new Error('legacy migration failed')
let port = 43100
while (port < 43200) {
  const free = await new Promise((resolve) => { const s=net.createServer(); s.once('error',()=>resolve(false)); s.listen(port,'127.0.0.1',()=>s.close(()=>resolve(true))) })
  if (free) break
  port += 1
}
const node = process.execPath
const server = path.join(here, 'smoke-server.mjs')
const command = `"${node}" "${server}" ${port}`
let started
try {
  started = await registry.start(workspace, { command, label:`smoke:${port}` })
  if (started.phase !== 'running' || started.generation !== 1) throw new Error('start state invalid')
  const ready = await registry.wait(workspace, started.workloadId, { log_text:`READY ${port}`, port, http_url:`http://127.0.0.1:${port}/health`, expected_status:200, timeout_ms:15000 })
  if (!ready.ready) throw new Error('readiness failed')
  const logs = registry.logs(workspace, started.workloadId, 32768)
  if (!logs.log.includes('[REDACTED]') || logs.log.includes('smoke-only-value')) throw new Error('log redaction failed')
  const restarted = await registry.restart(workspace, started.workloadId)
  if (restarted.workloadId !== started.workloadId || restarted.runId === started.runId || restarted.generation !== 2) throw new Error('restart identity failed')
  await registry.wait(workspace, started.workloadId, { port, timeout_ms:15000 })
  const stopped = await registry.stop(workspace, started.workloadId)
  if (stopped.phase !== 'stopped') throw new Error('stop failed')
  console.log(JSON.stringify({ migrated:migrated.workloads.length, workloadId:started.workloadId, firstRunId:started.runId, secondRunId:restarted.runId, generation:restarted.generation, redacted:true, stopped:stopped.phase }, null, 2))
} finally {
  if (started) { try { await registry.stop(workspace, started.workloadId) } catch {} }
  fs.rmSync(temp, { recursive:true, force:true })
}
