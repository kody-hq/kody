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
import {
	loadBlackFridayCheckoutOffer,
	resolveBlackFridayCodeInterval,
} from '../../start/campaigns/black-friday-2026/server.ts'

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
	alreadySubscribed: (slug: string, billingUrl: string) =>
		`@${slug} already has a paid plan, so there is nothing to check out. Change or cancel it at ${billingUrl}`,
	codeNotApplied:
		'That promo code could not be applied, so it is left out of this checkout.',
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
			/** Set when the caller passed a promo code that cannot be used. */
			codeNote: string | null
	  }
	| { ok: false; reason: string; paidPlan?: true }

type BillingOrgAccess =
	| { ok: true; binding: OrgBinding; slug: string }
	| { ok: false; reason: string }

/** `https://kody.codes/@acme/-/billing` */
export function orgBillingPageUrl(orgSlug: string, baseUrl: string) {
	return new URL(orgBillingPath(orgSlug), baseUrl).toString()
}

/**
 * A promo code is letters and digits in capitals, usually with a dash
 * (`SAVE20`, `SPRING-SALE`). Tells a code passed as `interval` apart from a
 * mistyped interval such as "weekly".
 */
function looksLikePromoCode(value: string) {
	return (
		/^[A-Z0-9]{4,}$/.test(value) ||
		/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+$/.test(value)
	)
}

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
 * Whether `userId` may manage billing for the organization. `requestForOrg`
 * returns the request the permission check runs against, or null when the
 * caller's credential cannot act for that organization (an agent connection
 * belongs to one organization).
 */
export async function resolveBillingOrgAccess(input: {
	env: Env
	userId: string
	requestForOrg: (binding: OrgBinding) => RequestContext | null
	org: unknown
}): Promise<BillingOrgAccess> {
	const { env } = input
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
	return { ok: true, binding, slug }
}

/**
 * Whether `userId` may start Pro checkout for the organization, and whether
 * a running sale applies. A promo code (as `promoCode`, or passed where the
 * interval goes) only picks the billing interval: the sale price is applied
 * at checkout by the same rules with or without it.
 */
export async function evaluateCheckoutLink(input: {
	env: Env
	userId: string
	requestForOrg: (binding: OrgBinding) => RequestContext | null
	org: unknown
	plan: unknown
	interval: unknown
	promoCode?: unknown
	baseUrl: string
	now: Date
}): Promise<CheckoutLinkDecision> {
	const { env, now } = input
	if (input.plan !== checkoutLinkPlan) {
		return { ok: false, reason: checkoutLinkReasons.plan }
	}
	const givenInterval =
		input.interval === 'month' || input.interval === 'year'
			? input.interval
			: null
	const intervalText =
		typeof input.interval === 'string' ? input.interval.trim() : ''
	const intervalCode =
		!givenInterval && looksLikePromoCode(intervalText) ? intervalText : null
	if (!givenInterval && !intervalCode) {
		return { ok: false, reason: checkoutLinkReasons.interval }
	}
	const code =
		typeof input.promoCode === 'string' && input.promoCode.trim()
			? input.promoCode.trim()
			: intervalCode
	const access = await resolveBillingOrgAccess(input)
	if (!access.ok) return access
	const { binding, slug } = access
	if (!isBillingConfigured(env)) {
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
		return {
			ok: false,
			reason: checkoutLinkReasons.alreadySubscribed(
				slug,
				orgBillingPageUrl(slug, input.baseUrl),
			),
			paidPlan: true,
		}
	}
	// Remove when: the Black Friday 2026 campaign folder is deleted (any time
	// after 2026-12-04); see its README. Every code is then unknown and
	// `offer` is always null.
	const codeInterval = code
		? await resolveBlackFridayCodeInterval({ env, code, now })
		: null
	const interval = codeInterval ?? givenInterval ?? 'month'
	if (!getPriceIdForPlan(env, checkoutLinkPlan, interval)) {
		return { ok: false, reason: checkoutLinkReasons.notConfigured }
	}
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
		codeNote: code && !codeInterval ? checkoutLinkReasons.codeNotApplied : null,
	}
}

/** The check for a signed-in person on the website, as that person. */
export function evaluateCheckoutLinkForSession(input: {
	env: Env
	person: Parameters<typeof deriveRequestContext>[0]['user']
	org: unknown
	plan: unknown
	interval: unknown
	baseUrl: string
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
		baseUrl: input.baseUrl,
		now: input.now,
	})
}
