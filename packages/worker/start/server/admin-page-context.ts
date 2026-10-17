import {
	getRequest,
	setResponseHeader,
	setResponseStatus,
} from '@tanstack/react-start/server'
import { redirect } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { getEnv } from '../../src/app/env.ts'
import { setAuthSessionSecret } from '../../src/app/auth-session.ts'
import { readAuthenticatedAppUser } from '../../src/app/authenticated-user.ts'
import { loadResolvedRequestAuth } from '../../src/app/request-auth-cache.ts'
import { userHasRole } from '../../universal/permissions.ts'

/** Admin page authorization uses the RPC principal and an explicit navigation target. */
export async function readAdminPageContext(href: string) {
	if (!/^\/admin(?:\/|$)/.test(href) || href.includes('\\'))
		throw new Error('Invalid admin destination')
	const bindings = getEnv(env)
	setAuthSessionSecret(bindings.COOKIE_SECRET)
	setResponseHeader('Cache-Control', 'private, no-store')
	const request = getRequest()
	const url = new URL(href, request.url)
	const authenticated = await readAuthenticatedAppUser(request, bindings, {
		prefetchFeatureFlags: true,
	})
	if (!authenticated) {
		const { setCookie } = await loadResolvedRequestAuth(request, bindings)
		if (setCookie) setResponseHeader('Set-Cookie', setCookie)
		throw redirect({
			href: `/login?${new URLSearchParams({ redirectTo: url.pathname + url.search })}`,
			statusCode: 302,
		})
	}
	const user = userHasRole(authenticated, 'admin') ? authenticated : null
	if (!user) setResponseStatus(403)
	return { bindings, request, url, user }
}
