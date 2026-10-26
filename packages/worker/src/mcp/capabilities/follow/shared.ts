import { z } from 'zod'
import {
	followEvents,
	followPauseReasons,
	followStatuses,
	followTargetKinds,
} from '#worker/follow/types.ts'

export const followEventsSchema = z
	.array(z.enum(followEvents))
	.min(1)
	.describe(
		'Events to deliver: published (follow.published, packages only) and/or pushed (follow.pushed, needs read access).',
	)

export const followViewSchema = z.object({
	name: z.string().describe('Target @handle/name.'),
	kind: z.enum(followTargetKinds),
	status: z.enum(followStatuses),
	events: z
		.array(z.enum(followEvents))
		.describe('Events this follow delivers: published and/or pushed.'),
	created_at: z.string(),
	paused_at: z.string().nullable(),
	paused_reason: z
		.enum(followPauseReasons)
		.nullable()
		.describe(
			'Why a paused follow paused: target_missing or access_lost. Null when active.',
		),
	last_delivery_skip_reason: z
		.string()
		.nullable()
		.describe(
			'Set when a delivery was skipped before the handler ran, for example zero_credits.',
		),
})

export const followRecentUpdateSchema = z.object({
	name: z.string().describe('Target @handle/name.'),
	kind: z.enum(followTargetKinds),
	event: z.enum(followEvents),
	occurred_at: z.string(),
	summary: z
		.string()
		.describe(
			'For example "Published version abc1234" or "3 commits pushed to main: Fix typo".',
		),
})
