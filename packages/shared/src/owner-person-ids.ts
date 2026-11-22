/**
 * Kody separates *whose data* an operation touches from *who* performs it.
 *
 * - `OwnerId` is the id of the org that owns a resource. It keys storage:
 *   `user_id` columns, Durable Object names, Vectorize metadata, R2/KV key
 *   prefixes, and secret AAD.
 * - `PersonId` identifies the acting person: sessions, passkeys,
 *   OAuth/CLI/API-token principals, audit actors, and RBAC
 *   (`users.stable_user_id`).
 *
 * Owners are orgs. Legacy personal orgs reuse `orgs.id === stable_user_id`;
 * new signups mint a distinct `orgs.id` recorded on `users.personal_org_id`
 * (ADR 0063 / #3053). Resolve that id with `personalOrgIdForPerson` (and
 * related helpers), not by assuming it equals the person id.
 * `personalOrgId(person)` only brands a person id into `OwnerId` for
 * **person-keyed** storage. Mixing the brands is a compile error. Ids are
 * opaque (random hex or legacy SHA-256(email)) and never public. See
 * docs/contributing/decisions/0060-owner-and-person-ids.md.
 * Remove when: no org still has the legacy equal-id shape (`orgs.id` equals the person's stable user id, #3053).
 */
import { toHex } from './hex.ts'

declare const ownerIdBrand: unique symbol
declare const personIdBrand: unique symbol

export type OwnerId = string & { readonly [ownerIdBrand]: true }
export type PersonId = string & { readonly [personIdBrand]: true }

type NotOwnerOrPerson<T> = T extends OwnerId | PersonId ? never : T

const stableIdPattern = /^[a-f0-9]{64}$/

function parseStableId(value: unknown) {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return stableIdPattern.test(trimmed) ? trimmed : null
}

// Trims like the `users.stable_user_id` reads it replaced, so auth resolves
// existing rows exactly as before.
function requireStoredId(value: string | null | undefined, label: string) {
	const trimmed = value?.trim() ?? ''
	if (!trimmed) {
		throw new Error(`${label} is required`)
	}
	return trimmed
}

/**
 * Mint the id for a new account: 32 random bytes as 64 lowercase hex. Never
 * derive it from the email or any other attribute.
 */
export function mintPersonId(): PersonId {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return toHex(bytes) as PersonId
}

/**
 * Parse an untrusted value (session record, admin input, request field) as a
 * person's stable id. Returns null unless it is 64 lowercase hex.
 */
export function parsePersonId<T>(value: NotOwnerOrPerson<T>): PersonId | null {
	return parseStableId(value) as PersonId | null
}

/**
 * Parse an untrusted value (admin input, request field) as an owner's stable
 * id. Returns null unless it is 64 lowercase hex.
 */
export function parseOwnerId<T>(value: NotOwnerOrPerson<T>): OwnerId | null {
	return parseStableId(value) as OwnerId | null
}

/**
 * Brand a person id read from Kody's own storage (a `users.stable_user_id`
 * row, a persisted caller context, a signed token claim). Throws when empty.
 */
export function personIdFromStored<T extends string | null | undefined>(
	value: NotOwnerOrPerson<T>,
): PersonId {
	return requireStoredId(value, 'Person id') as PersonId
}

/**
 * Brand an owner id read from Kody's own storage (a `user_id` /
 * `owner_user_id` column, an org id, a persisted owner). Throws
 * when empty. Owners are not always people: `system:email` owns system mail.
 */
export function ownerIdFromStored<T extends string | null | undefined>(
	value: NotOwnerOrPerson<T>,
): OwnerId {
	return requireStoredId(value, 'Owner id') as OwnerId
}

/**
 * Brand a person id into the `OwnerId` type for **person-keyed** storage
 * (sessions, passkeys, OAuth principals, connected-agent grants, audit).
 *
 * This is **not** the personal org resolver. After #3053 phase 3, personal org
 * ids come from `users.personal_org_id` via `personalOrgIdForPerson` /
 * `personalOrgIdFromUserRow` / `loadPersonalOrgIdForPerson`. Legacy personal
 * orgs still have `orgs.id === person id`; new signups mint a distinct org id.
 * Acting in any org other than the caller's personal org must go through an
 * explicit membership or grant check.
 * Remove when: no org still has the legacy equal-id shape (`orgs.id` equals the person's stable user id, #3053).
 */
export function personalOrgId(person: PersonId): OwnerId {
	return person as string as OwnerId
}
