import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { parseUnboundRuntimeHelperMessage } from '#worker/package-runtime/unbound-runtime-helpers.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

/**
 * Regression coverage for the unbound-helper hint against a REAL
 * `buildKodyModuleBundle` bundle rather than hand-written modules: the
 * bundler inlines the virtual `kody:runtime` module into the entry module,
 * so no `kody:runtime` import statements survive and helpers appear as
 * `var email = __kodyOptionalRuntimeObjectExport("email", null)`
 * declarations. The detector must match that inlined shape, or the hint
 * only ever fires in synthetic tests (as shipped in the first iteration).
 */
test(
	'guard-less unbound runtime helpers in real bundles get the bound-context hint',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		for (const helper of [
			{
				name: 'email',
				userId: 'user-unbound-repro',
				email: 'repro@example.com',
				source: [
					"import { email } from 'kody:runtime'",
					'export default async function main() {',
					"\treturn await email.getMessage('m-1')",
					'}',
				].join('\n'),
				error: "Cannot read properties of null (reading 'getMessage')",
			},
			{
				name: 'packageSecrets',
				userId: 'user-unbound-secrets',
				email: 'secrets@example.com',
				source: [
					"import { packageSecrets } from 'kody:runtime'",
					'export default async function main() {',
					"\treturn await packageSecrets.get('token')",
					'}',
				].join('\n'),
				error:
					'kody:runtime export "packageSecrets" is not available in this execution context.',
			},
		]) {
			const callerContext = createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://kody.dev',
				user: {
					userId: personIdFromStored(helper.userId),
					email: helper.email,
					displayName: helper.name,
				},
			})
			const bundle = await buildKodyModuleBundle({
				env,
				baseUrl: 'https://kody.dev',
				userId: ownerIdFromStored(helper.userId),
				sourceFiles: { 'entry.ts': helper.source },
				entryPoint: 'entry.ts',
			})
			const result = await runBundledModuleWithRegistry(
				env,
				callerContext,
				bundle,
				undefined,
				{ skipCapabilityRegistry: true },
			)
			expect(result.error).toContain(helper.error)
			expect(parseUnboundRuntimeHelperMessage(result.error ?? '')).toBe(
				helper.name,
			)
		}
	},
)
