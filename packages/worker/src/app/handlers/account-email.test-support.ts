import { loadAccountEmailData } from '#app/account-email-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	AuthorizationError,
	authorize,
} from '#worker/authorization/authorize.ts'
import {
	classifyAccountEmailMessage,
	deleteAccountEmailMessage,
} from './account-email.ts'
export * from './account-email.ts'
export function testAccountEmailApiHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}
			try {
				await authorize({ env, request: user.request }, 'email:read')
			} catch (error) {
				if (!(error instanceof AuthorizationError)) throw error
				return operationResult({ ok: false, error: error.message }, 403)
			}

			if (request.method === 'GET') {
				return operationResult(
					await loadAccountEmailData({ env, request, user }),
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

			const context = {
				env,
				user,
				messageId: '',
			}
			const fields = body as Record<string, unknown>
			context.messageId =
				typeof fields.message_id === 'string' ? fields.message_id.trim() : ''
			const result =
				fields.action === 'delete'
					? await deleteAccountEmailMessage(context)
					: fields.action === 'classify' &&
						  (fields.classification === 'accepted' ||
								fields.classification === 'quarantined')
						? await classifyAccountEmailMessage({
								...context,
								classification: fields.classification,
							})
						: operationResult(
								{
									ok: false,
									error:
										fields.action === 'classify'
											? 'Classification must be accepted or quarantined.'
											: 'Invalid action.',
								},
								400,
							)

			return operationResult(result.data, result.status)
		},
	}
}
