/**
 * A webhook runs only after a person approves it, which creates their
 * enablement. Minting a URL never does; these build the approval link that
 * mint responses and refused deliveries point to.
 */
import { buildCredentialApprovalHref } from '#universal/credential-contracts.ts'
import type { EnablementRunPlan } from '#worker/enablements/run-gate.ts'
import { getOrgById } from '#worker/orgs/repo.ts'
import type { WebhookEndpointRecord } from './types.ts'

/** Absolute approval page URL that turns the webhook on; null without a slug. */
export function buildWebhookApprovalUrl(input: {
	baseUrl: string
	orgSlug: string | null
	packageKodyId: string
	webhookName: string
	/** Minted endpoint to approve; required when several URLs share the name. */
	endpointId?: string | null
}): string | null {
	if (!input.orgSlug) return null
	return new URL(
		buildCredentialApprovalHref({
			username: input.orgSlug,
			kodyId: input.packageKodyId,
			changes: [],
			enable: [
				{
					kind: 'webhook',
					name: input.webhookName,
					...(input.endpointId ? { endpointId: input.endpointId } : {}),
				},
			],
		}),
		input.baseUrl,
	).toString()
}

/**
 * The 409 a delivery gets when nothing ran: never approved (or turned off),
 * or paused because its enabler lost access. Both carry the approval link.
 */
export async function describeWebhookNotOn(input: {
	env: Env
	baseUrl: string
	endpoint: Pick<WebhookEndpointRecord, 'id' | 'userId' | 'webhookName'>
	packageKodyId: string
	plan: EnablementRunPlan
}): Promise<{ message: string; approvalUrl: string | null }> {
	const name = input.endpoint.webhookName
	const org = await getOrgById(input.env.APP_DB, String(input.endpoint.userId))
	const approvalUrl = buildWebhookApprovalUrl({
		baseUrl: input.baseUrl,
		orgSlug: org?.slug ?? null,
		packageKodyId: input.packageKodyId,
		webhookName: name,
		endpointId: input.endpoint.id,
	})
	const where = approvalUrl
		? `: ${approvalUrl}`
		: ` from package "${input.packageKodyId}"'s Credentials page.`
	const paused = input.plan.skipped.length > 0
	return {
		approvalUrl,
		message: paused
			? `Webhook "${name}" is paused because its enabler lost access, so nothing ran. It resumes once their access is back. Review it${where}`
			: `Webhook "${name}" is not approved, so nothing ran. Minting a URL does not turn a webhook on. Approve it${where}`,
	}
}
