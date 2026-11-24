import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { beforeEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import * as packageRepo from '#worker/package-registry/repo.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

// Runs resolve each run package's app location; this D1 has no saved
// package rows.
beforeEach(() => {
	vi.spyOn(packageRepo, 'listSavedPackagesByIdsInAnyOrg').mockResolvedValue([])
})

/**
 * Regression coverage for the production "RPC stub used after being
 * disposed" failures (communityPublish / communitySearch / repo publish
 * capabilities intermittently failing on repeated calls).
 *
 * Execute uses a stable dynamic-worker id for a hashable module graph, so two
 * executes with identical code reuse one sandbox isolate — and the isolate's
 * ES module cache survives between them. The `kody:runtime` virtual module
 * used to freeze the first run's `kody` capability proxy into module scope;
 * that proxy closes over the first `evaluate()` call's RPC ToolDispatcher
 * stubs, which workerd implicitly disposes when that call returns. Every
 * later execute with the same code (including from a brand-new conversation)
 * then called capabilities through disposed stubs.
 *
 * Reuse no longer depends on `APP_COMMIT_SHA`. This suite still pins one so
 * the fixture matches deployed env shape; the regression is the stale
 * dispatcher stubs on a reused isolate.
 */

const reuseEnv = {
	...env,
	APP_COMMIT_SHA: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
} as Env

function createCaller() {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.dev',
		user: {
			userId: personIdFromStored('user-reuse-test'),
			email: 'reuse@example.com',
			displayName: 'Reuse Test',
		},
	})
}

async function bundleEntry(lines: Array<string>) {
	// The bundler and registry runtime emit known incidental warnings; only
	// those are swallowed, anything else still fails the test.
	silenceIncidentalRuntimeWarnings()
	return await buildKodyModuleBundle({
		env: reuseEnv,
		baseUrl: 'https://kody.dev',
		userId: ownerIdFromStored('user-reuse-test'),
		sourceFiles: { 'entry.ts': lines.join('\n') },
		entryPoint: 'entry.ts',
	})
}

async function runBundle(
	bundle: Awaited<ReturnType<typeof bundleEntry>>,
	params: Record<string, unknown> | undefined,
	options: {
		pingLabel?: string
		packageContext?: { packageId: string; kodyId: string }
	} = {},
) {
	const { pingLabel, packageContext } = options
	const run = await runBundledModuleWithRegistry(
		reuseEnv,
		// A fresh caller context per call models fresh MCP tool calls —
		// including calls issued with brand-new conversation ids, which
		// still hashed to the same cached dynamic worker in production.
		createCaller(),
		{ mainModule: bundle.mainModule, modules: bundle.modules },
		params,
		{
			skipCapabilityRegistry: true,
			...(packageContext ? { packageContext } : {}),
			...(pingLabel
				? {
						additionalTools: {
							ping_capability: async (args: unknown) => ({
								ok: true,
								label: pingLabel,
								args,
							}),
						},
					}
				: {}),
		},
	)
	expect(run.error).toBeUndefined()
	return run.result
}

test(
	'sequential executes with identical code reuse the dynamic worker without stale dispatcher stubs',
	{ timeout: 60_000 },
	async () => {
		const bundle = await bundleEntry([
			"import { kody } from 'kody:runtime'",
			'export default async function main() {',
			"\treturn await kody.ping_capability({ query: 'slack' })",
			'}',
		])

		// Before the kody:runtime late-binding fix the second run failed with
		// "RPC stub used after being disposed.": the reused isolate's cached
		// runtime module still pointed at the first run's dispatcher stubs.
		for (const pingLabel of ['first', 'second', 'third']) {
			expect(await runBundle(bundle, undefined, { pingLabel })).toEqual({
				ok: true,
				label: pingLabel,
				args: { query: 'slack' },
			})
		}
	},
)

test(
	'sequential executes with the same code and different params reuse the isolate and deliver params',
	{ timeout: 60_000 },
	async () => {
		const bundle = await bundleEntry([
			"import { kody, packageContext, packageSecrets } from 'kody:runtime'",
			'export default async function main(params) {',
			'\treturn {',
			'\t\tparams,',
			'\t\tpackageId: packageContext?.packageId ?? null,',
			'\t\tsecretsBound: "get" in packageSecrets,',
			'\t\tping: await kody.ping_capability({ query: params.room }),',
			'\t}',
			'}',
		])

		const runs = [
			{ pingLabel: 'first', room: 'office' },
			{ pingLabel: 'second', room: 'kitchen' },
			{
				pingLabel: 'third',
				room: 'office',
				packageContext: { packageId: 'pkg-reuse', kodyId: 'bot-reuse' },
			},
		]
		for (const { room, ...options } of runs) {
			expect(await runBundle(bundle, { room }, options)).toEqual({
				params: { room },
				packageId: options.packageContext?.packageId ?? null,
				secretsBound: Boolean(options.packageContext),
				ping: { ok: true, label: options.pingLabel, args: { query: room } },
			})
		}
	},
)

test(
	'module-scope packageContext capture still late-binds across evaluate reuse',
	{ timeout: 60_000 },
	async () => {
		const bundle = await bundleEntry([
			"import { packageContext } from 'kody:runtime'",
			'const capturedContext = packageContext',
			'export default async function main() {',
			'\treturn { packageId: capturedContext?.packageId ?? null }',
			'}',
		])

		for (const [packageId, kodyId] of [
			['pkg-a', 'bot-a'],
			['pkg-b', 'bot-b'],
		] as const) {
			expect(
				await runBundle(bundle, undefined, {
					packageContext: { packageId, kodyId },
				}),
			).toEqual({ packageId })
		}
	},
)

test(
	'mutating packageContext.packageId cannot retarget unstamped packageSecrets',
	{ timeout: 60_000 },
	async () => {
		const bundle = await bundleEntry([
			"import { packageContext, packageSecrets } from 'kody:runtime'",
			'export default async function main() {',
			'\tlet mutationError = null',
			'\ttry {',
			"\t\tpackageContext.packageId = 'pkg-attacker'",
			'\t} catch (error) {',
			'\t\tmutationError = error instanceof Error ? error.message : String(error)',
			'\t}',
			'\treturn {',
			'\t\tpackageId: packageContext?.packageId ?? null,',
			'\t\tsecretsBound: "get" in packageSecrets,',
			'\t\tmutationError,',
			'\t}',
			'}',
		])

		expect(
			await runBundle(bundle, undefined, {
				packageContext: { packageId: 'pkg-trusted', kodyId: 'bot-trusted' },
			}),
		).toEqual({
			packageId: 'pkg-trusted',
			secretsBound: true,
			mutationError: expect.stringMatching(
				/trap returned falsish|cannot assign|read.only|frozen/i,
			),
		})
	},
)
