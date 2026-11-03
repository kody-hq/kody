import {
	formatPackageAppOauthClientId,
	parsePackageAppOauthClientId,
	type PackageAppOauthClientId,
} from '#app/package-app-oauth-client-id.ts'
import {
	resolvePackageAppOrgOwnerByHandle,
	type PackageAppOrgOwner,
} from '#app/package-app-owner.ts'
import { resolveSavedPackageForPackageAppSlug } from '#worker/package-invocations/module-artifacts.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'

/**
 * A package-app OAuth client is not registered — it is a real hosted package
 * (`owner/leaf` with `has_app`). Authorize and host login must resolve this
 * before trusting a subdomain label or a caller-supplied `client_id`.
 */
export type ResolvedPackageAppOauthClient = {
	client: PackageAppOauthClientId
	org: PackageAppOrgOwner
	savedPackage: SavedPackageRecord
}

export async function resolvePackageAppOauthClient(input: {
	env: Env
	username: string
	kodyId: string
}): Promise<ResolvedPackageAppOauthClient | null> {
	const parsed = parsePackageAppOauthClientId(
		formatPackageAppOauthClientId({
			username: input.username,
			kodyId: input.kodyId,
		}),
	)
	if (!parsed) return null

	const org = await resolvePackageAppOrgOwnerByHandle({
		env: input.env,
		handle: parsed.username,
	})
	if (!org) return null

	const lookup = await resolveSavedPackageForPackageAppSlug({
		db: input.env.APP_DB,
		userId: org.userId,
		slug: parsed.kodyId,
	})
	// Require the live leaf: retired slug redirects must not rewrite OAuth
	// client_id to a different leaf (custom host / grant identity stays bound
	// to the requested owner/leaf only when that leaf is current).
	if (!lookup?.savedPackage.hasApp || lookup.retired) return null

	const username = org.username.trim().toLowerCase()
	const kodyId = parsed.kodyId
	return {
		client: {
			username,
			kodyId,
			clientId: formatPackageAppOauthClientId({ username, kodyId }),
		},
		org,
		savedPackage: lookup.savedPackage,
	}
}
