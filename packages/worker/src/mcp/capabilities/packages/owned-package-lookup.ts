import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	normalizePackageNameInput,
	packageIdLookupDescription,
	packageNameLookupDescription,
} from '#worker/package-registry/package-name.ts'
import {
	getSavedPackageById,
	resolveSavedPackageRef,
} from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { z } from 'zod'

export const packageIdentityInputShape = {
	package_id: z.string().min(1).optional().describe(packageIdLookupDescription),
	kody_id: z.string().min(1).optional().describe(packageNameLookupDescription),
}

export type PackageIdentity = {
	package_id?: string
	kody_id?: string
}

export const packageIdentityCountMessage =
	'Provide exactly one of `package_id` or the package name leaf.'

export function requireExactlyOnePackageIdentity(args: PackageIdentity) {
	const count =
		(args.package_id !== undefined ? 1 : 0) +
		(args.kody_id !== undefined ? 1 : 0)
	if (count !== 1) {
		throw new McpCallerError(packageIdentityCountMessage)
	}
}

export function normalizeRequestedKodyId(input: {
	kodyId: string | undefined
	ownerScope: string
}) {
	if (input.kodyId === undefined) return undefined
	try {
		return normalizePackageNameInput({
			value: input.kodyId,
			ownerScope: input.ownerScope,
			action: 'resolve',
		})
	} catch (error) {
		throw new McpCallerError(getErrorMessage(error), { cause: error })
	}
}

export async function findOwnedSavedPackage(input: {
	db: D1Database
	userId: string
	ownerScope: string
	args: PackageIdentity
}): Promise<{
	savedPackage: SavedPackageRecord | null
	requestedKodyId: string | undefined
}> {
	const requestedKodyId = normalizeRequestedKodyId({
		kodyId: input.args.kody_id,
		ownerScope: input.ownerScope,
	})
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
	return { savedPackage, requestedKodyId }
}
