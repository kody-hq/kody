import { resolve } from 'node:path'
import { availableParallelism } from 'node:os'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineProject, mergeConfig } from 'vitest/config'
import {
	rootDir,
	sharedProjectConfig,
	sharedTestExclude,
} from './vitest-shared.ts'

// The pool restarts a Wrangler config read per test file, and each read logs
// "Using secrets defined in packages/worker/.env" at the default log level.
process.env.WRANGLER_LOG ??= 'warn'

// Workers-unit gets one 40s test/hook budget everywhere (CI, validate, local)
// instead of the shared 20s: the pool's per-file DO cold load already takes
// ~10s, and under validate's parallel gate cold RPCs stretched past 20s
// (#2939). One budget means a passing validate run and CI's Workers job
// verify the same budget, so each shard's Nx `test-workers` hash can ignore
// `KODY_VALIDATE_LOAD`. Shards and full runs have distinct hashes. The flag (set on
// validate's test-workers leg only) now only lowers maxWorkers so the suite
// shares the box with Playwright and the Wrangler servers. Kept here — not in
// sharedProjectConfig — so node-unit / mcp-e2e keep the 20s budget. Does not
// change production startup CPU budgets.
const underValidateLoad =
	process.env.KODY_VALIDATE_LOAD === '1' ||
	process.env.KODY_VALIDATE_LOAD === 'true'
const workersTestTimeout = 40_000
const workersMaxWorkers = process.env.CI
	? Math.min(underValidateLoad ? 2 : 3, availableParallelism())
	: undefined

export default mergeConfig(
	sharedProjectConfig,
	defineProject({
		plugins: [
			cloudflareTest({
				remoteBindings: false,
				wrangler: {
					configPath: resolve(rootDir, 'packages/worker/wrangler.jsonc'),
					environment: 'test',
				},
				miniflare: {
					// Schema for tests that seed real rows (users, orgs, credentials):
					// `applyD1Migrations(env.APP_DB, env.TEST_MIGRATIONS)`.
					bindings: {
						TEST_MIGRATIONS: await readD1Migrations(
							resolve(rootDir, 'packages/worker/migrations'),
						),
						TEST_AUDIT_MIGRATIONS: await readD1Migrations(
							resolve(rootDir, 'packages/worker/audit-migrations'),
						),
						// Beat packages/worker/.env: wrangler loads that file as
						// secrets and can override env.test's SENTRY_ENVIRONMENT
						// (and inject a real SENTRY_DSN). mergeWorkerOptions applies
						// these bindings last so deliberate test faults never ingest.
						SENTRY_DSN: '',
						SENTRY_ENVIRONMENT: 'test',
					},
					// The test env's JOBS and HIGHLIGHT service bindings target
					// sibling workers that local `wrangler dev` runs alongside
					// the main worker. The pool only loads the main config, so
					// auxiliary workers (bundled by the global setups below)
					// serve those contracts.
					workers: [
						{
							name: 'kody-jobs-test',
							modules: true,
							scriptPath: resolve(rootDir, '.tmp/jobs-test-service/index.mjs'),
							compatibilityDate: '2025-06-01',
							d1Databases: ['JOBS_DB'],
						},
						{
							name: 'kody-highlight-test',
							modules: true,
							scriptPath: resolve(
								rootDir,
								'.tmp/highlight-test-service/index.mjs',
							),
							compatibilityDate: '2025-06-01',
						},
					],
				},
			}),
		],
		test: {
			name: 'workers-unit',
			include: ['**/*.workers.test.ts'],
			exclude: [...sharedTestExclude],
			testTimeout: workersTestTimeout,
			hookTimeout: workersTestTimeout,
			maxWorkers: workersMaxWorkers,
			globalSetup: [resolve(rootDir, 'tools/vitest-global-setup-workers.ts')],
		},
	}),
)
