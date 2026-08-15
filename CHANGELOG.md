# Changelog

## 0.3.0 - 2026-08-15

- 运行中心 UI 优化：Workload 卡片的「停止」按钮不再依赖 `capabilities.stop`，任何阶段都可手动停止；新增「全部关闭」按钮（仅在有运行中服务时显示，需二次点击确认）。
- Host 新增 `stopAll(workspaceRoot, control?)`：按顺序停止全部 active Workload，返回逐项结果（`requested/stopped/results`）；Web API 新增 `op=stopAll`（POST）。
- Agent 工具新增 `workload_stop_all` 与 `proc_stop_all` 兼容别名。
- 修复 stop() 使用陈旧进程表缓存的 bug：`start()->list()` 可能在 child 启动前缓存进程快照（TTL 750ms），导致整个 start→wait→stopAll 流程命中该快照，stop() 误判“进程已不存在”而不杀进程树，进而造成端口占用、restart 失败与临时目录清理失败。现在 stop() 强制刷新进程表后再做身份校验。
- 修复 stop() 在 Windows 进程表查询失败（返回空表）时误判“进程已消失”的 bug：空表视为“仍存活”，保证总会升级到强制终止。
- 测试：registry-smoke 与 tool-adapter-smoke 新增 stopAll 覆盖；临时目录清理等待 detached runner 释放句柄并使用重试（`maxRetries/retryDelay`），消除 Windows EPERM。

## 0.2.0 - 2026-08-14

- Declared an installable DSH profile bundle through `dsh.bundle.patch`.
- Added a bundle patch that mounts the shared Host Registry and Runtime Center with legacy migration disabled by default.
- Added package exports/files metadata and a bundle manifest smoke test.
- Prepared public GitHub discovery and installation documentation.

## 0.1.0 - 2026-08-14

- Added the Host-owned `workloads` registry and Windows local-process provider.
- Added stable workload IDs with per-run IDs and generations.
- Added persistent phase, health, readiness, audit metadata, and rotated logs.
- Added workspace/session authorization for the Web API.
- Added Runtime Center aggregation of Session Jobs and Workspace Workloads.
- Added `workload_*` Agent tools and optional `proc_*` compatibility aliases.
- Added optional migration from legacy workspace-hashed process record roots.
- Added lifecycle, migration, tool adapter, Client Slot, and redaction smoke tests.
