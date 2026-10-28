import { z } from 'zod'
import {
	ApprovalBundleError,
	createApprovalBundle,
} from '#worker/approval-bundles/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	approvalBundleMaxItems,
	parseApprovalItemKey,
	type ApprovalItemRef,
} from '#universal/approval-bundles.ts'
import {
	approvalItemSchema,
	approvalItemTypeSchema,
	approvalViewerForCaller,
	toApprovalItemOutput,
} from './approval-bundle-shared.ts'

function readItemKeys(keys: ReadonlyArray<string>): Array<ApprovalItemRef> {
	return keys.map((key) => {
		const ref = parseApprovalItemKey(key)
		if (!ref) {
			throw new McpCallerError(
				`"${key}" is not an approval item key. Use keys from approvalPendingList.`,
			)
		}
		return ref
	})
}

export const approvalBundleCreateCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'approvalBundleCreate',
		contextRuns: 'deny',
		orgPermission: 'none',
		description: `Make one approval page for the signed-in person from approvals waiting on them (see approvalPendingList): pass item keys, or omit them to include everything pending (narrowed by types and packages). Returns a URL to send to the person. The page groups items by package, shows what each grants, and lets them approve all at once or approve or deny each one. Approving runs each item's own approval, exactly as on its package page. This never approves anything; only the person can, in the browser. Items not waiting on the person are skipped and listed. At most ${approvalBundleMaxItems} items; the link works for 30 days.`,
		keywords: [
			'approval',
			'approvals',
			'bundle',
			'approve all',
			'credential needs',
			'publish',
			'credentials',
			'link',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			items: z
				.array(z.string().min(1))
				.max(approvalBundleMaxItems)
				.optional()
				.describe(
					'Item keys from approvalPendingList. Omit to bundle everything pending.',
				),
			types: z
				.array(approvalItemTypeSchema)
				.optional()
				.describe('When items is omitted: only these item types.'),
			packages: z
				.array(z.string().min(1))
				.optional()
				.describe(
					'When items is omitted: only these packages, by package id or kody id.',
				),
			note: z
				.string()
				.max(2000)
				.optional()
				.describe('Shown to the person as an untrusted note from you.'),
		}),
		outputSchema: z.object({
			bundleId: z.string(),
			url: z.string(),
			items: z.array(approvalItemSchema),
			skipped: z
				.array(z.string())
				.describe('Requested keys not waiting on the person, left out.'),
			message: z.string(),
		}),
		async handler(args, ctx) {
			const viewer = approvalViewerForCaller(ctx, 'create approval bundles')
			try {
				const created = await createApprovalBundle({
					viewer,
					items: args.items ? readItemKeys(args.items) : undefined,
					filter: { types: args.types, packages: args.packages },
					note: args.note ?? null,
				})
				return {
					bundleId: created.bundle.id,
					url: created.url,
					items: created.items.map(toApprovalItemOutput),
					skipped: created.skipped,
					message: `Send this link to the person to review ${created.items.length} approval${created.items.length === 1 ? '' : 's'}: ${created.url}`,
				}
			} catch (error) {
				if (error instanceof ApprovalBundleError) {
					throw new McpCallerError(error.message)
				}
				throw error
			}
		},
	},
)
