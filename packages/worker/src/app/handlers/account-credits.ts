import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { personalOrgUsageRedirectUrl } from '#app/handlers/org-usage.ts'
import { operationResult } from '../operation-result.ts'
import { loadAccountCreditsUser } from '#app/account-credits-data.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadRequestOrgResolution } from '#app/org-request-binding.ts'
import {
	authorize,
	AuthorizationError,
} from '#worker/authorization/authorize.ts'
import { orgUsageCreditsPath } from '#universal/org-pages.ts'
import {
	validateCreditAutoRefillSettings,
	validateCreditTopUpCents,
	type CreditNotifySettings,
} from '#universal/credits.ts'
import { isBillingConfigured } from '#worker/billing/billing-config.ts'
import { startCreditTopUpCheckout } from '#worker/billing/credit-top-ups.ts'
import {
	ensureCreditWallet,
	updateCreditWalletSettings,
} from '#worker/billing/credit-wallet.ts'
import { StripeApiError } from '#worker/billing/stripe-client.ts'
import { getOrgById, loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { type BillingPageOrg } from '#app/account-billing-data.ts'

/**
 * Where an old `/account/credits` link lands once the personal org slug is
 * known. Kept for unit tests that build the URL without auth.
 */
export function accountCreditsRedirectUrl(
	requestUrl: string,
	slug: string,
): string {
	const url = new URL(requestUrl)
	if (url.searchParams.has('topup'))
		return personalOrgUsageRedirectUrl({ requestUrl, slug, credits: true })
	url.pathname = `/@${slug}/-/credits`
	return url.toString()
}

function readNotifySettings(value: unknown): CreditNotifySettings | null {
	if (!value || typeof value !== 'object') return null
	const record = value as Record<string, unknown>
	const autoRefilled = record['autoRefilled']
	const monthlyCap = record['monthlyCap']
	const lowBalance = record['lowBalance']
	if (
		typeof autoRefilled !== 'boolean' ||
		typeof monthlyCap !== 'boolean' ||
		typeof lowBalance !== 'boolean'
	) {
		return null
	}
	return { autoRefilled, monthlyCap, lowBalance }
}

/**
 * Organization a credits mutation acts on. Path/Referer bind via
 * {@link loadRequestOrgResolution}; missing org falls back to the signup
 * organization. Requires `billing:write`.
 */
async function resolveCreditsOrg(input: {
	orgSlug?: string
	request: Request
	env: Env
	user: AuthenticatedAppUser
}): Promise<
	| { ok: true; org: BillingPageOrg }
	| { ok: false; status: 403 | 404; error: string }
> {
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
	if (resolution === 'denied') {
		return { ok: false, status: 404, error: 'Organization unavailable.' }
	}
	try {
		await authorize(
			{ env: input.env, request: input.user.request },
			'billing:write',
		)
	} catch (error) {
		if (!(error instanceof AuthorizationError)) throw error
		const slug =
			resolution === 'personal'
				? input.user.username
				: (resolution.org.slug ?? input.user.username)
		return {
			ok: false,
			status: 403,
			error: `Only owners and billing admins can manage credits for @${slug}.`,
		}
	}
	if (resolution === 'personal') {
		const id = personalOrgIdForPerson(input.user.mcpUser)
		const record = await getOrgById(input.env.APP_DB, id)
		return {
			ok: true,
			org: {
				id,
				slug: record?.slug?.trim() || input.user.username,
				displayName: record?.display_name ?? null,
				personal: true,
			},
		}
	}
	const record = await getOrgById(input.env.APP_DB, resolution.org.id)
	if (!record) {
		throw new Error(`Cannot load credits: missing org ${resolution.org.id}.`)
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

export async function startWebsiteCreditTopUp(input: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	orgSlug?: string
	body: unknown
}) {
	const { env, request, user } = input
	const access = await resolveCreditsOrg({
		request,
		env,
		user,
		orgSlug: input.orgSlug,
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}
	const body = input.body as {
		amountCents?: unknown
	} | null
	const amount = validateCreditTopUpCents(body?.amountCents)
	if (!amount.ok) {
		return operationResult({ ok: false, error: amount.error }, 400)
	}
	if (!isBillingConfigured(env)) {
		return operationResult(
			{ ok: false, error: 'Billing is not configured on this deployment.' },
			409,
		)
	}
	const now = new Date()
	const creditsUser = await loadAccountCreditsUser({
		env,
		userId: user.userId,
		orgId: access.org.id,
		personal: access.org.personal,
		now,
	})
	if (!creditsUser?.canBuyCredits || !creditsUser.stripeCustomerId) {
		return operationResult(
			{ ok: false, error: 'Subscribe to Pro to add credits.' },
			409,
		)
	}
	await ensureCreditWallet({
		db: env.APP_DB,
		userId: creditsUser.stableUserId,
		entitlement: creditsUser.entitlement,
		now,
	})
	try {
		const checkout = await startCreditTopUpCheckout({
			env,
			stableUserId: creditsUser.stableUserId,
			stripeCustomerId: creditsUser.stripeCustomerId,
			amountCents: amount.cents,
			creditsUrl: new URL(
				orgUsageCreditsPath(access.org.slug),
				request.url,
			).toString(),
		})
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'credits_top_up_started',
			result: 'success',
			email: user.email,
			ip: getRequestIp(request) ?? undefined,
			path: new URL(request.url).pathname,
			reason: `amount_cents=${amount.cents}`,
		})
		return operationResult({ ok: true, url: checkout.url })
	} catch (error) {
		if (error instanceof StripeApiError) {
			console.error('credit_top_up_checkout_failed', {
				status: error.status,
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

export async function saveWebsiteCreditSettings(input: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	orgSlug?: string
	body: unknown
}) {
	const { env, request, user } = input
	const access = await resolveCreditsOrg({
		request,
		env,
		user,
		orgSlug: input.orgSlug,
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}
	const body = input.body as {
		autoRefill?: unknown
		notify?: unknown
	} | null
	const autoRefill = validateCreditAutoRefillSettings(body?.autoRefill)
	if (!autoRefill.ok) {
		return operationResult({ ok: false, error: autoRefill.error }, 400)
	}
	const notify = readNotifySettings(body?.notify)
	if (!notify) {
		return operationResult(
			{ ok: false, error: 'Notification settings are required.' },
			400,
		)
	}
	const now = new Date()
	const creditsUser = await loadAccountCreditsUser({
		env,
		userId: user.userId,
		orgId: access.org.id,
		personal: access.org.personal,
		now,
	})
	if (!creditsUser?.canBuyCredits) {
		return operationResult(
			{ ok: false, error: 'Subscribe to Pro to change credit settings.' },
			409,
		)
	}
	await ensureCreditWallet({
		db: env.APP_DB,
		userId: creditsUser.stableUserId,
		entitlement: creditsUser.entitlement,
		now,
	})
	await updateCreditWalletSettings({
		db: env.APP_DB,
		userId: creditsUser.stableUserId,
		autoRefill: autoRefill.value,
		notify,
		now,
	})
	return operationResult({ ok: true })
}
