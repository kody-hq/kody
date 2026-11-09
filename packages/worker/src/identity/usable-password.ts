const usablePasswordHashPrefix = 'pbkdf2_sha256$'

/**
 * Stored `users.password_hash` values that are not PBKDF2 and never verify.
 * `verifyPassword` rejects anything that is not a pbkdf2_sha256 hash; these
 * labels exist so operators can tell why an account has no usable password.
 */
export const unusablePasswordHash = {
	oauthCreated: 'oauth_created_no_usable_password',
	adminCreated: 'admin_created_no_usable_password',
	reclaimedUnverified: 'reclaimed_unverified_no_usable_password',
	guestCreated: 'guest_created_no_usable_password',
} as const

export function isUsablePasswordHash(passwordHash: string | null | undefined) {
	return passwordHash?.startsWith(usablePasswordHashPrefix) === true
}
