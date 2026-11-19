import { getStartRequestEnv } from './request-env.ts'
import {
	isSameOriginFormPost,
	readUrlEncodedForm,
} from './auth-document-protocol.ts'
import { redirectToLoginWhenUnauthenticated } from '#app/auth-redirect.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { continueNavigationResponse } from '#app/continue-navigation.ts'
import { packageAppHandoffQueryParam } from '#app/package-app-handoff.ts'
import { parsePackageAppOauthClientId } from '#app/package-app-oauth-client-id.ts'
import { resolvePackageAppOrgOwnerByHandle } from '#app/package-app-owner.ts'
import {
	approvePackageAppRun,
	needsPackageAppRunConsentForPerson,
} from '#app/package-app-run-consent.ts'
import { viewerCanExecutePackageApp } from '#app/package-viewer-access.ts'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { discardUnreadRequestBody } from '#worker/request-body.ts'
import { findPendingPackageAppDeviceAuthorization } from '#worker/oauth-device/verification.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { resolveSavedPackageForPackageAppSlug } from '#worker/package-invocations/module-artifacts.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import { parsePackageAppPath } from '#worker/package-runtime/package-app-serve.ts'

const headers = {
	'Cache-Control': 'private, no-store',
	'Referrer-Policy': 'same-origin',
}

function seeOther(location: string) {
	return new Response(null, {
		status: 303,
		headers: { ...headers, Location: location },
	})
}

export async function loadPackageAppRunConsentView(request: Request, env: Env) {
	const url = new URL(request.url)
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) return redirectToLoginWhenUnauthenticated(request, env)
	const returnTo = normalizeRedirectTo(url.searchParams.get('returnTo'))
	const entry = returnTo && new URL(returnTo, url.origin)
	const target = entry && parsePackageAppPath(entry.pathname)
	if (!entry || !target?.openHandoff)
		return new Response(null, { status: 404, headers })
	entry.searchParams.delete(packageAppHandoffQueryParam)

	const org = await resolvePackageAppOrgOwnerByHandle({
		env,
		handle: target.username,
	})
	const app =
		org &&
		(await resolveSavedPackageForPackageAppSlug({
			db: env.APP_DB,
			userId: org.userId,
			slug: target.kodyId,
		}))
	if (
		!org ||
		!app?.savedPackage.hasApp ||
		app.retired ||
		!(await viewerCanExecutePackageApp({
			env,
			viewer: user.mcpUser,
			ownerId: org.userId,
			appId: app.savedPackage.id,
		}))
	)
		return new Response(null, { status: 404, headers })

	const personId = user.mcpUser.userId
	let destination = `${entry.pathname}${entry.search}`
	const resume = url.searchParams.get('resume')
	if (resume !== null) {
		const safeResume = normalizeRedirectTo(resume)
		const authorize = safeResume && new URL(safeResume, url.origin)
		if (!authorize || authorize.pathname !== packageAppOauthPaths.authorize) {
			return new Response(null, { status: 404, headers })
		}
		const deviceCode = authorize.searchParams.get('device_user_code')
		let clientId = authorize.searchParams.get('client_id')
		if (deviceCode) {
			const device = await findPendingPackageAppDeviceAuthorization({
				request,
				env,
				user: { personId, email: user.email },
				userCode: deviceCode,
			})
			if (device.kind !== 'found')
				return new Response(null, { status: 404, headers })
			clientId = device.row.client_id
		}
		const client = parsePackageAppOauthClientId(clientId)
		if (
			client?.username !== target.username ||
			client.kodyId !== target.kodyId
		) {
			return new Response(null, { status: 404, headers })
		}
		destination = `${authorize.pathname}${authorize.search}`
	}

	return {
		user,
		destination,
		packageId: app.savedPackage.id,
		publisherId: org.userId,
		personId,
		appName: getPackageNameLeaf(app.savedPackage.name),
		publisherName: org.displayName,
		publisherUsername: org.username,
		viewerName: user.displayName || user.username,
		declined: url.searchParams.get('declined') === '1',
		needsConsent: await needsPackageAppRunConsentForPerson({
			db: env.APP_DB,
			packageId: app.savedPackage.id,
			ownerId: org.userId,
			personId,
		}),
	}
}

export async function postPackageAppRunConsent({
	request,
}: {
	request: Request
}) {
	if (!isSameOriginFormPost(request)) {
		await discardUnreadRequestBody(request)
		return new Response(null, { status: 403, headers })
	}
	const form = await readUrlEncodedForm(request)
	const decision = form?.get('decision')
	if (decision !== 'approve' && decision !== 'decline') {
		await discardUnreadRequestBody(request)
		return new Response(null, { status: 400, headers })
	}
	const env = getStartRequestEnv()
	const view = await loadPackageAppRunConsentView(request, env)
	if (view instanceof Response) return view
	if (
		form?.get('packageId') !== view.packageId ||
		form.get('publisherId') !== view.publisherId ||
		form.get('personId') !== view.personId
	) {
		return new Response(null, { status: 409, headers })
	}
	if (decision === 'decline') {
		const url = new URL(request.url)
		url.searchParams.set('declined', '1')
		return seeOther(`${url.pathname}${url.search}`)
	}
	if (view.needsConsent) {
		await withAccountWriteLease({
			db: env.APP_DB,
			stableUserId: personalOrgIdForPerson(view.user.mcpUser),
			holder: 'website:package-app-run-consent',
			env,
			write: () =>
				approvePackageAppRun(env.APP_DB, view.personId, view.packageId),
		})
	}
	// The resumed app opening or authorization may redirect across origins.
	// Leave the form submission before that happens (CSP form-action 'self').
	return continueNavigationResponse({ location: view.destination })
}
