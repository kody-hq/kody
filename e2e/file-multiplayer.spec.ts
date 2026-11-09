import { randomUUID } from 'node:crypto'
import { type Locator, type WebSocketRoute } from '@playwright/test'
import { test, expect, waitForClientHydration } from './playwright-utils.ts'

test('collaborators jump to a live caret and merge edits after a disconnect', async ({
	page,
	browser,
	baseURL,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(120_000)
	const id = randomUUID().slice(0, 8)
	const owner = await seedE2eUser({
		username: `multiplayer-owner-${id}`,
		email: `multiplayer-owner-${id}@example.com`,
	})
	const guest = await seedE2eUser({
		username: `multiplayer-guest-${id}`,
		email: `multiplayer-guest-${id}@example.com`,
	})
	await login({ ...owner, mode: 'login' })
	await page.goto(`/@${owner.username}/-/files?new=true&page=true`)
	await waitForClientHydration(page)
	await page.getByRole('textbox', { name: 'Page title' }).fill('Multiplayer')
	const ownerEditor = page.getByLabel('Page content', { exact: true })
	await ownerEditor.pressSequentially('Shared paragraph')
	await expect(page).toHaveURL(/\?file=/)
	await expect(
		page
			.getByRole('status', { name: '', exact: true })
			.filter({ hasText: /^Saved$/ }),
	).toBeVisible()

	await ownerEditor.press('Home')
	await page.keyboard.insertText('Earlier notes. '.repeat(400))
	await ownerEditor.press('Enter')
	await expect(
		ownerEditor.getByText('Shared paragraph', { exact: true }),
	).toBeVisible()
	await page.getByRole('button', { name: 'More actions', exact: true }).click()
	await page
		.getByRole('button', { name: 'Details & permissions', exact: true })
		.click()
	const panel = page.getByRole('dialog')
	await panel.getByLabel('Collaborator email').fill(guest.email)
	await panel.getByLabel('New collaborator access').selectOption('contribute')
	await panel.getByRole('button', { name: 'Create invite' }).click()
	const invite = await panel.getByLabel('Invitation link').inputValue()
	await panel.getByRole('button', { name: 'Done', exact: true }).click()

	const context = await browser.newContext({ baseURL, reducedMotion: 'reduce' })
	try {
		const response = await context.request.post('/auth', {
			data: { ...guest, mode: 'login' },
		})
		expect(response.ok()).toBe(true)
		const collaborator = await context.newPage()
		let connected = true
		let connection: WebSocketRoute | undefined
		let serverConnection: WebSocketRoute | undefined
		await collaborator.routeWebSocket('**/file-session/**', (socket) => {
			if (!connected) {
				void socket.close({ code: 4001 })
				return
			}
			connection = socket
			serverConnection = socket.connectToServer()
		})
		await collaborator.goto(invite)
		await waitForClientHydration(collaborator)
		await collaborator
			.getByRole('button', { name: 'Accept invitation' })
			.click()
		const guestEditor = collaborator.getByLabel('Page content', { exact: true })
		await expect(guestEditor).toContainText('Shared paragraph')
		await guestEditor.getByText('Shared paragraph', { exact: true }).click()
		await guestEditor.press('End')
		await guestEditor.pressSequentially(' together')
		await expect(ownerEditor).toContainText('Shared paragraph together')

		const jump = page.getByRole('button', {
			name: /^Jump to multiplayer-guest-/,
		})
		await expect(jump).toBeVisible()
		const caret = ownerEditor.locator('[data-presence-session]')
		await expect(caret).toHaveCount(1)
		await ownerEditor.evaluate((editor) =>
			editor.scrollIntoView({ block: 'start', behavior: 'instant' }),
		)
		await expect(caret).not.toBeInViewport()
		await jump.click()
		await expect(caret).toBeInViewport()
		await expect(jump).toBeFocused()
		await expect(
			page.getByText('People & agents', { exact: true }),
		).toHaveCount(0)

		connected = false
		await serverConnection!.close({ code: 4001 })
		await connection!.close({ code: 4001 })
		await expect(
			collaborator.getByText('Saved on this device', { exact: true }),
		).toBeVisible()
		await expect(caret).toHaveCount(0)
		await guestEditor.press('End')
		await guestEditor.pressSequentially(' with offline edits')
		await ownerEditor
			.getByText('Shared paragraph together', { exact: true })
			.click()
		await ownerEditor
			.locator('.block-text')
			.last()
			.evaluate((paragraph) => {
				window.getSelection()?.collapse(paragraph, 0)
			})
		await page.keyboard.insertText('Live: ')
		await expect(ownerEditor).toContainText('Live: Shared paragraph together')
		await expect(ownerEditor).not.toContainText('with offline edits')
		connected = true

		const merged = 'Live: Shared paragraph together with offline edits'
		const paragraphText = (editor: Locator) =>
			editor
				.locator('.block-text')
				.last()
				.evaluate((paragraph) => {
					const content = paragraph.cloneNode(true) as HTMLElement
					for (const marker of content.querySelectorAll(
						'[data-presence-session]',
					))
						marker.remove()
					return content.textContent
				})
		await expect
			.poll(() => paragraphText(ownerEditor), { timeout: 20_000 })
			.toBe(merged)
		await expect
			.poll(() => paragraphText(guestEditor), { timeout: 20_000 })
			.toBe(merged)
		await collaborator.reload()
		await expect.poll(() => paragraphText(guestEditor)).toBe(merged)
	} finally {
		await context.close()
	}
})

test('collaborative Markdown opens as a padded preview without a duplicate title', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const username = `markdown-preview-${randomUUID().slice(0, 8)}`
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
	).setFiles({
		name: 'Review.md',
		mimeType: 'text/markdown',
		buffer: Buffer.from('# Review notes\n\nReady to share.'),
	})
	await page
		.getByRole('region', { name: 'Uploads' })
		.getByRole('link', { name: 'Open', exact: true })
		.click()

	const document = page.getByRole('region', { name: 'Document', exact: true })
	const preview = document
		.locator('article')
		.filter({ hasText: 'Ready to share.' })
	await expect(preview).toBeVisible()
	await expect(preview).toHaveCSS('padding-left', '32px')
	await expect(
		document.getByRole('heading', { name: 'Review.md', exact: true }),
	).toHaveCount(0)
	await document.getByRole('button', { name: 'Edit', exact: true }).click()
	const source = document.getByLabel('Document text', { exact: true })
	await expect(source).toHaveValue(/Ready to share\./)
	await expect(source).toHaveCSS('padding-left', '16px')
})
