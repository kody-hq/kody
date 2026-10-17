import { readFileSync } from 'node:fs'

const wait = (ms) => new Promise((done) => setTimeout(done, ms))

export async function createAccountSession(context, origin, result) {
	const credentials = process.env.SESSION_AUTH_FILE
		? JSON.parse(readFileSync(process.env.SESSION_AUTH_FILE, 'utf8'))[origin]
		: { email: 'jane@example.com', password: 'ilikecode' }
	if (!credentials) throw new Error('No local seed credentials configured')
	const auth = await context.request.post(origin + '/auth', {
		data: { ...credentials, mode: 'login' },
	})
	if (!auth.ok()) throw new Error(`Local seed login returned ${auth.status()}`)
	const profile = await context.request.get(origin + '/account/profile.json')
	if (!profile.ok()) throw new Error('Cannot read seeded account profile')
	const original = await profile.json()
	const editor = await context.newPage()
	editor.on('pageerror', (error) =>
		result.errors.push({ phase: 'account-editor', message: error.message }),
	)
	await editor.goto(origin + '/account')
	await editor.getByLabel('Display name', { exact: true }).waitFor()
	let sequence = 0
	let originalRetention
	const saveName = async (name) => {
		await editor.getByLabel('Display name', { exact: true }).fill(name)
		const response = editor.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === '/account/profile.json' &&
				response.request().method() === 'POST',
		)
		await editor
			.getByRole('button', { name: 'Save profile', exact: true })
			.click()
		if (!(await response).ok()) throw new Error('Profile form save failed')
		const persisted = await context.request.get(
			origin + '/account/profile.json',
		)
		if (!persisted.ok() || (await persisted.json()).displayName !== name)
			throw new Error('Profile mutation was not persisted')
	}
	return {
		async checkpoint(page) {
			sequence++
			const row = {
				sequence,
				mutationPersisted: false,
				focusFresh: false,
				reconnectRefresh: false,
				draftRetained: false,
			}
			result.accountChecks.push(row)
			if (new URL(page.url()).pathname !== '/account')
				await page
					.locator('a[href="/account"]')
					.filter({ visible: true })
					.first()
					.click()
			const field = page.getByLabel('Display name', { exact: true })
			await field.waitFor()
			const timeOrigin = await page.evaluate(() => performance.timeOrigin)
			const name = `Session saved ${sequence}`
			await saveName(name)
			row.mutationPersisted = true
			await page.bringToFront()
			await page.evaluate(() => {
				window.dispatchEvent(new FocusEvent('focus'))
				document.dispatchEvent(new Event('visibilitychange'))
			})
			const focusDeadline = performance.now() + 5000
			while (performance.now() < focusDeadline) {
				if ((await field.inputValue()) === name) {
					row.focusFresh = true
					break
				}
				await wait(50)
			}
			const draft = `Unsaved session draft ${sequence}`
			await field.fill(draft)
			const nextName = `Session remote ${sequence}`
			await saveName(nextName)
			const refresh = page
				.waitForResponse(
					async (response) => {
						if (response.request().method() !== 'GET') return false
						const path = new URL(response.url()).pathname
						if (
							path !== '/account/profile.json' &&
							!path.startsWith('/_serverFn/')
						)
							return false
						return (await response.text()).includes(nextName)
					},
					{ timeout: 5000 },
				)
				.catch(() => null)
			await page.evaluate(() => window.dispatchEvent(new Event('online')))
			row.reconnectRefresh = Boolean(await refresh)
			await wait(250)
			row.draftRetained = (await field.inputValue()) === draft
			row.documentRetained =
				(await page.evaluate(() => performance.timeOrigin)) === timeOrigin
			await field.fill(nextName)
			await page
				.locator('a[href="/account/jobs"]')
				.filter({ visible: true })
				.first()
				.click()
			await page.getByRole('heading', { name: 'Jobs', exact: true }).waitFor()
			const search = page.getByRole('searchbox', { name: 'Search jobs' })
			await search.fill('no-such-session-job')
			row.jobsSearchRetained =
				(await search.inputValue()) === 'no-such-session-job'
			await search.fill('')
			const jobs = await context.request.get(origin + '/account/jobs.json')
			row.jobsStatus = jobs.status()
			if (jobs.ok()) {
				const payload = await jobs.json()
				row.jobCount = Array.isArray(payload.jobs) ? payload.jobs.length : null
				originalRetention ??= payload.retention
				const days = Number(payload.retention.successOnceDays) === 14 ? 15 : 14
				await page
					.getByLabel('Successful one-off (days)', { exact: true })
					.fill(String(days))
				const button = page.getByRole('button', {
					name: 'Save retention',
					exact: true,
				})
				await button.evaluate((button) => {
					window.__retentionTiming = {
						start: null,
						pendingDomMs: null,
						pendingFrameMs: null,
						successFrameMs: null,
					}
					button.addEventListener(
						'click',
						() => {
							const timing = window.__retentionTiming
							timing.start = performance.now()
							const visible = (node) =>
								node &&
								node.getBoundingClientRect().height > 0 &&
								getComputedStyle(node).visibility !== 'hidden'
							const currentButton = () =>
								[...document.querySelectorAll('button')].find(
									(node) => node.textContent.trim() === 'Save retention',
								)
							const pending = () => {
								const node = currentButton()
								return node?.disabled && visible(node)
							}
							const observer = new MutationObserver(() => {
								if (pending() && timing.pendingDomMs === null)
									timing.pendingDomMs = performance.now() - timing.start
							})
							observer.observe(document.body, {
								attributes: true,
								childList: true,
								subtree: true,
							})
							const frame = () => {
								if (pending() && timing.pendingFrameMs === null)
									timing.pendingFrameMs = performance.now() - timing.start
								const success = [
									...document.querySelectorAll('[role="status"]'),
								].find(
									(node) =>
										node.textContent.includes(
											'Updated job retention preferences.',
										) && visible(node),
								)
								if (success && currentButton() && !currentButton().disabled) {
									timing.successFrameMs = performance.now() - timing.start
									observer.disconnect()
									return
								}
								if (performance.now() - timing.start < 10000)
									requestAnimationFrame(frame)
								else observer.disconnect()
							}
							requestAnimationFrame(frame)
						},
						{ capture: true, once: true },
					)
				})
				const saved = page.waitForResponse(
					(response) =>
						new URL(response.url()).pathname === '/account/jobs.json' &&
						response.request().method() === 'POST',
				)
				await page
					.getByRole('button', { name: 'Save retention', exact: true })
					.click()
				const accepted = await saved
				await accepted.finished()
				row.retentionMutationAccepted = accepted.ok()
				const responseTiming = accepted.request().timing()
				await page.waitForFunction(
					() => window.__retentionTiming.successFrameMs !== null,
					null,
					{ timeout: 10000 },
				)
				const measured = await page.evaluate(() => ({
					...window.__retentionTiming,
					timeOrigin: performance.timeOrigin,
				}))
				row.retentionTiming = {
					pendingDomMs: measured.pendingDomMs,
					pendingFrameMs: measured.pendingFrameMs,
					postResponseHeadersMs:
						responseTiming.startTime +
						responseTiming.responseStart -
						measured.timeOrigin -
						measured.start,
					postAcceptedMs:
						responseTiming.startTime +
						responseTiming.responseEnd -
						measured.timeOrigin -
						measured.start,
					successFrameMs: measured.successFrameMs,
				}
				const confirmation = await context.request.get(
					origin + '/account/jobs.json',
				)
				row.retentionPersisted =
					confirmation.ok() &&
					(await confirmation.json()).retention.successOnceDays === days
				row.retentionTiming.persistedConfirmationMs = await page.evaluate(
					() => performance.now() - window.__retentionTiming.start,
				)
			}
		},
		async close() {
			const restored = await context.request.post(
				origin + '/account/profile.json',
				{ data: { displayName: original.displayName } },
			)
			const checked = await context.request.get(
				origin + '/account/profile.json',
			)
			result.profileRestored =
				restored.ok() &&
				checked.ok() &&
				(await checked.json()).displayName === original.displayName
			if (originalRetention) {
				const restoredRetention = await context.request.post(
					origin + '/account/jobs.json',
					{
						data: {
							action: 'update_retention',
							successOnceDays: originalRetention.successOnceDays,
							failedOrNeverRanOnceDays:
								originalRetention.failedOrNeverRanOnceDays,
							disabledRecurringDays: originalRetention.disabledRecurringDays,
						},
					},
				)
				const verified = await context.request.get(
					origin + '/account/jobs.json',
				)
				const payload = verified.ok() ? await verified.json() : null
				result.retentionRestored =
					restoredRetention.ok() &&
					[
						'successOnceDays',
						'failedOrNeverRanOnceDays',
						'disabledRecurringDays',
					].every((key) => payload?.retention[key] === originalRetention[key])
			}
			await editor.close()
		},
	}
}
