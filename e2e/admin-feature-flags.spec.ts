import {
	expect,
	test,
	waitForClientHydration,
	type Locator,
	type Page,
} from './playwright-utils.ts'

async function waitForAdminFeatureFlagsHydrated(page: Page) {
	await expect(
		page.getByRole('heading', { name: 'Admin feature flags' }),
	).toBeVisible()
	// Save / Remove are preventDefault + fetch to /admin/feature-flags.json.
	// Before hydration a native POST hits the HTML route and does not persist,
	// and type="button" Remove is a silent no-op.
	await waitForClientHydration(page)
}

async function saveGlobalStateAndReload(page: Page, demoFlagSection: Locator) {
	await demoFlagSection
		.getByRole('button', { name: 'Save', exact: true })
		.click()
	await expect(page.getByText(/Saved global state/)).toBeVisible()
	await page.reload()
	await waitForAdminFeatureFlagsHydrated(page)
}

test('admin feature flags: global toggle and per-user override visibility', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const adminUser = await seedE2eUser({
		email: `ff-admin-${runId}@example.com`,
		username: `ff-admin-${runId}`,
		password: 'ff-admin-password',
		admin: true,
	})
	const memberUser = await seedE2eUser({
		email: `ff-member-${runId}@example.com`,
		username: `ff-member-${runId}`,
		password: 'ff-member-password',
	})

	await login({
		email: adminUser.email,
		password: adminUser.password,
		mode: 'login',
	})
	await page.goto('/')

	await page.getByRole('link', { name: 'Admin', exact: true }).click()
	await page.getByRole('link', { name: 'Feature flags', exact: true }).click()
	await expect(page).toHaveURL(/\/admin\/feature-flags\/?$/)
	await waitForAdminFeatureFlagsHydrated(page)

	const demoFlagSection = page
		.getByRole('heading', { name: 'demo-indicator' })
		.locator('xpath=ancestor::section[1]')

	const enabledCheckbox = demoFlagSection.getByLabel('Enabled')
	const audienceSelect = demoFlagSection.getByLabel('Audience')
	if (await enabledCheckbox.isChecked()) {
		await enabledCheckbox.uncheck()
		await saveGlobalStateAndReload(page, demoFlagSection)
		await expect(page.getByTestId('demo-indicator')).toHaveCount(0)
	}

	// Audience must hydrate from list data after save/reload. Remix applies
	// defaultValue as an attribute (ignored by <select>); options need selected.
	await audienceSelect.selectOption('experiments_opt_in')
	await demoFlagSection.getByLabel('Note').fill(`e2e-audience-${runId}`)
	await saveGlobalStateAndReload(page, demoFlagSection)
	await expect(audienceSelect).toHaveValue('experiments_opt_in')

	// Restore everyone before enabling: seeded users are not experiments-opted-in,
	// so experiments_opt_in audience would hide demo-indicator for the admin.
	await audienceSelect.selectOption('everyone')
	await enabledCheckbox.check()
	await demoFlagSection.getByLabel('Note').fill(`e2e-global-${runId}`)
	await saveGlobalStateAndReload(page, demoFlagSection)
	await expect(page.getByTestId('demo-indicator')).toBeVisible()
	await expect(audienceSelect).toHaveValue('everyone')

	await enabledCheckbox.uncheck()
	await saveGlobalStateAndReload(page, demoFlagSection)
	await expect(page.getByTestId('demo-indicator')).toHaveCount(0)

	await demoFlagSection.getByLabel('Username').fill(memberUser.username)
	await demoFlagSection.getByLabel('State').selectOption('true')
	await demoFlagSection
		.getByRole('button', { name: 'Add override', exact: true })
		.click()

	const memberOverrideRow = demoFlagSection
		.locator('strong', { hasText: memberUser.username })
		.locator('xpath=../..')
	await expect(memberOverrideRow).toBeVisible()

	await page.reload()
	await expect(page.getByTestId('demo-indicator')).toHaveCount(0)

	await page.context().clearCookies()
	await login({
		email: memberUser.email,
		password: memberUser.password,
		mode: 'login',
	})
	await page.goto('/')
	await expect(page.getByTestId('demo-indicator')).toBeVisible()

	await page.context().clearCookies()
	await login({
		email: adminUser.email,
		password: adminUser.password,
		mode: 'login',
	})
	await page.goto('/admin/feature-flags')
	await waitForAdminFeatureFlagsHydrated(page)
	await expect(memberOverrideRow).toBeVisible()
	await memberOverrideRow
		.getByRole('button', { name: 'Remove', exact: true })
		.click()
	await expect(memberOverrideRow).toHaveCount(0)

	await page.context().clearCookies()
	await login({
		email: memberUser.email,
		password: memberUser.password,
		mode: 'login',
	})
	await page.goto('/')
	await expect(page.getByTestId('demo-indicator')).toHaveCount(0)
})
