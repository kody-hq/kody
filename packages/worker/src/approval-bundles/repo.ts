import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	approvalItemKey,
	parseApprovalItemKey,
	type ApprovalItemRef,
} from '#universal/approval-bundles.ts'

export type ApprovalBundleRecord = {
	id: string
	orgId: string
	personUserId: string
	agentCredentialKind: string | null
	agentCredentialId: string | null
	note: string | null
	items: Array<ApprovalItemRef>
	createdAt: string
}

export type ApprovalBundleDecisionRecord = {
	itemKey: string
	decision: 'approved' | 'denied'
	decidedByUserId: string
	decidedAt: string
}

function readItems(value: unknown): Array<ApprovalItemRef> {
	if (typeof value !== 'string') return []
	try {
		const parsed: unknown = JSON.parse(value)
		if (!Array.isArray(parsed)) return []
		return parsed.flatMap((entry) => {
			const ref = typeof entry === 'string' ? parseApprovalItemKey(entry) : null
			return ref ? [ref] : []
		})
	} catch {
		return []
	}
}

function mapBundleRow(row: Record<string, unknown>): ApprovalBundleRecord {
	const text = (key: string) => (row[key] == null ? null : String(row[key]))
	return {
		id: String(row['id']),
		orgId: String(row['org_id']),
		personUserId: String(row['person_user_id']),
		agentCredentialKind: text('agent_credential_kind'),
		agentCredentialId: text('agent_credential_id'),
		note: text('note'),
		items: readItems(row['items_json']),
		createdAt: String(row['created_at']),
	}
}

/** The new bundle and the statement that stores it, for an audited batch. */
export function planApprovalBundleInsert(
	db: D1Database,
	input: Omit<ApprovalBundleRecord, 'id' | 'createdAt'> & {
		id?: string
		createdAt?: string
	},
): { record: ApprovalBundleRecord; statement: D1PreparedStatement } {
	const record: ApprovalBundleRecord = {
		...input,
		id: input.id ?? crypto.randomUUID(),
		createdAt: input.createdAt ?? new Date().toISOString(),
	}
	const statement = db
		.prepare(
			`INSERT INTO approval_bundles (
				id, org_id, person_user_id, agent_credential_kind,
				agent_credential_id, note, items_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			record.id,
			record.orgId,
			record.personUserId,
			record.agentCredentialKind,
			record.agentCredentialId,
			record.note,
			JSON.stringify(record.items.map(approvalItemKey)),
			record.createdAt,
		)
	return { record, statement }
}

/** The bundle when it belongs to this person in this org; null otherwise. */
export async function getApprovalBundleForPerson(
	db: D1Database,
	input: { id: string; orgId: string; personUserId: string },
): Promise<ApprovalBundleRecord | null> {
	const row = await db
		.prepare(
			`SELECT id, org_id, person_user_id, agent_credential_kind,
				agent_credential_id, note, items_json, created_at
			FROM approval_bundles
			WHERE id = ? AND org_id = ? AND person_user_id = ?
			LIMIT 1`,
		)
		.bind(input.id, input.orgId, input.personUserId)
		.first<Record<string, unknown>>()
	return row ? mapBundleRow(row) : null
}

export async function listApprovalBundleDecisions(
	db: D1Database,
	bundleId: string,
): Promise<Map<string, ApprovalBundleDecisionRecord>> {
	const { results } = await db
		.prepare(
			`SELECT item_key, decision, decided_by_user_id, decided_at
			FROM approval_bundle_decisions
			WHERE bundle_id = ? AND finalized_at IS NOT NULL`,
		)
		.bind(bundleId)
		.all<Record<string, unknown>>()
	return new Map(
		(results ?? []).map((row) => [
			String(row['item_key']),
			{
				itemKey: String(row['item_key']),
				decision: row['decision'] === 'denied' ? 'denied' : 'approved',
				decidedByUserId: String(row['decided_by_user_id']),
				decidedAt: String(row['decided_at']),
			},
		]),
	)
}

type DecisionClaim = {
	bundleId: string
	itemKey: string
	decision: 'approved' | 'denied'
	decidedByUserId: string
	decidedAt: string
}

/**
 * How long an unfinalized claim blocks other requests. Longer than any single
 * approve (a publish included), so only a request that stopped part-way loses
 * its claim.
 */
export const approvalBundleClaimLeaseMs = 10 * 60_000

/** A live claim on the same item from another bundle in the org. */
const liveClaimElsewhere = `EXISTS (
	SELECT 1 FROM approval_bundles other
	JOIN approval_bundle_decisions claim
		ON claim.bundle_id = other.id AND claim.item_key = ?
	WHERE other.org_id = ? AND other.id <> ?
		AND claim.finalized_at IS NULL AND claim.decided_at >= ?
)`

/**
 * Claims an item's decision before anything is approved or denied, so only
 * one request acts on an item, across every bundle in the org that holds it.
 * The row stays an in-flight claim (no `finalized_at`) until the approve or
 * deny finishes; a claim older than the lease is taken over. False when the
 * item is decided in this bundle or another request is deciding it.
 */
export async function claimApprovalBundleDecision(
	db: D1Database,
	claim: DecisionClaim & { orgId: string },
): Promise<boolean> {
	const leaseCutoff = new Date(
		Date.parse(claim.decidedAt) - approvalBundleClaimLeaseMs,
	).toISOString()
	const elsewhere = [claim.itemKey, claim.orgId, claim.bundleId, leaseCutoff]
	const inserted = await db
		.prepare(
			`INSERT OR IGNORE INTO approval_bundle_decisions (
				bundle_id, item_key, decision, decided_by_user_id, decided_at
			)
			SELECT ?, ?, ?, ?, ? WHERE NOT ${liveClaimElsewhere}`,
		)
		.bind(
			claim.bundleId,
			claim.itemKey,
			claim.decision,
			claim.decidedByUserId,
			claim.decidedAt,
			...elsewhere,
		)
		.run()
	if ((inserted.meta?.changes ?? 0) > 0) return true
	const takenOver = await db
		.prepare(
			`UPDATE approval_bundle_decisions
			SET decision = ?, decided_by_user_id = ?, decided_at = ?
			WHERE bundle_id = ? AND item_key = ? AND finalized_at IS NULL
				AND decided_at < ? AND NOT ${liveClaimElsewhere}`,
		)
		.bind(
			claim.decision,
			claim.decidedByUserId,
			claim.decidedAt,
			claim.bundleId,
			claim.itemKey,
			leaseCutoff,
			...elsewhere,
		)
		.run()
	return (takenOver.meta?.changes ?? 0) > 0
}

/** Gives back a claim whose approve or deny did not happen. */
export async function releaseApprovalBundleDecision(
	db: D1Database,
	claim: DecisionClaim,
) {
	await db
		.prepare(
			`DELETE FROM approval_bundle_decisions
			WHERE bundle_id = ? AND item_key = ? AND decided_at = ?
				AND finalized_at IS NULL`,
		)
		.bind(claim.bundleId, claim.itemKey, claim.decidedAt)
		.run()
}

/**
 * Turns the claim into a decision once its approve or deny is done; batched
 * with the audit row so a recorded decision is always audited.
 */
export function finalizeApprovalBundleDecisionStatement(
	db: D1Database,
	claim: DecisionClaim,
	finalizedAt: string,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE approval_bundle_decisions SET finalized_at = ?
			WHERE bundle_id = ? AND item_key = ? AND decided_at = ?
				AND finalized_at IS NULL`,
		)
		.bind(finalizedAt, claim.bundleId, claim.itemKey, claim.decidedAt)
}

/** A member leaving an org takes the bundles made for them there. */
export async function deleteApprovalBundlesForMember(input: {
	db: D1Database
	orgId: string
	personId: string
}) {
	await input.db
		.prepare(
			`DELETE FROM approval_bundle_decisions WHERE bundle_id IN (
				SELECT id FROM approval_bundles WHERE org_id = ? AND person_user_id = ?
			)`,
		)
		.bind(input.orgId, input.personId)
		.run()
	const result = await input.db
		.prepare(
			`DELETE FROM approval_bundles WHERE org_id = ? AND person_user_id = ?`,
		)
		.bind(input.orgId, input.personId)
		.run()
	return result.meta?.changes ?? 0
}

/**
 * Pairs of the given packages where one's published bundles import the other
 * (`dependent` imports `dependency`). A dependent built while its dependency
 * is still publishing captures the old dependency version.
 */
export async function listPackageDependencyEdges(
	db: D1Database,
	input: { ownerUserId: string; packageIds: ReadonlyArray<string> },
): Promise<Array<{ dependent: string; dependency: string }>> {
	if (input.packageIds.length < 2) return []
	const ids = JSON.stringify(input.packageIds)
	const result = await db
		.prepare(
			`SELECT DISTINCT dependent.id AS dependent, dependency.id AS dependency
			FROM published_bundle_artifacts AS artifact
			JOIN entity_sources AS source
				ON source.id = artifact.source_id
				AND source.user_id = artifact.user_id
				AND source.entity_kind = 'package'
				AND source.published_commit = artifact.published_commit
			JOIN saved_packages AS dependent
				ON dependent.id = source.entity_id
				AND dependent.user_id = artifact.user_id
			JOIN json_each(artifact.dependencies_json) AS imported
			JOIN saved_packages AS dependency
				ON dependency.source_id = json_extract(imported.value, '$.sourceId')
				AND dependency.user_id = artifact.user_id
			WHERE artifact.user_id = ?
				AND dependent.id IN (SELECT value FROM json_each(?))
				AND dependency.id IN (SELECT value FROM json_each(?))
				AND dependency.id <> dependent.id
				${andLiveDeletedAtSql('source')}${andLiveDeletedAtSql('dependent')}${andLiveDeletedAtSql('dependency')}`,
		)
		.bind(input.ownerUserId, ids, ids)
		.all<{ dependent: string; dependency: string }>()
	return result.results ?? []
}
