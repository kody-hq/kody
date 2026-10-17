import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
import { docHref, resolveLegacyDocSlug } from '#universal/docs-nav.ts'

export const loadDoc = createServerFn({ method: 'GET' })
	.validator((data: { slug: string; search?: string }) => {
		if (
			typeof data.slug !== 'string' ||
			!data.slug ||
			data.slug.includes('/') ||
			data.slug.includes('.')
		)
			throw notFound()
		return {
			slug: data.slug,
			search: typeof data.search === 'string' ? data.search : '',
		}
	})
	.handler(async ({ data }) => {
		const alias = resolveLegacyDocSlug(data.slug)
		if (alias.slug !== data.slug)
			throw redirect({
				href: `${docHref(alias.slug)}${data.search}${alias.fragment ? `#${alias.fragment}` : ''}`,
				statusCode: 308,
				headers: { 'Cache-Control': 'public, max-age=3600' },
			})
		const [
			{ env },
			{ getEnv },
			{ getRequest, setResponseHeader },
			{ setAuthSessionSecret },
			{ loadAccessibleDocDetail },
			{ loadSessionInfo },
			{ loadDocumentHead },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('../../src/app/env.ts'),
			import('@tanstack/react-start/server'),
			import('../../src/app/auth-session.ts'),
			import('../../src/app/handlers/docs.ts'),
			import('../../src/app/session-info.ts'),
			import('./document-head.ts'),
		])
		const bindings = getEnv(env)
		setAuthSessionSecret(bindings.COOKIE_SECRET)
		const request = getRequest()
		// The envelope includes the viewer session, so it must never enter a shared cache.
		setResponseHeader('Cache-Control', 'private, no-store')
		const detail = await loadAccessibleDocDetail(request, bindings, data.slug)
		if (!detail) throw notFound()
		const { doc } = detail
		const { session, setCookie } = await loadSessionInfo(request, bindings)
		if (setCookie) setResponseHeader('Set-Cookie', setCookie)
		return {
			doc,
			session,
			head: loadDocumentHead('docDetail', docHref(doc.slug), {
				docDetail: doc,
			}),
		}
	})

export const loadDocsConnect = createServerFn({ method: 'GET' }).handler(
	async () => {
		const [
			{ listProviderGuides, toGuideSummary },
			{ env },
			{ getEnv },
			{ getRequest },
			{ requestIsDocsAdmin },
			{ setAuthSessionSecret },
			{ loadDocumentHead },
		] = await Promise.all([
			import('../../src/guides/catalog.ts'),
			import('cloudflare:workers'),
			import('../../src/app/env.ts'),
			import('@tanstack/react-start/server'),
			import('../../src/app/docs-access.ts'),
			import('../../src/app/auth-session.ts'),
			import('./document-head.ts'),
		])
		const bindings = getEnv(env)
		setAuthSessionSecret(bindings.COOKIE_SECRET)
		const data = {
			ok: true as const,
			guides: listProviderGuides().map(toGuideSummary),
		}
		return {
			data,
			isAdmin: await requestIsDocsAdmin(getRequest(), bindings),
			head: loadDocumentHead('docsConnect', '/docs/connect', {
				docsConnect: data,
			}),
		}
	},
)
