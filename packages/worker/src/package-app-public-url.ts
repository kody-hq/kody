import {
	buildPackageAppCustomHostnameUrl,
	buildPackageAppSubdomainPath,
	buildPackageAppSubdomainUrl,
} from '@kody-internal/shared/public-urls.ts'
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import { isPackageAppCustomDomainsEnabled } from '#worker/package-app-custom-hostnames/feature-flag.ts'
import { lookupVerifiedAppCustomHostnameForPackage } from '#worker/package-app-custom-hostnames/lookup.ts'

/**
 * Where a browser should open a hosted package app when it does not need a
 * kody.codes session handoff.
 *
 * App-level custom hostnames win. Otherwise this is the per-user `kody.run`
 * subdomain. Org-level custom hostnames are session-gated and are not a public
 * origin. Returns null when this deployment serves package apps inline on the
 * app origin (no `PACKAGE_APP_BASE_URL`).
 */
export type PublicPackageAppLocation = {
	hostedUrl: string
	/**
	 * Origin-relative mount. Empty on an app-level custom hostname (the app
	 * owns `/`). On a subdomain this is `/packages/{kodyId}`.
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
		if (!(await isPackageAppCustomDomainsEnabled(input.env.APP_DB))) return null
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
