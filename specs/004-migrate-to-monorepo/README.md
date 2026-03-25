---
status: complete
created: 2026-02-23
priority: high
tags:
- monorepo
- turborepo
- pnpm
- restructure
created_at: 2026-02-23T02:16:53.482087Z
updated_at: 2026-02-23T05:23:22.097832Z
completed_at: 2026-02-23T05:23:22.097832Z
transitions:
- status: in-progress
  at: 2026-02-23T03:23:51.244743Z
- status: complete
  at: 2026-02-23T05:23:22.097832Z
---

# Migrate To Monorepo

> **Status**: complete · **Priority**: high · **Created**: 2026-02-23  
> **North Star**: Restructure telegramable from a single-package Node app into a pnpm + Turborepo monorepo that hosts the backend and future frontend packages side-by-side.

## Overview

telegramable currently lives as a single `package.json` at the repo root with all backend source code under `src/`. Spec 003 (UI Framework Setup) already designs a monorepo layout with `apps/web` and `packages/ui`, but the structural migration has not been done.

This spec captures the work to:
1. Convert the repo root into a pnpm workspace managed by Turborepo.
2. Move the existing backend into `apps/api/`.
3. Establish the shared `packages/` directory for future cross-app code.
4. Keep CI/CD, Docker, and existing tests working throughout.

Doing this migration as a dedicated step (before 003) avoids interleaving structural rewrites with feature work.

## Design

### Target layout

```
telegramable/
├── apps/
│   └── api/                  # current src/ backend (Fastify/telegramable core)
│       ├── src/
│       ├── tests/
│       ├── Dockerfile
│       └── package.json
├── packages/
│   └── tsconfig/             # shared TypeScript base configs
│       └── package.json
├── package.json              # workspace root (no src, dev tooling only)
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.json             # repo-root base, extended by each package
```

> `apps/web` and `packages/ui` are **not** part of this spec — they are created in spec 003.

### Key decisions

| Decision             | Choice              | Rationale                               |
| -------------------- | ------------------- | --------------------------------------- |
| Workspace manager    | pnpm workspaces     | already used in repo                    |
| Build orchestration  | Turborepo           | spec 003 already plans `turbo.json`     |
| Backend package name | `@telegramable/api`      | namespaced for future cross-referencing |
| Shared tsconfig      | `packages/tsconfig` | single source for compiler options      |

### `pnpm-workspace.yaml`

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

### Root `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "dev":   { "persistent": true, "cache": false },
    "test":  { "dependsOn": ["^build"] },
    "lint":  {}
  }
}
```

### `apps/api/package.json` changes
- `name`: `@telegramable/api`
- scripts stay the same (`build`, `dev`, `start`, `test`)
- Dependencies move from root `package.json` to `apps/api/package.json`
- Root `package.json` keeps only workspace-level dev deps (turbo, typescript, etc.)

## Plan

- [x] Install Turborepo as a root dev dependency (`pnpm add -Dw turbo`)
- [x] Create `pnpm-workspace.yaml` at repo root
- [x] Create `turbo.json` with `build`, `dev`, `test`, `lint` tasks
- [x] Create `apps/api/` directory structure and move `src/`, `tests/` into it
- [x] Move `Dockerfile` into `apps/api/`
- [x] Create `apps/api/package.json` (name `@telegramable/api`, copy relevant deps from root)
- [x] Create `apps/api/tsconfig.json` extending root config
- [x] Update root `package.json`: remove moved deps, add workspace scripts delegating to turbo
- [x] Create `packages/tsconfig/` with base `tsconfig.json` and `package.json`
- [x] Update all import paths and build output references if changed
- [x] Verify `pnpm install` resolves workspace correctly
- [x] Verify `pnpm -F @telegramable/api test` runs existing tests green
- [x] Update Dockerfile `COPY` / `WORKDIR` paths for new layout
- [x] Update CI workflow (if any) to use `turbo run build test` (no applicable CI workflow changes required)

## Test

- [x] `pnpm install` succeeds with no duplicate lockfile conflicts
- [x] `pnpm turbo run build` builds `apps/api` without errors
- [x] `pnpm turbo run test` passes all existing tests in `apps/api/tests/`
- [x] `docker build` succeeds using the updated `apps/api/Dockerfile`
- [x] No TypeScript errors across the workspace (`pnpm turbo run lint` or `tsc --noEmit`)
- [x] `apps/` and `packages/` directories are ready for spec 003 work

## Notes

- This spec is a **prerequisite** for spec 003 (UI Framework Setup) and spec 002 (Runtime Config Web UI).
- Keep the migration atomic: land it as a single PR so all subsequent feature branches start from the new layout.
- Consider squash-merging to keep git history clean.
- The `packages/tsconfig` package avoids duplicating `compilerOptions` across `apps/`.
