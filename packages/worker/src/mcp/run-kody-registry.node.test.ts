import {
	ownerIdFromStored,
	personIdFromStored,
	personalOrgId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { http, HttpResponse } from 'msw'
import { expect, test, vi } from 'vitest'
import { createExecuteHelperPrelude } from '#mcp/execute-modules/kody-runtime-utils.ts'
import { kodyCallDispatcherName } from '#worker/kody-evaluate-bindings.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import * as registryModule from '#mcp/capabilities/registry.ts'
import { buildCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import * as moduleGraph from '#worker/package-runtime/module-graph.ts'
import {
	buildKodyFns,
	createWorkflowTools,
	credentialNeedsEntryPackageIds,
	executeBundleTimeoutMs,
	runModuleWithRegistry,
} from './run-kody-registry.ts'
import * as runRecords from '#worker/run-records/service.ts'
import * as mcpExecutor from '#mcp/executor.ts'
import * as executeInterpretable from '#mcp/execute-interpretable.ts'
import { createStableDynamicWorkerId } from '#mcp/dynamic-worker-id.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import { PackageSecretMountError } from '#mcp/secrets/package-access.ts'
import { secretAuthorityArgName } from '#mcp/secrets/secret-authority.ts'
import * as credentialDoor from '#worker/credentials/resolve-credential.ts'
import { type JobRecord } from '#worker/jobs/types.ts'
import { createD1JobsStore } from '@kody-internal/shared/jobs/store.ts'
import {
	createFakeRunLogNamespace,
	createJobMutationDatabase,
	createJobMutationKv,
	createRunKodyRegistryTestEnv,
	createJobRow,
} from '#worker/test-support/run-kody-registry.ts'

vi.mock('#worker/package-runtime/module-graph.ts', async () => {
	const actual = await vi.importActual<typeof moduleGraph>(
		'#worker/package-runtime/module-graph.ts',
	)
	return {
		...actual,
		buildKodyModuleBundle: vi.fn(async () => ({
			mainModule: 'entry.js',
			modules: {
				'entry.js':
					'export default async function main(input = {}) { return input }',
			},
		})),
	}
})

type ProviderFns = Record<string, (args: unknown) => Promise<unknown>>

function requireFn<Fn>(fns: Record<string, Fn>, name: string): Fn {
	const fn = fns[name]
	if (!fn) throw new Error(`Expected kody function "${name}"`)
	return fn
}
type Providers = Array<{ fns: ProviderFns }>
type CapabilityRegistry = Awaited<
	ReturnType<typeof registryModule.getCapabilityRegistryForContext>
>

const emptyRegistry = {
	capabilityDomains: [],
	capabilityDomainDescriptionsByName: {} as Record<string, string>,
	capabilityHandlers: {},
	capabilityList: [],
	capabilityMap: {},
	capabilitySpecs: {},
	capabilityToolDescriptors: {},
} as CapabilityRegistry

function registryWith(capability: {
	name: string
	domain: string
	description: string
	readOnly: boolean
	idempotent: boolean
	inputSchema: Record<string, unknown>
	outputSchema: Record<string, unknown>
	handler: (args: Record<string, unknown>) => Promise<unknown>
}) {
	const entry = { keywords: [], destructive: false, ...capability }
	return {
		...emptyRegistry,
		capabilityList: [entry],
		capabilityMap: { [entry.name]: entry },
		capabilityToolDescriptors: {
			[entry.name]: {
				description: entry.description,
				inputSchema: entry.inputSchema,
				outputSchema: entry.outputSchema,
			},
		},
	} as unknown as CapabilityRegistry
}

const secretSetRegistry = () =>
	registryWith({
		name: 'secretSet',
		domain: 'secrets',
		description: 'Store a secret.',
		readOnly: false,
		idempotent: false,
		inputSchema: {
			type: 'object',
			properties: { name: { type: 'string' }, value: { type: 'string' } },
			required: ['name', 'value'],
		},
		outputSchema: { type: 'object', properties: { name: { type: 'string' } } },
		handler: async (args) => ({ name: args.name }),
	})

const meCaller = () =>
	createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://app.example.com',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'me@example.com',
			displayName: 'Me',
		},
		storageContext: null,
	})

function mockExecutor(
	respond: (providers: Providers) => unknown | Promise<unknown> = async () => ({
		result: 'ok',
		logs: [],
	}),
) {
	const calls: Array<{
		source: string
		providers: Providers
		invocation: unknown
		input: Parameters<typeof mcpExecutor.createExecuteExecutor>[0]
	}> = []
	const spy = vi.spyOn(mcpExecutor, 'createExecuteExecutor').mockImplementation(
		(input) =>
			({
				async execute(
					source: unknown,
					providers: Providers,
					invocation?: unknown,
				) {
					calls.push({ source: String(source), providers, invocation, input })
					return await respond(providers)
				},
			}) as never,
	)
	return { spy, calls, fns: () => calls.at(-1)!.providers[0]!.fns }
}

function createWorkflowEnv(savedPackageRow: Record<string, unknown> | null) {
	const created: Array<WorkflowInstanceCreateOptions<unknown>> = []
	const workflowEnv = {
		APP_DB: {
			prepare(query: string) {
				return {
					bind() {
						return {
							async first() {
								if (query.includes('COUNT(*) AS count')) return { count: 0 }
								if (query.includes('FROM saved_packages')) {
									return savedPackageRow
								}
								return null
							},
							async all() {
								throw new Error(`Unsupported all query: ${query}`)
							},
							async run() {
								throw new Error(`Unsupported run query: ${query}`)
							},
						}
					},
				}
			},
		} as unknown as D1Database,
		RUN_LOG: createFakeRunLogNamespace().namespace,
		DYNAMIC_CALLABLE_WORKFLOWS: {
			get: async () => {
				throw new Error('not found')
			},
			create: async (options?: WorkflowInstanceCreateOptions<unknown>) => {
				if (!options) throw new Error('missing options')
				created.push(options)
				return {
					id: options.id ?? 'generated',
					status: async () => ({ status: 'queued' }),
				} as WorkflowInstance
			},
			createBatch: async () => {
				throw new Error('createBatch is not supported in this test')
			},
			deleteBatch: async () => {
				throw new Error('deleteBatch is not supported in this test')
			},
		} as Workflow<unknown>,
	} as Env
	return { workflowEnv, created }
}

test('buildKodyFns rejects role-gated capabilities even when passed an unfiltered registry', async () => {
	// The stub Env has no MCP server storage, so metadata loading warns
	// 'mcp-server-refs-load-failed' before degrading to "no MCP servers".
	silenceIncidentalRuntimeWarnings()
	const registry = buildCapabilityRegistry([
		{
			name: 'admin',
			description: 'Admin capabilities',
			capabilities: [
				defineDomainCapability('admin', {
					name: 'adminUserList',
					orgPermission: 'none',
					description: 'List admin user account metadata',
					readOnly: true,
					idempotent: true,
					requiredRole: 'admin',
					inputSchema: { type: 'object', properties: {} },
					handler: async () => ({ ok: true }),
				}),
			],
		},
	])
	const tools = await buildKodyFns(
		{} as Env,
		createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored('user-1'),
				email: 'user@example.com',
				displayName: 'user',
				roles: ['user'],
			},
		}),
		{ capabilityRegistry: registry },
	)

	await expect(requireFn(tools, 'adminUserList')({})).rejects.toThrow(
		'MCP user lacks required role "admin" for capability "adminUserList".',
	)
})

test('package workflow tools create instances from package context and honor caller overrides in runModuleWithRegistry', async () => {
	silenceIncidentalRuntimeWarnings()
	const { workflowEnv, created } = createWorkflowEnv({
		id: 'pkg-1',
		user_id: ownerIdFromStored('user-1'),
		name: 'Shade automation',
		kody_id: 'shade-automation',
		description: 'Shade automation package',
		tags_json: '[]',
		search_text: null,
		source_id: 'source-1',
		has_app: 0,
		created_at: '2026-05-03T00:00:00.000Z',
		updated_at: '2026-05-03T00:00:00.000Z',
	})
	const packageContext = {
		packageId: 'pkg-1',
		kodyId: 'shade-automation',
		sourceId: 'source-1',
	}
	const workflowTools = createWorkflowTools({
		env: workflowEnv,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://app.example.com',
			user: {
				userId: personIdFromStored('user-1'),
				email: 'me@example.com',
				displayName: 'Me',
			},
			storageContext: null,
			repoContext: null,
		}),
		packageContext,
	})

	const result = await workflowTools?.create({
		workflowName: 'shade-event',
		exportName: './run-event',
		runAt: '2026-05-03T12:00:00.000Z',
		idempotencyKey: 'event-key',
		params: { eventId: 'event-1' },
	})
	expect(result).toMatchObject({
		ok: true,
		workflow_name: 'shade-event',
		export_name: './run-event',
		run_at: '2026-05-03T12:00:00.000Z',
	})
	expect(created).toHaveLength(1)
	expect(created[0]?.params).toEqual(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			packageId: 'pkg-1',
			kodyId: 'shade-automation',
			sourceId: 'source-1',
			workflowName: 'shade-event',
			params: { eventId: 'event-1' },
		}),
	)

	const customWorkflowTools = {
		create: vi.fn(async () => ({ ok: true, id: 'custom-workflow' })),
	}
	const executor = mockExecutor()
	await runModuleWithRegistry(
		{} as Env,
		meCaller(),
		`import { workflows } from 'kody:runtime'
export default async function run() {
	await workflows.create({
		workflowName: 'shade-event',
		exportName: './run-event',
		runAt: '2026-05-03T12:00:00.000Z',
		idempotencyKey: 'event-key',
	})
}`,
		undefined,
		{ packageContext, workflowTools: customWorkflowTools },
	)
	await expect(
		requireFn(
			executor.fns(),
			'packageWorkflowCreate',
		)({
			workflowName: 'custom',
		}),
	).resolves.toEqual({ ok: true, id: 'custom-workflow' })
	expect(customWorkflowTools.create).toHaveBeenCalledWith({
		workflowName: 'custom',
	})
})

test('runModuleWithRegistry queues inline workflows.create calls without runAt or idempotencyKey', async () => {
	silenceIncidentalRuntimeWarnings()
	const { workflowEnv, created } = createWorkflowEnv(null)
	const inlineCode =
		'export default async function main() { return { ok: true } }'
	const executor = mockExecutor(async (providers) => ({
		result: await requireFn(
			providers[0]!.fns,
			'packageWorkflowCreate',
		)({ code: inlineCode }),
		logs: [],
	}))

	vi.useFakeTimers()
	try {
		vi.setSystemTime(new Date('2026-05-03T12:34:56.000Z'))
		const result = await runModuleWithRegistry(
			workflowEnv,
			meCaller(),
			`import { workflows } from 'kody:runtime'
export default async function main() {
  return await workflows.create({ code: \`${inlineCode}\` })
}`,
		)

		expect(result.result).toMatchObject({
			ok: true,
			source_type: 'inline',
			workflow_name: 'inline-code',
			export_name: null,
			run_at: '2026-05-03T12:34:56.000Z',
			plan_date: '2026-05-03',
			status: 'queued',
		})
		const wrappedSource = executor.calls[0]!.source
		expect(wrappedSource).toContain('const workflows = {')
		expect(wrappedSource).toContain(
			"__kodyCallDispatcher('packageWorkflowCreate'",
		)
		expect(wrappedSource).toContain('kody: __kodyProvider')
		expect(wrappedSource).not.toMatch(/\b(?:const|let|var) kody\b/)
		expect(created).toHaveLength(1)
		expect(created[0]?.params).toEqual(
			expect.objectContaining({
				sourceType: 'inline',
				userId: ownerIdFromStored('user-1'),
				workflowName: 'inline-code',
				code: inlineCode,
				idempotencyKey: expect.stringMatching(/^generated:/),
				runAt: '2026-05-03T12:34:56.000Z',
				planDate: '2026-05-03',
			}),
		)
	} finally {
		vi.useRealTimers()
	}
})

test('buildKodyFns updates package jobs through production-shaped bindings', async () => {
	silenceIncidentalRuntimeWarnings()
	const user = {
		userId: personIdFromStored('user-123'),
		email: 'user@example.com',
		displayName: 'User Example',
	}
	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		user,
		storageContext: {
			sessionId: null,
			appId: 'app-123',
			packageId: null,
			storageId: null,
		},
	})
	const userId = user.userId
	const jobId = 'package-job:pkg-1:hrv-discord-reaction-poller'
	const job: JobRecord = {
		version: 1,
		id: jobId,
		userId: personalOrgId(userId),
		name: 'hrv-discord-reaction-poller',
		sourceId: 'job-source-1',
		publishedCommit: 'published-commit-1',
		storageId: `job:${jobId}`,
		params: { channelId: 'discord-channel-1' },
		schedule: { type: 'interval', every: '5m' },
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		expiresAt: null,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-16T00:05:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}
	const db = createJobMutationDatabase({
		jobs: [createJobRow(job, { ...callerContext, user })],
		entitySources: [],
	})
	const repoSessionAccesses: Array<string> = []
	const jobManagerSyncPayloads: Array<{ userId: string; source?: string }> = []
	const env = createRunKodyRegistryTestEnv({
		APP_DB: db,
		SENTRY_ENVIRONMENT: 'production',
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
		BUNDLE_ARTIFACTS_KV: createJobMutationKv(),
		REPO_SESSION: {
			idFromName(name: string) {
				repoSessionAccesses.push(name)
				throw new Error('metadata-only job updates must not publish source')
			},
			get() {
				throw new Error('metadata-only job updates must not open repo sessions')
			},
		},
		JOBS: {
			...createD1JobsStore(db),
			async syncAlarm(input: { userId: string }) {
				if (input.userId !== userId) {
					throw new Error(`Expected JOBS.syncAlarm to be scoped to ${userId}`)
				}
				jobManagerSyncPayloads.push(input)
				return { ok: true as const, userId: input.userId, nextRunAt: null }
			},
		},
	})
	const readJobRow = () =>
		db
			.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?')
			.bind(jobId, userId)
			.first<Record<string, unknown>>()

	const kody = await buildKodyFns(env, callerContext)
	await expect(
		requireFn(kody, 'jobUpdate')({ id: jobId, enabled: false }),
	).resolves.toMatchObject({
		job_id: jobId,
		name: 'hrv-discord-reaction-poller',
		enabled: false,
		params: { channelId: 'discord-channel-1' },
	})
	expect(repoSessionAccesses).toEqual([])
	expect(jobManagerSyncPayloads).toMatchObject([{ userId }])
	await expect(readJobRow()).resolves.toMatchObject({ enabled: 0 })
})

test('buildKodyFns tracks secretSet values and runModuleWithRegistry redacts them from cyclic results and logs', async () => {
	silenceIncidentalRuntimeWarnings()
	vi.spyOn(registryModule, 'getCapabilityRegistryForContext').mockResolvedValue(
		secretSetRegistry(),
	)
	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		user: {
			userId: personIdFromStored('user-123'),
			email: 'user@example.com',
			displayName: 'User Example',
		},
	})
	const trackedSecretValues: Array<string> = []
	const trackedKody = await buildKodyFns({} as Env, callerContext, {
		trackSecretInputValue(value) {
			trackedSecretValues.push(value)
		},
	})
	await expect(
		requireFn(
			trackedKody,
			'secretSet',
		)({
			name: 'spotifyAccessToken',
			value: 'fresh-access-token',
		}),
	).resolves.toEqual({ name: 'spotifyAccessToken' })
	expect(trackedSecretValues).toEqual(['fresh-access-token'])

	mockExecutor(async (providers) => {
		await requireFn(
			providers[0]!.fns,
			'secretSet',
		)({
			name: 'spotifyAccessToken',
			value: 'fresh-access-token',
		})
		const objectResult: Record<string, unknown> = {
			'fresh-access-token key': 'fresh-access-token value',
		}
		objectResult.self = objectResult
		const arrayResult: Array<unknown> = ['fresh-access-token array']
		arrayResult.push(arrayResult)
		const errorResult = new Error('fresh-access-token error') as Error & {
			cause?: unknown
		}
		errorResult.cause = errorResult
		return {
			result: { objectResult, arrayResult, errorResult },
			logs: ['fresh-access-token log'],
		}
	})
	const result = await runModuleWithRegistry(
		{} as Env,
		callerContext,
		`import { kody } from 'kody:runtime'

export default async function run() {
	await kody.secretSet({
		name: 'spotifyAccessToken',
		value: 'fresh-access-token',
	})
	return null
}`,
	)
	const sanitized = result.result as {
		objectResult: Record<string, unknown>
		arrayResult: Array<unknown>
		errorResult: Error & { cause?: unknown }
	}
	expect(sanitized.objectResult['[REDACTED SECRET] key']).toBe(
		'[REDACTED SECRET] value',
	)
	expect(sanitized.objectResult.self).toBe(sanitized.objectResult)
	expect(sanitized.arrayResult[0]).toBe('[REDACTED SECRET] array')
	expect(sanitized.arrayResult[1]).toBe(sanitized.arrayResult)
	expect(sanitized.errorResult.message).toBe('[REDACTED SECRET] error')
	expect(sanitized.errorResult.cause).toBe(sanitized.errorResult)
	expect(result.logs).toEqual(['[REDACTED SECRET] log'])
})

test('runModuleWithRegistry redacts an oauthClientCredentials access token from results and logs while the Bearer header keeps the real value', async () => {
	silenceIncidentalRuntimeWarnings()
	vi.spyOn(registryModule, 'getCapabilityRegistryForContext').mockResolvedValue(
		secretSetRegistry(),
	)
	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		user: {
			userId: personIdFromStored('user-123'),
			email: 'user@example.com',
			displayName: 'User Example',
		},
	})
	const accessToken = 'minted+access/token=='
	const apiAuthorizations: Array<string | null> = []
	using _server = createMswNodeServer([
		http.post('https://oauth.example.com/token', () =>
			HttpResponse.json({ access_token: accessToken, token_type: 'Bearer' }),
		),
		http.get('https://api.example.com/items', ({ request }) => {
			apiAuthorizations.push(request.headers.get('authorization'))
			return HttpResponse.json({ ok: true })
		}),
	])
	mockExecutor(async (providers) => {
		const fns = providers[0]!.fns
		const createHelpers = new Function(
			kodyCallDispatcherName,
			`${createExecuteHelperPrelude()}; return { oauthClientCredentials };`,
		) as (dispatch: (name: string, args: unknown) => Promise<unknown>) => {
			oauthClientCredentials: (input: unknown) => Promise<{
				access_token: string
			}>
		}
		const helpers = createHelpers(
			async (name, args) => await requireFn(fns, name)(args as never),
		)
		const token = await helpers.oauthClientCredentials({
			tokenUrl: 'https://oauth.example.com/token',
			clientIdSecret: 'exampleClientId',
			clientSecretSecret: 'exampleClientSecret',
		})
		const response = await fetch('https://api.example.com/items', {
			headers: { Authorization: `Bearer ${token.access_token}` },
		})
		return {
			result: { token, status: response.status },
			logs: [
				`token ${token.access_token}`,
				`encoded ${encodeURIComponent(accessToken)}`,
				`base64 ${btoa(accessToken)}`,
			],
		}
	})
	const result = await runModuleWithRegistry(
		{} as Env,
		callerContext,
		`export default async function run() { return null }`,
	)
	expect(apiAuthorizations).toEqual([`Bearer ${accessToken}`])
	expect(result.result).toEqual({
		token: { access_token: '[REDACTED SECRET]', token_type: 'Bearer' },
		status: 200,
	})
	expect(result.logs).toEqual([
		'token [REDACTED SECRET]',
		'encoded [REDACTED SECRET]',
		'base64 [REDACTED SECRET]',
	])
})

test('buildKodyFns rejects package storage kody tools that collide with capabilities', async () => {
	silenceIncidentalRuntimeWarnings()
	vi.spyOn(registryModule, 'getCapabilityRegistryForContext').mockResolvedValue(
		registryWith({
			name: 'packageStorageGet',
			domain: 'storage',
			description: 'Capability that collides with a package storage helper.',
			readOnly: true,
			idempotent: true,
			inputSchema: { type: 'object', properties: {} },
			outputSchema: { type: 'object', properties: {} },
			handler: async () => ({ ok: true }),
		}),
	)
	const env = {
		STORAGE_RUNNER: {
			idFromName: (name: string) => name,
			get: () => ({}),
		},
	} as unknown as Env

	await expect(
		buildKodyFns(
			env,
			createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				user: {
					userId: personIdFromStored('user-123'),
					email: 'user@example.com',
					displayName: 'User Example',
				},
			}),
			{
				packageStorageTools: {
					grantedPackageIds: new Set(['pkg-1']),
					runPackageId: 'pkg-1',
				},
			},
		),
	).rejects.toThrow(
		'Kody helper "packageStorageGet" collides with a capability.',
	)
})

test('packageStorage keys StorageRunner by the bound org, not the caller person', async () => {
	silenceIncidentalRuntimeWarnings()
	vi.spyOn(registryModule, 'getCapabilityRegistryForContext').mockResolvedValue(
		emptyRegistry,
	)
	const names: Array<string> = []
	const env = {
		STORAGE_RUNNER: {
			idFromName: (name: string) => {
				names.push(name)
				return name
			},
			get: () => ({
				getValue: async ({ key }: { key: string }) => ({ key, value: 'v' }),
			}),
		},
	} as unknown as Env
	const user = {
		userId: personIdFromStored('person-1'),
		email: 'member@example.com',
		displayName: 'Member',
	}
	const storageNameFor = async (orgId: string | null) => {
		names.length = 0
		const fns = await buildKodyFns(
			env,
			createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://kody.codes',
				user,
				orgBinding: orgId
					? { org: { id: orgId, slug: 'team' }, role: 'member' }
					: null,
			}),
			{
				packageStorageTools: {
					grantedPackageIds: new Set(['pkg-1']),
					runPackageId: 'pkg-1',
				},
			},
		)
		await (fns as Record<string, (args: unknown) => Promise<unknown>>)
			.packageStorageGet!({ packageId: 'pkg-1', key: 'k' })
		return names.at(-1)
	}

	expect(await storageNameFor('team-org-1')).toBe(
		JSON.stringify(['team-org-1', 'package:pkg-1']),
	)
	expect(await storageNameFor(null)).toBe(
		JSON.stringify([personalOrgId(user.userId), 'package:pkg-1']),
	)
})

test('runModuleWithRegistry forwards package context and resolves package secrets as the trusted package', async () => {
	silenceIncidentalRuntimeWarnings()
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		user: {
			userId: personIdFromStored('user-123'),
			email: 'user@example.com',
			displayName: 'User Example',
		},
		storageContext: {
			sessionId: null,
			appId: 'package-123',
			packageId: null,
			storageId: 'package-123',
		},
	})
	vi.spyOn(registryModule, 'getCapabilityRegistryForContext').mockResolvedValue(
		emptyRegistry,
	)
	const mountedRef =
		'{{secret:discordBotTokenKentPersonalAutomation|scope=user}}'
	const resolveMountedSpy = vi
		.spyOn(credentialDoor, 'resolveCredential')
		.mockImplementation(async ({ credential }) => {
			if (credential.use !== 'package-secret-mount') {
				throw new Error(`Unexpected credential use: ${credential.use}`)
			}
			const { alias } = credential
			if (alias === 'missing-token') {
				throw new PackageSecretMountError(
					'Secret "missing-token" was not found.',
				)
			}
			return {
				alias,
				name: 'discordBotTokenKentPersonalAutomation',
				ref: mountedRef,
				scope: 'user',
				packageId: 'package-123',
				kodyId: 'discord-gateway',
			}
		})
	const executor = mockExecutor()

	const result = await runModuleWithRegistry(
		env,
		callerContext,
		`import { packageContext } from 'kody:runtime'

export default async function run() {
	return packageContext?.packageId ?? null
}`,
		undefined,
		{ packageContext: { packageId: 'package-123', kodyId: 'discord-gateway' } },
	)
	expect(result.result).toBe('ok')
	const fns = executor.fns()
	const packageSecretHas = requireFn(fns, 'packageSecretHas')
	const packageSecretGet = requireFn(fns, 'packageSecretGet')
	await expect(packageSecretHas({ alias: 'token' })).resolves.toEqual({
		has: true,
	})
	await expect(packageSecretHas({ alias: 'missing-token' })).resolves.toEqual({
		has: false,
	})

	// Forged packageId args (with or without a secret-authority arg) still
	// resolve as the run's trusted package.
	for (const args of [
		{ alias: 'token' },
		{ alias: 'token', packageId: 'pkg-a-forged' },
		{
			alias: 'token',
			packageId: 'pkg-a-forged',
			[secretAuthorityArgName]: 'package-123',
		},
	]) {
		resolveMountedSpy.mockClear()
		await expect(packageSecretGet(args)).resolves.toEqual({
			value: mountedRef,
		})
		expect(resolveMountedSpy).toHaveBeenCalledExactlyOnceWith({
			env,
			orgId: callerContext.request?.org.id,
			actor: callerContext.request,
			packageStamp: { kind: 'attested', packageId: 'package-123' },
			runContextPackageId: 'package-123',
			baseUrl: callerContext.baseUrl,
			credential: {
				use: 'package-secret-mount',
				alias: 'token',
				callerContext,
			},
		})
	}
})

test('runModuleWithRegistry records execute interpretable class only on execute-surface runs and resolves run surfaces', async () => {
	silenceIncidentalRuntimeWarnings()
	const recordSpy = vi
		.spyOn(executeInterpretable, 'recordExecuteInterpretableEvent')
		.mockImplementation(() => {})
	const env = {} as Env
	const callerContext = meCaller()
	vi.spyOn(registryModule, 'getCapabilityRegistryForContext').mockResolvedValue(
		emptyRegistry,
	)
	const executor = mockExecutor()
	const packageContext = { packageId: 'pkg-1', kodyId: 'bot' }
	const glueCode = `import { kody } from 'kody:runtime'
export default async function main() { return await kody.capability_id({}) }`
	const packageCode = `import whatShipped from 'kody:@you/bot/whatShipped'
export default async function main() { return await whatShipped({}) }`

	await runModuleWithRegistry(env, callerContext, glueCode)
	expect(recordSpy).toHaveBeenCalledExactlyOnceWith(env, { source: glueCode })
	expect(executor.spy).toHaveBeenCalledWith(
		expect.objectContaining({ surface: 'execute', executeShape: 'glue' }),
	)

	recordSpy.mockClear()
	await runModuleWithRegistry(env, callerContext, packageCode, undefined, {
		packageContext,
	})
	await runModuleWithRegistry(env, callerContext, glueCode, undefined, {
		packageContext,
		runRecord: { surface: 'execute' },
	})
	expect(recordSpy).not.toHaveBeenCalled()

	executor.spy.mockClear()
	await runModuleWithRegistry(env, callerContext, packageCode, undefined, {
		packageContext,
		runRecord: null,
		runSurface: 'subscription',
	})
	await runModuleWithRegistry(env, callerContext, packageCode, undefined, {
		packageContext,
		runRecord: null,
		runRecordHandle: {
			id: 'run-keyed',
			userId: ownerIdFromStored('user-1'),
			startedAt: '2026-09-07T00:00:00.000Z',
			persistence: 'eager',
			context: { surface: 'webhook' },
		},
	})
	expect(executor.spy.mock.calls.map(([input]) => input.surface)).toEqual([
		'subscription',
		'webhook',
	])
})

test('runModuleWithRegistry keeps WorkerCode stable across params and packageContext', async () => {
	silenceIncidentalRuntimeWarnings()
	const env = {} as Env
	const callerContext = meCaller()
	vi.spyOn(registryModule, 'getCapabilityRegistryForContext').mockResolvedValue(
		emptyRegistry,
	)
	const executor = mockExecutor()
	vi.mocked(moduleGraph.buildKodyModuleBundle).mockImplementation(
		async (input) => ({
			mainModule: 'entry.js',
			modules: {
				'entry.js':
					input.sourceFiles['entry.ts'] ??
					'export default async function main() { return null }',
			},
			dependencies: [],
		}),
	)

	const code = `import { kody } from 'kody:runtime'
export default async function main(params) { return params }`
	const firstParams = { sentinel: 'param-sentinel-9f3-office' }
	const secondParams = { sentinel: 'param-sentinel-9f3-kitchen' }
	const packageContext = { packageId: 'pkg-9f3', kodyId: 'bot-9f3' }
	await runModuleWithRegistry(env, callerContext, code, firstParams)
	await runModuleWithRegistry(env, callerContext, code, secondParams)
	await runModuleWithRegistry(env, callerContext, code, firstParams, {
		packageContext,
	})
	await runModuleWithRegistry(
		env,
		callerContext,
		`import { kody } from 'kody:runtime'
export default async function main(params) { return { other: true, ...params } }`,
		firstParams,
	)

	const [first, ...rest] = executor.calls
	const sameCode = rest.slice(0, 2)
	const otherCode = rest[2]!
	expect(sameCode.map((call) => call.source)).toEqual([
		first!.source,
		first!.source,
	])
	expect(sameCode.map((call) => call.input.modules)).toEqual([
		first!.input.modules,
		first!.input.modules,
	])
	expect(otherCode.input.modules).not.toEqual(first!.input.modules)
	const wrapped = first!.source
	expect(
		['__invocation.params', '__kodyTrustedPackageId', 'Object.freeze'].filter(
			(snippet) => !wrapped.includes(snippet),
		),
	).toEqual([])
	for (const leaked of [
		firstParams.sentinel,
		secondParams.sentinel,
		packageContext.packageId,
	]) {
		expect(JSON.stringify(wrapped)).not.toContain(leaked)
	}
	expect(executor.calls.slice(0, 3).map((call) => call.invocation)).toEqual([
		{ params: firstParams, packageContext: null },
		{ params: secondParams, packageContext: null },
		{ params: firstParams, packageContext },
	])

	const mintFromRun = async (call: (typeof executor.calls)[number]) =>
		await createStableDynamicWorkerId({
			userId: ownerIdFromStored('user-1'),
			storageContext: null,
			workerOptions: {
				...createDynamicWorkerCompatibilityOptions(),
				mainModule: 'executor.js',
				modules: {
					...(call.input.modules as Record<string, string>),
					'executor.js': await mcpExecutor.createExecutorModuleSource({
						code: call.source,
						providers: [{ name: 'kody', fns: {} }],
						shadowGlobalThis: false,
						timeoutMs: 1_000,
					}),
				},
			},
		})
	const ids = await Promise.all(executor.calls.map(mintFromRun))
	expect(ids.slice(1, 3)).toEqual([ids[0], ids[0]])
	expect(ids[3]).not.toBe(ids[0])
})

test('runModuleWithRegistry begins a run before bundling and records a clear timeout when bundling hangs', async () => {
	silenceIncidentalRuntimeWarnings()
	vi.useFakeTimers()
	const handle = {
		id: 'run-bundle-timeout',
		userId: ownerIdFromStored('user-1'),
		startedAt: '2026-10-01T00:00:00.000Z',
		persistence: 'eager' as const,
		context: { surface: 'execute' as const, name: null },
	}
	const beginSpy = vi
		.spyOn(runRecords, 'beginRunRecord')
		.mockReturnValue(handle)
	const finishSpy = vi
		.spyOn(runRecords, 'finishRunRecord')
		.mockResolvedValue(undefined as never)
	try {
		vi.mocked(moduleGraph.buildKodyModuleBundle).mockImplementation(
			() => new Promise(() => {}),
		)
		vi.spyOn(
			registryModule,
			'getCapabilityRegistryForContext',
		).mockResolvedValue(emptyRegistry)

		const pending = runModuleWithRegistry(
			{} as Env,
			meCaller(),
			'export default async function main() { return 1 }',
			undefined,
			{
				runRecord: { surface: 'execute', name: null },
			},
		)
		expect(beginSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				context: expect.objectContaining({ surface: 'execute' }),
			}),
		)
		await vi.advanceTimersByTimeAsync(executeBundleTimeoutMs)
		const result = await pending
		expect(result.error).toMatch(/Execute module bundling exceeded/)
		expect(result.runId).toBe('run-bundle-timeout')
		expect(finishSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				handle,
				status: 'error',
				error: expect.objectContaining({
					name: 'ExecuteBundleTimeoutError',
				}),
			}),
		)
	} finally {
		vi.useRealTimers()
		beginSpy.mockRestore()
		finishSpy.mockRestore()
		vi.mocked(moduleGraph.buildKodyModuleBundle).mockReset()
		vi.mocked(moduleGraph.buildKodyModuleBundle).mockImplementation(
			async () => ({
				mainModule: 'entry.js',
				modules: {
					'entry.js':
						'export default async function main(input = {}) { return input }',
				},
				dependencies: [],
			}),
		)
	}
})

test('credential needs come from entry closures, never a pinned dependency', () => {
	const dependencies = [
		{ sourceId: 's1', publishedCommit: 'c1', kodyId: 'dep', packageId: 'dep' },
		{
			sourceId: 's2',
			publishedCommit: 'c2',
			kodyId: 'nested',
			packageId: 'nested',
			transitive: true as const,
		},
	]
	const entries = (
		packageId: string | null,
		computedImportCalleePackageId: string | null = null,
	) =>
		credentialNeedsEntryPackageIds({
			packageContext: packageId
				? ({ packageId, kodyId: packageId } as never)
				: null,
			computedImportCalleePackageId,
			dependencies,
			dynamicDependencyPackageIds: ['dynamic'],
		})
	expect(entries(null)).toEqual(['dep', 'dynamic'])
	expect(entries('own')).toEqual(['own', 'dynamic'])
	expect(entries('own', 'callee')).toEqual(['own', 'callee', 'dynamic'])
	expect(entries(null, 'callee')).toEqual(['callee', 'dynamic'])
})
