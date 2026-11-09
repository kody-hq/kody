import { randomUUID } from 'node:crypto'
import { test, expect, waitForClientHydration } from './playwright-utils.ts'

test('a shared file stays viewable without an account and can be copied into a different personal workspace', async ({
	page,
	browser,
	baseURL,
	seedE2eUser,
	login,
	request,
}, testInfo) => {
	test.setTimeout(120_000)
	const id = randomUUID().slice(0, 8)
	const owner = await seedE2eUser({
		username: `share-owner-${id}`,
		email: `share-owner-${id}@example.com`,
	})
	const viewer = await seedE2eUser({
		username: `share-viewer-${id}`,
		email: `share-viewer-${id}@example.com`,
	})
	await login({ ...owner, mode: 'login' })
	await page.goto(`/@${owner.username}/-/files`)
	await waitForClientHydration(page)
	await page.getByRole('button', { name: 'Create', exact: true }).last().click()
	const chooser = page.waitForEvent('filechooser')
	await page
		.getByRole('menuitem', { name: 'Upload files', exact: true })
		.click()
	await (
		await chooser
	).setFiles({
		name: 'Launch brief.md',
		mimeType: 'text/markdown',
		buffer: Buffer.from(
			'# Launch brief\n\nStart with three design partners.\n\n## Rollout\n\n- Confirm the first teams\n- Review the invite\n- Run through the shared workspace\n',
		),
	})
	await page
		.getByRole('region', { name: 'Uploads' })
		.getByRole('link', { name: 'Open', exact: true })
		.click()
	await expect(
		page.getByRole('button', { name: 'More actions', exact: true }),
	).toBeVisible()
	const fileUrl = page.url()
	async function sharePanel() {
		await page
			.getByRole('button', { name: 'More actions', exact: true })
			.click()
		await page
			.getByRole('button', { name: 'Details & permissions', exact: true })
			.click()
		return page.getByRole('dialog', { name: /Details and permissions/ })
	}
	let panel = await sharePanel()
	await panel.getByRole('button', { name: 'Create signed URL' }).click()
	const signedUrl = panel.getByLabel('Signed asset URL', { exact: true })
	await expect(signedUrl).toHaveValue(/signature=/)
	const signed = await signedUrl.inputValue()
	const signedResponse = await request.get(signed)
	expect(signedResponse.status()).toBe(200)
	expect(signedResponse.headers()['cache-control']).toBe('private, no-store')
	expect(await signedResponse.text()).toContain(
		'Start with three design partners.',
	)
	const tampered = new URL(signed)
	tampered.searchParams.set('signature', 'invalid')
	expect((await request.get(tampered.href)).status()).toBe(404)
	await expect(panel.getByLabel('Public cache lifetime')).toBeEnabled()
	await panel
		.getByLabel('Public cache lifetime')
		.selectOption('public, max-age=60')
	await panel.getByLabel('Content disposition').selectOption('attachment')
	await panel.getByRole('button', { name: 'Save asset settings' }).click()
	await panel
		.getByRole('button', { name: 'Create public link', exact: true })
		.click()
	const urlInput = panel.getByLabel('Public link URL', { exact: true })
	await expect(urlInput).toHaveValue(/\/shared-files\//)
	const shared = await urlInput.inputValue()
	await page.reload()
	await waitForClientHydration(page)
	panel = await sharePanel()
	await expect(panel.getByLabel('Public link URL')).toHaveValue(shared)
	await expect(panel.getByLabel('Public cache lifetime')).toHaveValue(
		'public, max-age=60',
	)
	const assetUrl = panel.getByLabel('Public asset URL', { exact: true })
	await expect(assetUrl).toHaveValue(/\/shared-file-assets\//)
	const asset = await assetUrl.inputValue()
	const assetResponse = await request.get(asset, {
		headers: { Origin: 'https://example.com' },
	})
	expect(assetResponse.status()).toBe(200)
	expect(assetResponse.headers()['cache-control']).toBe('public, max-age=60')
	expect(assetResponse.headers()['content-disposition']).toMatch(/^attachment;/)
	expect(assetResponse.headers()['access-control-allow-origin']).toBe('*')
	expect(await assetResponse.text()).toContain(
		'Start with three design partners.',
	)
	const visitor = await browser.newContext({
		baseURL,
		viewport: { width: 1280, height: 780 },
	})
	try {
		const sharedPage = await visitor.newPage()
		await sharedPage.goto(shared)
		await expect(
			sharedPage.getByRole('navigation', { name: 'Shared file path' }),
		).toBeVisible()
		await expect(
			sharedPage.getByRole('link', { name: 'Pricing', exact: true }),
		).toHaveCount(0)
		await expect(
			sharedPage.getByRole('heading', { name: 'Launch brief', exact: true }),
		).toBeVisible()
		await expect(
			sharedPage.getByRole('link', { name: 'Download', exact: true }),
		).toBeVisible()
		await sharedPage.screenshot({
			path: testInfo.outputPath('visitor-preview.jpg'),
		})
		await sharedPage
			.getByRole('button', { name: 'Use in Kody', exact: true })
			.click()
		const signIn = sharedPage.getByRole('link', {
			name: 'Sign in to save a copy',
		})
		await expect(signIn).toBeVisible()
		const returnTo = new URL(
			(await signIn.getAttribute('href')) ?? '',
			baseURL,
		).searchParams.get('redirectTo')!
		await sharedPage.screenshot({
			path: testInfo.outputPath('visitor-use-in-kody.jpg'),
		})
		const response = await visitor.request.post('/auth', {
			data: { ...viewer, mode: 'login' },
		})
		expect(response.ok()).toBe(true)
		await sharedPage.goto(returnTo)
		await sharedPage
			.getByRole('button', { name: 'Save a copy in Kody', exact: true })
			.click()
		const copied = sharedPage.getByRole('link', { name: 'Open copy in Kody' })
		await expect(copied).toHaveAttribute(
			'href',
			new RegExp(`^/@${viewer.username}/-/files\\?file=`),
		)
		await copied.click()
		await expect(
			sharedPage.getByText('Start with three design partners.', {
				exact: true,
			}),
		).toBeVisible()
		expect(sharedPage.url()).not.toBe(fileUrl)
		await panel.getByRole('button', { name: 'Revoke', exact: true }).click()
		await expect(panel.getByText('Not public', { exact: true })).toBeVisible()
		expect((await request.get(asset)).status()).toBe(404)
		await sharedPage.goto(shared)
		await expect(
			sharedPage.getByRole('heading', { name: 'This link is unavailable' }),
		).toBeVisible()
	} finally {
		await visitor.close()
	}
})
