import type { AccountPackageSecurityAudit } from '#universal/loader-data.ts'
import { buildPackageSecurityAuditPrompt } from '#universal/package-security-audit-prompt.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { getLatestPackageSecurityAudit } from './security-audits-repo.ts'

async function lookupRecorderUsername(db: D1Database, personId: string) {
	const row = await db
		.prepare(
			`SELECT username FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(personId)
		.first<{ username: string | null }>()
	const username = row?.username?.trim()
	return username ? `@${username}` : null
}

type CurrentPackageSecurityAudit = Omit<
	Extract<AccountPackageSecurityAudit, { status: 'audited' }>,
	'status'
>

/**
 * The audit recorded for exactly this published commit + capability
 * fingerprint. Any newer publish or capability change has no matching row,
 * so it reads as not audited.
 */
export async function loadCurrentPackageSecurityAudit(
	db: D1Database,
	input: {
		ownerUserId: string
		packageId: string
		publishedCommit: string
		fingerprint: string
	},
): Promise<CurrentPackageSecurityAudit | null> {
	const audit = await getLatestPackageSecurityAudit(db, input)
	if (!audit) return null
	const recorder =
		(await lookupRecorderUsername(db, audit.recordedByUserId)) ??
		'a former member'
	const auditor = audit.auditorLabel ?? recorder
	return {
		verdict: audit.verdict,
		summary: audit.summary,
		auditor,
		recordedBy: auditor === recorder ? null : recorder,
		recordedAt: audit.recordedAt,
	}
}

/** Approval-page audit state, with the agent prompt when not yet audited. */
export async function loadPackageSecurityAuditState(input: {
	db: D1Database
	ownerUserId: string
	packageId: string
	packageName: string
	publishedCommit: string | null
	fingerprint: string
	approvalUrl: string
}): Promise<AccountPackageSecurityAudit> {
	if (!input.publishedCommit) return { status: 'unpublished' }
	const audit = await loadCurrentPackageSecurityAudit(input.db, {
		ownerUserId: input.ownerUserId,
		packageId: input.packageId,
		publishedCommit: input.publishedCommit,
		fingerprint: input.fingerprint,
	})
	if (audit) return { status: 'audited', ...audit }
	return {
		status: 'not_audited',
		prompt: buildPackageSecurityAuditPrompt({
			packageName: input.packageName,
			packageId: input.packageId,
			publishedCommit: input.publishedCommit,
			fingerprint: input.fingerprint,
			approvalUrl: input.approvalUrl,
		}),
	}
}
