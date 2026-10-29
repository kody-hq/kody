import { z } from 'zod'
import { loadAdminOrgDetail } from '#worker/admin/orgs-data.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import { adminOrgTargetSchema } from './org-limit-override-shared.ts'

export const adminOrgDetailSchema = z.object({
	org: z.object({
		id: z.string(),
		slug: z.string(),
		displayName: z.string().nullable(),
		kind: z.enum(['personal', 'team']),
		createdAt: z.string(),
		updatedAt: z.string(),
		suspendedAt: z.string().nullable(),
	}),
	softDelete: z
		.object({
			deletedAt: z.string().nullable(),
			deletingAt: z.string().nullable(),
			restoreDeadline: z.string().nullable(),
		})
		.nullable(),
	plan: z.object({
		manualPlan: z.enum(['free', 'standard', 'pro', 'max']),
		stripePlan: z.enum(['free', 'standard', 'pro', 'max']).nullable(),
		effectivePlan: z.enum(['free', 'standard', 'pro', 'max']),
		entitlementLadder: z.enum(['public', 'legacy']),
		stripeCustomerLinked: z.boolean(),
		adminCreditsEligible: z.boolean(),
		stripeCreditsEligible: z.boolean(),
		creditsEligible: z.boolean(),
	}),
	seats: z.object({ live: z.number().int(), billingOnly: z.number().int() }),
	members: z.array(
		z.object({
			stableUserId: z.string(),
			username: z.string(),
			role: z.enum(['owner', 'member', 'billing']),
			joinedAt: z.string(),
			membershipDeletedAt: z.string().nullable(),
			userDeletedAt: z.string().nullable(),
			individualBudgetMicroUsd: z.number().nullable(),
			effectiveBudgetMicroUsd: z.number().nullable(),
		}),
	),
	budgets: z.object({
		defaultUserBudgetMicroUsd: z.number().nullable(),
		automationBudgetMicroUsd: z.number().nullable(),
	}),
	wallet: z.object({
		plan: z.enum(['free', 'standard', 'pro', 'max']),
		eligible: z.boolean(),
		adminCreditsEligible: z.boolean(),
		unlocked: z.boolean(),
		balanceMicroUsd: z.number(),
		recent: z.array(
			z.object({
				kind: z.enum(['top_up', 'auto_refill', 'admin_grant', 'debit']),
				amountMicroUsd: z.number(),
				description: z.string(),
				createdAt: z.string(),
				grantedByUsername: z.string().nullable(),
				note: z.string().nullable(),
			}),
		),
	}),
	teamsCount: z.number().int(),
})

export const adminOrgGetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminOrgGet',
		contextRuns: 'deny',
		description:
			'Read one organization’s plans, lifecycle state, seats, members, budgets, wallet, and recent ledger by orgId or slug. Admin-only; includes deleted organizations.',
		keywords: [
			'admin',
			'organization',
			'org',
			'plan',
			'seats',
			'wallet',
			'budget',
		],
		inputSchema: adminOrgTargetSchema,
		outputSchema: adminOrgDetailSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(ctx, 'adminOrgGet', async () => {
				const detail = await loadAdminOrgDetail(ctx.env, {
					orgId: args.orgId,
					slug: args.org,
				})
				if (!detail) throw new Error('Organization not found.')
				return detail
			})
		},
	},
)
