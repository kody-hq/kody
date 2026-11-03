import type { McpUserContext } from '@kody-internal/shared/chat.ts'
import type {
	OwnerId,
	PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import type { AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	AuthorizationError,
	authorizePackageWrite,
} from '#worker/authorization/authorize.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'

type PackageWritePermission =
	| 'package:write'
	| 'package:delete'
	| 'package:publish'

export type WritableAccountSavedPackage = {
	savedPackage: SavedPackageRecord
	ownerUserId: OwnerId
	actorUserId: PersonId
}

function packageNotFoundResponse() {
	return jsonResponse({ ok: false, error: 'Package not found.' }, 404)
}

async function requestContextForOwningOrg(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'>
	ownerUserId: string
}) {
	const binding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		input.viewer.userId,
		input.ownerUserId,
	)
	if (!binding) return null
	return deriveRequestContext({
		user: input.viewer,
		source: { kind: 'session' },
		orgBinding: binding,
	})
}

/**
 * Load a saved package for account JSON write actions. Resolves the row in
 * whichever org owns it, rebinds authorization to that org, and checks the
 * requested package write permission there.
 */
export async function loadWritableAccountSavedPackage(input: {
	env: Env
	user: AuthenticatedAppUser
	packageId: string
	permission: PackageWritePermission
}): Promise<
	| { ok: true; package: WritableAccountSavedPackage }
	| { ok: false; response: Response }
> {
	const savedPackage = await getSavedPackageByIdInAnyOrg(
		input.env.APP_DB,
		input.packageId,
	)
	if (!savedPackage) {
		return { ok: false, response: packageNotFoundResponse() }
	}
	const request = await requestContextForOwningOrg({
		env: input.env,
		viewer: input.user.mcpUser,
		ownerUserId: savedPackage.userId,
	})
	if (!request) {
		return { ok: false, response: packageNotFoundResponse() }
	}
	try {
		await authorizePackageWrite(
			{ env: input.env, request },
			{
				id: savedPackage.id,
				userId: savedPackage.userId,
				label: savedPackage.name,
			},
			input.permission,
		)
	} catch (error) {
		if (error instanceof AuthorizationError) {
			return { ok: false, response: packageNotFoundResponse() }
		}
		throw error
	}
	return {
		ok: true,
		package: {
			savedPackage,
			ownerUserId: savedPackage.userId,
			actorUserId: input.user.mcpUser.userId,
		},
	}
}
