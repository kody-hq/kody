import { randomUUID } from 'node:crypto'
import { executeE2eD1Command } from '../d1-utils.ts'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

// These cases edit the same platform KV record, whose read/modify/write
// operation cannot be isolated by choosing distinct usernames.
test.describe('retained reserved username mutations', () => {
	test.describe.configure({ mode: 'serial' })
	for (const suffix of ['#pending-review', '?review=pending']) {
		test(`retained admin form releases pending state after navigating to ${suffix}`, async ({
			page,
			seedE2eUser,
			login,
		}) => {
			const id = randomUUID().slice(0, 8)
			const user = await seedE2eUser({
				email: `pending-${id}@example.com`,
				username: `pending-${id}`,
				admin: true,
			})
			await login({ ...user, mode: 'login' })
			await page.goto('/admin/reserved-usernames')
			await waitForClientHydration(page)
			const name = `reserved-${id}`
			const input = page.getByLabel('Usernames', { exact: true })
			await input.fill(name)
			// Keep the actual accepted write response in flight while the same route
			// remains mounted at another search/fragment location.
			let release!: () => void
			const barrier = new Promise<void>((resolve) => {
				release = resolve
			})
			let captured = false
			let responseHeld = false
			await page.route('**/_serverFn/**', async (route) => {
				if (
					captured ||
					route.request().method() !== 'POST' ||
					!route.request().postData()?.includes(name)
				)
					return route.fallback()
				captured = true
				const response = await route.fetch()
				responseHeld = true
				await barrier
				await route.fulfill({ response })
			})
			try {
				await page.getByRole('button', { name: 'Add', exact: true }).click()
				await expect.poll(() => responseHeld).toBe(true)
				await expect(input).toBeDisabled()
				await page.evaluate(
					(next) => window.history.pushState(null, '', next),
					`/admin/reserved-usernames${suffix}`,
				)
				await expect(page).toHaveURL(
					new RegExp(suffix.replace(/[?]/g, '\\?') + '$'),
				)
				release()
				await expect(input).toBeEnabled()
				await expect(
					page.getByRole('button', { name: 'Add', exact: true }),
				).toBeEnabled()
				// The departed submission must not clear the retained draft or announce
				// success at the new location, even though its pending state is finished.
				await expect(input).toHaveValue(name)
				await expect(
					page.getByText('Reserved usernames updated.', { exact: true }),
				).toHaveCount(0)
				const row = page.getByText(name, { exact: true }).locator('..')
				await row.getByRole('button', { name: 'Remove', exact: true }).click()
				await expect(
					page.getByText('Reserved username removed.', { exact: true }),
				).toBeVisible()
			} finally {
				release()
			}
		})
	}
})

for (const suffix of ['#pending-review', '?review=pending']) {
	test(`account verification resend finishes after retained navigation to ${suffix}`, async ({
		page,
		seedE2eUser,
		login,
	}) => {
		const id = randomUUID().slice(0, 8)
		const user = await seedE2eUser({
			email: `resend-${id}@example.com`,
			username: `resend-${id}`,
		})
		executeE2eD1Command(
			`UPDATE users SET email_verified_at = NULL WHERE username = 'resend-${id}'`,
		)
		await login({ ...user, mode: 'login' })
		await page.goto('/account')
		await waitForClientHydration(page)
		let release!: () => void
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		let held = false
		await page.route('**/_serverFn/**', async (route) => {
			if (route.request().method() !== 'POST' || held) return route.fallback()
			const response = await route.fetch()
			held = true
			await barrier
			await route.fulfill({ response })
		})
		try {
			await page
				.getByRole('button', { name: 'Resend verification email', exact: true })
				.click()
			await expect.poll(() => held).toBe(true)
			await page.evaluate(
				(next) => window.history.pushState(null, '', next),
				`/account${suffix}`,
			)
			await expect(
				page.getByRole('button', { name: 'Sending...', exact: true }),
			).toBeDisabled()
			release()
			await expect(
				page.getByRole('button', {
					name: 'Resend verification email',
					exact: true,
				}),
			).toBeEnabled()
		} finally {
			release()
		}
	})
}

test('avatar removal remains pending across an away-and-back retained navigation', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `avatar-${id}@example.com`,
		username: `avatar-${id}`,
	})
	executeE2eD1Command(
		`UPDATE users SET avatar_key = 'user-avatars/' || stable_user_id || '/e2e-avatar-${id}.png' WHERE username = 'avatar-${id}'`,
	)
	await login({ ...user, mode: 'login' })
	await page.goto('/account')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('button', { name: 'Remove avatar', exact: true }),
	).toBeVisible()
	let release!: () => void
	const barrier = new Promise<void>((resolve) => {
		release = resolve
	})
	let held = false
	await page.route('**/_serverFn/**', async (route) => {
		if (route.request().method() !== 'POST' || held) return route.fallback()
		const response = await route.fetch()
		held = true
		await barrier
		await route.fulfill({ response })
	})
	try {
		await page
			.getByRole('button', { name: 'Remove avatar', exact: true })
			.click()
		await expect.poll(() => held).toBe(true)
		await page.evaluate(() =>
			window.history.pushState(null, '', '/account?review=pending'),
		)
		await expect(page.getByTestId('account-avatar-file')).toBeDisabled()
		await page.evaluate(() => window.history.pushState(null, '', '/account'))
		await expect(page.getByTestId('account-avatar-file')).toBeDisabled()
		release()
		await expect(page.getByTestId('account-avatar-file')).toBeEnabled()
		await expect(
			page.getByText('Avatar removed.', { exact: true }),
		).toHaveCount(0)
		// A fresh read confirms the held request performed the real deletion.
		await page.reload()
		await waitForClientHydration(page)
		await expect(page.getByTestId('account-avatar-file')).toBeEnabled()
		await expect(
			page.getByRole('button', { name: 'Remove avatar', exact: true }),
		).toHaveCount(0)
	} finally {
		release()
	}
})
