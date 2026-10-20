import { z } from 'zod'

const storageMatchSchema = z.object({
	path: z.string(),
	line: z.number().int().positive(),
	column: z.number().int().positive(),
	pattern: z.enum([
		'packageStorage',
		'storageQuery',
		'storageExport',
		'kodyBracket',
		'bracketKey',
	]),
	snippet: z.string(),
})

const manifestFieldSchema = z.enum([
	'secretMounts',
	'secretProvider',
	'subscriptions',
	'emits',
	'jobs',
	'retrievers',
	'webhooks',
])

export const selfPublishBlockerReasonSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('unpublished'),
		sourceId: z.string(),
	}),
	z.object({
		kind: z.literal('stale_dependencies'),
		sourceId: z.string(),
		pinnedCommit: z.string(),
		livePublishedCommit: z.string().nullable(),
	}),
	z.object({
		kind: z.literal('credential_entry'),
		credentialId: z.string().optional(),
		name: z.string().optional(),
		via: z.array(z.string()),
	}),
	z.object({
		kind: z.literal('storage_entry'),
		storageId: z.string(),
		via: z.array(z.string()),
		assumed: z.literal(true).optional(),
		matches: z.array(storageMatchSchema).optional(),
	}),
	z.object({
		kind: z.literal('manifest_field'),
		field: manifestFieldSchema,
		sourceId: z.string(),
	}),
	z.object({
		kind: z.literal('credential_needs'),
		sourceId: z.string(),
		needCount: z.number().int().nonnegative(),
	}),
	z.object({ kind: z.literal('not_audited') }),
	z.object({ kind: z.literal('audit_concerns') }),
	z.object({ kind: z.literal('not_permitted') }),
])

export const selfPublishBlockerSchema = z.enum([
	'unpublished',
	'stale_dependencies',
	'declares_credentials',
	'declares_capabilities',
	'not_audited',
	'audit_concerns',
	'not_permitted',
])

export const selfPublishBlockerDetailOutputSchema = z.object({
	self_publish_blocker: selfPublishBlockerSchema,
	self_publish_blocker_reasons: z.array(selfPublishBlockerReasonSchema),
	self_publish_blocker_message: z.string(),
})
