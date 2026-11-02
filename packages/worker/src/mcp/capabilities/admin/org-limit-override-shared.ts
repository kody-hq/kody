import { z } from 'zod'
import {
	limitOverrideKeys,
	planNames,
	unlimitedLimit,
} from '#universal/plans.ts'
import { stableUserIdSchema } from './admin-shared.ts'

export const adminOrgTargetSchema = z
	.object({
		orgId: stableUserIdSchema
			.optional()
			.describe(
				'Org id (orgs.id). A personal org uses users.personal_org_id when set, otherwise users.stable_user_id — they are not always equal.',
			),
		org: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Org slug / handle, with or without "@" (for example "@kody").',
			),
	})
	.refine(
		(value) => (value.orgId === undefined) !== (value.org === undefined),
		{ message: 'Provide exactly one of orgId or org.' },
	)

export const limitOverrideKeySchema = z
	.enum(limitOverrideKeys)
	.describe(
		'Daily, weekly, or monthly cap. The monthly keys move only the stop-at-$0 threshold for an empty credit wallet; credit debits always use the plan include.',
	)

export const limitOverrideValueSchema = z.union([
	z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	z.literal('unlimited'),
])

const limitNumberSchema = z
	.number()
	.nullable()
	.describe(
		`Null when the plan has no such window (weekly on max / legacy). ${unlimitedLimit} means unlimited.`,
	)

export const adminOrgLimitsSchema = z.object({
	org: z.object({
		id: z.string(),
		slug: z.string(),
		displayName: z.string().nullable(),
	}),
	plan: z.enum(planNames),
	creditWallet: z.enum(['none', 'empty', 'funded']),
	seats: z.number().int(),
	limits: z.array(
		z.object({
			key: limitOverrideKeySchema,
			label: z.string(),
			planLimit: limitNumberSchema.describe(
				'Plan limit for this org (seat pool and credits ceiling included).',
			),
			effectiveLimit: limitNumberSchema.describe(
				'Enforced limit: the larger of the plan limit and an active override.',
			),
			override: z
				.object({
					value: limitOverrideValueSchema,
					expiresAt: z.string().nullable(),
					reason: z.string(),
					setByUserId: z.string(),
					createdAt: z.string(),
					updatedAt: z.string(),
					active: z.boolean().describe('False once expiresAt has passed.'),
				})
				.nullable(),
		}),
	),
})
