import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
import { routes } from '#universal/routes.ts'
function validate(data: { username: string; kodyId: string; search?: string }) {
	if (
		!data ||
		typeof data.username !== 'string' ||
		!data.username ||
		typeof data.kodyId !== 'string' ||
		!data.kodyId ||
		(data.search !== undefined &&
			(typeof data.search !== 'string' ||
				(data.search !== '' && !data.search.startsWith('?')) ||
				data.search.includes('#')))
	)
		throw notFound()
	return data
}
async function review(data: ReturnType<typeof validate>) {
	const [
		{ env },
		{ getEnv },
		{ getRequest, setResponseHeader },
		{ setAuthSessionSecret },
		{ requireAuthenticatedPageUser },
		{ loadPackagePage },
		{ loadAccountPackageApproveCapabilitiesData },
		{ loadDocumentHead },
	] = await Promise.all([
		import('cloudflare:workers'),
		import('../../src/app/env.ts'),
		import('@tanstack/react-start/server'),
		import('../../src/app/auth-session.ts'),
		import('../../src/app/page-auth.ts'),
		import('../../src/app/package-page.ts'),
		import('../../src/app/account-package-capability-approval.ts'),
		import('./document-head.ts'),
	])
	const bindings = getEnv(env)
	setAuthSessionSecret(bindings.COOKIE_SECRET)
	const original = getRequest()
	const url = new URL(
		routes.communityPackageApproveCapabilities.href(data),
		original.url,
	)
	url.search = data.search ?? ''
	setResponseHeader('Cache-Control', 'private, no-store')
	const user = await requireAuthenticatedPageUser(original, bindings, {
		redirectTo: `${url.pathname}${url.search}`,
	})
	if (user instanceof Response) {
		const cookies = user.headers.getSetCookie()
		if (cookies.length) setResponseHeader('Set-Cookie', cookies)
		throw redirect({
			href: user.headers.get('Location') ?? '/login',
			statusCode: user.status,
		})
	}
	const page = await loadPackagePage({
		env: bindings,
		request: original,
		username: data.username,
		kodyId: data.kodyId,
	})
	if (page.kind === 'redirect') {
		const destination = new URL(`${page.to}/approve-capabilities`, url)
		destination.search = url.search
		setResponseHeader('Cache-Control', 'private, no-store')
		throw redirect({ href: destination.toString(), statusCode: 302 })
	}
	if (page.kind !== 'page' || !page.viewerCanManage || !page.ownerPackage)
		throw notFound()
	const payload = await loadAccountPackageApproveCapabilitiesData({
		env: bindings,
		request: original,
		user,
		packageId: page.ownerPackage.id,
	})
	if (!payload.ok) throw notFound()
	return {
		payload,
		head: loadDocumentHead(
			'communityPackageApproveCapabilities',
			url.pathname,
			{
				accountPackageApproveCapabilities: payload,
			},
		),
	}
}

export const loadCapabilityReview = createServerFn({ method: 'GET' })
	.validator(validate)
	.handler(async ({ data }) => review(data))
