import { z } from 'zod'
import {
	oauthGrantsLackingOrgIdRevokeConfirm,
	oauthGrantsLackingOrgIdScanLimitDefault,
	oauthGrantsLackingOrgIdScanLimitMax,
	runOauthGrantsLackingOrgIdRevoke,
} from '#worker/admin/oauth-grants-lacking-org-id.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const count = z.number().int().nonnegative()

const byClientSchema = z.object({
	clientId: z.string(),
	count,
})

const failureSchema = z.object({
	grantId: z.string(),
	userId: z.string(),
	clientId: z.string(),
	error: z.string(),
})

const inputSchema = z
	.object({
		dryRun: z
			.boolean()
			.optional()
			.describe(
				'When true (default), list and count grants lacking plaintext metadata.orgId without revoking. Set false only after a dry-run, and pass confirm.',
			),
		confirm: z
			.string()
			.optional()
			.describe(
				`Required when dryRun is false. Must be exactly "${oauthGrantsLackingOrgIdRevokeConfirm}".`,
			),
		cursor: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Resume after this OAUTH_KV list cursor. Pass the previous nextCursor until complete is true.',
			),
		limit: z
			.number()
			.int()
			.min(1)
			.max(oauthGrantsLackingOrgIdScanLimitMax)
			.optional()
			.describe(
				`Grant keys to inspect in this page (default ${oauthGrantsLackingOrgIdScanLimitDefault}, max ${oauthGrantsLackingOrgIdScanLimitMax}).`,
			),
	})
	.superRefine((value, ctx) => {
		if (value.dryRun === false) {
			if (value.confirm !== oauthGrantsLackingOrgIdRevokeConfirm) {
				ctx.addIssue({
					code: 'custom',
					path: ['confirm'],
					message: `When dryRun is false, confirm must be exactly "${oauthGrantsLackingOrgIdRevokeConfirm}".`,
				})
			}
		}
	})

const outputSchema = z.object({
	dryRun: z.boolean(),
	scanned: count,
	withOrgId: count,
	lackingOrgId: count,
	revoked: count,
	usersLackingOrgId: count.describe(
		'Unique user ids among lackingOrgId grants in this page.',
	),
	byClient: z
		.array(byClientSchema)
		.describe('Lacking-orgId counts by clientId for this page.'),
	failures: z
		.array(failureSchema)
		.describe(
			'Apply-only revoke failures (grant id + reason). Empty on dry-run.',
		),
	nextCursor: z.string().nullable(),
	complete: z.boolean(),
})

export const adminOauthGrantsLackingOrgIdRevokeCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminMutationCapabilityAccess,
		idempotent: true,
		name: 'adminOauthGrantsLackingOrgIdRevoke',
		contextRuns: 'deny',
		description:
			'Teams P9 leftover (#3057): page OAUTH_KV grant:* keys and revoke MCP OAuth grants that still lack plaintext metadata.orgId. dryRun defaults to true (counts + by-client breakdown only). Apply requires confirm and revokes via OAuth helpers (idempotent; a complete second pass finds zero lacking). Audited. Never returns tokens or encrypted props.',
		keywords: [
			'admin',
			'oauth',
			'grants',
			'orgId',
			'metadata',
			'revoke',
			'cleanup',
			'P9',
			'dry run',
		],
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const dryRun = args.dryRun !== false
			return auditAdminCapabilityInvocation(
				ctx,
				'adminOauthGrantsLackingOrgIdRevoke',
				async () =>
					await runOauthGrantsLackingOrgIdRevoke({
						env: ctx.env,
						dryRun,
						cursor: args.cursor ?? null,
						limit: args.limit,
					}),
				{
					resultOf: (result) =>
						result.failures.length > 0 ? 'failure' : 'success',
					successReason: (result) =>
						`dry_run=${result.dryRun ? 1 : 0};scanned=${result.scanned};with=${result.withOrgId};lacking=${result.lackingOrgId};revoked=${result.revoked};users=${result.usersLackingOrgId};failed=${result.failures.length};complete=${result.complete ? 1 : 0}`,
				},
			)
		},
	})
