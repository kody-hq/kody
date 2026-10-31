import {
	deviceAuthorizationRetentionSeconds,
	deviceSlowDownIncrementSeconds,
} from './device-grant.ts'

export type DeviceAuthorizationStatus =
	| 'pending'
	| 'approved'
	| 'denied'
	| 'consumed'

export type DeviceAuthorizationKind = 'cli' | 'package_app'

export type DeviceAuthorizationRow = {
	id: string
	device_code_hash: string
	user_code: string
	client_id: string
	scope: string
	resource: string
	requested_org_slug: string | null
	status: DeviceAuthorizationStatus
	interval_seconds: number
	created_at: number
	expires_at: number
	last_polled_at: number | null
	user_id: string | null
	org_id: string | null
	decided_at: number | null
	consumed_at: number | null
	/** `package_app` rows are package-app visitor sign-ins (ADR 0094). */
	kind: DeviceAuthorizationKind
	/** Package-app rows only: the rest of the authorize request, as JSON. */
	request_json: string | null
	/** Package-app rows only: the scopes the approver allowed. */
	approved_scope: string | null
}

const table = 'oauth_device_authorizations'

export function nowSeconds() {
	return Math.floor(Date.now() / 1000)
}

export async function purgeExpiredDeviceAuthorizations(
	db: D1Database,
	now = nowSeconds(),
) {
	await db
		.prepare(`DELETE FROM ${table} WHERE expires_at < ?`)
		.bind(now - deviceAuthorizationRetentionSeconds)
		.run()
}

/** Inserts a pending row; returns false when the user_code collided. */
export async function insertDeviceAuthorization(
	db: D1Database,
	row: Pick<
		DeviceAuthorizationRow,
		| 'id'
		| 'device_code_hash'
		| 'user_code'
		| 'client_id'
		| 'scope'
		| 'resource'
		| 'requested_org_slug'
		| 'interval_seconds'
		| 'created_at'
		| 'expires_at'
	> &
		Partial<Pick<DeviceAuthorizationRow, 'kind' | 'request_json'>>,
) {
	const result = await db
		.prepare(
			`INSERT INTO ${table} (
				id, device_code_hash, user_code, client_id, scope, resource,
				requested_org_slug, status, interval_seconds, created_at, expires_at,
				kind, request_json
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
			ON CONFLICT (user_code) DO NOTHING`,
		)
		.bind(
			row.id,
			row.device_code_hash,
			row.user_code,
			row.client_id,
			row.scope,
			row.resource,
			row.requested_org_slug,
			row.interval_seconds,
			row.created_at,
			row.expires_at,
			row.kind ?? 'cli',
			row.request_json ?? null,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function findDeviceAuthorizationByDeviceCodeHash(
	db: D1Database,
	deviceCodeHash: string,
) {
	return await db
		.prepare(`SELECT * FROM ${table} WHERE device_code_hash = ?`)
		.bind(deviceCodeHash)
		.first<DeviceAuthorizationRow>()
}

/** A pending, unexpired request by its normalized user code. */
export async function findPendingDeviceAuthorizationByUserCode(
	db: D1Database,
	userCode: string,
	now = nowSeconds(),
) {
	return await db
		.prepare(
			`SELECT * FROM ${table}
			WHERE user_code = ? AND status = 'pending' AND expires_at > ?`,
		)
		.bind(userCode, now)
		.first<DeviceAuthorizationRow>()
}

/**
 * Records one poll against the row the caller just read. A poll sooner than
 * the stored interval is RFC 8628 `slow_down` and grows the interval by five
 * seconds. The write is conditional on the `last_polled_at` that was read, so
 * when two polls race only one counts as on time.
 */
export async function recordDevicePoll(
	db: D1Database,
	row: Pick<
		DeviceAuthorizationRow,
		'id' | 'last_polled_at' | 'interval_seconds'
	>,
	now = nowSeconds(),
): Promise<{ tooFast: boolean; intervalSeconds: number }> {
	const tooFast =
		row.last_polled_at !== null &&
		now - row.last_polled_at < row.interval_seconds
	const intervalSeconds = tooFast
		? row.interval_seconds + deviceSlowDownIncrementSeconds
		: row.interval_seconds
	const result = await db
		.prepare(
			`UPDATE ${table}
			SET interval_seconds = ?, last_polled_at = ?
			WHERE id = ? AND last_polled_at IS ?`,
		)
		.bind(intervalSeconds, now, row.id, row.last_polled_at)
		.run()
	if ((result.meta.changes ?? 0) === 0) {
		// A concurrent poll won the write; this one was too fast by definition.
		await db
			.prepare(
				`UPDATE ${table} SET interval_seconds = interval_seconds + ?
				WHERE id = ?`,
			)
			.bind(deviceSlowDownIncrementSeconds, row.id)
			.run()
		return {
			tooFast: true,
			intervalSeconds: row.interval_seconds + deviceSlowDownIncrementSeconds,
		}
	}
	return { tooFast, intervalSeconds }
}

export async function decideDeviceAuthorization(
	db: D1Database,
	input:
		| { id: string; decision: 'approved'; userId: string; orgId: string }
		| { id: string; decision: 'denied'; userId: string },
	now = nowSeconds(),
) {
	const result = await db
		.prepare(
			`UPDATE ${table}
			SET status = ?, user_id = ?, org_id = ?, decided_at = ?
			WHERE id = ? AND status = 'pending' AND expires_at > ?
				AND kind = 'cli'`,
		)
		.bind(
			input.decision,
			input.userId,
			input.decision === 'approved' ? input.orgId : null,
			now,
			input.id,
			now,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/**
 * Records the decision on a pending package-app visitor sign-in (ADR 0094).
 * An approval stores the scopes the approver allowed; the limited device
 * turns it into a package-app authorization code when it next checks in.
 */
export async function decidePackageAppDeviceAuthorization(
	db: D1Database,
	input:
		| {
				id: string
				decision: 'approved'
				userId: string
				approvedScope: string
		  }
		| { id: string; decision: 'denied'; userId: string },
	now = nowSeconds(),
) {
	const result = await db
		.prepare(
			`UPDATE ${table}
			SET status = ?, user_id = ?, approved_scope = ?, decided_at = ?
			WHERE id = ? AND status = 'pending' AND expires_at > ?
				AND kind = 'package_app'`,
		)
		.bind(
			input.decision,
			input.userId,
			input.decision === 'approved' ? input.approvedScope : null,
			now,
			input.id,
			now,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/** Moves an approved row to consumed. Only one caller can win. */
export async function consumeApprovedDeviceAuthorization(
	db: D1Database,
	id: string,
	now = nowSeconds(),
) {
	const result = await db
		.prepare(
			`UPDATE ${table} SET status = 'consumed', consumed_at = ?
			WHERE id = ? AND status = 'approved' AND expires_at > ?`,
		)
		.bind(now, id, now)
		.run()
	return (result.meta.changes ?? 0) > 0
}
