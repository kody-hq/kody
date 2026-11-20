import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	createExecuteExecutor,
	getExecutionErrorDetails,
} from '#mcp/executor.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

/**
 * Agents must use `import { kody } from 'kody:runtime'`. The evaluate-scope
 * provider used to be `const kody`, which one-file snippets (empty module
 * graph, user code inlined into `evaluate()`) could read without that import.
 * Module executes already failed bare `kody`; this suite pins both paths.
 */

const userId = ownerIdFromStored('user-evaluate-kody-binding')

function createCaller() {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.dev',
		user: {
			userId: personIdFromStored('user-evaluate-kody-binding'),
			email: 'binding@example.com',
			displayName: 'Binding Test',
		},
	})
}

async function bundle(source: string) {
	return await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId,
		sourceFiles: { 'entry.ts': source },
		entryPoint: 'entry.ts',
	})
}

test('hosted execute passes pinned credential picks across the gateway RPC boundary', async () => {
	silenceIncidentalRuntimeWarnings()
	const run = await runBundledModuleWithRegistry(
		env,
		createCaller(),
		await bundle('export default () => ({ ran: true })'),
		undefined,
		{
			skipCapabilityRegistry: true,
			credentialCallMap: {
				map: new Map([['api', [{ id: 'pinned-credential-id' }]]]),
				checked: true,
				strict: false,
			},
		},
	)
	expect(run.error).toBeUndefined()
	expect(run.result).toEqual({ ran: true })
})

test(
	'bare kody is absent on one-file and module executes, while the documented import and helpers still work',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const providers = [
			{
				name: 'kody',
				fns: {
					ping: async () => ({ ok: true }),
				},
			},
		]
		const oneFile = createExecuteExecutor({
			env,
			gatewayProps: {
				baseUrl: 'https://kody.dev',
				userId: null,
				email: null,
				request: null,
				storageContext: null,
			},
			timeoutMs: 15_000,
			recordExecuteUsage: false,
		})

		const bareOneFile = await oneFile.execute('async () => kody', providers)
		expect(bareOneFile.error).toMatch(/kody is not defined/)
		expect(
			getExecutionErrorDetails(new Error(bareOneFile.error ?? '')),
		).toMatchObject({
			kind: 'runtime_import_missing',
			exportName: 'kody',
			nextStep: expect.stringContaining("import { kody } from 'kody:runtime'"),
		})

		const bypass = await oneFile.execute(
			`async () => {
				const attempts = []
				const tryCall = async (label, call) => {
					try {
						await call()
						attempts.push(label + ':called')
					} catch (error) {
						const name = error instanceof Error ? error.name : 'Error'
						attempts.push(label + ':' + name)
					}
				}
				await tryCall('dispatcher', () => __kodyCallDispatcher('ping', {}))
				await tryCall('provider', () => __kodyProvider.ping({}))
				await tryCall('bag', () => __dispatchers.kody.call('ping', '{}'))
				return {
					attempts,
					dispatcherType: typeof __kodyCallDispatcher,
				}
			}`,
			providers,
		)
		expect(bypass.error).toBeUndefined()
		expect(bypass.result).toEqual({
			attempts: ['dispatcher:TypeError', 'provider:TypeError', 'bag:TypeError'],
			dispatcherType: 'undefined',
		})

		const symbols = await oneFile.execute(
			`async () => ({
				globalKody: typeof globalThis.kody,
				fetchStorage: typeof globalThis[Symbol.for('kody.evaluateFetchStorage')]?.getStore,
				fetchPatched: globalThis[Symbol.for('kody.evaluateFetchPatched')] === true,
			})`,
			providers,
		)
		expect(symbols.error).toBeUndefined()
		expect(symbols.result).toEqual({
			globalKody: 'undefined',
			fetchStorage: 'function',
			fetchPatched: true,
		})

		const bareModule = await runBundledModuleWithRegistry(
			env,
			createCaller(),
			await bundle(`export default async function main() {
				return kody
			}`),
			undefined,
			{ skipCapabilityRegistry: true },
		)
		expect(bareModule.error).toMatch(/kody is not defined/)
		expect(
			getExecutionErrorDetails(new Error(bareModule.error ?? '')),
		).toMatchObject({
			kind: 'runtime_import_missing',
			exportName: 'kody',
		})

		const imported = await runBundledModuleWithRegistry(
			env,
			createCaller(),
			await bundle(`import { kody } from 'kody:runtime'
export default async function main() {
	const storage = globalThis[Symbol.for('kody.runtimeStorage')]
	const authority = globalThis[Symbol.for('kody.getSecretAuthority')]
	return {
		ping: await kody.ping({ n: 1 }),
		globalKody: typeof globalThis.kody,
		runtimeStorage: typeof storage?.run,
		authority: typeof authority,
	}
}`),
			undefined,
			{
				skipCapabilityRegistry: true,
				additionalTools: {
					ping: async (args) => ({ echoed: args }),
				},
			},
		)
		expect(imported.error).toBeUndefined()
		expect(imported.result).toEqual({
			ping: { echoed: { n: 1 } },
			globalKody: 'undefined',
			runtimeStorage: 'function',
			// GHSA-5fv3: no global secret-authority getter; identity is a
			// trusted per-package binding.
			authority: 'undefined',
		})

		const helper = await runBundledModuleWithRegistry(
			env,
			createCaller(),
			await bundle(`import { email } from 'kody:runtime'
export default async function main() {
	if (!email) return { bound: false }
	let missing = null
	try {
		await email.getMessage('   ')
	} catch (error) {
		missing = error instanceof Error ? error.message : String(error)
	}
	return {
		bound: true,
		missing,
		message: await email.getMessage('msg-1'),
	}
}`),
			undefined,
			{
				skipCapabilityRegistry: true,
				emailTools: {
					getMessage: async (messageId) => ({
						id: messageId,
						subject: 'hello',
					}),
					getAttachment: async () => ({ content_base64: null }),
				},
			},
		)
		expect(helper.error).toBeUndefined()
		expect(helper.result).toEqual({
			bound: true,
			missing: 'email.getMessage requires a non-empty message id.',
			message: { id: 'msg-1', subject: 'hello' },
		})
	},
)
