import { parsePackageAppPath } from '#worker/package-runtime/package-app-serve.ts'

/**
 * Resolve package-app OAuth host identity on the app origin when
 * `PACKAGE_APP_BASE_URL` is unset (preview / path-based inline serving).
 * Prefer explicit `org`+`app` query params; fall back to a package-shaped
 * `return_to` path (`/@owner/packages/leaf/...`).
 */
export function resolvePackageAppOauthInlineIdentity(url: URL): {
	orgUsername: string
	kodyId: string
} | null {
	const orgParam = (
		url.searchParams.get('org') ??
		url.searchParams.get('username') ??
		url.searchParams.get('owner')
	)
		?.trim()
		.toLowerCase()
	const appParam = (
		url.searchParams.get('app') ??
		url.searchParams.get('package') ??
		url.searchParams.get('kody_id')
	)
		?.trim()
		.toLowerCase()
	if (orgParam && appParam) {
		return { orgUsername: orgParam, kodyId: appParam }
	}
	const returnTo = url.searchParams.get('return_to')
	if (!returnTo?.startsWith('/') || returnTo.startsWith('//')) return null
	const target = new URL(returnTo, url.origin)
	if (target.origin !== url.origin) return null
	const parsed = parsePackageAppPath(target.pathname)
	if (!parsed) return null
	return {
		orgUsername: parsed.username.toLowerCase(),
		kodyId: parsed.kodyId.toLowerCase(),
	}
}
