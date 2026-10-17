export type EmailVerificationOutcome =
	| {
			ok: true
			kind:
				| 'email_verify'
				| 'email_change'
				| 'email_claim_release'
				| 'email_destination'
			message: string
			ctaHref?: string
			ctaLabel?: string
	  }
	| {
			ok: false
			error: string
			kind?:
				| 'email_verify'
				| 'email_change'
				| 'email_claim_release'
				| 'email_destination'
			reason?: 'missing_token' | 'invalid_token' | 'expired_token'
			ctaHref?: string
			ctaLabel?: string
	  }

export type TipsUnsubscribeOutcome =
	| {
			ok: true
			alreadyOptedOut: boolean
			message: string
	  }
	| {
			ok: false
			error: string
	  }

/** Status and cookie metadata are applied at the HTTP boundary, never serialized. */
export type EmailVerificationResult = EmailVerificationOutcome & {
	title: string
	status?: number
	setCookie?: string
}
export type TipsUnsubscribeResult = TipsUnsubscribeOutcome & {
	title: string
	status?: number
}
