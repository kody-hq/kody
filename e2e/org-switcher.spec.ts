import { saveKeyThroughUi } from './account-fixtures.ts'
import {
	expect,
	test,
	waitForClientHydration,
	type Page,
} from './playwright-utils.ts'

import { waitForOrgRead } from './server-function-requests.ts'

async function openSwitcher(page: Page) {
	const trigger = page.getByTestId('org-switcher')
	const panel = page.getByTestId('org-switcher-panel')
	await trigger.click()
	await expect(panel).toBeVisible()
	await expect(trigger).toHaveAttribute('aria-expanded', 'true')
	await expect
		.poll(() => panel.evaluate((node) => getComputedStyle(node).opacity))
		.toBe('1')
	return { trigger, panel }
}

test('switching orgs from Credentials loads the destination org, not the one you left', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `org-switch-secrets-${runId}@example.com`,
		username: `org-switch-secrets-${runId}`,
		password: 'org-switch-secrets-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await saveKeyThroughUi(page, {
		name: 'personalOnlySecret',
		value: 'personal-secret-value',
		allowedHosts: [],
	})

	await page.setViewportSize({ width: 1440, height: 900 })
	await page.goto('/account/organizations/new')
	await waitForClientHydration(page)
	await page.getByLabel('Name').fill(`Switch ${runId}`)
	await expect(page.getByLabel('Handle')).toHaveValue(`switch-${runId}`)
	await page
		.getByRole('button', { name: 'Create organization', exact: true })
		.click()
	await page.getByRole('button', { name: 'Yes, create organization' }).click()
	await expect(page).toHaveURL(new RegExp(`/@switch-${runId}/-/overview$`))

	await page.goto(`/@${user.username}/-/credentials`)
	await waitForClientHydration(page)
	await expect(page.getByText('personalOnlySecret')).toBeVisible()

	// The destination travels as server-function input while the current URL
	// still names the personal org. Verify that transport and the returned data.
	const teamLoad = waitForOrgRead(page, `switch-${runId}`)
	const { panel } = await openSwitcher(page)
	await panel.getByTestId(`org-switcher-switch-${runId}`).click()
	await expect(page).toHaveURL(new RegExp(`/@switch-${runId}/-/credentials$`))
	const teamResponse = await teamLoad
	expect(teamResponse.ok()).toBe(true)
	expect(await teamResponse.text()).not.toContain('personalOnlySecret')

	await expect(
		page.getByRole('heading', { level: 1, name: 'Credentials' }),
	).toBeVisible()
	await expect(
		page.getByText('No credentials yet.', { exact: false }),
	).toBeVisible()
	await expect(page.getByText('personalOnlySecret')).toHaveCount(0)
	const back = await openSwitcher(page)
	await back.panel.getByTestId(`org-switcher-${user.username}`).click()
	await expect(page).toHaveURL(new RegExp(`/@${user.username}/-/credentials$`))
	await expect(page.getByText('personalOnlySecret')).toBeVisible()
	await page.goBack()
	await expect(page).toHaveURL(new RegExp(`/@switch-${runId}/-/credentials$`))
	await expect(page.getByText('personalOnlySecret')).toHaveCount(0)
	await expect(
		page.getByText('No credentials yet.', { exact: false }),
	).toBeVisible()
})
