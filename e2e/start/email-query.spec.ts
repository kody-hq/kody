import { requestHasMutationDataFields } from '../server-function-requests.ts'
import { randomUUID } from 'node:crypto'
import {
	classifyEmailThroughUi,
	deleteEmailThroughUi,
	readEmailThroughUi,
} from '../account-fixtures.ts'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

for (const outcome of [
	'accepted',
	'rejected',
	'rejected-while-mounted',
] as const) {
	test(`email classification survives navigation and ${outcome} writes`, async ({
		page,
		baseURL,
		seedE2eUser,
		login,
	}) => {
		const origin = new URL(baseURL!)
		expect(['localhost', '127.0.0.1']).toContain(origin.hostname)
		const id = randomUUID().slice(0, 8)
		const user = await seedE2eUser({
			email: `email-query-${id}@example.com`,
			username: `email-query-${id}`,
		})
		await login({ ...user, mode: 'login' })
		const read = () => readEmailThroughUi(page)
		const initial = await read()
		expect(initial.emailVerified).toBe(true)
		const recipient = initial.inboxAddress!
		expect(recipient).toMatch(
			/@(inbox\.)?(localhost|127\.0\.0\.1|[^@]+\.test)$/,
		)
		const subject = `Local query fixture ${id}`
		const endpoint = new URL('/cdn-cgi/local/email', origin)
		endpoint.searchParams.set('from', 'sender@example.com')
		endpoint.searchParams.set('to', recipient)
		// Cloudflare's supported local event injection, never an outbound email API.
		const messageIds: string[] = []
		for (const [index, fixtureSubject] of [
			subject,
			`Pagination fixture ${id}`,
		].entries()) {
			const injected = await page.request.post(endpoint.href, {
				data: [
					'From: sender@example.com',
					`To: ${recipient}`,
					`Subject: ${fixtureSubject}`,
					`Message-ID: <${id}-${index}@example.com>`,
					`Date: ${new Date().toUTCString()}`,
					'Content-Type: text/plain; charset=utf-8',
					'',
					'Disposable local email query fixture.',
				].join('\r\n'),
				headers: { 'Content-Type': 'message/rfc822' },
			})
			expect(injected.status()).toBe(200)
			let seededId = ''
			await expect
				.poll(async () => {
					seededId =
						(await read()).messages.find(
							(message) => message.subject === fixtureSubject,
						)?.id ?? ''
					return seededId
				})
				.not.toBe('')
			messageIds.push(seededId)
			await classifyEmailThroughUi(page, seededId)
		}
		const messageId = messageIds[0]!
		let release = () => {}
		try {
			const ordered = (await read()).messages
			await page.goto('/account/email?pageSize=1')
			await waitForClientHydration(page)
			await expect(
				page.getByRole('link', { name: ordered[0]!.subject!, exact: false }),
			).toBeVisible()
			await expect(
				page.getByRole('link', { name: ordered[1]!.subject!, exact: false }),
			).toHaveCount(0)
			await page.getByRole('button', { name: 'Next', exact: true }).click()
			await expect(page.getByText('Page 2 of 2', { exact: true })).toBeVisible()
			await expect(
				page.getByRole('link', { name: ordered[1]!.subject!, exact: false }),
			).toBeVisible()
			await expect(
				page.getByRole('link', { name: ordered[0]!.subject!, exact: false }),
			).toHaveCount(0)
			await page.getByRole('button', { name: 'Previous', exact: true }).click()
			await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible()
			await expect(
				page.getByRole('link', { name: ordered[0]!.subject!, exact: false }),
			).toBeVisible()
			await page.goto('/account/email')
			await waitForClientHydration(page)
			await page
				.getByRole('combobox', { name: 'Filter messages by classification' })
				.selectOption('quarantined')
			await expect(
				page.getByText('No messages match the current filters.'),
			).toBeVisible()
			await page
				.getByRole('combobox', { name: 'Filter messages by classification' })
				.selectOption('all')
			await page.getByRole('link', { name: subject, exact: false }).click()
			await expect(
				page.getByRole('button', { name: 'Mark as spam', exact: true }),
			).toBeVisible()
			let captured!: () => void
			const held = new Promise<void>((resolve) => {
				captured = resolve
			})
			const barrier = new Promise<void>((resolve) => {
				release = resolve
			})
			await page.route('**/_serverFn/**', async (route) => {
				if (
					!requestHasMutationDataFields(route.request(), {
						messageId,
						classification: 'quarantined',
					})
				)
					return route.fallback()
				captured()
				await barrier
				if (outcome !== 'accepted')
					await route.fulfill({
						status: 500,
						contentType: 'text/plain',
						body: 'Controlled email rejection',
					})
				else await route.continue()
			})
			const response = page.waitForResponse((value) =>
				requestHasMutationDataFields(value.request(), {
					messageId,
					classification: 'quarantined',
				}),
			)
			await page
				.getByRole('button', { name: 'Mark as spam', exact: true })
				.click()
			await held
			await expect(
				page
					.locator('span')
					.filter({ hasText: /^Quarantined$/ })
					.first(),
			).toBeVisible()
			if (outcome !== 'rejected-while-mounted') {
				await page.getByTestId('account-menu').click()
				await page
					.getByTestId('account-menu-panel')
					.getByRole('link', { name: 'Account settings', exact: true })
					.click()
				await expect(
					page.getByLabel('Display name', { exact: true }),
				).toBeVisible()
				await page.evaluate(
					(href) => window.history.pushState(null, '', href),
					`/@${user.username}/-/email`,
				)
				await expect(
					page
						.locator('span')
						.filter({ hasText: /^Quarantined$/ })
						.first(),
				).toBeVisible()
				await page.getByTestId('account-menu').click()
				await page
					.getByTestId('account-menu-panel')
					.getByRole('link', { name: 'Account settings', exact: true })
					.click()
				await expect(
					page.getByLabel('Display name', { exact: true }),
				).toBeVisible()
			}
			release()
			await (await response).finished()
			if (outcome === 'rejected-while-mounted')
				await expect(
					page.getByText('Controlled email rejection', { exact: true }),
				).toBeVisible()
			else if (outcome === 'rejected')
				// An abandoned submitter must not notify an unrelated screen.
				await expect(
					page.getByText('Controlled email rejection', { exact: true }),
				).toHaveCount(0)
			await page.unrouteAll({ behavior: 'wait' })
			await page.evaluate(
				(href) => window.history.pushState(null, '', href),
				`/@${user.username}/-/email`,
			)
			await page
				.getByRole('combobox', { name: 'Filter messages by classification' })
				.selectOption('quarantined')
			if (outcome === 'accepted')
				await expect(
					page.getByRole('link', { name: subject, exact: false }),
				).toBeVisible()
			else
				await expect(
					page.getByText('No messages match the current filters.'),
				).toBeVisible()
			const stored = (await read()).messages.find(
				(message) => message.id === messageId,
			)
			expect(stored?.classification).toBe(
				outcome === 'accepted' ? 'quarantined' : 'accepted',
			)
		} finally {
			release()
			await page.unrouteAll({ behavior: 'wait' })
			for (const seededId of messageIds) {
				await deleteEmailThroughUi(page, seededId)
			}
		}
	})
}
