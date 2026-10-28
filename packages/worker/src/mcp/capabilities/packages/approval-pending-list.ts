import { z } from 'zod'
import { listPendingApprovalItems } from '#worker/approval-bundles/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	approvalItemSchema,
	approvalItemTypeSchema,
	approvalViewerForCaller,
	toApprovalItemOutput,
} from './approval-bundle-shared.ts'

export const approvalPendingListCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'approvalPendingList',
		contextRuns: 'allow',
		orgPermission: 'none',
		description:
			'List approvals waiting on the signed-in person in this org that they can decide: paused publishes whose credential needs changed or that make a package public, internet-visible packages whose credentials or storage changed, and credential picks proposed with credentialMappingPropose. Each item says in plain language what approving grants (credential, kind, provider, hosts) and what was approved before. Read-only; pass keys to approvalBundleCreate for one page the person approves in the browser.',
		keywords: [
			'approval',
			'approvals',
			'pending',
			'credential needs',
			'publish',
			'approve',
			'bundle',
			'credentials',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			types: z
				.array(approvalItemTypeSchema)
				.optional()
				.describe('Only these item types. Default: every type.'),
			packages: z
				.array(z.string().min(1))
				.optional()
				.describe('Only these packages, by package id or kody id.'),
		}),
		outputSchema: z.object({
			items: z.array(approvalItemSchema),
			message: z.string(),
		}),
		async handler(args, ctx) {
			const viewer = approvalViewerForCaller(ctx, 'list approvals')
			const items = await listPendingApprovalItems(viewer, {
				types: args.types,
				packages: args.packages,
			})
			return {
				items: items.map(toApprovalItemOutput),
				message:
					items.length === 0
						? 'Nothing is waiting on this person to approve.'
						: `${items.length} approval${items.length === 1 ? '' : 's'} waiting. Call approvalBundleCreate to give the person one page to review them.`,
			}
		},
	},
)
