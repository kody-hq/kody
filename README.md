<div align="center">
  <img src="./packages/worker/public/logo.png" alt="kody logo" width="400" />

  <p>
    <strong>Your agents' cloud: the memory, keys, code, and automations your AI agent keeps, portable across every MCP host. Built on Cloudflare Workers.</strong>
  </p>

  <p>
    <a href="https://github.com/kody-hq/kody/actions/workflows/deploy.yml"><img src="https://img.shields.io/github/actions/workflow/status/kody-hq/kody/deploy.yml?branch=main&style=flat-square&logo=github&label=CI" alt="Build Status" /></a>
    <a href="https://kcd.im/kody-discord"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Join the Discord" /></a>
    <img src="https://img.shields.io/badge/TypeScript-6.0-blue?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Node-26-5FA04E?style=flat-square&logo=node.js&logoColor=white" alt="Node 26" />
    <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
    <img src="https://img.shields.io/badge/TanStack_Start-FF5E00?style=flat-square" alt="TanStack Start" />
  </p>
</div>

---

Kody is Your agents' cloud: the memory, keys, code, and automations your AI
agent keeps, portable across every MCP host. Built on Cloudflare Workers and the
Model Context Protocol (MCP), it ships a TanStack Start website, Worker-based
request routing, package runtime plumbing, and OAuth-protected MCP endpoints.
The project favors a compact MCP surface with powerful `search` and Code Mode
`execute` flows over a large static tool catalog.

Kody works for individuals and teams (orgs, teams, grants): each account holds
isolated packages, jobs, credentials, memories, and related state. Tests and
fixtures may seed deterministic local accounts, but no account is privileged at
runtime. The repo follows several
[epicflare](https://github.com/epicweb-dev/epicflare) starter conventions.

The repo is organized as an Nx monorepo, with shared modules in
`packages/shared` (`@kody-internal/shared`), the origin app worker under
`packages/worker`, sibling workers under `packages/platform-worker`,
`packages/runtime-worker`, and `packages/jobs-worker`, and mock Workers under
`packages/mock-servers/*`. Production topology lives in
[`docs/contributing/architecture/index.md`](./docs/contributing/architecture/index.md).

## Quick Start

```bash
npm install
npm run dev
```

The dev server runs at `localhost:3742` by default (the CLI picks the next free
port and prints the resolved URL). Wrangler handles the local Cloudflare Workers
runtime and D1 database automatically.

To scaffold a **new** project from the epicflare template instead, run
`npx create-epicflare`.

See
[`docs/contributing/getting-started.md`](./docs/contributing/getting-started.md)
for the full setup paths and expectations. Contributors and agents should start
with [`AGENTS.md`](./AGENTS.md) for repo-specific guidance.

If you are trying to understand what this repository is for, start with
[`docs/contributing/project-intent.md`](./docs/contributing/project-intent.md).

## Tech Stack

| Layer           | Technology                                                                               |
| --------------- | ---------------------------------------------------------------------------------------- |
| Runtime         | [Cloudflare Workers](https://workers.cloudflare.com/)                                    |
| UI Framework    | [TanStack Start](https://tanstack.com/start)                                             |
| Package Manager | [npm](https://www.npmjs.com/)                                                            |
| Workspace       | [Nx](https://nx.dev/) + npm workspaces                                                   |
| Database        | [Cloudflare D1](https://developers.cloudflare.com/d1/)                                   |
| Session/OAuth   | [Cloudflare KV](https://developers.cloudflare.com/kv/)                                   |
| MCP State       | [Durable Objects](https://developers.cloudflare.com/durable-objects/) on `kody-platform` |
| E2E Testing     | [Playwright](https://playwright.dev/)                                                    |
| Bundler         | [Vite](https://vite.dev/)                                                                |

## Scope

- Fair Source platform for individuals and teams, not a general-purpose agent
  harness
- MCP-first architecture intended to work across compatible AI agent hosts
- Compact MCP surface area preferred over a large static tool inventory
- ChatGPT is a likely primary host target, while keeping the server usable from
  other MCP hosts where practical

## How It Works

```
kody.codes  → kody-production (origin: TanStack Start, /mcp HTTP, OAuth, email, queues)
                 ├─→ kody-platform  (MCP / mailbox / meter / repo-session DOs)
                 ├─→ kody-runtime   (package apps, invoke API, StorageRunner)
                 └─→ kody-jobs      (cron + JobManager; calls back via JobsHost)

kody.run    → kody-runtime (package-app zone routes)
```

- `packages/worker/src/index.ts` is the origin entrypoint; platform, runtime,
  and jobs have sibling entrypoints (see
  [architecture](./docs/contributing/architecture/index.md#production-worker-fleet))
- OAuth requests are handled first, then MCP requests, then static assets
- Webhook ingress (including GET subscription challenges) is handled in the
  Worker `fetch` path before TanStack Start
- Remaining website requests go through TanStack Start
  (`packages/worker/start/http-entry.ts`)
- Client assets are bundled into `packages/worker/public/` and served via the
  `ASSETS` binding

## Documentation

| Document                                                                                     | Description                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------ |
| [`docs/contributing/getting-started.md`](./docs/contributing/getting-started.md)             | Setup, environment variables, deploy |
| [`docs/contributing/environment-variables.md`](./docs/contributing/environment-variables.md) | Adding new env vars                  |
| [`docs/contributing/cloudflare-offerings.md`](./docs/contributing/cloudflare-offerings.md)   | Optional Cloudflare integrations     |
| [`docs/contributing/project-intent.md`](./docs/contributing/project-intent.md)               | Scope, goals, and non-goals          |
| [`docs/contributing/index.md`](./docs/contributing/index.md)                                 | Developing and extending Kody        |
| [`docs/use/index.md`](./docs/use/index.md)                                                   | Using Kody over MCP                  |
| [`docs/contributing/setup/`](./docs/contributing/setup/index.md)                             | Local development and verification   |

## Contributing

Outside pull requests to this repository need a signed inbound
[Contributor License Agreement](./docs/contributing/inbound-contributions.md).
Public packages do not use that CLA.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) and
[`docs/contributing/index.md`](./docs/contributing/index.md).

## License

Kody is licensed under the
[Functional Source License, Version 1.1, ALv2 Future License](./LICENSE)
([FSL-1.1-ALv2](https://fsl.software/)). You can use, copy, modify, create
derivative works from, publicly perform, publicly display, and redistribute the
software for any purpose other than Competing Use. Competing Use means making
the software available to others in a commercial product or service that
substitutes for Kody, substitutes for another product or service the licensor
offers using Kody that existed when the version was made available, or offers
the same or substantially similar functionality. Each version becomes available
under the Apache License 2.0 on the second anniversary of the date that version
was made available.

Public packages published through Kody do not use this repository's CLA and have
no license gate; that is separate from this repository's license.

---

<div align="center">
  <sub>Built with ❤️ by <a href="https://epicweb.dev">Epic Web</a></sub>
</div>
