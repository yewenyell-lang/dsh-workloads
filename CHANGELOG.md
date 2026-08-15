# Changelog

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
