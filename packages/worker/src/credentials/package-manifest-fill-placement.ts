/**
 * Apply a package's declared `kody.credentials` fill placement when inserting
 * a package-scope secret for that package (Connect / secretSet when no row
 * exists yet). Disconnect keeps the row; reconnect does not re-apply this
 * unless the row still holds an untouched headers-only default (see
 * placement_origin repair). Runtime cannot pass placement; the published
 * manifest is the reviewable source.
 */
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	type CredentialFillPlacement,
	credentialFillPlacementSchema,
} from '#worker/credentials/fill-placement.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'

export type DeclaredPackageSecretFillPlacementRead =
	| { status: 'applied'; placement: CredentialFillPlacement }
	| { status: 'undeclared' }
	| { status: 'unread'; reason: string }

/**
 * Read the package's declared fill placement for a secret name.
 * Distinguishes undeclared (no slot / no placement) from unread (missing
 * package, load failure, invalid placement JSON).
 */
export async function readDeclaredPackageSecretFillPlacement(input: {
	env: Env
	userId: OwnerId
	baseUrl: string
	packageId: string
	secretName: string
}): Promise<DeclaredPackageSecretFillPlacementRead> {
	const packageId = input.packageId.trim()
	const secretName = input.secretName.trim()
	if (!packageId || !secretName) {
		return { status: 'unread', reason: 'missing_package_or_secret_name' }
	}
	try {
		const saved = await getSavedPackageById(input.env.APP_DB, {
			userId: input.userId,
			packageId,
		})
		if (!saved?.sourceId) {
			return { status: 'unread', reason: 'package_source_missing' }
		}
		const { manifest } = await loadPackageManifestBySourceId({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceId: saved.sourceId,
		})
		const slot = manifest.kody.credentials?.[secretName]
		if (!slot || slot.placement === undefined) {
			return { status: 'undeclared' }
		}
		const parsed = credentialFillPlacementSchema.safeParse(slot.placement)
		if (!parsed.success) {
			return { status: 'unread', reason: 'placement_invalid' }
		}
		return { status: 'applied', placement: parsed.data }
	} catch {
		return { status: 'unread', reason: 'manifest_load_failed' }
	}
}
