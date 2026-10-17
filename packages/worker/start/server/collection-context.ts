import { createServerOnlyFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
import { type OrgOwnedAccountSection } from '#universal/org-pages.ts'

/** Resource scope is explicit. The request remains the authenticated RPC/document. */
export const loadScopedCollection = createServerOnlyFn(
	async (input: {
		orgSlug: string
		section: OrgOwnedAccountSection | 'billing' | 'usage'
		returnTo: string
	}) => {
		const [
			{ env },
			{ getRequest, setResponseHeader },
			{ getEnv },
			{ requireAuthenticatedPageUser },
			{ loadOrgBindingForSlug },
			{ deriveRequestContext },
			{ orgSectionDenial },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('@tanstack/react-start/server'),
			import('#app/env.ts'),
			import('#app/page-auth.ts'),
			import('#worker/orgs/repo.ts'),
			import('#worker/request-context/request-context.ts'),
			import('#app/org-request-binding.ts'),
		])
		const bindings = getEnv(env)
		const request = getRequest()
		const authenticated = await requireAuthenticatedPageUser(
			request,
			bindings,
			{ redirectTo: input.returnTo },
		)
		if (authenticated instanceof Response) {
			const cookies = authenticated.headers.getSetCookie()
			if (cookies.length) setResponseHeader('Set-Cookie', cookies)
			throw redirect({
				href: authenticated.headers.get('Location') ?? '/login',
				statusCode: authenticated.status,
			})
		}
		const binding = await loadOrgBindingForSlug(
			bindings.APP_DB,
			authenticated.mcpUser.userId,
			input.orgSlug,
		)
		if (
			!binding ||
			(input.section !== 'billing' &&
				input.section !== 'usage' &&
				orgSectionDenial(binding, input.section))
		)
			throw notFound()
		const user = {
			...authenticated,
			request: deriveRequestContext({
				user: authenticated.mcpUser,
				source: { kind: 'session' },
				orgBinding: binding,
			}),
		}

		setResponseHeader('Cache-Control', 'private, no-store')
		return { bindings, request, user }
	},
)

/** Person-owned settings have no workspace selector. */
export const loadPersonalCollection = createServerOnlyFn(
	async (returnTo: string) => {
		const [
			{ env },
			{ getRequest, setResponseHeader },
			{ getEnv },
			{ requireAuthenticatedPageUser },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('@tanstack/react-start/server'),
			import('#app/env.ts'),
			import('#app/page-auth.ts'),
		])
		const bindings = getEnv(env)
		const request = getRequest()
		const user = await requireAuthenticatedPageUser(request, bindings, {
			redirectTo: returnTo,
		})
		if (user instanceof Response) {
			const cookies = user.headers.getSetCookie()
			if (cookies.length) setResponseHeader('Set-Cookie', cookies)
			throw redirect({
				href: user.headers.get('Location') ?? '/login',
				statusCode: user.status,
			})
		}
		setResponseHeader('Cache-Control', 'private, no-store')
		return { bindings, request, user }
	},
)
