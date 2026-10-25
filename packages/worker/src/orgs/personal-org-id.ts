import {
	mintPersonId,
	ownerIdFromStored,
	personIdFromStored,
	personalOrgId,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
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
 * Concurrent identical personal-org lookups against the same `APP_DB` share
 * one users-row read (KODY-AZ). Cleared when the promise settles so a later
 * ownership conversion (or any write) in this or another isolate still
 * re-reads — module state cannot invalidate other isolates.
 *
 * When a `request` is passed, the settled id is also kept for that request
 * (KODY-BF): sequential `credential(key)` opens on a queue consumer re-use
 * one users SELECT without caching across requests or other users.
 */
const inflightPersonalOrgIds = new WeakMap<
	D1Database,
	Map<string, Promise<OwnerId>>
>()

const personalOrgIdByRequest = new WeakMap<
	RequestContext,
	Map<string, Promise<OwnerId>>
>()

/**
 * Resolve personal org id when only a person id and DB are available (no
 * stamped `personalOrgId` on the caller). Prefer this over branding the
 * person id for org-keyed storage lookups.
 *
 * Pass `request` on credential open / package execute paths so sequential
 * need-key resolution within one execution shares one users read.
 */
export async function loadPersonalOrgIdForPerson(
	db: D1Database,
	personId: PersonId,
	request?: RequestContext | null,
): Promise<OwnerId> {
	if (request) {
		let byPerson = personalOrgIdByRequest.get(request)
		if (!byPerson) {
			byPerson = new Map()
			personalOrgIdByRequest.set(request, byPerson)
		}
		const cached = byPerson.get(personId)
		if (cached) return cached
		const pending = loadPersonalOrgIdForPersonInflight(db, personId)
		byPerson.set(personId, pending)
		pending.catch(() => {
			if (byPerson.get(personId) === pending) byPerson.delete(personId)
		})
		return pending
	}
	return loadPersonalOrgIdForPersonInflight(db, personId)
}

async function loadPersonalOrgIdForPersonInflight(
	db: D1Database,
	personId: PersonId,
): Promise<OwnerId> {
	let inflight = inflightPersonalOrgIds.get(db)
	if (!inflight) {
		inflight = new Map()
		inflightPersonalOrgIds.set(db, inflight)
	}
	const existing = inflight.get(personId)
	if (existing) return existing
	const pending = readPersonalOrgIdForPerson(db, personId).finally(() => {
		if (inflight.get(personId) === pending) inflight.delete(personId)
	})
	inflight.set(personId, pending)
	return pending
}

/**
 * Drop an in-flight personal-org id after `users.personal_org_id` changes
 * (ownership conversion). Safe no-op when nothing is in flight; call after
 * the write batch commits. Request-scoped entries die with the request.
 */
export function forgetPersonalOrgIdForPerson(
	db: D1Database,
	personId: PersonId,
) {
	inflightPersonalOrgIds.get(db)?.delete(personId)
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
