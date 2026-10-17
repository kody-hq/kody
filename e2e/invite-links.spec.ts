import { type Route } from '@playwright/test'
import { seedStableUserIdFromEmail } from '../tools/seed-sql.ts'
import { executeE2eD1Command } from './d1-utils.ts'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'

function sqlString(value: string) {
	return `'${value.replaceAll("'", "''")}'`
}

function seedTeamOrg(input: {
	runId: number
	ownerId: string
	packageName: string
}) {
	const { runId, ownerId, packageName } = input
	const orgId = `org-links-${runId}`
	const orgSlug = `links-org-${runId}`
	const teamId = `team-links-${runId}`
	const now = new Date().toISOString()
	executeE2eD1Command(`
INSERT INTO orgs (id, slug, display_name, created_by_user_id, created_at, updated_at)
VALUES (${sqlString(orgId)}, ${sqlString(orgSlug)}, 'Links Org', ${sqlString(ownerId)}, ${sqlString(now)}, ${sqlString(now)});
INSERT INTO org_memberships (org_id, user_id, role, created_at)
VALUES (${sqlString(orgId)}, ${sqlString(ownerId)}, 'owner', ${sqlString(now)});
INSERT INTO teams (id, org_id, slug, name, created_at, updated_at)
VALUES (${sqlString(teamId)}, ${sqlString(orgId)}, 'writers', 'Writers', ${sqlString(now)}, ${sqlString(now)});
INSERT INTO saved_packages (
	id, user_id, name, kody_id, description, tags_json, search_text,
	source_id, has_app, hidden, is_private
) VALUES (
	${sqlString(`pkg-links-${runId}`)}, ${sqlString(orgId)}, ${sqlString(packageName)},
	${sqlString(packageName)}, 'E2E invite links package', '[]', ${sqlString(packageName)},
	${sqlString(`src-links-${runId}`)}, 0, 0, 1
);
`)
	return { orgSlug }
}

test('package invite link: create on Collaborators, accept from Invites', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const runId = Date.now()
	const owner = await seedE2eUser({
		email: `links-owner-${runId}@example.com`,
		username: `links-owner-${runId}`,
		password: 'links-owner-password',
	})
	const recipient = await seedE2eUser({
		email: `links-guest-${runId}@example.com`,
		username: `links-guest-${runId}`,
		password: 'links-guest-password',
	})
	const packageName = `links-pkg-${runId}`
	const { orgSlug } = seedTeamOrg({
		runId,
		ownerId: seedStableUserIdFromEmail(owner.email),
		packageName,
	})

	await login({ email: owner.email, password: owner.password, mode: 'login' })
	await page.goto(`/@${orgSlug}/${packageName}/collaborators`)
	await waitForClientHydration(page)
	const form = page.getByTestId('package-invite-link-form')
	await form
		.getByRole('combobox', { name: 'Access for the invite link' })
		.selectOption('contribute')
	await page.getByTestId('package-invite-link-create').click()
	const linkUrl = (
		await page
			.getByTestId('package-invite-link-url')
			.locator('code')
			.innerText()
	).trim()
	expect(linkUrl).toMatch(/\/join\/[0-9a-f]{64}$/)
	await expect(page.getByTestId('package-invite-link')).toHaveCount(1)

	await page.context().clearCookies()
	await page.goto(new URL(linkUrl).pathname)
	await expect(page.getByTestId('org-invite-join')).toHaveAttribute(
		'data-invite-kind',
		'resource',
	)
	await expect(
		page.getByRole('link', { name: 'Create an account' }),
	).toHaveAttribute('href', /redirectTo=%2Fjoin%2F/)

	await login({
		email: recipient.email,
		password: recipient.password,
		mode: 'login',
	})
	await page.goto(new URL(linkUrl).pathname)
	await waitForClientHydration(page)
	await expect(page.getByTestId('org-invite-join-confirm')).toBeVisible()
	await expect(page.getByTestId('org-invite-join-details')).not.toHaveAttribute(
		'open',
	)

	await page.goto(`/@${recipient.username}/-/waiting`)
	await waitForClientHydration(page)
	await expect(page.getByTestId('waiting-invite')).toContainText(
		`Contribute access to ${packageName}`,
	)

	await page.goto('/account/organizations#invites')
	await waitForClientHydration(page)
	const row = page.getByTestId('pending-invite')
	await expect(row).toHaveCount(1)
	await expect(row).toContainText(packageName)
	await Promise.all([
		page.waitForURL(new RegExp(`/@${orgSlug}/${packageName}$`)),
		row.getByTestId('pending-invite-accept').click(),
	])

	await page.goto(new URL(linkUrl).pathname)
	await expect(page.getByTestId('org-invite-join-confirm')).toHaveCount(0)
})

test('team invite link: recover a lost acceptance response without consuming another use', async ({
	page,
	browser,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const runId = Date.now()
	const owner = await seedE2eUser({
		email: `team-links-owner-${runId}@example.com`,
		username: `team-links-owner-${runId}`,
		password: 'team-links-owner-password',
	})
	const recipient = await seedE2eUser({
		email: `team-links-guest-${runId}@example.com`,
		username: `team-links-guest-${runId}`,
		password: 'team-links-guest-password',
	})
	const { orgSlug } = seedTeamOrg({
		runId,
		ownerId: seedStableUserIdFromEmail(owner.email),
		packageName: `team-links-pkg-${runId}`,
	})

	await login({ email: owner.email, password: owner.password, mode: 'login' })
	await page.goto(`/@${orgSlug}/-/teams`)
	await waitForClientHydration(page)
	await page.getByTestId('org-team-invite-link-create').click()
	const linkUrl = (
		await page.getByTestId('org-team-invite-link-url').innerText()
	).trim()
	expect(linkUrl).toMatch(/\/join\/[0-9a-f]{64}$/)
	await expect(page.getByTestId('org-team-invite-link')).toHaveCount(1)

	const ownerState = await page.context().storageState()

	await page.context().clearCookies()
	await login({
		email: recipient.email,
		password: recipient.password,
		mode: 'login',
	})
	await page.goto(new URL(linkUrl).pathname)
	await waitForClientHydration(page)
	await expect(page.getByTestId('org-invite-join')).toHaveAttribute(
		'data-invite-kind',
		'team',
	)
	// Two already-open tabs can submit the same offer. Hold the duplicate at
	// the network boundary until the first has committed and lost its response.
	const retryPage = await page.context().newPage()
	await retryPage.goto(new URL(linkUrl).pathname)
	await waitForClientHydration(retryPage)
	await expect(retryPage.getByTestId('org-invite-join-confirm')).toBeVisible()
	let dropped = false
	await page.route('**/_serverFn/**', async (route) => {
		if (
			route.request().method() !== 'POST' ||
			dropped ||
			!route
				.request()
				.postData()
				?.includes(new URL(linkUrl).pathname.split('/').at(-1)!)
		)
			return route.fallback()
		const response = await route.fetch()
		expect(response.ok()).toBe(true)
		dropped = true
		await route.abort('failed')
	})
	let releaseRetry!: () => void
	const retryBarrier = new Promise<void>((resolve) => {
		releaseRetry = resolve
	})
	let retryHeld = false
	await retryPage.route('**/_serverFn/**', async (route) => {
		if (route.request().method() !== 'POST' || retryHeld)
			return route.fallback()
		retryHeld = true
		await retryBarrier
		await route.continue()
	})
	try {
		await retryPage.getByTestId('org-invite-join-confirm').click()
		await expect.poll(() => retryHeld).toBe(true)
		await page.getByTestId('org-invite-join-confirm').click()
		await expect.poll(() => dropped).toBe(true)
		// Settlement refreshes the authoritative read after transport failure.
		await expect(page.getByTestId('org-invite-join-confirm')).toHaveCount(0)
		releaseRetry()
		await retryPage.waitForURL(new RegExp(`/@${orgSlug}/-/teams$`))
	} finally {
		releaseRetry()
	}
	await expect(retryPage.getByText('Writers').first()).toBeVisible()
	await retryPage.reload()
	await waitForClientHydration(retryPage)
	await expect(retryPage.getByText('Writers').first()).toBeVisible()

	const ownerContext = await browser.newContext({ storageState: ownerState })
	try {
		const ownerPage = await ownerContext.newPage()
		await ownerPage.goto(new URL(`/@${orgSlug}/-/teams`, linkUrl).href)
		await waitForClientHydration(ownerPage)
		await expect(ownerPage.getByTestId('org-team-invite-link')).toContainText(
			'1 uses',
		)
	} finally {
		await ownerContext.close()
		await retryPage.close()
	}
})

test('addressed invite: listed and revocable on Members, accepted from Waiting', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const runId = Date.now()
	const owner = await seedE2eUser({
		email: `addressed-owner-${runId}@example.com`,
		username: `addressed-owner-${runId}`,
		password: 'addressed-owner-password',
	})
	const recipient = await seedE2eUser({
		email: `addressed-guest-${runId}@example.com`,
		username: `addressed-guest-${runId}`,
		password: 'addressed-guest-password',
	})
	const { orgSlug } = seedTeamOrg({
		runId,
		ownerId: seedStableUserIdFromEmail(owner.email),
		packageName: `addressed-pkg-${runId}`,
	})

	await login({ email: owner.email, password: owner.password, mode: 'login' })
	await page.goto(`/@${orgSlug}/-/members`)
	await waitForClientHydration(page)
	const form = page.getByTestId('org-invite-form')
	for (const invitee of [recipient.email, `nobody-${runId}@example.com`]) {
		await form.getByLabel('Email or username').fill(invitee)
		await form.getByRole('button', { name: 'Send invite' }).click()
		await expect(
			page.getByTestId('org-invite').filter({ hasText: invitee }),
		).toContainText('Pending')
	}
	const mistaken = page
		.getByTestId('org-invite')
		.filter({ hasText: `nobody-${runId}@example.com` })
	await mistaken.getByTestId('org-invite-revoke').click()
	await expect(mistaken).toHaveCount(0)
	await expect(page.getByTestId('org-invite')).toHaveCount(1)

	await page.context().clearCookies()
	await login({
		email: recipient.email,
		password: recipient.password,
		mode: 'login',
	})
	await page.goto(`/@${recipient.username}/-/waiting`)
	await waitForClientHydration(page)
	const card = page.getByTestId('waiting-invite')
	await expect(card).toHaveCount(1)
	await expect(card).toContainText('Join as Member')
	await expect(card).toContainText('Links Org')
	await Promise.all([
		page.waitForURL(new RegExp(`/@${orgSlug}$`)),
		card.getByTestId('pending-invite-accept').click(),
	])
	await page.goto(`/@${recipient.username}/-/waiting`)
	await waitForClientHydration(page)
	await expect(page.getByTestId('waiting-invite')).toHaveCount(0)
})

for (const state of ['revoked', 'expired'] as const) {
	test(`team invite already open in the browser cannot be accepted after it is ${state}`, async ({
		page,
		browser,
		seedE2eUser,
		login,
	}) => {
		test.setTimeout(process.env.CI ? 120_000 : 90_000)
		const runId = Date.now()
		const owner = await seedE2eUser({
			email: `${state}-owner-${runId}@example.com`,
			username: `${state}-owner-${runId}`,
		})
		const recipient = await seedE2eUser({
			email: `${state}-guest-${runId}@example.com`,
			username: `${state}-guest-${runId}`,
		})
		const { orgSlug } = seedTeamOrg({
			runId,
			ownerId: seedStableUserIdFromEmail(owner.email),
			packageName: `${state}-pkg-${runId}`,
		})
		await login({ ...owner, mode: 'login' })
		await page.goto(`/@${orgSlug}/-/teams`)
		await waitForClientHydration(page)
		await page.getByTestId('org-team-invite-link-create').click()
		const linkUrl = (
			await page.getByTestId('org-team-invite-link-url').innerText()
		).trim()
		const ownerState = await page.context().storageState()
		await page.context().clearCookies()
		await login({ ...recipient, mode: 'login' })
		await page.goto(new URL(linkUrl).pathname)
		await waitForClientHydration(page)
		await expect(page.getByTestId('org-invite-join-confirm')).toBeVisible()

		if (state === 'revoked') {
			const ownerContext = await browser.newContext({
				storageState: ownerState,
			})
			try {
				const ownerPage = await ownerContext.newPage()
				await ownerPage.goto(new URL(`/@${orgSlug}/-/teams`, linkUrl).href)
				await waitForClientHydration(ownerPage)
				await ownerPage
					.getByTestId('org-team-invite-link')
					.getByRole('button', { name: 'Revoke', exact: true })
					.click()
				await expect(ownerPage.getByTestId('org-team-invite-link')).toHaveCount(
					0,
				)
			} finally {
				await ownerContext.close()
			}
		} else {
			// Only the clock fixture changes. Acceptance still uses the real server
			// function and rechecks the database after the valid page was loaded.
			executeE2eD1Command(
				`UPDATE org_invite_links SET expires_at = '2000-01-01T00:00:00.000Z' WHERE org_id = ${sqlString(`org-links-${runId}`)}`,
			)
		}
		await page.getByTestId('org-invite-join-confirm').click()
		await expect(page.getByRole('alert')).toContainText(
			`This invite link has ${state === 'expired' ? 'expired' : 'been revoked'}.`,
		)
		await expect(page.getByTestId('org-invite-join-confirm')).toHaveCount(0)
		await page.reload()
		await waitForClientHydration(page)
		await expect(page.getByRole('alert')).toContainText(
			`This invite link has ${state === 'expired' ? 'expired' : 'been revoked'}.`,
		)
		await expect(page.getByTestId('org-invite-join-confirm')).toHaveCount(0)
		await page.goto(`/@${recipient.username}/-/waiting`)
		await waitForClientHydration(page)
		await expect(page.getByTestId('waiting-invite')).toHaveCount(0)
		const denied = await page.goto(`/@${orgSlug}/-/teams`)
		expect(denied?.status()).toBe(404)
		await expect(
			page.getByRole('heading', {
				name: "This doesn't quite connect.",
				exact: true,
			}),
		).toBeVisible()
		await expect(page.getByTestId('org-teams')).toHaveCount(0)
		await expect(page.getByText('Writers', { exact: true })).toHaveCount(0)
	})
}

for (const kind of ['package', 'team'] as const) {
	test(`${kind} invite handoff disappears after a committed revoke loses its response`, async ({
		page,
		seedE2eUser,
		login,
	}) => {
		const runId = Date.now()
		const owner = await seedE2eUser({
			email: `lost-${kind}-${runId}@example.com`,
			username: `lost-${kind}-${runId}`,
		})
		const packageName = `lost-${kind}-${runId}`
		const { orgSlug } = seedTeamOrg({
			runId,
			ownerId: seedStableUserIdFromEmail(owner.email),
			packageName,
		})
		await login({ ...owner, mode: 'login' })
		await page.goto(
			kind === 'package'
				? `/@${orgSlug}/${packageName}/collaborators`
				: `/@${orgSlug}/-/teams`,
		)
		await waitForClientHydration(page)
		const prefix =
			kind === 'package' ? 'package-invite-link' : 'org-team-invite-link'
		await page.getByTestId(`${prefix}-create`).click()
		await expect(page.getByTestId(`${prefix}-url`)).toBeVisible()
		const row = page.getByTestId(prefix)
		await expect(row).toHaveCount(1)
		let droppedRevoke = false
		const loseRevokeResponse = async (route: Route) => {
			if (
				route.request().method() !== 'POST' ||
				!route.request().postData()?.includes('linkId')
			)
				return route.fallback()
			const response = await route.fetch()
			expect(response.ok()).toBe(true)
			droppedRevoke = true
			await route.abort('failed')
		}
		await page.route('**/_serverFn/**', loseRevokeResponse)
		try {
			await row.getByRole('button', { name: 'Revoke', exact: true }).click()
			await expect(row).toHaveCount(0)
			await expect(page.getByTestId(`${prefix}-url`)).toHaveCount(0)
			expect(droppedRevoke).toBe(true)
		} finally {
			await page.unroute('**/_serverFn/**', loseRevokeResponse)
		}
	})
}
