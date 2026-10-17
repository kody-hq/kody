import { requestHasMutationDataFields } from '../server-function-requests.ts'
import { randomUUID } from 'node:crypto'
import {
	classifyEmailThroughUi,
	deleteEmailThroughUi,
	readEmailThroughUi,
} from '../account-fixtures.ts'
import {
	expect,
	test,
	waitForClientHydration,
	type Request,
} from '../playwright-utils.ts'

/** Inspect the server function's data object, not strings nested in auth
 * context and not a generated function ID that can change between builds. */
function emailRead(request: Pick<Request, 'url' | 'method'>) {
	const url = new URL(request.url())
	if (request.method() !== 'GET' || !url.pathname.startsWith('/_serverFn/'))
		return null
	try {
		const root = JSON.parse(url.searchParams.get('payload') ?? 'null')?.t?.p
		const index = root?.k?.indexOf('data') ?? -1
		const data = index < 0 ? null : root.v[index]?.p
		if (!Array.isArray(data?.k)) return null
		if (data.k.includes('messageId')) {
			return {
				kind: 'detail',
				messageId: data.v[data.k.indexOf('messageId')]?.s,
			}
		}
		if (
			['org', 'query', 'classification', 'page', 'pageSize'].every((key) =>
				data.k.includes(key),
			)
		)
			return { kind: 'list' }
		return null
	} catch {
		return null
	}
}

test('Email reuses resources across selection and preserves optimistic intent through stale reads and return navigation', async ({
	page,
	baseURL,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(120_000)
	const origin = new URL(baseURL!)
	expect(['localhost', '127.0.0.1']).toContain(origin.hostname)
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `email-resources-${id}@example.com`,
		username: `email-resources-${id}`,
	})
	await login({ ...user, mode: 'login' })
	const read = () => readEmailThroughUi(page)
	const recipient = (await read()).inboxAddress!
	expect(recipient).toMatch(/@(inbox\.)?(localhost|127\.0\.0\.1|[^@]+\.test)$/)
	const endpoint = new URL('/cdn-cgi/local/email', origin)
	endpoint.searchParams.set('from', 'sender@example.com')
	endpoint.searchParams.set('to', recipient)
	const subjects = [`Resource A ${id}`, `Resource B ${id}`]
	const messageIds: string[] = []
	let releaseWrite = () => {}
	let releaseReads = () => {}
	try {
		for (const [index, subject] of subjects.entries()) {
			// Wrangler local event injection, never an outbound mail API.
			const injected = await page.request.post(endpoint.href, {
				data: [
					'From: sender@example.com',
					`To: ${recipient}`,
					`Subject: ${subject}`,
					`Message-ID: <resources-${id}-${index}@example.com>`,
					'Content-Type: text/plain; charset=utf-8',
					'',
					'Resource cache fixture.',
				].join('\r\n'),
				headers: { 'Content-Type': 'message/rfc822' },
			})
			expect(injected.status()).toBe(200)
			let messageId = ''
			await expect
				.poll(async () => {
					messageId =
						(await read()).messages.find(
							(message) => message.subject === subject,
						)?.id ?? ''
					return messageId
				})
				.not.toBe('')
			messageIds.push(messageId)
			await classifyEmailThroughUi(page, messageId)
		}
		await page.goto('/account')
		await waitForClientHydration(page)
		// Keep cache age deterministic while measuring reuse. Timers and network
		// still run normally; advance Date explicitly for the activation test.
		const now = Date.now()
		await page.clock.setFixedTime(new Date(now))
		const reads: Array<ReturnType<typeof emailRead>> = []
		const serverRequests: string[] = []
		let destinationsPath: string | undefined
		page.on('request', (request) => {
			const resource = emailRead(request)
			if (resource) reads.push(resource)
			const url = new URL(request.url())
			if (url.pathname.startsWith('/_serverFn/'))
				serverRequests.push(url.pathname)
		})
		page.on('response', async (response) => {
			const url = new URL(response.url())
			if (
				!url.pathname.startsWith('/_serverFn/') ||
				response.request().method() !== 'GET'
			)
				return
			const body = await response.text().catch(() => '')
			if (
				body.includes('additionalLimit') &&
				body.includes('additionalRemaining') &&
				body.includes('destinations')
			)
				destinationsPath = url.pathname
		})
		await page.evaluate(
			(href) => window.history.pushState(null, '', href),
			`/@${user.username}/-/email`,
		)
		await expect(
			page.getByRole('link', { name: subjects[0]!, exact: false }),
		).toBeVisible()
		await expect.poll(() => destinationsPath).toBeTruthy()
		await page.waitForLoadState('networkidle')
		expect(reads.filter((read) => read?.kind === 'list')).toHaveLength(1)
		expect(reads.filter((read) => read?.kind === 'detail')).toHaveLength(0)
		expect(
			serverRequests.filter((path) => path === destinationsPath),
		).toHaveLength(1)
		for (const index of [0, 1, 0]) {
			await page
				.getByRole('link', { name: subjects[index]!, exact: false })
				.click()
			await expect(
				page.getByRole('button', { name: 'Mark as spam', exact: true }),
			).toBeVisible()
			await expect(page).toHaveURL(
				(url) =>
					decodeURIComponent(url.pathname) ===
					`/@${user.username}/-/email/${messageIds[index]}`,
			)
			await expect(
				page.getByRole('heading', { name: subjects[index]!, exact: true }),
			).toBeVisible()
			await page.waitForLoadState('networkidle')
		}
		expect(reads.filter((read) => read?.kind === 'list')).toHaveLength(1)
		expect(
			reads
				.filter((read) => read?.kind === 'detail')
				.map((read) => read?.messageId),
		).toEqual(messageIds)
		expect(
			serverRequests.filter((path) => path === destinationsPath),
		).toHaveLength(1)

		let holdReads = true
		const capturedReads: string[] = []
		let deliveredReads = 0
		const readBarrier = new Promise<void>((resolve) => {
			releaseReads = resolve
		})
		await page.route('**/_serverFn/**', async (route) => {
			const resource = emailRead(route.request())
			if (!holdReads || !resource) return route.continue()
			// Capture an actual authorized response before the write, then deliver
			// that stale result after optimism is visible.
			const response = await route.fetch()
			expect(response.ok()).toBe(true)
			capturedReads.push(resource.kind)
			await readBarrier
			await route.fulfill({ response })
			deliveredReads++
		})
		await page.clock.setFixedTime(new Date(now + 20_000))
		await page.evaluate(() => window.dispatchEvent(new Event('focus')))
		await expect
			.poll(() => capturedReads.slice().sort())
			.toEqual(['detail', 'list'])
		let capturedWrite = false
		const writeBarrier = new Promise<void>((resolve) => {
			releaseWrite = resolve
		})
		await page.route('**/_serverFn/**', async (route) => {
			if (
				!requestHasMutationDataFields(route.request(), {
					messageId: messageIds[0]!,
					classification: 'quarantined',
				})
			)
				return route.fallback()
			capturedWrite = true
			await writeBarrier
			await route.continue()
		})
		await page
			.getByRole('button', { name: 'Mark as spam', exact: true })
			.click()
		await expect.poll(() => capturedWrite).toBe(true)
		const quarantined = page
			.locator('span')
			.filter({ hasText: /^Quarantined$/ })
			.first()
		await expect(quarantined).toBeVisible()
		holdReads = false
		releaseReads()
		await expect.poll(() => deliveredReads).toBe(2)
		await expect(quarantined).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Updating…', exact: true }),
		).toBeVisible()
		await page.getByTestId('account-menu').click()
		await page
			.getByTestId('account-menu-panel')
			.getByRole('link', { name: 'Account settings', exact: true })
			.click()
		await expect(page.getByLabel('Display name', { exact: true })).toBeVisible()
		await page.goBack()
		await expect(
			page.getByRole('heading', { name: subjects[0]!, exact: true }),
		).toBeVisible()
		await expect(quarantined).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Updating…', exact: true }),
		).toBeVisible()
		const accepted = page.waitForResponse((response) =>
			requestHasMutationDataFields(response.request(), {
				messageId: messageIds[0]!,
				classification: 'quarantined',
			}),
		)
		releaseWrite()
		expect((await accepted).ok()).toBe(true)
		await expect(
			page.getByRole('button', { name: 'Updating…', exact: true }),
		).toHaveCount(0)
		await expect(quarantined).toBeVisible()
		expect(
			(await read()).messages.find((message) => message.id === messageIds[0])
				?.classification,
		).toBe('quarantined')
	} finally {
		releaseReads()
		releaseWrite()
		await page.unrouteAll({ behavior: 'wait' })
		for (const messageId of messageIds) {
			await deleteEmailThroughUi(page, messageId)
		}
	}
})
