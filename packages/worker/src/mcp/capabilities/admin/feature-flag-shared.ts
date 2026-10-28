import { z } from 'zod'
import {
	featureFlagKeys,
	isFeatureFlagKey,
	type FeatureFlagKey,
} from '#universal/feature-flags/registry.ts'
import { usageEventTypes } from '#universal/usage-event-types.ts'
import { parsePersonId } from '@kody-internal/shared/owner-person-ids.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { stableUserIdSchema } from './admin-shared.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export const adminFeatureFlagOverrideSchema = z.object({
	stableUserId: stableUserIdSchema,
	username: z.string(),
	enabled: z.boolean(),
	updatedAt: z.string(),
})

export const adminFeatureFlagOrgOverrideSchema = z.object({
	orgId: z.string(),
	slug: z.string(),
	displayName: z.string().nullable(),
	personal: z.boolean(),
	enabled: z.boolean(),
	note: z.string(),
	updatedByStableUserId: stableUserIdSchema.nullable(),
	updatedAt: z.string(),
})

export const featureFlagSuccessMetricSchema = z.object({
	eventType: z.enum(usageEventTypes),
	measure: z.enum(['event_count', 'error_rate', 'avg_duration_ms']),
	goal: z.enum(['increase', 'decrease']),
	hypothesis: z.string(),
})

const featureFlagMetricCohortSchema = z.object({
	users: z.number().int().min(0),
	eventCount: z.number().int().min(0),
	errorCount: z.number().int().min(0),
	errorRate: z.number().nullable(),
	avgDurationMs: z.number().nullable(),
})

export const adminFeatureFlagMetricReadoutSchema = z.discriminatedUnion(
	'status',
	[
		z.object({
			status: z.literal('unavailable'),
			reason: z.string(),
		}),
		z.object({
			status: z.literal('ok'),
			windowStart: z.string(),
			windowEnd: z.string(),
			on: featureFlagMetricCohortSchema,
			off: featureFlagMetricCohortSchema,
			override: featureFlagMetricCohortSchema,
			overrideUsers: z.number().int().min(0),
			orgOverride: featureFlagMetricCohortSchema,
			orgOverrideUsers: z.number().int().min(0),
			mixedUsers: z.number().int().min(0),
		}),
	],
)

export const adminFeatureFlagSchema = z.object({
	key: z.string(),
	description: z.string().nullable(),
	defaultEnabled: z.boolean().nullable(),
	defaultAudience: z.enum(['everyone', 'experiments_opt_in']).nullable(),
	stale: z.boolean(),
	successMetric: featureFlagSuccessMetricSchema.nullable(),
	metricReadout: adminFeatureFlagMetricReadoutSchema.optional(),
	global: z
		.object({
			enabled: z.boolean(),
			rolloutPercent: z.number().int().min(0).max(100).nullable(),
			audience: z.enum(['everyone', 'experiments_opt_in']),
			note: z.string(),
			updatedByStableUserId: stableUserIdSchema.nullable(),
			updatedAt: z.string(),
		})
		.nullable(),
	overrides: z.array(adminFeatureFlagOverrideSchema),
	orgOverrides: z.array(adminFeatureFlagOrgOverrideSchema),
})

export function assertFeatureFlagKey(key: string): FeatureFlagKey {
	if (!isFeatureFlagKey(key)) {
		throw new Error(
			`Unknown feature flag key "${key}". Valid keys: ${featureFlagKeys.join(', ')}.`,
		)
	}
	return key
}

export async function resolveTargetUser(
	db: D1Database,
	input: { stableUserId?: string; username?: string },
): Promise<{ dbUserId: number; stableUserId: string }> {
	if (input.stableUserId !== undefined && input.username !== undefined) {
		throw new McpCallerError(
			'Provide either stableUserId or username, not both.',
		)
	}
	if (input.stableUserId !== undefined) {
		const stableUserId = parsePersonId(input.stableUserId)
		if (!stableUserId) {
			throw new McpCallerError('stableUserId must be a valid stable user id.')
		}
		const row = await db
			.prepare(
				`SELECT id, stable_user_id FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(stableUserId)
			.first<{ id: number; stable_user_id: string }>()
		if (!row) {
			throw new McpCallerError(
				`User not found for stableUserId ${stableUserId}.`,
			)
		}
		return { dbUserId: row.id, stableUserId: row.stable_user_id }
	}
	if (input.username !== undefined) {
		const username = input.username.trim().toLowerCase()
		if (!username) {
			throw new McpCallerError('username must not be empty.')
		}
		const row = await db
			.prepare(
				`SELECT id, stable_user_id FROM users WHERE username = ?${andLiveDeletedAtSql()}`,
			)
			.bind(username)
			.first<{ id: number; stable_user_id: string }>()
		if (!row) {
			throw new McpCallerError(`User not found for username "${username}".`)
		}
		return { dbUserId: row.id, stableUserId: row.stable_user_id }
	}
	throw new McpCallerError('Provide either stableUserId or username.')
}

export async function resolveTargetOrg(
	db: D1Database,
	input: { orgId?: string; orgSlug?: string },
): Promise<{ orgId: string; slug: string }> {
	if (input.orgId !== undefined && input.orgSlug !== undefined) {
		throw new McpCallerError('Provide either orgId or orgSlug, not both.')
	}
	if (input.orgId === undefined && input.orgSlug === undefined) {
		throw new McpCallerError('Provide either orgId or orgSlug.')
	}
	const byId = input.orgId !== undefined
	const value = byId
		? (input.orgId ?? '').trim()
		: (input.orgSlug ?? '').trim().replace(/^@/, '').toLowerCase()
	if (!value) {
		throw new McpCallerError(
			byId ? 'orgId must not be empty.' : 'orgSlug must not be empty.',
		)
	}
	const row = await db
		.prepare(
			`SELECT id, slug FROM orgs WHERE ${byId ? 'id' : 'slug'} = ?${andLiveDeletedAtSql()}`,
		)
		.bind(value)
		.first<{ id: string; slug: string }>()
	if (!row) {
		throw new McpCallerError(
			byId
				? `Organization not found for orgId ${value}.`
				: `Organization not found for orgSlug "${value}".`,
		)
	}
	return { orgId: row.id, slug: row.slug }
}
