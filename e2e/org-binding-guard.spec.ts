import { expect, test, waitForClientHydration } from './playwright-utils.ts'

const orgSectionApis = [
	['memories', 'memories'],
	['memories-export', 'memories'],
	['workflows', 'workflows'],
	['webhooks', 'webhooks'],
	['mcp-servers', 'mcp-servers'],
	['integrations', 'integrations'],
	['secret-providers', 'secret-providers'],
	['email', 'email'],
	['activity', 'activity'],
	['waiting', 'waiting'],
	['secrets', 'secrets'],
	['jobs', 'jobs'],
	['connected-agents', 'agents'],
] as const

test('an org the person cannot use is a 404 on every section, never their own data', async ({
	page,
	seedE2eUser,
	login,
	baseURL,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const runId = Date.now()
	const origin = new URL(baseURL ?? 'http://127.0.0.1:3847').origin
	const owner = await seedE2eUser({
		email: `org-guard-owner-${runId}@example.com`,
		username: `org-guard-owner-${runId}`,
		password: 'org-guard-owner-password',
	})
	const stranger = await seedE2eUser({
		email: `org-guard-stranger-${runId}@example.com`,
		username: `org-guard-stranger-${runId}`,
		password: 'org-guard-stranger-password',
	})
	const vault = `vault-${runId}`

	await login({ email: owner.email, password: owner.password, mode: 'login' })
	await page.goto('/account/organizations/new')
	await waitForClientHydration(page)
	await page.getByLabel('Name').fill(`Vault ${runId}`)
	await expect(page.getByLabel('Handle')).toHaveValue(vault)
	await page
		.getByRole('button', { name: 'Create organization', exact: true })
		.click()
	await page.getByRole('button', { name: 'Yes, create organization' }).click()
	await expect(page).toHaveURL(new RegExp(`/@${vault}$`))
	await page.context().clearCookies()

	await login({
		email: stranger.email,
		password: stranger.password,
		mode: 'login',
	})

	// A browser can forge the explicit organization input, but it cannot gain access.
	await page.goto(`/@${stranger.username}/-/mcp-servers/new`)
	await waitForClientHydration(page)
	let forged = false
	await page.route('**/_serverFn/**', async (route) => {
		if (
			route.request().method() !== 'POST' ||
			!route.request().postData()?.includes('orgSlug')
		)
			return route.fallback()
		const body = route.request().postDataJSON()
		function changeScope(value: unknown): void {
			if (!value || typeof value !== 'object') return
			const record = value as Record<string, unknown>
			if (record.orgSlug === stranger.username) {
				record.orgSlug = vault
				forged = true
			}
			if (Array.isArray(record.k) && Array.isArray(record.v)) {
				const index = record.k.indexOf('orgSlug')
				if (index >= 0) {
					const node = record.v[index] as { s?: string }
					if (node?.s === stranger.username) {
						node.s = vault
						forged = true
					}
				}
			}
			for (const child of Object.values(record)) changeScope(child)
		}
		changeScope(body)
		expect(forged).toBe(true)
		await route.continue({ postData: JSON.stringify(body) })
	})
	await page.locator('input[name="name"]').fill('forged-org-write')
	await page.getByLabel('Server URL').fill('http://127.0.0.1:9/mcp')
	await page
		.locator('button[type="submit"]')
		.filter({ hasText: /^Add server$/ })
		.click()
	await expect.poll(() => forged).toBe(true)
	await expect(
		page.getByText('Organization not found.', { exact: false }).first(),
	).toBeVisible()
	await page.unrouteAll({ behavior: 'wait' })

	for (const section of ['memories', 'workflows', 'webhooks', 'mcp-servers']) {
		const response = await page.goto(`/@${vault}/-/${section}`)
		expect(response?.status(), section).toBe(404)
		await expect(page).toHaveURL(`${origin}/@${vault}/-/${section}`)
		expect(response?.headers()['cache-control']).toContain('no-store')
		expect(response?.headers()['content-security-policy']).toMatch(
			/script-src[^;]*'nonce-[^']+'/,
		)
		await expect(page.getByTestId('not-found-page')).toBeVisible()
		await waitForClientHydration(page)
	}

	for (const [, section] of orgSectionApis) {
		const denied = await page.goto(`/@${vault}/-/${section}`)
		expect(denied?.status(), section).toBe(404)
		await expect(page.getByTestId('not-found-page')).toBeVisible()
	}
	for (const [, section] of orgSectionApis) {
		const own = await page.goto(`/@${stranger.username}/-/${section}`)
		expect(own?.status(), section).toBe(200)
		await expect(page.getByTestId('not-found-page')).toHaveCount(0)
	}

	const ownPage = await page.goto(`/@${stranger.username}/-/memories`)
	expect(ownPage?.status()).toBe(200)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Memories' }),
	).toBeVisible()
})
