/**
 * Find and repair live accounts whose personal org (`users.personal_org_id`)
 * has no live `orgs` row, owner membership, or handle. Repairs recreate only
 * those rows with default free billing columns (no plan, credit, or
 * enablement changes) and write one audit event per repaired account. Inserts
 * are plain (not OR IGNORE): a slug/handle conflict fails the account's batch
 * atomically and reports `failed` instead of a false `repaired`.
 */
import { unusablePasswordHash } from '#worker/identity/usable-password.ts'
import { normalizeUsername } from '#worker/identity/username.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { bumpAccessEpochStatement } from '#worker/authorization/access-compile.ts'

export const personalOrgRepairLimitDefault = 200
export const personalOrgRepairLimitMax = 500

export type PersonalOrgRepairOutcome =
	| 'repaired'
	| 'skipped_org_soft_deleted'
	| 'skipped_slug_taken'
	| 'failed'

export type PersonalOrgRepairResult = {
	dryRun: boolean
	counts: {
		scanned: number
		distinctOrgId: number
		missingOrg: number
		missingMembership: number
		missingHandle: number
		needsRepair: number
		repaired: number
		skippedOrgSoftDeleted: number
		skippedSlugTaken: number
		failed: number
	}
	bySignupPath: Array<{ signupPath: string; count: number }>
	outcomes: Array<{
		stableUserId: string
		outcome: PersonalOrgRepairOutcome
		error?: string
	}>
	nextCursor: number | null
}

type ScanRow = {
	id: number
	stable_user_id: string
	org_id: string
	username: string
	password_hash: string | null
	mcp_client_name: string | null
	created_at: string
	live_org: number
	deleted_org: number
	membership: number
	handle: number
	slug_taken: number
}

/** Coarse signup path from the stored password marker and first MCP client. */
export function personalOrgSignupPath(row: {
	password_hash: string | null
	mcp_client_name: string | null
}) {
	const hash = row.password_hash ?? ''
	const base =
		hash === unusablePasswordHash.oauthCreated
			? 'oauth'
			: hash === unusablePasswordHash.adminCreated
				? 'admin'
				: hash === unusablePasswordHash.reclaimedUnverified
					? 'reclaimed'
					: 'password'
	const client = row.mcp_client_name?.trim()
	return client ? `${base}:${client}` : base
}

function slugFor(username: string) {
	return normalizeUsername(username)?.toLowerCase() ?? ''
}

export async function runPersonalOrgRepair(input: {
	env: Pick<Env, 'APP_DB' | 'AUDIT_DB' | 'SENTRY_ENVIRONMENT'>
	dryRun: boolean
	actorEmail?: string | null
	stableUserId?: string
	limit?: number
	cursor?: number | null
	now?: Date
}): Promise<PersonalOrgRepairResult> {
	const db = input.env.APP_DB
	const limit = Math.min(
		Math.max(1, input.limit ?? personalOrgRepairLimitDefault),
		personalOrgRepairLimitMax,
	)
	const target = input.stableUserId?.trim() || null
	const rows = await db
		.prepare(
			`SELECT u.id, u.stable_user_id, u.username, u.password_hash,
			        u.mcp_client_name, u.created_at,
			        COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id) AS org_id,
			        EXISTS (SELECT 1 FROM orgs o WHERE o.id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id) AND o.deleted_at IS NULL) AS live_org,
			        EXISTS (SELECT 1 FROM orgs o WHERE o.id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id) AND o.deleted_at IS NOT NULL) AS deleted_org,
			        EXISTS (SELECT 1 FROM org_memberships m WHERE m.org_id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id) AND m.user_id = u.stable_user_id AND m.deleted_at IS NULL) AS membership,
			        EXISTS (SELECT 1 FROM handles h WHERE h.org_id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)) AS handle,
			        EXISTS (SELECT 1 FROM orgs o WHERE o.slug = LOWER(u.username) AND o.id != COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)) AS slug_taken
			 FROM users u
			 WHERE u.deleted_at IS NULL AND u.deleting_at IS NULL AND u.id > ?
			   ${target ? 'AND u.stable_user_id = ?' : ''}
			 ORDER BY u.id ASC
			 LIMIT ?`,
		)
		.bind(input.cursor ?? 0, ...(target ? [target] : []), limit)
		.all<ScanRow>()
	const scanned = rows.results ?? []
	const result: PersonalOrgRepairResult = {
		dryRun: input.dryRun,
		counts: {
			scanned: scanned.length,
			distinctOrgId: 0,
			missingOrg: 0,
			missingMembership: 0,
			missingHandle: 0,
			needsRepair: 0,
			repaired: 0,
			skippedOrgSoftDeleted: 0,
			skippedSlugTaken: 0,
			failed: 0,
		},
		bySignupPath: [],
		outcomes: [],
		nextCursor: scanned.length === limit ? (scanned.at(-1)?.id ?? null) : null,
	}
	const byPath = new Map<string, number>()
	const now = (input.now ?? new Date()).toISOString()
	for (const row of scanned) {
		if (row.org_id !== row.stable_user_id) result.counts.distinctOrgId++
		const missingOrg = Number(row.live_org) !== 1
		const missingMembership = Number(row.membership) !== 1
		const missingHandle = Number(row.handle) !== 1
		if (missingOrg) result.counts.missingOrg++
		if (missingMembership) result.counts.missingMembership++
		if (missingHandle) result.counts.missingHandle++
		if (!missingOrg && !missingMembership && !missingHandle) continue
		result.counts.needsRepair++
		const path = personalOrgSignupPath(row)
		byPath.set(path, (byPath.get(path) ?? 0) + 1)
		if (missingOrg && Number(row.deleted_org) === 1) {
			result.counts.skippedOrgSoftDeleted++
			result.outcomes.push({
				stableUserId: row.stable_user_id,
				outcome: 'skipped_org_soft_deleted',
			})
			continue
		}
		const slug = slugFor(row.username)
		if (missingOrg && (Number(row.slug_taken) === 1 || slug === '')) {
			result.counts.skippedSlugTaken++
			result.outcomes.push({
				stableUserId: row.stable_user_id,
				outcome: 'skipped_slug_taken',
			})
			continue
		}
		if (input.dryRun) {
			result.counts.repaired++
			result.outcomes.push({
				stableUserId: row.stable_user_id,
				outcome: 'repaired',
			})
			continue
		}
		try {
			const statements: Array<D1PreparedStatement> = []
			if (missingOrg) {
				statements.push(
					db
						.prepare(
							`INSERT INTO orgs (id, slug, plan, entitlement_ladder, created_by_user_id, created_at, updated_at)
							 VALUES (?, ?, 'free', 'public', ?, ?, ?)`,
						)
						.bind(row.org_id, slug, row.stable_user_id, now, now),
				)
			}
			if (missingMembership) {
				statements.push(
					db
						.prepare(
							`INSERT INTO org_memberships (org_id, user_id, role, invited_by_user_id, created_at, deleted_at)
							 VALUES (?, ?, 'owner', NULL, ?, NULL)
							 ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'owner', deleted_at = NULL`,
						)
						.bind(row.org_id, row.stable_user_id, now),
					bumpAccessEpochStatement(db, row.org_id),
				)
			}
			if (missingHandle && slug !== '') {
				statements.push(
					db
						.prepare(
							`INSERT INTO handles (handle, user_id, org_id, created_at)
							 VALUES (?, ?, ?, ?)`,
						)
						.bind(slug, row.stable_user_id, row.org_id, now),
				)
			}
			await db.batch(statements)
			result.counts.repaired++
			result.outcomes.push({
				stableUserId: row.stable_user_id,
				outcome: 'repaired',
			})
			await logAuditEvent({
				db: auditDatabaseFromEnv(input.env),
				category: 'admin',
				action: 'personal_org_repair',
				result: 'success',
				email: input.actorEmail ?? undefined,
				path: '/mcp',
				reason: [
					`target_stable_user_id=${row.stable_user_id}`,
					`org=${missingOrg ? 1 : 0}`,
					`membership=${missingMembership ? 1 : 0}`,
					`handle=${missingHandle ? 1 : 0}`,
				].join(';'),
			})
		} catch (error) {
			result.counts.failed++
			result.outcomes.push({
				stableUserId: row.stable_user_id,
				outcome: 'failed',
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}
	result.bySignupPath = [...byPath]
		.map(([signupPath, count]) => ({ signupPath, count }))
		.sort(
			(a, b) => b.count - a.count || a.signupPath.localeCompare(b.signupPath),
		)
	return result
}
