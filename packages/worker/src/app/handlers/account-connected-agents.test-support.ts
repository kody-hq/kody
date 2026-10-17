import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	loadAccountConnectedAgentsData,
	revokeAccountConnectedAgent,
	createConnectedAgentProfile,
	updateConnectedAgentProfile,
	deleteConnectedAgentProfile,
} from './account-connected-agents.ts'
export * from './account-connected-agents.ts'
export function testAccountConnectedAgentsApiHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return operationResult(
					await loadAccountConnectedAgentsData({
						env,
						requestUrl: request.url,
						user,
					}),
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
				fields.intent === 'revoke' && typeof fields.clientId === 'string'
					? await revokeAccountConnectedAgent({
							...context,
							clientId: fields.clientId.trim(),
						})
					: fields.intent === 'create'
						? await createConnectedAgentProfile({
								...context,
								name: typeof fields.name === 'string' ? fields.name : '',
								grants: fields.grants,
							})
						: fields.intent === 'update' &&
							  typeof fields.profileId === 'string' &&
							  fields.profileId.trim()
							? await updateConnectedAgentProfile({
									...context,
									profileId: fields.profileId.trim(),
									name:
										typeof fields.name === 'string' ? fields.name : undefined,
									grants: fields.grants,
								})
							: fields.intent === 'delete' &&
								  typeof fields.profileId === 'string' &&
								  fields.profileId.trim()
								? await deleteConnectedAgentProfile({
										...context,
										profileId: fields.profileId.trim(),
									})
								: operationResult(
										{ ok: false, error: 'Invalid request body.' },
										400,
									)

			return operationResult(result.data, result.status)
		},
	}
}
