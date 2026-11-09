import type { Page } from '@playwright/test'
import { readE2eCloudflareMockState } from '../tools/e2e-cloudflare-mock-state.ts'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'

// Changing the client ID of an app behind a live connection must ask first:
// replace the app explicitly, or save a separate app + connection.
async function connectRehearsal(input: {
	page: Page
	provider: string
	clientId: string
	authorizedClientIds: Array<string>
	beforeSave?: () => Promise<void>
}) {
	const { page, provider } = input
	const mock = readE2eCloudflareMockState()
	const authorizeUrl = `${mock.origin}/__mocks/rehearsal/oauth/authorize`
	await page.route(`${authorizeUrl}?**`, async (route) => {
		const authorization = new URL(route.request().url())
		input.authorizedClientIds.push(
			authorization.searchParams.get('client_id') ?? '',
		)
		const callback = new URL(authorization.searchParams.get('redirect_uri')!)
		callback.searchParams.set('code', `rehearsal-code-${crypto.randomUUID()}`)
		callback.searchParams.set('state', authorization.searchParams.get('state')!)
		await route.fulfill({ status: 302, headers: { location: callback.href } })
	})
	const configuration = new URLSearchParams({
		provider,
		authorizeUrl,
		tokenUrl: `${mock.origin}/__mocks/rehearsal/oauth/token`,
		flow: 'confidential',
		allowedHosts: new URL(mock.origin).hostname,
	})
	await page.goto(`/connect/oauth?${configuration}`)
	await waitForClientHydration(page)
	// Existing connections land on the connect step. Open setup first.
	const edit = page.getByRole('button', { name: 'Edit app credentials' })
	const clientIdField = page.locator('input[name="oauthClientId"]')
	await expect(edit.or(clientIdField)).toBeVisible()
	if (await edit.isVisible()) await edit.click()
	await expect(clientIdField).toBeVisible()
	await clientIdField.fill(input.clientId)
	// A stored secret is bound to the saved client ID. Changing the ID
	// reveals the secret field; a one-shot isVisible() loses that React
	// render and token exchange then fails with "No saved client secret
	// matches this client ID and token URL."
	const secretField = page.locator('input[name="oauthClientSecret"]')
	await expect(secretField).toBeVisible()
	await secretField.fill('rehearsal-secret')
	await input.beforeSave?.()
	await page.getByRole('button', { name: 'Save and continue' }).click()
}

async function finishConnect(page: Page, name: string) {
	await page.getByRole('button', { name: `Continue to ${name}` }).click()
	const connected = page.getByText("You're connected.", { exact: true })
	const missingSecret = page.getByText(
		'No saved client secret matches this client ID and token URL',
	)
	await expect(connected.or(missingSecret)).toBeVisible({
		timeout: 20_000,
	})
	await expect(missingSecret).toHaveCount(0)
	await expect(connected).toBeVisible()
	await page.unrouteAll({ behavior: 'ignoreErrors' })
}

test('a changed client ID on a live connection warns, then saves as a new connection or replaces explicitly', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const id = crypto.randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `oauth-live-${id}@example.com`,
		username: `oauth-live-${id}`,
	})
	await login({ ...user, mode: 'login' })
	const provider = `rehearsal-${id}`
	const authorizedClientIds: Array<string> = []

	await connectRehearsal({
		page,
		provider,
		clientId: 'rehearsal-client',
		authorizedClientIds,
	})
	await finishConnect(page, provider)

	// Save as a new connection: nothing is saved until a name is chosen.
	await connectRehearsal({
		page,
		provider,
		clientId: 'rehearsal-client-b',
		authorizedClientIds,
	})
	const warning = page.getByTestId('connect-live-replace-warning')
	await expect(warning).toBeVisible()
	await expect(warning).toContainText(`${provider} is connected through the`)
	await expect(warning).toContainText('stops working until you reconnect it')
	await warning
		.getByRole('button', { name: 'Save as a new connection' })
		.click()
	const nameField = warning.locator('input[name="newConnectionName"]')
	await expect(nameField).toHaveValue(`${provider}-2`)
	await nameField.fill(provider.toUpperCase())
	await warning.getByRole('button', { name: 'Save as new connection' }).click()
	await expect(warning).toContainText(`Pick a name other than ${provider}.`)
	await nameField.fill(`${provider}-2`)
	await page.locator('input[name="oauthClientSecret"]').fill('rehearsal-secret')
	await warning.getByRole('button', { name: 'Save as new connection' }).click()
	await finishConnect(page, `${provider}-2`)

	await page.goto(`/@${user.username}/-/credentials?kind=oauth`)
	const credentials = page.getByRole('region', {
		name: 'Credentials',
		exact: true,
	})
	await expect(
		credentials.getByRole('link', { name: new RegExp(`^${provider}\\b`) }),
	).toHaveCount(2)

	// Replace this app: explicit, keeps today's in-place behavior.
	await connectRehearsal({
		page,
		provider,
		clientId: 'rehearsal-client-c',
		authorizedClientIds,
	})
	await expect(warning).toBeVisible()
	await warning.getByRole('button', { name: 'Replace this app' }).click()
	await expect(warning).toBeHidden()
	await finishConnect(page, provider)
	expect(authorizedClientIds).toEqual([
		'rehearsal-client',
		'rehearsal-client-b',
		'rehearsal-client-c',
	])
})
