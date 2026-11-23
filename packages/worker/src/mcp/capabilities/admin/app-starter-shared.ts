import { z } from 'zod'
import { maxAppStarterNoteLength } from '#worker/app-starters/service.ts'

const fieldErrorSchema = z.object({ field: z.string(), message: z.string() })

export const appStarterEntrySchema = z.object({
	packageId: z.string(),
	packageName: z.string(),
	rank: z.number().int(),
	enabled: z.boolean(),
	note: z.string().nullable(),
	updatedAt: z.string(),
	listingId: z.string().nullable(),
	checks: z.array(
		z.object({
			id: z.string(),
			label: z.string(),
			ok: z.boolean(),
			detail: z.string(),
		}),
	),
	starter: z
		.object({
			name: z.string(),
			description: z.string(),
			whenToUse: z.string(),
			tags: z.array(z.string()),
			preview: z.string(),
			capabilities: z.array(z.string()),
			customize: z.object({
				themeTokens: z.string(),
				routes: z.string(),
				content: z.string(),
			}),
		})
		.nullable(),
	problems: z.array(fieldErrorSchema),
})

export const appStartersOutputSchema = z.object({
	starters: z.array(appStarterEntrySchema),
})

export const appStarterNoteSchema = z
	.string()
	.max(maxAppStarterNoteLength)
	.nullable()
	.optional()
	.describe('Optional admin note shown on the starters page.')

export const appStarterRankSchema = z
	.number()
	.int()
	.min(1)
	.optional()
	.describe('1 is recommended first. Other starters shift to make room.')
