import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
import { routes } from '#universal/routes.ts'
function validate(data: { username: string; kodyId: string; commit?: string }) {
	if (
		!data ||
		typeof data.username !== 'string' ||
		!data.username ||
		typeof data.kodyId !== 'string' ||
		!data.kodyId ||
		(data.commit !== undefined && typeof data.commit !== 'string')
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
		{ loadAccountPackageApprovePublishData },
		{ loadDocumentHead },
	] = await Promise.all([
		import('cloudflare:workers'),
		import('../../src/app/env.ts'),
		import('@tanstack/react-start/server'),
		import('../../src/app/auth-session.ts'),
		import('../../src/app/page-auth.ts'),
		import('../../src/app/package-page.ts'),
		import('../../src/app/account-package-publish-lock.ts'),
		import('./document-head.ts'),
	])
	const bindings = getEnv(env)
	setAuthSessionSecret(bindings.COOKIE_SECRET)
	const original = getRequest()
	const url = new URL(
		routes.communityPackageApprovePublish.href(data),
		original.url,
	)
	if (data.commit) url.searchParams.set('commit', data.commit)
	const request = original
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
		const destination = new URL(`${page.to}/approve-publish`, url)
		destination.search = url.search
		setResponseHeader('Cache-Control', 'private, no-store')
		throw redirect({ href: destination.toString(), statusCode: 302 })
	}
	if (page.kind !== 'page' || !page.viewerCanManage || !page.ownerPackage)
		throw notFound()
	const payload = await loadAccountPackageApprovePublishData({
		env: bindings,
		request,
		user,
		packageId: page.ownerPackage.id,
		commit: data.commit ?? '',
	})
	if (!payload.ok) throw notFound()
	return {
		payload,
		head: loadDocumentHead('communityPackageApprovePublish', url.pathname, {
			accountPackageApprovePublish: payload,
		}),
	}
}

export const loadPublishReview = createServerFn({ method: 'GET' })
	.validator(validate)
	.handler(async ({ data }) => review(data))
