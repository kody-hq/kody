import { resetIsolateState } from '@kody-internal/shared/isolate-state-test-support.ts'
import assert from 'node:assert/strict'

import { afterEach, test, vi } from 'vitest'

import {
	accessClaims,
	accessSigner,
	environment,
} from './backup-control-plane-test-support.ts'
import { handleControlPlaneFetch } from './control-plane-fetch.ts'

afterEach(() => {
	vi.restoreAllMocks()
})

const routes: Array<{ method: string; path: string }> = [
	{ method: 'GET', path: '/' },
	{ method: 'GET', path: '/restore-status?id=demo' },
	{ method: 'GET', path: '/seal-status?id=seal-day-2026-09-22' },
	{ method: 'POST', path: '/actions/run-backup' },
	{ method: 'POST', path: '/actions/seal-day' },
	{ method: 'POST', path: '/actions/run-drill' },
	{ method: 'POST', path: '/actions/restore/prepare' },
	{ method: 'POST', path: '/actions/restore/execute' },
]

test('fetch handler returns 403 without a valid Access JWT for every route', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined)
	resetIsolateState()
	const env = environment()
	for (const route of routes) {
		const response = await handleControlPlaneFetch(
			new Request(`https://backup.example${route.path}`, {
				method: route.method,
				headers:
					route.method === 'POST'
						? { 'sec-fetch-site': 'same-origin' }
						: undefined,
			}),
			env,
			async () => Response.json({ keys: [] }),
		)
		assert.equal(response.status, 403, `${route.method} ${route.path}`)
		assert.deepEqual(await response.json(), {
			error: 'forbidden',
			code: 'access-jwt-missing',
		})
	}
})

test('fetch handler serves the dashboard with a valid Access JWT', async () => {
	resetIsolateState()
	const { fetcher, sign } = accessSigner()
	const env = environment()
	const response = await handleControlPlaneFetch(
		new Request('https://backup.example/', {
			headers: { 'cf-access-jwt-assertion': sign(accessClaims(env)) },
		}),
		env,
		fetcher,
	)
	assert.equal(response.status, 200)
	assert.match(response.headers.get('content-type') ?? '', /text\/html/)
})
