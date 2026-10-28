import { expect, test } from 'vitest'
import { buildPackageWebhooksHref } from '#client/routes/webhooks-shared.ts'

test('buildPackageWebhooksHref deep-links from the package owner scope', () => {
	expect(
		buildPackageWebhooksHref({
			packageName: '@team-org/ci-alerts',
			kodyId: 'ci-alerts',
			ownerUsername: 'personal-handle',
			webhookName: 'github',
			endpointId: '0a643410-53ff-40ee-aa4a-2f5eb1eb280a',
		}),
	).toBe(
		'/@team-org/ci-alerts/settings#webhook-github-0a643410-53ff-40ee-aa4a-2f5eb1eb280a',
	)
})

test('buildPackageWebhooksHref falls back to an explicit owner when the name is unscoped', () => {
	expect(
		buildPackageWebhooksHref({
			packageName: 'ci-alerts',
			kodyId: 'ci-alerts',
			ownerUsername: 'team-org',
			webhookName: 'github',
		}),
	).toBe('/@team-org/ci-alerts/settings#webhook-github')
})
