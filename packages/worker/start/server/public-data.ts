import { type CommunityDetailApiPayload } from '../community-types.ts'
import { createServerFn } from '@tanstack/react-start'
import { notFound } from '@tanstack/react-router'

import { z } from 'zod'

export const loadCommunity = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			query: z.string(),
			sort: z.string().nullable(),
			category: z.string().nullable(),
			limit: z.number().int().positive().max(100),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ env },
			{ getEnv },
			{ getRequest },
			{ setAuthSessionSecret },
			{ loadCommunityIndexData },
			{ loadDocumentHead },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('../../src/app/env.ts'),
			import('@tanstack/react-start/server'),
			import('../../src/app/auth-session.ts'),
			import('../../src/app/community-data.ts'),
			import('./document-head.ts'),
		])
		const bindings = getEnv(env)
		setAuthSessionSecret(bindings.COOKIE_SECRET)
		const request = getRequest()
		const community = await loadCommunityIndexData(bindings, request, data)
		return {
			data: community,
			head: loadDocumentHead('community', '/community'),
		}
	})

export const loadProfile = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			username: z.string().min(1),
			query: z.string(),
			limit: z.number().int().positive().max(100).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ env },
			{ getEnv },
			{ getRequest, setResponseHeader },
			{ setAuthSessionSecret },
			{ loadProfileData },
			{ loadDocumentHead },
			{ toProfileShellLoaderData, toProfileListLoaderData },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('../../src/app/env.ts'),
			import('@tanstack/react-start/server'),
			import('../../src/app/auth-session.ts'),
			import('../../src/app/profile-data.ts'),
			import('./document-head.ts'),
			import('../../universal/loader-data.ts'),
		])
		const bindings = getEnv(env)
		setAuthSessionSecret(bindings.COOKIE_SECRET)
		const request = getRequest()
		const path = `/@${encodeURIComponent(data.username)}`
		const profile = await loadProfileData(
			bindings,
			request,
			data.username,
			undefined,
			{ query: data.query, limit: data.limit },
		)
		if (!profile) {
			const { loadSessionInfo } = await import('../../src/app/session-info.ts')
			const { session, setCookie } = await loadSessionInfo(request, bindings)
			if (setCookie) setResponseHeader('Set-Cookie', setCookie)
			const orgHome = session?.organizations.find(
				(org) => org.slug === data.username && !org.personal,
			)
			if (!orgHome) throw notFound()
			setResponseHeader('Cache-Control', 'no-store')
			return {
				data: null,
				orgHome,
				head: {
					...loadDocumentHead('profile', path),
					title: orgHome.displayName || `@${orgHome.slug}`,
				},
			}
		}
		return {
			data: profile,
			orgHome: null,
			head: loadDocumentHead('profile', path, {
				profileShell: toProfileShellLoaderData(profile),
				profileList: toProfileListLoaderData(profile),
			}),
		}
	})

export const loadPackage = createServerFn({ method: 'GET' })
	.validator(
		(data: {
			username: string
			kodyId: string
			page?: 'settings'
			listingId?: string
			search?: string
		}) => {
			if (
				!data ||
				typeof data !== 'object' ||
				(data.page !== undefined && data.page !== 'settings') ||
				(data.listingId !== undefined &&
					(typeof data.listingId !== 'string' || !data.listingId)) ||
				(data.search !== undefined &&
					(typeof data.search !== 'string' ||
						(data.search !== '' && !data.search.startsWith('?')))) ||
				typeof data.username !== 'string' ||
				typeof data.kodyId !== 'string' ||
				(!data.listingId && (!data.username || !data.kodyId))
			)
				throw notFound()
			return data
		},
	)
	.handler(async ({ data }) => {
		const [
			{ env },
			{ getEnv },
			{ getRequest, setResponseHeader, setResponseStatus },
			{ setAuthSessionSecret },
			{ loadCommunityPackagePayload, loadCommunityDetailPayload },
			{ loadDocumentHead },
			{ loadSessionInfo },
			{ resolvePackageListIconUrl },
			{ routes },
			{ redirect },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('../../src/app/env.ts'),
			import('@tanstack/react-start/server'),
			import('../../src/app/auth-session.ts'),
			import('../../src/app/community-package-payload.ts'),
			import('./document-head.ts'),
			import('../../src/app/session-info.ts'),
			import('../../universal/identity-icon-urls.ts'),
			import('../../universal/routes.ts'),
			import('@tanstack/react-router'),
		])
		const bindings = getEnv(env)
		setAuthSessionSecret(bindings.COOKIE_SECRET)
		const original = getRequest()
		const path = data.listingId
			? routes.communityDetail.href({ listingId: data.listingId })
			: data.page === 'settings'
				? routes.communityPackageSettings.href(data)
				: routes.communityPackage.href(data)
		const request = original
		let loaded:
			| Awaited<ReturnType<typeof loadCommunityPackagePayload>>
			| Awaited<ReturnType<typeof loadCommunityDetailPayload>>
		if (data.listingId) {
			const { loadCommunityDetailData } =
				await import('../../src/app/community-data.ts')
			const { resolveCanonicalListingPath } =
				await import('../../src/app/community-package-route.ts')
			const detail = await loadCommunityDetailData(
				bindings,
				request,
				data.listingId,
			)
			if (!detail?.listing) throw notFound()
			const canonical = await resolveCanonicalListingPath({
				env: bindings,
				listingId: data.listingId,
				ownerUsername: detail.listing.ownerUsername,
				kodyId: detail.listing.kodyId,
			})
			if (canonical) {
				setResponseHeader('Cache-Control', 'public, max-age=3600')
				throw redirect({
					href: canonical + (data.search ?? ''),
					statusCode: 301,
				})
			}
			loaded = await loadCommunityDetailPayload(
				bindings,
				request,
				data.listingId,
				detail,
			)
		} else
			loaded = await loadCommunityPackagePayload({
				env: bindings,
				request,
				username: data.username,
				kodyId: data.kodyId,
			})
		if (loaded.kind === 'redirect') {
			const isPublic = loaded.shared
			setResponseHeader(
				'Cache-Control',
				isPublic ? 'public, max-age=3600' : 'private, no-store',
			)
			if (!isPublic) setResponseHeader('Vary', 'Cookie')
			throw redirect({
				href:
					loaded.to +
					(data.page === 'settings' ? '/settings' : '') +
					(data.search ?? ''),
				statusCode: isPublic ? 301 : 302,
			})
		}
		if (loaded.kind === 'no_access') {
			const { packageNoAccessResult } = await import('./package-no-access.ts')
			return packageNoAccessResult(loaded, path)
		}
		if (loaded.kind === 'unauthorized') {
			setResponseStatus(401)
			return { kind: 'unauthorized' as const }
		}

		if (loaded.kind === 'not_found') throw notFound()
		const result: CommunityDetailApiPayload = loaded.data
		if (
			data.page === 'settings' &&
			(!result.viewerCanManage || !result.ownerPackage)
		)
			throw notFound()
		const { session, setCookie } = await loadSessionInfo(request, bindings)
		if (setCookie) setResponseHeader('Set-Cookie', setCookie)
		const listing = result.listing
		const description =
			listing?.description ?? result.ownerPackage?.description ?? ''
		const header = {
			listing,
			username: result.username,
			kodyId: result.kodyId,
			description,
			isPrivate: result.isPrivate,
			ownerProfilePublic: result.ownerProfilePublic,
			viewerIsOwner: result.viewerIsOwner,
			viewerCanManage: result.viewerCanManage,
			viewerCanManageAccess: result.viewerCanManageAccess,
			hasPackage: result.hasPackage,
			packageShaped: result.packageShaped === true,
			repoActions: result.repoActions ?? null,
			iconUrl:
				listing?.iconUrl ??
				resolvePackageListIconUrl({
					username: result.username,
					kodyId: result.kodyId,
					listingId: null,
					listingIconCommit: null,
					publishedCommit: result.ownerPackage?.publishedCommit ?? null,
				}),
		}
		const shell = {
			...result,
			listingId: listing?.id ?? null,
			name: listing?.name ?? `@${result.username}/${result.kodyId}`,
			description,
			trusted: listing?.trusted ?? false,
			featured: listing?.featured ?? false,
			hasAgentsDocs: result.hasAgentsDocs ?? false,
			imageBaseHref: result.imageBaseHref ?? null,
		}
		return {
			kind: 'page' as const,
			data: result,
			header,
			session,
			head: loadDocumentHead(
				data.page === 'settings'
					? 'communityPackageSettings'
					: data.listingId
						? 'communityDetail'
						: 'communityPackage',
				path,
				{ communityDetailShell: shell },
			),
		}
	})
