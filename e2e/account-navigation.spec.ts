import { accountConnectionAgentIds } from '../packages/worker/universal/account-connections.ts'
import { saveKeyThroughUi } from './account-fixtures.ts'
import {
	collectJsonRequests,
	expectSingleCommitTransition,
	observeMainTransitions,
	readMainTransitions,
} from './main-transitions.ts'
import {
	expect,
	test,
	waitForClientHydration,
	type Locator,
	type Page,
} from './playwright-utils.ts'

/**
 * Account and admin pages sit in a persistent shell; moving between them is
 * tab switching. Each hop must replace the previous page in one commit: the
 * heading never disappears, no "Loading…" copy takes the content's place,
 * and the destination payload the router preloaded is never fetched twice.
 */
async function clickThroughSections(
	page: Page,
	navName: string,
	hops: Array<{ link: string; heading: string | RegExp }>,
	fromHeading: string | RegExp,
) {
	const requests = collectJsonRequests(page)
	let previousHeading = fromHeading
	for (const hop of hops) {
		await observeMainTransitions(page)
		requests.reset()
		await page
			.getByRole('navigation', { name: navName })
			.getByRole('link', { name: hop.link, exact: true })
			.click()
		await expect(
			page.getByRole('heading', { level: 1, name: hop.heading }),
		).toBeVisible()
		// Let any stray follow-up render land before reading the log.
		await page.waitForTimeout(250)
		expectSingleCommitTransition(await readMainTransitions(page), {
			fromHeading: previousHeading,
			toHeading: hop.heading,
		})
		expect(requests.duplicates(), requests.paths.join(', ')).toEqual([])
		previousHeading = hop.heading
	}
}

test('account section switches keep the current page on screen (no loading flash, no refetch)', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `account-nav-${runId}@example.com`,
		username: `account-nav-${runId}`,
		password: 'account-nav-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await page.goto(`/@${user.username}/-/jobs`)
	await expect(page).toHaveURL(new RegExp(`/@${user.username}/-/jobs$`))
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Jobs' }),
	).toBeVisible()

	await clickThroughSections(
		page,
		'Workspace sections',
		[
			{ link: 'Memories', heading: 'Memories' },
			{ link: 'Credentials', heading: 'Credentials' },
			{ link: 'Agents', heading: 'Agents' },
			{ link: 'Activity', heading: 'Activity' },
			{ link: 'Webhooks', heading: 'Webhooks' },
			{ link: 'Repositories', heading: 'Repositories' },
			{ link: 'Jobs', heading: 'Jobs' },
		],
		'Jobs',
	)

	// Repositories is the workspace list in the rail, not the public profile.
	await expect(
		page
			.getByRole('navigation', { name: 'Workspace sections' })
			.getByRole('link', { name: 'Repositories', exact: true }),
	).toHaveAttribute('href', `/@${user.username}/-/repositories`)

	// Person settings have their own rail; the account menu is the way across.
	await page.getByTestId('account-menu').click()
	await page
		.getByTestId('account-menu-panel')
		.getByRole('link', { name: 'Account settings' })
		.click()
	await expect(
		page.getByRole('heading', { level: 1, name: 'Account settings' }),
	).toBeVisible()
	await expect(
		page.getByRole('navigation', { name: 'Workspace sections' }),
	).toHaveCount(0)
	await clickThroughSections(
		page,
		'Account sections',
		[
			{ link: 'Security', heading: 'Security' },
			{ link: 'Organizations', heading: 'Organizations' },
			{ link: 'Data & deletion', heading: 'Data & deletion' },
			{ link: 'Account settings', heading: 'Account settings' },
		],
		'Account settings',
	)
})

test('every workspace section is reachable from /account through the avatar menu', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `account-workspace-${runId}@example.com`,
		username: `account-workspace-${runId}`,
		password: 'account-workspace-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await page.setViewportSize({ width: 1440, height: 900 })
	await page.goto('/account')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Account settings' }),
	).toBeVisible()

	// The account rail holds only the person's pages. The avatar menu's
	// Manage group opens the signup org's overview, whose rail names every
	// section.
	await page.getByTestId('account-menu').click()
	const workspaceRow = page
		.getByTestId('account-menu-panel')
		.getByRole('group', { name: 'Manage' })
		.getByRole('link', { name: `@${user.username}`, exact: true })
	await expect(workspaceRow).toHaveAttribute(
		'href',
		`/@${user.username}/-/overview`,
	)
	await workspaceRow.click()
	await expect(page).toHaveURL(new RegExp(`/@${user.username}/-/overview$`))
	const workspaceRail = page.getByRole('navigation', {
		name: 'Workspace sections',
	})
	await workspaceRail
		.getByRole('link', { name: 'Credentials', exact: true })
		.click()
	await expect(page).toHaveURL(new RegExp(`/@${user.username}/-/credentials$`))
	await expect(
		page.getByRole('heading', { level: 1, name: 'Credentials' }),
	).toBeVisible()
	await expect(
		workspaceRail.getByRole('link', { name: 'Credentials', exact: true }),
	).toHaveAttribute('aria-current', 'page')

	// Account pages have no workspace rail (so no switcher); the avatar
	// menu's Manage group opens the signup org's overview, which links every
	// section.
	await page.goto('/account/security')
	await waitForClientHydration(page)
	await expect(page.getByTestId('org-switcher')).toHaveCount(0)
	await page.getByTestId('account-menu').click()
	await page
		.getByTestId('account-menu-panel')
		.getByRole('group', { name: 'Manage' })
		.getByRole('link', { name: `@${user.username}`, exact: true })
		.click()
	await expect(page).toHaveURL(new RegExp(`/@${user.username}/-/overview$`))
	await expect(
		page.getByRole('heading', { level: 1, name: 'Overview' }),
	).toBeVisible()
	await expect(
		page
			.getByRole('navigation', { name: 'Workspace sections' })
			.getByRole('link', { name: 'Overview', exact: true }),
	).toHaveAttribute('aria-current', 'page')
	const overview = page.locator('[data-testid^="org-overview-"]')
	for (const label of [
		'Repositories',
		'Agents',
		'Credentials',
		'Jobs',
		'Memories',
		'Billing',
	]) {
		await expect(
			overview.getByRole('link', { name: new RegExp(`^${label}`) }),
		).toBeVisible()
	}
	await page
		.getByTestId('org-overview-credentials')
		.getByRole('link', { name: /^Credentials/ })
		.click()
	await expect(page).toHaveURL(new RegExp(`/@${user.username}/-/credentials$`))
	await expect(
		page.getByRole('heading', { level: 1, name: 'Credentials' }),
	).toBeVisible()

	// The organizations list opens the signup org's overview too.
	await page.goto('/account/organizations')
	await waitForClientHydration(page)
	await expect(
		page.getByTestId('account-organization').getByRole('link'),
	).toHaveAttribute('href', `/@${user.username}/-/overview`)
})

test('signed-in profile opens the workspace rail through to Activity', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `rail-entry-${runId}@example.com`,
		username: `rail-entry-${runId}`,
		password: 'rail-entry-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })

	// Own profile names Workspace; it is not a community-only dead end.
	await page.goto(`/@${user.username}`)
	await waitForClientHydration(page)
	await expect(page.getByTestId('profile-workspace')).toHaveAttribute(
		'href',
		`/@${user.username}/-/repositories`,
	)
	await Promise.all([
		page.waitForURL(new RegExp(`/@${user.username}/-/repositories$`)),
		page.getByTestId('profile-workspace').click(),
	])
	await expect(
		page.getByRole('heading', { level: 1, name: 'Repositories' }),
	).toBeVisible()
	const rail = page.getByRole('navigation', { name: 'Workspace sections' })
	await expect(rail).toBeVisible()
	await Promise.all([
		page.waitForURL(new RegExp(`/@${user.username}/-/activity$`)),
		rail.getByRole('link', { name: 'Activity', exact: true }).click(),
	])
	await expect(
		page.getByRole('heading', { level: 1, name: 'Activity' }),
	).toBeVisible()
	await expect(
		rail.getByRole('link', { name: 'Activity', exact: true }),
	).toHaveAttribute('aria-current', 'page')

	// Workflows and Waiting are tabs on Activity; the rail item stays current.
	const tabs = page.getByRole('navigation', { name: 'Activity pages' })
	await expect(
		tabs.getByRole('link', { name: 'Activity', exact: true }),
	).toHaveAttribute('aria-current', 'page')
	await Promise.all([
		page.waitForURL(new RegExp(`/@${user.username}/-/workflows$`)),
		tabs.getByRole('link', { name: 'Workflows', exact: true }).click(),
	])
	await expect(
		page.getByRole('heading', { level: 1, name: 'Workflows' }),
	).toBeVisible()
	await expect(
		page
			.getByRole('navigation', { name: 'Activity pages' })
			.getByRole('link', { name: 'Workflows', exact: true }),
	).toHaveAttribute('aria-current', 'page')
	await expect(
		rail.getByRole('link', { name: 'Activity', exact: true }),
	).toHaveAttribute('aria-current', 'page')
})

test('the legacy credits URL opens the personal workspace ledger', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `account-credits-${runId}@example.com`,
		username: `account-credits-${runId}`,
		password: 'account-credits-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await page.goto('/account/credits')
	await expect(page).toHaveURL(new RegExp(`/@${user.username}/-/credits$`))
	await expect(
		page.getByRole('heading', { level: 1, name: 'Credits' }),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { level: 2, name: 'Ledger' }),
	).toBeVisible()

	const rail = page.getByRole('navigation', { name: 'Workspace sections' })
	await expect(
		rail.getByRole('link', { name: 'Credits', exact: true }),
	).toHaveAttribute('aria-current', 'page')
})

test('Add connection opens its own page with the client wall, then a host step (no loading flash, no double fetch)', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `connections-${runId}@example.com`,
		username: `connections-${runId}`,
		password: 'connections-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await page.goto(`/@${user.username}/-/agents`)
	await expect(page).toHaveURL(new RegExp(`/@${user.username}/-/agents$`))
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Agents' }),
	).toBeVisible()
	await expect(
		page.getByRole('region', { name: 'Connected agents' }),
	).toBeVisible()
	await expect(page.getByTestId('account-connections-agent-grid')).toHaveCount(
		0,
	)
	await expect(page.getByTestId('account-connections-back')).toHaveCount(0)

	await observeMainTransitions(page)
	const requests = collectJsonRequests(page)
	await page.getByTestId('account-connections-add').click()
	await expect(page).toHaveURL(new RegExp(`/@${user.username}/-/agents/new$`))
	const grid = page.getByTestId('account-connections-agent-grid')
	await expect(grid).toBeVisible()
	await expect(page.getByTestId('account-connections-back')).toBeVisible()
	await expect(
		page.getByRole('region', { name: 'Connected agents' }),
	).toHaveCount(0)
	// The heading never leaves the screen: list and add share the account
	// shell while the body swaps in one commit.
	await page.waitForTimeout(250)
	expectSingleCommitTransition(await readMainTransitions(page), {
		fromHeading: 'Agents',
		toHeading: 'Agents',
	})
	// Like every router hop, the destination loader (or its intent prefetch)
	// fetches the payload once before commit; the contract here is that the
	// route never asks for the same payload a second time.
	expect(requests.duplicates(), requests.paths.join(', ')).toEqual([])
	requests.reset()
	// Every named client is a card link. Connected marks (if any) stay on
	// those links — never a dead-end span — and none is hidden by viewport.
	await expect(grid.getByRole('link')).toHaveCount(
		accountConnectionAgentIds.length,
	)
	await expect(grid.locator('[data-greyed="true"]:not(a)')).toHaveCount(0)
	await expect(page.getByTestId('onboarding-agent-claude-code')).toBeVisible()
	await expect(page.getByTestId('onboarding-agent-grok')).toBeVisible()
	await expect(page.getByTestId('onboarding-agent-muse')).toBeVisible()
	await expect(page.getByTestId('onboarding-agent-hermes')).toBeVisible()

	await page.getByTestId('onboarding-agent-claude-code').click()
	await expect(page).toHaveURL(
		new RegExp(`/@${user.username}/-/agents/new/claude-code$`),
	)
	await expect(
		page.getByRole('heading', { level: 2, name: 'Connect Claude Code' }),
	).toBeVisible()
	await expect(
		page.getByTestId('account-connections-agent-instructions'),
	).toBeVisible()
	await expect(
		page.getByRole('region', { name: 'Connected agents' }),
	).toHaveCount(0)
	// Agents stays current in the rail on the add views.
	await expect(
		page
			.getByRole('navigation', { name: 'Workspace sections' })
			.getByRole('link', { name: 'Agents', exact: true }),
	).toHaveAttribute('aria-current', 'page')

	expect(requests.duplicates(), requests.paths.join(', ')).toEqual([])
	requests.reset()

	await page.getByTestId('account-connections-change-agent').click()
	await expect(grid).toBeVisible()
	// Leave the agent grid so a hover-intent prefetch does not fire after
	// reset() and get counted as a second destination load on Back (#3807).
	await page.mouse.move(0, 0)
	expect(requests.duplicates(), requests.paths.join(', ')).toEqual([])
	requests.reset()

	await page.getByTestId('account-connections-back').click()
	await expect(page).toHaveURL(new RegExp(`/@${user.username}/-/agents$`))
	await expect(page.getByTestId('account-connections-add')).toBeVisible()
	await expect(
		page.getByRole('region', { name: 'Connected agents' }),
	).toBeVisible()
	await expect(page.getByTestId('account-connections-agent-grid')).toHaveCount(
		0,
	)
	expect(requests.duplicates(), requests.paths.join(', ')).toEqual([])
})

async function markSearchNode(search: Locator) {
	await search.evaluate((element) => {
		;(element as HTMLElement).dataset.kodySearchMount = '1'
	})
}

test('account live search keeps the same focused input while the list filters', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `account-search-${runId}@example.com`,
		username: `account-search-${runId}`,
		password: 'account-search-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })

	await saveKeyThroughUi(page, {
		name: `alphaSecret${runId}`,
		value: 'alpha-secret-value',
		description: 'Matches the alpha query',
		allowedHosts: ['api.example.com'],
	})
	await saveKeyThroughUi(page, {
		name: `betaSecret${runId}`,
		value: 'beta-secret-value',
		description: 'Does not match the alpha query',
		allowedHosts: ['api.example.com'],
	})

	await page.goto(`/@${user.username}/-/credentials`)
	await expect(page).toHaveURL(new RegExp(`/@${user.username}/-/credentials$`))
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Credentials' }),
	).toBeVisible()
	await expect(page.getByText(`alphaSecret${runId}`)).toBeVisible()
	await expect(page.getByText(`betaSecret${runId}`)).toBeVisible()

	const credentialsSearch = page.getByRole('searchbox', {
		name: 'Search credentials',
	})
	await credentialsSearch.click()
	await markSearchNode(credentialsSearch)
	await credentialsSearch.pressSequentially(`alphaSecret${runId}`, {
		delay: 20,
	})
	await expect(credentialsSearch).toBeFocused()
	await expect(credentialsSearch).toHaveAttribute('data-kody-search-mount', '1')
	await expect(credentialsSearch).toHaveValue(`alphaSecret${runId}`)
	await expect(page.getByText(`alphaSecret${runId}`)).toBeVisible()
	await expect(page.getByText(`betaSecret${runId}`)).toHaveCount(0)

	await page.goto(`/@${user.username}/-/jobs`)
	await expect(page).toHaveURL(new RegExp(`/@${user.username}/-/jobs$`))
	await waitForClientHydration(page)
	const jobsSearch = page.getByRole('searchbox', { name: 'Search jobs' })
	await jobsSearch.click()
	await markSearchNode(jobsSearch)
	await jobsSearch.pressSequentially('no-such-job', { delay: 20 })
	await expect(jobsSearch).toBeFocused()
	await expect(jobsSearch).toHaveAttribute('data-kody-search-mount', '1')
	await expect(jobsSearch).toHaveValue('no-such-job')
})

test('admin section switches keep the current page on screen (no loading flash, no refetch)', async ({
	page,
	seedE2eUser,
	assignRole,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const adminUser = await seedE2eUser({
		email: `admin-nav-${runId}@example.com`,
		username: `admin-nav-${runId}`,
		password: 'admin-nav-password',
	})
	await assignRole(adminUser.email, 'admin')
	await login({
		email: adminUser.email,
		password: adminUser.password,
		mode: 'login',
	})
	await page.goto('/admin/roles')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Admin roles' }),
	).toBeVisible()

	await clickThroughSections(
		page,
		'Admin sections',
		[
			{ link: 'Reserved usernames', heading: 'Reserved usernames' },
			{ link: 'Feature flags', heading: 'Admin feature flags' },
			{ link: 'Roles', heading: 'Admin roles' },
		],
		'Admin roles',
	)
})
