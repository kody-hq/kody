import { z } from 'zod'
import {
	parseOwnerId,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	auditDatabaseFromEnv,
	logAuditEvent,
	redactEmailRecipient,
} from '#worker/audit-log.ts'
import {
	emailVerificationDeliveryClassValues,
	emailVerificationDeliveryStatusValues,
} from '#universal/email-verification-delivery.ts'
import { roleNames } from '#universal/permissions.ts'
import { planNames } from '#universal/plans.ts'
import { shouldDeferSiteAccessToActor } from '#mcp/capabilities/access-control.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export type ActingAdminPerson = {
	usersId: number
	stableUserId: string
	email: string
	username: string
}

/**
 * Site-admin tools: the `admin` role gates them, not org permissions. A job,
 * webhook, subscription, package run, or team-org `jobRunNow` may call them
 * when the person it acts for holds the role (see `triggered-site-access.ts`).
 */
export const adminCapabilityAccess = {
	orgPermission: 'none',
	requiredRole: 'admin',
	readOnly: true,
	idempotent: true,
	destructive: false,
} as const

export const adminMutationCapabilityAccess = {
	orgPermission: 'none',
	requiredRole: 'admin',
	readOnly: false,
	idempotent: false,
	destructive: false,
} as const

export const roleNameSchema = z.enum(roleNames)

export const planNameSchema = z.enum(planNames)

export function adminStableOwnerId(value: string): OwnerId {
	const ownerId = parseOwnerId(value)
	if (!ownerId) {
		throw new Error('stable_user_id is invalid.')
	}
	return ownerId
}

export const stableUserIdSchema = z
	.string()
	.regex(/^[a-f0-9]{64}$/)
	.describe('Stable users.stable_user_id.')

export const adminUserMetadataSchema = z.object({
	stableUserId: stableUserIdSchema,
	username: z.string(),
	email: z.string(),
	email_verified: z
		.boolean()
		.describe('True when email_verified_at is non-null.'),
	email_verified_at: z
		.string()
		.nullable()
		.describe('Raw users.email_verified_at timestamp, or null if unverified.'),
	plan: planNameSchema.describe(
		'Manual entitlement grant (orgs.plan on the personal org). The org admin Plan panel and adminOrgPlanSet write this column. Ordinary Stripe subscribers keep this as free.',
	),
	manualPlan: planNameSchema.describe(
		'Same as plan: the admin/manual grant on orgs.plan.',
	),
	stripePlan: planNameSchema
		.nullable()
		.describe(
			'Stripe-derived paid tier from orgs.stripe_plan, or null when none.',
		),
	effectivePlan: planNameSchema.describe(
		'Entitlement plan after manual grant, Stripe, and unexpired Pro overlays (second-agent gift / referral credit).',
	),
	secondAgentGiftExpiresAt: z
		.string()
		.nullable()
		.describe(
			'Raw orgs.second_agent_standard_gift_expires_at ISO timestamp, or null.',
		),
	referralCreditExpiresAt: z
		.string()
		.nullable()
		.describe(
			'Raw orgs.referral_standard_credit_expires_at ISO timestamp, or null.',
		),
	overlayExpiresAt: z
		.string()
		.nullable()
		.describe(
			'Later of the two overlay expiry columns (or null). Same value gating uses for the temporary Pro raise.',
		),
	isProOverlay: z
		.boolean()
		.describe(
			'True while a temporary Pro overlay currently raises Free. False for paid or manual plans even when expiry columns remain set.',
		),
	overlayType: z
		.enum(['second_agent_gift', 'referral_credit'])
		.nullable()
		.describe(
			'Which overlay classifies the current Pro raise. When both are active, the later expiry wins; equal timestamps prefer second_agent_gift. Null unless isProOverlay.',
		),
	entitlementLadder: z
		.enum(['public', 'legacy'])
		.describe(
			'Which Standard/Pro ceiling table applies. legacy keeps the pre-cut limits while paid access stays continuous; cancel then resubscribe is public.',
		),
	stripeCustomerLinked: z
		.boolean()
		.describe('True when orgs.stripe_customer_id is set.'),
	suspended_at: z
		.string()
		.nullable()
		.describe(
			'Set when the account is platform-suspended (blocks sessions, MCP, package apps, webhooks, jobs and other background work, and email).',
		),
	email_outbound_paused_at: z
		.string()
		.nullable()
		.describe(
			'Set when outbound email was automatically paused after spam complaints or repeated bounces.',
		),
	email_verification_delivery: z
		.object({
			status: z.enum(emailVerificationDeliveryStatusValues),
			class: z.enum(emailVerificationDeliveryClassValues).nullable(),
			at: z.string().nullable(),
		})
		.nullable()
		.describe(
			'Latest signup/verify mail delivery outcome. Null when no verification send has been tracked.',
		),
	email_verification_delivery_detail: z
		.string()
		.nullable()
		.describe(
			'Truncated provider SMTP response or failure detail for the latest verification send.',
		),
	utm_source: z
		.string()
		.nullable()
		.describe('First-touch utm_source at signup.'),
	utm_medium: z
		.string()
		.nullable()
		.describe('First-touch utm_medium at signup.'),
	utm_campaign: z
		.string()
		.nullable()
		.describe('First-touch utm_campaign at signup.'),
	utm_content: z
		.string()
		.nullable()
		.describe('First-touch utm_content at signup.'),
	utm_term: z.string().nullable().describe('First-touch utm_term at signup.'),
	first_touch_landing_path: z
		.string()
		.nullable()
		.describe('First-touch landing path at signup (pathname only).'),
	first_touch_referrer: z
		.string()
		.nullable()
		.describe('First-touch document referrer at signup.'),
	first_mcp_connected_at: z
		.string()
		.nullable()
		.describe('First successful MCP/agent connection timestamp.'),
	first_execute_at: z
		.string()
		.nullable()
		.describe('First successful execute usage timestamp.'),
	first_search_at: z
		.string()
		.nullable()
		.describe('First successful MCP search timestamp.'),
	first_saved_package_at: z
		.string()
		.nullable()
		.describe('First saved package timestamp.'),
	mcp_client_name: z
		.string()
		.nullable()
		.describe('First-seen MCP client/host name (e.g. claude-ai).'),
	last_active_at: z
		.string()
		.nullable()
		.describe(
			'Last activity day stamp (login, MCP, execute, package) for D2/D7 return.',
		),
	created_at: z.string(),
	updated_at: z.string(),
	roles: z.array(roleNameSchema),
})

function getErrorReason(error: unknown) {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message.slice(0, 240)
	}
	return 'unknown_error'
}

async function resolveAuditActorEmail(
	ctx: CapabilityContext,
): Promise<string | undefined> {
	const callerEmail = ctx.callerContext.user?.email?.trim()
	if (callerEmail) return callerEmail
	try {
		return (await resolveActingAdminPerson(ctx)).email
	} catch {
		return undefined
	}
}

export async function auditAdminCapabilityInvocation<TResult>(
	ctx: CapabilityContext,
	capabilityName: string,
	run: () => Promise<TResult>,
	options: {
		successReason?: (result: TResult) => string
		/** A resolved result that reports its own failure (default: success). */
		resultOf?: (result: TResult) => 'success' | 'failure'
		skipSuccessAudit?: (result: TResult) => boolean
	} = {},
): Promise<TResult> {
	const actorEmail = await resolveAuditActorEmail(ctx)
	try {
		const result = await run()
		if (!options.skipSuccessAudit?.(result)) {
			await logAuditEvent({
				db: auditDatabaseFromEnv(ctx.env),
				category: 'admin',
				action: capabilityName,
				result: options.resultOf?.(result) ?? 'success',
				email: actorEmail,
				path: '/mcp',
				reason: options.successReason?.(result) ?? 'mcp_admin_capability',
			})
		}
		return result
	} catch (error) {
		await logAuditEvent({
			db: auditDatabaseFromEnv(ctx.env),
			category: 'admin',
			action: capabilityName,
			result: 'failure',
			email: actorEmail,
			path: '/mcp',
			reason: getErrorReason(error),
		})
		throw error
	}
}

export function buildCreatedUserAuditReason(input: {
	stableUserId: string
	email: string
}) {
	return [
		`target_stable_user_id=${input.stableUserId}`,
		`target_email=${redactEmailRecipient(input.email)}`,
	].join(';')
}

/**
 * The person a site-admin capability acts as for attribution. When site-admin
 * access defers to `request.actor` (enablement-backed runs, or background
 * team-org `jobRunNow`), resolve that actor; otherwise the authenticated MCP
 * caller.
 */
export async function resolveActingAdminPerson(
	ctx: CapabilityContext,
): Promise<ActingAdminPerson> {
	const actor = ctx.callerContext.request?.actor
	const stableUserId =
		shouldDeferSiteAccessToActor(ctx.callerContext) && actor
			? String(actor.userId).trim()
			: requireMcpUser(ctx.callerContext).userId.trim()
	if (!stableUserId) {
		throw new Error('Authenticated admin account was not found.')
	}
	const row = await ctx.env.APP_DB.prepare(
		`SELECT id, email, username FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(stableUserId)
		.first<{ id: number; email: string; username: string }>()
	if (!row) {
		throw new Error('Authenticated admin account was not found.')
	}
	return {
		usersId: row.id,
		stableUserId,
		email: row.email,
		username: row.username,
	}
}

export async function resolveActingAdminUserId(
	ctx: CapabilityContext,
): Promise<number> {
	return (await resolveActingAdminPerson(ctx)).usersId
}
