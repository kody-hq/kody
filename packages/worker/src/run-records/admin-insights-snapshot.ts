/**
 * Content-free per-user RunLog point-read for post-D1 admin insights.
 *
 * Aggregators may sum workflow statuses, job outcome counts, and activation
 * funnel/latency across users. Never includes workflow/package/job names,
 * errors, logs, or other user-authored content.
 */

import type { ActivationMilestone } from './package-activation-state.ts'

export type RunLogAdminInsightsWorkflowStatusCount = {
	/** Projection `status`, or `'unknown'` when null/blank. */
	status: string
	count: number
}

export type RunLogAdminInsightsActivationMilestone = {
	milestone: ActivationMilestone
	reachedAt: string
	/** Opaque package id for aggregate joins only — never a display name. */
	packageId: string | null
}

export type RunLogAdminInsightsSnapshot = {
	workflowStatusCounts: Array<RunLogAdminInsightsWorkflowStatusCount>
	activationMilestones: Array<RunLogAdminInsightsActivationMilestone>
	jobRunCounts: {
		success: number
		error: number
	}
}
