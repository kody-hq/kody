import { McpCallerError } from '#mcp/caller-error.ts'
import { getSecretBindingKey } from '#mcp/secrets/secret-bindings.ts'
import type { SecretScope } from '#mcp/secrets/types.ts'
import type { StorageContext } from '#mcp/storage.ts'

/**
 * Thrown before `authorizeSecretSet` / `secret:write` so local execute (and
 * any other context without a package runtime binding) does not surface a
 * misleading `insufficient_scope` for `secret:write` / `secret:create`.
 *
 * Local CapabilityProxy does not attach package secret authority; a
 * client-supplied package id is not trusted as proof of a hosted package run.
 */
export const packageScopedSecretWriteUnavailableMessage =
	'Package-scoped secret writes are not available without a package runtime (local `kody execute --local` does not attach package secret authority; a client-supplied package id is not trusted). Run this via hosted package execute, or set the secret with the account UI (/connect/secret-set) or Open API `secretSet` with a user scope / outside local execute.'

export function assertPackageScopedSecretWriteAvailable(input: {
	scope: SecretScope
	storageContext: StorageContext | null
}): void {
	if (input.scope !== 'package') return
	if (getSecretBindingKey('package', input.storageContext) != null) return
	throw new McpCallerError(packageScopedSecretWriteUnavailableMessage)
}
