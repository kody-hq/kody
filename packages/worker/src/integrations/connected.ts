/**
 * One definition of "this OAuth connection is connected" for credential list
 * status, candidate resolution, and personal-credential usability.
 *
 * `connected_at` is stamped on every successful token persist
 * (`COALESCE` so refreshes keep the first connect time), on platform-lane
 * connection upsert, and by the backfill migration for rows that already held
 * tokens. Auth failure is a separate overlay on list status only.
 */

/** SQL predicate matching {@link isIntegrationConnected} for a column. */
export function integrationConnectedSql(column = 'connected_at'): string {
	return `${column} IS NOT NULL`
}

export function isIntegrationConnected(
	connectedAt: string | null | undefined,
): boolean {
	return connectedAt != null
}

export function oauthCredentialListStatus(input: {
	connectedAt: string | null
	authFailedAt: string | null
	authFailedReason: string | null
}): {
	status: 'ok' | 'needs_attention'
	statusMessage: string | null
} {
	const connected = isIntegrationConnected(input.connectedAt)
	const failed = input.authFailedAt != null
	if (connected && !failed) {
		return { status: 'ok', statusMessage: null }
	}
	if (!connected) {
		return { status: 'needs_attention', statusMessage: 'Not connected yet.' }
	}
	return {
		status: 'needs_attention',
		statusMessage: `Reconnect needed${input.authFailedReason ? ` (${input.authFailedReason})` : ''}.`,
	}
}

/**
 * Owner of a connection's bring-your-own app: `app_owner_id`, which is
 * `user_id` except for a personal connection made through another org's app.
 */
export function integrationAppOwnerSql(alias?: string): string {
	const column = (name: string) => (alias ? `${alias}.${name}` : name)
	return `COALESCE(${column('app_owner_id')}, ${column('user_id')})`
}

/**
 * The connection resolves in runs of the org bound at `orgParam`: its app is
 * its owner's own (or a platform app), or the run org owns the app it was
 * made through (pinned, ADR 0068).
 */
export function integrationUsableInOrgSql(
	orgParam: string,
	alias?: string,
): string {
	const column = (name: string) => (alias ? `${alias}.${name}` : name)
	return `${integrationAppOwnerSql(alias)} IN (${column('user_id')}, ${orgParam})`
}
