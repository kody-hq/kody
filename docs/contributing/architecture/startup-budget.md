# Worker startup budget

Cloudflare validates every Worker upload against a fixed startup CPU limit: the
time spent evaluating the main module (parse, compile, and every top-level
statement) must stay under the platform ceiling or the upload is rejected with
`Script startup exceeded CPU time limit`. The check runs on Cloudflare's
validation hosts, so a script that sits near the ceiling can pass on one upload
and fail on the next.

This document records what counts toward startup, how to measure it, the rules
that keep it low, and the CI tripwire that stops regressions.

## What counts

Module evaluation of the startup entry
(`packages/worker/src/production-worker.ts`, `platform-worker.ts`,
`runtime-worker.ts`) and everything it imports statically. Production and
preview deploy the same slim origin entry. The full `index.ts` entry (dev/test)
also evaluates every Durable Object class and reads roughly 1.8× the slim entry,
so that entry is not what preview uploads. The expensive items on an eager
startup path are, in order:

- Zod schema construction at module scope. Every capability definition builds
  its input and output schemas when its module evaluates; the MCP server SDK
  builds wire schemas for each protocol revision the same way.
- Third-party libraries with large top-level tables: `isomorphic-git`,
  `@babel/parser`, `tldts`, `@tanstack/markdown`.
- Anything that touches ICU at module scope (`new Intl.NumberFormat(...)`).
- Statically imported WebAssembly modules (compiled at load).

Request-time work is not part of the budget. Cloudflare measures module
evaluation of the uploaded main module. An in-repo dynamic `import()` can defer
that evaluation: capability domains stay in the same bundle and run on the first
request that needs the registry (rule 1).

A dynamic `import()` of an npm package is inlined into the Wrangler main module,
so that source is parsed during startup. A bare import of
`@cloudflare/worker-bundler` is also evaluated on every cold start
(`packages/worker/src/worker-bundler-modules.ts`). Bytes still count when a
wrapper only defers evaluation (`packages/worker/src/isomorphic-git-load.ts`).

To keep a heavy library off the main module, prebuild it to
`packages/worker/src/node_modules/.kody-generated/*.mjs`
(`tools/build-worker-bundler-modules.ts`) and list that filename in the
`find_additional_modules` ESModule rule. The `node_modules/` prefix is
load-bearing: Wrangler's walker discovers the file under `src/`, and its
directory watcher skips `node_modules` (Friction #1789). A `../` specifier from
`repo/` inlines the module. Origin Vite builds are the exception in rule 1: they
emit `import()` targets as hashed SSR chunks.

## Measuring

Profile a worker with Wrangler's built-in startup profiler from the package
directory that owns its config:

```bash
# Origin: profile the Vite-built slim entry (same artifact production uploads).
KODY_WRANGLER_CONFIG=packages/worker/wrangler.jsonc npx vite build
npx wrangler check startup --config dist/ssr/wrangler.json
cd packages/platform-worker && npx wrangler check startup
cd packages/runtime-worker && npx wrangler check startup
```

The summary prints `Active: N ms` (sampled CPU during evaluation, including
garbage collection) and writes a `.cpuprofile` that Chrome DevTools or VS Code
can open as a flamegraph. Absolute numbers are machine-specific; compare before
and after on the same machine.

`wrangler check startup` profiles the multipart bundle from an inner
`wrangler deploy --dry-run --outfile`. Pass `--workerBundle` (alias `--worker`)
only with that same `--outfile` form-data file. An extracted `.js` is not a
worker bundle: Wrangler reads the path as multipart form data.

To attribute time to source files, inspect the Vite origin source map at
`dist/ssr/index.js.map` (or a Wrangler `--dry-run --outdir` map for platform and
runtime). A frame with no ancestor in `packages/` is third-party module
initialisation hoisted to the bundle's top level; walk to the nearest
non-library caller to find which of our modules imported it.

## Rules

1. **Capability domains load lazily.**
   `packages/worker/src/mcp/capabilities/builtin-domains.ts` loads each
   `{domain}/domain.ts` through dynamic `import()` and `getStaticRegistry()` is
   async. Direct Wrangler/esbuild worker builds keep that code in the same
   bundle and wrap those modules so they evaluate on the first request that
   needs the registry. Origin Vite builds emit those `import()` targets as
   hashed SSR chunks under `dist/ssr`. Never import a `*/domain.ts` or a
   capability definition module statically from anything on the startup path;
   one static edge makes the Wrangler/esbuild path evaluate the module eagerly
   again. That lazy wrap is for these in-repo domain modules. An npm package
   follows the additional-module rule in [What counts](#what-counts). Shared
   helpers (`{domain}/shared.ts`) are the supported static entry points, so keep
   them light: helpers, not schema catalogs.
2. **Heavy libraries load on first use.** `isomorphic-git` goes through
   `packages/worker/src/isomorphic-git-load.ts` (re-exported as
   `repo/isomorphic-git-lazy.ts`), including platform `RepoSession`. That helper
   loads the pre-bundled `isomorphic-git.mjs` additional module (not a bare
   `import('isomorphic-git')`, which Wrangler would inline into the main byte
   graph). The MCP server SDK goes through `loadMcpServerModule()` in
   `packages/worker/src/mcp/protocol-metrics.ts` and the lazy stateless-lane /
   legacy-lane loaders in `mcp-auth.ts` and `origin-handler.ts`. The platform
   worker is the exception: the `MCP` Durable Object class extends the agents
   SDK base class at module scope, so that worker carries the SDK cost by
   design.
3. **No module-scope formatters or wasm on the startup path.** Build `Intl.*`
   objects on first use (see `universal/dynamic-worker-cost.ts`). Keep
   WebAssembly imports inside modules that are only reached lazily.
4. **New capability schemas belong in capability files**, which are lazy, not in
   modules the app handlers import.
5. **Keep Zod English-only on the Worker graph.** `import { z } from 'zod'`
   re-exports every file under `zod/v4/locales` unless the locales barrel is
   trimmed. `patches/zod+4.6.6.patch` keeps only `en` (already applied by Zod's
   classic entry). Do not import other locale modules on the startup path; when
   bumping Zod, refresh that patch.
6. **Keep Zod `compile` off the Worker graph.** Zod 4.6+ re-exports `compile`
   (and `fromJSONSchema` / `deepPartial`) through the classic and mini barrels
   onto the `z` / `z.core` namespace. That forces `compile.js` into every Worker
   main even when nothing calls it. The same patch strips those barrel exports.
   Do not call `z.compile()` on the module-scope capability schema path
   (`new Function`, extra construction). Keep using ordinary schema parse.
7. **Defer isomorphic-git as an additional module.** `loadIsomorphicGit()` in
   `packages/worker/src/isomorphic-git-load.ts` imports
   `node_modules/.kody-generated/isomorphic-git.mjs` (built by
   `tools/build-worker-bundler-modules.ts`), not a bare
   `import('isomorphic-git')`. Wrangler inlines bare dynamic imports into the
   main byte graph; the generated specifier must stay
   `./node_modules/.kody-generated/…` relative to `packages/worker/src` (a `../`
   path from `repo/` inlines the module). Same pattern as oauth-provider and
   local-execute-runtime-support. postal-mime (`postal-mime-load.ts`) and
   codemode's acorn-backed `normalizeCode` (`codemode-normalize-load.ts`) use
   the same lane. `patches/acorn+8.17.0.patch` marks acorn side-effect free so
   esbuild drops it once `normalizeCode` is off the graph; refresh that patch
   when codemode bumps acorn.
8. **Type deferred packages with `typeof import(...)` queries.** esbuild walks
   `import type` and `import { type … }` edges into Wrangler main, and keeps the
   target package's side-effecting module code. The lint autofix rewrites
   `import type` to the inline form. Export the types from the loader as type
   queries instead (see `postal-mime-load.ts`). The same trap applies to in-repo
   modules: a type-only import of a module whose top level builds something
   heavy (for example a validator instance) still evaluates it at startup, so
   keep such modules free of top-level work.

## CI tripwire

`npm run worker-startup-time:check` (`tools/check-worker-startup-time.ts`, the
serial tail of `npm run validate` and a dedicated CI static step) profiles each
production entry three times with `wrangler check startup` and compares the best
sample to `tools/worker-startup-budget.json`. Local validate runs this after the
parallel jobs so sampled CPU is not inflated by e2e and Worker builds. Budgets
sit well above the steady-state reading and well below the level that made
uploads flaky, so the check catches a re-eagerised domain graph or a new heavy
import without failing on runner noise. It complements
`worker-startup-bundles:check`, which measures bytes and enforces import-graph
boundaries deterministically. Byte ceilings live in
`tools/worker-startup-bundle-budget.json`. Append measured notes to
`tools/worker-startup-bundle-notes.md` instead of rewriting the checker.

`patches/wrangler+<version>.patch` raises Wrangler's hard-coded 10s
`STARTUP_PROFILE_TIMEOUT_MS` to 60s. That timer covers Miniflare boot, and the
origin snapshot (~1,500 modules) takes ~20s to boot on a 4-vCPU GitHub-hosted
runner before any sampled CPU is measured. The budget still compares active CPU,
so the longer boot allowance does not loosen it. Refresh the patch when bumping
Wrangler.

Byte overages against the reviewed ceiling **warn and open/update a GitHub
issue** on main CI (`Startup budget overage: <worker>`, marker
`<!-- kody-startup-bundle-overage:<worker> -->`, `friction` label). They do
**not** fail 🧹 Static / ✅ Validate or block 🚀 Deploy. Deferred-source and
additional-module regressions still fail hard. Shrink the graph when you can;
raise the committed budget (with a notes ledger entry) when the growth is
intentional.

When a change buys headroom, lower the budget in the same PR.

## Reference readings

Best-of-three readings with capability domains and heavy libraries on first use.
The GitHub-hosted runner reads roughly 1.6× the local development VM, and the
budgets are set against the runner (about 1.5× its steady reading), so a local
run has more headroom than CI does.

| Worker   | Local  | CI     | Budget |
| -------- | ------ | ------ | ------ |
| origin   | 110 ms | 186 ms | 280 ms |
| platform | 166 ms | 228 ms | 340 ms |
| runtime  | 70 ms  | 102 ms | 160 ms |

An origin entry that evaluates those libraries at module scope reads roughly 500
ms on the runner, which is the regime in which Cloudflare uploads fail
intermittently.
