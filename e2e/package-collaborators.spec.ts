import { type Route } from '@playwright/test'
import { seedStableUserIdFromEmail } from '../tools/seed-sql.ts'
import { executeE2eD1Command } from './d1-utils.ts'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'

function sqlString(value: string) {
	return `'${value.replaceAll("'", "''")}'`
}

test('package Collaborators tab adds, changes, and removes internal access', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const runId = Date.now()
	const owner = await seedE2eUser({
		email: `collab-owner-${runId}@example.com`,
		username: `collab-owner-${runId}`,
		password: 'collab-owner-password',
	})
	const member = await seedE2eUser({
		email: `collab-member-${runId}@example.com`,
		username: `collab-member-${runId}`,
		password: 'collab-member-password',
	})
	const ownerId = seedStableUserIdFromEmail(owner.email)
	const memberId = seedStableUserIdFromEmail(member.email)
	const orgId = `org-collab-${runId}`
	const orgSlug = `collab-org-${runId}`
	const teamId = `team-collab-${runId}`
	const packageName = `collab-pkg-${runId}`
	const now = new Date().toISOString()
	executeE2eD1Command(`
INSERT INTO orgs (id, slug, display_name, created_by_user_id, created_at, updated_at)
VALUES (${sqlString(orgId)}, ${sqlString(orgSlug)}, 'Collab Org', ${sqlString(ownerId)}, ${sqlString(now)}, ${sqlString(now)});
INSERT INTO org_memberships (org_id, user_id, role, created_at)
VALUES
	(${sqlString(orgId)}, ${sqlString(ownerId)}, 'owner', ${sqlString(now)}),
	(${sqlString(orgId)}, ${sqlString(memberId)}, 'member', ${sqlString(now)});
INSERT INTO teams (id, org_id, slug, name, created_at, updated_at)
VALUES (${sqlString(teamId)}, ${sqlString(orgId)}, 'writers', 'Writers', ${sqlString(now)}, ${sqlString(now)});
INSERT INTO saved_packages (
	id, user_id, name, kody_id, description, tags_json, search_text,
	source_id, has_app, hidden, is_private
) VALUES (
	${sqlString(`pkg-collab-${runId}`)}, ${sqlString(orgId)}, ${sqlString(packageName)},
	${sqlString(packageName)}, 'E2E collaborators package', '[]', ${sqlString(packageName)},
	${sqlString(`src-collab-${runId}`)}, 0, 0, 1
);
`)

	await login({ email: owner.email, password: owner.password, mode: 'login' })
	await page.goto(`/@${orgSlug}/${packageName}`)
	await waitForClientHydration(page)
	const tab = page.getByTestId('package-repo-nav-collaborators')
	await expect(tab).toBeVisible()
	await Promise.all([
		page.waitForURL(new RegExp(`/@${orgSlug}/${packageName}/collaborators$`)),
		tab.click(),
	])
	await expect(page.getByTestId('package-collaborators-empty')).toBeVisible()

	const status = page.getByRole('status').filter({ hasText: /\S/ }).last()
	const rows = page.getByTestId('package-collaborator')

	const addMember = page.getByTestId('package-collaborators-add-member')
	await addMember
		.getByRole('combobox', { name: 'Member', exact: true })
		.selectOption({ label: `@${member.username}` })
	await addMember.getByRole('button', { name: 'Add member' }).click()
	const memberRow = rows.filter({ hasText: `@${member.username}` })
	await expect(memberRow).toContainText('Org member')
	const memberAccess = memberRow.getByRole('combobox', {
		name: `Access for @${member.username}`,
	})
	await expect(memberAccess).toHaveValue('use')

	await memberAccess.selectOption('manage')
	await expect(status).toContainText(
		`@${member.username} can now manage this package.`,
	)
	await page.reload()
	await waitForClientHydration(page)
	await expect(memberAccess).toHaveValue('manage')

	const addTeam = page.getByTestId('package-collaborators-add-team')
	await addTeam
		.getByRole('combobox', { name: 'Team', exact: true })
		.selectOption({ label: 'Writers (0 members)' })
	await addTeam
		.getByRole('combobox', { name: 'Access for the team' })
		.selectOption('contribute')
	await addTeam.getByRole('button', { name: 'Add team' }).click()
	const teamRow = rows.filter({ hasText: 'Writers' })
	await expect(teamRow).toContainText('Team')
	await expect(
		teamRow.getByRole('combobox', { name: 'Access for Writers' }),
	).toHaveValue('contribute')

	await expect(page.getByTestId('package-collaborators-invite')).toHaveCount(0)
	await expect(
		page.getByTestId('package-collaborators-team-callout'),
	).toHaveCount(0)

	await memberRow.getByRole('button', { name: 'Remove' }).click()
	await memberRow.getByRole('button', { name: 'Confirm remove' }).click()
	await expect(memberRow).toHaveCount(0)
	await expect(rows).toHaveCount(1)
	await expect(
		addMember.getByRole('combobox', { name: 'Member', exact: true }),
	).toContainText(`@${member.username}`)
})

test('a personal org owner invites an outside collaborator, revokes the invite, and removes access', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const runId = Date.now()
	const owner = await seedE2eUser({
		email: `solo-owner-${runId}@example.com`,
		username: `solo-owner-${runId}`,
		password: 'solo-owner-password',
	})
	const friend = await seedE2eUser({
		email: `solo-friend-${runId}@example.com`,
		username: `solo-friend-${runId}`,
		password: 'solo-friend-password',
	})
	const ownerId = seedStableUserIdFromEmail(owner.email)
	const friendId = seedStableUserIdFromEmail(friend.email)
	const packageId = `pkg-solo-${runId}`
	const packageName = `solo-pkg-${runId}`
	const now = new Date().toISOString()
	executeE2eD1Command(`
INSERT INTO saved_packages (
	id, user_id, name, kody_id, description, tags_json, search_text,
	source_id, has_app, hidden, is_private
) VALUES (
	${sqlString(packageId)}, ${sqlString(ownerId)}, ${sqlString(packageName)},
	${sqlString(packageName)}, 'E2E personal package', '[]', ${sqlString(packageName)},
	${sqlString(`src-solo-${runId}`)}, 0, 0, 1
);
`)

	await login({ email: owner.email, password: owner.password, mode: 'login' })
	await page.goto(`/@${owner.username}/${packageName}/collaborators`)
	await waitForClientHydration(page)
	await expect(page.getByTestId('package-collaborators-empty')).toBeVisible()
	await expect(
		page.getByTestId('package-collaborators-add-member'),
	).toHaveCount(0)

	const callout = page.getByTestId('package-collaborators-team-callout')
	await expect(
		callout.getByRole('link', { name: 'Create a team organization' }),
	).toHaveAttribute('href', '/account/organizations/new')
	await expect(
		callout.getByRole('link', { name: 'Learn more' }),
	).toHaveAttribute('href', '/docs/organizations')

	const form = page.getByTestId('package-collaborators-invite')
	await expect(form).toContainText('They cannot change it.')
	await form
		.getByRole('textbox', { name: 'Email or username' })
		.fill(`@${friend.username}`)
	await form.getByRole('radio', { name: /Contribute/ }).check()
	await form.getByRole('button', { name: 'Create invite' }).click()

	const ready = page.getByTestId('package-collaborators-invite-ready')
	await expect(ready).toContainText(`Invite ready for @${friend.username}`)
	await expect(
		ready.getByRole('button', { name: 'Copy invite message' }),
	).toBeVisible()
	const prompt = page.getByTestId('package-collaborators-prompt')
	await expect(prompt).toBeHidden()
	await ready.getByText('Details', { exact: true }).click()
	await expect(prompt).toContainText('Call inviteAccept with this token:')

	const invites = page.getByTestId('package-collaborator-invite')
	const pending = invites.filter({ hasText: `@${friend.username}` })
	await expect(pending).toContainText('Contribute')

	await form
		.getByRole('textbox', { name: 'Email or username' })
		.fill('not a username!')
	await form.getByRole('button', { name: 'Create invite' }).click()
	await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toBeVisible()
	await expect(ready).toContainText(`Invite ready for @${friend.username}`)
	await expect(invites).toHaveCount(1)

	let droppedRevoke = false
	const loseRevokeResponse = async (route: Route) => {
		if (
			route.request().method() !== 'POST' ||
			!route.request().postData()?.includes('inviteId')
		)
			return route.fallback()
		const response = await route.fetch()
		expect(response.ok()).toBe(true)
		droppedRevoke = true
		await route.abort('failed')
	}
	await page.route('**/_serverFn/**', loseRevokeResponse)
	try {
		await pending.getByRole('button', { name: 'Revoke' }).click()
		await pending.getByRole('button', { name: 'Confirm revoke' }).click()
		await expect(invites).toHaveCount(0)
		await expect(ready).toHaveCount(0)
		expect(droppedRevoke).toBe(true)
	} finally {
		await page.unroute('**/_serverFn/**', loseRevokeResponse)
	}

	await form
		.getByRole('textbox', { name: 'Email or username' })
		.fill(`@${friend.username}`)
	await form.getByRole('button', { name: 'Create invite' }).click()
	await expect(ready).toBeVisible()
	await page.reload()
	await waitForClientHydration(page)
	await expect(pending).toContainText('Use')
	await expect(ready).toHaveCount(0)

	executeE2eD1Command(`
INSERT INTO grants (
	id, org_id, resource_type, resource_id, subject_type, subject_id,
	preset, created_by_user_id, created_at, updated_at
) VALUES (
	${sqlString(`grant-solo-${runId}`)}, ${sqlString(ownerId)}, 'package', ${sqlString(packageId)},
	'user', ${sqlString(friendId)}, 'use', ${sqlString(ownerId)}, ${sqlString(now)}, ${sqlString(now)}
);
INSERT INTO grant_permissions (grant_id, permission) VALUES
	(${sqlString(`grant-solo-${runId}`)}, 'package:read'),
	(${sqlString(`grant-solo-${runId}`)}, 'package:execute');
`)
	await page.reload()
	await waitForClientHydration(page)
	const row = page
		.getByTestId('package-collaborator')
		.filter({ hasText: `@${friend.username}` })
	await expect(row).toContainText('Outside collaborator')
	await expect(row).toContainText('Use')
	await row.getByRole('button', { name: 'Remove' }).click()
	await row.getByRole('button', { name: 'Confirm remove' }).click()
	await expect(row).toHaveCount(0)
	await expect(page.getByTestId('package-collaborators-empty')).toBeVisible()
})

for (const failed of [false, true]) {
	test(`addressed invite ${failed ? 'failure' : 'success'} stays with its submitted package after navigation`, async ({
		page,
		seedE2eUser,
		login,
	}) => {
		const id = Date.now()
		const owner = await seedE2eUser({
			email: `invite-scope-${id}@example.com`,
			username: `invite-scope-${id}`,
		})
		const ownerId = seedStableUserIdFromEmail(owner.email)
		for (const name of ['invite-a', 'invite-b']) {
			executeE2eD1Command(
				`INSERT INTO saved_packages (id,user_id,name,kody_id,description,tags_json,search_text,source_id,has_app,hidden,is_private) VALUES (${sqlString(`${name}-${id}`)},${sqlString(ownerId)},${sqlString(name)},${sqlString(name)},'Invite scope fixture','[]',${sqlString(name)},${sqlString(`src-${name}-${id}`)},0,0,1);`,
			)
		}
		await login({ ...owner, mode: 'login' })
		const pathA = `/@${owner.username}/invite-a/collaborators`
		const pathB = `/@${owner.username}/invite-b/collaborators`
		await page.goto(pathA)
		await waitForClientHydration(page)
		const target = failed ? 'not a username!' : `friend-${id}@example.com`
		let release!: () => void
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		let held = false
		let captured = false
		let delivered = false
		await page.route('**/_serverFn/**', async (route) => {
			if (
				captured ||
				route.request().method() !== 'POST' ||
				!route.request().postData()?.includes(target)
			)
				return route.fallback()
			captured = true
			const response = await route.fetch()
			held = true
			await barrier
			await route.fulfill({ response })
			delivered = true
		})
		try {
			const form = page.getByTestId('package-collaborators-invite')
			await form
				.getByRole('textbox', { name: 'Email or username' })
				.fill(target)
			await form.getByRole('button', { name: 'Create invite' }).click()
			await expect.poll(() => held).toBe(true)
			// Router owns this same-document transition, retaining the pending mutation.
			await page.evaluate(
				(next) => window.history.pushState(null, '', next),
				pathB,
			)
			await expect(page).toHaveURL(new RegExp(`${pathB}$`))
			await expect(page.getByTestId('package-title-name')).toHaveText(
				'invite-b',
			)
			release()
			await expect.poll(() => delivered).toBe(true)
			await expect(
				form.getByRole('button', { name: 'Create invite' }),
			).toBeDisabled()
			await expect(
				page.getByTestId('package-collaborators-invite-ready'),
			).toHaveCount(0)
			await expect(
				page.getByText('Invite created.', { exact: true }),
			).toHaveCount(0)
			await expect(page.getByRole('alert')).toHaveCount(0)
			await page.reload()
			await waitForClientHydration(page)
			await expect(page.getByTestId('package-collaborator-invite')).toHaveCount(
				0,
			)
			await page.goto(pathA)
			await waitForClientHydration(page)
			await expect(page.getByTestId('package-collaborator-invite')).toHaveCount(
				failed ? 0 : 1,
			)
			await expect(
				page.getByTestId('package-collaborators-invite-ready'),
			).toHaveCount(0)
		} finally {
			release()
		}
	})
}
