import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
import { packageAccessInput } from '#universal/package-access-mutations.ts'
import { type PackageForksLoaderData } from '#universal/package-forks.ts'
import { parseRouteInput } from './route-input.ts'
import { type z } from 'zod'

export const loadPackageForks = createServerFn({ method: 'GET' })
	.validator((data: z.input<typeof packageAccessInput>) =>
		parseRouteInput(packageAccessInput, data),
	)
	.handler(async ({ data }) => {
		const [
			{ getRequest, setResponseHeader, setResponseStatus },
			{ getStartRequestEnv },
			{ readAuthenticatedAppUser },
			{ loadPackagePage, packagePageIsPrivate },
			{ loadVisibleCommunityForks },
			{ loadDocumentHead },
		] = await Promise.all([
			import('@tanstack/react-start/server'),
			import('./request-env.ts'),
			import('../../src/app/authenticated-user.ts'),
			import('../../src/app/package-page.ts'),
			import('../../src/app/community-forks-data.ts'),
			import('./document-head.ts'),
		])
		const request = getRequest()
		const env = getStartRequestEnv()
		const href = `/@${encodeURIComponent(data.username)}/${encodeURIComponent(data.kodyId)}/forks`
		// Private forks vary by viewer, so this page is never shared-cached.
		setResponseHeader('Cache-Control', 'private, no-store')
		setResponseHeader('Vary', 'Cookie')
		const page = await loadPackagePage({ env, request, ...data })
		if (page.kind === 'no_access') {
			const { packageNoAccessResult } = await import('./package-no-access.ts')
			return { ...packageNoAccessResult(page, href), payload: null }
		}
		if (page.kind === 'redirect')
			throw redirect({ href: `${page.to}/forks`, statusCode: 302 })
		if (page.kind === 'unauthorized') {
			setResponseStatus(401)
			return { kind: 'unauthorized' as const, payload: null }
		}
		if (page.kind !== 'page' || !page.hasPackage) throw notFound()
		const listing = page.listing?.listing ?? null
		const viewer = listing
			? ((await readAuthenticatedAppUser(request, env))?.mcpUser ?? null)
			: null
		const { forks, total } = listing
			? await loadVisibleCommunityForks({
					env,
					listingId: listing.id,
					viewer,
				})
			: { forks: [], total: 0 }
		const payload: PackageForksLoaderData = {
			ok: true,
			shell: {
				username: page.username,
				kodyId: page.kodyId,
				name:
					listing?.name ??
					page.ownerPackage?.name ??
					`@${page.username}/${page.kodyId}`,
				description:
					listing?.description ?? page.ownerPackage?.description ?? '',
				isPrivate: packagePageIsPrivate(page),
				isListed: Boolean(listing),
				listingId: listing?.id ?? null,
				listingIconUrl: listing?.iconUrl ?? null,
				defaultBranch: listing?.defaultBranch ?? null,
				publishedCommit: page.ownerPackage?.publishedCommit ?? null,
				ownerProfilePublic: page.ownerProfilePublic,
				viewerIsOwner: page.viewerIsOwner,
				viewerCanManage: page.viewerCanManage,
				viewerCanManageAccess: page.viewerCanManageAccess,
				viewerCanSeeConnectedPeople: page.viewerCanSeeConnectedPeople,
			},
			forks,
			total,
		}
		return {
			kind: 'page' as const,
			payload,
			head: loadDocumentHead('communityPackageForks', href, {
				packageForks: payload,
			}),
		}
	})
