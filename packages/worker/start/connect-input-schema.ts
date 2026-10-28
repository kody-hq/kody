import { z } from 'zod'
import { placementApprovalParts } from '#universal/credential-placement-approval.ts'

const locationFields = {
	orgSlug: z
		.string()
		.regex(/^[a-zA-Z0-9_-]+$/)
		.optional(),
	// Lossless navigation state only. Authorization and reads use the explicit fields.
	search: z.array(z.tuple([z.string(), z.string()])),
}
export const connectSecretsSchema = z.object({
	...locationFields,
	selectedSecretId: z.string().nullable(),
	approval: z.object({
		hosts: z.array(z.string()),
		names: z.array(z.string()),
		packageId: z.string().optional(),
		scope: z.enum(['user', 'session', 'package']),
		storagePackageId: z.string().optional(),
		sessionId: z.string().optional(),
	}),
	/** Owner-approval request to allow these fill placement parts. */
	placement: z.array(z.enum(placementApprovalParts)).default([]),
	/** Pins the placement request to exactly this credential. */
	placementCredentialId: z.string().min(1).max(200).optional(),
})
export const connectOauthSchema = z.object({
	...locationFields,
	provider: z.string().optional(),
	code: z.string().optional(),
	error: z.string().optional(),
	appSlug: z.string().optional(),
	platformSlug: z.string().optional(),
})
export const connectWebhookSchema = z.object({
	...locationFields,
	handle: z.string().nullable(),
	fingerprint: z.string().nullable(),
})
