import { requestHasDataFields } from './server-function-requests.ts'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'
import {
	clearAuthRateLimitsInE2eDatabase,
	deleteUserInE2eDatabase,
} from './d1-utils.ts'
import {
	extractVerifyEmailPath,
	findConnectAgentEmail,
	findVerificationEmail,
	listE2eCloudflareMockMessages,
	type MockEmailMessage,
} from './cloudflare-mock.ts'

const mcpInitializeBody = {
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2025-03-26',
		capabilities: {},
		clientInfo: { name: 'kody-e2e', version: '0.0.0' },
	},
}

async function postUnauthenticatedMcpInitialize(origin: string) {
	return fetch(new URL('/mcp', origin), {
		method: 'POST',
		headers: {
			Accept: 'application/json, text/event-stream',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(mcpInitializeBody),
	})
}

test('signup shows an inline username error instead of native constraint focus', async ({
	page,
}) => {
	test.setTimeout(process.env.CI ? 60_000 : 45_000)
	clearAuthRateLimitsInE2eDatabase()
	await page.context().clearCookies()

	await page.goto('/signup')
	await waitForClientHydration(page)

	const username = page.getByLabel('Username')
	await username.fill('Ján Kováč')
	await page.getByLabel('Email').fill('jan.kovac@example.com')
	await page.getByLabel('Password', { exact: true }).fill('password123')

	const createAccount = page.getByRole('button', {
		name: 'Create account',
		exact: true,
	})
	await createAccount.click()

	const alert = page.getByRole('alert')
	await expect(alert).toContainText('no accents')
	await expect(alert).toContainText('jan-kovac')
	await expect(username).toHaveAttribute('aria-invalid', 'true')
	// Submit ran (inline error) rather than native constraint validation
	// silently moving focus back to the username field with no feedback.
	await expect(createAccount).toBeEnabled()
	await expect(page).toHaveURL(/\/signup/)
})

test('a new user signs up, verifies email from the message, and reaches MCP connect', async ({
	page,
	baseURL,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const origin = new URL(baseURL ?? 'http://127.0.0.1:3847').origin
	const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
	const email = `e2e-signup-${runId}@example.com`
	const username = `e2e-su-${runId}`
	const password = 'e2e-signup-password'

	clearAuthRateLimitsInE2eDatabase()
	await page.context().clearCookies()

	try {
		await page.goto('/signup')
		await waitForClientHydration(page)
		await expect(
			page.getByRole('heading', { name: 'Create your account' }),
		).toBeVisible()

		await page.getByLabel('Username').fill(username)
		await page.getByLabel('Email').fill(email)
		await page.getByLabel('Password', { exact: true }).fill(password)
		// Handles are permanent: the first submit shows the final URL and asks once.
		await page
			.getByRole('button', { name: 'Create account', exact: true })
			.click()
		await expect(page.getByRole('status')).toContainText(
			`kody.codes/@${username}`,
		)
		await page.getByRole('button', { name: 'Yes, create account' }).click()

		await expect(page).toHaveURL(
			/\/pending-verification(?:\?accountCreated=1)?$/,
		)
		await expect(
			page.getByRole('heading', { name: 'Check your email' }),
		).toBeVisible()
		await expect(
			page.getByRole('img', {
				name: 'Kody holding a sealed envelope with a green wax K stamp',
			}),
		).toBeVisible()
		await expect(
			page.getByRole('region', { name: 'Email verification status' }),
		).toBeVisible()
		await expect(page.getByText(email, { exact: false })).toBeVisible()

		const sessionBefore = await page.request.get('/session')
		expect(sessionBefore.ok()).toBe(true)
		const sessionBeforeBody = (await sessionBefore.json()) as {
			ok?: boolean
			session?: { email?: string; emailVerified?: boolean }
		}
		expect(sessionBeforeBody.ok).toBe(true)
		expect(sessionBeforeBody.session?.email).toBe(email)
		expect(sessionBeforeBody.session?.emailVerified).toBe(false)

		await page.goto('/onboarding')
		await expect(page).toHaveURL(/\/pending-verification/)
		await expect(
			page.getByRole('heading', { name: 'Check your email' }),
		).toBeVisible()

		const mcpBeforeVerify = await postUnauthenticatedMcpInitialize(origin)
		expect(mcpBeforeVerify.status).toBe(401)
		expect(mcpBeforeVerify.headers.get('www-authenticate') ?? '').toMatch(
			/resource_metadata="[^"]*\/.well-known\/oauth-protected-resource\/mcp"/,
		)

		let verificationEmail = null as MockEmailMessage | null
		await expect
			.poll(
				async () => {
					const payload = await listE2eCloudflareMockMessages()
					verificationEmail = findVerificationEmail(payload.messages, email)
					return verificationEmail
				},
				{ timeout: 15_000 },
			)
			.not.toBeNull()
		const emailBody = `${verificationEmail?.text ?? ''}\n${verificationEmail?.html ?? ''}`
		const verifyPath = extractVerifyEmailPath(emailBody)
		if (!verifyPath) {
			throw new Error(
				'Verification email did not contain a /verify-email?token= link.',
			)
		}

		// Discover the compiled RPC from the browser navigation, never assume a
		// generated function ID or serialize Start's request format ourselves.
		const verificationUrl = new URL(verifyPath, origin)
		const token = verificationUrl.searchParams.get('token')!
		const redirectTo = verificationUrl.searchParams.get('redirectTo')
		let checkedHead = false
		await page.route('**/_serverFn/**', async (route) => {
			const request = route.request()
			if (!requestHasDataFields(request, { token, redirectTo }))
				return route.fallback()
			const head = await page.request.head(request.url(), {
				headers: await request.allHeaders(),
				maxRedirects: 0,
			})
			expect(head.status()).toBe(405)
			expect(head.headers().allow).toBe('GET')
			expect(await head.body()).toHaveLength(0)
			const stillUnverified = await page.request.get('/session')
			const state = (await stillUnverified.json()) as {
				session?: { emailVerified?: boolean }
			}
			expect(state.session?.emailVerified).toBe(false)
			checkedHead = true
			await route.continue()
		})
		await waitForClientHydration(page)
		await page.evaluate(
			(href) => window.history.pushState(null, '', href),
			verifyPath,
		)

		await expect(
			page.getByRole('heading', { name: 'Email verified' }),
		).toBeVisible()
		expect(checkedHead).toBe(true)
		await page.unrouteAll({ behavior: 'wait' })
		await expect(
			page.getByRole('link', { name: 'Continue to onboarding' }),
		).toBeVisible()

		let connectAgentEmail = null as MockEmailMessage | null
		await expect
			.poll(
				async () => {
					const payload = await listE2eCloudflareMockMessages()
					connectAgentEmail = findConnectAgentEmail(payload.messages, email)
					return connectAgentEmail
				},
				{ timeout: 15_000 },
			)
			.not.toBeNull()
		expect(connectAgentEmail?.subject).toBe('Connect the agent you already use')

		const sessionAfter = await page.request.get('/session')
		expect(sessionAfter.ok()).toBe(true)
		const sessionAfterBody = (await sessionAfter.json()) as {
			ok?: boolean
			session?: { email?: string; emailVerified?: boolean }
		}
		expect(sessionAfterBody.ok).toBe(true)
		expect(sessionAfterBody.session?.email).toBe(email)
		expect(sessionAfterBody.session?.emailVerified).toBe(true)

		await page.getByRole('link', { name: 'Continue to onboarding' }).click()
		await expect(page).toHaveURL(/\/onboarding/, { timeout: 20_000 })
		await waitForClientHydration(page)
		await expect(
			page.getByRole('heading', { name: /Get started with\s*Kody/i }),
		).toBeVisible()

		const stepsNav = page.getByRole('navigation', { name: 'Onboarding steps' })
		await stepsNav
			.getByRole('link', { name: '2 Make something useful' })
			.click()
		await expect(page.getByTestId('onboarding-connect-mcp')).toBeVisible()
		await expect(
			page.getByTestId('onboarding-unconnected-prompt'),
		).toBeVisible()

		await stepsNav
			.getByRole('link', { name: '3 Connect a second agent' })
			.click()
		await expect(
			page.getByTestId('onboarding-connect-second-agent'),
		).toBeVisible()
		await expect(page.getByTestId('onboarding-agent-picker')).toBeVisible()

		await stepsNav.getByRole('link', { name: '1 Connect your agent' }).click()
		// Step 3 retains its own picker until Step 1 commits.
		const firstAgentPanel = page.getByTestId('onboarding-connect-agent')
		await expect(firstAgentPanel).toBeVisible()
		await firstAgentPanel
			.getByTestId('onboarding-agent-picker')
			.getByRole('link', { name: 'Claude Code', exact: true })
			.click()
		await expect(page).toHaveURL(/\/onboarding\/step-1\/claude-code/)
		const mcpUrl = `${origin}/mcp`
		await expect(
			page.getByTestId('onboarding-agent-instructions'),
		).toContainText(mcpUrl)
		await expect(
			page
				.locator('[data-surface="desktop"]')
				.getByTestId('onboarding-authenticate-callout'),
		).toBeVisible()

		const mcpAfterVerify = await postUnauthenticatedMcpInitialize(origin)
		expect(mcpAfterVerify.status).toBe(401)
		expect(mcpAfterVerify.headers.get('www-authenticate') ?? '').toMatch(
			/^Bearer\s+/,
		)
		expect(mcpAfterVerify.headers.get('www-authenticate') ?? '').toContain(
			`${origin}/.well-known/oauth-protected-resource/mcp`,
		)

		await page.goto('/account/security')
		await waitForClientHydration(page)
		await expect(
			page.getByText('Change password', { exact: true }),
		).toBeVisible()
		await page.goto('/account/data')
		await waitForClientHydration(page)
		await page.getByTestId('delete-account').click()
		await page.getByTestId('delete-account-confirmation').fill('GOODBYE KODY')
		await page.getByTestId('delete-account-password').fill(password)
		await page.getByTestId('delete-account-confirm').click()
		await expect(page).toHaveURL(/\/\?accountDeleted=1$/)
		await expect(page.getByTestId('account-deleted-notice')).toHaveText(
			'Your Kody account has been deleted',
		)
		const sessionAfterDelete = await page.request.get('/session')
		expect(sessionAfterDelete.ok()).toBe(true)
		const sessionAfterDeleteBody = (await sessionAfterDelete.json()) as {
			ok?: boolean
		}
		expect(sessionAfterDeleteBody.ok).toBe(false)
	} finally {
		deleteUserInE2eDatabase(email)
	}
})
