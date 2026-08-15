import path from 'node:path'

function rootFromExec(ctx, exec) {
  const session = exec?.agent?.session
  if (!session) throw new Error('workload tools require a live agent session')
  const policy = ctx.sandboxPolicy.resolve({ session })
  if (!policy.workspaceRoot || !path.isAbsolute(policy.workspaceRoot)) throw new Error('workload tools require an absolute workspace root')
  return policy.workspaceRoot
}
function controlFromExec(exec) {
  return { source: 'tool', sessionId: String(exec?.agent?.session?.id || exec?.agent?.id || 'agent') }
}
function find(ctx, root, args) {
  const rows = ctx.workloads.list(root).workloads
  if (args.workload_id || args.job_id) {
    const id = String(args.workload_id || args.job_id)
    const row = rows.find((item) => item.workloadId === id)
    if (!row) throw new Error(`workload not found: ${id}`)
    return row
  }
  const query = String(args.query || '').trim().toLowerCase()
  if (!query) throw new Error('workload_id is required when query is omitted')
  const matches = rows.filter((item) => item.label.toLowerCase().includes(query) || item.workloadId.toLowerCase().includes(query))
  if (matches.length !== 1) throw new Error(`query must match exactly one workload; matched ${matches.length}`)
  return matches[0]
}
function stringTool(ctx, name, description, parameters, handler) {
  ctx.tools.register({
    name, description, parameters,
    output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: value }] } },
    async execute(args, exec) { return handler(args || {}, exec) },
  })
}
function json(value) { return JSON.stringify(value, null, 2) }

export const name = 'dsh-tool-workloads'
export const inject = ['tools', 'systemPrompt', 'workloads', 'sandboxPolicy']

export function apply(ctx, config = {}) {
  ctx.systemPrompt.context({
    name: 'dsh:workspace-workloads', order: 118,
    text(context) {
      const session = context.agent?.session
      if (!session) return ''
      try {
        const root = ctx.sandboxPolicy.resolve({ session }).workspaceRoot
        const active = ctx.workloads.list(root, { activeOnly: true }).workloads
        return active.length ? [
          'Active workspace-owned DSH Workloads. Reuse them across same-cwd conversations; call workload_list before starting duplicates:',
          ...active.map((item) => `- ${item.label} | workloadId=${item.workloadId} | phase=${item.phase} | health=${item.health} | pid=${item.pid || 'unknown'}`),
        ].join('\n') : ''
      } catch { return '' }
    },
  })

  const listParams = { type: 'object', additionalProperties: false, properties: { active_only: { type: 'boolean', description: 'Only starting/running/stopping Workloads.' } } }
  const startParams = { type: 'object', additionalProperties: false, required: ['command'], properties: {
    command: { type: 'string', description: 'Complete single-line command without embedded passwords, tokens, or connection strings.' },
    label: { type: 'string', description: 'Stable friendly label; network services should use <service>:<port>.' },
    name: { type: 'string', description: 'Compatibility alias for label.' },
    cwd: { type: 'string', description: 'Relative or absolute directory inside the current workspace.' },
    shell: { type: 'boolean', description: 'Enable only when shell syntax is required.' },
    shell_type: { type: 'string', enum: ['pwsh', 'cmd'], description: 'Windows shell when shell=true.' },
  } }
  const idParams = { type: 'object', additionalProperties: false, properties: {
    workload_id: { type: 'string', description: 'Stable workloadId returned by workload_start.' },
    job_id: { type: 'string', description: 'Legacy proc_* alias for workload_id.' },
    query: { type: 'string', description: 'Unique label or workloadId query; explicit ID is preferred.' },
  } }
  const logsParams = { ...idParams, properties: { ...idParams.properties, max_bytes: { type: 'integer', description: 'Tail bytes, clamped to 1024-32768.' } } }
  const waitParams = { ...idParams, properties: { ...idParams.properties,
    log_text: { type: 'string', description: 'Fixed text required in the log tail.' }, port: { type: 'integer', description: '127.0.0.1 TCP port.' },
    http_url: { type: 'string', description: 'Credential-free localhost http:// readiness URL.' }, expected_status: { type: 'integer', description: 'Expected HTTP status, default 200.' },
    timeout_ms: { type: 'integer', description: '1000-120000ms, default 30000ms.' },
  } }

  const list = async (args, exec) => ctx.workloads.list(rootFromExec(ctx, exec), { activeOnly: args.active_only === true })
  const start = async (args, exec) => ctx.workloads.start(rootFromExec(ctx, exec), args, null, controlFromExec(exec))
  const logs = async (args, exec) => { const root = rootFromExec(ctx, exec); const row = find(ctx, root, args); return ctx.workloads.logs(root, row.workloadId, args.max_bytes) }
  const wait = async (args, exec) => { const root = rootFromExec(ctx, exec); const row = find(ctx, root, args); return ctx.workloads.wait(root, row.workloadId, args, exec.signal) }
  const stop = async (args, exec) => { const root = rootFromExec(ctx, exec); const row = find(ctx, root, args); return ctx.workloads.stop(root, row.workloadId, controlFromExec(exec)) }
  const stopAll = async (args, exec) => ctx.workloads.stopAll(rootFromExec(ctx, exec), controlFromExec(exec))
  const restart = async (args, exec) => { const root = rootFromExec(ctx, exec); const row = find(ctx, root, args); return ctx.workloads.restart(root, row.workloadId, controlFromExec(exec)) }

  stringTool(ctx, 'workload_list', 'List persistent long-running Workloads in the current DSH workspace. Call before start, restart, or stop.', listParams, async (a,e)=>json(await list(a,e)))
  stringTool(ctx, 'workload_start', 'Start a workspace-owned Workload that can survive session changes and be reconciled after DSH restarts. Use for dev servers, watchers, debuggers, proxies, and local middleware; use Jobs for bounded commands.', startParams, async (a,e)=>json(await start(a,e)))
  stringTool(ctx, 'workload_logs', 'Read the current Workload run log tail with common credential shapes redacted.', logsParams, async (a,e)=>json(await logs(a,e)))
  stringTool(ctx, 'workload_wait', 'Wait for fixed log text, local TCP, and/or localhost HTTP readiness, then persist health evidence.', waitParams, async (a,e)=>json(await wait(a,e)))
  stringTool(ctx, 'workload_stop', 'Explicitly stop a workspace Workload after workspace and process-identity verification, escalating only after a grace period.', idParams, async (a,e)=>json(await stop(a,e)))
  stringTool(ctx, 'workload_stop_all', 'Stop every active Workload in the current DSH workspace. Returns per-workload results.', { type: 'object', additionalProperties: false, properties: {} }, async (a,e)=>json(await stopAll(a,e)))
  stringTool(ctx, 'workload_restart', 'Keep the stable workloadId while creating a new generation and runId after fully stopping the current run.', idParams, async (a,e)=>json(await restart(a,e)))

  if (config.enableProcAliases !== false) {
    stringTool(ctx, 'proc_list', 'Legacy alias for workload_list.', listParams, async (a,e)=>json(await list(a,e)))
    stringTool(ctx, 'proc_start', 'Legacy alias for workload_start.', startParams, async (a,e)=>json(await start(a,e)))
    stringTool(ctx, 'proc_logs', 'Legacy alias for workload_logs; job_id accepts a workloadId.', logsParams, async (a,e)=>json(await logs(a,e)))
    stringTool(ctx, 'proc_wait', 'Legacy alias for workload_wait; job_id accepts a workloadId.', waitParams, async (a,e)=>json(await wait(a,e)))
    stringTool(ctx, 'proc_stop', 'Legacy alias for workload_stop; job_id accepts a workloadId.', idParams, async (a,e)=>json(await stop(a,e)))
    stringTool(ctx, 'proc_stop_all', 'Legacy alias for workload_stop_all.', { type: 'object', additionalProperties: false, properties: {} }, async (a,e)=>json(await stopAll(a,e)))
    stringTool(ctx, 'proc_restart', 'Legacy alias for workload_restart; job_id accepts a workloadId.', idParams, async (a,e)=>json(await restart(a,e)))
  }
}
