import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { loadAdminOauthConnectionHosts } from '#worker/admin/oauth-connection-hosts.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

const inputSchema = z
	.object({
		orgId: stableUserIdSchema
			.optional()
			.describe('Org id (orgs.id; a personal org id equals stable_user_id).'),
		org: z
			.string()
			.min(1)
			.optional()
			.describe('Org slug / handle, with or without "@".'),
		provider: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.optional()
			.describe(
				'Only connections whose provider or name equals this, case-insensitively (for example "dropbox").',
			),
	})
	.refine(
		(value) => (value.orgId === undefined) !== (value.org === undefined),
		{ message: 'Provide exactly one of orgId or org.' },
	)

const hostList = z.array(z.string())

const outputSchema = z.object({
	org: z.object({ id: z.string(), slug: z.string() }),
	connections: z.array(
		z.object({
			credentialId: z.string().nullable(),
			name: z.string(),
			provider: z.string().nullable(),
			lane: z
				.enum(['user', 'platform'])
				.describe('user: the org registered its own OAuth app.'),
			tokenHost: z
				.string()
				.nullable()
				.describe('Host of the app token URL (where tokens are minted).'),
			apiBaseHost: z
				.string()
				.nullable()
				.describe('Host of the app API base URL, always allowed.'),
			hosts: hostList.describe(
				'Stored required hosts of the connection (user_integrations.required_hosts_json).',
			),
			appHosts: hostList.describe(
				'Hosts a built-in (platform) app always allows.',
			),
			connected: z.boolean().describe('True when an access token is stored.'),
			connectedAt: z.string().nullable(),
			authFailedAt: z.string().nullable(),
			updatedAt: z.string(),
		}),
	),
	truncated: z.boolean().describe('True when more than 200 matched.'),
})

export const adminOauthConnectionHostsListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminOauthConnectionHostsList',
		contextRuns: 'deny',
		description:
			'List one org’s live OAuth connections with the hosts each may be sent to (stored hosts, API base host, built-in app hosts), token host, lane, and connection status. For support checks such as a connection missing an upload host. Never returns a token, client id, or any credential value. Admin-only; audited.',
		keywords: [
			'admin',
			'oauth',
			'connection',
			'integration',
			'hosts',
			'allowed hosts',
			'required hosts',
			'support',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminOauthConnectionHostsList',
				async () =>
					loadAdminOauthConnectionHosts({
						db: ctx.env.APP_DB,
						target: { orgId: args.orgId, org: args.org },
						provider: args.provider,
					}),
				{
					successReason: (result) =>
						`org_id=${result.org.id};provider=${args.provider ?? '*'};returned=${String(result.connections.length)}`,
				},
			)
		},
	},
)
