import {
	guestClaimCapabilityName,
	guestClaimFinishCapabilityName,
} from '#worker/guest/guest-accounts.ts'

export type GuestErrorCode = 'guest_not_allowed' | 'guest_claim_required'

export type GuestErrorPayload = {
	error: GuestErrorCode
	error_description: string
	claim_url: string | null
	claim_capability: string
	claim_finish_capability: string
}

const claimHint =
	`Claim the account to keep everything: open the claim link, or ask the agent to run the ${guestClaimCapabilityName} capability ` +
	`with the person's email (Kody emails a one-time code), then ${guestClaimFinishCapabilityName} with that code.`

export function guestErrorPayload(input: {
	code: GuestErrorCode
	blocked: string
	claimUrl: string | null
}): GuestErrorPayload {
	const lead =
		input.code === 'guest_claim_required'
			? `This guest account's 24 hours of full access are over, so ${input.blocked} is read-only until it is claimed.`
			: `Guest accounts can't ${input.blocked}.`
	return {
		error: input.code,
		error_description: `${lead} ${claimHint}${input.claimUrl ? ` Claim link: ${input.claimUrl}` : ''}`,
		claim_url: input.claimUrl,
		claim_capability: guestClaimCapabilityName,
		claim_finish_capability: guestClaimFinishCapabilityName,
	}
}

export class GuestRestrictionError extends Error {
	readonly payload: GuestErrorPayload
	constructor(payload: GuestErrorPayload) {
		super(payload.error_description)
		this.name = 'GuestRestrictionError'
		this.payload = payload
	}
	get code() {
		return this.payload.error
	}
}

export function createGuestErrorResponse(payload: GuestErrorPayload) {
	return Response.json(payload, { status: 403 })
}
