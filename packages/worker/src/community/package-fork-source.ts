import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { resolvePackagePageUrl } from '#worker/community/package-url.ts'
import { findPublicOwnerIdentityByHandle } from '#worker/identity/user-lookup.ts'
import { type PrivatePackageForkSource } from './service.ts'

/**
 * Owner org and package for `@owner/leaf`, or null when it does not exist.
 * Callers still check `package:read` before revealing or forking it.
 */
export async function resolvePackageForkSource(
	env: Env,
	input: { ownerHandle: string; kodyId: string },
): Promise<PrivatePackageForkSource | null> {
	const identity = await findPublicOwnerIdentityByHandle({
		db: env.APP_DB,
		handle: input.ownerHandle,
	})
	if (!identity) return null
	const page = await resolvePackagePageUrl({
		db: env.APP_DB,
		username: identity.handle,
		kodyId: input.kodyId,
	})
	if (page?.kind !== 'package' || !page.savedPackage) return null
	return {
		ownerId: page.userId as OwnerId,
		packageId: page.savedPackage.id,
	}
}
