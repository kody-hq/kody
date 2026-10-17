import { expect, test } from 'vitest'
import {
	createUniqueTestUser,
	getSharedMcpE2eServer,
} from '../../../tools/mcp-test-support.ts'
import { loginToApp } from '../../../tools/mcp-oauth-client.ts'

async function readDocument(path: string, cookie?: string) {
	const server = await getSharedMcpE2eServer()
	const response = await fetch(new URL(path, server.origin), {
		headers: cookie ? { Cookie: cookie } : {},
		redirect: 'manual',
	})
	const html = (await response.text())
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
	return { response, html }
}

test('native token error documents retain status and actionable recovery', async () => {
	for (const [path, marker] of [
		['/verify-email', 'Verification token is required.'],
		['/verify-email-destination', 'Resend from email inbox'],
		['/unsubscribe/tips', 'Unsubscribe token is required.'],
	] as const) {
		const { response, html } = await readDocument(path)
		expect(response.status).toBe(400)
		expect(html).toContain(marker)
		expect(html).not.toContain('data-testid="internal-error-page"')
	}
})

test('native secret connection redirects preserve prefill and destination authentication', async () => {
	const server = await getSharedMcpE2eServer()
	const legacyPath =
		'/connect/secret-set?name=exampleApiKey&allowedHosts=api.example.com'
	const creationPath =
		'/connect/credential?kind=secret&name=exampleApiKey&allowedHosts=api.example.com'
	const legacyAnonymous = await readDocument(legacyPath)
	expect(legacyAnonymous.response.status).toBe(302)
	expect(legacyAnonymous.response.headers.get('Location')).toBe(creationPath)
	for (const path of [
		'/connect/secrets',
		'/account/credentials',
		creationPath,
	]) {
		const { response } = await readDocument(path)
		expect(response.status, `Anonymous document ${path}`).toBe(302)
		const login = new URL(response.headers.get('Location')!, server.origin)
		expect(login.pathname).toBe('/login')
		expect(login.searchParams.get('redirectTo')).toBe(path)
	}
	const user = createUniqueTestUser()
	await server.ensureUser(user)
	const cookie = await loginToApp(server.origin, user)
	const legacy = await readDocument(legacyPath, cookie)
	expect(legacy.response.status).toBe(302)
	expect(legacy.response.headers.get('Location')).toBe(creationPath)
	const list = await readDocument('/account/credentials?kind=key', cookie)
	expect(
		list.response.status,
		'/account/credentials authenticated redirect',
	).toBe(302)
	expect(list.response.headers.get('Location')).toBe(
		`/@${user.username}/-/credentials?kind=key`,
	)
	expect(list.response.headers.get('Cache-Control')).toContain('no-store')
	const creation = await readDocument(creationPath, cookie)
	expect(creation.response.status).toBe(302)
	const destination = `/@${user.username}/-/credentials/new?kind=secret&name=exampleApiKey&allowedHosts=api.example.com`
	expect(creation.response.headers.get('Location')).toBe(destination)
	const { response, html } = await readDocument(destination, cookie)
	expect(response.status).toBe(200)
	expect(html).toContain('exampleApiKey')
	expect(html).toContain('api.example.com')
	expect(html).toContain('Add a key')
	expect(html).toContain('Save key')
	expect(html).not.toContain('data-testid="internal-error-page"')
	const prefilled = await readDocument(
		`/@${user.username}/-/secrets/new?name=exampleApiKey&allowedHosts=api.example.com`,
		cookie,
	)
	expect(prefilled.response.status).toBe(302)
	expect(prefilled.response.headers.get('Location')).toBe(destination)
	const richPrefill = new URLSearchParams({
		name: 'billingKey',
		provider: 'stripe',
		description: 'Billing access',
		allowedHosts: 'api.stripe.com,uploads.stripe.com',
		expiresAt: '2026-12-31',
		allowedPackages: 'pkg-one,pkg-two',
		forPackage: 'billing-package',
		need: 'apiKey',
		org: 'other-org',
	})
	const rich = await readDocument(
		`/@${user.username}/-/secrets/new?${richPrefill}`,
		cookie,
	)
	expect(rich.response.status).toBe(302)
	const redirected = new URL(
		rich.response.headers.get('Location')!,
		server.origin,
	)
	expect(redirected.pathname).toBe(`/@${user.username}/-/credentials/new`)
	for (const [key, value] of richPrefill) {
		if (key !== 'org') expect(redirected.searchParams.get(key), key).toBe(value)
	}
	expect(redirected.searchParams.get('kind')).toBe('secret')
	expect(redirected.searchParams.has('hosts')).toBe(false)
	expect(redirected.searchParams.has('org')).toBe(false)
	const bare = await readDocument(`/@${user.username}/-/secrets/new`, cookie)
	expect(bare.response.status).toBe(200)
	expect(bare.html).toContain('Secrets')
	const approval = await readDocument(
		'/connect/secrets?name=exampleApiKey&hosts=api.example.com',
		cookie,
	)
	expect(approval.response.status).toBe(200)
	expect(approval.html).toContain('Allow secret hosts')
})

test('native anonymous onboarding renders every wizard step and canonicalizes invalid choices', async () => {
	for (const path of [
		'/onboarding/step-1',
		'/onboarding/step-2',
		'/onboarding/step-3',
		'/onboarding/step-3/claude-code',
	]) {
		const { response, html } = await readDocument(path)
		expect(response.status).toBe(200)
		expect(html).toContain('<h1')
		expect(html).not.toContain('data-testid="internal-error-page"')
		if (path === '/onboarding/step-1') {
			for (const marker of [
				'onboarding-steps-nav',
				'onboarding-agent-picker',
				'onboarding-join-discord',
				'onboarding-step-2',
			])
				expect(html).toContain(marker)
			const positions = [
				'onboarding-steps-nav',
				'onboarding-agent-picker',
				'onboarding-join-discord',
			].map((marker) => html.indexOf(marker))
			expect(positions).toEqual([...positions].sort((a, b) => a - b))
			expect(html).toContain('href="/onboarding/step-2"')
		}
	}
	for (const [path, destination] of [
		['/onboarding', '/onboarding/step-1'],
		['/onboarding?redirectTo=%2F', '/onboarding/step-1?redirectTo=%2F'],
		['/onboarding/step-1/nope', '/onboarding/step-1'],
		['/onboarding/step-2/not-listed', '/onboarding/step-2'],
		[
			'/onboarding/step-3/not-listed?redirectTo=%2F',
			'/onboarding/step-3?redirectTo=%2F',
		],
	] as const) {
		const { response } = await readDocument(path)
		expect(response.status).toBe(307)
		const location = new URL(
			response.headers.get('Location')!,
			'https://example.com',
		)
		expect(location.pathname + location.search).toBe(destination)
	}
})
