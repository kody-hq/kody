import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	guestClaimCapabilityName,
	guestClaimUrl,
	guestPhase,
	guestReminderWindowMs,
	readGuestAccountByPerson,
} from '#worker/guest/guest-accounts.ts'

export type GuestResultBlock = {
	status: 'active' | 'read_only'
	full_access_until: string
	time_left: string
	delete_at: string
	claim_url: string
	claim_capability: string
	remind_now: boolean
	guidance: string
}

export function formatGuestTimeLeft(ms: number) {
	if (ms <= 0) return '0 minutes'
	const totalMinutes = Math.ceil(ms / 60_000)
	const hours = Math.floor(totalMinutes / 60)
	const minutes = totalMinutes % 60
	if (hours === 0) return `${minutes} minute${minutes === 1 ? '' : 's'}`
	if (minutes === 0) return `${hours} hour${hours === 1 ? '' : 's'}`
	return `${hours} hour${hours === 1 ? '' : 's'} ${minutes} minute${minutes === 1 ? '' : 's'}`
}

export const guestAgentGuidance =
	'This person is using a guest account. Show them the claim link once at the start, and again when 2 hours of full access are left (remind_now is true). ' +
	`When they want to keep the account, offer to claim it for them with the ${guestClaimCapabilityName} capability.`

export async function buildGuestResultBlock(input: {
	db: D1Database
	callerContext: McpCallerContext
	now?: Date
}): Promise<GuestResultBlock | null> {
	const user = input.callerContext.user
	if (!user?.guestExpiresAt) return null
	const guest = await readGuestAccountByPerson(input.db, user.userId)
	if (!guest) return null
	const now = input.now ?? new Date()
	const msLeft = Date.parse(guest.expiresAt) - now.getTime()
	const phase = guestPhase(guest.expiresAt, now)
	return {
		status: phase === 'active' ? 'active' : 'read_only',
		full_access_until: guest.expiresAt,
		time_left: formatGuestTimeLeft(msLeft),
		delete_at: guest.deleteAt,
		claim_url: guestClaimUrl(input.callerContext.baseUrl, guest.claimCode),
		claim_capability: guestClaimCapabilityName,
		remind_now: phase === 'hold' || msLeft <= guestReminderWindowMs,
		guidance: guestAgentGuidance,
	}
}

/** Adds the guest block to a search or execute tool result. */
export async function attachGuestResultBlock<
	Response extends {
		content?: Array<unknown>
		structuredContent?: Record<string, unknown>
	},
>(
	response: Response,
	input: { db: D1Database; callerContext: McpCallerContext },
): Promise<Response> {
	if (!input.callerContext.user?.guestExpiresAt) return response
	const guest = await buildGuestResultBlock(input).catch((error: unknown) => {
		console.warn('guest-result-block-failed', error)
		return null
	})
	if (!guest) return response
	return {
		...response,
		...(response.content
			? {
					content: [
						...response.content,
						{ type: 'text', text: formatGuestResultText(guest) },
					],
				}
			: {}),
		structuredContent: { ...response.structuredContent, guest },
	}
}

/** Text form of the guest block, for clients that only read text parts. */
export function formatGuestResultText(guest: GuestResultBlock) {
	const status =
		guest.status === 'active'
			? `Guest account: full access for ${guest.time_left} more (until ${guest.full_access_until}).`
			: `Guest account: read-only until claimed. It is deleted at ${guest.delete_at}.`
	return `${status} Claim link: ${guest.claim_url}\n${guest.guidance}`
}
