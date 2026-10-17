import { QueryClient } from '@tanstack/react-query'
import { expect, test } from 'vitest'
import { invalidateCredentialResources } from './credential-mutation.ts'

test('credential approval refreshes every dependent read only for its submitting actor and org', async () => {
	const client = new QueryClient()
	const resources = [
		'loadCredentialsPage',
		'loadPackageCredentialsPage',
		'loadSecretsPage',
		'loadIntegrationsPage',
		'loadJobsPage',
		'loadWorkflowsPage',
		'loadWebhooksPage',
	]
	const matching = resources.map((resource) => [
		'page',
		'actor-a',
		resource,
		resource === 'loadPackageCredentialsPage'
			? { username: 'acme', kodyId: 'package' }
			: { orgSlug: 'acme' },
	])
	const typed = ['page', 'actor-a', 'loadCredentialsPage', { orgSlug: 'acme' }]
	const unrelated = [
		['page', 'actor-b', 'loadCredentialsPage', { orgSlug: 'acme' }],
		['page', 'actor-a', 'loadCredentialsPage', { username: 'other' }],
		['page', 'actor-a', 'loadCredentialsPage', { orgSlug: 'other' }],
		['page', 'actor-a', 'loadCredentialsPage', {}],
		['page', 'actor-a', 'loadDocs', '/docs'],
	]
	for (const key of [...matching, typed, ...unrelated])
		client.setQueryData(key, { ok: true })
	try {
		await invalidateCredentialResources(client, 'actor-a', 'acme')
		for (const key of [...matching, typed])
			expect(client.getQueryState(key)?.isInvalidated).toBe(true)
		for (const key of unrelated)
			expect(client.getQueryState(key)?.isInvalidated).toBe(false)
	} finally {
		client.clear()
	}
})
