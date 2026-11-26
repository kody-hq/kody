import {
	expect,
	test,
	waitForClientHydration,
	type Page,
	type Request,
} from './playwright-utils.ts'
import { seedUserInE2eDatabase } from './d1-utils.ts'
import { requestHasMutationDataFields } from './server-function-requests.ts'

function uniqueUsername() {
	return `e2e-sug-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

async function seedTakenUsername(username: string) {
	await seedUserInE2eDatabase({
		email: `${username}@example.com`,
		username,
		password: 'e2e-suggestion-password',
	})
}

test('an invalid username offers a clickable, available suggestion', async ({
	page,
}) => {
	const base = uniqueUsername()
	await page.goto('/signup')
	await waitForClientHydration(page)

	const field = page.getByLabel('Username', { exact: true })
	await field.fill(`${base};j`)
	const suggestion = page.getByRole('button', { name: `Use ${base}-j` })
	await expect(suggestion).toBeVisible()

	await suggestion.focus()
	await page.keyboard.press('Enter')
	await expect(field).toHaveValue(`${base}-j`)
	await expect(field).toBeFocused()
	await expect(page.getByText(`${base}-j is available.`)).toBeVisible()
	await expect(page.getByTestId('handle-suggestion')).toHaveCount(0)
})

test('a taken sanitized suggestion falls back to the first free variant', async ({
	page,
}) => {
	const base = uniqueUsername()
	await seedTakenUsername(base)
	await page.goto('/signup')
	await waitForClientHydration(page)

	const field = page.getByLabel('Username', { exact: true })
	await field.fill(`${base};`)
	await expect(
		page.getByRole('button', { name: `Use ${base}-2` }),
	).toBeVisible()
	await expect(
		page.getByRole('button', { name: `Use ${base}`, exact: true }),
	).toHaveCount(0)
})

test('a suggestion taken before the click shows the normal taken error', async ({
	page,
}) => {
	const base = uniqueUsername()
	await page.goto('/signup')
	await waitForClientHydration(page)

	const field = page.getByLabel('Username', { exact: true })
	await field.fill(`${base};`)
	const suggestion = page.getByRole('button', {
		name: `Use ${base}`,
		exact: true,
	})
	await expect(suggestion).toBeVisible()

	await seedTakenUsername(base)
	await suggestion.click()
	await expect(field).toHaveValue(base)
	await expect(field).toBeFocused()
	await expect(
		page.getByRole('status').filter({ hasText: 'taken' }),
	).toBeVisible()
})

function isUsernameCheck(request: Request) {
	return (
		request.method() === 'POST' &&
		new URL(request.url()).pathname.startsWith('/_serverFn/') &&
		(request.postData() ?? '').includes('"username"')
	)
}

async function recordUsernameChecks(page: Page) {
	const checks: Array<Request> = []
	page.on('request', (request) => {
		if (isUsernameCheck(request)) checks.push(request)
	})
	return checks
}

async function recordAvailabilityStatuses(page: Page) {
	await page.evaluate(() => {
		const status = document.querySelector('[id$="-username-availability"]')
		const seen: Array<string | null> = []
		;(window as unknown as { seenStatuses: typeof seen }).seenStatuses = seen
		new MutationObserver(() =>
			seen.push(status?.getAttribute('data-status') ?? null),
		).observe(status!, { attributes: true, attributeFilter: ['data-status'] })
	})
	return () =>
		page.evaluate(
			() =>
				(window as unknown as { seenStatuses: Array<string | null> })
					.seenStatuses,
		)
}

/** Longer than the field's availability debounce. */
const pastDebounceMs = 1_000

test('editing the email never checks, fills, or replaces the username', async ({
	page,
}) => {
	const base = uniqueUsername()
	await page.goto('/signup')
	await waitForClientHydration(page)
	await page.clock.install()
	const username = page.getByLabel('Username', { exact: true })
	const email = page.getByLabel('Email', { exact: true })
	const checks = await recordUsernameChecks(page)

	await email.pressSequentially(`${base}@example.com`)
	await page.clock.fastForward(pastDebounceMs)
	await expect(username).toHaveValue('')

	await username.fill(base)
	await expect(page.getByText(`${base} is available.`)).toBeVisible()
	const statuses = await recordAvailabilityStatuses(page)

	await email.fill('')
	await email.pressSequentially(`someone-else-${base}@example.com`)
	await page.clock.fastForward(pastDebounceMs)
	await expect(username).toHaveValue(base)
	await expect(page.getByText(`${base} is available.`)).toBeVisible()
	expect(await statuses()).toEqual([])

	// A later username edit orders after anything the email edits sent.
	await username.fill(`${base}x`)
	await expect(page.getByText(`${base}x is available.`)).toBeVisible()
	expect(checks).toHaveLength(2)
	expect(
		requestHasMutationDataFields(checks[0]!, { username: base }),
	).toBeTruthy()
})

test('editing the username runs one debounced availability check', async ({
	page,
}) => {
	const base = uniqueUsername()
	await page.goto('/signup')
	await waitForClientHydration(page)
	await page.clock.install()
	await page.clock.pauseAt(Date.now() + pastDebounceMs)
	const username = page.getByLabel('Username', { exact: true })
	const checks = await recordUsernameChecks(page)

	// Paused, every keystroke lands inside one debounce window.
	await username.pressSequentially(base)
	await page.clock.resume()
	await expect(page.getByText(`${base} is available.`)).toBeVisible()
	expect(checks).toHaveLength(1)
	expect(
		requestHasMutationDataFields(checks[0]!, { username: base }),
	).toBeTruthy()
})
