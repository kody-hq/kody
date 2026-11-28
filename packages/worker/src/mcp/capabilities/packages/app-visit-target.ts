/**
 * What `appFetch` and `appOpenLink` share: find the app an address names,
 * run the one visit check for the calling credential, and report a consent
 * only the person can give.
 */
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
import { resolveHostedPackageAppLocation } from '@kody-internal/shared/public-urls.ts'
import {
	resolveAppAddress,
	type AppAddress,
} from '#worker/app-visit/address.ts'
import { AppConsentRequiredError } from '#worker/app-visit/consent-required.ts'
import { authorizeAppVisit } from '#worker/app-visit/authorize.ts'
import {
	packageAppRunConsentRequiredHeader,
	packageAppRunConsentUrl,
} from '#worker/app-visit/run-consent-url.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { requireInteractiveMcpCaller } from '#mcp/capabilities/meta/require-interactive-caller.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { getOrgById } from '#worker/orgs/repo.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'
import type { PackageAppPath } from '#worker/package-runtime/package-app-serve.ts'
import { packageAppVisitorConsentRequiredHeader } from '#worker/package-runtime/package-app-synthetic.ts'

function appNotFound(label: string) {
	return new McpCallerError(
		`No app ${label} that you can run. Check the address with appList, which lists every app you can run, or ask the app's owner to share it with you (Use on the app).`,
	)
}

async function resolveRequestedApp(
	ctx: Pick<CapabilityContext, 'env' | 'callerContext'>,
	args: { app?: string; package_id?: string },
): Promise<AppAddress & { label: string }> {
	if (args.app !== undefined) {
		const address = await resolveAppAddress({
			env: ctx.env,
			address: args.app,
			appBaseUrl: ctx.callerContext.baseUrl,
		})
		return { ...address, label: `at "${args.app}"` }
	}
	const label = `with package_id "${args.package_id}"`
	const saved = await getSavedPackageByIdInAnyOrg(
		ctx.env.APP_DB,
		args.package_id ?? '',
	)
	const org = saved ? await getOrgById(ctx.env.APP_DB, saved.userId) : null
	if (!saved || !org) throw appNotFound(label)
	return {
		ownerHandle: org.slug,
		appSlug: getPackageNameLeaf(saved.name),
		path: null,
		label,
	}
}

function normalizeAppPath(capabilityName: string, path: string | undefined) {
	const trimmed = path?.trim() ?? ''
	if (!trimmed || trimmed === '/') return '/'
	const pathOnly = trimmed.split(/[?#]/, 1)[0] ?? ''
	for (const segment of pathOnly.split(/[\\/]/)) {
		let decoded: string
		try {
			decoded = decodeURIComponent(segment)
		} catch {
			throw new McpCallerError(
				`${capabilityName} path contains invalid percent encoding.`,
			)
		}
		if (decoded === '..') {
			throw new McpCallerError(
				`${capabilityName} path must not contain parent traversal segments.`,
			)
		}
	}
	return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/**
 * The app a call names, authorized for the calling credential: the one
 * visit check in the org that owns the app, with this request's profile
 * chain and token scopes (ADR 0062). Throws when the caller cannot run it
 * or the person still owes "Run as me".
 */
export async function resolveAppVisitTarget(
	ctx: Pick<CapabilityContext, 'env' | 'callerContext'>,
	args: { app?: string; package_id?: string; path?: string },
	capabilityName: string,
	runtimeCallerErrorMessage: string,
) {
	const user = requireMcpUser(ctx.callerContext)
	requireInteractiveMcpCaller(ctx.callerContext, runtimeCallerErrorMessage)
	const callerRequest = requireMcpRequest(ctx.callerContext)
	if (!callerRequest.actor) {
		throw new McpCallerError(
			`${capabilityName} needs a signed-in caller, who the app acts as.`,
		)
	}
	const requested = await resolveRequestedApp(ctx, args)
	// Validate the path before the access check so traversal and encoding
	// errors fail closed without warming any cache.
	const restPath = normalizeAppPath(
		capabilityName,
		args.path ?? requested.path ?? '/',
	)
	const restPathOnly = restPath.split(/[?#]/, 1)[0] || '/'

	const visit = await authorizeAppVisit({
		env: ctx.env,
		callerRequest,
		ownerHandle: requested.ownerHandle,
		appSlug: requested.appSlug,
	})
	if (visit.kind === 'not-found') throw appNotFound(requested.label)
	if (visit.kind === 'forbidden') {
		// The person can run it but this credential cannot: say which
		// layer to fix. Anything else reads the same as a missing app.
		const code = visit.error?.code
		if (
			visit.error &&
			(code === 'profile_grant' ||
				code === 'profile_inactive' ||
				code === 'credential_scope')
		) {
			throw visit.error
		}
		throw appNotFound(requested.label)
	}
	const app = visit.app
	if (!app?.hasApp) throw appNotFound(requested.label)
	const appSlug = visit.retiredSlug
		? getPackageNameLeaf(app.name)
		: requested.appSlug
	const { owner } = visit

	// A custom domain the caller named stays the app's host, so links
	// the app builds from the request point back at that domain.
	const customMount = visit.retiredSlug ? null : requested.customMount
	const packageAppOrigin = getPackageAppBaseUrl({ env: ctx.env })
	const hosted = resolveHostedPackageAppLocation({
		packageAppBaseUrl: packageAppOrigin,
		appBaseUrl: ctx.callerContext.baseUrl,
		username: owner.username,
		kodyId: appSlug,
		restPath: restPath === '/' ? null : restPath,
	})
	const packagePath: PackageAppPath = {
		username: owner.username,
		kodyId: appSlug,
		restPath: restPathOnly,
		mount: customMount
			? customMount.mount
			: !packageAppOrigin
				? 'username-path'
				: hosted.appBasePath === ''
					? 'custom-hostname'
					: 'user-subdomain',
	}
	const appLabel = `@${owner.username}/${appSlug}`
	const runConsentRequired = () =>
		new AppConsentRequiredError({
			consent: 'run_as_me',
			app: appLabel,
			consentUrl: packageAppRunConsentUrl({
				baseUrl: ctx.callerContext.baseUrl,
				packagePath: { ...packagePath, restPath: '/' },
			}).toString(),
		})
	if (visit.needsRunConsent) throw runConsentRequired()

	return {
		callerRequest,
		packagePath,
		appLabel,
		notFound: () => appNotFound(requested.label),
		/** The app's address in a browser, with the requested path. */
		url: customMount ? `${customMount.baseUrl}${restPath}` : hosted.hostedUrl,
		/** False when this deployment serves apps on the Kody origin itself. */
		hasAppHost: customMount != null || packageAppOrigin != null,
		owner: {
			userId: owner.userId,
			username: owner.username,
			// Team org entitlements resolve by org id alone.
			email: owner.userId === personalOrgIdForPerson(user) ? user.email : '',
			displayName: owner.displayName,
		},
		visitor: {
			...visit.visitor,
			username: visit.visitor.username || user.username || '',
		},
		runConsentRequired,
	}
}

export type AppVisitTarget = Awaited<ReturnType<typeof resolveAppVisitTarget>>

/**
 * Throw `app_consent_required` when a served response says the person still
 * owes "Run as me" or a required visitor credential. Agents never give
 * either, so the caller gets the link to hand to the person.
 */
export async function assertAppVisitConsent(
	target: Pick<AppVisitTarget, 'appLabel' | 'runConsentRequired'>,
	response: Response,
	requestUrl: string,
) {
	if (response.headers.get(packageAppRunConsentRequiredHeader) === 'required') {
		throw target.runConsentRequired()
	}
	if (
		response.headers.get(packageAppVisitorConsentRequiredHeader) !== 'required'
	) {
		return
	}
	const refusal = (await response.json().catch(() => null)) as {
		need?: unknown
		consent_url?: unknown
	} | null
	// App code can set this header too, so only a link to Kody's own
	// sign-in page for this app's host is passed on to the person.
	const consentUrl =
		typeof refusal?.consent_url === 'string'
			? URL.parse(refusal.consent_url)
			: null
	const expected = new URL(packageAppOauthPaths.login, requestUrl)
	if (
		!consentUrl ||
		consentUrl.origin !== expected.origin ||
		consentUrl.pathname !== expected.pathname
	) {
		throw new Error('App consent refusal carried no valid consent link.')
	}
	throw new AppConsentRequiredError({
		consent: 'visitor_need',
		app: target.appLabel,
		consentUrl: consentUrl.toString(),
		need: typeof refusal?.need === 'string' ? refusal?.need : null,
	})
}
