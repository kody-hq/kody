import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { changeAccountPassword } from './account-password.ts'
export function testAccountPasswordHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}

			let body: unknown
			try {
				body = await request.json()
			} catch {
				return operationResult(
					{ ok: false, error: 'Invalid JSON payload.' },
					400,
				)
			}

			const result = await changeAccountPassword({ env, request, user, body })
			const headers = new Headers()
			if (result.sessionCookie)
				headers.append('Set-Cookie', result.sessionCookie)
			if (result.retryAfter) headers.set('Retry-After', result.retryAfter)
			return operationResult(result.payload, {
				status: result.status,
				headers,
			})
		},
	}
}
