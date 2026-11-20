/**
 * Local execute must not hop package-scoped secret mutations to CapabilityProxy.
 * Origin would otherwise often answer `insufficient_scope` for `secret:write` /
 * `secret:create` because the local bridge does not attach package secret
 * authority — a misleading hint to remint scopes.
 *
 * Keep this fail-closed: do not invent a local write path that trusts a
 * client-supplied package id as proof of a hosted package run. `secretSet`
 * with `package_id` is not that: Kody checks the package belongs to the
 * caller's org and that the caller may create secrets there.
 */

export const localPackageScopedSecretWriteUnavailableMessage =
	'Package-scoped secret writes in local execution need an explicit package: pass `package_id` (a saved package in this org) to `secretSet`. The local CapabilityProxy bridge does not attach package secret authority, so a write without `package_id` has no package to land in.'

const packageSecretMutations = new Set([
	'secretSet',
	'secretSetMany',
	'secretDelete',
	'secretDisconnect',
])

function firstArgRecord(
	args: ReadonlyArray<unknown>,
): Record<string, unknown> | null {
	const first = args[0]
	if (first == null || typeof first !== 'object' || Array.isArray(first)) {
		return null
	}
	return first as Record<string, unknown>
}

function hasPackageTarget(value: unknown): boolean {
	return typeof value === 'string' && value.trim() !== ''
}

function isPackageScope(value: unknown): boolean {
	return typeof value === 'string' && value.trim() === 'package'
}

/**
 * @returns Error message when this CapabilityProxy call is a package-scoped
 * secret mutation; otherwise null.
 */
export function localPackageScopedSecretWriteBlockReason(
	path: ReadonlyArray<string>,
	args: ReadonlyArray<unknown>,
): string | null {
	if (path.length !== 2 || path[0] !== 'kody') return null
	const name = path[1]
	if (typeof name !== 'string' || !packageSecretMutations.has(name)) return null

	const record = firstArgRecord(args)
	if (!record) return null

	if (name === 'secretSetMany') {
		const secrets = record.secrets
		if (!Array.isArray(secrets)) return null
		const touchesPackage = secrets.some((entry) => {
			if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
				return false
			}
			return isPackageScope((entry as { scope?: unknown }).scope)
		})
		return touchesPackage
			? localPackageScopedSecretWriteUnavailableMessage
			: null
	}

	// Kody resolves and authorizes `package_id` against the caller's org.
	if (name === 'secretSet' && hasPackageTarget(record.package_id)) return null

	return isPackageScope(record.scope)
		? localPackageScopedSecretWriteUnavailableMessage
		: null
}

export function assertLocalPackageScopedSecretWriteAllowed(
	path: ReadonlyArray<string>,
	args: ReadonlyArray<unknown>,
): void {
	const reason = localPackageScopedSecretWriteBlockReason(path, args)
	if (reason) throw new Error(reason)
}
