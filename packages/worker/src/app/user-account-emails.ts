import {
	buildBillingSuccessEmail,
	buildCreditsAutoRefilledEmail,
	buildCreditsLowBalanceEmail,
	buildCreditsMonthlyCapEmail,
	buildPastDueEmail,
	buildPaymentFailedEmail,
} from '#app/email/messages.ts'
import {
	categoryForTransactionalEmailKind,
	sendGatedTransactionalEmail,
} from '#worker/email/transactional-send-policy.ts'
import { accountCreditsPath } from '#universal/compute-overage.ts'
import { orgBillingPath } from '#universal/org-pages.ts'
import { formatCents, formatMicroUsd } from '#universal/credits.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { kodyDiscordInviteUrl } from '#universal/community-links.ts'

export const userAccountEmailKvKeyPrefix = 'account-email-user:v1'
export const userAccountEmailClaimTtlSeconds = 30 * 24 * 60 * 60

/**
 * Billing and credit transactional mail. Connect-agent and other tips live in
 * the usage campaign.
 */
export type UserAccountEmailKind =
	| 'billing_success'
	| 'payment_failed'
	| 'past_due'
	| 'credits_auto_refilled'
	| 'credits_monthly_cap'
	| 'credits_low_balance'

export function userAccountEmailKvKey(input: {
	userId: string
	kind: UserAccountEmailKind
	suffix?: string
}) {
	const base = `${userAccountEmailKvKeyPrefix}:${input.userId}:${input.kind}`
	return input.suffix ? `${base}:${input.suffix}` : base
}

type EmailConfig = { appBaseUrl: string; fromEmail: string }

async function claimAndSend(input: {
	env: Env
	to: string
	userId: string
	kind: UserAccountEmailKind
	suffix?: string
	emailConfig?: EmailConfig
	build: (config: EmailConfig) =>
		| Promise<{
				subject: string
				html: string
				text: string
				headers?: Record<string, string>
		  }>
		| {
				subject: string
				html: string
				text: string
				headers?: Record<string, string>
		  }
}): Promise<boolean> {
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	const emailConfig =
		input.emailConfig ?? resolveTransactionalEmailConfig({ env: input.env })
	if (!kv || !emailConfig) return false

	const key = userAccountEmailKvKey({
		userId: input.userId,
		kind: input.kind,
		suffix: input.suffix,
	})
	if (await kv.get(key)) return false

	try {
		await kv.put(key, String(Date.now()), {
			expirationTtl: userAccountEmailClaimTtlSeconds,
		})
	} catch (error) {
		console.warn('user-account-email-claim-failed', {
			kind: input.kind,
			error,
		})
		return false
	}

	const email = await input.build(emailConfig)
	let sendResult: Awaited<ReturnType<typeof sendGatedTransactionalEmail>>
	try {
		sendResult = await sendGatedTransactionalEmail({
			db: input.env.APP_DB,
			config: {
				accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
				apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
				apiToken: input.env.CLOUDFLARE_API_TOKEN,
			},
			category: categoryForTransactionalEmailKind(input.kind),
			kind: input.kind,
			message: {
				to: input.to,
				from: emailConfig.fromEmail,
				subject: email.subject,
				html: email.html,
				text: email.text,
				headers: email.headers,
			},
		})
	} catch (error) {
		console.warn('user-account-email-send-failed', {
			kind: input.kind,
			error,
		})
		await releaseEmailClaim(kv, key)
		return false
	}
	if (!sendResult.ok) {
		console.warn('user-account-email-send-skipped', {
			kind: input.kind,
			reason: sendResult.error ?? 'unconfigured',
			hold: 'hold' in sendResult ? sendResult.hold : false,
		})
		await releaseEmailClaim(kv, key)
		return false
	}
	return true
}

async function releaseEmailClaim(kv: KVNamespace, key: string) {
	try {
		await kv.delete(key)
	} catch (error) {
		console.warn('user-account-email-claim-release-failed', { key, error })
	}
}

function orgBillingUrl(appBaseUrl: string, orgSlug: string) {
	return new URL(orgBillingPath(orgSlug), appBaseUrl).toString()
}

export async function sendBillingSuccessEmail(input: {
	env: Env
	email: string
	userId: string
	orgSlug: string
	planLabel: string
}): Promise<boolean> {
	return await claimAndSend({
		env: input.env,
		to: input.email,
		userId: input.userId,
		kind: 'billing_success',
		suffix: input.planLabel.toLowerCase(),
		build: (config) =>
			buildBillingSuccessEmail({
				appBaseUrl: config.appBaseUrl,
				billingUrl: orgBillingUrl(config.appBaseUrl, input.orgSlug),
				discordUrl: kodyDiscordInviteUrl,
				planLabel: input.planLabel,
			}),
	})
}

export async function sendPaymentFailedEmail(input: {
	env: Env
	email: string
	userId: string
	orgSlug: string
	day: string
}): Promise<boolean> {
	return await claimAndSend({
		env: input.env,
		to: input.email,
		userId: input.userId,
		kind: 'payment_failed',
		suffix: input.day,
		build: (config) =>
			buildPaymentFailedEmail({
				appBaseUrl: config.appBaseUrl,
				billingUrl: orgBillingUrl(config.appBaseUrl, input.orgSlug),
			}),
	})
}

export async function sendPastDueEmail(input: {
	env: Env
	email: string
	userId: string
	orgSlug: string
	day: string
}): Promise<boolean> {
	return await claimAndSend({
		env: input.env,
		to: input.email,
		userId: input.userId,
		kind: 'past_due',
		suffix: input.day,
		build: (config) =>
			buildPastDueEmail({
				appBaseUrl: config.appBaseUrl,
				billingUrl: orgBillingUrl(config.appBaseUrl, input.orgSlug),
			}),
	})
}

export async function sendCreditAutoRefilledEmail(input: {
	env: Env
	email: string
	userId: string
	paymentIntentId: string
	amountCents: number
	balanceMicroUsd: number
}): Promise<boolean> {
	return await claimAndSend({
		env: input.env,
		to: input.email,
		userId: input.userId,
		kind: 'credits_auto_refilled',
		suffix: input.paymentIntentId,
		build: (config) =>
			buildCreditsAutoRefilledEmail({
				appBaseUrl: config.appBaseUrl,
				creditsUrl: new URL(accountCreditsPath, config.appBaseUrl).toString(),
				amountLabel: formatCents(input.amountCents),
				balanceLabel: formatMicroUsd(input.balanceMicroUsd),
			}),
	})
}

export async function sendCreditMonthlyCapEmail(input: {
	env: Env
	email: string
	userId: string
	month: string
}): Promise<boolean> {
	return await claimAndSend({
		env: input.env,
		to: input.email,
		userId: input.userId,
		kind: 'credits_monthly_cap',
		suffix: input.month,
		build: (config) =>
			buildCreditsMonthlyCapEmail({
				appBaseUrl: config.appBaseUrl,
				creditsUrl: new URL(accountCreditsPath, config.appBaseUrl).toString(),
			}),
	})
}

export async function sendCreditLowBalanceEmail(input: {
	env: Env
	email: string
	userId: string
	balanceMicroUsd: number
	now: Date
}): Promise<boolean> {
	return await claimAndSend({
		env: input.env,
		to: input.email,
		userId: input.userId,
		kind: 'credits_low_balance',
		suffix: input.now.toISOString().slice(0, 'YYYY-MM-DDTHH'.length),
		build: (config) =>
			buildCreditsLowBalanceEmail({
				appBaseUrl: config.appBaseUrl,
				creditsUrl: new URL(accountCreditsPath, config.appBaseUrl).toString(),
				balanceLabel: formatMicroUsd(input.balanceMicroUsd),
			}),
	})
}
