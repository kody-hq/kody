/**
 * soft-delete-read-filter: opt-out. The MCP hub backfill also visits owners
 * whose mcp_server_settings rows are soft-deleted, since their hub storage
 * persists until purge.
 */
import { z } from 'zod'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { sealPlaintextTotpSecrets } from '#worker/identity/two-factor.ts'
import { sealPlaintextGuestClaimCodes } from '#worker/guest/guest-accounts.ts'
import type { McpOAuthStorageBackfillResult } from '#worker/mcp-client/sealed-oauth-storage.ts'
import { mcpClientHubDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const targets = [
	'totp_secrets',
	'guest_claim_codes',
	'mcp_client_oauth',
] as const
const limitDefault = 100
const limitMax = 500

const inputSchema = z.object({
	target: z.enum(targets),
	dryRun: z
		.boolean()
		.optional()
		.describe('When true (default), count plaintext rows without writing.'),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe('Resume after this cursor from a prior nextCursor.'),
	limit: z.number().int().min(1).max(limitMax).optional(),
})

const count = z.number().int().nonnegative()

const outputSchema = z.object({
	target: z.enum(targets),
	dryRun: z.boolean(),
	scanned: count,
	sealed: count,
	remainingPlaintext: count,
	hubsScanned: count.optional(),
	nextCursor: z.string().nullable(),
})

type HubBackfillStub = {
	sealLegacyOAuthStorage(input: {
		dryRun: boolean
	}): Promise<McpOAuthStorageBackfillResult>
}

async function runMcpClientOAuthBackfill(input: {
	env: Env
	dryRun: boolean
	cursor: string | null
	limit: number
}) {
	const owners = await input.env.APP_DB.prepare(
		`SELECT DISTINCT user_id FROM mcp_server_settings
		 WHERE user_id > ? ORDER BY user_id LIMIT ?`,
	)
		.bind(input.cursor ?? '', input.limit)
		.all<{ user_id: string }>()
	const page = owners.results ?? []
	const totals = { scanned: 0, sealed: 0, remainingPlaintext: 0 }
	for (const owner of page) {
		const namespace = input.env.MCP_CLIENT_HUB
		const hub = namespace.get(
			namespace.idFromName(
				mcpClientHubDurableObjectName(ownerIdFromStored(owner.user_id)),
			),
		) as unknown as HubBackfillStub
		const result = await hub.sealLegacyOAuthStorage({ dryRun: input.dryRun })
		totals.scanned += result.scanned
		totals.sealed += result.sealed
		totals.remainingPlaintext += result.remainingPlaintext
	}
	return {
		...totals,
		hubsScanned: page.length,
		nextCursor:
			page.length < input.limit ? null : (page.at(-1)?.user_id ?? null),
	}
}

export const adminPlaintextSecretBackfillCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		destructive: false,
		idempotent: true,
		name: 'adminPlaintextSecretBackfill',
		contextRuns: 'deny',
		description:
			'Seal secrets written before at-rest encryption. target totp_secrets seals verifications.secret for 2fa rows; guest_claim_codes replaces guest_accounts.claim_code with its lookup hash plus a sealed copy; mcp_client_oauth seals MCP client OAuth tokens, client secrets, and PKCE verifiers in each MCP client hub that has any mcp_server_settings row, including soft-deleted ones. dryRun (default true) writes nothing. Each row is a compare-and-swap, so reruns are safe. remainingPlaintext is table-wide for D1 targets and the sum over this page of hubs for mcp_client_oauth. One page per execute; resume with nextCursor until null.',
		keywords: [
			'admin',
			'backfill',
			'encrypt',
			'seal',
			'totp',
			'guest',
			'oauth',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const dryRun = args.dryRun !== false
			const limit = args.limit ?? limitDefault
			const cursor = args.cursor ?? null
			return auditAdminCapabilityInvocation(
				ctx,
				'adminPlaintextSecretBackfill',
				async () => {
					if (args.target === 'totp_secrets') {
						const numericCursor = cursor === null ? null : Number(cursor)
						if (
							numericCursor !== null &&
							!Number.isSafeInteger(numericCursor)
						) {
							throw new Error('cursor must be an integer for totp_secrets.')
						}
						const result = await sealPlaintextTotpSecrets({
							env: ctx.env,
							dryRun,
							limit,
							cursor: numericCursor,
						})
						return {
							target: args.target,
							dryRun,
							...result,
							nextCursor:
								result.nextCursor === null ? null : String(result.nextCursor),
						}
					}
					if (args.target === 'guest_claim_codes') {
						const result = await sealPlaintextGuestClaimCodes({
							env: ctx.env,
							dryRun,
							limit,
							cursor,
						})
						return { target: args.target, dryRun, ...result }
					}
					const result = await runMcpClientOAuthBackfill({
						env: ctx.env,
						dryRun,
						cursor,
						limit,
					})
					return { target: args.target, dryRun, ...result }
				},
				{
					successReason: (result) =>
						`target=${result.target};dry_run=${result.dryRun};scanned=${result.scanned};sealed=${result.sealed};remaining=${result.remainingPlaintext}`,
				},
			)
		},
	},
)
