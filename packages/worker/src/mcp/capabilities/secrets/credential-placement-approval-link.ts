import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { secretPageOrgSlugFromCaller } from '#mcp/secrets/package-approval-url.ts'
import { readStoredCredentialPlacement } from '#worker/credentials/credential-fields.ts'
import { effectiveFillPlacement } from '#worker/credentials/fill-placement-enforcement.ts'
import { readFillPlacementOptIn } from '#worker/credentials/fill-placement-opt-ins.ts'
import { buildCredentialPlacementApprovalUrl } from '#worker/credentials/placement-approval-links.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	formatPlacementApprovalParts,
	placementApprovalParts,
} from '#universal/credential-placement-approval.ts'
import { authorizeSecret } from './authorize-secret.ts'

const placementSchema = z
	.object({
		headers: z.union([z.literal(true), z.array(z.string())]).optional(),
		query: z.literal(true).optional(),
		path: z.literal(true).optional(),
		body: z.literal(true).optional(),
	})
	.nullable()

export const credentialPlacementApprovalLinkCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'credentialPlacementApprovalLink',
		contextRuns: 'allow',
		orgPermission: 'none',
		description:
			'Build the owner-approval link that lets a saved user Key (secret) be filled into the request query, URL path, or body, for example a body-auth API like Plaid. Returns `approval_url` (`/connect/secrets?name=…&placement=…`, optionally with `hosts` to approve in the same click). It never changes placement: the owner must open the link, read the warning that the host may store the value, and approve. Show the link to the owner and stop; retry only after they approve. Use it when a fetch fails with credential_placement_refused for the query, path, or body (that error already carries the same link). Needs Use on the credential.',
		keywords: [
			'credential',
			'secret',
			'placement',
			'body',
			'query',
			'path',
			'approval',
			'credential_placement_refused',
			'fill placement',
			'opt-in',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			name: z
				.string()
				.min(1)
				.describe('The saved user Key (secret) name, as in {{secret:name}}.'),
			parts: z
				.array(z.enum(placementApprovalParts))
				.min(1)
				.describe(
					'Request parts to ask the owner to allow: query, path (URL path), and/or body. Headers never need approval.',
				),
			hosts: z
				.array(z.string())
				.max(20)
				.optional()
				.describe(
					'Hosts the request goes to. Hosts not yet allowed are approved in the same click; allowed ones are shown as allowed.',
				),
		}),
		outputSchema: z.object({
			name: z.string(),
			status: z
				.enum(['approval_required', 'already_allowed'])
				.describe(
					'already_allowed: the credential can already fill every requested part.',
				),
			approval_url: z
				.string()
				.describe('Link for the owner to open. Never treat it as a grant.'),
			pending_parts: z.array(z.enum(placementApprovalParts)),
			placement: placementSchema.describe(
				'The stored placement now. Null means not set (headers plus parts used before enforcement).',
			),
			message: z.string(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const name = args.name.trim()
			await authorizeSecret(ctx, 'secret:use', { name, scope: 'user' })
			const stored = await readStoredCredentialPlacement({
				db: ctx.env.APP_DB,
				orgId: ownerIdFromCaller(ctx.callerContext),
				name,
			})
			if (!stored) {
				throw new McpCallerError(
					`No saved user Key named "${name}" in this org. Save it first (send the owner to /connect/secret-set), then request placement.`,
				)
			}
			const optIn = await readFillPlacementOptIn(ctx.env.APP_DB, stored.id)
			const effective = effectiveFillPlacement(stored.placement, optIn) ?? {}
			const parts = placementApprovalParts.filter((part) =>
				args.parts.includes(part),
			)
			const pendingParts = parts.filter((part) => effective[part] !== true)
			const approvalUrl = buildCredentialPlacementApprovalUrl({
				baseUrl: ctx.callerContext.baseUrl,
				names: [name],
				parts,
				hosts: args.hosts ?? [],
				orgSlug: secretPageOrgSlugFromCaller(ctx.callerContext),
				credentialId: stored.id,
			})
			const label = formatPlacementApprovalParts(parts)
			return {
				name,
				status:
					pendingParts.length === 0
						? ('already_allowed' as const)
						: ('approval_required' as const),
				approval_url: approvalUrl,
				pending_parts: pendingParts,
				placement: stored.placement,
				message:
					pendingParts.length === 0
						? `"${name}" can already fill the request ${label}. If a host is still missing, the owner can approve it at the same link.`
						: `Ask the owner to open ${approvalUrl} and approve filling "${name}" into the request ${formatPlacementApprovalParts(pendingParts)}. Only the owner can approve it; do not retry until they do.`,
			}
		},
	},
)
