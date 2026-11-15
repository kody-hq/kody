import { z } from 'zod'
import { buildPackageCapabilityApprovalUrl } from '#worker/package-capabilities/capability-approval-url.ts'
import { loadHeldForApproval } from '#worker/package-capabilities/held-for-approval.ts'

export const heldForApprovalSchema = z
	.object({
		serving_commit: z
			.string()
			.describe('The approved commit everyone still runs.'),
		held_commit: z
			.string()
			.describe(
				'The published commit that waits for capability approval before it serves.',
			),
		approval_url: z.string(),
		message: z.string(),
	})
	.nullable()
	.optional()
	.describe(
		'Set when this internet-visible app now asks for more capabilities than the approved version. Everyone, members and the owner included, stays on serving_commit until the owner approves at approval_url; approving moves everyone to held_commit. Test the new version with local dev or a dev check. Null/omitted otherwise.',
	)

export type HeldForApprovalPublishNotice = NonNullable<
	z.infer<typeof heldForApprovalSchema>
>

export async function buildHeldForApprovalPublishNotice(input: {
	env: Env
	baseUrl: string
	ownerUserId: string
	ownerScope: string
	packageId: string
	kodyId: string
}): Promise<HeldForApprovalPublishNotice | null> {
	// Optional notice only: never fail a completed publish because it rejected.
	try {
		const held = await loadHeldForApproval({
			env: input.env,
			packageId: input.packageId,
			ownerUserId: input.ownerUserId,
		})
		if (!held) return null
		const approvalUrl = buildPackageCapabilityApprovalUrl({
			baseUrl: input.baseUrl,
			username: input.ownerScope,
			kodyId: input.kodyId,
		})
		return {
			serving_commit: held.servingCommit,
			held_commit: held.heldCommit,
			approval_url: approvalUrl,
			message: `Everyone is still on the previous version (${held.servingCommit.slice(0, 7)}) until you approve the new capabilities that ${held.heldCommit.slice(0, 7)} asks for. Approve to update everyone: ${approvalUrl}`,
		}
	} catch (error) {
		console.warn(
			`[heldForApproval] lookup failed for ${input.ownerScope}/${input.kodyId}:`,
			error instanceof Error ? error.message : error,
		)
		return null
	}
}
