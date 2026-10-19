# kody Cloud Agent Guide

A full-stack web application built on Cloudflare Workers with a TanStack Start
web UI. Remix serves the HTTP API layer and optional package apps.

## Quick Reference

| Task                          | Command                |
| ----------------------------- | ---------------------- |
| Start or reuse dev server     | `npm run dev:ensure`   |
| Full validation               | `npm run validate`     |
| Compose Cloud Agent git hooks | `npm run hooks:ensure` |
| Apply formatter / lint        | `npm run validate:fix` |
| Lint                          | `npm run lint`         |
| Format                        | `npm run format`       |
| Type check                    | `npm run typecheck`    |
| Build                         | `npm run build`        |
| E2E tests                     | `npm run test:e2e:run` |

`npm run validate` is the single authoritative local gate. CI runs the same
checks as parallel jobs (including separate 🧪 Node and ☁️ Workers unit jobs),
so a green local `validate` means CI will pass. `validate` is read-only; use
`npm run validate:fix` when you want auto-fixes applied.

## Services

- **Dev server**: `npm run dev:ensure` reuses or starts the origin and prints
  `App running at http://localhost:<port>` once `/health` is ok (default 3742;
  the CLI hops if that port is taken by a non-kody process)
- `npm run dev` starts Vite so origin SSR and the client hydrate in one workerd
  graph, and stays attached for an interactive session

## Architecture

- **Server**: Cloudflare Workers (see `packages/worker/src/`)
- **Client**: TanStack Start components bundled with Vite (see
  `packages/worker/client/` and `packages/worker/start/`)
- **Database**: Cloudflare D1 (SQLite, auto-handled locally by Wrangler)
- **MCP Server**: Available at `/mcp` endpoint when worker runs

## Documentation

- [AGENTS.md](../AGENTS.md) - Agent instructions and verification steps
- [docs/contributing/remix.md](../docs/contributing/remix.md) - Remix HTTP and
  package-app guidance (installed `node_modules/remix` docs are canonical for
  framework APIs)
- [docs/contributing/setup/](../docs/contributing/setup/index.md) - Setup
  documentation
- [docs/contributing/cloud-agents.md](../docs/contributing/cloud-agents.md) —
  Cloud Agent VM gotchas (canonical; this file is a quick reference). Headless
  prefer-local uses `KODY_API_TOKEN`; interactive agents prefer `kody login`.
- Local CLI execute: [guide](../docs/guides/local-execute.md)
  (`guide:local_execute`) and
  [prefer-local-cli-execute](../.agents/skills/prefer-local-cli-execute/SKILL.md)
- [docs/contributing/testing-principles.md](../docs/contributing/testing-principles.md) -
  Testing guidelines
- [docs/contributing/end-to-end-testing.md](../docs/contributing/end-to-end-testing.md) -
  E2E testing guide
