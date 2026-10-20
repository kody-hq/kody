/**
 * A trigger instance's stored credential picks (its `enablement` mapping
 * rows) are checked before each run: a pick the enabler can no longer Use
 * (deleted, Use revoked, or a personal grant withdrawn), or one that no
 * longer fits its need after a republish changed the need's kind or
 * provider, pauses the enablement instead of starting a run that would fail.
 * It resumes on the next event once the pick works again or the enabler maps
 * another. A row for a need the package no longer declares is ignored, as
 * the run ignores it. Default layers are not checked: an unusable default
 * falls through, as the run's own resolution does.
 */
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { listUsableCredentials } from '#worker/credentials/credential-candidates.ts'
import {
	loadPackageNeeds,
	mappedCredentialFitsNeed,
} from '#worker/credentials/credential-need-fit.ts'
import { enablementMappingPauseResourceType } from '#universal/credential-contracts.ts'
import { type EnablementPauseInput } from './repo.ts'
import { type EnablementPause, type EnablementRecord } from './types.ts'

/** A pause on a stored trigger pick resumes by re-checking the mapping. */
export function isEnablementMappingPause(pause: EnablementPause | null) {
	return (
		pause?.reason === 'credential_access' &&
		pause.resourceType === enablementMappingPauseResourceType
	)
}

async function loadTriggerPicks(db: D1Database, enablement: EnablementRecord) {
	const result = await db
		.prepare(
			`SELECT need_key, credential_ids_json FROM credential_mappings
			WHERE org_id = ? AND package_id = ? AND target = 'enablement'
				AND enablement_id = ?
			ORDER BY need_key`,
		)
		.bind(enablement.orgId, enablement.packageId, enablement.id)
		.all<{ need_key: string; credential_ids_json: string }>()
	return (result.results ?? []).map((row) => {
		// A corrupt row reads as unset, as the run's own resolution reads it.
		let parsed: unknown = null
		try {
			parsed = JSON.parse(row.credential_ids_json)
		} catch {}
		return {
			needKey: row.need_key,
			ids: Array.isArray(parsed)
				? parsed.filter((id): id is string => typeof id === 'string')
				: [],
		}
	})
}

/**
 * The pause a run of `enablement` needs before it starts, or null when every
 * credential its trigger mapping names for a declared need is usable by the
 * enabler (`request`) and fits that need. "None on purpose" (`[]`) is not a
 * pause; the run reports it.
 */
export async function checkEnablementMappedCredentials(input: {
	env: Env
	request: RequestContext
	enablement: EnablementRecord
}): Promise<EnablementPauseInput | null> {
	const { packageId } = input.enablement
	const picks = (
		await loadTriggerPicks(input.env.APP_DB, input.enablement)
	).filter((pick) => pick.ids.length > 0)
	if (picks.length === 0) return null
	const needs = new Map(
		(
			await loadPackageNeeds({
				env: input.env,
				orgId: input.request.org.id,
				packageId,
			})
		).map((need) => [need.key, need]),
	)
	const declared = picks.filter((pick) => needs.has(pick.needKey))
	if (declared.length === 0) return null
	const usable = new Map(
		(
			await listUsableCredentials({
				...input,
				packageId,
			})
		).map((credential) => [credential.id, credential]),
	)
	for (const { needKey, ids } of declared) {
		const need = needs.get(needKey)!
		const missing = ids.find((id) => {
			const credential = usable.get(id)
			return !credential || !mappedCredentialFitsNeed(credential, need)
		})
		if (!missing) continue
		return {
			reason: 'credential_access',
			permission: null,
			resourceType: enablementMappingPauseResourceType,
			resourceId: needKey,
			credentialId: missing,
		}
	}
	return null
}
