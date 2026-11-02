import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { type ApiTokenRecord } from '#worker/api-tokens/service.ts'
import { cliCredentialBootstrapCapability } from './cli-credential-bootstrap.ts'

const mintCliCredentialBootstrap = vi.hoisted(() =>
	vi.fn(async (_input: Record<string, unknown>) => ({
		bootstrap_code: 'kody_bc_test',
		expires_at: '2030-01-01T00:00:00.000Z',
		cli_command: 'npx @kodycodes/cli auth bootstrap',
		name: 'cli',
		scopes: ['package:read'],
		idle_ttl_seconds: 3600,
		max_lifetime_seconds: 86400,
	})),
)
vi.mock('#worker/api-tokens/cli-credential-bootstrap.ts', async (original) => ({
	...(await original<
		typeof import('#worker/api-tokens/cli-credential-bootstrap.ts')
	>()),
	mintCliCredentialBootstrap,
}))

function mcpCaller() {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.codes',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'user@example.com',
			displayName: 'User',
		},
	})
}

test('cliCredentialBootstrap refuses hosted execute (no Open API principal)', async () => {
	await expect(
		cliCredentialBootstrapCapability.handler(
			{ lifetime: 'short' },
			{ env: {} as Env, callerContext: mcpCaller() },
		),
	).rejects.toThrow(/cannot be called from execute code/)
})

test('cliCredentialBootstrap refuses the execute --local CapabilityProxy hop', async () => {
	await expect(
		cliCredentialBootstrapCapability.handler(
			{ lifetime: 'short' },
			{
				env: {} as Env,
				callerContext: mcpCaller(),
				openApiPrincipal: { kind: 'mcp-oauth' },
				localExecuteHop: true,
			},
		),
	).rejects.toThrow(/cannot be called from execute code/)
})

test('cliCredentialBootstrap rejects saved-package and app runtime contexts', async () => {
	for (const storageContext of [
		{ packageId: 'package-1' },
		{ appId: 'app-1' },
	]) {
		await expect(
			cliCredentialBootstrapCapability.handler(
				{},
				{
					env: {} as Env,
					openApiPrincipal: { kind: 'mcp' },
					callerContext: createMcpCallerContext({
						source: { kind: 'mcp-oauth' },
						baseUrl: 'https://kody.codes',
						user: {
							userId: personIdFromStored('user-1'),
							email: 'user@example.com',
							displayName: 'User',
						},
						storageContext: {
							sessionId: null,
							appId: 'appId' in storageContext ? storageContext.appId : null,
							packageId:
								'packageId' in storageContext ? storageContext.packageId : null,
							storageId: null,
						},
					}),
				},
			),
		).rejects.toThrow(
			/cannot run inside saved-package, job, webhook, or app runtimes/,
		)
	}
})

test('cliCredentialBootstrap from an org-bound parent token stays bound to that org', async () => {
	mintCliCredentialBootstrap.mockClear()
	const token = {
		id: 'tok-1',
		user_id: 'user-1',
		org_id: 'org-team',
		org_binding: 'org',
		scopes: ['package:read'],
		max_expires_at: null,
	} as unknown as ApiTokenRecord
	await cliCredentialBootstrapCapability.handler(
		{ lifetime: 'short' },
		{
			env: { APP_DB: {} } as unknown as Env,
			callerContext: mcpCaller(),
			openApiPrincipal: { kind: 'token', token },
		},
	)
	expect(mintCliCredentialBootstrap).toHaveBeenCalledWith(
		expect.objectContaining({ orgBinding: 'org', orgId: 'org-team' }),
	)
})

test('cliCredentialBootstrap from a user-owned parent token stays user-owned', async () => {
	mintCliCredentialBootstrap.mockClear()
	const token = {
		id: 'tok-2',
		user_id: 'user-1',
		org_id: 'user-1',
		org_binding: 'user',
		scopes: ['package:read'],
		max_expires_at: null,
	} as unknown as ApiTokenRecord
	await cliCredentialBootstrapCapability.handler(
		{ lifetime: 'short' },
		{
			env: { APP_DB: {} } as unknown as Env,
			callerContext: mcpCaller(),
			openApiPrincipal: { kind: 'token', token },
		},
	)
	expect(mintCliCredentialBootstrap.mock.calls[0]?.[0]).not.toHaveProperty(
		'orgBinding',
	)
})
