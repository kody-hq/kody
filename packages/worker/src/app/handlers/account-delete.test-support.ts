import { readAuthenticatedAppUserForDeletion } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { deleteAccount } from './account-delete.ts'
export function testAccountDeleteHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUserForDeletion(request, env)
			if (!user) {
				return operationResult(
					{ error: 'Authentication required.' },
					{ status: 401 },
				)
			}

			let body: unknown
			try {
				body = await request.json()
			} catch {
				return operationResult(
					{ error: 'Invalid JSON payload.' },
					{ status: 400 },
				)
			}

			const result = await deleteAccount({ env, request, user, body })
			return operationResult(result.payload, {
				status: result.status,
				headers: result.sessionCookie
					? { 'Set-Cookie': result.sessionCookie }
					: {},
			})
		},
	}
}
