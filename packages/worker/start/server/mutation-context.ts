import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { getStartRequestEnv } from './request-env.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadResolvedRequestAuth } from '#app/request-auth-cache.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'

type WebsiteScope = { scope?: { orgSlug: string; requireMembership?: boolean } }
type WebsiteContext = {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
}

export class WebsiteAuthenticationError extends Error {
	constructor() {
		super('Please sign in again.')
		this.name = 'WebsiteAuthenticationError'
	}
}

/** Explicit scope is checked against the session principal, never the Referer. */
async function websiteContext(options: WebsiteScope): Promise<WebsiteContext> {
	const request = getRequest()
	const env = getStartRequestEnv()
	setResponseHeader('Cache-Control', 'private, no-store')
	const authenticated = await readAuthenticatedAppUser(request, env)
	const resolved = await loadResolvedRequestAuth(request, env)
	if (resolved.setCookie) setResponseHeader('Set-Cookie', resolved.setCookie)
	if (!authenticated) throw new WebsiteAuthenticationError()
	// Request auth is cached. Never mutate it while binding an independent operation.
	const user = { ...authenticated }
	if (options.scope) {
		const { orgSlug, requireMembership = true } = options.scope
		if (!/^[a-zA-Z0-9_-]+$/.test(orgSlug))
			throw new Error('Organization not found.')
		const binding = await loadOrgBindingForSlug(
			env.APP_DB,
			user.mcpUser.userId,
			orgSlug,
		)
		if (!binding || (requireMembership && binding.role == null))
			throw new Error('Organization not found.')
		user.request = deriveRequestContext({
			user: user.mcpUser,
			source: { kind: 'session' },
			orgBinding: binding,
		})
	}
	return { request, env, user }
}
export async function withWebsiteRead<T>(
	options: WebsiteScope,
	read: (context: WebsiteContext) => Promise<T>,
): Promise<T> {
	return read(await websiteContext(options))
}
export async function withWebsiteMutation<T>(
	options: WebsiteScope,
	write: (context: WebsiteContext) => Promise<T>,
): Promise<T> {
	const context = await websiteContext(options)
	const { request, env, user } = context
	const auth = await loadResolvedRequestAuth(request, env)
	if (auth.user?.accountDeleting)
		throw new Error('Account deletion is in progress.')
	return withAccountWriteLease({
		db: env.APP_DB,
		stableUserId: personalOrgIdForPerson(user.mcpUser),
		holder: 'website:server-function',
		env,
		write: () => write(context),
	})
}
