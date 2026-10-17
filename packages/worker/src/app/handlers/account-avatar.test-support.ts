import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { updateAccountAvatar } from './account-avatar.ts'
export * from './account-avatar.ts'
export function testAccountAvatarApiPostHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method !== 'POST') {
				return operationResult({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const contentType = request.headers.get('Content-Type') ?? ''

			if (contentType.includes('application/json')) {
				const body = await request.json().catch(() => null)
				if (
					!body ||
					typeof body !== 'object' ||
					(body as Record<string, unknown>).remove !== true
				) {
					return operationResult(
						{ ok: false, error: 'Invalid request body.' },
						400,
					)
				}

				return operationResult(
					await updateAccountAvatar({ env, user, request, avatar: null }),
				)
			}

			let formData: FormData
			try {
				formData = await request.formData()
			} catch {
				return operationResult(
					{
						ok: false,
						error: 'Expected multipart form data with an avatar file.',
					},
					400,
				)
			}

			const avatar = formData.get('avatar')
			if (!(avatar instanceof File) || avatar.size === 0) {
				return operationResult(
					{ ok: false, error: 'Avatar file is required.' },
					400,
				)
			}

			try {
				return operationResult(
					await updateAccountAvatar({ env, user, request, avatar }),
				)
			} catch (error) {
				return operationResult(
					{
						ok: false,
						error:
							error instanceof Error ? error.message : 'Unable to save avatar.',
					},
					400,
				)
			}
		},
	}
}
