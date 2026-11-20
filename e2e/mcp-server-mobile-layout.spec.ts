import { addMcpServerThroughUi } from './account-fixtures.ts'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'

test.use({ viewport: { width: 375, height: 812 } })

test('MCP server detail fits a 375px phone with every control reachable', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `mcp-mobile-${runId}@example.com`,
		username: `mcp-mobile-${runId}`,
		password: 'mcp-mobile-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })

	const serverName = `mobile-layout-${runId}`
	const serverId = await addMcpServerThroughUi(page, user.username, serverName)

	await page.goto(`/@${user.username}/-/mcp-servers/${serverId}`)
	await waitForClientHydration(page)
	const detail = page.getByRole('region', { name: `${serverName} details` })
	await expect(detail).toBeVisible()

	const viewportWidth = await page.evaluate(
		() => document.documentElement.clientWidth,
	)
	const controls = [
		page.getByTestId('save-mcp-server-usage'),
		detail.getByRole('button', { name: 'Save OAuth client' }),
		detail.getByLabel('Client ID'),
		detail.getByRole('button', { name: 'Reconnect' }),
		detail.getByRole('button', { name: 'Remove' }),
		detail.getByText('http://127.0.0.1:9/mcp'),
	]
	for (const control of controls) {
		const box = await control.boundingBox()
		expect(box, 'control renders').not.toBeNull()
		expect(box!.x).toBeGreaterThanOrEqual(0)
		expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth)
	}
	expect(
		await page.evaluate(
			() =>
				document.scrollingElement!.scrollWidth -
				document.documentElement.clientWidth,
		),
	).toBeLessThanOrEqual(0)
})
