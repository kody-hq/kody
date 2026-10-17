import { createServerFn } from '@tanstack/react-start'
import { redirect, notFound } from '@tanstack/react-router'
import { z } from 'zod'
import { orgResourcePathForAccountPath } from '#universal/org-pages.ts'

/** Old account resource bookmarks now resolve to the authenticated person's signup org. */
export const resolveOrgAlias = createServerFn({ method: 'GET' })
	.validator(
		z
			.string()
			.refine(
				(href) => href.startsWith('/account/') && !href.includes('\\'),
				'Invalid account resource URL',
			),
	)
	.handler(async ({ data: href }) => {
		const [
			{ env },
			{ getEnv },
			{ getRequest, setResponseHeader },
			{ setAuthSessionSecret },
			{ loadSessionInfo },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('../../src/app/env.ts'),
			import('@tanstack/react-start/server'),
			import('../../src/app/auth-session.ts'),
			import('../../src/app/session-info.ts'),
		])
		const bindings = getEnv(env)
		setAuthSessionSecret(bindings.COOKIE_SECRET)
		const original = getRequest()
		const destination = new URL(href, original.url)
		setResponseHeader('Cache-Control', 'no-store')
		const { session, setCookie } = await loadSessionInfo(original, bindings)
		if (setCookie) setResponseHeader('Set-Cookie', setCookie)
		if (!session)
			throw redirect({ href: `/login?redirectTo=${encodeURIComponent(href)}` })
		const personal = session.organizations.find((org) => org.personal)
		if (!personal) throw notFound()
		const url = destination
		const path = orgResourcePathForAccountPath(
			url.pathname.replace(
				/^\/account\/connections(?=\/|$)/,
				'/account/agents',
			),
			personal.slug,
		)
		if (!path) throw notFound()
		throw redirect({ href: path + url.search + url.hash, statusCode: 302 })
	})
