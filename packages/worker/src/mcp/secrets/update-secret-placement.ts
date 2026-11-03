import {
	type CredentialFillPlacement,
	serializeCredentialFillPlacement,
} from '#worker/credentials/fill-placement.ts'
import type { CredentialPlacementOrigin } from '#worker/credentials/placement-origin.ts'

/** Update stored fill placement and origin on an existing secret entry. */
export async function updateSecretEntryPlacement(input: {
	db: D1Database
	bucketId: string
	name: string
	placement: CredentialFillPlacement | null
	origin: CredentialPlacementOrigin
	updatedAt?: string
}): Promise<void> {
	await input.db
		.prepare(
			`UPDATE secret_entries
			SET placement_json = ?, placement_origin = ?, updated_at = ?
			WHERE bucket_id = ? AND name = ? AND deleted_at IS NULL`,
		)
		.bind(
			serializeCredentialFillPlacement(input.placement),
			input.origin,
			input.updatedAt ?? new Date().toISOString(),
			input.bucketId,
			input.name,
		)
		.run()
}
