import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { requirePackageIdFromJobId } from '#worker/jobs/package-job-id.ts'
import {
	type McpHubServerImportResult,
	type McpHubServerTransfer,
} from '#worker/mcp-client/hub-transfer.ts'
import { buildOrgTransferBackup, orgTransferBackupKey } from './backup.ts'
import { buildOrgTransferStatements } from './batch.ts'
import { type OrgTransferFinding } from './findings.ts'
import {
	type OrgTransferLogoCopy,
	type OrgTransferPlan,
	planOrgTransfer,
} from './plan.ts'
import { type OrgTransferSealedColumns } from './reencrypt.ts'
import { type OrgTransferSnapshot, type OrgTransferOrg } from './snapshot.ts'
import {
	type OrgTransferMcpConnection,
	type OrgTransferPostCommitResult,
} from './post-commit-result.ts'
import {
	OrgTransferStorageNotEmptyError,
	type StorageCopyResult,
} from './storage-copy.ts'
import {
	fingerprintOrgTransferSummary,
	type OrgTransferSummary,
	summarizeOrgTransferPlan,
} from './report.ts'

export type OrgTransferMode = 'dry-run' | 'apply'

export type OrgTransferAuditEvent = {
	orgId: string
	action: string
	details: Record<string, unknown>
}

/**
 * Everything outside APP_DB the transfer touches. Production wires these to
 * Durable Objects, R2, and the jobs worker; tests replace them to drive
 * failures at each step.
 */
export type OrgTransferEffects = {
	withWriteLease<T>(ownerId: OwnerId, write: () => Promise<T>): Promise<T>
	loadSnapshot(input: {
		from: OrgTransferOrg
		to: OrgTransferOrg
	}): Promise<OrgTransferSnapshot>
	reseal(plan: OrgTransferPlan): Promise<OrgTransferSealedColumns>
	writeBackup(input: {
		key: string
		backup: ReturnType<typeof buildOrgTransferBackup>
	}): Promise<void>
	copyLogo(copy: OrgTransferLogoCopy): Promise<void>
	deleteLogo(key: string): Promise<void>
	isStorageEmpty(input: {
		userId: OwnerId
		storageId: string
	}): Promise<boolean>
	/** Throws `OrgTransferStorageNotEmptyError` before writing to a full target. */
	copyStorage(input: {
		fromUserId: OwnerId
		toUserId: OwnerId
		storageId: string
	}): Promise<StorageCopyResult>
	clearStorage(input: { userId: OwnerId; storageId: string }): Promise<void>
	exportMcpServer(input: {
		userId: OwnerId
		serverId: string
	}): Promise<McpHubServerTransfer | null>
	importMcpServer(input: {
		userId: OwnerId
		transfer: McpHubServerTransfer
	}): Promise<McpHubServerImportResult>
	discardMcpServerImport(input: {
		userId: OwnerId
		serverId: string
	}): Promise<void>
	jobCallerContextJson(input: {
		userId: OwnerId
		packageId: string
	}): Promise<string>
	transferJobs(input: {
		fromUserId: OwnerId
		toUserId: OwnerId
		jobs: Array<{ jobId: string; callerContextJson: string }>
		updatedAt: string
	}): Promise<{ transferred: number }>
	/**
	 * Plans the wipe of members' personal connections pinned to the org's
	 * moving OAuth apps: their grants are to this org, and the apps leave it
	 * (ADR 0068 amendment 2026-10-29). The deletes commit in the transfer
	 * batch; upstream revoke and audit run after commit.
	 */
	planPinnedMemberWipes(input: {
		orgId: OwnerId
		appSlugs: Array<string>
	}): Promise<{
		statements: Array<D1PreparedStatement>
		afterCommit(): Promise<unknown>
	}>
	/** Org audit outbox rows for the batch, and delivery after commit. */
	planAudit(events: Array<OrgTransferAuditEvent>): {
		statements: Array<D1PreparedStatement>
		deliver(): Promise<void>
	}
	/** Best-effort cleanup and reindex after commit; returns warnings. */
	afterCommit(input: {
		plan: OrgTransferPlan
		cleanupOrphans: boolean
	}): Promise<OrgTransferPostCommitResult>
}

export type OrgTransferOutcome = 'planned' | 'refused' | 'failed' | 'applied'

/** Apply's pre-commit steps, in order. */
export const orgTransferSteps = [
	'reseal',
	'backup',
	'logo_copy',
	'storage_copy',
	'mcp_import',
	'jobs_transfer',
	'commit',
] as const

export type OrgTransferStep = (typeof orgTransferSteps)[number]

/**
 * A failure before the batch committed: nothing moved. `failed_undo` lists
 * side copies that could not be undone (the source still holds its data;
 * the target may hold stray copies). `backup_key` is null when the failure
 * came before the backup step; when the backup step itself failed, the
 * object may or may not exist.
 */
export type OrgTransferFailure = {
	committed: false
	failed_step: OrgTransferStep
	failed_undo?: Array<string>
	backup_key: string | null
	message: string
}

export type OrgTransferResult = {
	mode: OrgTransferMode
	outcome: OrgTransferOutcome
	applied: boolean
	summary: OrgTransferSummary
	/** Hash of `summary`; pass it back as `expectedFingerprint` to apply. */
	fingerprint: string
	/** Why apply refuses (or, on dry-run, would refuse) this plan. */
	refusals: Array<OrgTransferFinding>
	failure: OrgTransferFailure | null
	backupKey: string | null
	storage: Array<StorageCopyResult>
	leftovers: Record<string, number>
	postCommitWarnings: Array<OrgTransferFinding>
	mcpConnections: Array<OrgTransferMcpConnection>
}

export class OrgTransferRefusedError extends Error {
	override readonly name = 'OrgTransferRefusedError'
}

type Compensation = { label: string; run: () => Promise<void> }

async function resolveOrg(db: D1Database, orgId: string, role: string) {
	const row = await db
		.prepare(
			`SELECT id, slug, suspended_at FROM orgs
			 WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL`,
		)
		.bind(orgId)
		.first<{ id: string; slug: string; suspended_at: string | null }>()
	if (!row) {
		throw new OrgTransferRefusedError(`The ${role} org ${orgId} is not live.`)
	}
	if (row.suspended_at) {
		throw new OrgTransferRefusedError(
			`The ${role} org @${row.slug} is suspended.`,
		)
	}
	return { id: row.id as OwnerId, slug: row.slug }
}

/** Target StorageRunners that already hold data become clashes. */
async function addStorageClashes(
	effects: OrgTransferEffects,
	plan: OrgTransferPlan,
) {
	const full = await Promise.all(
		plan.storageCopies.map(async (copy) =>
			(await effects.isStorageEmpty({
				userId: plan.to.id,
				storageId: copy.storageId,
			}))
				? null
				: copy.storageId,
		),
	)
	for (const storageId of full) {
		if (storageId) {
			plan.clashes.push({
				code: 'target_storage_not_empty',
				message: `storage: ${storageId} already holds data in @${plan.to.slug}`,
				table: 'user_storage_buckets',
				subject: storageId,
			})
		}
	}
	return plan
}

async function planWithFingerprint(input: {
	effects: OrgTransferEffects
	from: OrgTransferOrg
	to: OrgTransferOrg
	skipOrphans: boolean
	expectedFingerprint: string | undefined
}) {
	const plan = await addStorageClashes(
		input.effects,
		planOrgTransfer(
			await input.effects.loadSnapshot({ from: input.from, to: input.to }),
		),
	)
	const summary = summarizeOrgTransferPlan(plan)
	const fingerprint = await fingerprintOrgTransferSummary(summary)
	const refusals: Array<OrgTransferFinding> = [
		...plan.clashes,
		...plan.blockers,
	]
	if (plan.orphans.length > 0 && !input.skipOrphans) {
		refusals.push({
			code: 'orphans_present',
			message: `${plan.orphans.length} orphaned row(s) found; pass skipOrphans to leave them out and clean them up.`,
		})
	}
	if (
		input.expectedFingerprint !== undefined &&
		input.expectedFingerprint !== fingerprint
	) {
		refusals.push({
			code: 'plan_drifted',
			message: `The plan changed since expectedFingerprint ${input.expectedFingerprint} (now ${fingerprint}); dry-run again and review it.`,
		})
	}
	return { plan, summary, fingerprint, refusals }
}

function notApplied(input: {
	mode: OrgTransferMode
	outcome: OrgTransferOutcome
	summary: OrgTransferSummary
	fingerprint: string
	refusals: Array<OrgTransferFinding>
	failure?: OrgTransferFailure
}): OrgTransferResult {
	return {
		mode: input.mode,
		outcome: input.outcome,
		applied: false,
		summary: input.summary,
		fingerprint: input.fingerprint,
		refusals: input.refusals,
		failure: input.failure ?? null,
		backupKey: input.failure?.backup_key ?? null,
		storage: [],
		leftovers: {},
		postCommitWarnings: [],
		mcpConnections: [],
	}
}

async function runCompensations(compensations: Array<Compensation>) {
	const failures: Array<string> = []
	for (const compensation of compensations.toReversed()) {
		try {
			await compensation.run()
		} catch {
			failures.push(compensation.label)
		}
	}
	return failures
}

/**
 * Move every live resource of one org to another: dry-run reports the plan;
 * apply holds both orgs' write leases, backs up every touched row, copies
 * side storage, then re-points APP_DB in one batch. Any failure before the
 * batch commits undoes the side copies, so the source org stays whole, and
 * returns outcome `failed` instead of throwing.
 */
export async function runOrgResourceTransfer(input: {
	db: D1Database
	effects: OrgTransferEffects
	actorUserId: string
	fromOrgId: string
	toOrgId: string
	mode: OrgTransferMode
	skipOrphans: boolean
	/** Apply refuses unless the plan still hashes to this. */
	expectedFingerprint?: string
	now?: () => Date
}): Promise<OrgTransferResult> {
	const { db, effects } = input
	const now = input.now ?? (() => new Date())
	if (input.fromOrgId === input.toOrgId) {
		throw new OrgTransferRefusedError('Source and target org are the same.')
	}
	const from = await resolveOrg(db, input.fromOrgId, 'source')
	const to = await resolveOrg(db, input.toOrgId, 'target')

	if (input.mode === 'dry-run') {
		const planned = await planWithFingerprint({
			effects,
			from,
			to,
			skipOrphans: input.skipOrphans,
			expectedFingerprint: input.expectedFingerprint,
		})
		return notApplied({ mode: 'dry-run', outcome: 'planned', ...planned })
	}

	// A fixed lock order keeps two opposite transfers from deadlocking.
	const [first, second] = [from.id, to.id].toSorted()
	return await effects.withWriteLease(first!, () =>
		effects.withWriteLease(second!, () =>
			applyUnderLease({
				...input,
				expectedFingerprint: input.expectedFingerprint,
				from,
				to,
				now,
			}),
		),
	)
}

async function applyUnderLease(input: {
	db: D1Database
	effects: OrgTransferEffects
	from: OrgTransferOrg
	to: OrgTransferOrg
	actorUserId: string
	skipOrphans: boolean
	expectedFingerprint: string | undefined
	now: () => Date
}): Promise<OrgTransferResult> {
	const { db, effects, from, to } = input
	const { plan, summary, fingerprint, refusals } = await planWithFingerprint({
		effects,
		from,
		to,
		skipOrphans: input.skipOrphans,
		expectedFingerprint: input.expectedFingerprint,
	})
	if (refusals.length > 0) {
		return notApplied({
			mode: 'apply',
			outcome: 'refused',
			summary,
			fingerprint,
			refusals,
		})
	}

	let step: OrgTransferStep = 'reseal'
	let backupKey: string | null = null
	const compensations: Array<Compensation> = []
	const storage: Array<StorageCopyResult> = []
	try {
		const sealed = await effects.reseal(plan)

		step = 'backup'
		const startedAt = input.now()
		const key = orgTransferBackupKey({
			fromOrgId: from.id,
			toOrgId: to.id,
			now: startedAt,
		})
		backupKey = key
		await effects.writeBackup({
			key,
			backup: buildOrgTransferBackup({
				plan,
				actorUserId: input.actorUserId,
				createdAt: startedAt.toISOString(),
			}),
		})

		step = 'logo_copy'
		for (const copy of plan.logoCopies) {
			await effects.copyLogo(copy)
			compensations.push({
				label: `logo ${copy.toKey}`,
				run: () => effects.deleteLogo(copy.toKey),
			})
		}
		step = 'storage_copy'
		for (const copy of plan.storageCopies) {
			const clearTarget: Compensation = {
				label: `storage ${copy.storageId}`,
				run: () =>
					effects.clearStorage({ userId: to.id, storageId: copy.storageId }),
			}
			try {
				storage.push(
					await effects.copyStorage({
						fromUserId: from.id,
						toUserId: to.id,
						storageId: copy.storageId,
					}),
				)
			} catch (error) {
				// A copy that fails half way leaves rows to clear; a refused full
				// target was never written and must keep its data.
				if (!(error instanceof OrgTransferStorageNotEmptyError)) {
					compensations.push(clearTarget)
				}
				throw error
			}
			compensations.push(clearTarget)
		}
		step = 'mcp_import'
		for (const row of plan.moves.mcp_server_settings) {
			const serverId = String(row['id'])
			const transfer = await effects.exportMcpServer({
				userId: from.id,
				serverId,
			})
			if (!transfer) {
				throw new Error(
					`MCP server ${String(row['name'])} has no connection in @${from.slug}'s hub.`,
				)
			}
			const imported = await effects.importMcpServer({
				userId: to.id,
				transfer,
			})
			if (!imported.ok) {
				throw new Error(
					`MCP server ${String(row['name'])} could not move: ${imported.reason}.`,
				)
			}
			compensations.push({
				label: `MCP server ${String(row['name'])}`,
				run: () => effects.discardMcpServerImport({ userId: to.id, serverId }),
			})
		}
		step = 'jobs_transfer'
		if (plan.jobs.length > 0) {
			const updatedAt = input.now().toISOString()
			const jobs = await Promise.all(
				plan.jobs.map(async (job) => ({
					jobId: job.id,
					callerContextJson: await effects.jobCallerContextJson({
						userId: to.id,
						packageId: requirePackageIdFromJobId(job.id),
					}),
				})),
			)
			await effects.transferJobs({
				fromUserId: from.id,
				toUserId: to.id,
				jobs,
				updatedAt,
			})
			compensations.push({
				label: 'jobs',
				run: async () => {
					await effects.transferJobs({
						fromUserId: to.id,
						toUserId: from.id,
						jobs: plan.jobs.map((job) => ({
							jobId: job.id,
							callerContextJson: job.callerContextJson,
						})),
						updatedAt: input.now().toISOString(),
					})
				},
			})
		}

		step = 'commit'
		const pinnedWipes = await effects.planPinnedMemberWipes({
			orgId: from.id,
			appSlugs: plan.moves.user_oauth_apps.map((row) => String(row['slug'])),
		})
		const details = {
			from_org_id: from.id,
			from_slug: from.slug,
			to_org_id: to.id,
			to_slug: to.slug,
			backup_key: backupKey,
			counts: summary.counts,
			orphans_cleaned: plan.orphans.length,
		}
		const audit = effects.planAudit([
			{ orgId: from.id, action: 'org.resources_transferred_out', details },
			{ orgId: to.id, action: 'org.resources_transferred_in', details },
		])
		await db.batch(
			buildOrgTransferStatements({
				db,
				plan,
				sealed,
				cleanupOrphans: input.skipOrphans,
				now: input.now().toISOString(),
				auditStatements: audit.statements,
				pinnedWipeStatements: pinnedWipes.statements,
			}),
		)
		await audit.deliver().catch(() => {})
		await pinnedWipes.afterCommit().catch(() => {})
	} catch (error) {
		const failedUndo = await runCompensations(compensations)
		return notApplied({
			mode: 'apply',
			outcome: 'failed',
			summary,
			fingerprint,
			refusals: [],
			failure: {
				committed: false,
				failed_step: step,
				...(failedUndo.length > 0 ? { failed_undo: failedUndo } : {}),
				backup_key: backupKey,
				message: error instanceof Error ? error.message : String(error),
			},
		})
	}

	// The move is durable now: an unexpected failure here must still return
	// the committed result and backup key.
	const after = await effects
		.afterCommit({ plan, cleanupOrphans: input.skipOrphans })
		.catch((error: unknown): OrgTransferPostCommitResult => ({
			leftovers: {},
			warnings: [
				{
					code: 'post_commit_step_failed',
					message: `post-commit: ${error instanceof Error ? error.message : String(error)}`,
					subject: 'post-commit',
				},
			],
			mcpConnections: [],
		}))
	return {
		mode: 'apply',
		outcome: 'applied',
		applied: true,
		summary,
		fingerprint,
		refusals: [],
		failure: null,
		backupKey,
		storage,
		leftovers: after.leftovers,
		postCommitWarnings: after.warnings,
		mcpConnections: after.mcpConnections,
	}
}
