/**
 * The local address of a package app under `kody dev`. It is the hosted
 * shape on a different base: `https://{leaf}--{handle}.kody.run` in
 * production, `http://{leaf}--{handle}.localhost:<port>` here, built by the
 * same functions. Browsers resolve `*.localhost` to loopback themselves.
 */

import {
	buildPackageAppRootOrigin,
	buildPackageAppSubdomainOrigin,
	isDnsSafeUsername,
} from '@kody-internal/shared/public-urls.ts'
import type { KodyPackageManifest } from '../package-manifest.js'

/** Local account username: the package scope when there is one. */
export function localUsernameFor(manifest: Pick<KodyPackageManifest, 'name'>) {
	const scope = /^@([a-z0-9][a-z0-9-]*)\//i.exec(manifest.name)?.[1]
	return (scope ?? 'dev').toLowerCase()
}

/**
 * Origin the app is served on at `port`, or null when the names cannot form
 * a host label. With `appBasePath` it is the old path shape instead: the
 * owner's `{handle}` host, with the app under that path.
 */
export function devPackageAppOrigin(input: {
	username: string
	kodyId: string
	port: number
	appBasePath: string
}): string | null {
	const packageAppOrigin = `http://localhost:${input.port}`
	if (!input.appBasePath) {
		return buildPackageAppRootOrigin({
			packageAppOrigin,
			username: input.username,
			kodyId: input.kodyId,
		})
	}
	if (!isDnsSafeUsername(input.username)) return null
	return buildPackageAppSubdomainOrigin({
		packageAppOrigin,
		username: input.username,
	})
}
