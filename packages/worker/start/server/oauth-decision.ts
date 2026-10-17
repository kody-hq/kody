import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { type OAuthDecisionData } from '../../src/oauth-handlers.ts'

export const submitOAuthDecision = createServerFn({ method: 'POST' })
	.inputValidator(
		z
			.object({
				search: z
					.string()
					.refine((search) => search === '' || search.startsWith('?')),
				fields: z.record(z.string(), z.string()),
			})
			.refine((input) =>
				['approve', 'deny', 'reset-client'].includes(
					input.fields.decision ?? '',
				),
			),
	)
	.handler(
		async ({ data }): Promise<OAuthDecisionData & { successful: boolean }> => {
			const [
				{ publicAuthContext },
				{ decideOAuthAuthorization },
				{ checkPublicFormProtection },
				{ withAccountRequestWriteLease },
			] = await Promise.all([
				import('./auth-mutation-context.ts'),
				import('../../src/oauth-handlers.ts'),
				import('../../src/app/public-form-protection.ts'),
				import('../../src/app/account-write-lease-middleware.ts'),
			])
			const { request, env } = await publicAuthContext()
			const authorizeUrl = new URL('/oauth/authorize', request.url)
			authorizeUrl.search = data.search
			// Use the original RPC request for identity, cookies, origin and IP checks.
			if ('email' in data.fields || 'password' in data.fields) {
				const protection = await checkPublicFormProtection({
					env,
					request,
					body: data.fields,
				})
				if (!protection.ok) {
					if (protection.status) {
						const { setResponseStatus } =
							await import('@tanstack/react-start/server')
						setResponseStatus(protection.status)
					}
					return {
						successful: false,
						ok: false,
						error: protection.error,
					}
				}
			}
			const formData = new FormData()
			for (const [key, value] of Object.entries(data.fields))
				formData.set(key, value)
			const result = await withAccountRequestWriteLease(request, env, () =>
				decideOAuthAuthorization({ request, env, authorizeUrl, formData }),
			)
			if (result instanceof Response) {
				const { setResponseStatus } =
					await import('@tanstack/react-start/server')
				setResponseStatus(result.status)
				throw new Error(
					'Account deletion is in progress; user-owned writes are disabled.',
				)
			}
			const { setResponseHeader } = await import('@tanstack/react-start/server')
			const cookies = result.headers.getSetCookie()
			if (cookies.length) setResponseHeader('Set-Cookie', cookies)
			const retryAfter = result.headers.get('Retry-After')
			if (retryAfter) setResponseHeader('Retry-After', retryAfter)
			return { ...result.data, successful: result.status < 400 }
		},
	)
