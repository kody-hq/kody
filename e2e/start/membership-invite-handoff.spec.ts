import { seedStableUserIdFromEmail } from '../../tools/seed-sql.ts'
import { executeE2eD1Command } from '../d1-utils.ts'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'
import { requestHasMutationDataFields } from '../server-function-requests.ts'

function sqlString(value: string) {
	return `'${value.replaceAll("'", "''")}'`
}

test('membership invite handoff survives failed attempts and clears only when its own link is revoked', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const id = Date.now()
	const owner = await seedE2eUser({
		email: `membership-handoff-${id}@example.com`,
		username: `membership-handoff-${id}`,
	})
	const ownerId = seedStableUserIdFromEmail(owner.email)
	const orgId = `org-handoff-${id}`
	const slug = `handoff-${id}`
	const now = new Date().toISOString()
	executeE2eD1Command(`
 INSERT INTO orgs (id,slug,display_name,created_by_user_id,created_at,updated_at)
 VALUES (${sqlString(orgId)},${sqlString(slug)},'Handoff Org',${sqlString(ownerId)},${sqlString(now)},${sqlString(now)});
 INSERT INTO org_memberships (org_id,user_id,role,created_at)
 VALUES (${sqlString(orgId)},${sqlString(ownerId)},'owner',${sqlString(now)});
 `)
	await login({ ...owner, mode: 'login' })
	await page.goto(`/@${slug}/-/members`)
	await waitForClientHydration(page)
	const form = page.getByTestId('org-invite-link-form')
	const create = page.getByTestId('org-invite-link-copy')
	const handoff = page.getByTestId('invite-link-url')
	const rows = page.getByTestId('org-invite-link')
	await create.click()
	await expect(handoff).toBeVisible()
	await expect(rows).toHaveCount(1)
	const firstUrl = (await handoff.locator('code').innerText()).trim()
	const firstId = await rows.first().getAttribute('data-invite-link-id')
	expect(firstId).toBeTruthy()
	// A rejected second create must not discard the only copy of the first URL.
	await form.getByLabel('Max uses (optional)').fill('0')
	await create.click()
	await expect(page.getByRole('alert')).toContainText(
		'Max uses must be a positive integer.',
	)
	await expect(handoff.locator('code')).toHaveText(firstUrl)
	await expect(rows).toHaveCount(1)
	await form.getByLabel('Max uses (optional)').fill('')
	await create.click()
	await expect(rows).toHaveCount(2)
	await expect(handoff.locator('code')).not.toHaveText(firstUrl)
	const secondUrl = (await handoff.locator('code').innerText()).trim()
	const firstRow = page.locator(`[data-invite-link-id="${firstId}"]`)
	const secondRow = page.locator(
		`[data-testid="org-invite-link"]:not([data-invite-link-id="${firstId}"])`,
	)
	const secondId = await secondRow.getAttribute('data-invite-link-id')
	expect(secondId).toBeTruthy()
	// Revoking another link must preserve the currently displayed handoff.
	await firstRow.getByRole('button', { name: 'Revoke', exact: true }).click()
	await expect(firstRow).toHaveCount(0)
	await expect(handoff.locator('code')).toHaveText(secondUrl)
	let dropAfterCommit = false
	let intercepted = 0
	await page.route('**/_serverFn/**', async (route) => {
		if (
			!requestHasMutationDataFields(route.request(), {
				orgSlug: slug,
				linkId: secondId,
			})
		)
			return route.fallback()
		if (dropAfterCommit) {
			const response = await route.fetch()
			expect(response.ok()).toBe(true)
		}
		intercepted++
		await route.abort('failed')
	})
	// A transport failure before the write leaves the link and its URL usable.
	await secondRow.getByRole('button', { name: 'Revoke', exact: true }).click()
	await expect.poll(() => intercepted).toBe(1)
	await expect(page.getByRole('alert')).toBeVisible()
	await expect(
		secondRow.getByRole('button', { name: 'Revoke', exact: true }),
	).toBeEnabled()
	await expect(handoff.locator('code')).toHaveText(secondUrl)
	// A lost response after the real write is reconciled by the confirming read.
	dropAfterCommit = true
	await secondRow.getByRole('button', { name: 'Revoke', exact: true }).click()
	await expect.poll(() => intercepted).toBe(2)
	await expect(rows).toHaveCount(0)
	await expect(handoff).toHaveCount(0)
	await page.reload()
	await waitForClientHydration(page)
	await expect(rows).toHaveCount(0)
	await expect(handoff).toHaveCount(0)
	// The parent's explicit revision reset still hides a link handoff when an
	// addressed invitation is started, even if that different action is rejected.
	await create.click()
	await expect(handoff).toBeVisible()
	const addressed = page.getByTestId('org-invite-form')
	await addressed.getByLabel('Email or username').fill('not a username!')
	await addressed.getByRole('button', { name: 'Send invite' }).click()
	await expect(handoff).toHaveCount(0)
	await expect(page.getByRole('alert')).toBeVisible()
	await expect(rows).toHaveCount(1)
})
