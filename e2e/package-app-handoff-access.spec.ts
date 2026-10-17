import { expect, test, waitForClientHydration } from './playwright-utils.ts'
import { executeE2eD1Command } from './d1-utils.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'

/**
 * Hosted package-app handoff sends visitors without app:execute to the
 * saved-package page. That page must say "you don't have access" for a
 * signed-in outsider, never the generic "doesn't quite connect" 404.
 *
 * Cross-origin token mint/exchange lives in
 * `package-app-origin.workers.test.ts` (requires PACKAGE_APP_BASE_URL). This
 * E2E locks the user-visible no-access landing that Tanner hit after Continue.
 */
test('a signed-in outsider hitting a private package page sees no-access, not a missing-page 404', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const runId = Date.now()
	const owner = await seedE2eUser({
		email: `pkg-access-owner-${runId}@example.com`,
		username: `pkgaccessowner${runId}`.slice(0, 32),
		password: 'pkg-access-owner-password',
	})
	const stranger = await seedE2eUser({
		email: `pkg-access-stranger-${runId}@example.com`,
		username: `pkgaccessstranger${runId}`.slice(0, 32),
		password: 'pkg-access-stranger-password',
	})
	const packageId = crypto.randomUUID()
	const sourceId = crypto.randomUUID()
	const kodyId = `private-demo-${runId}`
	const packageName = `@${owner.username}/${kodyId}`
	const privateDescription = `Private package metadata ${crypto.randomUUID()}`
	const now = new Date().toISOString()
	const ownerIdSql = `(SELECT personal_org_id FROM users WHERE email = ${quoteSqlString(owner.email)})`

	executeE2eD1Command(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, hidden, is_private, created_at, updated_at
		) VALUES (
			${quoteSqlString(packageId)},
			${ownerIdSql},
			${quoteSqlString(packageName)},
			${quoteSqlString(kodyId)},
			${quoteSqlString(privateDescription)},
			'[]',
			NULL,
			${quoteSqlString(sourceId)},
			1,
			0,
			1,
			${quoteSqlString(now)},
			${quoteSqlString(now)}
		)`,
	)

	const packagePath = `/@${owner.username}/${kodyId}`
	const anonymous = await page.goto(packagePath)
	expect(anonymous?.status()).toBe(404)
	await waitForClientHydration(page)
	await expect(page).toHaveTitle('Not found')
	await expect(page.getByTestId('not-found-page')).toBeVisible()
	await expect(page.getByTestId('package-no-access-page')).toHaveCount(0)
	await expect(page.locator('body')).not.toContainText(packageName, {
		useInnerText: true,
	})
	// The router serializes the requested URL even on a 404. That is already
	// known to the caller, but database-only metadata must never reach HTML,
	// including hydration data and metadata tags.
	const anonymousHtml = await anonymous!.text()
	for (const privateValue of [privateDescription, packageId, sourceId]) {
		expect(anonymousHtml).not.toContain(privateValue)
	}
	const metadata = await page
		.locator('meta')
		.evaluateAll((elements) =>
			elements
				.map((element) => element.getAttribute('content') ?? '')
				.join('\n'),
		)
	expect(metadata).not.toContain(packageName)

	await login({
		email: stranger.email,
		password: stranger.password,
		mode: 'login',
	})

	const response = await page.goto(packagePath)
	expect(response?.status()).toBe(403)
	await waitForClientHydration(page)

	const noAccess = page.getByTestId('package-no-access-page')
	await expect(noAccess).toBeVisible()
	await expect(
		page.getByRole('heading', { name: "You don't have access" }),
	).toBeVisible()
	await expect(noAccess).toContainText(packageName)
	await expect(noAccess).toContainText(`@${stranger.username}`)
	await expect(
		page.getByRole('link', { name: 'How sharing works' }),
	).toHaveAttribute('href', '/docs/package-sharing')
	await expect(page.getByTestId('not-found-page')).toHaveCount(0)
	await expect(
		page.getByRole('heading', { name: "This doesn't quite connect." }),
	).toHaveCount(0)

	// App-origin handoff mount for the same private package must not mint a
	// token for the outsider; it sends them to the package page instead.
	const handoff = await page.request.get(
		`/@${owner.username}/packages/${kodyId}`,
		{ maxRedirects: 0 },
	)
	expect(handoff.status()).toBe(302)
	expect(handoff.headers()['location']).toBe(`/@${owner.username}/${kodyId}`)

	// Leaving the denial must remove its content, and client history must
	// recheck access when the owner grants it, not reuse a cached denial.
	await page.getByRole('link', { name: 'How sharing works' }).click()
	await expect(page).toHaveURL(/\/docs\/package-sharing$/)
	await expect(noAccess).toHaveCount(0)
	const grantId = `handoff-access-${runId}`
	executeE2eD1Command(`
		INSERT INTO grants (id, org_id, resource_type, resource_id, subject_type,
			subject_id, preset, created_by_user_id, created_at, updated_at)
		SELECT ${quoteSqlString(grantId)}, owner.personal_org_id, 'package',
			${quoteSqlString(packageId)}, 'user', stranger.stable_user_id, 'use',
			owner.stable_user_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
		FROM users owner JOIN users stranger ON stranger.email = ${quoteSqlString(stranger.email)}
		WHERE owner.email = ${quoteSqlString(owner.email)};
		INSERT INTO grant_permissions (grant_id, permission) VALUES
			(${quoteSqlString(grantId)}, 'package:read'),
			(${quoteSqlString(grantId)}, 'package:execute');
		UPDATE orgs SET access_epoch = access_epoch + 1 WHERE id = ${ownerIdSql};
	`)
	await page.goBack()
	await expect(page).toHaveURL(new RegExp(`${packagePath}$`))
	await expect(
		page.getByRole('link', { name: 'Files', exact: true }),
	).toBeVisible()
	await expect(noAccess).toHaveCount(0)
	await expect(page.getByTestId('not-found-page')).toHaveCount(0)
})
