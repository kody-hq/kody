import {
	PlatformFeedbackActiveQueueLimitError,
	PlatformFeedbackConcurrentUpdateError,
	PlatformFeedbackInvalidTransitionError,
	PlatformFeedbackNotFoundError,
	PlatformFeedbackSubmissionConflictError,
	PlatformFeedbackSubmissionRateLimitError,
} from './errors.ts'
import {
	platformFeedbackActiveQueueLimit,
	platformFeedbackSubmissionRateLimit,
	platformFeedbackSubmissionRateLimitWindowMs,
	platformFeedbackSubmissionRateLimitWindowSeconds,
} from './limits.ts'
import {
	getPlatformFeedbackByIdForAdmin,
	getPlatformFeedbackByIdForSubmitter,
	getPlatformFeedbackSubmissionLimitCounts,
	insertPlatformFeedback,
	listPlatformFeedbackPageRowsForAdmin,
	listPlatformFeedbackPageRowsForSubmitter,
	listPlatformFeedbackRowsForAdmin,
	listPlatformFeedbackRowsForSubmitter,
	updatePlatformFeedbackStatusForAdmin,
} from './repo.ts'
import {
	normalizePlatformFeedbackResolutionNote,
	normalizePlatformFeedbackResolutionPrUrls,
	serializePlatformFeedbackResolutionPrUrls,
} from './resolution.ts'
import {
	type PlatformFeedbackAction,
	type PlatformFeedbackAdminUpdate,
	type PlatformFeedbackCategory,
	type PlatformFeedbackOutcomeStatus,
	type PlatformFeedbackRecord,
	type PlatformFeedbackRecordWithRevision,
	type PlatformFeedbackRow,
	type PlatformFeedbackStatus,
	type PlatformFeedbackSubmitterListItem,
	type PlatformFeedbackSubmitterRecord,
	platformFeedbackOutcomeStatuses,
} from './types.ts'

export {
	platformFeedbackActiveQueueLimit,
	platformFeedbackSubmissionRateLimit,
} from './limits.ts'

const maxSummaryLength = 200
const maxDetailsLength = 8_000
const maxAdminNoteLength = 2_000
const defaultPageSize = 20
const maxPageSize = 100
const submissionInsertAttempts = 2

function isOutcomeAction(
	action: PlatformFeedbackAction,
): action is Exclude<PlatformFeedbackAction, 'triage'> {
	return action === 'resolve' || action === 'dismiss'
}

function isOutcomeStatus(
	status: PlatformFeedbackStatus,
): status is PlatformFeedbackOutcomeStatus {
	return (platformFeedbackOutcomeStatuses as ReadonlyArray<string>).includes(
		status,
	)
}

export type PlatformFeedbackSubmissionQuota = {
	limit: number
	remaining: number
	/** ISO timestamp when the next rolling-window slot frees; null when remaining > 0. */
	nextSlotAt: string | null
}

function getRollingWindowStart(now: string) {
	return new Date(
		new Date(now).getTime() - platformFeedbackSubmissionRateLimitWindowMs,
	).toISOString()
}

/**
 * Shared rolling-window quota math for submit enforcement and list reads so
 * remaining / next-slot cannot drift from the rate-limit error path.
 */
export function buildPlatformFeedbackSubmissionQuota(
	counts: { rollingCount: number; oldestCreatedAt: string | null },
	now: string,
): PlatformFeedbackSubmissionQuota {
	const remaining = Math.max(
		0,
		platformFeedbackSubmissionRateLimit - counts.rollingCount,
	)
	if (remaining > 0) {
		return {
			limit: platformFeedbackSubmissionRateLimit,
			remaining,
			nextSlotAt: null,
		}
	}
	const oldestCreatedAtMs = Date.parse(counts.oldestCreatedAt ?? '')
	const nowMs = Date.parse(now)
	const nextSlotAtMs =
		Number.isFinite(oldestCreatedAtMs) && Number.isFinite(nowMs)
			? oldestCreatedAtMs + platformFeedbackSubmissionRateLimitWindowMs
			: nowMs + platformFeedbackSubmissionRateLimitWindowMs
	return {
		limit: platformFeedbackSubmissionRateLimit,
		remaining: 0,
		nextSlotAt: new Date(nextSlotAtMs).toISOString(),
	}
}

function getSubmissionRateLimitRetryAfterSeconds(
	oldestCreatedAt: string | null,
	now: string,
) {
	const quota = buildPlatformFeedbackSubmissionQuota(
		{ rollingCount: platformFeedbackSubmissionRateLimit, oldestCreatedAt },
		now,
	)
	const nextSlotAtMs = Date.parse(quota.nextSlotAt ?? '')
	const nowMs = Date.parse(now)
	if (!Number.isFinite(nextSlotAtMs) || !Number.isFinite(nowMs)) {
		return platformFeedbackSubmissionRateLimitWindowSeconds
	}
	return Math.min(
		platformFeedbackSubmissionRateLimitWindowSeconds,
		Math.max(1, Math.ceil((nextSlotAtMs - nowMs) / 1_000)),
	)
}

export async function getPlatformFeedbackSubmissionQuota(input: {
	db: D1Database
	submitterUserId: string
	now?: string
}): Promise<PlatformFeedbackSubmissionQuota> {
	const now = input.now ?? new Date().toISOString()
	const counts = await getPlatformFeedbackSubmissionLimitCounts(input.db, {
		submitterUserId: input.submitterUserId,
		rollingWindowStart: getRollingWindowStart(now),
	})
	return buildPlatformFeedbackSubmissionQuota(counts, now)
}

function toPlatformFeedbackRecord({
	revision: _revision,
	...record
}: PlatformFeedbackRecordWithRevision): PlatformFeedbackRecord {
	return record
}

function normalizeRequiredText(
	value: string,
	input: { field: string; maxLength: number },
) {
	const normalized = value.trim()
	if (normalized.length < 1 || normalized.length > input.maxLength) {
		throw new Error(
			`${input.field} must contain between 1 and ${input.maxLength} characters.`,
		)
	}
	return normalized
}

function normalizeAdminNote(
	adminNote: string | undefined,
): string | null | undefined {
	if (adminNote === undefined) return undefined
	const normalized = adminNote.trim()
	if (normalized.length > maxAdminNoteLength) {
		throw new Error(
			`admin_note must contain at most ${maxAdminNoteLength} characters.`,
		)
	}
	return normalized.length > 0 ? normalized : null
}

function normalizePage(value: number | undefined) {
	if (value === undefined || !Number.isFinite(value)) return 1
	return Math.max(1, Math.trunc(value))
}

function normalizePageSize(value: number | undefined) {
	if (value === undefined || !Number.isFinite(value)) return defaultPageSize
	return Math.min(maxPageSize, Math.max(1, Math.trunc(value)))
}

function invalidTransition(input: {
	feedbackId: string
	status: PlatformFeedbackStatus
	action: PlatformFeedbackAction
}): never {
	throw new PlatformFeedbackInvalidTransitionError(input)
}

function planTransition(input: {
	feedbackId: string
	status: PlatformFeedbackStatus
	action: PlatformFeedbackAction
}): PlatformFeedbackStatus | null {
	switch (input.action) {
		case 'triage': {
			switch (input.status) {
				case 'open':
					return 'triaged'
				case 'triaged':
					return null
				case 'resolved':
					return invalidTransition(input)
				case 'dismissed':
					return invalidTransition(input)
				default: {
					const exhaustive: never = input.status
					throw new Error(`Unsupported platform feedback status: ${exhaustive}`)
				}
			}
		}
		case 'resolve': {
			switch (input.status) {
				case 'open':
				case 'triaged':
					return 'resolved'
				case 'resolved':
					return null
				case 'dismissed':
					return invalidTransition(input)
				default: {
					const exhaustive: never = input.status
					throw new Error(`Unsupported platform feedback status: ${exhaustive}`)
				}
			}
		}
		case 'dismiss': {
			switch (input.status) {
				case 'open':
				case 'triaged':
					return 'dismissed'
				case 'dismissed':
					return null
				case 'resolved':
					return invalidTransition(input)
				default: {
					const exhaustive: never = input.status
					throw new Error(`Unsupported platform feedback status: ${exhaustive}`)
				}
			}
		}
		default: {
			const exhaustive: never = input.action
			throw new Error(`Unsupported platform feedback action: ${exhaustive}`)
		}
	}
}

export async function submitPlatformFeedback(input: {
	db: D1Database
	submitterUserId: string
	submitterUsername: string
	submitterEmail: string
	category: PlatformFeedbackCategory
	summary: string
	details: string
}): Promise<PlatformFeedbackRecord> {
	const submitterUserId = normalizeRequiredText(input.submitterUserId, {
		field: 'submitterUserId',
		maxLength: 1_000,
	})
	const summary = normalizeRequiredText(input.summary, {
		field: 'summary',
		maxLength: maxSummaryLength,
	})
	const details = normalizeRequiredText(input.details, {
		field: 'details',
		maxLength: maxDetailsLength,
	})
	const now = new Date().toISOString()
	const feedbackId = crypto.randomUUID()
	const row: PlatformFeedbackRow = {
		id: feedbackId,
		submitter_user_id: submitterUserId,
		submitter_username: input.submitterUsername,
		submitter_email: input.submitterEmail,
		category: input.category,
		summary,
		details,
		status: 'open',
		reviewed_by_user_id: null,
		reviewed_at: null,
		admin_note: null,
		resolution_note: null,
		resolution_pr_urls: null,
		created_at: now,
		updated_at: now,
	}
	const rollingWindowStart = getRollingWindowStart(now)
	for (let attempt = 0; attempt < submissionInsertAttempts; attempt += 1) {
		const didInsert = await insertPlatformFeedback(input.db, row, {
			activeQueueLimit: platformFeedbackActiveQueueLimit,
			rollingWindowStart,
			submissionRateLimit: platformFeedbackSubmissionRateLimit,
		})
		if (didInsert) {
			break
		}
		const limitCounts = await getPlatformFeedbackSubmissionLimitCounts(
			input.db,
			{
				submitterUserId,
				rollingWindowStart,
			},
		)
		if (limitCounts.rollingCount >= platformFeedbackSubmissionRateLimit) {
			throw new PlatformFeedbackSubmissionRateLimitError(
				platformFeedbackSubmissionRateLimit,
				getSubmissionRateLimitRetryAfterSeconds(
					limitCounts.oldestCreatedAt,
					now,
				),
			)
		}
		if (limitCounts.activeCount >= platformFeedbackActiveQueueLimit) {
			throw new PlatformFeedbackActiveQueueLimitError(
				platformFeedbackActiveQueueLimit,
			)
		}
		if (attempt === submissionInsertAttempts - 1) {
			throw new PlatformFeedbackSubmissionConflictError()
		}
	}
	return {
		id: row.id,
		submitterUserId: row.submitter_user_id,
		submitterUsername: row.submitter_username,
		submitterEmail: row.submitter_email,
		category: row.category,
		summary: row.summary,
		details: row.details,
		status: row.status,
		reviewedByUserId: row.reviewed_by_user_id,
		reviewedAt: row.reviewed_at,
		adminNote: row.admin_note,
		resolutionNote: row.resolution_note,
		resolutionPrUrls: [],
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

export async function listPlatformFeedbackForAdmin(input: {
	db: D1Database
	page?: number
	pageSize?: number
	status?: PlatformFeedbackStatus
	category?: PlatformFeedbackCategory
}) {
	let page = normalizePage(input.page)
	const pageSize = normalizePageSize(input.pageSize)
	const query = {
		page,
		pageSize,
		status: input.status,
		category: input.category,
	}
	const result = await listPlatformFeedbackRowsForAdmin(input.db, query)
	const lastPage = Math.ceil(result.total / pageSize)
	if (result.total > 0 && page > lastPage) {
		page = lastPage
		result.items = await listPlatformFeedbackPageRowsForAdmin(input.db, {
			...query,
			page,
		})
	}
	return { ...result, page, pageSize }
}

export async function getPlatformFeedbackForAdmin(input: {
	db: D1Database
	feedbackId: string
}) {
	const feedback = await getPlatformFeedbackByIdForAdmin(
		input.db,
		input.feedbackId,
	)
	return feedback ? toPlatformFeedbackRecord(feedback) : null
}

export async function getPlatformFeedbackForSubmitter(input: {
	db: D1Database
	feedbackId: string
	submitterUserId: string
}): Promise<PlatformFeedbackSubmitterRecord | null> {
	return getPlatformFeedbackByIdForSubmitter(input.db, {
		feedbackId: input.feedbackId,
		submitterUserId: input.submitterUserId,
	})
}

export async function listPlatformFeedbackForSubmitter(input: {
	db: D1Database
	submitterUserId: string
	page?: number
	pageSize?: number
	status?: PlatformFeedbackStatus
	now?: string
}): Promise<{
	total: number
	page: number
	pageSize: number
	items: Array<PlatformFeedbackSubmitterListItem>
	submissionQuota: PlatformFeedbackSubmissionQuota
}> {
	let page = normalizePage(input.page)
	const pageSize = normalizePageSize(input.pageSize)
	const query = {
		submitterUserId: input.submitterUserId,
		page,
		pageSize,
		status: input.status,
	}
	const [result, submissionQuota] = await Promise.all([
		listPlatformFeedbackRowsForSubmitter(input.db, query),
		getPlatformFeedbackSubmissionQuota({
			db: input.db,
			submitterUserId: input.submitterUserId,
			now: input.now,
		}),
	])
	const lastPage = Math.ceil(result.total / pageSize)
	if (result.total > 0 && page > lastPage) {
		page = lastPage
		result.items = await listPlatformFeedbackPageRowsForSubmitter(input.db, {
			...query,
			page,
		})
	}
	return { ...result, page, pageSize, submissionQuota }
}

export async function updatePlatformFeedbackForAdmin(input: {
	db: D1Database
	feedbackId: string
	reviewerUserId: string
	action: PlatformFeedbackAction
	adminNote?: string
	/**
	 * Submitter-visible outcome note. Stored as `resolution_note` when this
	 * update transitions into resolved/dismissed (same text mailed as
	 * `user_message`). Ignored for triage and no-op terminal updates.
	 */
	resolutionNote?: string
	/**
	 * Optional https PR URLs stored as `resolution_pr_urls` on the same
	 * outcome transition. Ignored for triage and no-op terminal updates.
	 */
	resolutionPrUrls?: Array<string>
}): Promise<PlatformFeedbackAdminUpdate> {
	const reviewerUserId = normalizeRequiredText(input.reviewerUserId, {
		field: 'reviewerUserId',
		maxLength: 1_000,
	})
	const adminNote = normalizeAdminNote(input.adminNote)
	const resolutionNote = normalizePlatformFeedbackResolutionNote(
		input.resolutionNote,
	)
	const resolutionPrUrls = normalizePlatformFeedbackResolutionPrUrls(
		input.resolutionPrUrls,
	)
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const existing = await getPlatformFeedbackByIdForAdmin(
			input.db,
			input.feedbackId,
		)
		if (!existing) {
			throw new PlatformFeedbackNotFoundError(input.feedbackId)
		}
		const nextStatus = planTransition({
			feedbackId: input.feedbackId,
			status: existing.status,
			action: input.action,
		})
		const adminNoteChanged =
			adminNote !== undefined && adminNote !== existing.adminNote
		const storeOutcomeFields =
			nextStatus !== null &&
			isOutcomeAction(input.action) &&
			isOutcomeStatus(nextStatus)
		const nextResolutionNote = storeOutcomeFields
			? (resolutionNote ?? null)
			: undefined
		const nextResolutionPrUrlsJson = storeOutcomeFields
			? serializePlatformFeedbackResolutionPrUrls(resolutionPrUrls ?? null)
			: undefined
		if (nextStatus === null && !adminNoteChanged && !storeOutcomeFields) {
			return {
				feedback: toPlatformFeedbackRecord(existing),
				previousStatus: existing.status,
				didChangeStatus: false,
			}
		}
		const reviewedAt = new Date().toISOString()
		const updated = await updatePlatformFeedbackStatusForAdmin(input.db, {
			feedbackId: input.feedbackId,
			expectedStatus: existing.status,
			expectedRevision: existing.revision,
			status: nextStatus ?? existing.status,
			reviewedByUserId: reviewerUserId,
			reviewedAt,
			adminNote,
			resolutionNote: nextResolutionNote,
			resolutionPrUrlsJson: nextResolutionPrUrlsJson,
		})
		if (!updated) continue
		const feedback = await getPlatformFeedbackByIdForAdmin(
			input.db,
			input.feedbackId,
		)
		if (!feedback) {
			throw new PlatformFeedbackNotFoundError(input.feedbackId)
		}
		return {
			feedback: toPlatformFeedbackRecord(feedback),
			previousStatus: existing.status,
			didChangeStatus: nextStatus !== null,
		}
	}
	throw new PlatformFeedbackConcurrentUpdateError(input.feedbackId)
}
