import { z } from 'zod'
import { buildPackageCapabilityApprovalUrl } from '#worker/package-capabilities/capability-approval-url.ts'
import {
	loadHeldForApproval,
	type HeldForApproval,
} from '#worker/package-capabilities/held-for-approval.ts'

export const heldForApprovalStatusDescription =
	'The new commit is built but not live. This internet-visible app now asks for more capabilities than the approved version, so everyone, members and the owner included, stays on serving_commit until the owner approves at approval_url. Approving moves everyone to held_commit. Test the new version with local dev or a dev check. Different from approval_required, which pauses a publish before it starts.'

/** What every `held_for_approval` publish result reports. */
export const heldForApprovalStatusShape = {
	serving_commit: z
		.string()
		.describe('The approved commit everyone still runs.'),
	held_commit: z
		.string()
		.describe(
			'The commit this publish built. It serves nobody until the owner approves its capabilities.',
		),
	approval_url: z
		.string()
		.describe('Owner page that approves held_commit and makes it live.'),
	message: z.string(),
}

export type HeldForApprovalPublishStatus = {
	serving_commit: string
	held_commit: string
	approval_url: string
	message: string
}

export function buildHeldForApprovalPublishStatus(input: {
	held: HeldForApproval
	baseUrl: string
	ownerScope: string
	kodyId: string
}): HeldForApprovalPublishStatus {
	const approvalUrl = buildPackageCapabilityApprovalUrl({
		baseUrl: input.baseUrl,
		username: input.ownerScope,
		kodyId: input.kodyId,
	})
	const { servingCommit, heldCommit } = input.held
	return {
		serving_commit: servingCommit,
		held_commit: heldCommit,
		approval_url: approvalUrl,
		message: `This publish is held for approval and is not live. Commit ${heldCommit.slice(0, 7)} asks for more capabilities than the approved version, so everyone is still on ${servingCommit.slice(0, 7)}. The owner approves it here: ${approvalUrl}`,
	}
}

/**
 * The held state of a package's latest publish, or null when that publish is
 * live. A failed read throws: reporting a held publish as published is worse
 * than failing the call, and a retry of the same commit reads it again.
 */
export async function loadHeldForApprovalPublishStatus(input: {
	env: Env
	baseUrl: string
	ownerUserId: string
	ownerScope: string
	packageId: string
	kodyId: string
}): Promise<HeldForApprovalPublishStatus | null> {
	const held = await loadHeldForApproval({
		env: input.env,
		packageId: input.packageId,
		ownerUserId: input.ownerUserId,
	})
	if (!held) return null
	return buildHeldForApprovalPublishStatus({
		held,
		baseUrl: input.baseUrl,
		ownerScope: input.ownerScope,
		kodyId: input.kodyId,
	})
}
