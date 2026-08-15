# DSH Workloads

[English](README.md) | [简体中文](README.zh-CN.md)

Durable, workspace-owned long-running processes for DeepSeek Harness, plus a Runtime Center that keeps DSH Session Jobs and Workspace Workloads visible without conflating their lifecycles.

> Current status: public installable profile bundle with a Windows local-process Provider, validated against DSH `0.1.0-rc.6`. The Service/API contract remains pre-1.0.

## Why Workloads are not Jobs

| | DSH Job | DSH Workload |
|---|---|---|
| Owner | Agent/Session | Canonical workspace |
| Lifetime | Bounded operation | Long-running service |
| Disposal | Cancel with owner | Explicit stop |
| Storage | In-memory registry | Durable records and logs |
| Restart identity | New Job | Stable `workloadId`, new `runId/generation` |
| Readiness | Producer-specific | Log/TCP/localhost HTTP evidence |

Typical Workloads include dev servers, watchers, debuggers, proxies, local middleware, and long-running event consumers. Builds, tests, installs, and other bounded operations should remain DSH Jobs.

## Package surfaces

- `.` — Host plugin that provides `ctx.workloads`, the local-process provider, and a session-authorized Web API.
- `./client` — Web Client plugin that registers the `运行中心` entry in `conversation.view`.
- `./tools` — opt-in Agent-preset consumer exposing six `workload_*` tools and optional `proc_*` compatibility aliases.

## Host Service

The Host plugin provides one process-wide `ctx.workloads` service:

```text
list(workspaceRoot, options)
start(workspaceRoot, spec, existing?, control?)
wait(workspaceRoot, workloadId, readiness, signal?)
logs(workspaceRoot, workloadId, maxBytes?)
stop(workspaceRoot, workloadId, control?)
restart(workspaceRoot, workloadId, control?)
subscribe(listener)
```

Records are stored outside business repositories:

```text
${DSH_HOME}/runtime/workloads/<canonical-workspace-sha256-prefix>/
```

Each Workload has a stable `workloadId`, a new `runId` and incremented `generation` per start/restart, orthogonal lifecycle `phase` and readiness `health`, process identity, timestamps, last outcome, bounded run history, readiness evidence, action audit metadata, and rotating logs.

The detached runner checks `currentRunId` before each metadata write, preventing a stopped older generation from overwriting a newer restart.

## Workspace authority

Browser calls include the current `sessionId`, but neither the browser nor the model chooses the authoritative workspace boundary. The Host resolves:

```text
sessions.get(sessionId)
→ sandboxPolicy.resolve({ session })
→ canonical workspaceRoot
```

A request whose cwd does not match that root is rejected. Agent tools use the same policy from `exec.agent.session`.

## Runtime Center

The Client registers a session-scoped `conversation.view` entry with ID `runtime-center` and label `运行中心`.

- Session Jobs come directly from `useSessions(state => state.jobsBySession[sessionId])`; they are not polled or copied into a second state owner.
- Workspace Workloads use a session-authorized complete snapshot every three seconds.
- Same-cwd conversations see the same Workloads while retaining separate Session Job lists.
- Readiness, phase, health, PID, run identity, and a redacted 32 KiB log tail are shown.
- Stop and restart require a second click confirmation and are re-authorized on the Host.

A future DSH-native version should replace Workload polling with an `apiProxy` domain and Client snapshot mirror. Session Jobs already use the native push mirror.

## Agent tools

Load `./tools` from an Agent preset to expose:

```text
workload_list
workload_start
workload_wait
workload_logs
workload_stop
workload_restart
```

Set `enableProcAliases: false` to omit the six legacy `proc_*` aliases. The tool layer is a consumer only; it must not publish or isolate the shared Host `workloads` service.

## Install

Install the tagged GitHub package into the Web profile:

```powershell
dsh plugin --profile web add github:yewenyell-lang/dsh-workloads#v0.2.0
```

The package declares `dsh.bundle.patch`, so `dsh plugin` automatically adds it to `dsh.profile.bundles`. Its [`cordis.patch.yml`](cordis.patch.yml) mounts the Host Registry, local-process Provider, Web API, and Runtime Center with legacy migration disabled by default. Restart the existing DSH Web process and refresh the browser after installation.

Verify the composed profile without starting another server:

```powershell
dsh --profile web --dump-config
```

To remove the bundle:

```powershell
dsh plugin --profile web remove dsh-workloads-local-ui1
```

Add the tool consumer only to Agent presets that should control Workloads:

```yaml
- id: tool-workloads
  name: dsh-workloads-local-ui1/tools
  config:
    enableProcAliases: true
```

The Registry belongs in the Host plane because it crosses Sessions. Only the tool consumer belongs in an Agent preset; do not isolate the shared `workloads` service there.

To opt into legacy migration, override the bundle row in the Web profile's later `cordis.patch.yml` layer and restate its complete config:

```yaml
- id: dsh-workloads-local-ui1
  config:
    legacyProcessRoots:
      - C:\\absolute\\legacy-process-root
```

## Local-process safety

- Commands must be one line and are rejected when they contain common password, token, JWT, Bearer, URL-credential, Redis password, or connection-string shapes.
- Requested cwd must stay inside the canonical workspace.
- Extra environment maps are not accepted; runner/child environments remove `DSH_*` and common credential variable names.
- Readiness is restricted to fixed log text, `127.0.0.1` TCP, and credential-free localhost `http://` URLs.
- Stop is fail-closed when the Windows process table is unavailable or PID creation time does not match the recorded run.
- Windows process-tree termination is best effort: graceful `taskkill /T` first, `/F` only after the grace period.
- Unknown application secret formats can still reach local log files. API/tool reads redact common shapes, but callers should request the minimum tail.

## Optional legacy migration

`legacyProcessRoots` accepts absolute directories whose children are workspace-hash directories containing the earlier `jobId/status/logPath` record shape.

Migration is opt-in, copy-only, idempotent per target workspace, non-destructive to sources, and marked with `migratedFrom: legacy-process-v1`. No product-, preset-, user-, or machine-specific migration root is compiled into the package.

## Development

No dependency installation is required for the current source and smoke tests.

```powershell
npm run check
npm test
```

The suite uses temporary `DSH_HOME` and workspace directories and covers Client registration, optional legacy migration, start, combined readiness, redaction, stable restart identity, stop, action audit metadata, six `workload_*` tools, optional aliases, and cleanup.

## Known limitations and roadmap

1. One DSH Host per `DSH_HOME` is the supported coordination model. Shared multi-Host operation needs storage CAS/lease fencing.
2. The current Web carrier is an exact session-authorized route; upstream integration should use a typed `apiProxy` domain/mux.
3. Workload snapshots currently poll every three seconds; a future Client mirror should resync on `connection/reset` and consume Host change events.
4. The local-process provider is Windows-only. PM2, Docker Compose, systemd, SSH, and Kubernetes should be separate Providers behind the same Registry contract.
5. A future Service Definition package should formalize types, Provider registration, `attachController()`, desired state, and reconciliation leases before a stable 1.0 release.

## License

MIT
