import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
import {
	packageAccessInput,
	grantPackageCollaboratorInput,
	revokePackageCollaboratorInput,
	createPackageCollaboratorInviteInput,
	revokePackageCollaboratorInviteInput,
} from '#universal/package-access-mutations.ts'
import { type PackageCollaboratorsLoaderData } from '#universal/package-collaborators.ts'

export const loadPackageCollaborators = createServerFn({ method: 'GET' })
	.validator(packageAccessInput)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteRead, WebsiteAuthenticationError },
			{ loadPackagePage, packagePageIsPrivate },
			{ readPackageCollaborators },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/package-page.ts'),
			import('../../src/app/handlers/package-collaborators.ts'),
			import('./document-head.ts'),
		])
		const href = `/@${encodeURIComponent(data.username)}/${encodeURIComponent(data.kodyId)}/collaborators`
		try {
			return await withWebsiteRead({}, async ({ request, env, user }) => {
				const page = await loadPackagePage({ env, request, ...data })
				if (page.kind === 'no_access') {
					const { packageNoAccessResult } =
						await import('./package-no-access.ts')
					return { ...packageNoAccessResult(page, href), payload: null }
				}
				if (page.kind === 'redirect')
					throw redirect({ href: `${page.to}/collaborators`, statusCode: 302 })
				if (
					page.kind !== 'page' ||
					!page.ownerPackage ||
					!page.viewerCanManageAccess
				)
					throw notFound()
				const result = await readPackageCollaborators({
					request,
					env,
					user,
					...data,
				})
				if (!result.data.ok) throw notFound()
				const payload: PackageCollaboratorsLoaderData = {
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
						viewerCanManage: page.viewerCanManage,
					},
					view: result.data,
				}
				return {
					kind: 'page' as const,
					payload,
					head: loadDocumentHead('communityPackageCollaborators', href, {
						packageCollaborators: payload,
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
export const grantPackageCollaborator = createServerFn({ method: 'POST' })
	.validator(grantPackageCollaboratorInput)
	.handler(async ({ data }) => {
		const [{ withWebsiteMutation }, { grantPackageCollaborator }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/app/handlers/package-collaborators.ts'),
			])
		return withWebsiteMutation({}, async ({ request, env, user }) => {
			const result = await grantPackageCollaborator({
				request,
				env,
				user,
				...data,
			})
			if (!result.data.ok) throw new Error(result.data.error)
			return result.data
		})
	})
export const revokePackageCollaborator = createServerFn({ method: 'POST' })
	.validator(revokePackageCollaboratorInput)
	.handler(async ({ data }) => {
		const [{ withWebsiteMutation }, { revokePackageCollaborator }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/app/handlers/package-collaborators.ts'),
			])
		return withWebsiteMutation({}, async ({ request, env, user }) => {
			const result = await revokePackageCollaborator({
				request,
				env,
				user,
				...data,
			})
			if (!result.data.ok) throw new Error(result.data.error)
			return result.data
		})
	})

export const createPackageCollaboratorInvite = createServerFn({
	method: 'POST',
})
	.validator(createPackageCollaboratorInviteInput)
	.handler(async ({ data }) => {
		const [{ withWebsiteMutation }, { createPackageCollaboratorInvite }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/app/handlers/package-collaborators.ts'),
			])
		return withWebsiteMutation({}, async ({ request, env, user }) => {
			const result = await createPackageCollaboratorInvite({
				request,
				env,
				user,
				...data,
			})
			if (!result.data.ok) throw new Error(result.data.error)
			return result.data
		})
	})

export const revokePackageCollaboratorInvite = createServerFn({
	method: 'POST',
})
	.validator(revokePackageCollaboratorInviteInput)
	.handler(async ({ data }) => {
		const [{ withWebsiteMutation }, { revokePackageCollaboratorInvite }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/app/handlers/package-collaborators.ts'),
			])
		return withWebsiteMutation({}, async ({ request, env, user }) => {
			const result = await revokePackageCollaboratorInvite({
				request,
				env,
				user,
				...data,
			})
			if (!result.data.ok) throw new Error(result.data.error)
			return result.data
		})
	})
