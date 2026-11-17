import { buildPackageAppRootOrigin } from '@kody-internal/shared/public-urls.ts'
import type { PackageAppPath } from '#worker/package-runtime/package-app-serve.ts'

/**
 * The moment `https://{handle}.kody.run/{app}/` stops serving apps and only
 * redirects to `https://{app}--{handle}.kody.run/`: 30 days after the owner
 * notice went out (2026-11-17 20:45 UTC), on the date that notice names.
 * The production Wrangler environment sets `PACKAGE_APP_PATH_MOUNT_CUTOVER_AT`
 * to this value. The preview and test environments leave it unset and keep
 * serving the path address.
 */
export const packageAppPathMountCutoverAt = '2026-12-17T20:45:00Z'

export type PackageAppPathMountCutoverEnv = {
	PACKAGE_APP_PATH_MOUNT_CUTOVER_AT?: string
}

const isoUtcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** False when the var is unset or not a UTC ISO timestamp, so a typo never cuts over early. */
export function isPackageAppPathMountCutOver(input: {
	env: PackageAppPathMountCutoverEnv
	now?: number
}) {
	const configured = input.env.PACKAGE_APP_PATH_MOUNT_CUTOVER_AT?.trim()
	if (!configured || !isoUtcTimestampPattern.test(configured)) return false
	const cutoverAt = Date.parse(configured)
	if (!Number.isFinite(cutoverAt)) return false
	return (input.now ?? Date.now()) >= cutoverAt
}

/**
 * Where a request to the path address goes after cutover: the same path and
 * query on the app's own host. Null before cutover, and for a pair with no
 * valid host label, which keeps being served where it is.
 */
export function buildPackageAppPathMountCutoverLocation(input: {
	env: PackageAppPathMountCutoverEnv
	packageAppOrigin: string
	packagePath: Pick<PackageAppPath, 'username' | 'kodyId' | 'restPath'>
	url: URL
	now?: number
}) {
	if (!isPackageAppPathMountCutOver(input)) return null
	const origin = buildPackageAppRootOrigin({
		packageAppOrigin: input.packageAppOrigin,
		username: input.packagePath.username,
		kodyId: input.packagePath.kodyId,
	})
	if (!origin) return null
	return `${origin}${input.packagePath.restPath}${input.url.search}`
}
