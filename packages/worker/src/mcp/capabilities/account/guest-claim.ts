import { z } from 'zod'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	guestClaimCapabilityName,
	guestClaimFinishCapabilityName,
	guestClaimUrl,
	readGuestAccountByPerson,
} from '#worker/guest/guest-accounts.ts'
import { GuestClaimError } from '#worker/guest/guest-claim.ts'
import {
	finishGuestClaim,
	GuestClaimCodeError,
	startGuestClaim,
} from '#worker/guest/guest-claim-code.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { McpCallerError } from '#mcp/caller-error.ts'

async function requireGuest(ctx: {
	env: Env
	callerContext: { user?: { userId: string } | null }
}) {
	const user = requireMcpUser(ctx.callerContext as never)
	const guest = await readGuestAccountByPerson(ctx.env.APP_DB, user.userId)
	if (!guest || guest.claimedAt) {
		throw new McpCallerError(
			'This account is not a guest account, so there is nothing to claim.',
		)
	}
	return guest
}

function asCallerError(error: unknown, claimUrl: string): never {
	if (error instanceof GuestClaimCodeError) {
		const parts = [`${error.message} (${error.code})`]
		if (error.deliveryNote) parts.push(error.deliveryNote)
		if (error.code !== 'email_invalid') {
			parts.push(
				`If the code email did not arrive, send them the claim link instead: ${claimUrl}`,
			)
		}
		throw new McpCallerError(parts.join(' '))
	}
	if (error instanceof GuestClaimError) {
		throw new McpCallerError(`${error.message} (${error.code})`)
	}
	throw error
}

export const guestClaimStartCapability = defineDomainCapability(
	capabilityDomainNames.account,
	{
		name: guestClaimCapabilityName,
		contextRuns: 'deny',
		orgPermission: 'org:read',
		description: `Guest accounts only: start claiming this guest account for the person so they keep everything. Pass their email plus a username for a new account, or merge: true to move everything into the existing Kody account that uses that email. Kody emails them a one-time code; ask them to read it to you, then call ${guestClaimFinishCapabilityName} with it. The same OAuth connection and CLI login keep working after the claim. For GitHub or Google, send them the claim_url instead.`,
		keywords: [
			'guest',
			'claim',
			'keep account',
			'sign up',
			'signup',
			'create account',
			'merge',
			'try it out',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			email: z.string().min(3).describe("The person's email address."),
			username: z
				.string()
				.optional()
				.describe('Username for a new account. Omit when merge is true.'),
			merge: z
				.boolean()
				.optional()
				.describe(
					'Move everything into the existing Kody account that uses this email.',
				),
		}),
		outputSchema: z.object({
			code_sent_to: z.string(),
			mode: z.enum(['new', 'merge']),
			code_expires_at: z.string(),
			next_step: z.string(),
			claim_url: z.string(),
			provider_message_id: z
				.string()
				.nullable()
				.describe(
					'Cloudflare Email Sending message id for the code email; null when no email went out.',
				),
			code_delivery: z
				.enum(['accepted', 'dev_code'])
				.describe(
					'accepted: the mail provider took the email; delivery to the inbox is not confirmed. dev_code: non-production, use dev_code.',
				),
			dev_code: z.string().optional(),
		}),
		async handler(args, ctx) {
			const guest = await requireGuest(ctx)
			const baseUrl = getAppBaseUrl({
				env: ctx.env,
				requestUrl: ctx.callerContext.baseUrl,
			})
			const claimUrl = guestClaimUrl(baseUrl, guest.claimCode)
			const started = await startGuestClaim({
				env: ctx.env,
				guest,
				email: args.email,
				username: args.username ?? null,
				merge: args.merge ?? false,
				requestUrl: baseUrl,
			}).catch((error: unknown) => asCallerError(error, claimUrl))
			const accepted =
				started.codeDelivery === 'accepted'
					? `Kody's mail provider accepted the code email${started.providerMessageId ? ` (message ${started.providerMessageId})` : ''}; delivery to the inbox is not confirmed yet. `
					: ''
			return {
				code_sent_to: started.email,
				mode: started.mode,
				code_expires_at: started.expiresAt,
				next_step: `${accepted}Ask the person for the 6-digit code Kody emailed to ${started.email}, then call ${guestClaimFinishCapabilityName} with it. If it has not arrived within a few minutes (check spam), send them claim_url instead.`,
				claim_url: claimUrl,
				provider_message_id: started.providerMessageId,
				code_delivery: started.codeDelivery,
				...(started.devCode ? { dev_code: started.devCode } : {}),
			}
		},
	},
)

export const guestClaimFinishCapability = defineDomainCapability(
	capabilityDomainNames.account,
	{
		name: guestClaimFinishCapabilityName,
		contextRuns: 'deny',
		orgPermission: 'org:read',
		description: `Guest accounts only: finish a claim started with ${guestClaimCapabilityName} by passing the one-time code the person read to you. A new account keeps this guest in place; a merge moves packages, memories, jobs, and run history into the existing account (clashing package names get a -guest suffix) and deletes the empty guest. This connection keeps working either way, with no new login.`,
		keywords: ['guest', 'claim', 'code', 'finish signup', 'verify', 'merge'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			code: z.string().min(4).describe('The one-time code from the email.'),
		}),
		outputSchema: z.object({
			claimed: z.literal(true),
			mode: z.enum(['new', 'merge']),
			username: z.string(),
			renamed_packages: z.array(z.object({ from: z.string(), to: z.string() })),
			account_url: z.string(),
			message: z.string(),
		}),
		async handler(args, ctx) {
			const guest = await requireGuest(ctx)
			const baseUrl = getAppBaseUrl({
				env: ctx.env,
				requestUrl: ctx.callerContext.baseUrl,
			})
			const result = await finishGuestClaim({
				env: ctx.env,
				guest,
				code: args.code,
				baseUrl,
				method: 'agent',
			}).catch((error: unknown) =>
				asCallerError(error, guestClaimUrl(baseUrl, guest.claimCode)),
			)
			return {
				claimed: true as const,
				mode: result.mode,
				username: result.username,
				renamed_packages: result.renamedPackages,
				account_url: `${baseUrl.replace(/\/+$/, '')}/account`,
				message:
					result.mode === 'merge'
						? `Claimed into ${result.username}. Everything moved over and this connection keeps working.`
						: `Claimed as ${result.username}. The $5 welcome credits are in and this connection keeps working.`,
			}
		},
	},
)
