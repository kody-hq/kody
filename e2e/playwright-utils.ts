import {
	expect,
	test as base,
	type APIRequestContext,
	type Page,
} from '@playwright/test'
import * as setCookieParser from 'set-cookie-parser'
import {
	assignRoleInE2eDatabase,
	clearAuthRateLimitsInE2eDatabase,
	seedUserInE2eDatabase,
} from './d1-utils.ts'
import { ensurePrimaryUserExists, primaryTestUser } from './auth-test-user.ts'
import { usernameFromEmail } from '../packages/worker/src/identity/username.ts'
import {
	assertE2eWebServerAlive,
	attachUnreadCloneTeeHintIfNeeded,
	throwIfE2eWebServerDead,
} from './web-server-liveness.ts'

export * from '@playwright/test'

// Cold Vite compile of a lazy route area (account-area, admin-area) happens
// after `page-init.js` marks `html.js.is-settled`. A first `/account/jobs`
// load on this VM reached `data-hydrated` ~6s after `goto` returned (~16s
// from navigation start); a colder first attempt exceeded 15s. CI shares
// the runner with unit + MCP, so keep the larger budget there.
const hydrationTimeoutMs = process.env.CI ? 30_000 : 20_000

/**
 * Wait until Start client hydration has bound event handlers.
 *
 * The root route sets `html[data-hydrated=true]` after mount, so SSR headings
 * and buttons are visible while click/submit handlers are still unbound.
 * Clicking a `type="button"` control in that gap is a silent no-op.
 *
 * Do not use Playwright's 5s default: `is-settled` only means the document
 * loaded, not that the client finished hydrating.
 */
export async function waitForClientHydration(page: Page) {
	await expect(
		page.locator('html'),
		'Start boot sets html[data-hydrated=true] after client hydration',
	).toHaveAttribute('data-hydrated', 'true', {
		timeout: hydrationTimeoutMs,
	})
}

const authRetryBudgetMs = 15_000
const authRetryPauseMs = 250

export const test = base.extend<{
	/**
	 * Auto fixture: abort immediately when Wrangler has exited mid-suite so
	 * we do not burn CI retries on ECONNREFUSED for every remaining test.
	 */
	ensureE2eWebServerAlive: void
	insertNewUser(options?: {
		email?: string
		username?: string
		password?: string
	}): Promise<{ email: string; username: string; password: string }>
	assignRole(email: string, role: string): Promise<void>
	seedE2eUser(options?: {
		email?: string
		username?: string
		password?: string
		admin?: boolean
	}): Promise<{ email: string; username: string; password: string }>
	login(options?: {
		email?: string
		username?: string
		password?: string
		mode?: 'login' | 'signup'
	}): Promise<{ email: string; username: string; password: string }>
}>({
	ensureE2eWebServerAlive: [
		async ({ baseURL }, use, testInfo) => {
			await assertE2eWebServerAlive(baseURL)
			await use()
			attachUnreadCloneTeeHintIfNeeded(testInfo)
		},
		{ auto: true },
	],
	insertNewUser: async ({ page }, use) => {
		await use(async (options) => {
			const email = options?.email ?? primaryTestUser.email
			const username =
				options?.username ??
				(email === primaryTestUser.email
					? primaryTestUser.username
					: usernameFromEmail(email))
			const password = options?.password ?? primaryTestUser.password

			if (
				email === primaryTestUser.email &&
				password === primaryTestUser.password
			) {
				await ensurePrimaryUserExists()
				return { email, username: primaryTestUser.username, password }
			}

			clearAuthRateLimitsInE2eDatabase()
			await signupOrLoginViaAuth(page.request, { email, username, password })

			return { email, username, password }
		})
	},
	// Playwright fixtures require object destructuring even with no deps.
	// eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
	assignRole: async ({}, use) => {
		await use(async (email, role) => {
			assignRoleInE2eDatabase(email, role)
		})
	},
	// eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
	seedE2eUser: async ({}, use) => {
		await use(async (options) => {
			const runId = Date.now()
			const email = options?.email ?? `e2e-user-${runId}@example.com`
			const username = options?.username ?? `e2e-user-${runId}`
			const password = options?.password ?? 'e2e-test-password'
			await seedUserInE2eDatabase({
				email,
				username,
				password,
				admin: options?.admin,
			})
			return { email, username, password }
		})
	},
	login: async ({ page, baseURL }, use) => {
		await use(async (options) => {
			const email = options?.email ?? primaryTestUser.email
			const username =
				options?.username ??
				(email === primaryTestUser.email
					? primaryTestUser.username
					: usernameFromEmail(email))
			const password = options?.password ?? primaryTestUser.password
			const preferredMode = options?.mode
			const origin = new URL(baseURL ?? 'http://127.0.0.1:3847').origin

			// Manual retry loop (not expect().toPass): connection-refused must
			// abort immediately instead of polling for the full auth budget
			// after wrangler has already exited. Cap each request timeout to the
			// remaining budget so Playwright's 30s API default cannot overrun it.
			const deadline = Date.now() + authRetryBudgetMs
			let response!: Awaited<ReturnType<typeof page.request.post>>
			let lastError: unknown
			for (;;) {
				const remainingMs = Math.max(0, deadline - Date.now())
				if (remainingMs === 0) break
				try {
					clearAuthRateLimitsInE2eDatabase()
					if (preferredMode === 'login') {
						response = await page.request.post('/auth', {
							data: { email, password, mode: 'login' },
							headers: { 'Content-Type': 'application/json' },
							timeout: remainingMs,
						})
						if (!response.ok()) {
							throw new Error(
								`Failed to login user (${response.status()}): ${await readResponseDetail(response)}`,
							)
						}
					} else {
						response = await signupOrLoginViaAuth(
							page.request,
							{ email, username, password },
							remainingMs,
						)
					}
					lastError = undefined
					break
				} catch (error) {
					throwIfE2eWebServerDead(error, origin)
					lastError = error
					if (Date.now() >= deadline) break
					await new Promise((resolve) => setTimeout(resolve, authRetryPauseMs))
				}
			}
			if (lastError) throw lastError
			if (!response) {
				throw new Error('Failed to authenticate within the auth retry budget.')
			}

			// `page.request` already shares the browser context's cookie jar, so
			// the session cookie is registered for the 127.0.0.1 base URL by the
			// /auth response itself. This extra registration makes the same
			// session valid on `localhost` too, which the passkey specs need
			// because WebAuthn relying party ids must be domains, not IPs.
			const setCookieHeader = response.headers()['set-cookie']
			if (setCookieHeader) {
				const parsed = setCookieParser.parseString(setCookieHeader)
				if (!parsed) {
					throw new Error(
						`Unable to parse set-cookie header: ${setCookieHeader}`,
					)
				}
				const cookieConfig = {
					name: parsed.name,
					value: parsed.value,
					domain: 'localhost',
					path: parsed.path || '/',
					httpOnly: parsed.httpOnly,
					secure: parsed.secure,
					sameSite: parsed.sameSite as 'Strict' | 'Lax' | 'None',
				}
				await page.context().addCookies([cookieConfig])
			}

			return { email, username, password }
		})
	},
})

/**
 * Sign the user up via `/auth`, falling back to a login when the email is
 * already registered. Returns the response whose Set-Cookie header carries
 * the auth session.
 */
async function signupOrLoginViaAuth(
	request: APIRequestContext,
	credentials: { email: string; username: string; password: string },
	timeoutMs?: number,
) {
	const { email, username, password } = credentials
	const requestTimeout =
		timeoutMs === undefined ? undefined : { timeout: timeoutMs }
	const signupResponse = await request.post('/auth', {
		data: { email, username, password, mode: 'signup' },
		headers: { 'Content-Type': 'application/json' },
		...requestTimeout,
	})

	// An already-registered email gets the same accepted body as a fresh
	// signup but no session cookie (anti-enumeration), so fall back to login
	// whenever the signup did not establish a session.
	if (
		signupResponse.ok() &&
		!signupResponse.headers()['set-cookie']?.includes('kody_session=')
	) {
		const loginResponse = await request.post('/auth', {
			data: { email, password, mode: 'login' },
			headers: { 'Content-Type': 'application/json' },
			...requestTimeout,
		})
		if (!loginResponse.ok()) {
			throw new Error(
				`Failed to login existing user (${loginResponse.status()}): ${await readResponseDetail(loginResponse)}`,
			)
		}
		return loginResponse
	}

	if (!signupResponse.ok()) {
		throw new Error(
			`Failed to seed user (${signupResponse.status()}): ${await readResponseDetail(signupResponse)}`,
		)
	}
	return signupResponse
}

async function readResponseDetail(response: { json(): Promise<unknown> }) {
	const payload = await response.json().catch(() => null)
	if (
		payload &&
		typeof payload === 'object' &&
		typeof (payload as Record<string, unknown>).error === 'string'
	) {
		return (payload as Record<string, string>).error
	}
	return 'Unknown error.'
}
