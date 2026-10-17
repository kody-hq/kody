import { type PackageCredentialsLoaderData } from '#universal/package-credentials-page.ts'
import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { routes } from '#universal/routes.ts'
import { type AccountCredentialsResponse } from '#universal/credentials-list.ts'

const orgSlug = z.string().regex(/^[a-zA-Z0-9_-]+$/)
const segment = z
	.string()
	.min(1)
	.refine((value) => !/[\\/]/.test(value) && value !== '.' && value !== '..')
const searchEntries = z.array(z.tuple([z.string(), z.string()])).default([])

export const loadCredentialsPage = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug,
			credentialId: segment.optional(),
			create: z.boolean().default(false),
			search: searchEntries,
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ loadScopedCollection },
			{ loadAccountCredentialsData },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/app/account-credentials-data'),
			import('./document-head'),
		])
		const pathname =
			routes.orgCredentials.href({ orgSlug: data.orgSlug }) +
			(data.create
				? '/new'
				: data.credentialId
					? `/${encodeURIComponent(data.credentialId)}`
					: '')
		const params = new URLSearchParams(data.search)
		const search = params.size ? `?${params}` : ''
		const { bindings, user } = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'credentials',
			returnTo: pathname + search,
		})
		const payload: AccountCredentialsResponse =
			await loadAccountCredentialsData({
				env: bindings,
				user,
				selectedId: data.create ? null : (data.credentialId ?? null),
			})
		return {
			payload,
			head: loadDocumentHead(
				data.create ? 'orgCredentialNew' : 'orgCredentials',
				pathname,
				undefined,
				search,
			),
		}
	})

export const loadCredentialApprovalPage = createServerFn({ method: 'GET' })
	.validator(z.object({ orgSlug, kodyId: segment, proposal: searchEntries }))
	.handler(async ({ data }) => {
		const [
			{ loadPersonalCollection },
			{ resolveCredentialApproval },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/credentials/credential-approval'),
			import('./document-head'),
		])
		const pathname =
			routes.communityPackage.href({
				username: data.orgSlug,
				kodyId: data.kodyId,
			}) + '/approve-credentials'
		const params = new URLSearchParams(data.proposal)
		const search = params.size ? `?${params}` : ''
		const { bindings, request, user } = await loadPersonalCollection(
			pathname + search,
		)
		const { loadPackagePage } = await import('../../src/app/package-page')
		const page = await loadPackagePage({
			env: bindings,
			request,
			username: data.orgSlug,
			kodyId: data.kodyId,
		})
		if (page.kind === 'redirect')
			throw redirect({
				href: `${page.to}/approve-credentials${search}`,
				statusCode: 302,
			})
		const { loadPackageMappingScopeForViewer } =
			await import('../../src/app/package-credentials-access.ts')
		const { parseCredentialApprovalQuery } =
			await import('../../universal/credential-contracts.ts')
		const scope = await loadPackageMappingScopeForViewer({
			env: bindings,
			request,
			user,
			username: data.orgSlug,
			kodyId: data.kodyId,
		})
		if (!scope) throw notFound()
		const { view } = await resolveCredentialApproval(
			scope,
			parseCredentialApprovalQuery(params),
		)
		return {
			payload: { ok: true as const, view },
			head: loadDocumentHead(
				'communityPackageApproveCredentials',
				pathname,
				undefined,
				search,
			),
		}
	})

export const loadPackageCredentialsPage = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug,
			kodyId: segment,
			view: z.enum(['credentials', 'mappings', 'triggers']),
			search: searchEntries,
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ loadPersonalCollection },
			{ loadPackagePage, packagePageIsPrivate },
			{ buildPackageCredentialsView },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/app/package-page'),
			import('../../src/credentials/package-credential-mappings'),
			import('./document-head'),
		])
		const pathname =
			routes.communityPackage.href({
				username: data.orgSlug,
				kodyId: data.kodyId,
			}) + `/${data.view}`
		const searchParams = new URLSearchParams(data.search)
		const search = searchParams.size ? `?${searchParams}` : ''
		const { bindings, request, user } = await loadPersonalCollection(
			pathname + search,
		)
		const params = { username: data.orgSlug, kodyId: data.kodyId }
		const page = await loadPackagePage({ env: bindings, request, ...params })
		if (page.kind === 'no_access') {
			const { packageNoAccessResult } = await import('./package-no-access.ts')
			return { ...packageNoAccessResult(page, pathname), payload: null }
		}
		const { loadPackageMappingScopeForViewer } =
			await import('../../src/app/package-credentials-access.ts')
		const scope = await loadPackageMappingScopeForViewer({
			env: bindings,
			request,
			user,
			...params,
		})
		if (page.kind === 'redirect')
			throw redirect({
				href: `${page.to}/${data.view}${search}`,
				statusCode: 302,
			})
		if (page.kind !== 'page' || !page.ownerPackage || !page.viewerIsOwner)
			throw notFound()
		const view = scope ? await buildPackageCredentialsView(scope) : null
		const payload: PackageCredentialsLoaderData = {
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
				viewerCanManageAccess: page.viewerCanManageAccess,
			},
			view,
			viewError: view
				? null
				: 'You can read this package but not run it, so it has no credentials, mappings, or triggers for you. Ask an org owner for run access.',
		}
		return {
			kind: 'page' as const,
			payload,
			head: loadDocumentHead(
				'communityPackageCredentials',
				pathname,
				undefined,
				search,
			),
		}
	})
