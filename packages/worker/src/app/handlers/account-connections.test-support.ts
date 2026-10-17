import { isOauthProviderId } from '#app/oauth-providers.ts'
import { loadAccountConnectionsData } from '#app/account-connections-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	disconnectAccountProvider,
	syncAccountDiscordRole,
} from './account-connections.ts'
export * from './account-connections.ts'
export function testAccountConnectionsApiHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return operationResult(
					await loadAccountConnectionsData({ env, userId: user.userId }),
				)
			}

			if (request.method !== 'POST') {
				return operationResult({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			const fields =
				body && typeof body === 'object'
					? (body as Record<string, unknown>)
					: {}
			const context = { request, env, user }
			const result =
				fields.intent === 'sync-discord-role'
					? await syncAccountDiscordRole(context)
					: fields.intent === 'disconnect' &&
						  typeof fields.provider === 'string' &&
						  isOauthProviderId(fields.provider)
						? await disconnectAccountProvider({
								...context,
								provider: fields.provider,
							})
						: operationResult(
								{ ok: false, error: 'Invalid request body.' },
								400,
							)

			return operationResult(result.data, result.status)
		},
	}
}
