import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

/**
 * Regression coverage for sandbox console capture: user modules are loaded via
 * `import("./main.js")`, so a lexical `const console` in `evaluate()` cannot
 * shadow the free `console` binding those modules resolve. Capture patches
 * `globalThis.console` once per isolate and routes each call's logs through
 * AsyncLocalStorage (like fetch), so reused dynamic workers never write into
 * another run's `__logs`, even when runs overlap.
 */

const reuseEnv = {
	...env,
	APP_COMMIT_SHA: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
} as Env

function createCaller(userId: string) {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.dev',
		user: {
			userId: personIdFromStored(userId),
			email: `${userId}@example.com`,
			displayName: 'Console Capture',
		},
	})
}

async function bundleLines(runEnv: Env, userId: string, lines: Array<string>) {
	return await buildKodyModuleBundle({
		env: runEnv,
		baseUrl: 'https://kody.dev',
		userId,
		sourceFiles: { 'entry.ts': lines.join('\n') },
		entryPoint: 'entry.ts',
	})
}

async function runBundle(
	runEnv: Env,
	userId: string,
	bundle: Awaited<ReturnType<typeof bundleLines>>,
	additionalTools?: Record<string, () => Promise<unknown>>,
) {
	return await runBundledModuleWithRegistry(
		runEnv,
		createCaller(userId),
		bundle,
		undefined,
		{
			skipCapabilityRegistry: true,
			...(additionalTools ? { additionalTools } : {}),
		},
	)
}

test(
	'console capture contract: levels on success, capture through throw, and unshimmed methods',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = ownerIdFromStored('user-console-capture-contract')
		const cases = [
			{
				label: 'log/warn/error levels are captured with the correct prefix',
				lines: [
					"\tconsole.log('alpha')",
					"\tconsole.log('beta')",
					"\tconsole.warn('heads up')",
					"\tconsole.error('boom line')",
					"\treturn 'ok'",
				],
				expected: {
					error: undefined,
					result: 'ok',
					logs: ['alpha', 'beta', '[warn] heads up', '[error] boom line'],
				},
			},
			{
				label: 'logs emitted before a throw are still captured',
				lines: [
					"\tconsole.log('before throw')",
					"\tconsole.warn('about to fail')",
					"\tthrow new Error('sandbox boom')",
				],
				expected: {
					error: 'sandbox boom',
					result: undefined,
					logs: ['before throw', '[warn] about to fail'],
				},
			},
			{
				// Unshimmed console methods (table, dir, count, time, …) do not
				// throw; only console.log output is included in the captured logs.
				label: 'unshimmed console methods',
				lines: [
					"\tconsole.log('before table')",
					'\tconsole.table({ ok: true })',
					'\tconsole.dir({ ok: true })',
					"\tconsole.count('label')",
					"\tconsole.countReset('label')",
					"\tconsole.time('t')",
					"\tconsole.timeEnd('t')",
					"\treturn 'ok'",
				],
				expected: { error: undefined, result: 'ok', logs: ['before table'] },
			},
		]
		for (const { label, lines, expected } of cases) {
			const bundle = await bundleLines(env, userId, [
				'export default async function main() {',
				...lines,
				'}',
			])
			const run = await runBundle(env, userId, bundle)
			expect({
				label,
				error: run.error,
				result: run.result,
				logs: run.logs,
			}).toEqual({ label, ...expected })
		}
	},
)

test(
	'reused dynamic workers capture only the current run logs',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = ownerIdFromStored('user-console-capture-reuse')
		// Identical code + modules + acting user => same dynamic-worker id.
		// Per-run labels arrive through RPC dispatchers, not baked code.
		const bundle = await bundleLines(reuseEnv, userId, [
			"import { kody } from 'kody:runtime'",
			'export default async function main() {',
			'\tconst { label } = await kody.ping_capability({})',
			'\tconsole.log(label)',
			'\tconsole.log(`${label}-tail`)',
			'\treturn label',
			'}',
		])
		for (const label of ['first-run', 'second-run']) {
			const run = await runBundle(reuseEnv, userId, bundle, {
				ping_capability: async () => ({ label }),
			})
			expect(run.error).toBeUndefined()
			expect(run.logs).toEqual([label, `${label}-tail`])
		}
	},
)

test(
	'overlapping runs on one dynamic worker capture only their own logs',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = ownerIdFromStored('user-console-capture-overlap')
		// Same code + acting user => same dynamic-worker id for every run.
		const bundle = await bundleLines(reuseEnv, userId, [
			"import { kody } from 'kody:runtime'",
			'export default async function main() {',
			'\tconst { label } = await kody.ping_capability({})',
			'\tconsole.log(`${label}-before`)',
			'\tawait kody.rendezvous_capability({})',
			'\tconsole.warn(`${label}-after`)',
			'\treturn label',
			'}',
		])
		// Both runs log once, then wait until the other has logged too, so
		// each run's second log happens while the other run is still active.
		let arrivals = 0
		let releaseBoth!: () => void
		const bothArrived = new Promise<void>((resolve) => {
			releaseBoth = resolve
		})
		const runOverlapping = (label: string) =>
			runBundle(reuseEnv, userId, bundle, {
				ping_capability: async () => ({ label }),
				rendezvous_capability: async () => {
					arrivals += 1
					if (arrivals === 2) releaseBoth()
					await bothArrived
					return {}
				},
			})
		const [first, second] = await Promise.all([
			runOverlapping('first'),
			runOverlapping('second'),
		])
		expect(
			[first, second].map(({ error, result, logs }) => ({
				error,
				result,
				logs,
			})),
		).toEqual([
			{
				error: undefined,
				result: 'first',
				logs: ['first-before', '[warn] first-after'],
			},
			{
				error: undefined,
				result: 'second',
				logs: ['second-before', '[warn] second-after'],
			},
		])

		for (const label of ['third', 'fourth']) {
			const run = await runBundle(reuseEnv, userId, bundle, {
				ping_capability: async () => ({ label }),
				rendezvous_capability: async () => ({}),
			})
			expect({ error: run.error, logs: run.logs }).toEqual({
				error: undefined,
				logs: [`${label}-before`, `[warn] ${label}-after`],
			})
		}
	},
)

test(
	'console overwrites from one run do not leak into the next run on a reused worker',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = ownerIdFromStored('user-console-capture-overwrite')
		const bundle = await bundleLines(reuseEnv, userId, [
			"import { kody } from 'kody:runtime'",
			'export default async function main() {',
			'\tconst { label, clobber } = await kody.ping_capability({})',
			'\tconsole.log(label)',
			"\tif (clobber === 'method') console.log = () => {}",
			"\tif (clobber === 'object') globalThis.console = { log() {}, warn() {} }",
			'\treturn label',
			'}',
		])
		const runs = []
		for (const [label, clobber] of [
			['clobber-method', 'method'],
			['after-method', null],
			['clobber-object', 'object'],
			['after-object', null],
		] as const) {
			const run = await runBundle(reuseEnv, userId, bundle, {
				ping_capability: async () => ({ label, clobber }),
			})
			runs.push({ error: run.error, logs: run.logs })
		}
		expect(runs).toEqual([
			{ error: undefined, logs: ['clobber-method'] },
			{ error: undefined, logs: ['after-method'] },
			{ error: undefined, logs: ['clobber-object'] },
			{ error: undefined, logs: ['after-object'] },
		])
	},
)
