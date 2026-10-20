import { buildPackageAppSubdomainPath } from '@kody-internal/shared/public-urls.ts'
import { isPackageAppLegacySubdomainMountPath } from '@kody-internal/shared/package-app-host-paths.ts'
import { type PackageAppPath } from '#worker/package-runtime/package-app-serve.ts'

export const packageAppLegacyMountEventKind = 'legacy_package_mount'

export type PackageAppLegacyMountDisposition = 'redirect' | 'rewrite'

export type PackageAppLegacyMountEnv = {
	PACKAGE_APP_LEGACY_EVENTS?: AnalyticsEngineDataset
	WRANGLER_IS_LOCAL_DEV?: string
}

/**
 * Browser HTML navigations (GET/HEAD + Accept text/html) on the legacy
 * subdomain `/packages/{leaf}` mount permanently redirect to `/{leaf}`.
 * Other methods (assets, API, WebSocket upgrade probes, etc.) stay on a quiet
 * rewrite so dual-serve can soak without breaking clients.
 */
export function shouldRedirectLegacyPackageAppSubdomainMount(
	request: Request,
): boolean {
	if (request.method !== 'GET' && request.method !== 'HEAD') return false
	const accept = request.headers.get('Accept') ?? ''
	return accept.toLowerCase().includes('text/html')
}

export function buildLegacyPackageAppSubdomainMountLocation(input: {
	url: URL
	packagePath: Pick<PackageAppPath, 'kodyId' | 'restPath'>
}) {
	const path = buildPackageAppSubdomainPath({
		kodyId: input.packagePath.kodyId,
		restPath:
			input.packagePath.restPath === '/' ? null : input.packagePath.restPath,
	})
	return `${path}${input.url.search}`
}

/**
 * Record one Analytics Engine point for a legacy `/packages/{leaf}` hit on a
 * user subdomain. Never throws. Skipped in local wrangler and when the binding
 * is absent.
 */
export function recordPackageAppLegacyMountHit(input: {
	env: PackageAppLegacyMountEnv
	username: string
	kodyId: string
	method: string
	disposition: PackageAppLegacyMountDisposition
}) {
	try {
		if (!input.env.PACKAGE_APP_LEGACY_EVENTS) return
		if (input.env.WRANGLER_IS_LOCAL_DEV === 'true') return
		input.env.PACKAGE_APP_LEGACY_EVENTS.writeDataPoint({
			indexes: [input.username],
			blobs: [
				packageAppLegacyMountEventKind,
				input.username,
				input.kodyId,
				input.method,
				input.disposition,
			],
			doubles: [1],
		})
	} catch (error) {
		console.warn('package-app-legacy-mount-event-failed', error)
	}
}

/**
 * When the request path is a legacy subdomain mount, instrument the hit and
 * either permanently redirect HTML GET/HEAD to the short path or return null
 * so the caller continues with a quiet rewrite.
 */
export function maybeHandleLegacyPackageAppSubdomainMount(input: {
	request: Request
	env: PackageAppLegacyMountEnv
	url: URL
	packagePath: PackageAppPath
}): Response | null {
	if (!isPackageAppLegacySubdomainMountPath(input.url.pathname)) return null

	const redirect = shouldRedirectLegacyPackageAppSubdomainMount(input.request)
	const disposition: PackageAppLegacyMountDisposition = redirect
		? 'redirect'
		: 'rewrite'
	recordPackageAppLegacyMountHit({
		env: input.env,
		username: input.packagePath.username,
		kodyId: input.packagePath.kodyId,
		method: input.request.method,
		disposition,
	})
	if (!redirect) return null

	const location = buildLegacyPackageAppSubdomainMountLocation({
		url: input.url,
		packagePath: input.packagePath,
	})
	return new Response(null, {
		status: 308,
		headers: {
			Location: location,
			'Cache-Control': 'public, max-age=300',
		},
	})
}
