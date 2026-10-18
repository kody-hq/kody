import {
	PlatformFeedbackActiveQueueLimitError,
	PlatformFeedbackConcurrentUpdateError,
	PlatformFeedbackInvalidTransitionError,
	PlatformFeedbackNotFoundError,
	PlatformFeedbackSubmissionConflictError,
	PlatformFeedbackSubmissionRateLimitError,
} from './errors.ts'
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
	type PlatformFeedbackAction,
	type PlatformFeedbackAdminUpdate,
	type PlatformFeedbackCategory,
	type PlatformFeedbackRecord,
	type PlatformFeedbackRecordWithRevision,
	type PlatformFeedbackRow,
	type PlatformFeedbackStatus,
	type PlatformFeedbackSubmitterListItem,
	type PlatformFeedbackSubmitterRecord,
} from './types.ts'

const maxSummaryLength = 200
const maxDetailsLength = 8_000
const maxAdminNoteLength = 2_000
const defaultPageSize = 20
const maxPageSize = 100
const activeQueueLimit = 100
const submissionRateLimit = 10
const submissionRateLimitWindowSeconds = 24 * 60 * 60
const submissionRateLimitWindowMs = submissionRateLimitWindowSeconds * 1_000
const submissionInsertAttempts = 2

function getSubmissionRateLimitRetryAfterSeconds(
	oldestCreatedAt: string | null,
	now: string,
) {
	const oldestCreatedAtMs = Date.parse(oldestCreatedAt ?? '')
	const nowMs = Date.parse(now)
	if (!Number.isFinite(oldestCreatedAtMs) || !Number.isFinite(nowMs)) {
		return submissionRateLimitWindowSeconds
	}
	return Math.min(
		submissionRateLimitWindowSeconds,
		Math.max(
			1,
			Math.ceil(
				(oldestCreatedAtMs + submissionRateLimitWindowMs - nowMs) / 1_000,
			),
		),
	)
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
		created_at: now,
		updated_at: now,
	}
	const rollingWindowStart = new Date(
		new Date(now).getTime() - submissionRateLimitWindowMs,
	).toISOString()
	for (let attempt = 0; attempt < submissionInsertAttempts; attempt += 1) {
		const didInsert = await insertPlatformFeedback(input.db, row, {
			activeQueueLimit,
			rollingWindowStart,
			submissionRateLimit,
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
		if (limitCounts.rollingCount >= submissionRateLimit) {
			throw new PlatformFeedbackSubmissionRateLimitError(
				submissionRateLimit,
				getSubmissionRateLimitRetryAfterSeconds(
					limitCounts.oldestCreatedAt,
					now,
				),
			)
		}
		if (limitCounts.activeCount >= activeQueueLimit) {
			throw new PlatformFeedbackActiveQueueLimitError(activeQueueLimit)
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
}): Promise<{
	total: number
	page: number
	pageSize: number
	items: Array<PlatformFeedbackSubmitterListItem>
}> {
	let page = normalizePage(input.page)
	const pageSize = normalizePageSize(input.pageSize)
	const query = {
		submitterUserId: input.submitterUserId,
		page,
		pageSize,
		status: input.status,
	}
	const result = await listPlatformFeedbackRowsForSubmitter(input.db, query)
	const lastPage = Math.ceil(result.total / pageSize)
	if (result.total > 0 && page > lastPage) {
		page = lastPage
		result.items = await listPlatformFeedbackPageRowsForSubmitter(input.db, {
			...query,
			page,
		})
	}
	return { ...result, page, pageSize }
}

export async function updatePlatformFeedbackForAdmin(input: {
	db: D1Database
	feedbackId: string
	reviewerUserId: string
	action: PlatformFeedbackAction
	adminNote?: string
}): Promise<PlatformFeedbackAdminUpdate> {
	const reviewerUserId = normalizeRequiredText(input.reviewerUserId, {
		field: 'reviewerUserId',
		maxLength: 1_000,
	})
	const adminNote = normalizeAdminNote(input.adminNote)
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
		if (nextStatus === null && !adminNoteChanged) {
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
