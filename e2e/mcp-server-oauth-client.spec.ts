import { addMcpServerThroughUi } from './account-fixtures.ts'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'

test('an admin types, saves, replaces, and removes an MCP server OAuth client', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `mcp-oauth-client-${runId}@example.com`,
		username: `mcp-oauth-client-${runId}`,
		password: 'mcp-oauth-client-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })

	const serverName = `oauth-client-${runId}`
	const serverId = await addMcpServerThroughUi(page, user.username, serverName)

	await page.goto(`/@${user.username}/-/mcp-servers/${serverId}`)
	await waitForClientHydration(page)
	const section = page.getByRole('region', { name: 'OAuth client (optional)' })
	await expect(section).toBeVisible()

	const clientSecret = `e2e-secret-${runId}`
	const clientIdInput = section.getByLabel('Client ID')
	const clientSecretInput = section.getByLabel('Client secret', { exact: true })
	await clientIdInput.pressSequentially('e2e-client-id')
	await clientSecretInput.pressSequentially(clientSecret)

	await section.getByRole('button', { name: 'Save OAuth client' }).click()
	const configured = section.getByTestId('mcp-server-oauth-client-configured')
	await expect(configured).toContainText('Configured.')
	await expect(configured).toContainText('e2e-client-id')
	await expect(section.getByTestId('mcp-server-oauth-client-form')).toHaveCount(
		0,
	)
	expect(await page.content()).not.toContain(clientSecret)

	await section.getByRole('button', { name: 'Replace' }).click()
	await expect(clientIdInput).toHaveValue('e2e-client-id')
	await expect(clientSecretInput).toHaveValue('')
	await clientIdInput.fill('')
	await clientIdInput.pressSequentially('e2e-client-id-2')
	await clientSecretInput.pressSequentially(`${clientSecret}-2`)
	await section.getByRole('button', { name: 'Replace OAuth client' }).click()
	await expect(configured).toContainText('e2e-client-id-2')
	expect(await page.content()).not.toContain(clientSecret)

	await section.getByRole('button', { name: 'Remove' }).click()
	await section
		.getByRole('button', { name: 'Confirm remove OAuth client' })
		.click()
	await expect(configured).toHaveCount(0)
	await expect(
		section.getByRole('button', { name: 'Save OAuth client' }),
	).toBeVisible()
})
