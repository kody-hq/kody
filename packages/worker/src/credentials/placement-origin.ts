/**
 * How a stored fill placement was chosen. Null on legacy rows created before
 * this column existed.
 *
 * - `manifest`: package `kody.credentials` declaration applied on insert (or
 *   re-applied later onto an untouched default).
 * - `default_unread`: headers-only default because the package manifest could
 *   not be read at insert (or declaration parse failed).
 * - `default_undeclared`: headers-only default because the package has no
 *   placement on that need.
 * - `owner`: set from the credential page editor.
 * - `explicit`: set via secretSet / credentialUpdate placement input.
 * Remove when: `/connect/secret-set` gets no traffic; then delete the redirect.
 */
export const credentialPlacementOrigins = [
	'manifest',
	'default_unread',
	'default_undeclared',
	'owner',
	'explicit',
] as const

export type CredentialPlacementOrigin =
	(typeof credentialPlacementOrigins)[number]

export function isCredentialPlacementOrigin(
	value: unknown,
): value is CredentialPlacementOrigin {
	return (
		typeof value === 'string' &&
		(credentialPlacementOrigins as ReadonlyArray<string>).includes(value)
	)
}

/** Origins that still hold the untouched headers-only default and may be repaired. */
export function placementOriginAllowsManifestRepair(
	origin: CredentialPlacementOrigin | null,
): boolean {
	return (
		origin === null ||
		origin === 'default_unread' ||
		origin === 'default_undeclared'
	)
}
