import { z } from 'zod'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	loadTwoFactorStatus,
	startAccountTwoFactorSetup,
	confirmAccountTwoFactorSetup,
	cancelAccountTwoFactorSetup,
	disableAccountTwoFactor,
} from './account-two-factor.ts'
export function testAccountTwoFactorApiHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return operationResult(
					await loadTwoFactorStatus(env.APP_DB, user.userId),
				)
			}

			if (request.method !== 'POST') {
				return operationResult({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = z
				.object({
					intent: z.enum(['setup', 'confirm', 'cancel', 'disable']),
					code: z.string().optional(),
				})
				.parse(await request.json())
			const result = await (async () => {
				switch (body?.intent) {
					case 'setup':
						return startAccountTwoFactorSetup({ env, request, user })
					case 'confirm':
						return confirmAccountTwoFactorSetup({
							env,
							request,
							user,
							code: typeof body.code === 'string' ? body.code : '',
						})
					case 'cancel':
						return cancelAccountTwoFactorSetup({ env, request, user })
					case 'disable':
						return disableAccountTwoFactor({
							env,
							request,
							user,
							code: typeof body.code === 'string' ? body.code : '',
						})
					default:
						throw new Error('Unsupported security fixture intent')
				}
			})()
			return operationResult(result, result.ok ? 200 : 400)
		},
	}
}
