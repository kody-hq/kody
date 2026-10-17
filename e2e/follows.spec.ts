import { seedStableUserIdFromEmail } from '../tools/seed-sql.ts'
import { executeE2eD1Command } from './d1-utils.ts'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'

function sqlString(value: string) {
	return `'${value.replaceAll("'", "''")}'`
}

function seedPublicRepo(input: { ownerId: string; id: string; name: string }) {
	const now = new Date().toISOString()
	executeE2eD1Command(`
INSERT INTO user_repos (id, user_id, name, description, is_private, created_at, updated_at)
VALUES (
	${sqlString(input.id)},
	${sqlString(input.ownerId)},
	${sqlString(input.name)},
	'E2E follow repo',
	0,
	${sqlString(now)},
	${sqlString(now)}
);
`)
}

test('follow a repo for pushes, see it on Follows, and unfollow there', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `follows-owner-${runId}@example.com`,
		username: `follows-owner-${runId}`,
		password: 'follows-owner-password',
	})
	const repoName = `followed-notes-${runId}`
	seedPublicRepo({
		ownerId: seedStableUserIdFromEmail(user.email),
		id: `repo-follow-${runId}`,
		name: repoName,
	})

	await login({ email: user.email, password: user.password, mode: 'login' })
	await page.goto(`/@${user.username}/${repoName}`)
	await waitForClientHydration(page)

	const toggle = page.getByTestId('package-follow-toggle')
	await expect(toggle).toHaveText(/Follow/)
	await toggle.click()
	const panel = page.getByTestId('package-follow-panel')
	await expect(panel).toBeVisible()
	await expect(toggle).toHaveAttribute('aria-expanded', 'true')
	await expect(panel.getByRole('checkbox', { name: /Pushes/ })).toBeChecked()
	await expect(
		panel.getByRole('checkbox', { name: /New versions/ }),
	).toHaveCount(0)
	await panel.getByTestId('package-follow-submit').click()
	await expect(panel.getByTestId('package-follow-message')).toHaveText(
		'Following. Pushes go to your personal workspace.',
	)
	await expect(toggle).toHaveText(/Following/)

	await page.evaluate(() => {
		document.documentElement.dataset.followsNavigation = 'retained'
	})

	await Promise.all([
		page.waitForURL(new RegExp(`/@${user.username}/-/follows$`)),
		panel.getByTestId('package-follow-manage').click(),
	])
	await expect(
		page.getByRole('heading', { level: 1, name: 'Follows' }),
	).toBeVisible()
	await expect(page.locator('html')).toHaveAttribute(
		'data-follows-navigation',
		'retained',
	)
	await waitForClientHydration(page)
	const row = page.getByTestId('org-follow').filter({ hasText: repoName })
	await expect(row.getByTestId('org-follow-status')).toHaveText('Active')
	await expect(row).toContainText('Repository · Pushes')
	await expect(row.getByText('Follow ID')).toBeHidden()
	await row.getByText('Details').click()
	await expect(row.getByText('Follow ID')).toBeVisible()

	const unfollow = row.getByTestId('org-follow-unfollow')
	await unfollow.click()
	await expect(unfollow).toHaveText(/Confirm unfollow/)
	await unfollow.click()
	await expect(
		page.getByText(`Unfollowed @${user.username}/${repoName}.`),
	).toBeVisible()
	await expect(page.getByTestId('org-follows-empty')).toBeVisible()
})

test('#follow opens the panel and explains why a repo without read access cannot be followed', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const owner = await seedE2eUser({
		email: `follows-repo-owner-${runId}@example.com`,
		username: `follows-repo-owner-${runId}`,
		password: 'follows-repo-owner-password',
	})
	const visitor = await seedE2eUser({
		email: `follows-visitor-${runId}@example.com`,
		username: `follows-visitor-${runId}`,
		password: 'follows-visitor-password',
	})
	const repoName = `public-stash-${runId}`
	seedPublicRepo({
		ownerId: seedStableUserIdFromEmail(owner.email),
		id: `repo-gated-${runId}`,
		name: repoName,
	})

	await login({
		email: visitor.email,
		password: visitor.password,
		mode: 'login',
	})
	await page.goto(`/@${owner.username}/${repoName}#follow`)
	await waitForClientHydration(page)

	const panel = page.getByTestId('package-follow-panel')
	await expect(panel).toBeVisible()
	await expect(
		panel.getByTestId('package-follow-event-pushed-gated'),
	).toHaveText(
		`Pushes need read access to @${owner.username}/${repoName}. A Use grant includes read; run-only access does not.`,
	)
	await expect(panel.getByTestId('package-follow-blocked')).toBeVisible()
	await expect(panel.getByTestId('package-follow-submit')).toBeDisabled()
})

test('an existing push follow without read access still shows pushes as on', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const owner = await seedE2eUser({
		email: `follows-kept-owner-${runId}@example.com`,
		username: `kept-owner-${runId}`,
		password: 'follows-kept-owner-password',
	})
	const visitor = await seedE2eUser({
		email: `kept-visitor-${runId}@example.com`,
		username: `kept-visitor-${runId}`,
		password: 'follows-kept-visitor-password',
	})
	const ownerId = seedStableUserIdFromEmail(owner.email)
	const visitorId = seedStableUserIdFromEmail(visitor.email)
	const repoName = `kept-stash-${runId}`
	const repoId = `repo-kept-${runId}`
	seedPublicRepo({ ownerId, id: repoId, name: repoName })
	const now = new Date().toISOString()
	executeE2eD1Command(`
INSERT INTO follows (
	id, follower_org_id, creator_user_id, target_kind, target_owner_id,
	target_id, target_name, status, published_enabled, pushed_enabled,
	created_at, updated_at
) VALUES (
	${sqlString(`follow-kept-${runId}`)},
	${sqlString(visitorId)},
	${sqlString(visitorId)},
	'repo',
	${sqlString(ownerId)},
	${sqlString(repoId)},
	${sqlString(`@${owner.username}/${repoName}`)},
	'active',
	0,
	1,
	${sqlString(now)},
	${sqlString(now)}
);
`)

	await login({
		email: visitor.email,
		password: visitor.password,
		mode: 'login',
	})
	await page.goto(`/@${owner.username}/${repoName}#follow`)
	await waitForClientHydration(page)

	const panel = page.getByTestId('package-follow-panel')
	await expect(panel).toBeVisible()
	await expect(panel.getByTestId('package-follow-status')).toHaveText(
		'Following. Pushes go to this workspace.',
	)
	const pushes = panel.getByRole('checkbox', { name: /Pushes/ })
	await expect(pushes).toBeChecked()
	await expect(pushes).toBeDisabled()
	await expect(panel.getByTestId('package-follow-submit')).toBeDisabled()
	await expect(panel.getByTestId('package-follow-unfollow')).toBeEnabled()
})
