# DSH Workloads

[English](README.md) | [简体中文](README.zh-CN.md)

为 DeepSeek Harness 提供工作区级持久进程托管、就绪检测与运行中心，同时保持 DSH Session Job 与 Workspace Workload 的生命周期边界。

> 当前状态：可安装的公开 profile bundle，首个 Provider 为 Windows local-process，已在 DSH `0.1.0-rc.6` 验证；Service/API 契约仍处于 1.0 之前。

## 为什么 Workload 不是 Job

| | DSH Job | DSH Workload |
|---|---|---|
| Owner | Agent/Session | 规范化 Workspace |
| 生命周期 | 有界后台操作 | 长期运行服务 |
| Owner 销毁 | 自动取消 | 保持运行，显式停止 |
| 存储 | 内存 Registry | 持久记录和轮转日志 |
| 重启身份 | 新 Job | 稳定 `workloadId`，新 `runId/generation` |
| 就绪判断 | 由生产者决定 | 日志/TCP/localhost HTTP 证据 |

Workload 适合 dev server、watcher、调试器、代理、本地中间件和长期事件消费者；构建、测试、安装等有界操作仍应使用 DSH Job。

## 包入口

- `.`：Host 插件，提供 `ctx.workloads`、local-process Provider 和 Session 授权 Web API；
- `./client`：在 `conversation.view` 注册“运行中心”；
- `./tools`：Agent preset 可选消费者，提供六个 `workload_*` 工具和可关闭的 `proc_*` 兼容别名；
- `./cordis.patch.yml`：DSH profile bundle patch。

## Host Service

Host 插件提供进程级共享 `ctx.workloads`：

```text
list(workspaceRoot, options)
start(workspaceRoot, spec, existing?, control?)
wait(workspaceRoot, workloadId, readiness, signal?)
logs(workspaceRoot, workloadId, maxBytes?)
stop(workspaceRoot, workloadId, control?)
stopAll(workspaceRoot, control?)
restart(workspaceRoot, workloadId, control?)
subscribe(listener)
```

数据保存在业务仓库之外：

```text
${DSH_HOME}/runtime/workloads/<canonical-workspace-sha256-prefix>/
```

每个 Workload 有稳定 `workloadId`；每次启动或重启创建新的 `runId` 并增加 `generation`。生命周期 `phase` 与就绪状态 `health` 分离。Detached runner 每次写元数据前检查 `currentRunId`，避免旧 generation 覆盖重启后的新状态。

## Workspace 授权

浏览器会携带当前 `sessionId`，但浏览器和模型都不能决定权威工作区。Host 按以下链路解析：

```text
sessions.get(sessionId)
→ sandboxPolicy.resolve({ session })
→ canonical workspaceRoot
```

请求 cwd 与权威 workspaceRoot 不一致时拒绝。Agent tools 同样从 `exec.agent.session` 推导边界。

## 运行中心

Client 注册 session-scope `conversation.view` 条目 `runtime-center`：

- Session Jobs 直接读取 `jobsBySession[sessionId]`，不轮询 Job；
- Workspace Workloads 使用 Session 授权的三秒完整快照；
- 相同 cwd 的对话共享 Workload，Session Job 仍彼此隔离；
- 展示 phase、health、PID、run identity、readiness 和最多 32 KiB 的日志尾部；
- 每个 Workload 卡片的「停止」按钮任何阶段都可用（对已终止服务是幂等操作），「重启」保持原行为；
- 「工作区长期服务」区块头部提供「全部关闭」，仅在有运行中服务时显示，与 stop/restart 一样需要二次点击，并在 Host 重新鉴权。

未来 DSH 原生版本应以 `apiProxy` domain 和 Client snapshot mirror 替代 Workload 轮询。

## 安装

将已标记版本安装到 Web profile：

```powershell
dsh plugin --profile web add github:yewenyell-lang/dsh-workloads#v0.3.0
```

包声明了 `dsh.bundle.patch`，`dsh plugin` 会自动把它加入 `dsh.profile.bundles`。安装后重启已有 DSH Web 进程并刷新浏览器。

不启动新服务器即可检查 composition：

```powershell
dsh --profile web --dump-config
```

卸载：

```powershell
dsh plugin --profile web remove dsh-workloads-local-ui1
```

只在需要控制 Workload 的 Agent preset 中加入工具消费者：

```yaml
- id: tool-workloads
  name: dsh-workloads-local-ui1/tools
  config:
    enableProcAliases: true
```

Registry 必须位于 Host plane；preset 只消费共享 `workloads` Service，不能在 preset 中重新提供或隔离它。

## Agent 工具

```text
workload_list
workload_start
workload_wait
workload_logs
workload_stop
workload_stop_all
workload_restart
```

设置 `enableProcAliases: false` 可关闭七个旧 `proc_*` 兼容别名（含 `proc_stop_all`）。

## local-process 安全边界

- 命令必须为单行；明显密码、Token、JWT、Bearer、URL 凭据、Redis 密码和连接串形态会被拒绝；
- cwd 必须位于规范化 Workspace 内；
- 不接受额外环境变量表；runner/child 会移除 `DSH_*` 和常见凭据变量；
- readiness 仅允许固定日志文本、`127.0.0.1` TCP 和无凭据的 localhost `http://` URL；
- Windows 进程表不可用或 PID 创建时间不匹配时 fail closed；
- 先尝试进程树优雅停止，超过 grace period 后才强制结束；
- API/Tool 读取会遮蔽常见凭据形态，但应用仍可能输出未知秘密格式，调用方应只读取必要日志尾部。

## 可选旧记录迁移

`legacyProcessRoots` 接受绝对目录；其子目录是旧的 workspace hash，记录采用早期 `jobId/status/logPath` 结构。迁移默认关闭，启用后只复制、不删除、按目标 Workspace 幂等，并标记 `migratedFrom: legacy-process-v1`。源码不编译任何产品、preset、用户或机器路径。

## 开发与验证

```powershell
npm run check
npm test
npm pack --dry-run
```

测试使用临时 `DSH_HOME` 和 Workspace，覆盖 Client 注册、bundle manifest、旧记录迁移、启动、组合 readiness、日志遮蔽、稳定重启身份、stop、审计元数据、六个 Workload 工具、可选别名和清理。

## 已知限制

1. 当前只支持一个 DSH Host 管理同一 `DSH_HOME`；多 Host 共享需要存储 CAS/lease fencing；
2. Web carrier 仍是精确 Session 授权路由，上游方案应改为 typed `apiProxy` domain；
3. Workload 快照目前每三秒轮询，未来应监听 Host 事件并在 `connection/reset` 后重同步；
4. local-process Provider 仅支持 Windows；PM2、Docker Compose、systemd、SSH、Kubernetes 应作为独立 Provider；
5. 稳定 1.0 前仍需正式 Service Definition、Provider 注册、`attachController()`、desired state 和 reconciliation lease。

## License

MIT
