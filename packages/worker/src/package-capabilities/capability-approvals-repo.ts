import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export type PackageCapabilityApprovalRow = {
	id: string
	package_id: string
	owner_user_id: string
	published_commit: string
	fingerprint: string
	capability_set_json: string
	dependency_snapshot_json: string
	approved_by_user_id: string
	approved_at: string
	created_at: string
}

export type PackageCapabilityApprovalRecord = {
	id: string
	packageId: string
	ownerUserId: string
	publishedCommit: string
	fingerprint: string
	capabilitySetJson: string
	dependencySnapshotJson: string
	approvedByUserId: string
	approvedAt: string
	createdAt: string
}

function mapRow(row: Record<string, unknown>): PackageCapabilityApprovalRecord {
	return {
		id: String(row['id']),
		packageId: String(row['package_id']),
		ownerUserId: String(row['owner_user_id']),
		publishedCommit: String(row['published_commit']),
		fingerprint: String(row['fingerprint']),
		capabilitySetJson: String(row['capability_set_json']),
		dependencySnapshotJson: String(row['dependency_snapshot_json'] ?? '{}'),
		approvedByUserId: String(row['approved_by_user_id']),
		approvedAt: String(row['approved_at']),
		createdAt: String(row['created_at']),
	}
}

export async function insertPackageCapabilityApproval(
	db: D1Database,
	row: Omit<PackageCapabilityApprovalRow, 'created_at'> & {
		created_at?: string
	},
): Promise<PackageCapabilityApprovalRecord> {
	const createdAt = row.created_at ?? row.approved_at
	// Approving the commit that already serves marks it served now; a commit
	// still building (including a first build, with no serving pointer yet)
	// is marked when its serving advance lands.
	await db
		.prepare(
			`INSERT INTO package_capability_approvals (
				id, package_id, owner_user_id, published_commit, fingerprint,
				capability_set_json, dependency_snapshot_json,
				approved_by_user_id, approved_at, created_at, served_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (
				SELECT ? FROM saved_packages AS package
				JOIN entity_sources AS source ON source.id = package.source_id
				WHERE package.id = ? AND source.user_id = ?
					AND source.serving_commit = ?${andLiveDeletedAtSql('package')}${andLiveDeletedAtSql('source')}
			))`,
		)
		.bind(
			row.id,
			row.package_id,
			row.owner_user_id,
			row.published_commit,
			row.fingerprint,
			row.capability_set_json,
			row.dependency_snapshot_json,
			row.approved_by_user_id,
			row.approved_at,
			createdAt,
			row.approved_at,
			row.package_id,
			row.owner_user_id,
			row.published_commit,
		)
		.run()
	return mapRow({ ...row, created_at: createdAt })
}

export async function getLatestPackageCapabilityApproval(
	db: D1Database,
	input: { packageId: string; ownerUserId: string },
): Promise<PackageCapabilityApprovalRecord | null> {
	const row = await db
		.prepare(
			`SELECT id, package_id, owner_user_id, published_commit, fingerprint,
				capability_set_json, dependency_snapshot_json,
				approved_by_user_id, approved_at, created_at
			FROM package_capability_approvals
			WHERE package_id = ? AND owner_user_id = ?
			ORDER BY approved_at DESC
			LIMIT 1`,
		)
		.bind(input.packageId, input.ownerUserId)
		.first()
	return row ? mapRow(row) : null
}

export async function updatePackageCapabilityApprovalSnapshot(
	db: D1Database,
	input: {
		id: string
		dependencySnapshotJson: string
		capabilitySetJson: string
		approvedByUserId: string
		approvedAt: string
	},
): Promise<PackageCapabilityApprovalRecord | null> {
	await db
		.prepare(
			`UPDATE package_capability_approvals
			SET dependency_snapshot_json = ?,
				capability_set_json = ?,
				approved_by_user_id = ?,
				approved_at = ?
			WHERE id = ?`,
		)
		.bind(
			input.dependencySnapshotJson,
			input.capabilitySetJson,
			input.approvedByUserId,
			input.approvedAt,
			input.id,
		)
		.run()
	const row = await db
		.prepare(
			`SELECT id, package_id, owner_user_id, published_commit, fingerprint,
				capability_set_json, dependency_snapshot_json,
				approved_by_user_id, approved_at, created_at
			FROM package_capability_approvals
			WHERE id = ?
			LIMIT 1`,
		)
		.bind(input.id)
		.first()
	return row ? mapRow(row) : null
}

export function isEmptyDependencySnapshotJson(raw: string | null | undefined) {
	if (!raw) return true
	const trimmed = raw.trim()
	return trimmed === '' || trimmed === '{}'
}

export async function findPackageCapabilityApprovalByFingerprint(
	db: D1Database,
	input: {
		packageId: string
		ownerUserId: string
		fingerprint: string
		publishedCommit?: string
	},
): Promise<PackageCapabilityApprovalRecord | null> {
	if (input.publishedCommit) {
		const row = await db
			.prepare(
				`SELECT id, package_id, owner_user_id, published_commit, fingerprint,
					capability_set_json, dependency_snapshot_json,
					approved_by_user_id, approved_at, created_at
				FROM package_capability_approvals
				WHERE package_id = ? AND owner_user_id = ?
					AND fingerprint = ? AND published_commit = ?
				ORDER BY approved_at DESC
				LIMIT 1`,
			)
			.bind(
				input.packageId,
				input.ownerUserId,
				input.fingerprint,
				input.publishedCommit,
			)
			.first()
		return row ? mapRow(row) : null
	}
	const row = await db
		.prepare(
			`SELECT id, package_id, owner_user_id, published_commit, fingerprint,
				capability_set_json, dependency_snapshot_json,
				approved_by_user_id, approved_at, created_at
			FROM package_capability_approvals
			WHERE package_id = ? AND owner_user_id = ? AND fingerprint = ?
			ORDER BY approved_at DESC
			LIMIT 1`,
		)
		.bind(input.packageId, input.ownerUserId, input.fingerprint)
		.first()
	return row ? mapRow(row) : null
}

/**
 * The approval anonymous visitors run (ADR 0069): the serving commit's own
 * approval, else the approval of the commit that served most recently. Only
 * approvals marked `served_at` qualify there, so a commit still building, or
 * one superseded before it served, never reaches visitors.
 */
export async function getServedPackageCapabilityApproval(
	db: D1Database,
	input: { packageId: string; ownerUserId: string; sourceId: string },
): Promise<PackageCapabilityApprovalRecord | null> {
	const servingCommitSql =
		'COALESCE(source.serving_commit, source.published_commit)'
	const row = await db
		.prepare(
			`SELECT approval.id, approval.package_id, approval.owner_user_id,
				approval.published_commit, approval.fingerprint,
				approval.capability_set_json, approval.dependency_snapshot_json,
				approval.approved_by_user_id, approval.approved_at, approval.created_at
			FROM package_capability_approvals AS approval
			JOIN entity_sources AS source
				ON source.id = ?
				AND source.user_id = approval.owner_user_id
				AND source.published_commit IS NOT NULL${andLiveDeletedAtSql('source')}
			WHERE approval.package_id = ? AND approval.owner_user_id = ?
				AND (
					approval.published_commit = ${servingCommitSql}
					OR (
						approval.published_commit != source.published_commit
						AND approval.served_at IS NOT NULL
					)
				)
			ORDER BY
				CASE WHEN approval.published_commit = ${servingCommitSql} THEN 0 ELSE 1 END,
				approval.served_at DESC,
				approval.approved_at DESC
			LIMIT 1`,
		)
		.bind(input.sourceId, input.packageId, input.ownerUserId)
		.first()
	return row ? mapRow(row) : null
}

/**
 * Insert an approval for `row.published_commit` only while that commit is
 * still the source's published commit and has no approval yet. Batched with
 * the serving-pointer advance so both land together or neither does.
 */
export function prepareCarriedForwardPackageCapabilityApproval(
	db: D1Database,
	row: Omit<PackageCapabilityApprovalRow, 'created_at'> & {
		source_id: string
	},
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO package_capability_approvals (
				id, package_id, owner_user_id, published_commit, fingerprint,
				capability_set_json, dependency_snapshot_json,
				approved_by_user_id, approved_at, created_at
			)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			WHERE EXISTS (
				SELECT 1 FROM entity_sources
				WHERE id = ? AND user_id = ? AND published_commit = ?${andLiveDeletedAtSql()}
			)
			AND NOT EXISTS (
				SELECT 1 FROM package_capability_approvals
				WHERE package_id = ? AND owner_user_id = ? AND published_commit = ?
			)`,
		)
		.bind(
			row.id,
			row.package_id,
			row.owner_user_id,
			row.published_commit,
			row.fingerprint,
			row.capability_set_json,
			row.dependency_snapshot_json,
			row.approved_by_user_id,
			row.approved_at,
			row.approved_at,
			row.source_id,
			row.owner_user_id,
			row.published_commit,
			row.package_id,
			row.owner_user_id,
			row.published_commit,
		)
}

/**
 * Stamp the approvals for `commit` served each time it becomes the source's
 * serving commit, so the fallback's "served most recently" holds. The time is
 * taken when the statement runs, so a retried batch never writes an older one. Batched
 * right after the serving-pointer advance, so it marks nothing when the
 * advance lost its compare-and-set.
 */
export function prepareMarkServedPackageCapabilityApprovals(
	db: D1Database,
	input: { sourceId: string; userId: string; commit: string },
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE package_capability_approvals
			SET served_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			WHERE published_commit = ? AND owner_user_id = ?
				AND package_id IN (
					SELECT id FROM saved_packages WHERE source_id = ?${andLiveDeletedAtSql()}
				)
				AND EXISTS (
					SELECT 1 FROM entity_sources
					WHERE id = ? AND user_id = ? AND serving_commit = ?${andLiveDeletedAtSql()}
				)`,
		)
		.bind(
			input.commit,
			input.userId,
			input.sourceId,
			input.sourceId,
			input.userId,
			input.commit,
		)
}
