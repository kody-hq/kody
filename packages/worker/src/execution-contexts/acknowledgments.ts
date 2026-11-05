import {
	addsEntries,
	type BoxAccessEntry,
	type BoxPrincipal,
	boxPrincipal,
	excessFingerprint,
	loadBoxAccess,
} from './box-access.ts'
import { excessForUser } from './box-notices.ts'
import type { ExecutionContextRow } from './store.ts'

/**
 * Why a person must acknowledge a shared context before their next run
 * (ADR 0097): they never did, the box login changed, or it gained access
 * they lack. A removed excess entry never needs a new acknowledgment.
 */
export type AcknowledgmentReason = 'first_run' | 'login_changed' | 'new_access'

export type AcknowledgmentState =
	| { required: false; acknowledgedAt: string | null }
	| {
			required: true
			reason: AcknowledgmentReason
			principal: BoxPrincipal
			entries: Array<BoxAccessEntry>
			/** Pass back to acknowledge exactly what was shown. */
			fingerprint: string
			acknowledgedAt: string | null
	  }

type AckRow = {
	principal_key: string
	entries_json: string
	acknowledged_at: string
}

function principalKey(principal: BoxPrincipal) {
	return `${principal.kind}:${principal.userId}:${principal.profileId ?? ''}`
}

/** The operator and the box login's own person never acknowledge. */
export function needsAcknowledgment(row: ExecutionContextRow, userId: string) {
	return row.operator_user_id !== userId && boxPrincipal(row).userId !== userId
}

async function readAck(
	db: D1Database,
	input: { contextId: string; orgId: string; userId: string },
) {
	return await db
		.prepare(
			`SELECT principal_key, entries_json, acknowledged_at
			 FROM execution_context_acknowledgments
			 WHERE context_id = ? AND org_id = ? AND user_id = ?`,
		)
		.bind(input.contextId, input.orgId, input.userId)
		.first<AckRow>()
}

function storedEntries(row: AckRow): Array<BoxAccessEntry> {
	try {
		const parsed = JSON.parse(row.entries_json) as unknown
		return Array.isArray(parsed) ? (parsed as Array<BoxAccessEntry>) : []
	} catch {
		return []
	}
}

export async function acknowledgmentState(
	db: D1Database,
	row: ExecutionContextRow,
	orgId: string,
	userId: string,
): Promise<AcknowledgmentState> {
	if (!needsAcknowledgment(row, userId)) {
		return { required: false, acknowledgedAt: null }
	}
	const [box, stored] = await Promise.all([
		loadBoxAccess(db, row, orgId),
		readAck(db, { contextId: row.id, orgId, userId }),
	])
	const entries = await excessForUser(db, box, orgId, userId)
	const reason: AcknowledgmentReason | null = !stored
		? 'first_run'
		: stored.principal_key !== principalKey(box.principal)
			? 'login_changed'
			: addsEntries(storedEntries(stored), entries)
				? 'new_access'
				: null
	if (!reason) {
		return { required: false, acknowledgedAt: stored!.acknowledged_at }
	}
	return {
		required: true,
		reason,
		principal: box.principal,
		entries,
		fingerprint: await excessFingerprint(box.principal, entries),
		acknowledgedAt: stored?.acknowledged_at ?? null,
	}
}

/**
 * Records the acknowledgment when `fingerprint` still matches what the
 * person would be asked to acknowledge now; `changed` means read it again.
 */
export async function recordAcknowledgment(
	db: D1Database,
	input: {
		row: ExecutionContextRow
		orgId: string
		userId: string
		fingerprint: string
	},
): Promise<'acknowledged' | 'not_required' | 'changed'> {
	const state = await acknowledgmentState(
		db,
		input.row,
		input.orgId,
		input.userId,
	)
	if (!state.required) return 'not_required'
	if (state.fingerprint !== input.fingerprint) return 'changed'
	await db
		.prepare(
			`INSERT INTO execution_context_acknowledgments
			   (context_id, org_id, user_id, principal_key, entries_json, acknowledged_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (context_id, org_id, user_id) DO UPDATE SET
			   principal_key = excluded.principal_key,
			   entries_json = excluded.entries_json,
			   acknowledged_at = excluded.acknowledged_at`,
		)
		.bind(
			input.row.id,
			input.orgId,
			input.userId,
			principalKey(state.principal),
			JSON.stringify(state.entries),
			new Date().toISOString(),
		)
		.run()
	return 'acknowledged'
}
