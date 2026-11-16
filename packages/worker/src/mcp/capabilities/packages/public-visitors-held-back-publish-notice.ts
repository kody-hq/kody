import { z } from 'zod'
import { buildPackageCapabilityApprovalUrl } from '#worker/package-capabilities/capability-approval-url.ts'
import { loadPublicVisitorsHeldBack } from '#worker/package-capabilities/public-visitors-held-back.ts'

export const publicVisitorsHeldBackSchema = z
	.object({
		public_commit: z
			.string()
			.describe('The approved commit public visitors still run.'),
		serving_commit: z
			.string()
			.describe('The published commit that waits for capability approval.'),
		approval_url: z.string(),
		message: z.string(),
	})
	.nullable()
	.optional()
	.describe(
		'Set when this internet-visible app now asks for more capabilities than the version approved for public visitors. Public visitors stay on public_commit until the owner approves at approval_url; members already get the new version. Null/omitted otherwise.',
	)

export type PublicVisitorsHeldBackPublishNotice = NonNullable<
	z.infer<typeof publicVisitorsHeldBackSchema>
>

export async function buildPublicVisitorsHeldBackPublishNotice(input: {
	env: Env
	baseUrl: string
	ownerUserId: string
	ownerScope: string
	packageId: string
	kodyId: string
}): Promise<PublicVisitorsHeldBackPublishNotice | null> {
	// Optional notice only: never fail a completed publish because it rejected.
	try {
		const heldBack = await loadPublicVisitorsHeldBack({
			env: input.env,
			packageId: input.packageId,
			ownerUserId: input.ownerUserId,
		})
		if (!heldBack) return null
		const approvalUrl = buildPackageCapabilityApprovalUrl({
			baseUrl: input.baseUrl,
			username: input.ownerScope,
			kodyId: input.kodyId,
		})
		return {
			public_commit: heldBack.publicCommit,
			serving_commit: heldBack.servingCommit,
			approval_url: approvalUrl,
			message: `Public visitors are still on the previous version (${heldBack.publicCommit.slice(0, 7)}) because ${heldBack.servingCommit.slice(0, 7)} asks for more capabilities. Members already get the new version. Approve to update public visitors: ${approvalUrl}`,
		}
	} catch (error) {
		console.warn(
			`[publicVisitorsHeldBack] lookup failed for ${input.ownerScope}/${input.kodyId}:`,
			error instanceof Error ? error.message : error,
		)
		return null
	}
}
