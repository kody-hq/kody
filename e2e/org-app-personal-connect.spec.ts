import { readE2eCloudflareMockState } from '../tools/e2e-cloudflare-mock-state.ts'
import { seedStableUserIdFromEmail } from '../tools/seed-sql.ts'
import { executeE2eD1Command } from './d1-utils.ts'
import {
	expect,
	test,
	type Page,
	waitForClientHydration,
} from './playwright-utils.ts'

function sqlString(value: string) {
	return `'${value.replaceAll("'", "''")}'`
}

const screenshotDir = process.env.KODY_E2E_SCREENSHOT_DIR

async function captureBothThemes(page: Page, name: string) {
	if (!screenshotDir) return
	for (const colorScheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme })
		await page.screenshot({
			path: `${screenshotDir}/${name}-${colorScheme}.png`,
			fullPage: true,
		})
	}
	await page.emulateMedia({ colorScheme: null })
}

// Only the provider's authorization page is simulated in the browser; the
// callback, token exchange, and storage run through the app and mock worker.
async function routeMockAuthorize(
	page: Page,
	authorizeUrl: string,
	id: string,
) {
	const authorizations: Array<string> = []
	await page.route(`${authorizeUrl}?**`, async (route) => {
		const authorization = new URL(route.request().url())
		authorizations.push(authorization.searchParams.get('client_id') ?? '')
		const callback = new URL(authorization.searchParams.get('redirect_uri')!)
		callback.searchParams.set('code', `rehearsal-code-${id}`)
		callback.searchParams.set('state', authorization.searchParams.get('state')!)
		await route.fulfill({ status: 302, headers: { location: callback.href } })
	})
	return authorizations
}

test('a member connects their own account through the org app, and an owner revokes it', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 150_000 : 120_000)
	const runId = Date.now()
	const id = String(runId).slice(-8)
	const orgSlug = `pinned-team-${runId}`
	const owner = await seedE2eUser({
		email: `pinned-owner-${runId}@example.com`,
		username: `pinned-owner-${runId}`,
		password: 'pinned-owner-password',
	})
	const member = await seedE2eUser({
		email: `pinned-member-${runId}@example.com`,
		username: `pinned-member-${runId}`,
		password: 'pinned-member-password',
	})
	const teamId = `org-pinned-${runId}`
	executeE2eD1Command(`
INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
VALUES (${sqlString(teamId)}, ${sqlString(orgSlug)}, 'Pinned Team', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES
	(${sqlString(teamId)}, ${sqlString(seedStableUserIdFromEmail(owner.email))}, 'owner', CURRENT_TIMESTAMP),
	(${sqlString(teamId)}, ${sqlString(seedStableUserIdFromEmail(member.email))}, 'member', CURRENT_TIMESTAMP);
`)
	const mock = readE2eCloudflareMockState()
	const provider = `rehearsal-${id}`
	const authorizeUrl = `${mock.origin}/__mocks/rehearsal/oauth/authorize`
	const authorizations = await routeMockAuthorize(page, authorizeUrl, id)

	// The owner registers the org's OAuth app (client secret stays host-side).
	await login({ email: owner.email, password: owner.password, mode: 'login' })
	const configuration = new URLSearchParams({
		provider,
		authorizeUrl,
		tokenUrl: `${mock.origin}/__mocks/rehearsal/oauth/token`,
		flow: 'confidential',
		allowedHosts: new URL(mock.origin).hostname,
		org: orgSlug,
	})
	await page.goto(`/connect/oauth?${configuration}`)
	await waitForClientHydration(page)
	await page.locator('input[name="oauthClientId"]').fill('rehearsal-client')
	await page.locator('input[name="oauthClientSecret"]').fill('rehearsal-secret')
	await page.getByRole('button', { name: 'Save and continue' }).click()
	await page.getByRole('button', { name: `Continue to ${provider}` }).click()
	await expect(
		page.getByText("You're connected.", { exact: true }),
	).toBeVisible()

	// The member finds "connect your own account" on the chooser.
	await page.context().clearCookies()
	await login({ email: member.email, password: member.password, mode: 'login' })
	await page.goto(`/connect/oauth?org=${orgSlug}`)
	await waitForClientHydration(page)
	const option = page
		.getByRole('link')
		.filter({ hasText: "Connect your own account through this org's app" })
	await expect(option).toHaveCount(1)
	await captureBothThemes(page, '1-chooser')
	const optionHref = new URL(
		(await option.getAttribute('href'))!,
		'https://kody.local',
	)
	expect(optionHref.searchParams.get('mode')).toBe('personal')
	expect(optionHref.searchParams.get('org')).toBe(orgSlug)
	const appSlug = optionHref.searchParams.get('app')!
	expect(appSlug).toBeTruthy()
	// The documented short form omits `provider`.
	await page.goto(
		`/connect/oauth?${new URLSearchParams({ org: orgSlug, app: appSlug, mode: 'personal' })}`,
	)
	await waitForClientHydration(page)
	await expect(
		page.getByRole('note').filter({ hasText: 'Connect your own account' }),
	).toBeVisible()
	await expect(page.locator('input[name="oauthClientSecret"]')).toHaveCount(0)
	await captureBothThemes(page, '2-personal-connect')
	await page.getByRole('button', { name: `Continue to ${provider}` }).click()
	await expect(
		page.getByText("You're connected.", { exact: true }),
	).toBeVisible()
	// The member's authorization used the org app's client id.
	expect(authorizations).toEqual(['rehearsal-client', 'rehearsal-client'])

	const detail = `/@${orgSlug}/-/integrations/apps/${appSlug}`
	await page.goto(detail)
	await waitForClientHydration(page)
	const memberSection = page.getByTestId('org-app-member-connections')
	await expect(memberSection.getByText('You', { exact: true })).toBeVisible()
	await expect(
		memberSection.getByRole('link', { name: 'Connect your own account' }),
	).toHaveCount(0)
	// A member without manage access never sees other members' list.
	await expect(
		memberSection.getByRole('list', { name: "Members' own connections" }),
	).toHaveCount(0)
	await captureBothThemes(page, '3-member-app-detail')

	// The owner sees metadata only and revokes it.
	await page.context().clearCookies()
	await login({ email: owner.email, password: owner.password, mode: 'login' })
	await page.goto(detail)
	await waitForClientHydration(page)
	const list = memberSection.getByRole('list', {
		name: "Members' own connections",
	})
	await expect(list).toContainText(`@${member.username}`)
	await expect(list).not.toContainText('rehearsal-secret')
	await captureBothThemes(page, '4-owner-member-connections')
	const revoke = list.getByTestId('revoke-member-connection')
	await revoke.click()
	await expect(revoke).toHaveText('Confirm revoke')
	await revoke.click()
	await expect(
		memberSection.getByText(
			'No other member has connected their own account yet.',
			{
				exact: true,
			},
		),
	).toBeVisible()

	// The member's connection is gone.
	await page.context().clearCookies()
	await login({ email: member.email, password: member.password, mode: 'login' })
	await page.goto(detail)
	await waitForClientHydration(page)
	await expect(
		memberSection.getByRole('link', { name: 'Connect your own account' }),
	).toBeVisible()
})
