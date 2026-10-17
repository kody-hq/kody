import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	loadClientsPayload,
	createAccountMcpOauthClient,
	revokeAccountMcpOauthClient,
} from './account-mcp-oauth-clients.ts'
export * from './account-mcp-oauth-clients.ts'
export function testAccountMcpOauthClientsApiHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return operationResult(
					await loadClientsPayload(env.APP_DB, user.userId),
				)
			}

			if (request.method !== 'POST') {
				return operationResult({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object')
				return operationResult(
					{ ok: false, error: 'Invalid request body.' },
					400,
				)
			const fields = body as Record<string, unknown>
			const context = { request, env, user }
			const result =
				fields.intent === 'create' &&
				(fields.label === undefined || typeof fields.label === 'string') &&
				(fields.redirectUris === undefined ||
					typeof fields.redirectUris === 'string')
					? await createAccountMcpOauthClient({
							...context,
							label: typeof fields.label === 'string' ? fields.label : '',
							redirectUris:
								typeof fields.redirectUris === 'string'
									? fields.redirectUris
									: '',
						})
					: fields.intent === 'revoke' &&
						  (fields.id === undefined || typeof fields.id === 'string')
						? await revokeAccountMcpOauthClient({
								...context,
								id: typeof fields.id === 'string' ? fields.id : '',
							})
						: operationResult(
								{ ok: false, error: 'Invalid request body.' },
								400,
							)

			return operationResult(result.data, result.status)
		},
	}
}
