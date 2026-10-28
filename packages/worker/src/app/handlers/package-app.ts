import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { buildPackagePagePath } from '@kody-internal/shared/public-urls.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requestHasSessionCookie } from '#app/anonymous-html-cache.ts'
import { redirectToLoginWhenUnauthenticated } from '#app/auth-redirect.ts'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { resolvePackageAppOrgOwnerByHandle } from '#app/package-app-owner.ts'
import { readPackageAppSession } from '#app/package-app-session.ts'
import {
	authorizePackageAppVisitorForOrg,
	resolvePackageAppIdentityOnlyVisitor,
} from '#app/package-app-origin.ts'
import { viewerCanExecutePackageApp } from '#app/package-viewer-access.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { resolveSavedPackageForPackageAppSlug } from '#worker/package-invocations/module-artifacts.ts'
import {
	logPackageAppAuthFailed,
	logPackageAppHttpError,
	withPackageAppRequestId,
} from '#worker/package-runtime/package-app-diagnostics.ts'
import { buildPackageAppNotFoundMessage } from '#worker/package-runtime/package-app-synthetic.ts'
import { applyPackageAppCacheHeaders } from '#worker/package-runtime/package-app-cache-headers.ts'
import { resolveInternetVisibleApprovedCommit } from '#app/package-app-internet-visible.ts'
import { runWithRequestContext } from '#worker/request-context.ts'
import {
	createPackageCodeRequest,
	isPackageAppRequestPath,
	parsePackageAppCustomHostnamePath,
	parsePackageAppPath,
	parsePackageAppSubdomainPath,
	servePackageAppRequest,
	type PackageAppPath,
} from '#worker/package-runtime/package-app-serve.ts'

export {
	createPackageCodeRequest,
	isPackageAppRequestPath,
	parsePackageAppCustomHostnamePath,
	parsePackageAppPath,
	parsePackageAppSubdomainPath,
	servePackageAppRequest,
	type PackageAppPath,
}

/**
 * Serve a hosted package app inline on the app origin, authenticated by the
 * browser `kody_session` cookie. An internet-visible app also serves a
 * visitor who is signed out or cannot run it, anonymously.
 *
 * This is the local dev / preview / test path. When `PACKAGE_APP_BASE_URL` is
 * configured, package apps are served from that origin instead and this handler
 * is never reached — see `packages/worker/src/app/package-app-origin.ts`.
 */
export async function handlePackageAppRequest(request: Request, env: Env) {
	const tagged = withPackageAppRequestId(request)
	return await runWithRequestContext(tagged.request, () =>
		handleTaggedPackageAppRequest(tagged.request, tagged.requestId, env),
	)
}

async function handleTaggedPackageAppRequest(
	request: Request,
	requestId: string,
	env: Env,
) {
	if (!isNonProductionRuntime(env)) {
		logPackageAppHttpError({
			request,
			status: 500,
			phase: 'inline-disabled',
			runtimeRunId: null,
		})
		return new Response(
			'Hosted package apps are unavailable. Inline package-app serving is disabled in production.',
			{
				status: 500,
				headers: {
					'Cache-Control': 'no-store',
					'Content-Type': 'text/plain; charset=utf-8',
				},
			},
		)
	}

	const requestUrl = new URL(request.url)
	const packagePath = parsePackageAppPath(requestUrl.pathname)
	if (!packagePath) {
		return new Response(buildPackageAppNotFoundMessage(), { status: 404 })
	}
	const org = await resolvePackageAppOrgOwnerByHandle({
		env,
		handle: packagePath.username,
	})
	const slugLookup = org
		? await resolveSavedPackageForPackageAppSlug({
				db: env.APP_DB,
				userId: org.userId,
				slug: packagePath.kodyId,
			})
		: null
	const approvedPublishedCommit = await resolveInternetVisibleApprovedCommit({
		env,
		lookup: slugLookup,
		requestUrl: request.url,
	})
	// Mirrors the app origin: a signed-in person who cannot run the app is
	// served anonymously plus identity while they hold a live grant for it.
	const serveAnonymously =
		org && approvedPublishedCommit
			? async (
					identity: Awaited<
						ReturnType<typeof resolvePackageAppIdentityOnlyVisitor>
					> = null,
				) =>
					applyPackageAppCacheHeaders(
						await servePackageAppRequest({
							request,
							env,
							packagePath,
							owner: {
								userId: org.userId,
								username: org.username,
								email: '',
								displayName: org.displayName,
							},
							visitor: null,
							identity,
							approvedPublishedCommit,
						}),
						identity ? 'signed-in' : 'anonymous',
					)
			: null
	const packageAppSession = await readPackageAppSession({
		request,
		env,
		slug: packagePath.kodyId,
	})
	if (packageAppSession) {
		const authorized = await authorizePackageAppVisitorForOrg({
			env,
			stableUserId: packageAppSession.session.stableUserId,
			issuedAt: packageAppSession.issuedAt,
			handle: packagePath.username,
			kodyId: packagePath.kodyId,
		})
		if (authorized.kind === 'ok') {
			const response = await servePackageAppRequest({
				request,
				env,
				packagePath,
				owner: authorized.owner,
				visitor: authorized.visitor,
			})
			return applyPackageAppCacheHeaders(response, 'signed-in')
		}
		if (serveAnonymously) {
			const identity = await resolvePackageAppIdentityOnlyVisitor({
				env,
				authorized,
				handle: packagePath.username,
				packagePath,
				kodyId: slugLookup?.savedPackage.kodyId,
			}).catch((error: unknown) => {
				console.warn('package-app-identity-lookup-failed', error)
				return null
			})
			return await serveAnonymously(identity)
		}
		if (authorized.kind === 'forbidden') {
			return new Response(null, {
				status: 302,
				headers: {
					Location: buildPackagePagePath({
						username: packagePath.username,
						kodyId: packagePath.kodyId,
					}),
					'Cache-Control': 'no-store',
				},
			})
		}
		return redirectToLoginWhenUnauthenticated(request, env)
	}
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		if (serveAnonymously) return await serveAnonymously()
		if (requestHasSessionCookie(request)) {
			logPackageAppAuthFailed({
				requestId,
				method: request.method,
				pathname: requestUrl.pathname,
			})
		}
		return redirectToLoginWhenUnauthenticated(request, env)
	}
	if (!org) {
		return new Response(buildPackageAppNotFoundMessage(), { status: 404 })
	}
	const canExecute = await viewerCanExecutePackageApp({
		env,
		viewer: user.mcpUser,
		ownerId: org.userId,
		appId: slugLookup?.savedPackage.id ?? null,
	})
	if (!canExecute) {
		if (serveAnonymously) {
			const username = user.mcpUser.username
			const identity = username
				? await resolvePackageAppIdentityOnlyVisitor({
						env,
						authorized: {
							kind: 'forbidden',
							visitorEmail: '',
							person: { userId: user.mcpUser.userId, username },
						},
						handle: packagePath.username,
						packagePath,
						kodyId: slugLookup?.savedPackage.kodyId,
					}).catch((error: unknown) => {
						console.warn('package-app-identity-lookup-failed', error)
						return null
					})
				: null
			return await serveAnonymously(identity)
		}
		return new Response(null, {
			status: 302,
			headers: {
				Location: buildPackagePagePath({
					username: packagePath.username,
					kodyId: packagePath.kodyId,
				}),
				'Cache-Control': 'no-store',
			},
		})
	}
	const binding = await loadOrgBindingForOrg(
		env.APP_DB,
		user.mcpUser.userId,
		org.userId,
	)
	const response = await servePackageAppRequest({
		request,
		env,
		packagePath,
		owner: {
			userId: org.userId,
			username: org.username,
			email:
				org.userId === personalOrgIdForPerson(user.mcpUser) ? user.email : '',
			displayName: org.displayName,
		},
		visitor: {
			userId: user.mcpUser.userId,
			username: user.username,
			role: binding?.role ?? null,
		},
	})
	return applyPackageAppCacheHeaders(response, 'signed-in')
}
