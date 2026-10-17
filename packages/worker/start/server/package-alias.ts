import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
export const loadAccountPackageAlias = createServerFn({ method: 'GET' })
	.validator(
		(data: {
			packageId: string
			approval?: 'publish' | 'capabilities'
			search: string
		}) => {
			if (
				!data ||
				typeof data.packageId !== 'string' ||
				!data.packageId ||
				typeof data.search !== 'string' ||
				(data.search !== '' && !data.search.startsWith('?')) ||
				(data.approval !== undefined &&
					data.approval !== 'publish' &&
					data.approval !== 'capabilities')
			)
				throw notFound()
			return data
		},
	)
	.handler(async ({ data }) => {
		const [
			{ env },
			{ getEnv },
			{ getRequest, setResponseHeader },
			{ setAuthSessionSecret },
			{ requireAuthenticatedPageUser },
			{ getSavedPackageByIdInAnyOrg },
			{ viewerCanReadSavedPackage, viewerCanManageSavedPackage },
			{ loadOrgBindingForOrg },
			{ routes },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('../../src/app/env.ts'),
			import('@tanstack/react-start/server'),
			import('../../src/app/auth-session.ts'),
			import('../../src/app/page-auth.ts'),
			import('../../src/package-registry/repo.ts'),
			import('../../src/app/package-viewer-access.ts'),
			import('../../src/orgs/repo.ts'),
			import('../../universal/routes.ts'),
		])
		const bindings = getEnv(env)
		setAuthSessionSecret(bindings.COOKIE_SECRET)
		const path =
			routes.accountPackageDetail.href({ packageId: data.packageId }) +
			(data.approval ? `/approve-${data.approval}` : '')
		const user = await requireAuthenticatedPageUser(getRequest(), bindings, {
			redirectTo: path + data.search,
		})
		if (user instanceof Response) {
			const cookie = user.headers.get('Set-Cookie')
			if (cookie) setResponseHeader('Set-Cookie', cookie)
			const location = user.headers.get('Location')
			if (location) throw redirect({ href: location, statusCode: user.status })
			throw notFound()
		}
		const saved = await getSavedPackageByIdInAnyOrg(
			bindings.APP_DB,
			data.packageId,
		)
		if (!saved) throw notFound()
		const canAccess = data.approval
			? viewerCanManageSavedPackage
			: viewerCanReadSavedPackage
		if (
			!(await canAccess({
				env: bindings,
				viewer: user.mcpUser,
				ownerId: saved.userId,
				packageId: saved.id,
			}))
		)
			throw notFound()
		const binding = await loadOrgBindingForOrg(
			bindings.APP_DB,
			user.mcpUser.userId,
			saved.userId,
		)

		setResponseHeader('Cache-Control', 'private, no-store')
		throw redirect({
			href:
				routes.communityPackage.href({
					username: binding?.org.slug ?? user.username,
					kodyId: saved.kodyId,
				}) +
				(data.approval ? `/approve-${data.approval}` : '') +
				data.search,
			statusCode: 302,
		})
	})
