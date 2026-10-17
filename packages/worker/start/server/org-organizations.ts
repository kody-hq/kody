import { redirect } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

async function accountContext() {
	const [
		{ env },
		{ getEnv },
		{ getRequest, setResponseHeader },
		{ setAuthSessionSecret },
		{ requireAuthenticatedPageUser },
	] = await Promise.all([
		import('cloudflare:workers'),
		import('../../src/app/env.ts'),
		import('@tanstack/react-start/server'),
		import('../../src/app/auth-session.ts'),
		import('../../src/app/page-auth.ts'),
	])
	const bindings = getEnv(env)
	setAuthSessionSecret(bindings.COOKIE_SECRET)
	const request = getRequest()
	setResponseHeader('Cache-Control', 'no-store')
	const user = await requireAuthenticatedPageUser(request, bindings, {
		redirectTo: '/account/organizations',
	})
	if (user instanceof Response) {
		const cookies = user.headers.getSetCookie()
		if (cookies.length) setResponseHeader('Set-Cookie', cookies)
		throw redirect({ href: user.headers.get('Location') ?? '/login' })
	}
	return { env: bindings, request, user }
}
export const loadOrganizations = createServerFn({ method: 'GET' }).handler(
	async () => {
		const { env, user } = await accountContext()
		const { loadAccountOrganizationsData } =
			await import('../../src/app/handlers/account-organizations.ts')
		return loadAccountOrganizationsData(env, user)
	},
)
export const createOrg = createServerFn({ method: 'POST' })
	.validator(z.object({ displayName: z.string(), slug: z.string() }))
	.handler(async ({ data }) => {
		const [{ withWebsiteMutation }, { createWebsiteOrganization }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/app/handlers/account-organizations.ts'),
			])
		return withWebsiteMutation({}, (context) =>
			createWebsiteOrganization({ ...context, ...data }),
		)
	})

export const restoreOrganization = createServerFn({ method: 'POST' })
	.validator(
		z.strictObject({
			orgSlug: z
				.string()
				.trim()
				.regex(/^[a-zA-Z0-9_-]+$/),
		}),
	)
	.handler(async ({ data }) => {
		const [{ withWebsiteMutation }, { restoreWebsiteOrganization }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/app/handlers/account-organizations.ts'),
			])
		return withWebsiteMutation({}, (context) =>
			restoreWebsiteOrganization({ ...context, ...data }),
		)
	})
