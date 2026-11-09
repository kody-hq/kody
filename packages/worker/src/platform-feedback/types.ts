import { statesOf } from '@kody-internal/shared/state-machine.ts'
import {
	platformFeedbackState,
	type PlatformFeedbackStatus,
} from './platform-feedback-state.ts'

export const platformFeedbackCategories = [
	'friction',
	'bug',
	'experience',
	'suggestion',
	'cancellation',
	'other',
] as const

export type PlatformFeedbackCategory =
	(typeof platformFeedbackCategories)[number]

export const platformFeedbackStatuses = statesOf(platformFeedbackState)

export type { PlatformFeedbackStatus } from './platform-feedback-state.ts'

export const platformFeedbackOutcomeStatuses = [
	'resolved',
	'dismissed',
] as const

export type PlatformFeedbackOutcomeStatus =
	(typeof platformFeedbackOutcomeStatuses)[number]

export const platformFeedbackActions = ['triage', 'resolve', 'dismiss'] as const

export type PlatformFeedbackAction = (typeof platformFeedbackActions)[number]

/**
 * Admin update actions: status transitions plus `follow_up`, which stores a
 * new submitter-visible note on resolved/dismissed feedback and emails it.
 */
export const platformFeedbackAdminActions = [
	...platformFeedbackActions,
	'follow_up',
] as const

export type PlatformFeedbackAdminAction =
	(typeof platformFeedbackAdminActions)[number]

/** One superseded submitter-visible outcome (note + PR URLs). */
export type PlatformFeedbackResolutionHistoryEntry = {
	note: string | null
	prUrls: Array<string>
	recordedAt: string
}

/**
 * One admin reopen of closed feedback back to triaged. Internal only: never
 * mailed and never returned to submitters.
 */
export type PlatformFeedbackReopenHistoryEntry = {
	fromStatus: PlatformFeedbackOutcomeStatus
	toStatus: 'triaged'
	/** Required internal reason for the reopen (same text stored as admin_note). */
	note: string
	/** Authenticated admin who reopened it (server-resolved, never caller-supplied). */
	actorUserId: string
	/** Server timestamp of the reopen. */
	recordedAt: string
}

export type PlatformFeedbackRow = {
	id: string
	submitter_user_id: string
	submitter_username: string
	submitter_email: string
	category: PlatformFeedbackCategory
	summary: string
	details: string
	status: PlatformFeedbackStatus
	reviewed_by_user_id: string | null
	reviewed_at: string | null
	admin_note: string | null
	resolution_note: string | null
	resolution_pr_urls: string | null
	resolution_history?: string | null
	reopen_history?: string | null
	created_at: string
	updated_at: string
}

export type PlatformFeedbackRecord = {
	id: string
	submitterUserId: string
	submitterUsername: string
	submitterEmail: string
	category: PlatformFeedbackCategory
	summary: string
	details: string
	status: PlatformFeedbackStatus
	reviewedByUserId: string | null
	reviewedAt: string | null
	adminNote: string | null
	/** Submitter-visible outcome note; never conflated with adminNote. */
	resolutionNote: string | null
	/** Submitter-visible https PR URLs from the outcome; empty when none. */
	resolutionPrUrls: Array<string>
	/** Earlier outcome notes replaced by follow-ups, oldest first. */
	resolutionHistory: Array<PlatformFeedbackResolutionHistoryEntry>
	/** Internal-only admin reopens (resolved/dismissed to triaged), oldest first. */
	reopenHistory: Array<PlatformFeedbackReopenHistoryEntry>
	createdAt: string
	updatedAt: string
}

export type PlatformFeedbackAdminUpdate = {
	feedback: PlatformFeedbackRecord
	previousStatus: PlatformFeedbackStatus
	didChangeStatus: boolean
}

/** Internal full-record shape used for optimistic admin updates. */
export type PlatformFeedbackRecordWithRevision = PlatformFeedbackRecord & {
	revision: number
}

export type PlatformFeedbackListItem = Omit<
	PlatformFeedbackRecord,
	| 'details'
	| 'adminNote'
	| 'resolutionNote'
	| 'resolutionPrUrls'
	| 'resolutionHistory'
	| 'reopenHistory'
	| 'submitterUsername'
	| 'submitterEmail'
>

/**
 * Submitter-facing feedback fields. Matches the account-export columns that
 * survive reviewer redaction (`reviewed_by_user_id`, `reviewed_at`,
 * `admin_note`), minus the submitter's own identity columns. Includes
 * submitter-visible resolution fields when present.
 */
export type PlatformFeedbackSubmitterListItem = {
	id: string
	category: PlatformFeedbackCategory
	summary: string
	status: PlatformFeedbackStatus
	resolutionNote: string | null
	resolutionPrUrls: Array<string>
	createdAt: string
	updatedAt: string
}

export type PlatformFeedbackSubmitterRecord =
	PlatformFeedbackSubmitterListItem & {
		details: string
	}
