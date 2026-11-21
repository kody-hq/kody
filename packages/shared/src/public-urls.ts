import {
	buildPackageAppHostLabel,
	isPackageAppHostLabelReservedPackageLeaf,
	packageAppHostLabelMaxLength,
	packageAppHostLabelSeparator,
} from './package-app-host-label.ts'
import {
	isPackageAppHostNonLeafFirstSegment,
	packageAppHostLegacyMountSegment,
} from './package-app-host-paths.ts'

export function buildUsernamePathPrefix(username: string) {
	return `/@${encodeURIComponent(username.trim())}`
}

function buildRestPathSuffix(restPath: string | null | undefined) {
	const trimmed = restPath?.trim()
	return trimmed ? `/${trimmed.replace(/^\/+/, '')}` : ''
}

/**
 * Canonical saved-package page on the app origin: `/@{username}/{kodyId}`.
 * Distinct from the hosted package-app mount, which needs a `/packages/`
 * segment so it does not steal this two-segment public page.
 */
export function buildPackagePagePath(input: {
	username: string
	kodyId: string
}) {
	return `${buildUsernamePathPrefix(input.username)}/${encodeURIComponent(
		input.kodyId.trim(),
	)}`
}

export function buildPackageAppPath(input: {
	username: string
	kodyId: string
	restPath?: string | null
}) {
	return `${buildUsernamePathPrefix(input.username)}/packages/${encodeURIComponent(
		input.kodyId.trim(),
	)}${buildRestPathSuffix(input.restPath)}`
}

/**
 * App-origin path that starts a package-app session handoff to the hosted
 * origin. Distinct from bare `/@{user}/packages/{name}`, which still hands
 * off for old links but does not read as an open action in the address bar.
 *
 * Subpath after `/open` (and the request query) is forwarded to the hosted
 * app the same way the bare mount does. Hosted URL shape is owned by
 * {@link buildPackageAppSubdomainPath} / {@link resolveHostedPackageAppUrl}.
 */
export const packageAppOpenPathSegment = 'open'

/**
 * Marks an app-origin entry URL that came from the app's own
 * `{leaf}--{handle}` host, so the handoff returns there instead of the
 * owner's shared subdomain. Both hosts serve the same app until the old
 * address stops serving, when every handoff targets the app host and this
 * marker goes away.
 */
export const packageAppHostEntryQueryParam = '__kody_app_host'

export function buildPackageAppOpenPath(input: {
	username: string
	kodyId: string
	restPath?: string | null
}) {
	const afterOpen = buildRestPathSuffix(input.restPath)
	return `${buildPackageAppPath({
		username: input.username,
		kodyId: input.kodyId,
	})}/${packageAppOpenPathSegment}${afterOpen}`
}

export function buildPackageAppUrl(input: {
	origin: string
	username: string
	kodyId: string
	restPath?: string | null
}) {
	return `${input.origin.trim().replace(/\/+$/, '')}${buildPackageAppPath(input)}`
}

/**
 * How a package-app URL addresses its package:
 *
 * - `user-subdomain`: `https://{username}.<package-app host>/{kodyId}`
 *   — the production shape, where the username lives in the hostname. Reserved
 *   or non-leaf names still generate the legacy `/packages/{kodyId}` mount
 *   (`buildPackageAppSubdomainPath`); that mount still serves every package.
 * - `username-path`: `/@{username}/packages/{kodyId}` — the app-origin entry
 *   point (which redirects into the handoff) and the non-production inline
 *   serving shape.
 * - `custom-hostname`: `https://{host}/{rest}` — a host bound to one app: a
 *   verified app-level custom hostname, or the app's own
 *   `{leaf}--{handle}` host on the package-app domain. The package is bound
 *   by hostname, so the path has no username or slug. The app is mounted at
 *   `/`.
 * Remove when: production `PACKAGE_APP_LEGACY_HOSTS` is empty and legacy `/packages` mount and `/_kody/auth` hits stay at zero.
 */
export type PackageAppMount =
	| 'user-subdomain'
	| 'username-path'
	| 'custom-hostname'

/**
 * The username shape: a valid DNS label (lowercase letters, digits, hyphens;
 * 3–32 chars; alphanumeric edges), because every user owns a `{username}.`
 * subdomain on the package-app domain. Also used to validate subdomain labels
 * from wildcard-routed hostnames, which can be arbitrary strings.
 *
 * `--` is banned so a per-app host label `{leaf}--{handle}` splits at exactly
 * one place and never reads as a handle.
 */
export const dnsSafeUsernamePattern =
	/^(?![a-z0-9-]*--)[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/

/**
 * Anchor-free source of {@link dnsSafeUsernamePattern}. Embed this fragment
 * in a larger expression so org slugs and path parsers share one handle shape.
 */
export const dnsSafeUsernamePatternSource = dnsSafeUsernamePattern.source.slice(
	1,
	-1,
)

export function isDnsSafeUsername(username: string) {
	return dnsSafeUsernamePattern.test(username.trim())
}

/**
 * Path for a hosted package app on its per-user package-app subdomain. The
 * username lives in the hostname there, so the path carries only the package
 * mount: `/{kodyId}/{rest}`. Kody-owned routes on that host live under `/-/`.
 *
 * Reserved or non-leaf names (legacy `packages` mount prefix, `robots.txt`,
 * `/-/`, …) cannot use the short path: the serving parser treats them as host
 * roots or prefixes, not package leaves. Those fall back to the legacy
 * `/packages/{leaf}` mount, which still routes today.
 * Remove when: production `PACKAGE_APP_LEGACY_HOSTS` is empty and legacy `/packages` mount and `/_kody/auth` hits stay at zero.
 */
export function buildPackageAppSubdomainPath(input: {
	kodyId: string
	restPath?: string | null
}) {
	const kodyId = input.kodyId.trim()
	const encodedKodyId = encodeURIComponent(kodyId)
	const mountPath = isPackageAppHostNonLeafFirstSegment(kodyId)
		? `/${packageAppHostLegacyMountSegment}/${encodedKodyId}`
		: `/${encodedKodyId}`
	return `${mountPath}${buildRestPathSuffix(input.restPath)}`
}

/**
 * Origin of one user's package-app subdomain: `{username}.` prefixed onto the
 * configured package-app origin's hostname, preserving scheme and port.
 *
 * The username must already satisfy the username format rules (lowercase DNS
 * label); this function does not re-validate it.
 */
export function buildPackageAppSubdomainOrigin(input: {
	packageAppOrigin: string
	username: string
}) {
	const username = input.username.trim().toLowerCase()
	if (!username) {
		throw new Error('Username is required to build a package-app subdomain.')
	}
	const url = new URL(input.packageAppOrigin)
	url.hostname = `${username}.${url.hostname}`
	return url.origin
}

export function buildPackageAppSubdomainUrl(input: {
	packageAppOrigin: string
	username: string
	kodyId: string
	restPath?: string | null
}) {
	return `${buildPackageAppSubdomainOrigin(input)}${buildPackageAppSubdomainPath(input)}`
}

const packageAppHostLabelLeafPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Split a per-app host label `{leaf}--{handle}` into its package leaf and
 * owner handle. Null for anything else: a bare handle, a reserved leaf,
 * uppercase input, or a label over the DNS limit.
 */
export function parsePackageAppHostLabel(label: string) {
	if (label.length > packageAppHostLabelMaxLength) return null
	const separatorIndex = label.indexOf(packageAppHostLabelSeparator)
	if (separatorIndex <= 0) return null
	const leaf = label.slice(0, separatorIndex)
	const handle = label.slice(
		separatorIndex + packageAppHostLabelSeparator.length,
	)
	if (!packageAppHostLabelLeafPattern.test(leaf)) return null
	if (isPackageAppHostLabelReservedPackageLeaf(leaf)) return null
	if (!dnsSafeUsernamePattern.test(handle)) return null
	return { leaf, handle }
}

/**
 * A profile package is named after its owner (`@{slug}/{slug}`, like a
 * GitHub `username/username` repository). Its app owns the owner's bare
 * `{slug}` host instead of a `{leaf}--{handle}` host.
 */
export function isProfilePackage(input: { username: string; kodyId: string }) {
	const username = input.username.trim().toLowerCase()
	return username !== '' && input.kodyId === username
}

/**
 * Origin where a package app is mounted at `/`: the owner's bare host for a
 * profile package, otherwise the app's own `{leaf}--{handle}` host. Null when
 * the pair has no routable host.
 */
export function buildPackageAppRootOrigin(input: {
	packageAppOrigin: string
	username: string
	kodyId: string
}) {
	if (!isProfilePackage(input)) return buildPackageAppHostOrigin(input)
	if (!isDnsSafeUsername(input.username.toLowerCase())) return null
	return buildPackageAppSubdomainOrigin(input)
}

/**
 * Origin of one package app's own host: `{leaf}--{handle}.` prefixed onto the
 * configured package-app origin's hostname, preserving scheme and port. Null
 * when the pair has no valid host label (for example a legacy leaf that is not
 * lower-kebab-case), so callers fall back to another address instead of
 * emitting a host that cannot route.
 * Remove when: production `PACKAGE_APP_LEGACY_HOSTS` is empty and legacy `/packages` mount and `/_kody/auth` hits stay at zero.
 */
export function buildPackageAppHostOrigin(input: {
	packageAppOrigin: string
	username: string
	kodyId: string
}) {
	const label = buildPackageAppHostLabel({
		leaf: input.kodyId,
		handle: input.username,
	})
	if (!parsePackageAppHostLabel(label)) return null
	const url = new URL(input.packageAppOrigin)
	url.hostname = `${label}.${url.hostname}`
	return url.origin
}

/**
 * Path on a customer custom hostname. The bound app owns the host root, so
 * there is no `/{kodyId}` prefix. An empty rest path is `/`.
 */
export function buildPackageAppCustomHostnamePath(input: {
	restPath?: string | null
}) {
	return buildRestPathSuffix(input.restPath) || '/'
}

export function buildPackageAppCustomHostnameUrl(input: {
	origin: string
	restPath?: string | null
}) {
	return `${input.origin.trim().replace(/\/+$/, '')}${buildPackageAppCustomHostnamePath(input)}`
}

/**
 * Canonical browser URL for a hosted package app, and the only builder
 * surfaces should use for "where does this app live". With a package-app
 * origin configured the app is mounted at the root of its own host
 * ({@link buildPackageAppRootOrigin}: `{leaf}--{handle}.`, or the owner's bare
 * host for a profile package). The shared `{username}.` host path address
 * (`/{kodyId}`, and the older `/packages/{kodyId}`) only serves old links
 * during the migration and is used here only for a pair with no valid host
 * label. Without a package-app origin, non-production deployments serve the
 * app inline under `/@{username}/packages/{kodyId}` on the app origin.
 */
export function resolveHostedPackageAppUrl(input: {
	packageAppBaseUrl: string | null
	appBaseUrl: string
	username: string
	kodyId: string
	restPath?: string | null
}) {
	return resolveHostedPackageAppLocation(input).hostedUrl
}

/**
 * {@link resolveHostedPackageAppUrl} plus the origin-relative mount the app
 * sees: empty when the app owns its host's root.
 */
export function resolveHostedPackageAppLocation(input: {
	packageAppBaseUrl: string | null
	appBaseUrl: string
	username: string
	kodyId: string
	restPath?: string | null
}) {
	if (input.packageAppBaseUrl) {
		const rootOrigin = buildPackageAppRootOrigin({
			packageAppOrigin: input.packageAppBaseUrl,
			username: input.username,
			kodyId: input.kodyId,
		})
		if (rootOrigin) {
			return {
				hostedUrl: buildPackageAppCustomHostnameUrl({
					origin: rootOrigin,
					restPath: input.restPath,
				}),
				appBasePath: '',
			}
		}
		return {
			hostedUrl: buildPackageAppSubdomainUrl({
				packageAppOrigin: input.packageAppBaseUrl,
				username: input.username,
				kodyId: input.kodyId,
				restPath: input.restPath,
			}),
			appBasePath: buildPackageAppSubdomainPath({ kodyId: input.kodyId }),
		}
	}
	return {
		hostedUrl: buildPackageAppUrl({
			origin: input.appBaseUrl,
			username: input.username,
			kodyId: input.kodyId,
			restPath: input.restPath,
		}),
		appBasePath: buildPackageAppPath(input),
	}
}

export function normalizePackageInvocationExportName(exportName: string) {
	const trimmed = exportName.trim()
	if (!trimmed) {
		throw new Error('Package export name must not be empty.')
	}
	if (trimmed === '.' || trimmed === './') {
		return '.'
	}
	return trimmed.startsWith('./') ? trimmed : `./${trimmed}`
}
