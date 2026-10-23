import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { cliCredentialBootstrapCapability } from './cli-credential-bootstrap.ts'

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
