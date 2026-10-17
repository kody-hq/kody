import { z } from 'zod'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	loadPasskeysPayload,
	deleteAccountPasskey,
	renameAccountPasskey,
} from './account-passkeys.ts'
export function testAccountPasskeysApiHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return operationResult(
					await loadPasskeysPayload(env.APP_DB, user.userId),
				)
			}

			if (request.method !== 'POST') {
				return operationResult({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = z
				.object({
					intent: z.enum(['delete', 'rename']),
					passkeyId: z.string(),
					name: z.string().optional(),
				})
				.parse(await request.json())
			const result = await (async () => {
				switch (body?.intent) {
					case 'delete':
						return deleteAccountPasskey({
							env,
							request,
							user,
							passkeyId: body.passkeyId,
						})
					case 'rename':
						return renameAccountPasskey({
							env,
							request,
							user,
							passkeyId: body.passkeyId,
							name: body.name,
						})
					default:
						throw new Error('Unsupported security fixture intent')
				}
			})()
			return operationResult(
				result,
				result.ok
					? 200
					: 'code' in result && result.code === 'not_found'
						? 404
						: 400,
			)
		},
	}
}
