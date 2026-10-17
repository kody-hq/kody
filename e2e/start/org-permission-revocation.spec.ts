import { randomUUID } from 'node:crypto'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { seedStableUserIdFromEmail } from '../../tools/seed-sql.ts'
import { executeE2eD1Command } from '../d1-utils.ts'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

test('removed org member cannot reuse a warm protected page or submit an org write', async ({
	page,
	browser,
	seedE2eUser,
	login,
	baseURL,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const id = randomUUID().slice(0, 8)
	const owner = await seedE2eUser({
		email: `revoke-owner-${id}@example.com`,
		username: `revoke-owner-${id}`,
	})
	const member = await seedE2eUser({
		email: `revoke-member-${id}@example.com`,
		username: `revoke-member-${id}`,
	})
	const ownerId = seedStableUserIdFromEmail(owner.email)
	const memberId = seedStableUserIdFromEmail(member.email)
	const orgId = `org-revoke-${id}`
	const orgSlug = `revoke-${id}`
	const now = new Date().toISOString()
	// Same membership fixtures as the collaborators suite. The revocation itself
	// must go through the owner UI and its real Start mutation.
	executeE2eD1Command(`
INSERT INTO orgs (id, slug, display_name, created_by_user_id, created_at, updated_at)
VALUES (${quoteSqlString(orgId)}, ${quoteSqlString(orgSlug)}, 'Revocation test', ${quoteSqlString(ownerId)}, ${quoteSqlString(now)}, ${quoteSqlString(now)});
INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES
(${quoteSqlString(orgId)}, ${quoteSqlString(ownerId)}, 'owner', ${quoteSqlString(now)}),
(${quoteSqlString(orgId)}, ${quoteSqlString(memberId)}, 'member', ${quoteSqlString(now)});
`)
	await login({ ...owner, mode: 'login' })
	const ownerContext = await browser.newContext({
		storageState: await page.context().storageState(),
	})
	const ownerPage = await ownerContext.newPage()
	const origin = new URL(baseURL ?? 'http://127.0.0.1:3847').origin
	try {
		await ownerPage.goto(`${origin}/@${orgSlug}/-/members`)
		await waitForClientHydration(ownerPage)
		const memberRow = ownerPage
			.getByTestId('org-member')
			.filter({ hasText: `@${member.username}` })
		await expect(memberRow).toBeVisible()

		await page.context().clearCookies()
		await login({ ...member, mode: 'login' })
		const listHref = `/@${orgSlug}/-/credentials?kind=mcp`
		await page.goto(listHref)
		await waitForClientHydration(page)
		await expect(
			page.getByRole('heading', { name: 'Credentials', exact: true }),
		).toBeVisible()
		await page.evaluate((value) => {
			;(window as unknown as Record<string, unknown>).__revocationDocument =
				value
		}, id)
		await page
			.getByRole('link', { name: 'Add credential', exact: true })
			.click()
		await expect(page).toHaveURL(new RegExp(`/@${orgSlug}/-/credentials/new$`))
		await expect(
			page.getByRole('heading', { name: 'Add a credential', exact: true }),
		).toBeVisible()

		await memberRow.getByRole('button', { name: 'Remove', exact: true }).click()
		await memberRow
			.getByRole('button', { name: 'Confirm remove', exact: true })
			.click()
		await expect(memberRow).toHaveCount(0)
		await expect(
			ownerPage.getByText('Member removed.', { exact: true }),
		).toBeVisible()

		// Same document and QueryClient, within the list's 30 second freshness
		// window. Back navigation must recheck access instead of reusing the cache.
		await page.goBack()
		await expect(page).toHaveURL(
			new RegExp(`/@${orgSlug}/-/credentials\\?kind=mcp$`),
		)
		await expect(page.getByTestId('not-found-page')).toBeVisible()
		expect(
			await page.evaluate(
				() =>
					(window as unknown as Record<string, unknown>).__revocationDocument,
			),
		).toBe(id)
		await expect(
			page.getByRole('heading', { name: 'Credentials', exact: true }),
		).toHaveCount(0)

		// As in org-binding-guard, forge only the org input from a usable form.
		// The actual Start handler must deny the request, with no mocked response.
		await page.goto(`/@${member.username}/-/mcp-servers/new`)
		await waitForClientHydration(page)
		let forged = false
		await page.route('**/_serverFn/**', async (route) => {
			if (
				route.request().method() !== 'POST' ||
				!route.request().postData()?.includes('orgSlug')
			)
				return route.fallback()
			const body: unknown = route.request().postDataJSON()
			function changeScope(value: unknown): void {
				if (!value || typeof value !== 'object') return
				const record = value as Record<string, unknown>
				if (record.orgSlug === member.username) {
					record.orgSlug = orgSlug
					forged = true
				}
				if (Array.isArray(record.k) && Array.isArray(record.v)) {
					const index = record.k.indexOf('orgSlug')
					const node = record.v[index] as { s?: string } | undefined
					if (index >= 0 && node?.s === member.username) {
						node.s = orgSlug
						forged = true
					}
				}
				for (const child of Object.values(record)) changeScope(child)
			}
			changeScope(body)
			expect(forged).toBe(true)
			await route.continue({ postData: JSON.stringify(body) })
		})
		await page.locator('input[name="name"]').fill(`revoked-write-${id}`)
		await page.getByLabel('Server URL').fill('http://127.0.0.1:9/mcp')
		await page
			.locator('button[type="submit"]')
			.filter({ hasText: /^Add server$/ })
			.click()
		await expect.poll(() => forged).toBe(true)
		await expect(
			page.getByText('Organization not found.', { exact: false }).first(),
		).toBeVisible()
		await page.unrouteAll({ behavior: 'wait' })
		await ownerPage.goto(`${origin}${listHref}`)
		await waitForClientHydration(ownerPage)
		await expect(
			ownerPage.getByRole('heading', { name: 'Credentials', exact: true }),
		).toBeVisible()
		await expect(
			ownerPage.getByText(`revoked-write-${id}`, { exact: true }),
		).toHaveCount(0)
	} finally {
		await page.unrouteAll({ behavior: 'wait' })
		await ownerContext.close()
	}
})
