/**
 * `countLiveSeats` in `packages/worker/src/orgs/billing.ts`. Whitespace and
 * case are ignored; any other `org_memberships` statement stays unmatched
 * (`isOrgBindingMembershipQuery` covers membership and org binding).
 */
const liveSeatCountSql = `SELECT COUNT(*) AS count
			 FROM org_memberships m
			 INNER JOIN users u
			   ON u.stable_user_id = m.user_id
			  AND u.deleted_at IS NULL
			 WHERE m.org_id = ?
			   AND m.role IN ('owner', 'admin', 'member')
			   AND m.deleted_at IS NULL`

function normalizeD1Query(query: string) {
	return query.replace(/\s+/g, ' ').trim().toLowerCase()
}

const normalizedLiveSeatCountSql = normalizeD1Query(liveSeatCountSql)

/**
 * Recognize the `countLiveSeats` statement so entitlement D1 stubs can answer
 * the live-seat COUNT. Raw and whitespace-normalized SQL both match.
 */
export function isLiveSeatCountQuery(query: string) {
	return normalizeD1Query(query) === normalizedLiveSeatCountSql
}

/** One live owner seat: the personal-org fixture count. */
export function mockLiveSeatCountRow(count = 1) {
	return { count }
}
