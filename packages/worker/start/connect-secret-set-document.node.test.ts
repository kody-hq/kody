import { connectSecretsInput } from './connect-input.ts'
import { expect, test } from 'vitest'
import { createElement } from 'react'
import { renderStartPage } from './test-support/render-start-page.ts'
import { ConnectSecretSetRoute } from './pages/connect-secret-set.tsx'
import { connectSecretSetQuery } from './connect-secret-set-query.ts'
import {
	absolutizeDocumentHead,
	resolveDocumentHead,
} from '#universal/document-head.ts'
async function renderConnectSecretSet(query: string) {
	const currentHref = `/connect/secret-set?${query}`
	const html = await renderStartPage(
		createElement(ConnectSecretSetRoute, { actorKey: null, currentHref }),
		currentHref,
		null,
		(client) => {
			client.setQueryData(
				connectSecretSetQuery(
					null,
					connectSecretsInput(
						new URL(currentHref, 'https://kody.local').search,
					),
				).queryKey,
				{
					payload: {
						ok: true,
						email: 'user@example.com',
						packageOptions: [],
						packages: [],
						secrets: [],
						selectedSecret: null,
						approval: null,
						approvalError: null,
					},
					head: absolutizeDocumentHead(
						resolveDocumentHead('connectSecretSet', '/connect/secret-set'),
						'https://example.com',
					),
				},
			)
		},
	)
	return { html }
}
function missing(html: string, markers: Array<string>) {
	return markers.filter((marker) => !html.includes(marker))
}

test('native Start renders the dedicated connect-secret-set page', async () => {
	const named = await renderConnectSecretSet(
		'name=exampleApiKey&description=Example%20API%20key&allowedHosts=api.example.com&scope=user',
	)
	expect(
		missing(named.html, [
			'data-testid="connect-secret-set"',
			'data-testid="connect-secret-set-card"',
			'exampleApiKey',
			'api.example.com',
		]),
	).toEqual([])
	// Named setup stays on the focused page, not the generic secrets list.
	expect(named.html).not.toContain('data-testid="account-secrets"')
	expect(named.html).not.toContain('data-testid="connect-secret-set-error"')

	const empty = await renderConnectSecretSet('')
	expect(empty.html).toContain('data-testid="connect-secret-set"')
	expect(empty.html).not.toContain('data-testid="connect-secret-set-card"')
})
