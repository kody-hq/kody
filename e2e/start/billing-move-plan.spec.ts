import { randomUUID } from 'node:crypto'
import { seedStableUserIdFromEmail } from '../../tools/seed-sql.ts'
import { executeE2eD1Command } from '../d1-utils.ts'
import {
	expect,
	test,
	type Page,
	waitForClientHydration,
} from '../playwright-utils.ts'

function sqlString(value: string) {
	return `'${value.replaceAll("'", "''")}'`
}

const screenshotDir = process.env.KODY_E2E_SCREENSHOT_DIR

async function captureBothThemes(page: Page, name: string) {
	if (!screenshotDir) return
	for (const colorScheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
		await page.screenshot({
			path: `${screenshotDir}/${name}-${colorScheme}.png`,
			fullPage: true,
		})
	}
	await page.emulateMedia({ colorScheme: null })
}

test('owner moves a paid monthly Pro plan from a personal org to a Free work org', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.skip(
		Boolean(process.env.PLAYWRIGHT_BASE_URL),
		'Requires the isolated E2E Stripe simulator',
	)
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `move-plan-${id}@example.com`,
		username: `move-plan-${id}`,
	})
	const userId = seedStableUserIdFromEmail(user.email)
	const workSlug = `work-${id}`
	const now = new Date().toISOString()
	// The simulator gives `cus_e2e_pro_month_*` one paid month, 10 days in.
	executeE2eD1Command(`
UPDATE orgs SET stripe_customer_id = ${sqlString(`cus_e2e_pro_month_${id}`)}
WHERE id = ${sqlString(userId)};
INSERT INTO orgs (id, slug, display_name, created_by_user_id, created_at, updated_at)
VALUES (${sqlString(`org-work-${id}`)}, ${sqlString(workSlug)}, 'Work', ${sqlString(userId)}, ${sqlString(now)}, ${sqlString(now)});
INSERT INTO org_memberships (org_id, user_id, role, created_at)
VALUES (${sqlString(`org-work-${id}`)}, ${sqlString(userId)}, 'owner', ${sqlString(now)});
`)
	await login({ ...user, mode: 'login' })
	const billing = `/@${user.username}/-/billing`
	await page.goto(billing)
	await waitForClientHydration(page)
	await page
		.getByRole('link', { name: 'Move this plan to another organization' })
		.click()
	await expect(page).toHaveURL(new RegExp(`${billing}/move-plan`))
	await page.getByRole('link', { name: new RegExp(`@${workSlug}`) }).click()
	await expect(page.getByText('Review the move')).toBeVisible()
	await expect(page.getByText('Remaining prepaid value')).toBeVisible()
	await expect(page.getByText('$8.00').first()).toBeVisible()
	const confirm = page.getByRole('button', {
		name: `Continue to checkout for @${workSlug}`,
	})
	await expect(confirm).toBeDisabled()
	await captureBothThemes(page, 'move-plan-preview')
	await page.getByRole('checkbox').check()
	await confirm.click()
	await expect(
		page.getByRole('heading', { name: 'Test checkout' }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Complete test payment' }).click()
	await expect(page).toHaveURL(/\/billing\/success\?session_id=cs_/)
	await expect(page.getByRole('heading', { name: 'Plan moved' })).toBeVisible()
	await captureBothThemes(page, 'move-plan-success')
	await page.goto(`${billing}/move-plan`)
	await waitForClientHydration(page)
	await expect(page.getByText(`Pro now lives in @${workSlug}`)).toBeVisible()
	await captureBothThemes(page, 'move-plan-confirmation')
	await page.goto(billing)
	await waitForClientHydration(page)
	await expect(
		page.getByRole('link', { name: 'Move this plan to another organization' }),
	).toHaveCount(0)
})
