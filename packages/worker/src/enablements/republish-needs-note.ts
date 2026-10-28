import { loadPublishedCredentialNeeds } from '#worker/credentials/credential-needs-closure.ts'
import {
	isSecretProviderNeed,
	type CredentialNeed,
} from '#worker/credentials/credential-needs.ts'
import {
	getSavedPackageByName,
	getSavedPackageBySourceId,
} from '#worker/package-registry/repo.ts'

/**
 * A publish note (ADR 0068) when a republish adds credential needs while the
 * package has live enablements: their runs resolve the new needs through the
 * mapping layers (trigger, the enabler's default, the org default, then the
 * one usable credential), and a run that finds none fails with a creation
 * link. Null when nothing applies. Informational only; it never fails a
 * publish.
 */
export async function republishedNeedsNote(input: {
	env: Env
	userId: string
	/**
	 * The source being published; found by it, a rename still finds the
	 * package, and a new source never reads a same-name package's enablements.
	 */
	sourceId?: string | null
	packageName: string
	needs: ReadonlyArray<CredentialNeed>
}): Promise<string | null> {
	if (input.needs.length === 0) return null
	const saved = input.sourceId
		? await getSavedPackageBySourceId(input.env.APP_DB, {
				userId: input.userId,
				sourceId: input.sourceId,
			})
		: await getSavedPackageByName(input.env.APP_DB, {
				userId: input.userId,
				name: input.packageName,
			})
	if (!saved) return null
	const row = await input.env.APP_DB.prepare(
		`SELECT COUNT(*) AS live FROM enablements
		 WHERE org_id = ? AND package_id = ? AND state <> 'off'`,
	)
		.bind(saved.userId, saved.id)
		.first<{ live: number }>()
	const live = row?.live ?? 0
	if (live === 0) return null
	const before = new Set(
		(
			await loadPublishedCredentialNeeds({
				env: input.env,
				userId: saved.userId,
				sourceId: saved.sourceId,
			})
		)
			.filter((need) => !isSecretProviderNeed(need))
			.map((need) => need.key),
	)
	// Secret-provider needs fill from the provider binding, not a mapping.
	const added = input.needs
		.filter((need) => !isSecretProviderNeed(need))
		.map((need) => need.key)
		.filter((key) => !before.has(key))
	if (added.length === 0) return null
	const one = live === 1
	return `This publish adds credential needs ${added.join(', ')}. ${live} live enablement${
		one ? '' : 's'
	} of this package resolve${one ? 's' : ''} them on each run from ${
		one ? 'its' : 'their'
	} trigger mapping, the enabler's default, the org default, or the one credential the enabler can use; a run that finds none fails with a link to create one. Map them on the package's Credentials page, or propose mappings with credentialMappingPropose.`
}
