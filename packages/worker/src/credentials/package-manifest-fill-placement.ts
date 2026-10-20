/**
 * Apply a package's declared `kody.credentials` fill placement when inserting
 * a package-scope secret for that package (Connect / secretSet / re-insert
 * after Disconnect). Runtime cannot pass placement; the published manifest is
 * the reviewable source. Omitted declaration → caller keeps headers-only
 * default. Failures to load the manifest are ignored so Connect still works.
 */
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	type CredentialFillPlacement,
	credentialFillPlacementSchema,
} from '#worker/credentials/fill-placement.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'

export async function readDeclaredPackageSecretFillPlacement(input: {
	env: Env
	userId: OwnerId
	baseUrl: string
	packageId: string
	secretName: string
}): Promise<CredentialFillPlacement | undefined> {
	const packageId = input.packageId.trim()
	const secretName = input.secretName.trim()
	if (!packageId || !secretName) return undefined
	try {
		const saved = await getSavedPackageById(input.env.APP_DB, {
			userId: input.userId,
			packageId,
		})
		if (!saved?.sourceId) return undefined
		const { manifest } = await loadPackageManifestBySourceId({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceId: saved.sourceId,
		})
		const slot = manifest.kody.credentials?.[secretName]
		if (!slot || slot.placement === undefined) return undefined
		const parsed = credentialFillPlacementSchema.safeParse(slot.placement)
		return parsed.success ? parsed.data : undefined
	} catch {
		return undefined
	}
}
