import { loadAccountExperimentsData } from '#app/account-experiments-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { saveExperimentsPreference } from './account-experiments.ts'
export * from './account-experiments.ts'
export function testAccountExperimentsApiHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return operationResult(
					await loadAccountExperimentsData({
						db: env.APP_DB,
						userId: user.userId,
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

			if (
				!('experimentsOptIn' in body) ||
				typeof body.experimentsOptIn !== 'boolean'
			) {
				return operationResult(
					{ ok: false, error: 'experimentsOptIn must be a boolean.' },
					400,
				)
			}
			const result = await saveExperimentsPreference({
				request,
				env,
				user,
				experimentsOptIn: body.experimentsOptIn,
			})
			return operationResult(result.data, result.status)
		},
	}
}
