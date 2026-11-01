import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
import {
	packageAppConnectedPeopleInput,
	revokePackageAppConnectedPersonInput,
} from '#universal/package-access-mutations.ts'
import {
	packageAppConnectedPeopleHref,
	type PackageAppConnectedPeopleLoaderData,
} from '#universal/package-app-connected-people.ts'
import { parseRouteInput } from './route-input.ts'
import { type z } from 'zod'

export const loadPackageAppConnectedPeople = createServerFn({ method: 'GET' })
	.validator((data: z.input<typeof packageAppConnectedPeopleInput>) =>
		parseRouteInput(packageAppConnectedPeopleInput, data),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteRead, WebsiteAuthenticationError },
			{ loadPackagePage, packagePageIsPrivate },
			{ readPackageAppConnectedPeople },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/package-page.ts'),
			import('../../src/app/handlers/package-app-connected-people.ts'),
			import('./document-head.ts'),
		])
		const href = packageAppConnectedPeopleHref(data)
		try {
			return await withWebsiteRead({}, async ({ request, env, user }) => {
				const page = await loadPackagePage({
					env,
					request,
					username: data.username,
					kodyId: data.kodyId,
				})
				if (page.kind === 'no_access') {
					const { packageNoAccessResult } =
						await import('./package-no-access.ts')
					return { ...packageNoAccessResult(page, href), payload: null }
				}
				if (page.kind === 'redirect')
					throw redirect({
						href: `${page.to}/connected-people`,
						statusCode: 302,
					})
				if (
					page.kind !== 'page' ||
					!page.ownerPackage ||
					!page.viewerCanSeeConnectedPeople
				)
					throw notFound()
				const result = await readPackageAppConnectedPeople({
					request,
					env,
					user,
					...data,
				})
				if (!result.data.ok) throw notFound()
				const payload: PackageAppConnectedPeopleLoaderData = {
					ok: true,
					shell: {
						username: page.username,
						kodyId: page.kodyId,
						name: page.ownerPackage.name,
						description: page.ownerPackage.description ?? '',
						isPrivate: packagePageIsPrivate(page),
						isListed: page.ownerPackage.hasCommunityListing === true,
						listingId: page.listing?.listing?.id ?? null,
						defaultBranch: page.listing?.listing?.defaultBranch ?? null,
						publishedCommit: page.ownerPackage.publishedCommit ?? null,
						ownerProfilePublic: page.ownerProfilePublic,
						viewerIsOwner: page.viewerIsOwner,
						viewerCanManage: page.viewerCanManage,
						viewerCanManageAccess: page.viewerCanManageAccess,
					},
					view: result.data,
				}
				return {
					kind: 'page' as const,
					payload,
					head: loadDocumentHead('communityPackageConnectedPeople', href, {
						packageAppConnectedPeople: payload,
					}),
				}
			})
		} catch (error) {
			if (error instanceof WebsiteAuthenticationError)
				throw redirect({
					href: `/login?redirectTo=${encodeURIComponent(href)}`,
				})
			throw error
		}
	})

export const revokePackageAppConnectedPerson = createServerFn({
	method: 'POST',
})
	.validator(revokePackageAppConnectedPersonInput)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ revokePackageAppConnectedPersonForOwner },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/package-app-connected-people.ts'),
		])
		return withWebsiteMutation({}, async ({ request, env, user }) => {
			const result = await revokePackageAppConnectedPersonForOwner({
				request,
				env,
				user,
				...data,
			})
			if (!result.data.ok) throw new Error(result.data.error)
			return result.data
		})
	})
