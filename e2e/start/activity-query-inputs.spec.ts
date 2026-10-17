import { orgResourcePath } from '../../packages/worker/universal/org-pages.ts'
import { requestHasDataFields } from '../server-function-requests.ts'
import { randomUUID } from 'node:crypto'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

test('activity navigation sends server filters and pagination while ignoring attribution', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `activity-input-${id}@example.com`,
		username: `activity-input-${id}`,
	})
	await login({ ...user, mode: 'login' })
	const activityPath = orgResourcePath(user.username, 'activity')
	await page.goto(activityPath)
	await waitForClientHydration(page)
	await page.waitForLoadState('networkidle')
	const cursor = Buffer.from(
		JSON.stringify({ startedAt: new Date().toISOString(), id: 'previous-run' }),
	).toString('base64')
	for (const pathname of [activityPath, `${activityPath}/missing-run`]) {
		const search = new URLSearchParams({
			view: 'recent',
			status: 'success',
			surface: 'job',
			error_triage: 'all',
			cursor,
			utm_source: 'regression',
		})
		const expected = {
			orgSlug: user.username,
			selectedRunId: pathname === activityPath ? null : 'missing-run',
			viewFilter: 'recent',
			statusFilter: 'success',
			surfaceFilter: 'job',
			triageFilter: 'all',
			cursor,
		}
		const response = page.waitForResponse((response) =>
			requestHasDataFields(response.request(), expected, [
				'section',
				'utm_source',
			]),
		)
		await page.evaluate(
			(href) => window.history.pushState(null, '', href),
			`${pathname}?${search}`,
		)
		const read = await response
		expect(read.ok()).toBe(true)
		const wireUrl = decodeURIComponent(read.url())
		expect(wireUrl).not.toContain('utm_source')
		const body = await read.text()
		for (const field of [
			'viewFilter',
			'statusFilter',
			'surfaceFilter',
			'triageFilter',
		])
			expect(body).toContain(field)
		await expect(page.getByLabel('Activity view', { exact: true })).toHaveValue(
			'recent',
		)
		await expect(page.getByLabel('Status filter', { exact: true })).toHaveValue(
			'success',
		)
		await expect(
			page.getByLabel('Surface filter', { exact: true }),
		).toHaveValue('job')
		await expect(page.getByLabel('Triage filter', { exact: true })).toHaveValue(
			'all',
		)
	}
})
