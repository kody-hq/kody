import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createMcpCallerContext } from '#mcp/context.ts'
import { cliCredentialBootstrapCapability } from '#mcp/capabilities/meta/cli-credential-bootstrap.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ApiError, invalidRequest } from './errors.ts'
import { type ApiInvocationContext } from './context.ts'
import { runCapabilityProxyCall } from './capability-proxy.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

const mockFns = vi.hoisted(() => ({
	buildKodyToolContext: vi.fn(),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	buildKodyToolContext: mockFns.buildKodyToolContext,
	createWorkflowTools: () => ({ create: async () => null }),
}))

const secretValue = 'sk-live-very-secret-value'
const apiToken = `kody_at_${'a'.repeat(20)}_${'b'.repeat(43)}`
const bootstrapCode = `kody_bc_${'a'.repeat(16)}_${'B'.repeat(32)}`

const ctx = {
	env: {},
	callerContext: { user: { userId: ownerIdFromStored('user-1') } },
	principal: { kind: 'mcp' },
	getFeatureFlags: async () => ({}),
} as unknown as ApiInvocationContext

function mockToolContext(secretSet: (args: unknown) => unknown) {
	mockFns.buildKodyToolContext.mockImplementation(
		async (
			_env: unknown,
			_callerContext: unknown,
			options: { trackSecretInputValue?: (value: string) => void },
		) => ({
			mcpServers: [],
			tools: {
				secret_set: async (args: { value: string }) => {
					options.trackSecretInputValue?.(args.value)
					return secretSet(args)
				},
			},
		}),
	)
}

function mockBootstrapToolContext(db: D1Database) {
	mockFns.buildKodyToolContext.mockImplementation(
		async (
			_env: unknown,
			callerContext: { user: { userId: string } },
			options: {
				openApiPrincipal?: Parameters<
					typeof cliCredentialBootstrapCapability.handler
				>[1]['openApiPrincipal']
				localExecuteHop?: true
			},
		) => ({
			mcpServers: [],
			tools: {
				cliCredentialBootstrap: (args: unknown) =>
					cliCredentialBootstrapCapability.handler(
						args as Record<string, unknown>,
						{
							env: { APP_DB: db } as Env,
							callerContext: createMcpCallerContext({
								source: { kind: 'mcp-oauth' },
								baseUrl: 'https://kody.codes',
								user: {
									userId: personIdFromStored(callerContext.user.userId),
									email: 'caller@example.com',
									displayName: 'Caller',
								},
							}),
							...(options.openApiPrincipal
								? { openApiPrincipal: options.openApiPrincipal }
								: {}),
							...(options.localExecuteHop ? { localExecuteHop: true } : {}),
						},
					),
			},
		}),
	)
}

async function callSecretSet() {
	return runCapabilityProxyCall({
		ctx,
		call: { path: ['kody', 'secret_set'], args: [{ value: secretValue }] },
	}).catch((error: unknown) => error)
}

afterEach(() => {
	mockFns.buildKodyToolContext.mockReset()
	vi.restoreAllMocks()
})

test('unexpected capability failures hide written secrets and API tokens', async () => {
	mockToolContext(() => {
		throw new Error(
			`write failed for ${secretValue} via ${apiToken} and ${bootstrapCode}`,
		)
	})
	const error = await callSecretSet()
	expect(error).toBeInstanceOf(ApiError)
	expect(error).toMatchObject({ status: 500, code: 'capability_error' })
	const message = (error as ApiError).message
	expect(message).toContain('write failed for [REDACTED SECRET]')
	expect(message).not.toContain(secretValue)
	expect(message).not.toContain(apiToken)
	expect(message).toContain('kody_bc_[redacted]')
	expect(message).not.toContain(bootstrapCode)
})

test('caller errors from a capability keep their status with secrets redacted', async () => {
	mockToolContext(() => {
		throw invalidRequest(`value ${secretValue} is too long`)
	})
	const error = await callSecretSet()
	expect(error).toMatchObject({
		status: 400,
		code: 'invalid_request',
		message: 'value [REDACTED SECRET] is too long',
	})
})

test('platform failures outside the capability return a generic error and log details', async () => {
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	mockFns.buildKodyToolContext.mockRejectedValue(
		new Error('D1_ERROR: no such column: secret_ciphertext'),
	)
	const error = await callSecretSet()
	expect(error).toMatchObject({ status: 500, code: 'internal_error' })
	expect((error as ApiError).message).not.toContain('D1_ERROR')
	expect(consoleError).toHaveBeenCalledWith(
		'capability-proxy platform failure',
		expect.objectContaining({
			path: 'kody.secret_set',
			error: 'D1_ERROR: no such column: secret_ciphertext',
		}),
	)
})

function parentTokenPrincipal() {
	const now = new Date()
	return {
		kind: 'token' as const,
		token: {
			id: 'parent-token',
			user_id: ownerIdFromStored('user-1'),
			name: 'parent',
			token_hash: 'hash',
			scopes: ['org:execute'],
			idle_ttl_seconds: 3600,
			expires_at: new Date(now.getTime() + 3600_000).toISOString(),
			max_expires_at: new Date(now.getTime() + 3600_000).toISOString(),
			created_via: 'api',
			created_at: now.toISOString(),
			updated_at: now.toISOString(),
			last_used_at: null,
			rotated_at: null,
			revoked_at: null,
		},
	}
}

function bootstrapDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	return createD1FromSqlite(sqlite)
}

function openApiBootstrap(db: D1Database, args: Record<string, unknown>) {
	return cliCredentialBootstrapCapability.handler(args, {
		env: { APP_DB: db } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'api-token', tokenId: 'token-1' },
			baseUrl: 'https://kody.codes',
			user: {
				userId: personIdFromStored('user-1'),
				email: 'caller@example.com',
				displayName: 'Caller',
			},
		}),
		openApiPrincipal: parentTokenPrincipal() as never,
	})
}

test('CapabilityProxy refuses cliCredentialBootstrap from execute --local', async () => {
	const db = bootstrapDb()
	mockBootstrapToolContext(db)
	const tokenCtx = {
		...ctx,
		principal: parentTokenPrincipal(),
	} as unknown as ApiInvocationContext

	const error = await runCapabilityProxyCall({
		ctx: tokenCtx,
		call: {
			path: ['kody', 'cliCredentialBootstrap'],
			args: [{ scopes: ['org:execute'], lifetime: 'short' }],
		},
	}).catch((value: unknown) => value)
	expect(error).toMatchObject({
		status: 400,
		message: expect.stringMatching(
			/cannot be called from execute code[\s\S]*MCP api tool/,
		),
	})
	expect(mockFns.buildKodyToolContext).toHaveBeenCalledWith(
		expect.anything(),
		expect.anything(),
		expect.objectContaining({ localExecuteHop: true }),
	)
})

test('Open API token callers cannot escalate scopes when minting CLI bootstrap credentials', async () => {
	const error = await openApiBootstrap(bootstrapDb(), {
		scopes: ['token:delete'],
		idle_ttl_seconds: 60,
	}).catch((value: unknown) => value)
	expect(error).toMatchObject({
		message: expect.stringMatching(/scopes it does not hold/),
	})
})

test('Open API token callers get bootstrap lifetime capped to the parent token lifetime', async () => {
	const result = (await openApiBootstrap(bootstrapDb(), {
		scopes: ['org:execute'],
		idle_ttl_seconds: 60,
		max_lifetime_seconds: 7200,
	})) as { max_lifetime_seconds: number }
	expect(result.max_lifetime_seconds).toBeLessThanOrEqual(3600)
	expect(result.max_lifetime_seconds).toBeGreaterThan(3000)
})

test('dotted kody.mcp[server].tool looks up raw tools-map keys, not sanitizeToolName dispatchName', async () => {
	const rawCapabilityName = 'mcp:home:set_pin'
	const sanitizedDispatchName = 'mcphomeset_pin'
	const calls: Array<unknown> = []
	mockFns.buildKodyToolContext.mockResolvedValue({
		mcpServers: [
			{
				name: 'home',
				serverId: 'home-server',
				status: {
					state: 'ready',
					connected: true,
					toolCount: 1,
					message: 'connected',
					unavailableMessage: 'unavailable',
				},
				capabilities: [
					{
						name: 'set_pin',
						// Cloud ToolDispatcher key; CapabilityProxy must not use this
						// against the raw-name tools map (#2949).
						dispatchName: sanitizedDispatchName,
					},
				],
			},
		],
		// Production tools map is keyed by raw capability.name (colons intact).
		tools: {
			[rawCapabilityName]: async (args: unknown) => {
				calls.push(args)
				return { ok: true }
			},
		},
	})

	const dotted = await runCapabilityProxyCall({
		ctx,
		call: {
			path: ['kody', 'mcp', 'home', 'set_pin'],
			args: [{ pin: '1234' }],
		},
	})
	expect(dotted.result).toEqual({ ok: true })

	const flat = await runCapabilityProxyCall({
		ctx,
		call: {
			path: ['kody', rawCapabilityName],
			args: [{ pin: '5678' }],
		},
	})
	expect(flat.result).toEqual({ ok: true })

	expect(calls).toEqual([{ pin: '1234' }, { pin: '5678' }])
})
