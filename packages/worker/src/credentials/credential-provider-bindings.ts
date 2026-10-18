/**
 * Custom secret provider (vault) bindings for the Credentials page. The
 * credentials list contract leaves them out of `credentialKinds`, so the page
 * lists them in their own section. Nothing here selects a value.
 */
import { type CredentialProviderBindingItem } from '#universal/credentials-list.ts'
import { readCredentialFillPlacement } from './fill-placement.ts'

type ProviderBindingRow = {
	id: string
	provider_id: string
	provider: string | null
	package_id: string
	door_secret_name: string
	placement_json: string | null
	updated_at: string
}

export async function listCredentialProviderBindings(
	db: D1Database,
	ownerId: string,
): Promise<Array<CredentialProviderBindingItem>> {
	const result = await db
		.prepare(
			`SELECT id, provider_id, provider, package_id, door_secret_name,
				placement_json, updated_at
			FROM secret_provider_bindings
			WHERE user_id = ? AND id IS NOT NULL AND deleted_at IS NULL`,
		)
		.bind(ownerId)
		.all<ProviderBindingRow>()
	return (result.results ?? [])
		.map((row) => ({
			id: row.id,
			providerId: row.provider_id,
			provider: row.provider,
			packageId: row.package_id,
			doorSecretName: row.door_secret_name,
			placement: readCredentialFillPlacement(row.placement_json),
			updatedAt: row.updated_at,
		}))
		.sort((left, right) => left.providerId.localeCompare(right.providerId))
}
