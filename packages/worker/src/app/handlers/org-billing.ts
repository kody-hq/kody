import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { operationResult } from '../operation-result.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import {
	BillingPlanUnavailableError,
	loadAccountBillingData,
	type BillingPageOrg,
} from '#app/account-billing-data.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { userHasMcpOAuthGrants } from '#app/onboarding-data.ts'
import { loadRequestOrgResolution } from '#app/org-request-binding.ts'
import {
	authorize,
	AuthorizationError,
} from '#worker/authorization/authorize.ts'
import { orgBillingPath } from '#universal/org-pages.ts'
import {
	createBillingPortalSession,
	createCheckoutSession,
	listSubscriptions,
	BillingNotConfiguredError,
	StripeApiError,
} from '#worker/billing/stripe-client.ts'
import {
	createBillingLinkReference,
	getBillingPortalConfigurationId,
	getPriceIdForPlan,
	isBillingConfigured,
	parseBillingInterval,
	selectKodyPlanRetainingSubscriptions,
	subscriptionHasPrice,
} from '#worker/billing/billing-config.ts'
import {
	attachPromoReservationSession,
	existingSubscriptionPromoRejection,
	hasPersonClaimedPromo,
	parsePromoCodeInput,
	promoAlreadyClaimedRejection,
	promoClaimMetadata,
	promoIntervalRejection,
	promoRejectedByStripe,
	releasePromoReservation,
	reservePromoClaim,
	resolveCheckoutPromotionCode,
} from '#worker/billing/checkout-promo.ts'
import {
	BillingLinkError,
	linkStripeCustomerFromCheckoutSessionAttribution,
} from '#worker/billing/subscription-sync.ts'
import { enqueuePlatformFeedbackDispatch } from '#worker/platform-feedback/dispatch-queue-producer.ts'
import { isPlatformFeedbackDomainError } from '#worker/platform-feedback/errors.ts'
import { submitPlatformFeedback } from '#worker/platform-feedback/service.ts'
import { recordCheckoutFunnelEvent } from '#worker/identity/onboarding-funnel.ts'
import { buildOrgBillingMetadata } from '#worker/billing/org-stripe-metadata.ts'
import {
	countLiveSeats,
	readOrgStripeCustomerId,
} from '#worker/orgs/billing.ts'
import { getOrgById, loadOrgBindingForSlug } from '#worker/orgs/repo.ts'

type OrgBillingAccess =
	| { ok: true; org: BillingPageOrg }
	| { ok: false; status: 403 | 404; error: string }

/**
 * The organization a `/@slug/-/billing...` request acts on, when the person may
 * use `permission` there. The request context binds that organization
 * (org-request-binding.ts), so `authorize` is the same check MCP billing
 * capabilities run. A slug the person cannot reach is a 404, never a silent
 * fall back to their signup organization.
 */
export async function resolveOrgBillingAccess(input: {
	orgSlug?: string
	request: Request
	env: Env
	user: AuthenticatedAppUser
	permission: Extract<OrgPermission, 'billing:read' | 'billing:write'>
}): Promise<OrgBillingAccess> {
	const resolution = input.orgSlug
		? ((await loadOrgBindingForSlug(
				input.env.APP_DB,
				input.user.mcpUser.userId,
				input.orgSlug,
			)) ?? 'denied')
		: await loadRequestOrgResolution(
				input.request,
				input.env,
				input.user.mcpUser.userId,
			)
	if (
		typeof resolution !== 'string' &&
		resolution.org.id !== input.user.request.org.id
	)
		return { ok: false, status: 404, error: 'Organization unavailable.' }
	if (typeof resolution === 'string') {
		return { ok: false, status: 404, error: 'Organization unavailable.' }
	}
	const slug = resolution.org.slug ?? input.user.username
	try {
		await authorize(
			{ env: input.env, request: input.user.request },
			input.permission,
		)
	} catch (error) {
		if (!(error instanceof AuthorizationError)) throw error
		return {
			ok: false,
			status: 403,
			error: `Only owners and billing admins can manage billing for @${slug}.`,
		}
	}
	const record = await getOrgById(input.env.APP_DB, resolution.org.id)
	if (!record) {
		return { ok: false, status: 404, error: 'Organization unavailable.' }
	}
	return {
		ok: true,
		org: {
			id: resolution.org.id,
			slug: record.slug,
			displayName: record.display_name,
			personal:
				resolution.org.id === personalOrgIdForPerson(input.user.mcpUser),
		},
	}
}

function orgBillingUrl(request: Request, slug: string, step = '') {
	return new URL(
		step ? `${orgBillingPath(slug)}/${step}` : orgBillingPath(slug),
		request.url,
	)
}

function billingErrorRedirect(
	request: Request,
	slug: string,
	errorCode: string,
) {
	const url = orgBillingUrl(request, slug)
	url.searchParams.set('error', errorCode)
	return Response.redirect(url.toString(), 302)
}

/**
 * Page data for someone who already passed `billing:read`. That permission
 * implies `billing:write`: the billing role preset includes both, and
 * billing permissions cannot be granted. The page has no read-only state.
 */
export async function loadOrgBillingPageData(input: {
	errorCode: string | null
	noticeCode: string | null
	env: Env
	user: AuthenticatedAppUser
	org: BillingPageOrg
}) {
	try {
		return await loadAccountBillingData({
			env: input.env,
			userId: input.user.userId,
			org: input.org,
			seats: Math.max(1, await countLiveSeats(input.env.APP_DB, input.org.id)),
			errorCode: input.errorCode,
			noticeCode: input.noticeCode,
		})
	} catch (error) {
		if (error instanceof BillingPlanUnavailableError) return null
		throw error
	}
}

export async function openWebsiteBillingPortal(input: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	orgSlug: string
}) {
	const { env, request, user, orgSlug } = input
	const access = await resolveOrgBillingAccess({
		env,
		request,
		user,
		orgSlug,
		permission: 'billing:write',
	})
	if (!access.ok)
		return operationResult({ ok: false, error: access.error }, access.status)
	const { org } = access
	const errorUrl = (code: string) => {
		const url = orgBillingUrl(request, org.slug)
		url.searchParams.set('error', code)
		return operationResult({ ok: true, url: url.toString() })
	}
	if (!isBillingConfigured(env)) return errorUrl('billing_not_configured')
	const customerId = await readOrgStripeCustomerId(env.APP_DB, org.id)
	if (!customerId) return errorUrl('no_customer')
	try {
		const portal = await createBillingPortalSession(env, {
			customerId,
			returnUrl: orgBillingUrl(request, org.slug).toString(),
			configuration: getBillingPortalConfigurationId(env),
		})
		return operationResult({ ok: true, url: portal.url })
	} catch (error) {
		if (error instanceof BillingNotConfiguredError)
			return errorUrl('billing_not_configured')
		console.error('billing_portal_failed', {
			stableUserId: user.mcpUser.userId,
			error: error instanceof Error ? error.message : String(error),
		})
		return errorUrl('portal_failed')
	}
}

export async function completeOrgBillingCheckout({
	request,
	env,
	user,
	orgSlug,
	sessionId,
}: {
	request: Request
	env: Env
	user: AuthenticatedAppUser
	orgSlug: string
	sessionId: string | null
}) {
	const access = await resolveOrgBillingAccess({
		request,
		env,
		user,
		permission: 'billing:write',
		orgSlug,
	})
	if (!access.ok) return access
	const { org } = access

	if (!isBillingConfigured(env)) {
		return billingErrorRedirect(request, org.slug, 'billing_not_configured')
	}

	sessionId = sessionId?.trim() ?? ''
	if (!sessionId) {
		return billingErrorRedirect(request, org.slug, 'missing_session')
	}

	const requestIp = getRequestIp(request) ?? undefined
	try {
		// Link the Stripe customer onto the request-bound org. The member
		// is the authorizing actor only (audit email below).
		await linkStripeCustomerFromCheckoutSessionAttribution({
			env,
			sessionId,
			orgId: org.id,
		})
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'billing_checkout_linked',
			result: 'success',
			email: user.email,
			ip: requestIp,
			path: `${orgBillingPath(orgSlug)}/success`,
		})
		const hasMcpClient = await userHasMcpOAuthGrants(
			env,
			personalOrgIdForPerson(user.mcpUser),
		)
		const needsOnboarding = !user.emailVerified || !hasMcpClient
		return { ok: true as const, needsOnboarding }
	} catch (error) {
		const code = error instanceof BillingLinkError ? error.code : 'link_failed'
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'billing_checkout_linked',
			result: 'failure',
			email: user.email,
			ip: requestIp,
			path: `${orgBillingPath(orgSlug)}/success`,
			reason: code,
		})
		return billingErrorRedirect(request, org.slug, code)
	}
}

export async function startWebsiteCheckout(input: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	orgSlug?: string
	body: unknown
}) {
	const { env, request, user } = input
	const access = await resolveOrgBillingAccess({
		request,
		env,
		user,
		permission: 'billing:write',
		orgSlug: input.orgSlug,
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}

	const body = input.body as {
		plan?: unknown
		interval?: unknown
		promoCode?: unknown
	} | null
	const plan = body?.plan === 'pro' ? body.plan : null
	if (!plan) {
		return operationResult({ ok: false, error: 'Choose Pro.' }, 400)
	}
	const interval = parseBillingInterval(body?.interval)
	if (!interval) {
		return operationResult(
			{ ok: false, error: 'Choose monthly or annual billing.' },
			400,
		)
	}
	const promo = parsePromoCodeInput(body?.promoCode)
	if (!promo.ok) {
		return operationResult({ ok: false, error: promo.error }, 400)
	}
	if (promo.code) {
		const intervalRejection = promoIntervalRejection(interval)
		if (intervalRejection) {
			return operationResult({ ok: false, error: intervalRejection }, 400)
		}
		if (await hasPersonClaimedPromo(env.APP_DB, user.mcpUser.userId)) {
			return operationResult(
				{ ok: false, error: promoAlreadyClaimedRejection },
				409,
			)
		}
	}
	const priceId = getPriceIdForPlan(env, plan, interval)
	if (!isBillingConfigured(env) || !priceId) {
		return operationResult(
			{
				ok: false,
				error: 'Pro checkout is not configured on this deployment.',
			},
			409,
		)
	}

	const { org } = access
	const customerId =
		(await readOrgStripeCustomerId(env.APP_DB, org.id)) || undefined
	const seatQuantity = Math.max(1, await countLiveSeats(env.APP_DB, org.id))
	const billingUrl = orgBillingUrl(request, org.slug).toString()
	const requestIp = getRequestIp(request) ?? undefined
	const requestPath = new URL(request.url).pathname

	try {
		if (customerId) {
			// An existing subscriber must change plans on their current
			// subscription. A second Checkout Session would create a second
			// subscription that bills alongside the first (the plan resolver
			// grants the higher tier across all of them), so route switches
			// to Pro through the portal's prorated confirm flow, pinned to
			// the Pro price so a retired price is never offered.
			// Only Kody subscriptions. Never portal-update a shared-account
			// product (for example GratiText Premium) onto a Kody price.
			const planRetaining = selectKodyPlanRetainingSubscriptions(
				env,
				await listSubscriptions(env, customerId),
			)
			if (planRetaining.length > 0 && promo.code) {
				return operationResult(
					{ ok: false, error: existingSubscriptionPromoRejection },
					409,
				)
			}
			if (planRetaining.length === 1) {
				const subscription = planRetaining[0]!
				if (subscriptionHasPrice(subscription, priceId)) {
					return operationResult(
						{ ok: false, error: 'You are already on that plan.' },
						409,
					)
				}
				const subscriptionItemId = subscription.items.data.find(
					(item) => item.id,
				)?.id
				if (!subscriptionItemId) {
					const portal = await createBillingPortalSession(env, {
						customerId,
						returnUrl: billingUrl,
						configuration: getBillingPortalConfigurationId(env),
					})
					return operationResult({
						ok: true,
						url: portal.url,
						mode: 'portal',
					})
				}
				const updatedUrl = new URL(billingUrl)
				updatedUrl.searchParams.set('billing', 'updated')
				const portal = await createBillingPortalSession(env, {
					customerId,
					returnUrl: billingUrl,
					configuration: getBillingPortalConfigurationId(env),
					flowData: {
						type: 'subscription_update_confirm',
						subscriptionId: subscription.id,
						subscriptionItemId,
						priceId,
						afterCompletionRedirectUrl: updatedUrl.toString(),
						quantity: seatQuantity,
					},
				})
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'billing_plan_change_started',
					result: 'success',
					email: user.email,
					ip: requestIp,
					path: requestPath,
				})
				return operationResult({
					ok: true,
					url: portal.url,
					mode: 'portal_update',
				})
			}
			if (planRetaining.length > 1) {
				// Legacy double subscriptions: the portal update flow targets
				// one subscription, so let the customer sort out which to keep.
				const portal = await createBillingPortalSession(env, {
					customerId,
					returnUrl: billingUrl,
					configuration: getBillingPortalConfigurationId(env),
				})
				return operationResult({
					ok: true,
					url: portal.url,
					mode: 'portal',
				})
			}
		}

		let promotionCodeId: string | undefined
		if (promo.code) {
			const resolved = await resolveCheckoutPromotionCode(env, {
				code: promo.code,
				now: new Date(),
			})
			if (!resolved.ok) {
				return operationResult({ ok: false, error: resolved.error }, 400)
			}
			promotionCodeId = resolved.id
			const reserved = await reservePromoClaim({
				db: env.APP_DB,
				userId: user.mcpUser.userId,
				promotionCodeId,
				orgId: org.id,
				now: new Date(),
			})
			if (!reserved) {
				return operationResult(
					{ ok: false, error: promoAlreadyClaimedRejection },
					409,
				)
			}
		}

		// Org is the billing subject; the signed-in member only authorizes.
		const clientReferenceId = await createBillingLinkReference(env, org.id)
		const successUrl = `${orgBillingUrl(request, org.slug, 'success').toString()}?session_id={CHECKOUT_SESSION_ID}`
		let session: { id: string; url: string }
		try {
			session = await createCheckoutSession(env, {
				priceId,
				clientReferenceId,
				successUrl,
				cancelUrl: billingUrl,
				quantity: seatQuantity,
				...(customerId ? { customerId } : { customerEmail: user.email }),
				...(promotionCodeId ? { promotionCodeId } : {}),
				// Org identity on Stripe objects (ADR 0065). HMAC client_reference_id
				// is also org-backed and verified on link.
				metadata: {
					...buildOrgBillingMetadata(org.id),
					kody_plan: plan,
					...(promotionCodeId
						? promoClaimMetadata({
								userId: user.mcpUser.userId,
								promotionCodeId,
							})
						: {}),
				},
			})
		} catch (error) {
			if (promotionCodeId) {
				await releasePromoReservation({
					db: env.APP_DB,
					userId: user.mcpUser.userId,
				})
			}
			// The code passed Kody's checks, so a 400 here is Stripe's own
			// coupon rule (product restriction, first-time-only).
			if (
				promotionCodeId &&
				error instanceof StripeApiError &&
				error.status === 400
			) {
				console.error('billing_checkout_promo_rejected', {
					orgId: org.id,
					code: error.code,
				})
				return operationResult({ ok: false, error: promoRejectedByStripe }, 400)
			}
			throw error
		}
		if (promotionCodeId) {
			await attachPromoReservationSession({
				db: env.APP_DB,
				userId: user.mcpUser.userId,
				checkoutSessionId: session.id,
			})
		}
		recordCheckoutFunnelEvent(env, {
			stage: 'checkout_started',
			userId: org.id,
			plan,
		})
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'billing_checkout_started',
			result: 'success',
			email: user.email,
			ip: requestIp,
			path: requestPath,
		})
		return operationResult({ ok: true, url: session.url, mode: 'checkout' })
	} catch (error) {
		if (error instanceof StripeApiError) {
			console.error('billing_checkout_failed', {
				stableUserId: user.mcpUser.userId,
				error: error.message,
			})
			return operationResult(
				{
					ok: false,
					error: 'Unable to start checkout. Try again shortly.',
				},
				502,
			)
		}
		throw error
	}
}

export async function submitWebsiteCancellationFeedback(input: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	orgSlug?: string
	body: unknown
}) {
	const { env, request, user } = input
	const body = input.body as {
		details?: unknown
	} | null
	const details = typeof body?.details === 'string' ? body.details.trim() : ''
	if (!details) {
		return operationResult(
			{ ok: false, error: 'Share a sentence or two before sending.' },
			400,
		)
	}
	if (details.length > 8000) {
		return operationResult(
			{ ok: false, error: 'Feedback is limited to 8000 characters.' },
			400,
		)
	}

	const submitterUsername = user.username.trim()
	if (!submitterUsername) {
		return operationResult(
			{ ok: false, error: 'Unable to submit feedback for this account.' },
			409,
		)
	}

	try {
		const feedback = await submitPlatformFeedback({
			db: env.APP_DB,
			submitterUserId: user.mcpUser.userId,
			submitterUsername,
			submitterEmail: user.email,
			category: 'cancellation',
			summary: 'Subscription cancellation feedback',
			details,
		})
		try {
			await enqueuePlatformFeedbackDispatch({
				queue: env.PLATFORM_FEEDBACK_DISPATCH_QUEUE,
				feedbackId: feedback.id,
			})
		} catch (error) {
			console.error('platform-feedback-dispatch-enqueue-failed', error)
		}
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'billing_cancellation_feedback',
			result: 'success',
			email: user.email,
			ip: getRequestIp(request) ?? undefined,
			path: new URL(request.url).pathname,
		})
		return operationResult({ ok: true })
	} catch (error) {
		if (isPlatformFeedbackDomainError(error)) {
			return operationResult({ ok: false, error: error.message }, 429)
		}
		throw error
	}
}
