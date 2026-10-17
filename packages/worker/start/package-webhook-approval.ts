import { buildCredentialApprovalHref } from '#universal/credential-contracts.ts'

/** Website links use the verified package identity, never an external response origin. */
export function packageWebhookApprovalHref(input: {
	username: string
	kodyId: string
	webhookName: string
	endpointId?: string | null
	approvalUrl: string | null
}) {
	if (!input.approvalUrl) return null
	return buildCredentialApprovalHref({
		username: input.username,
		kodyId: input.kodyId,
		changes: [],
		enable: [
			{
				kind: 'webhook',
				name: input.webhookName,
				...(input.endpointId ? { endpointId: input.endpointId } : {}),
			},
		],
	})
}
