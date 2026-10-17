import { loadAccountProfileData } from '#app/account-profile-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { saveAccountProfile } from './account-profile.ts'
export * from './account-profile.ts'
export function testAccountProfileApiHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return operationResult(await loadAccountProfileData(user, env))
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

			try {
				return operationResult(
					await saveAccountProfile({
						env,
						request,
						user,
						body: body as Record<string, unknown>,
					}),
				)
			} catch (error) {
				return operationResult(
					{
						ok: false,
						error:
							error instanceof Error
								? error.message
								: 'Unable to save profile.',
					},
					400,
				)
			}
		},
	}
}
