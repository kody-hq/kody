import { expect, test } from 'vitest'
import { statusFaviconPath } from './favicon.ts'
import type { StatusWorkerEnv } from './status-store.ts'
import worker from './worker.ts'

type StatusFetch = NonNullable<ExportedHandler<StatusWorkerEnv>['fetch']>

function workerRequest(url: string) {
	return new Request(url) as Parameters<StatusFetch>[0]
}

function unusedStore(): StatusWorkerEnv['STATUS_STORE'] {
	return {
		idFromName() {
			throw new Error('STATUS_STORE should not be used for /maintenance')
		},
		get() {
			throw new Error('STATUS_STORE should not be used for /maintenance')
		},
	} as unknown as StatusWorkerEnv['STATUS_STORE']
}

function env(): StatusWorkerEnv {
	return {
		STATUS_STORE: unusedStore(),
		PRIMARY_ORIGIN: 'https://kody.codes',
		PACKAGE_APP_ORIGIN: 'https://kody.run',
		STATUS_PAGE_URL: 'https://status.kody.codes',
		ALERT_EMAIL_TO: 'ops@example.com',
		ALERT_EMAIL_FROM: 'status@example.com',
		BUILD_COMMIT: 'abc123',
	}
}

test('GET /maintenance returns the static page without touching status storage', async () => {
	const response = await worker.fetch(
		workerRequest('https://status.kody.codes/maintenance'),
		env(),
	)
	expect(response.status).toBe(200)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	expect(response.headers.get('Content-Type')).toContain('text/html')
	const html = await response.text()
	expect(html).toContain('href="https://status.kody.codes/"')
	expect(html).toContain(`href="${statusFaviconPath('unknown')}"`)
})

test('GET /health stays independent of the maintenance page', async () => {
	const response = await worker.fetch(
		workerRequest('https://status.kody.codes/health'),
		env(),
	)
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		commit: 'abc123',
	})
})
