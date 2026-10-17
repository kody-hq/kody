import { expect, test } from 'vitest'
import { createElement } from 'react'
import { renderStartPage } from './test-support/render-start-page.ts'
import { ConnectSecretsRoute } from './pages/connect-secrets.tsx'
const email = 'user@example.com'
function userSecret(name: string, allowedHosts: Array<string>) {
	return {
		id: `user:${name}`,
		name,
		scope: 'user' as const,
		description: '',
		packageId: null,
		packageTitle: null,
		allowedHosts,
		allowedPackages: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		expiresAt: null,
		ttlMs: null,
	}
}

async function renderConnectSecrets(
	query: string,
	secret: ReturnType<typeof userSecret>,
	approval: {
		requestedHosts: Array<string>
		rejectedHosts?: Array<{
			host: string
			reason: 'malformed' | 'unknown_suffix'
			message: string
		}>
	},
) {
	const html = await renderStartPage(
		createElement(ConnectSecretsRoute, {
			initialData: {
				ok: true,
				email,
				packageOptions: [],
				packages: [],
				secrets: [secret],
				selectedSecret: null,
				approval: {
					name: secret.name,
					names: [secret.name],
					scope: 'user',
					requestedHost: approval.requestedHosts[0]!,
					requestedHosts: approval.requestedHosts,
					rejectedHosts: approval.rejectedHosts ?? [],
					requestedPackageId: null,
					currentAllowedHosts: secret.allowedHosts,
					currentAllowedPackages: [],
				},
				approvalError: null,
			},
		}),
		`/connect/secrets?${query}`,
	)
	return { html }
}

function missing(html: string, markers: Array<string>) {
	return markers.filter((marker) => !html.includes(marker))
}

test('native Start renders the dedicated connect-secrets approval page', async () => {
	const { html } = await renderConnectSecrets(
		'name=googleAccessToken&hosts=gmail.googleapis.com,oauth2.googleapis.com',
		userSecret('googleAccessToken', ['oauth2.googleapis.com']),
		{ requestedHosts: ['gmail.googleapis.com', 'oauth2.googleapis.com'] },
	)
	expect(
		missing(html, [
			'data-testid="connect-secrets"',
			'gmail.googleapis.com',
			'oauth2.googleapis.com',
			'Allow all 2 hosts',
		]),
	).toEqual([])
	expect(html).not.toContain('New secret')
})

test('native Start flags invalid connect-secrets hosts instead of offering Allow all', async () => {
	const { html } = await renderConnectSecrets(
		'names=slackWebhookPath,openaiApiKey&hosts=hooks.slack.com,api.ope',
		userSecret('openaiApiKey', []),
		{
			requestedHosts: ['hooks.slack.com'],
			rejectedHosts: [
				{
					host: 'api.ope',
					reason: 'unknown_suffix',
					message:
						"This host doesn't look complete (unknown public suffix). The approval link may have been truncated — copy it again.",
				},
			],
		},
	)
	expect(
		missing(html, [
			'data-testid="connect-secrets"',
			'hooks.slack.com',
			'api.ope',
			'data-testid="connect-secrets-rejected-hosts"',
			'Allow access',
		]),
	).toEqual([])
	expect(html).not.toContain('Allow all 2 hosts')
})
