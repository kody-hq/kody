import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { loadProfileChain } from './store.ts'

/**
 * The profile a request runs as (ADR 0092), for whoami and package code.
 * Informational only: grants enforce access, not this value.
 */
export type RunningProfile = {
	id: string
	name: string
	/** Ancestors root first, ending with the parent; empty for a top-level profile. */
	ancestors: Array<{ id: string; name: string }>
}

export async function loadRunningProfile(
	db: D1Database,
	request: RequestContext,
): Promise<RunningProfile | null> {
	const profileId = request.credential.profileId
	if (!profileId) return null
	const rows = await loadProfileChain(db, { orgId: request.org.id, profileId })
	const tip = rows.at(-1)
	if (!tip || tip.id !== profileId) return null
	return {
		id: tip.id,
		name: tip.name,
		ancestors: rows.slice(0, -1).map((row) => ({ id: row.id, name: row.name })),
	}
}
