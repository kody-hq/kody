import {
	mintPersonId,
	ownerIdFromStored,
	personIdFromStored,
	personalOrgId,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

/**
 * Personal org id recorded on a `users` row.
 *
 * Prefer the column when present and non-empty. Blank rows fall back to the
 * equal-id brand for fixtures that still omit the column; production live rows
 * are asserted non-blank by migration 0146.
 */
export function personalOrgIdFromUserRow(row: {
	personal_org_id?: string | null
	stable_user_id: string
}): OwnerId {
	const stored = row.personal_org_id?.trim() ?? ''
	if (stored !== '') return ownerIdFromStored(stored)
	return personalOrgId(personIdFromStored(row.stable_user_id))
}

/**
 * Personal org for an authenticated person. Prefer a stamped
 * `personalOrgId` loaded from `users.personal_org_id`; fall back to the
 * equal-id brand only when the stamp is absent (fixtures / pre-stamp callers).
 * Production auth always stamps the column.
 */
export function personalOrgIdForPerson(user: {
	userId: PersonId
	personalOrgId?: OwnerId | null
}): OwnerId {
	const stamped = user.personalOrgId
	if (typeof stamped === 'string' && stamped.trim() !== '') {
		return ownerIdFromStored(stamped as string)
	}
	return personalOrgId(user.userId)
}

/**
 * Personal-org id lookups against the same `APP_DB` share one users-row read
 * per person for the isolate lifetime (KODY-AZ). Package execute opens
 * `credential(key)` per need and each open also checks author exemption via
 * `assertCredentialUsesDeclared`, which used to re-query
 * `users.personal_org_id` once per need. The id is stable for a person
 * (conversion is rare and typically lands on a later request). Rejected
 * loads are forgotten so a retry can re-read.
 */
const personalOrgIdsByDb = new WeakMap<
	D1Database,
	Map<string, Promise<OwnerId>>
>()

/**
 * Resolve personal org id when only a person id and DB are available (no
 * stamped `personalOrgId` on the caller). Prefer this over branding the
 * person id for org-keyed storage lookups.
 */
export async function loadPersonalOrgIdForPerson(
	db: D1Database,
	personId: PersonId,
): Promise<OwnerId> {
	let cache = personalOrgIdsByDb.get(db)
	if (!cache) {
		cache = new Map()
		personalOrgIdsByDb.set(db, cache)
	}
	const existing = cache.get(personId)
	if (existing) return existing
	const pending = readPersonalOrgIdForPerson(db, personId)
	cache.set(personId, pending)
	pending.catch(() => {
		if (cache.get(personId) === pending) cache.delete(personId)
	})
	return pending
}

/**
 * Drop a memoized personal-org id after `users.personal_org_id` changes
 * (ownership conversion). Call only after the write batch commits.
 */
export function forgetPersonalOrgIdForPerson(
	db: D1Database,
	personId: PersonId,
) {
	personalOrgIdsByDb.get(db)?.delete(personId)
}

async function readPersonalOrgIdForPerson(
	db: D1Database,
	personId: PersonId,
): Promise<OwnerId> {
	const row = await db
		.prepare(
			`SELECT personal_org_id, stable_user_id FROM users
			 WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(personId)
		.first<{ personal_org_id: string | null; stable_user_id: string }>()
	if (!row) {
		// Equal-id fixtures that provision an org without a users row still key
		// storage at the person id. Production always has a live users row.
		return personalOrgId(personId)
	}
	return personalOrgIdFromUserRow(row)
}

/** Mint a fresh owner id for a new personal (or team) org row. */
export function mintOwnerId(): OwnerId {
	return ownerIdFromStored(mintPersonId() as string)
}
