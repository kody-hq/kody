import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { systemEmailOwnerId } from '#worker/email/email-owner.ts'
import { mailboxRpc, type MailboxEnv } from '#worker/email/mailbox-client.ts'
import type {
	MailboxBlobReference,
	MailboxCountResult,
} from '#worker/email/mailbox-types.ts'
import {
	deleteOutboundProviderIndexByMessageId,
	loadOutboundProviderIndexHealthReport,
	type OutboundProviderIndexHealthReport,
} from '#worker/email/outbound-provider-index.ts'
import {
	loadSystemEmailHealth,
	type SystemEmailHealth,
} from '#worker/email/system-email-health.ts'
import {
	deleteSystemEmailMessageById,
	getSystemEmailMessageById,
} from '#worker/email/system-email-graph-store.ts'
import {
	assertUserEmailGraphAuthority,
	loadUserEmailGraphAuthorityMarker,
	type UserEmailGraphAuthorityMarker,
} from '#worker/email/user-email-graph-authority.ts'
import { loadProviderIndexRepairHealth } from '#worker/email/provider-index-repair-health.ts'
import {
	loadInboundDueOwnersHealth,
	type InboundDueOwnersHealth,
} from '#worker/email/inbound-due-owners.ts'
import { loadDeliveryAlertEventsHealth } from '#worker/email/delivery-alert-events.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

/** Retention owner page size default/max (hard max). */
export const adminMailboxMaintenanceRetentionMaxLimit = 20
export const adminMailboxMaintenanceRetentionDefaultLimit =
	adminMailboxMaintenanceRetentionMaxLimit

/** Max concurrent per-owner Mailbox retention RPCs. */
export const adminMailboxMaintenanceRetentionConcurrency = 4

/** Wall-clock budget for one retention action call. */
export const adminMailboxMaintenanceRetentionBudgetMs = 10_000

export type AdminMailboxMaintenanceEnv = MailboxEnv & {
	APP_DB: D1Database
	EMAIL_BLOBS: Pick<R2Bucket, 'delete' | 'head'>
}

export type AdminMailboxMaintenanceStatus = {
	generatedAt: string
	authority: UserEmailGraphAuthorityMarker | null
	/**
	 * Structural health of the operational provider reverse index. No owner
	 * ids, message ids, or email content are exposed.
	 */
	outboundProviderIndex: OutboundProviderIndexHealthReport
	providerIndexRepair: Awaited<ReturnType<typeof loadProviderIndexRepairHealth>>
	inboundDueOwners: InboundDueOwnersHealth
	deliveryAlerts: Awaited<ReturnType<typeof loadDeliveryAlertEventsHealth>>
	/** Dedicated system-email authority, counts, and reference health. */
	systemEmail: SystemEmailHealth
}

export type AdminMailboxMaintenanceRetentionMailboxMetrics = {
	ownersAttempted: number
	ownersSucceeded: number
	ownersFailed: number
	before: MailboxCountResult
	after: MailboxCountResult
	blobDeleteFailureOwners: number
	expiredRemainingOwners: number
}

export type AdminMailboxMaintenanceRetentionMetrics = {
	mailbox: AdminMailboxMaintenanceRetentionMailboxMetrics
}

/**
 * Aggregate-only outcome for a single audited admin message delete. Never
 * includes addresses, bodies, filenames, or R2 keys.
 */
export type AdminMailboxMaintenanceDeleteMessageResult = {
	authoritativeMessageAbsent: boolean
	attachmentsSeen: number
	externalAttachmentsSeen: number
	rawMimeBlobAbsent: boolean
	externalAttachmentBlobsAbsent: number
	/** True when every key captured by the authoritative delete is absent. */
	allCapturedBlobsAbsent: boolean
}

function clampRetentionLimit(limit: number | undefined): number {
	const requested = limit ?? adminMailboxMaintenanceRetentionDefaultLimit
	if (!Number.isFinite(requested)) {
		return adminMailboxMaintenanceRetentionDefaultLimit
	}
	return Math.max(
		1,
		Math.min(adminMailboxMaintenanceRetentionMaxLimit, Math.trunc(requested)),
	)
}

function emptyMailboxCounts(): MailboxCountResult {
	return { threads: 0, messages: 0, attachments: 0, deliveryEvents: 0 }
}

function addMailboxCounts(
	left: MailboxCountResult,
	right: MailboxCountResult,
): MailboxCountResult {
	return {
		threads: left.threads + right.threads,
		messages: left.messages + right.messages,
		attachments: left.attachments + right.attachments,
		deliveryEvents: left.deliveryEvents + right.deliveryEvents,
	}
}

/**
 * List active owners from the account index, ordered by stable_user_id keyset.
 */
export async function listUsersForAdminMailboxRetention(input: {
	db: D1Database
	limit: number
	startAfterUserId?: string | null
}): Promise<Array<{ userId: OwnerId }>> {
	const startAfter = input.startAfterUserId ?? null
	const result = startAfter
		? await input.db
				.prepare(
					`SELECT u.stable_user_id AS userId
					FROM users u
					WHERE u.deleting_at IS NULL
						AND u.stable_user_id IS NOT NULL
						AND u.stable_user_id != ?
						AND u.stable_user_id > ?${andLiveDeletedAtSql()}
					ORDER BY u.stable_user_id ASC LIMIT ?`,
				)
				.bind(systemEmailOwnerId, startAfter, input.limit)
				.all<{ userId: OwnerId }>()
		: await input.db
				.prepare(
					`SELECT u.stable_user_id AS userId
					FROM users u
					WHERE u.deleting_at IS NULL
						AND u.stable_user_id IS NOT NULL
						AND u.stable_user_id != ?${andLiveDeletedAtSql()}
					ORDER BY u.stable_user_id ASC LIMIT ?`,
				)
				.bind(systemEmailOwnerId, input.limit)
				.all<{ userId: OwnerId }>()
	return result.results ?? []
}

type OwnerRetentionOutcome =
	| {
			status: 'succeeded'
			before: MailboxCountResult
			after: MailboxCountResult
			blobDeleteFailures: boolean
			expiredRemaining: boolean
	  }
	| { status: 'failed' }

async function runOwnersWithBudget(input: {
	owners: ReadonlyArray<{ userId: OwnerId }>
	concurrency: number
	deadlineMs: number
	nowMs: () => number
	runOwner: (userId: OwnerId) => Promise<OwnerRetentionOutcome>
}): Promise<{
	outcomes: Array<OwnerRetentionOutcome>
	lastAttemptedUserId: string | null
	stoppedByBudget: boolean
}> {
	const outcomes: Array<OwnerRetentionOutcome> = []
	let nextIndex = 0
	let inFlight = 0
	let lastAttemptedUserId: string | null = null
	let stoppedByBudget = false

	await new Promise<void>((resolve) => {
		const settleIfDone = () => {
			if (inFlight > 0) return
			resolve()
		}
		const launch = () => {
			while (
				inFlight < input.concurrency &&
				nextIndex < input.owners.length &&
				input.nowMs() < input.deadlineMs
			) {
				const owner = input.owners[nextIndex]
				if (!owner) break
				nextIndex += 1
				lastAttemptedUserId = owner.userId
				inFlight += 1
				void input
					.runOwner(owner.userId)
					.then((outcome) => {
						outcomes.push(outcome)
					})
					.catch(() => {
						// runOwner isolates failures; this is a last-resort guard.
						outcomes.push({ status: 'failed' })
					})
					.finally(() => {
						inFlight -= 1
						launch()
						settleIfDone()
					})
			}
			if (
				input.nowMs() >= input.deadlineMs &&
				nextIndex < input.owners.length
			) {
				stoppedByBudget = true
			}
			settleIfDone()
		}
		launch()
	})

	return { outcomes, lastAttemptedUserId, stoppedByBudget }
}

/**
 * Aggregate-only Mailbox authority status for operators. Never returns email
 * content, message ids, or per-owner identity (except retention cursors).
 */
export async function loadAdminMailboxMaintenanceStatus(input: {
	db: D1Database
	now?: Date
}): Promise<AdminMailboxMaintenanceStatus> {
	const now = input.now ?? new Date()
	const generatedAt = now.toISOString()
	const [
		authority,
		outboundProviderIndexHealth,
		providerIndexRepair,
		inboundDueOwners,
		deliveryAlerts,
		systemEmail,
	] = await Promise.all([
		loadUserEmailGraphAuthorityMarker(input.db),
		loadOutboundProviderIndexHealthReport({ db: input.db }),
		loadProviderIndexRepairHealth({ db: input.db }),
		loadInboundDueOwnersHealth({ db: input.db, now }),
		loadDeliveryAlertEventsHealth({ db: input.db, now }),
		loadSystemEmailHealth({ db: input.db }),
	])
	return {
		generatedAt,
		authority,
		outboundProviderIndex: outboundProviderIndexHealth,
		providerIndexRepair,
		inboundDueOwners,
		deliveryAlerts,
		systemEmail,
	}
}

/**
 * Bounded owner-Mailbox retention sweep. Stable-id keyset cursor, wall budget,
 * concurrency bounds, and per-owner failure isolation.
 */
export async function runAdminMailboxMaintenanceRetention(input: {
	env: AdminMailboxMaintenanceEnv
	limit?: number
	startAfterUserId?: string | null
	now?: Date
	/** Test seam for wall-clock budget. */
	budgetMs?: number
	/** Test seam for concurrency. */
	concurrency?: number
	/** Test seam for clock. */
	nowMs?: () => number
}): Promise<{
	metrics: AdminMailboxMaintenanceRetentionMetrics
	nextStartAfter: string | null
	truncated: boolean
	status: AdminMailboxMaintenanceStatus
}> {
	const now = input.now ?? new Date()
	const nowMs = input.nowMs ?? Date.now
	const budgetMs = input.budgetMs ?? adminMailboxMaintenanceRetentionBudgetMs
	const concurrency = Math.max(
		1,
		Math.min(
			adminMailboxMaintenanceRetentionConcurrency,
			input.concurrency ?? adminMailboxMaintenanceRetentionConcurrency,
		),
	)
	const limit = clampRetentionLimit(input.limit)
	const startAfterUserId = input.startAfterUserId ?? null
	const deadlineMs = nowMs() + budgetMs

	const owners = await listUsersForAdminMailboxRetention({
		db: input.env.APP_DB,
		limit,
		startAfterUserId,
	})

	const { outcomes, lastAttemptedUserId, stoppedByBudget } =
		await runOwnersWithBudget({
			owners,
			concurrency,
			deadlineMs,
			nowMs,
			async runOwner(userId) {
				try {
					await assertUserEmailGraphAuthority({
						db: input.env.APP_DB,
						ownerId: userId,
					})
					const result = await mailboxRpc({
						env: input.env,
						userId,
					}).runRetentionNow({ ownerId: userId })
					return {
						status: 'succeeded' as const,
						before: result.before,
						after: result.after,
						blobDeleteFailures: result.blobDeleteFailures,
						expiredRemaining: result.expiredRemaining,
					}
				} catch (error) {
					console.warn('admin-mailbox-maintenance-retention-owner-failed', {
						error,
					})
					return { status: 'failed' as const }
				}
			},
		})

	const mailbox: AdminMailboxMaintenanceRetentionMailboxMetrics = {
		ownersAttempted: 0,
		ownersSucceeded: 0,
		ownersFailed: 0,
		before: emptyMailboxCounts(),
		after: emptyMailboxCounts(),
		blobDeleteFailureOwners: 0,
		expiredRemainingOwners: 0,
	}
	for (const outcome of outcomes) {
		switch (outcome.status) {
			case 'failed':
				mailbox.ownersAttempted += 1
				mailbox.ownersFailed += 1
				break
			case 'succeeded':
				mailbox.ownersAttempted += 1
				mailbox.ownersSucceeded += 1
				mailbox.before = addMailboxCounts(mailbox.before, outcome.before)
				mailbox.after = addMailboxCounts(mailbox.after, outcome.after)
				if (outcome.blobDeleteFailures) mailbox.blobDeleteFailureOwners += 1
				if (outcome.expiredRemaining) mailbox.expiredRemainingOwners += 1
				break
			default: {
				const exhaustive: never = outcome
				throw new Error(
					`Unhandled retention owner outcome: ${JSON.stringify(exhaustive)}`,
				)
			}
		}
	}

	const pageFull = owners.length >= limit
	const truncated = stoppedByBudget || pageFull
	const nextStartAfter = truncated
		? (lastAttemptedUserId ?? startAfterUserId)
		: null

	const status = await loadAdminMailboxMaintenanceStatus({
		db: input.env.APP_DB,
		now,
	})

	return {
		metrics: {
			mailbox,
		},
		nextStartAfter,
		truncated,
		status,
	}
}

/**
 * Missing or foreign target for owner-scoped canary delete. Callers supplied
 * an id that does not resolve under the given owner fence — not a platform
 * defect. The MCP capability maps this to `McpCallerError` so it stays on
 * `mcp-event` and out of Sentry.
 */
export class AdminMailboxMessageNotFoundError extends Error {
	constructor(input: { stableUserId: OwnerId; messageId: string }) {
		super(
			`Email message not found for stable_user_id=${input.stableUserId} message_id=${input.messageId}`,
		)
		this.name = 'AdminMailboxMessageNotFoundError'
	}
}

/**
 * Owner-scoped single-message delete for accelerated Mailbox coverage canaries.
 * USER mail is deleted by the owner-bound Mailbox R2-before-metadata RPC.
 * `system:email` stays on the
 * dedicated D1 authority path. Exact authoritative keys are head-verified without being
 * returned to the caller.
 */
export async function runAdminMailboxMaintenanceDeleteMessage(input: {
	env: AdminMailboxMaintenanceEnv
	stableUserId: OwnerId
	messageId: string
}): Promise<AdminMailboxMaintenanceDeleteMessageResult> {
	const db = input.env.APP_DB
	const blobs = input.env.EMAIL_BLOBS
	let attachmentsSeen: number
	let externalAttachmentsSeen: number
	let blobReferences: Array<MailboxBlobReference>
	let authoritativeMessageAbsent = true
	if (input.stableUserId === systemEmailOwnerId) {
		const message = await getSystemEmailMessageById({
			db,
			messageId: input.messageId,
		})
		if (!message) {
			throw new AdminMailboxMessageNotFoundError({
				stableUserId: input.stableUserId,
				messageId: input.messageId,
			})
		}
		const deletion = await deleteSystemEmailMessageById({
			db,
			blobs: blobs as R2Bucket,
			messageId: input.messageId,
		})
		attachmentsSeen = deletion.attachmentsSeen
		externalAttachmentsSeen = deletion.externalAttachmentsSeen
		blobReferences = deletion.blobDeletions.map((entry) => ({
			kind: entry.role === 'raw_mime' ? 'raw_mime' : 'attachment',
			key: entry.key,
			messageId: input.messageId,
			attachmentId: null,
		}))
	} else {
		await assertUserEmailGraphAuthority({
			db,
			ownerId: input.stableUserId,
		})
		const mailbox = mailboxRpc({
			env: input.env,
			userId: input.stableUserId,
		})
		const mailboxDeletion = await mailbox.deleteMessageWithBlobs({
			ownerId: input.stableUserId,
			messageId: input.messageId,
		})
		if (mailboxDeletion.status === 'missing') {
			attachmentsSeen = 0
			externalAttachmentsSeen = 0
			blobReferences = []
			if (!mailboxDeletion.tombstoned) {
				throw new AdminMailboxMessageNotFoundError({
					stableUserId: input.stableUserId,
					messageId: input.messageId,
				})
			}
		} else {
			attachmentsSeen = mailboxDeletion.attachmentsSeen
			externalAttachmentsSeen = mailboxDeletion.externalAttachmentsSeen
			blobReferences = mailboxDeletion.blobReferences
		}
		await deleteOutboundProviderIndexByMessageId({
			db,
			messageId: input.messageId,
		})
	}

	if (input.stableUserId === systemEmailOwnerId) {
		const remaining = await getSystemEmailMessageById({
			db,
			messageId: input.messageId,
		})
		authoritativeMessageAbsent = remaining == null
	}

	const rawMimeReferences = blobReferences.filter(
		(reference) => reference.kind === 'raw_mime',
	)
	const attachmentReferences = blobReferences.filter(
		(reference) => reference.kind === 'attachment',
	)
	let rawMimeBlobAbsent = true
	for (const reference of rawMimeReferences) {
		if ((await blobs.head(reference.key)) != null) {
			rawMimeBlobAbsent = false
		}
	}
	let externalAttachmentBlobsAbsent = 0
	for (const reference of attachmentReferences) {
		if ((await blobs.head(reference.key)) == null) {
			externalAttachmentBlobsAbsent += 1
		}
	}
	const allCapturedBlobsAbsent =
		rawMimeBlobAbsent &&
		externalAttachmentBlobsAbsent === attachmentReferences.length

	return {
		authoritativeMessageAbsent,
		attachmentsSeen,
		externalAttachmentsSeen,
		rawMimeBlobAbsent,
		externalAttachmentBlobsAbsent,
		allCapturedBlobsAbsent,
	}
}
