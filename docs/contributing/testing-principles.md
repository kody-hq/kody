# Testing principles

Durable rules: [Test the workflow](../principles/test-the-workflow.md) and
[No invasive test-only code](../principles/no-invasive-test-only-code.md). This
page is how to choose a flavor and run suites in this repo.

## Test flavor decision matrix

Choose the lightest flavor that can falsify the behavior. Filename suffixes pick
the Vitest project (`vitest.config.ts`):

| Flavor / command                                                                    | Use when                                                                                                                                                                                                                                                                                                        | Avoid when                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*.node.test.ts` (`npm run test:node` / node-unit; also in `npm run test`)          | Pure server logic, pure functions, handlers/services that can run against an in-memory `node:sqlite` D1 facade (`createD1FromSqlite` in `packages/worker/src/test-support/`), or code that is correctly covered by spies/stubs (for example `vi.spyOn` on `recordUsage`). Fast feedback; no Workers runtime.    | The assertion needs real Cloudflare bindings (`env.APP_DB`, KV, DO, R2) or Workers-only APIs that the node stubs do not honestly exercise.                                                                                                         |
| `*.workers.test.ts` (`npm run test:workers` / workers-unit; also in `npm run test`) | The behavior depends on real local bindings from `cloudflare:workers` / the Vitest Workers pool (D1 schema + queries, KV reads/writes, DO stubs as configured). Prefer shared explicit-import factories from `packages/worker/src/test-support/` and domain `test-schema.ts` helpers over copy-pasted seed SQL. | The file never reads `env` / bindings and only tests pure registry or string logic — prefer `*.node.test.ts` instead (several `src/mcp/**` workers suites are historical misclassifications; leave them unless you are already editing that area). |
| `*.mcp-e2e.test.ts` (`npm run test:mcp`)                                            | A tiny smoke suite for the real MCP HTTP transport, OAuth, and package-app session wiring.                                                                                                                                                                                                                      | Capability-by-capability coverage that does not need that transport — put those beside the implementation as node or workers tests.                                                                                                                |
| Playwright (`npm run test:e2e:run`)                                                 | A very small number of user-critical happy-path journeys through the worker + client. See [end-to-end testing](./end-to-end-testing.md).                                                                                                                                                                        | Edge cases, copy pinning, or anything a faster unit/integration test can cover.                                                                                                                                                                    |

**Usage metering example** (lifted from
[usage metering](./architecture/usage-metering.md)): in `*.node.test.ts`, spy on
`recordUsage` and assert call shape for success and failure paths. In
`*.workers.test.ts` with a real local D1, call `ensureUsageRollupsTestSchema`
from `packages/worker/src/usage/test-schema.ts` and assert on `usage_rollups`
rows instead of spying.

Shared test helpers live under `packages/worker/src/test-support/`. Import
factories explicitly inside each test (or a per-test factory). Do not introduce
`beforeEach` hooks that hide setup. See
[Test the workflow](../principles/test-the-workflow.md).

## Running one file

Vitest project configs live at the repo root. `vitest.config.ts` lists
`vitest.node.config.ts`, `vitest.workers.config.ts`, and
`vitest.mcp-e2e.config.ts`. Nx targets in `packages/worker/project.json` run
`vitest run` with the repo root as the working directory. `npm run test`,
`npm run test:node`, and `npm run test:workers` call those targets through
`tools/run-nx.ts`. A focused run uses that same directory, the project that
matches the filename suffix, and a repo-relative path:

```sh
npx vitest run --project node-unit packages/worker/universal/compute-overage.node.test.ts
npx vitest run --project workers-unit packages/worker/src/billing/credit-wallet.workers.test.ts
npx vitest run --project mcp-e2e packages/worker/src/mcp/mcp-server.mcp-e2e.test.ts
```

| Suffix              | `--project`    |
| ------------------- | -------------- |
| `*.node.test.ts`    | `node-unit`    |
| `*.workers.test.ts` | `workers-unit` |
| `*.mcp-e2e.test.ts` | `mcp-e2e`      |

The shell's working directory is the repo root. Vitest resolves the root
config's `projects` entries against the current directory. A command started in
`packages/worker` with a package-relative path exits before any test runs:

```text
Projects definition references a non-existing file or a directory: <cwd>/vitest.node.config.ts
```

The path in that message is the current directory joined with
`vitest.node.config.ts`. The config files are at the repo root. Re-run from the
repo root with the repo-relative path above. The same `--project` names cover
other packages that share the root projects, for example
`npx vitest run --project node-unit packages/api-worker`.

## Suite mechanics

- Run full server/unit suites with `npm run test`. For one Vitest file, use the
  repo-root command in [Running one file](#running-one-file), which selects
  `node-unit`, `workers-unit`, or `mcp-e2e` from the filename suffix. Playwright
  specs stay on `npm run test:e2e:run`.
- Workers-unit harness rules (see
  [decision 0011](./decisions/0011-workers-unit-pool-harness.md)):
  - **Prefer `*.node.test.ts`** unless the assertion needs real Cloudflare
    bindings or Workers-only APIs (`@cloudflare/worker-bundler`, DO RPC, etc.).
  - **Do not** warm Durable Objects from `globalSetup` (Node-only) or from
    workers-unit `setupFiles` (breaks webhook / scheduled / `packageSave`
    suites).
  - **Do not** use `--no-isolate` / shared storage to chase suite wall clock.
    Per-file isolation stays; disabling it breaks suites that assume a clean
    store.
  - **Do not** stub away DOs in workers tests when binding fidelity is the
    point, and do not “fix” pool slowness with `--no-verify` or a shorter local
    `testTimeout`. Shared `testTimeout` is 20s so the pool’s ~10s first DO RPC
    in a file does not fail the default budget; workers-unit alone uses 40s
    everywhere (CI, validate, local) so one budget covers load-induced stretch
    and cached results use the same budget CI enforces. Full and sharded Workers
    runs have separate Nx cache keys. Full `npm run validate` sets
    `KODY_VALIDATE_LOAD=1` on `test:workers`, which only lowers `maxWorkers` to
    2; node-unit keeps the shared 20s budget. That flag does not loosen
    production startup CPU budgets. On a machine with at most 4 cores, or under
    24GB of RAM, the gate also runs one suite leg at a time (#3147).
  - Pool cold load is inherent today; suite wall clock will not match production
    RPC latency until the upstream pool improves.
- Vitest is configured with `clearMocks` and `mockReset` globally
  (`vitest-shared.ts`). Each test starts with a clean mock slate; inline the
  setup a test needs rather than relying on leftover state from a prior case.
  Keep explicit mid-test resets only when one workflow test runs multiple
  scenarios in a single `test(...)`.
- Console output is guarded globally
  (`packages/worker/src/test-support/console-spies.ts`, wired via `setupFiles`):
  unexpected `console.error`/`console.warn` calls fail the test, and
  `console.info`/`console.debug` are silenced. Never silence blindly — a blanket
  `.mockImplementation(() => {})` can hide a real regression. Instead:
  - When the log is part of the tested contract, import the exported
    `consoleError`/`consoleWarn` spies, call `.mockImplementation(() => {})`,
    and assert on the calls (prefer the stable first-argument tag plus
    `expect.any(Error)`; do not pin long prose). Assert the call count too when
    it is deterministic.
  - When the log is incidental to the behavior under test, use
    `silenceExpectedConsoleWarns([...])` / `silenceExpectedConsoleErrors([...])`
    (same module) with the exact expected message tags, or
    `silenceIncidentalRuntimeWarnings()`
    (`packages/worker/src/test-support/incidental-runtime-warnings.ts`) for the
    bundler/registry-runtime noise set. Anything outside the allowlist still
    fails the test.
  - Workerd logs Durable Object / WorkerEntrypoint RPC rejections as
    `uncaught exception` even when the caller catches them. Do not filter those
    dumps — a real isolate crash must stay visible. Prevent the RPC throw
    instead: fail closed in the sandbox or host tool before the gateway/DO call
    (outbound fetch, package-storage access), and when a test must exercise an
    in-object abort, call the method inside `runInDurableObject` rather than
    across the test RPC stub.

  Keep test output free of stray logging.

- The audit-log sink is mocked globally for `node-unit` tests
  (`packages/worker/src/test-support/audit-log-spy.ts`, wired via the project's
  `setupFiles`): import `logAuditEventSpy` and assert the audit events a handler
  is expected to emit (and `not.toHaveBeenCalled()` where none are). Tests that
  exercise the real audit pipeline opt out with
  `vi.unmock('#worker/audit-log.ts')`; tests that need to override other exports
  (e.g. `getRequestIp`) declare their own `vi.mock('#worker/audit-log.ts', ...)`
  and route `logAuditEvent` back through the shared spy.

## Examples

### `Symbol.dispose` with `using`

```ts
import { writeFile, readFile, rm } from 'node:fs/promises'
import { test, expect } from 'vitest'

const createTempFile = async () => {
	const path = `/tmp/test-${crypto.randomUUID()}.txt`
	await writeFile(path, 'hello')

	return {
		path,
		[Symbol.asyncDispose]: async () => {
			await rm(path, { force: true }).catch(() => {
				// Cleanup should never fail the test.
			})
		},
	}
}

test('reads a temp file', async () => {
	await using tempFile = await createTempFile()
	const contents = await readFile(tempFile.path, 'utf8')
	expect(contents).toBe('hello')
})
```

### `Symbol.asyncDispose` with `await using`

```ts
import { createServer } from 'node:http'
import { test, expect } from 'vitest'

const createDisposableServer = async () => {
	const server = createServer((_request, response) => {
		response.end('ok')
	})
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const address = server.address()
	if (!address || typeof address === 'string') {
		throw new Error('Failed to resolve test server port')
	}

	return {
		url: `http://localhost:${address.port}`,
		[Symbol.asyncDispose]: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error)
					else resolve()
				})
			})
		},
	}
}

test('fetches from a disposable server', async () => {
	await using server = await createDisposableServer()
	const response = await fetch(server.url)
	expect(await response.text()).toBe('ok')
})
```
