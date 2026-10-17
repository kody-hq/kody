import { createServerFn } from '@tanstack/react-start'
import { redirect } from '@tanstack/react-router'

export const loadAccountSecurity = createServerFn({ method: 'GET' })
	.validator((page: 'passkeys' | 'two-factor') => {
		if (page !== 'passkeys' && page !== 'two-factor')
			throw new Error('Unknown security page')
		return page
	})
	.handler(async ({ data: page }) => {
		const [
			{ env },
			{ getRequest, setResponseHeader },
			{ getEnv },
			{ setAuthSessionSecret },
			{ requireAuthenticatedPageUser },
			{ loadPasskeysPayload },
			{ loadTwoFactorStatus },
			{ loadDocumentHead },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('@tanstack/react-start/server'),
			import('../../src/app/env.ts'),
			import('../../src/app/auth-session.ts'),
			import('../../src/app/page-auth.ts'),
			import('../../src/app/handlers/account-passkeys.ts'),
			import('../../src/app/handlers/account-two-factor.ts'),
			import('./document-head.ts'),
		])
		const bindings = getEnv(env)
		setAuthSessionSecret(bindings.COOKIE_SECRET)
		const path = `/account/${page}`
		const user = await requireAuthenticatedPageUser(getRequest(), bindings, {
			redirectTo: path,
		})
		if (user instanceof Response) {
			const cookie = user.headers.get('Set-Cookie')
			if (cookie) setResponseHeader('Set-Cookie', cookie)
			throw redirect({
				href: user.headers.get('Location') ?? '/login',
				statusCode: user.status,
			})
		}
		return page === 'passkeys'
			? {
					page,
					payload: await loadPasskeysPayload(bindings.APP_DB, user.userId),
					head: loadDocumentHead('accountPasskeys', path),
				}
			: {
					page,
					payload: await loadTwoFactorStatus(bindings.APP_DB, user.userId),
					head: loadDocumentHead('accountTwoFactor', path),
				}
	})
