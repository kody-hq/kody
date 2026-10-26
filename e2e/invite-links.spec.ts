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
		page.waitForURL(new RegExp(`/@${orgSlug}/-/overview$`)),
		card.getByTestId('pending-invite-accept').click(),
	])
	await page.goto(`/@${recipient.username}/-/waiting`)
	await waitForClientHydration(page)
	await expect(page.getByTestId('waiting-invite')).toHaveCount(0)
})
