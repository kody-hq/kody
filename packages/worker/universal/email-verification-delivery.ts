export const emailVerificationDeliveryStatusValues = [
	'accepted',
	'delivered',
	'deferred',
	'bounced',
	'failed',
	'rejected',
	'complained',
] as const

export type EmailVerificationDeliveryStatus =
	(typeof emailVerificationDeliveryStatusValues)[number]

export const emailVerificationDeliveryClassValues = [
	'sender_block',
	'other',
] as const

export type EmailVerificationDeliveryClass =
	(typeof emailVerificationDeliveryClassValues)[number]

export type EmailVerificationDelivery = {
	status: EmailVerificationDeliveryStatus
	class: EmailVerificationDeliveryClass | null
	at: string | null
}

/** Public help doc for DNS filters and missing verification mail. */
const emailVerificationDeliveryHelpPath = '/docs/cant-open-or-get-mail'

const emailVerificationDeliveryIndicatorValues = [
	'waiting',
	'delivered',
	'delayed',
	'failed',
] as const

export type EmailVerificationDeliveryIndicator =
	(typeof emailVerificationDeliveryIndicatorValues)[number]

export const emailVerificationSenderBlockMessage =
	'Your mail provider is blocking our domain right now, try another address. Social login on the signup page still works. Support can also verify you manually — contact support with the address you used.'

const emailVerificationDeliveryFailedMessage =
	'The verification email could not be delivered. Try social login on the signup page, or contact support with the address you used.'

const emailVerificationDeliveryWaitingDetail =
	'Our mail provider accepted the message. Delivery confirmation can take a minute — check your inbox and spam folder while we wait.'

export function isEmailVerificationDeliveryStatus(
	value: string | null | undefined,
): value is EmailVerificationDeliveryStatus {
	return (
		typeof value === 'string' &&
		(emailVerificationDeliveryStatusValues as ReadonlyArray<string>).includes(
			value,
		)
	)
}

export function isEmailVerificationDeliveryClass(
	value: string | null | undefined,
): value is EmailVerificationDeliveryClass {
	return (
		typeof value === 'string' &&
		(emailVerificationDeliveryClassValues as ReadonlyArray<string>).includes(
			value,
		)
	)
}

export function parseEmailVerificationDelivery(input: {
	status?: string | null
	class?: string | null
	at?: string | null
}): EmailVerificationDelivery | null {
	if (!isEmailVerificationDeliveryStatus(input.status)) return null
	return {
		status: input.status,
		class: isEmailVerificationDeliveryClass(input.class) ? input.class : null,
		at: typeof input.at === 'string' && input.at.trim() ? input.at : null,
	}
}

/** Derived stall: unverified + latest send still `accepted` after this age. */
export const emailVerificationStallAfterMinutes = 60

export const adminUserVerificationFilterValues = ['stalled'] as const

export type AdminUserVerificationFilter =
	(typeof adminUserVerificationFilterValues)[number]

export function isAdminUserVerificationFilter(
	value: string,
): value is AdminUserVerificationFilter {
	return (adminUserVerificationFilterValues as ReadonlyArray<string>).includes(
		value,
	)
}

/**
 * Client/server predicate for the admin `verification=stalled` filter.
 * Stall is derived, never stored: late Cloudflare webhooks must not fight a
 * persisted `stalled` status.
 */
export function isStalledEmailVerificationDelivery(
	input: {
		emailVerified: boolean
		delivery: EmailVerificationDelivery | null
	},
	now: Date = new Date(),
	stallAfterMinutes = emailVerificationStallAfterMinutes,
) {
	if (input.emailVerified) return false
	if (input.delivery?.status !== 'accepted' || !input.delivery.at) return false
	const acceptedAt = Date.parse(input.delivery.at)
	if (!Number.isFinite(acceptedAt)) return false
	return now.getTime() - acceptedAt >= stallAfterMinutes * 60_000
}

export function acceptedEmailVerificationDelivery(
	at: string | Date = new Date(),
): EmailVerificationDelivery {
	return {
		status: 'accepted',
		class: null,
		at: at instanceof Date ? at.toISOString() : at,
	}
}

export function isEmailVerificationResendBlocked(
	delivery: EmailVerificationDelivery | null,
) {
	return delivery?.class === 'sender_block'
}

export type EmailVerificationDeliveryDescription = {
	headline: string | null
	detail: string | null
	canResend: boolean
	tone: 'info' | 'error'
	/** Visual phase for the signup delivery indicator. */
	indicator: EmailVerificationDeliveryIndicator
	/** Next-step help page when delivery failed or was blocked. */
	helpHref: string | null
	helpLabel: string | null
}

const emailVerificationDeliveryHelpLabel =
	"If you can't open kody.codes or get mail from us"

function describeDelivery(input: {
	headline: string | null
	detail: string | null
	canResend: boolean
	tone: 'info' | 'error'
	indicator: EmailVerificationDeliveryIndicator
	includeHelp?: boolean
}): EmailVerificationDeliveryDescription {
	return {
		headline: input.headline,
		detail: input.detail,
		canResend: input.canResend,
		tone: input.tone,
		indicator: input.indicator,
		helpHref: input.includeHelp ? emailVerificationDeliveryHelpPath : null,
		helpLabel: input.includeHelp ? emailVerificationDeliveryHelpLabel : null,
	}
}

export function describeEmailVerificationDelivery(
	delivery: EmailVerificationDelivery | null,
): EmailVerificationDeliveryDescription {
	if (!delivery) {
		return describeDelivery({
			headline: null,
			detail: null,
			canResend: true,
			tone: 'info',
			indicator: 'waiting',
		})
	}
	if (delivery.class === 'sender_block') {
		return describeDelivery({
			headline: 'Verification email blocked',
			detail: emailVerificationSenderBlockMessage,
			canResend: false,
			tone: 'error',
			indicator: 'failed',
			includeHelp: true,
		})
	}
	switch (delivery.status) {
		case 'bounced':
		case 'failed':
		case 'rejected':
			return describeDelivery({
				headline: 'Verification email was not delivered',
				detail: emailVerificationDeliveryFailedMessage,
				canResend: true,
				tone: 'error',
				indicator: 'failed',
				includeHelp: true,
			})
		case 'complained':
			return describeDelivery({
				headline: 'Verification email was marked as spam',
				detail: emailVerificationDeliveryFailedMessage,
				canResend: true,
				tone: 'error',
				indicator: 'failed',
				includeHelp: true,
			})
		case 'delivered':
			return describeDelivery({
				headline: 'Verification email delivered',
				detail:
					'The message reached your mailbox. Check your inbox and spam folder for the link.',
				canResend: true,
				tone: 'info',
				indicator: 'delivered',
			})
		case 'deferred':
			return describeDelivery({
				headline: 'Verification email delayed',
				detail:
					'Your mailbox provider delayed the message. Wait a bit, or resend if it still has not arrived.',
				canResend: true,
				tone: 'info',
				indicator: 'delayed',
			})
		case 'accepted':
			return describeDelivery({
				headline: 'Waiting for delivery confirmation',
				detail: emailVerificationDeliveryWaitingDetail,
				canResend: true,
				tone: 'info',
				indicator: 'waiting',
			})
		default: {
			const exhaustive: never = delivery.status
			void exhaustive
			return describeDelivery({
				headline: 'Waiting for delivery confirmation',
				detail: emailVerificationDeliveryWaitingDetail,
				canResend: true,
				tone: 'info',
				indicator: 'waiting',
			})
		}
	}
}

/** Keep polling while Cloudflare may still emit a lifecycle update. */
export function shouldPollEmailVerificationDelivery(
	delivery: EmailVerificationDelivery | null,
) {
	const indicator = describeEmailVerificationDelivery(delivery).indicator
	return indicator === 'waiting' || indicator === 'delayed'
}
