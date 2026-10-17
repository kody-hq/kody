import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import {
	normalizePackageFilesPath,
	getPackageTreeHref,
} from '#universal/package-files.ts'

export const loadPackageFiles = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			resource: z.discriminatedUnion('kind', [
				z.object({
					kind: z.literal('account-files'),
					packageId: z.string().min(1),
					relativePath: z.string(),
				}),
				z.object({
					kind: z.literal('listing-files'),
					listingId: z.string().min(1),
					relativePath: z.string(),
				}),
				z.object({
					kind: z.literal('package-files'),
					username: z.string().min(1),
					kodyId: z.string().min(1),
					relativePath: z.string(),
				}),
				z.object({
					kind: z.literal('package-tree'),
					username: z.string().min(1),
					kodyId: z.string().min(1),
					ref: z.string(),
					relativePath: z.string(),
				}),
			]),
			location: z.string().refine((value) => !!normalizeRedirectTo(value)),
			queryRef: z.string().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ env },
			{ getEnv },
			{ getRequest, setResponseHeader },
			{ setAuthSessionSecret },
			{ resolveCommunityFilesRoute },
			{ loadAccessiblePackageFilesData, loadListingFilesData },
			{ requireAuthenticatedPageUser },
			{ getSavedPackageByIdInAnyOrg },
			{ viewerCanReadSavedPackage },
			{ loadOrgBindingForOrg },
			{ loadDocumentHead },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('../../src/app/env.ts'),
			import('@tanstack/react-start/server'),
			import('../../src/app/auth-session.ts'),
			import('../../src/app/community-package-route.ts'),
			import('../../src/app/package-files-data.ts'),
			import('../../src/app/page-auth.ts'),
			import('../../src/package-registry/repo.ts'),
			import('../../src/app/package-viewer-access.ts'),
			import('../../src/orgs/repo.ts'),
			import('./document-head.ts'),
		])
		const bindings = getEnv(env)
		setAuthSessionSecret(bindings.COOKIE_SECRET)
		const original = getRequest()
		const url = new URL(data.location, original.url)
		const parsed = data.resource
		if (parsed.kind !== 'account-files') {
			const request = original
			const target = await resolveCommunityFilesRoute({
				env: bindings,
				resource: parsed,
				pathname: url.pathname,
				queryRef: data.queryRef,
				request,
			})
			if (!target || target.kind === 'invalid-path') throw notFound()
			if (target.kind === 'no_access') {
				const { packageNoAccessResult } = await import('./package-no-access.ts')
				return { ...packageNoAccessResult(target, url.pathname), data: null }
			}
			if (target.kind === 'unauthorized')
				throw redirect({
					href: `/login?redirectTo=${encodeURIComponent(data.location)}`,
					statusCode: 302,
				})
			if (target.kind === 'redirect') {
				const destination = new URL(target.to, url)
				destination.search = url.search
				destination.hash = url.hash
				setResponseHeader(
					'Cache-Control',
					target.shared ? 'public, max-age=3600' : 'private, no-store',
				)
				throw redirect({
					href: destination.toString(),
					statusCode: target.shared ? 301 : 302,
				})
			}
			const payload =
				target.kind === 'package'
					? await loadAccessiblePackageFilesData({
							env: bindings,
							request,
							username: target.username,
							kodyId: target.kodyId,
							selectedPath: target.selectedPath,
							ref: target.ref,
						})
					: await loadListingFilesData({
							env: bindings,
							request,
							listingId: target.listingId,
							packagePath: target.packagePath,
							selectedPath: target.selectedPath,
							ref: target.ref,
						})
			if (!payload) throw notFound()
			return {
				kind: 'page' as const,
				data: payload,
				head: loadDocumentHead(
					target.kind === 'package'
						? parsed?.kind === 'package-tree'
							? 'communityPackageTree'
							: 'communityPackageFiles'
						: 'communityDetailFiles',
					url.pathname,
					{ packageFiles: payload },
					url.search,
				),
			}
		}
		const path = normalizePackageFilesPath(parsed.relativePath ?? '')
		if (path == null) throw notFound()
		const request = original
		const user = await requireAuthenticatedPageUser(request, bindings, {
			redirectTo: data.location,
		})
		if (user instanceof Response) {
			const cookie = user.headers.get('Set-Cookie')
			if (cookie) setResponseHeader('Set-Cookie', cookie)
			throw redirect({
				href: user.headers.get('Location') ?? '/login',
				statusCode: user.status,
			})
		}
		const saved = await getSavedPackageByIdInAnyOrg(
			bindings.APP_DB,
			parsed.packageId,
		)
		if (
			!saved ||
			!(await viewerCanReadSavedPackage({
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
				getPackageTreeHref({
					username: binding?.org.slug ?? user.username,
					kodyId: saved.kodyId,
					relativePath: path,
				}) +
				url.search +
				url.hash,
			statusCode: 302,
		})
	})
