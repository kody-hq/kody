import { type GrantSubjectType } from '#worker/orgs/access-writes.ts'

/**
 * Whether a lookup lets a grant subject type reach the person. Every lookup
 * names every subject type, so a new type fails to compile until each lookup
 * decides; an exclusion carries the reason it is safe.
 */
export type GrantSubjectChoice = 'include' | { exclude: string }

/**
 * `profile` grants narrow a profile and never reach a person, so every
 * lookup excludes them.
 */
export type GrantSubjectChoices = Readonly<
	Record<GrantSubjectType, GrantSubjectChoice> & {
		profile: { exclude: string }
	}
>

export type GrantSubjectMatch = { sql: string; binds: Array<string> }

/**
 * The parenthesized SQL condition that a grant row (`grantAlias`, default
 * `g`) names `personId` through one of the included subject types:
 *
 * - `user`: the person directly.
 * - `team`: a live team in the grant's org with a live seat for the person.
 * - `org`: everyone in the grant's org (`subject_id = org_id`, migration
 *   0201), resolved against a live org membership at check time.
 *
 * `boundOrgId` is the org the caller already filters grants to with a bound
 * id. With it, the person's team seats in that org are listed once; without
 * it (the org comes from an outer row), each team grant checks its own seat.
 * Both forms test the same rows; each keeps the index plan of the query it
 * replaced. Binds come back in placeholder order.
 *
 * The grant must also be unexpired at `now` (default: the current time):
 * `expires_at` NULL never expires.
 */
export function grantSubjectMatchSql(input: {
	subjects: GrantSubjectChoices
	personId: string
	boundOrgId?: string
	grantAlias?: string
	now?: string
}): GrantSubjectMatch {
	const g = input.grantAlias ?? 'g'
	const branches: Array<string> = []
	const binds: Array<string> = []
	if (input.subjects.user === 'include') {
		branches.push(`(${g}.subject_type = 'user' AND ${g}.subject_id = ?)`)
		binds.push(input.personId)
	}
	if (input.subjects.team === 'include') {
		if (input.boundOrgId === undefined) {
			branches.push(
				`(${g}.subject_type = 'team' AND EXISTS (
				  SELECT 1 FROM team_members tm
				  INNER JOIN teams t
				    ON t.id = tm.team_id
				   AND t.org_id = ${g}.org_id
				   AND t.deleted_at IS NULL
				  WHERE tm.team_id = ${g}.subject_id
				    AND tm.user_id = ?
				    AND tm.deleted_at IS NULL
				))`,
			)
			binds.push(input.personId)
		} else {
			branches.push(
				`(${g}.subject_type = 'team' AND ${g}.subject_id IN (
				  SELECT tm.team_id FROM team_members tm
				  INNER JOIN teams t ON t.id = tm.team_id
				  WHERE tm.user_id = ?
				    AND tm.deleted_at IS NULL
				    AND t.org_id = ?
				    AND t.deleted_at IS NULL
				))`,
			)
			binds.push(input.personId, input.boundOrgId)
		}
	}
	if (input.subjects.org === 'include') {
		branches.push(
			`(${g}.subject_type = 'org' AND ${g}.subject_id = ${g}.org_id AND EXISTS (
			  SELECT 1 FROM org_memberships m
			  WHERE m.org_id = ${g}.org_id
			    AND m.user_id = ?
			    AND m.deleted_at IS NULL
			))`,
		)
		binds.push(input.personId)
	}
	if (branches.length === 0) {
		throw new Error('A grant subject lookup must include a subject type.')
	}
	const expiry = unexpiredGrantSql({ grantAlias: g, now: input.now })
	return {
		sql: `((${branches.join(' OR ')}) AND ${expiry.sql})`,
		binds: [...binds, ...expiry.binds],
	}
}

/** A grant row (`grantAlias`, default `g`) that has not expired at `now`. */
export function unexpiredGrantSql(
	input: { grantAlias?: string; now?: string } = {},
): GrantSubjectMatch {
	const g = input.grantAlias ?? 'g'
	return {
		sql: `(${g}.expires_at IS NULL OR ${g}.expires_at > ?)`,
		binds: [input.now ?? new Date().toISOString()],
	}
}
