import { type StorageContext } from '#mcp/storage.ts'
import { type CredentialFillPlacement } from '#worker/credentials/fill-placement.ts'

export const secretScopeValues = ['session', 'package', 'user'] as const

export type SecretScope = (typeof secretScopeValues)[number]

export type SecretBucketRow = {
	id: string
	user_id: string
	scope: SecretScope
	binding_key: string
	expires_at: string | null
	created_at: string
	updated_at: string
}

/**
 * What a stored credential is (migration 0117). Placeholders fill only a
 * `secret`; each later kind has its own resolver behind `resolveCredential`.
 */
export const storedCredentialKinds = [
	'secret',
	'url',
	'login',
	'signing',
] as const

export type StoredCredentialKind = (typeof storedCredentialKinds)[number]

export type SecretEntryRow = {
	/** Stable credential id, assigned by the database on insert. */
	id: string
	bucket_id: string
	name: string
	description: string
	encrypted_value: string
	allowed_hosts: string
	allowed_packages: string
	expires_at: string | null
	created_at: string
	updated_at: string
}

export type SecretMetadata = {
	name: string
	scope: SecretScope
	description: string
	packageId: string | null
	allowedHosts: Array<string>
	allowedPackages: Array<string>
	createdAt: string
	updatedAt: string
	expiresAt: string | null
	ttlMs: number | null
	/** Null means anywhere. */
	placement: CredentialFillPlacement | null
}

/** Listed secrets carry the credential id that grants are keyed by. */
export type ListedSecret = SecretMetadata & { credentialId: string }

export type SecretSearchRow = Pick<
	SecretMetadata,
	'name' | 'scope' | 'description' | 'packageId' | 'updatedAt'
> & { credentialId: string }

export type { StorageContext }
