import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { cliCredentialBootstrapCapability } from './cli-credential-bootstrap.ts'

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
