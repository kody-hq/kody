import {
	expect,
	waitForClientHydration,
	type Page,
} from './playwright-utils.ts'

export async function saveKeyThroughUi(
	page: Page,
	input: {
		name: string
		value: string
		description?: string
		allowedHosts?: string[]
	},
) {
	const search = new URLSearchParams({
		kind: 'key',
		kindMode: 'required',
		name: input.name,
	})
	if (input.description) search.set('description', input.description)
	if (input.allowedHosts?.length)
		search.set('allowedHosts', input.allowedHosts.join(','))
	await page.goto(`/connect/credential?${search}`)
	await waitForClientHydration(page)
	await page
		.getByRole('textbox', { name: 'Value', exact: true })
		.fill(input.value)
	await page.getByTestId('connect-credential-save').click()
	await expect(page.getByTestId('connect-credential-saved')).toContainText(
		`${input.name} is saved`,
	)
}
export async function addMcpServerThroughUi(
	page: Page,
	orgSlug: string,
	name: string,
) {
	await page.goto(`/@${orgSlug}/-/mcp-servers/new`)
	await waitForClientHydration(page)
	await page.locator('input[name="name"]').fill(name)
	await page.getByLabel('Server URL').fill('http://127.0.0.1:9/mcp')
	await page
		.locator('button[type="submit"]')
		.filter({ hasText: /^Add server$/ })
		.click()
	await expect(page).toHaveURL(/\/mcp-servers\/(?!new(?:\?|$))[^/?]+/)
	return new URL(page.url()).pathname.split('/').at(-1)!
}
export async function readEmailThroughUi(page: Page) {
	await page.goto('/account/email')
	await waitForClientHydration(page)
	const inboxAddress = await page
		.getByText('Inbox address:', { exact: false })
		.locator('code')
		.textContent()
	const messages = await page
		.locator('table tbody a[href*="/email/"]')
		.evaluateAll((links) =>
			links.map((link) => {
				const href = new URL((link as HTMLAnchorElement).href)
				const row = link.closest('tr') ?? link
				return {
					id: decodeURIComponent(href.pathname.split('/').at(-1)!),
					subject:
						link.querySelector('span span')?.textContent?.trim() ??
						link.textContent?.trim() ??
						'',
					classification: row.textContent?.includes('Quarantined')
						? 'quarantined'
						: 'accepted',
				}
			}),
		)
	return { emailVerified: true, inboxAddress, messages }
}
export async function classifyEmailThroughUi(page: Page, id: string) {
	await page.goto(`/account/email/${encodeURIComponent(id)}`)
	await waitForClientHydration(page)
	const accept = page.getByRole('button', { name: 'Not spam', exact: true })
	if (await accept.count()) {
		await accept.click()
		await expect(
			page.getByRole('button', { name: 'Mark as spam', exact: true }),
		).toBeVisible()
	}
}
export async function deleteEmailThroughUi(page: Page, id: string) {
	await page.goto(`/account/email/${encodeURIComponent(id)}`)
	await waitForClientHydration(page)
	await page.getByRole('button', { name: /^Delete message "/ }).click()
	await page.getByRole('button', { name: /^Confirm delete message "/ }).click()
	await expect(page).not.toHaveURL(new RegExp(`/email/${id}(?:\\?|$)`))
}
