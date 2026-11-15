import { executeModuleEntryFile } from '@kody-internal/shared/execute-module.ts'
import { executeParityCases } from '@kody-internal/shared/execute-parity.fixture.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	createAdHocExecuteSourceFiles,
	runBundledModuleWithRegistry,
} from '#mcp/run-kody-registry.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

const userId = ownerIdFromStored('user-execute-parity')
const caller = createMcpCallerContext({
	source: { kind: 'mcp-oauth' },
	baseUrl: 'https://kody.dev',
	user: {
		userId: personIdFromStored('user-execute-parity'),
		email: 'parity@example.com',
		displayName: 'Execute Parity',
	},
})

async function runOnCloud(code: string, params?: Record<string, unknown>) {
	try {
		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles: await createAdHocExecuteSourceFiles(code),
			entryPoint: executeModuleEntryFile,
		})
		return await runBundledModuleWithRegistry(env, caller, bundle, params, {
			skipCapabilityRegistry: true,
		})
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) }
	}
}

for (const parity of executeParityCases) {
	test(`Kody cloud parity: ${parity.name}`, { timeout: 60_000 }, async () => {
		silenceIncidentalRuntimeWarnings()
		const outcome = (await runOnCloud(parity.code, parity.params)) as {
			result?: unknown
			error?: unknown
			logs?: Array<string>
		}
		if ('errorIncludes' in parity.expected) {
			expect(String(outcome.error)).toContain(parity.expected.errorIncludes)
			return
		}
		expect(outcome.error).toBeUndefined()
		expect(outcome.result).toEqual(parity.expected.result)
		for (const line of parity.expected.logs ?? []) {
			expect(outcome.logs).toContain(line)
		}
	})
}
