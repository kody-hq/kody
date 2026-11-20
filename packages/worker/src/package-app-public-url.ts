import {
	buildPackageAppCustomHostnameUrl,
	buildPackageAppRootOrigin,
	buildPackageAppSubdomainPath,
	isProfilePackage,
	buildPackageAppSubdomainUrl,
	resolveHostedPackageAppUrl,
} from '@kody-internal/shared/public-urls.ts'
import { isPackageAppPathMountCutOver } from '#worker/package-runtime/package-app-path-mount-cutover.ts'
import { hasProfilePackageApp } from '#worker/package-app-profile-host.ts'
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import { lookupVerifiedAppCustomHostnameForPackage } from '#worker/package-app-custom-hostnames/lookup.ts'
import {
	getPackageNameLeaf,
	getPackageNameScope,
} from '#worker/package-registry/package-name.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'

/**
 * Where a browser should open a hosted package app when it does not need a
 * kody.codes session handoff (and the hosted target for `/open` handoff).
 *
 * A verified app-level custom hostname wins (both hostname and certificate
 * active; lexicographically smallest when several qualify). Pending hostnames
 * never win. A profile package (`@{slug}/{slug}`) owns the root of the owner's
 * `kody.run` subdomain, and the owner's other apps are then only reachable on
 * their own `{leaf}--{handle}` hosts. After the path-mount cutover every app with a
 * valid host label opens on its own host. Otherwise this is the per-user `kody.run` subdomain. Org-level
 * custom hostnames are session-gated and are not a public origin. Returns null
 * when this deployment serves package apps inline on the app origin (no
 * `PACKAGE_APP_BASE_URL`).
 */
export type PublicPackageAppLocation = {
	hostedUrl: string
	/**
	 * Origin-relative mount. Empty on an app-level custom hostname (the app
	 * owns `/`). On a subdomain this is `/{kodyId}` (legacy `/packages/{kodyId}`
	 * is still served but is not the public shape).
	 * Remove when: production `PACKAGE_APP_LEGACY_HOSTS` is empty and legacy `/packages` mount and `/_kody/auth` hits stay at zero.
	 */
	appBasePath: string
}

export async function resolvePublicPackageAppLocation(input: {
	env: Env
	username: string
	kodyId: string
	restPath?: string | null
}): Promise<PublicPackageAppLocation | null> {
	const packageAppBaseUrl = getPackageAppBaseUrl({ env: input.env })
	if (!packageAppBaseUrl) return null
	const customOrigin = await verifiedAppCustomOrigin(input)
	if (customOrigin) {
		return {
			hostedUrl: buildPackageAppCustomHostnameUrl({
				origin: customOrigin,
				restPath: input.restPath,
			}),
			appBasePath: '',
		}
	}
	const rootOrigin =
		isProfilePackage(input) ||
		isPackageAppPathMountCutOver({ env: input.env }) ||
		(await hasProfilePackageApp({ env: input.env, username: input.username }))
			? buildPackageAppRootOrigin({
					packageAppOrigin: packageAppBaseUrl,
					username: input.username,
					kodyId: input.kodyId,
				})
			: null
	if (rootOrigin) {
		return {
			hostedUrl: buildPackageAppCustomHostnameUrl({
				origin: rootOrigin,
				restPath: input.restPath,
			}),
			appBasePath: '',
		}
	}
	const hostedUrl = buildPackageAppSubdomainUrl({
		packageAppOrigin: packageAppBaseUrl,
		username: input.username,
		kodyId: input.kodyId,
		restPath: input.restPath,
	})
	return {
		hostedUrl,
		appBasePath: buildPackageAppSubdomainPath({
			kodyId: input.kodyId,
			restPath: input.restPath,
		}),
	}
}

async function verifiedAppCustomOrigin(input: {
	env: Env
	username: string
	kodyId: string
}): Promise<string | null> {
	try {
		const mapping = await lookupVerifiedAppCustomHostnameForPackage({
			db: input.env.APP_DB,
			username: input.username,
			kodyId: input.kodyId,
		})
		if (!mapping) return null
		return `https://${mapping.hostname}`
	} catch {
		// Unit tests often have no custom-hostname table. The subdomain URL
		// is still the public origin.
		return null
	}
}

/**
 * The app URL a package's code reads in `packageContext` when no request is
 * serving it (execute imports, jobs, webhooks, package invocations): the same
 * canonical location a browser opens, otherwise the inline mount on the app
 * origin. Both fields are null when the package has no app.
 */
export type PackageAppRunLocation = {
	hostedUrl: string | null
	appBasePath: string | null
}

export const noPackageAppRunLocation: PackageAppRunLocation = Object.freeze({
	hostedUrl: null,
	appBasePath: null,
})

export async function resolveCanonicalPackageAppLocation(input: {
	env: Env
	baseUrl: string
	packageName: string
}): Promise<PublicPackageAppLocation> {
	const username = getPackageNameScope(input.packageName)
	if (!username) {
		throw new Error(
			`Saved package name "${input.packageName}" must include a username scope.`,
		)
	}
	// Public URLs use the name leaf; kodyId stays identity only.
	const kodyId = getPackageNameLeaf(input.packageName)
	const canonical = await resolvePublicPackageAppLocation({
		env: input.env,
		username,
		kodyId,
	})
	if (canonical) return canonical
	const hostedUrl = resolveHostedPackageAppUrl({
		packageAppBaseUrl: getPackageAppBaseUrl({ env: input.env }),
		appBaseUrl: input.baseUrl,
		username,
		kodyId,
	})
	return { hostedUrl, appBasePath: new URL(hostedUrl).pathname }
}

export async function resolvePackageAppRunLocation(input: {
	env: Env
	baseUrl: string
	savedPackage: { name: string; hasApp: boolean }
}): Promise<PackageAppRunLocation> {
	if (!input.savedPackage.hasApp) return noPackageAppRunLocation
	return await resolveCanonicalPackageAppLocation({
		env: input.env,
		baseUrl: input.baseUrl,
		packageName: input.savedPackage.name,
	})
}

/**
 * App locations for every package a run may act as (its own package plus the
 * saved packages it imports), keyed by package id, so each package's code
 * reads its own `packageContext.hostedUrl` the same way on every surface.
 */
export async function resolvePackageAppRunLocations(input: {
	env: Env
	baseUrl: string
	packageIds: Iterable<string>
}): Promise<Record<string, PackageAppRunLocation>> {
	const entries = await Promise.all(
		[...new Set(input.packageIds)].map(async (packageId) => {
			const savedPackage = await getSavedPackageByIdInAnyOrg(
				input.env.APP_DB,
				packageId,
			)
			const location = savedPackage
				? await resolvePackageAppRunLocation({
						env: input.env,
						baseUrl: input.baseUrl,
						savedPackage,
					})
				: noPackageAppRunLocation
			return [packageId, location] as const
		}),
	)
	return Object.fromEntries(entries)
}
