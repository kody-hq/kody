import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { buildPendingCommunityForkLookupMessage } from '#worker/community/pending-fork-lookup.ts'
import { findPendingCommunityForkForLookup } from '#worker/community/repo.ts'
import { normalizePackageNameInput } from '#worker/package-registry/package-name.ts'
import {
	getSavedPackageById,
	resolveSavedPackageRef,
} from '#worker/package-registry/repo.ts'
import { getEntitySourceByIdForUser } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'

export type PackageSourceIdentity = {
	package_id?: string
	kody_id?: string
}

function requireExactlyOnePackageSourceIdentity(input: PackageSourceIdentity) {
	const count =
		(input.package_id !== undefined ? 1 : 0) +
		(input.kody_id !== undefined ? 1 : 0)
	if (count !== 1) {
		throw new McpCallerError(
			'Provide exactly one of `package_id` or the package name leaf.',
		)
	}
}

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
	requireExactlyOnePackageSourceIdentity(input.args)
	let requestedKodyId: string | undefined
	if (input.args.kody_id !== undefined) {
		try {
			requestedKodyId = normalizePackageNameInput({
				value: input.args.kody_id,
				ownerScope: input.ownerScope,
				action: 'resolve',
			})
		} catch (error) {
			throw new McpCallerError(getErrorMessage(error), { cause: error })
		}
	}
	const savedPackage =
		input.args.package_id !== undefined
			? await getSavedPackageById(input.db, {
					userId: input.userId,
					packageId: input.args.package_id,
				})
			: await resolveSavedPackageRef(input.db, {
					userId: input.userId,
					ref: requestedKodyId ?? '',
					match: 'slug',
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
