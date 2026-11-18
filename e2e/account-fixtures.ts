import { buildCredentialCreateHref } from '../packages/worker/universal/credential-contracts.ts'
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
	await page.goto(
		buildCredentialCreateHref({
			kind: 'secret',
			kindMode: 'required',
			name: input.name,
			description: input.description,
			allowedHosts: input.allowedHosts,
		}),
	)
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
