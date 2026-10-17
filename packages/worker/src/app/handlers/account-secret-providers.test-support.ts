import { loadAccountSecretProvidersData } from '#app/account-secret-providers-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	bindAccountSecretProvider,
	unbindAccountSecretProvider,
	grantAccountSecretProvider,
	revokeAccountSecretProvider,
} from './account-secret-providers.ts'
export * from './account-secret-providers.ts'
export function testAccountSecretProvidersApiHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}
			if (request.method === 'GET') {
				return operationResult(
					await loadAccountSecretProvidersData({
						env,
						userId: ownerIdFromCaller({
							request: user.request,
							user: user.mcpUser,
						}),
						email: user.email,
						approval: {
							provider:
								new URL(request.url).searchParams.get('provider') ?? undefined,
							ref: new URL(request.url).searchParams.get('ref') ?? undefined,
							packageId:
								new URL(request.url).searchParams.get('package_id') ??
								undefined,
							packageName:
								new URL(request.url).searchParams.get('package') ?? undefined,
						},
					}),
				)
			}
			if (request.method !== 'POST') {
				return operationResult({ ok: false, error: 'Method not allowed.' }, 405)
			}
			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object') {
				return operationResult(
					{ ok: false, error: 'Invalid request body.' },
					400,
				)
			}
			const values = body as Record<string, unknown>
			const field = (key: string) =>
				typeof values[key] === 'string' ? values[key].trim() : ''
			const input = {
				env,
				user,
				provider: field('provider'),
				packageId: field('packageId'),
				ref: field('ref'),
			}
			let result
			try {
				switch (values.action) {
					case 'bind':
						result = await bindAccountSecretProvider({
							...input,
							requestUrl: request.url,
							doorSecretName: field('doorSecretName'),
							config: Object.fromEntries(
								Object.entries(
									values.config && typeof values.config === 'object'
										? values.config
										: {},
								).filter(
									(entry): entry is [string, string] =>
										typeof entry[1] === 'string',
								),
							),
						})
						break
					case 'unbind':
						result = await unbindAccountSecretProvider(input)
						break
					case 'grant':
						result = await grantAccountSecretProvider(input)
						break
					case 'revoke':
						result = await revokeAccountSecretProvider(input)
						break
					default:
						return operationResult({ ok: false, error: 'Invalid action.' }, 400)
				}
			} catch (error) {
				return operationResult(
					{
						ok: false,
						error:
							error instanceof Error
								? error.message
								: 'Unable to update secret providers.',
					},
					400,
				)
			}

			return operationResult(result.data, result.status)
		},
	}
}
