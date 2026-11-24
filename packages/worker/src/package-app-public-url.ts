import {
	buildPackageAppCustomHostnameUrl,
	resolveHostedPackageAppLocation,
	resolveHostedPackageAppUrl,
} from '@kody-internal/shared/public-urls.ts'
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import { lookupVerifiedAppCustomHostnameForPackage } from '#worker/package-app-custom-hostnames/lookup.ts'
import {
	getPackageNameLeaf,
	getPackageNameScope,
} from '#worker/package-registry/package-name.ts'
import { listSavedPackagesByIdsInAnyOrg } from '#worker/package-registry/repo.ts'

/**
 * Where a browser should open a hosted package app when it does not need a
 * kody.codes session handoff (and the hosted target for `/open` handoff).
 *
 * A verified app-level custom hostname wins (both hostname and certificate
 * active; lexicographically smallest when several qualify). Pending hostnames
 * never win. Otherwise this is {@link resolveHostedPackageAppLocation}: the
 * root of the app's own `{leaf}--{handle}` host (the owner's bare host for a
 * profile package `@{slug}/{slug}`). The shared `{username}.` host path
 * address is only for a pair with no valid host label. Org-level
 * custom hostnames are session-gated and are not a public origin. Returns null
 * when this deployment serves package apps inline on the app origin (no
 * `PACKAGE_APP_BASE_URL`).
 */
export type PublicPackageAppLocation = {
	hostedUrl: string
	/**
	 * Origin-relative mount. Empty on an app-level custom hostname (the app
	 * owns `/`). Only a pair with no valid host label gets `/{kodyId}` on the
	 * shared owner host.
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
	return resolveHostedPackageAppLocation({
		packageAppBaseUrl,
		appBaseUrl: packageAppBaseUrl,
		username: input.username,
		kodyId: input.kodyId,
		restPath: input.restPath,
	})
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
	const packageIds = [...new Set(input.packageIds)]
	const savedPackages = new Map(
		(await listSavedPackagesByIdsInAnyOrg(input.env.APP_DB, packageIds)).map(
			(savedPackage) => [savedPackage.id, savedPackage],
		),
	)
	const entries = await Promise.all(
		packageIds.map(async (packageId) => {
			const savedPackage = savedPackages.get(packageId)
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
