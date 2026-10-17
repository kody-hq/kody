import { expect, test } from 'vitest'
import { packageWebhookApprovalHref } from './package-webhook-approval.ts'
import { buildCredentialApprovalHref } from '#universal/credential-contracts.ts'

test.each([
	'https://kody.codes/approval',
	'https://other.example/approval',
	'//other.example/path',
	'javascript:alert(1)',
])(
	'website approval uses verified identity rather than protocol URL %s',
	(approvalUrl) => {
		const href = packageWebhookApprovalHref({
			username: 'team',
			kodyId: 'demo',
			webhookName: 'event/one',
			endpointId: 'endpoint-staging',
			approvalUrl,
		})
		expect(href).toBe(
			buildCredentialApprovalHref({
				username: 'team',
				kodyId: 'demo',
				changes: [],
				enable: [
					{
						kind: 'webhook',
						name: 'event/one',
						endpointId: 'endpoint-staging',
					},
				],
			}),
		)
		expect(href).toMatch(/^\/@team\/demo\//)
		expect(new URL(href!, 'https://preview.example').origin).toBe(
			'https://preview.example',
		)
	},
)

test('an unavailable approval remains unavailable', () => {
	expect(
		packageWebhookApprovalHref({
			username: 'team',
			kodyId: 'demo',
			webhookName: 'event',
			approvalUrl: null,
		}),
	).toBeNull()
})
