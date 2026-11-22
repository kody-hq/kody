import { McpCallerError } from '#mcp/caller-error.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { getSecretBindingKey } from '#mcp/secrets/secret-bindings.ts'
import type { SecretScope } from '#mcp/secrets/types.ts'
import type { StorageContext } from '#mcp/storage.ts'

/**
 * Thrown before `authorizeSecretSet` / `secret:write` so local execute (and
 * any other context without a package runtime binding) does not surface a
 * misleading `insufficient_scope` for `secret:write` / `secret:create`.
 *
 * Local CapabilityProxy does not attach package runtime authority.
 * `secretSet` separately supports an explicit, authorized package target.
 */
export const packageScopedSecretWriteUnavailableMessage =
	"Package-scoped secret writes need a package. Pass `package_id` (a saved package in this org) to `secretSet`, or run it from that package's own code."

export function assertPackageScopedSecretWriteAvailable(input: {
	scope: SecretScope
	storageContext: StorageContext | null
}): void {
	if (input.scope !== 'package') return
	if (getSecretBindingKey('package', input.storageContext) != null) return
	throw new McpCallerError(packageScopedSecretWriteUnavailableMessage)
}

/**
 * The storage context a package-scope `secretSet` writes into. `package_id`
 * names a saved package of the caller's org (the same packages the website's
 * package picker offers); the caller still needs `secret:create` /
 * `secret:write` from `authorizeSecretSet`. Package code may only name its
 * own package.
 */
export async function resolvePackageScopedSecretWriteContext(
	ctx: CapabilityContext,
	input: {
		scope: SecretScope
		packageId: string | undefined
		authorityPackageId: string | null
		storageContext: StorageContext
	},
): Promise<StorageContext> {
	if (input.packageId === undefined) {
		assertPackageScopedSecretWriteAvailable(input)
		return input.storageContext
	}
	if (input.scope !== 'package') {
		throw new McpCallerError('package_id needs scope "package".')
	}
	if (
		input.authorityPackageId &&
		input.authorityPackageId !== input.packageId
	) {
		throw new McpCallerError(
			'Package code can only set package-scoped secrets for its own package.',
		)
	}
	const savedPackage = await getSavedPackageById(ctx.env.APP_DB, {
		userId: ownerIdFromCaller(ctx.callerContext),
		packageId: input.packageId,
	})
	if (!savedPackage) {
		throw new McpCallerError(
			`Package "${input.packageId}" was not found in this org.`,
		)
	}
	return {
		sessionId: null,
		appId: null,
		packageId: savedPackage.id,
		storageId: null,
	}
}
