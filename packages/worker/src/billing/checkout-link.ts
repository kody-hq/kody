/**
 * The agent checkout link: an agent asks for a kody.codes link
 * (`billingCheckoutLink`), and the person who opens it starts Stripe
 * Checkout themselves. This is the one set of checks behind both, run when
 * the link is issued and again when it is opened, so a forwarded or stale
 * link cannot start checkout for the wrong person or organization. No
 * Stripe Checkout Session exists until the person confirms on the link page.
 */
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { orgBillingPath } from '#universal/org-pages.ts'
import {
	authorize,
	AuthorizationError,
} from '#worker/authorization/authorize.ts'
import {
	getPriceIdForPlan,
	isBillingConfigured,
	type BillingInterval,
} from '#worker/billing/billing-config.ts'
import {
	resolveUserPlanFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import { loadOrgBindingForSlug, type OrgBinding } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { loadBlackFridayCheckoutOffer } from '../../start/campaigns/black-friday-2026/server.ts'

export const checkoutLinkPlan = 'pro'

export const checkoutLinkReasons = {
	plan: 'Pro is the only plan sold at checkout. Ask for plan "pro".',
	interval: 'Choose monthly or annual billing: interval "month" or "year".',
	notConfigured: 'Pro checkout is not configured on this deployment.',
	unknownOrg: (slug: string) =>
		`There is no organization @${slug} that you belong to. Check the handle.`,
	noBillingAccess: (slug: string) =>
		`Only owners and billing admins can manage billing for @${slug}. Ask one of them to open this link.`,
	otherOrg: (slug: string) =>
		`This connection works for a different organization than @${slug}. Connect to @${slug} to start its checkout, or open its billing page.`,
	credentialScope: (slug: string) =>
		`This connection is not allowed to manage billing for @${slug}. An owner or billing admin can start checkout on the billing page instead.`,
	alreadySubscribed: (slug: string) =>
		`@${slug} already has a paid plan, so there is nothing to check out. Change or cancel it on the organization's billing page.`,
} as const

export type CheckoutLinkOffer =
	| { applies: true; summary: string }
	| { applies: false; reason: string }

export type CheckoutLinkDecision =
	| {
			ok: true
			org: { id: string; slug: string; displayName: string | null }
			plan: typeof checkoutLinkPlan
			interval: BillingInterval
			/** A running sale, and whether its price applies to this checkout. */
			offer: CheckoutLinkOffer | null
	  }
	| { ok: false; reason: string }

function normalizeOrgSlug(value: unknown) {
	return typeof value === 'string'
		? value.trim().replace(/^@/, '').toLowerCase()
		: ''
}

/** `/@acme/-/billing/checkout?plan=pro&interval=year` */
export function checkoutLinkPath(input: {
	orgSlug: string
	interval: BillingInterval
}) {
	const search = new URLSearchParams({
		plan: checkoutLinkPlan,
		interval: input.interval,
	})
	return `${orgBillingPath(input.orgSlug)}/checkout?${search}`
}

/**
 * Whether `userId` may start Pro checkout for the organization, and whether
 * a running sale applies. `requestForOrg` returns the request the permission
 * check runs against, or null when the caller's credential cannot act for
 * that organization (an agent connection belongs to one organization).
 */
export async function evaluateCheckoutLink(input: {
	env: Env
	userId: string
	requestForOrg: (binding: OrgBinding) => RequestContext | null
	org: unknown
	plan: unknown
	interval: unknown
	now: Date
}): Promise<CheckoutLinkDecision> {
	const { env, now } = input
	if (input.plan !== checkoutLinkPlan) {
		return { ok: false, reason: checkoutLinkReasons.plan }
	}
	const interval =
		input.interval === 'month' || input.interval === 'year'
			? input.interval
			: null
	if (!interval) return { ok: false, reason: checkoutLinkReasons.interval }
	const slug = normalizeOrgSlug(input.org)
	const binding = /^[a-z0-9_-]+$/.test(slug)
		? await loadOrgBindingForSlug(env.APP_DB, input.userId, slug)
		: null
	// An outside collaborator (a grant, no membership) is not told the
	// organization exists.
	if (!binding || binding.role == null) {
		return { ok: false, reason: checkoutLinkReasons.unknownOrg(slug) }
	}
	const request = input.requestForOrg(binding)
	if (!request) return { ok: false, reason: checkoutLinkReasons.otherOrg(slug) }
	try {
		await authorize({ env, request }, 'billing:write')
	} catch (error) {
		if (!(error instanceof AuthorizationError)) throw error
		return {
			ok: false,
			reason:
				error.code === 'missing_permission'
					? checkoutLinkReasons.noBillingAccess(slug)
					: checkoutLinkReasons.credentialScope(slug),
		}
	}
	if (
		!isBillingConfigured(env) ||
		!getPriceIdForPlan(env, checkoutLinkPlan, interval)
	) {
		return { ok: false, reason: checkoutLinkReasons.notConfigured }
	}
	const row = await env.APP_DB.prepare(
		`SELECT slug, display_name, ${userEntitlementColumnsSql()} FROM orgs
		 WHERE id = ? AND deleted_at IS NULL`,
	)
		.bind(binding.org.id)
		.first<UserEntitlementRow & { slug: string; display_name: string | null }>()
	if (!row) return { ok: false, reason: checkoutLinkReasons.unknownOrg(slug) }
	// `stripe_plan` is the stored result of the subscription filter checkout
	// runs live against Stripe when the person confirms.
	if (row.stripe_plan || resolveUserPlanFromRow(row, now).plan !== 'free') {
		return { ok: false, reason: checkoutLinkReasons.alreadySubscribed(slug) }
	}
	// Remove when: the Black Friday 2026 campaign folder is deleted (any time
	// after 2026-12-04); see its README. `offer` is then always null.
	const offer = await loadBlackFridayCheckoutOffer({
		db: env.APP_DB,
		userId: input.userId,
		orgId: binding.org.id,
		interval,
		now,
	})
	return {
		ok: true,
		org: {
			id: binding.org.id,
			slug: row.slug,
			displayName: row.display_name,
		},
		plan: checkoutLinkPlan,
		interval,
		offer,
	}
}

/** The check for a signed-in person on the website, as that person. */
export function evaluateCheckoutLinkForSession(input: {
	env: Env
	person: Parameters<typeof deriveRequestContext>[0]['user']
	org: unknown
	plan: unknown
	interval: unknown
	now: Date
}) {
	return evaluateCheckoutLink({
		env: input.env,
		userId: input.person.userId,
		requestForOrg: (orgBinding) =>
			deriveRequestContext({
				user: input.person,
				source: { kind: 'session' },
				orgBinding,
			}),
		org: input.org,
		plan: input.plan,
		interval: input.interval,
		now: input.now,
	})
}
