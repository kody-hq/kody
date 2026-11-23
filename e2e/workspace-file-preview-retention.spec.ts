import { randomUUID } from 'node:crypto'
import { test, expect, waitForClientHydration } from './playwright-utils.ts'

test('switching workspace files keeps the previous file readable while the next one loads', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 60_000)
	const username = `preview-keep-${randomUUID().slice(0, 8)}`
	const owner = await seedE2eUser({
		username,
		email: `${username}@example.com`,
	})
	await login({ ...owner, mode: 'login' })
	await page.goto(`/@${username}/-/files`)
	await waitForClientHydration(page)
	await page.getByRole('button', { name: 'Create', exact: true }).last().click()
	const chooser = page.waitForEvent('filechooser')
	await page.getByRole('menuitem', { name: 'Upload files' }).click()
	await (
		await chooser
	).setFiles([
		{
			name: 'First.md',
			mimeType: 'text/markdown',
			buffer: Buffer.from('# First notes\n\nKept on screen.'),
		},
		{
			name: 'Second.md',
			mimeType: 'text/markdown',
			buffer: Buffer.from('# Second notes\n\nArrives later.'),
		},
	])
	await expect(
		page
			.getByRole('region', { name: 'Uploads' })
			.getByRole('link', { name: 'Open', exact: true }),
	).toHaveCount(2)
	await page.goto(`/@${username}/-/files`)
	await waitForClientHydration(page)
	await page
		.getByRole('group', { name: 'View mode' })
		.getByRole('button', { name: 'Columns', exact: true })
		.click()
	const columns = page.getByLabel('Browse workspace columns')
	await columns.getByRole('link', { name: 'First.md', exact: true }).click()
	await expect(page.getByText('Kept on screen.')).toBeVisible()
	const firstId = new URL(page.url()).searchParams.get('active')

	let release = () => {}
	const held = new Promise<void>((resolve) => (release = resolve))
	await page.route('**/_serverFn/**', async (route) => {
		await held
		await route.continue()
	})
	await columns.getByRole('link', { name: 'Second.md', exact: true }).click()
	const stale = page.locator('[data-stale-preview]')
	await expect(stale).toHaveAttribute('aria-busy', 'true')
	await expect(stale.locator('> [inert]')).toHaveCount(1)
	await stale.click({ button: 'right' })
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
	await page.getByRole('menuitem', { name: 'Copy link' }).click()
	expect(
		new URL(
			await page.evaluate(() => navigator.clipboard.readText()),
		).searchParams.get('file'),
	).toBe(firstId)
	await expect(stale.getByText('Kept on screen.')).toBeVisible()
	await expect(
		page.getByRole('status', { name: 'Loading file', exact: true }),
	).toHaveCount(0)
	release()
	await expect(page.getByText('Arrives later.')).toBeVisible()
	await expect(stale).toHaveCount(0)
	await expect(page.getByText('Kept on screen.')).toHaveCount(0)
	await page.unroute('**/_serverFn/**')
})
