import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	buildPendingCommunityForkLookupMessage,
	findPendingCommunityForkForLookup,
} from '#worker/community/pending-fork-lookup.ts'
import { getEntitySourceByIdForUser } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import {
	findOwnedSavedPackage,
	requireExactlyOnePackageIdentity,
	type PackageIdentity,
} from './owned-package-lookup.ts'

export type PackageSourceIdentity = PackageIdentity

/**
 * Resolve a saved package and its repo source in the org that owns the
 * connection (`userId` is that org, `ownerScope` its package scope). A name
 * leaf or `package_id` from another org is never resolved.
 */
export async function resolveOwnedPackageSource(input: {
	db: D1Database
	userId: OwnerId
	ownerScope: string
	args: PackageSourceIdentity
}): Promise<{
	packageId: string
	userId: OwnerId
	kodyId: string
	name: string
	hasApp: boolean
	source: EntitySourceRow
}> {
	requireExactlyOnePackageIdentity(input.args)
	const { savedPackage, requestedKodyId } = await findOwnedSavedPackage({
		db: input.db,
		userId: input.userId,
		ownerScope: input.ownerScope,
		args: input.args,
	})
	if (!savedPackage) {
		const missingId = input.args.package_id ?? input.args.kody_id
		const pendingFork = await findPendingCommunityForkForLookup(input.db, {
			forkerUserId: input.userId,
			packageIdOrKodyId: input.args.package_id ?? requestedKodyId ?? '',
		})
		if (pendingFork) {
			throw new McpCallerError(
				buildPendingCommunityForkLookupMessage({
					fork: pendingFork,
					ownerScope: input.ownerScope,
				}),
			)
		}
		throw new McpCallerError(
			`Saved package "${missingId}" was not found in @${input.ownerScope}, the org this connection is bound to. packageList lists the saved packages @${input.ownerScope} owns with their package_id; to use a package another org owns, bind the connection to that org.`,
		)
	}
	const source = await getEntitySourceByIdForUser(input.db, {
		id: savedPackage.sourceId,
		userId: input.userId,
	})
	if (!source) {
		throw new McpCallerError(
			`Saved package "${savedPackage.name}" (package_id ${savedPackage.id}) is missing its repo source record "${savedPackage.sourceId}". This is a missing source record, not an org-binding problem: the package row exists in @${input.ownerScope} but its source does not. Repair the source record or recreate the package.`,
		)
	}
	return {
		packageId: savedPackage.id,
		userId: savedPackage.userId,
		kodyId: savedPackage.kodyId,
		name: savedPackage.name,
		hasApp: savedPackage.hasApp,
		source,
	}
}
