import { randomUUID } from 'node:crypto'
import { readE2eCloudflareMockState } from '../tools/e2e-cloudflare-mock-state.ts'
import { requestHasMutationDataFields } from './server-function-requests.ts'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'

test('password reset feedback supports a successful request and retries a rejected token', async ({
	page,
}) => {
	await page.goto('/reset-password')
	await waitForClientHydration(page)
	await page
		.getByLabel('Email', { exact: true })
		.fill(`reset-${randomUUID()}@example.com`)
	await page
		.getByRole('button', { name: 'Send reset link', exact: true })
		.click()
	await expect(page.locator('form [aria-live="polite"]')).toContainText(
		/reset link|reset email|inbox/i,
	)
	await expect(
		page.getByRole('button', { name: 'Send reset link', exact: true }),
	).toBeEnabled()
	await page.goto('/reset-password?token=invalid-e2e-token')
	await waitForClientHydration(page)
	await page
		.getByLabel('New password', { exact: true })
		.fill('a-new-reset-password')
	const submit = page.getByRole('button', {
		name: 'Update password',
		exact: true,
	})
	await submit.click()
	await expect(page.locator('form [aria-live="polite"]')).toContainText(
		/invalid|expired/i,
	)
	await expect(submit).toBeEnabled()
	await submit.click()
	await expect(page.locator('form [aria-live="polite"]')).toContainText(
		/invalid|expired/i,
	)
	await expect(submit).toBeEnabled()
})

test('password change retries a rejected password and persists a successful update', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const user = await seedE2eUser()
	await login({ ...user, mode: 'login' })
	await page.goto('/account/security')
	await waitForClientHydration(page)
	await page.getByText('Change password', { exact: true }).click()
	const form = page.getByTestId('account-password-form')
	await form
		.getByLabel('Current password', { exact: true })
		.fill('wrong-password')
	await form
		.getByLabel('New password', { exact: true })
		.fill('changed-password-e2e')
	await form
		.getByLabel('Confirm new password', { exact: true })
		.fill('changed-password-e2e')
	await form
		.getByRole('button', { name: 'Update password', exact: true })
		.click()
	await expect(form).toContainText(/incorrect|invalid|wrong/i)
	await form.getByLabel('Current password', { exact: true }).fill(user.password)
	await form
		.getByRole('button', { name: 'Update password', exact: true })
		.click()
	await expect(
		page.getByText('Password updated.', { exact: true }).first(),
	).toBeVisible()
	const signedIn = await page.request.post('/auth', {
		data: {
			email: user.email,
			password: 'changed-password-e2e',
			mode: 'login',
		},
	})
	expect(signedIn.ok(), await signedIn.text()).toBe(true)
})

test('avatar decoding recovers from an invalid image, crops, saves and survives reload', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const user = await seedE2eUser()
	await login({ ...user, mode: 'login' })
	await page.goto('/account')
	await waitForClientHydration(page)
	const upload = page.getByTestId('account-avatar-file')
	await upload.setInputFiles({
		name: 'broken.png',
		mimeType: 'image/png',
		buffer: Buffer.from('not an image'),
	})
	const editor = page.getByRole('dialog', { name: 'Crop your avatar' })
	await expect(editor.getByRole('alert')).toBeVisible()
	await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
	const data = await page.evaluate(() => {
		const canvas = document.createElement('canvas')
		canvas.width = 256
		canvas.height = 256
		const context = canvas.getContext('2d')!
		context.fillStyle = '#4488cc'
		context.fillRect(0, 0, 256, 256)
		return canvas.toDataURL('image/png').split(',')[1]!
	})
	await upload.setInputFiles({
		name: 'avatar.png',
		mimeType: 'image/png',
		buffer: Buffer.from(data, 'base64'),
	})
	await expect(page.getByTestId('account-avatar-editor-stage')).toBeVisible()
	await editor.getByRole('button', { name: 'Zoom in', exact: true }).click()
	await editor.getByRole('button', { name: 'Use photo', exact: true }).click()
	await expect(editor).not.toBeVisible()
	await expect(
		page.getByRole('button', { name: 'Remove avatar', exact: true }),
	).toBeEnabled()
	await page.reload()
	await waitForClientHydration(page)
	await expect(
		page.getByRole('button', { name: 'Remove avatar', exact: true }),
	).toBeVisible()
})

test('an admin can complete and repeat an empty dry-run', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(90_000)
	const user = await seedE2eUser({ admin: true })
	await login({ ...user, mode: 'login' })
	await page.goto('/admin/codemods')
	await waitForClientHydration(page)
	await page.getByLabel('User IDs filter', { exact: true }).fill(randomUUID())
	await page
		.getByRole('combobox', { name: 'Mode', exact: true })
		.selectOption('dry-run')
	const submit = page.getByRole('button', { name: 'Run', exact: true })
	let submissions = 0
	page.on('request', (request) => {
		if (requestHasMutationDataFields(request, { mode: 'dry-run' }))
			submissions++
	})
	await submit.evaluate((button: HTMLButtonElement) => {
		button.click()
		button.click()
	})
	await expect(page.getByText(/Finished dry-run for/)).toBeVisible({
		timeout: 30_000,
	})
	await expect(submit).toBeEnabled()
	expect(submissions).toBe(1)
	await submit.click()
	await expect.poll(() => submissions).toBe(2)
	await expect(submit).toBeEnabled({ timeout: 30_000 })
})

test('device OAuth renders its code, ticks the countdown and consumes approval', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(60_000)
	const user = await seedE2eUser()
	await login({ ...user, mode: 'login' })
	const mock = readE2eCloudflareMockState()
	const provider = `rehearsal-device-${randomUUID().slice(0, 8)}`
	const configuration = new URLSearchParams({
		provider,
		deviceAuthorizationUrl: `${mock.origin}/__mocks/rehearsal/oauth/device/authorize`,
		tokenUrl: `${mock.origin}/__mocks/rehearsal/oauth/token`,
		flow: 'device',
		allowedHosts: new URL(mock.origin).hostname,
	})
	await page.goto(`/connect/oauth?${configuration}`)
	await waitForClientHydration(page)
	await page.locator('input[name="oauthClientId"]').fill('rehearsal-client')
	await page.getByRole('button', { name: 'Save and continue' }).click()
	await page
		.getByRole('button', { name: 'Start device authorization', exact: true })
		.click()
	const step = page.getByTestId('connect-oauth-device-step')
	await expect(page.getByTestId('connect-oauth-user-code')).not.toBeEmpty()
	await expect(step).toContainText('Waiting for approval')
	const initialCountdown = await step.locator('p').last().textContent()
	await expect(step.locator('p').last()).not.toHaveText(initialCountdown!)
	await expect(
		page.getByText("You're connected.", { exact: true }),
	).toBeVisible({ timeout: 30_000 })
})
