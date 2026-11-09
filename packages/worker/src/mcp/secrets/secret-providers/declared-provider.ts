import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'

export async function readDeclaredSecretProviderId(input: {
	env: Env
	baseUrl: string
	userId: string
	savedPackage: SavedPackageRecord
}): Promise<string | null> {
	const loaded = await loadPackageManifestBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
	})
	const providerId = loaded.manifest.kody.secretProvider?.id?.trim()
	return providerId && providerId.length > 0 ? providerId : null
}
