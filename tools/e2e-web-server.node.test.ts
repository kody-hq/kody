import { expect, test } from 'vitest'
import {
	defaultE2eWebServerPort,
	findUnhealthyOriginDevServerMessage,
	resolveE2eWebServerHealthUrl,
	runE2eMigrateWithLockRetry,
	shouldRetryE2eMigrate,
	shouldRetryE2eWebServerFirstStart,
	startCloudflareMockWithRetry,
} from './e2e-web-server.ts'

test('e2e webServer retries the first Vite process only before /health', () => {
	expect(resolveE2eWebServerHealthUrl([])).toBe(
		`http://127.0.0.1:${defaultE2eWebServerPort}/health`,
	)
	expect(resolveE2eWebServerHealthUrl(['--port', '3847'])).toBe(
		'http://127.0.0.1:3847/health',
	)
	expect(resolveE2eWebServerHealthUrl(['--port', '--strictPort'])).toBe(
		`http://127.0.0.1:${defaultE2eWebServerPort}/health`,
	)

	expect(
		shouldRetryE2eWebServerFirstStart({
			allowRetry: true,
			shuttingDown: false,
			servedHealth: false,
			exitCode: 1,
		}),
	).toBe(true)
	expect(
		shouldRetryE2eWebServerFirstStart({
			allowRetry: true,
			shuttingDown: false,
			servedHealth: true,
			exitCode: 1,
		}),
	).toBe(false)
	expect(
		shouldRetryE2eWebServerFirstStart({
			allowRetry: false,
			shuttingDown: false,
			servedHealth: false,
			exitCode: 1,
		}),
	).toBe(false)
	expect(
		shouldRetryE2eWebServerFirstStart({
			allowRetry: true,
			shuttingDown: true,
			servedHealth: false,
			exitCode: 1,
		}),
	).toBe(false)
	expect(
		shouldRetryE2eWebServerFirstStart({
			allowRetry: true,
			shuttingDown: false,
			servedHealth: false,
			exitCode: 0,
		}),
	).toBe(false)
})

test('e2e migrate retries SQLITE_BUSY once after resetting persist', () => {
	const busy =
		"Error: wrangler d1 execute failed (exit 1) for: SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations';\ndatabase is locked: SQLITE_BUSY (extended: SQLITE_BUSY_RECOVERY)"
	expect(
		shouldRetryE2eMigrate({
			allowRetry: true,
			status: 1,
			output: busy,
		}),
	).toBe(true)
	expect(
		shouldRetryE2eMigrate({
			allowRetry: true,
			status: 1,
			output: 'duplicate column name: color',
		}),
	).toBe(false)
	expect(
		shouldRetryE2eMigrate({
			allowRetry: false,
			status: 1,
			output: busy,
		}),
	).toBe(false)

	const runs: Array<string> = []
	const logs: Array<string> = []
	let persistResets = 0
	const result = runE2eMigrateWithLockRetry({
		run: () => {
			runs.push('migrate')
			if (runs.length === 1) return { status: 1, output: busy }
			return { status: 0, output: 'applied' }
		},
		resetPersist: () => {
			persistResets += 1
		},
		log: (message) => logs.push(message),
	})
	expect(result).toEqual({ status: 0, output: 'applied' })
	expect(runs).toEqual(['migrate', 'migrate'])
	expect(persistResets).toBe(1)
	expect(logs).toEqual([
		'e2e migrate hit a transient local D1 lock; resetting persist and retrying once.',
	])

	const firstPass = runE2eMigrateWithLockRetry({
		run: () => ({ status: 0, output: 'already applied' }),
		resetPersist: () => {
			throw new Error('must not reset persist on a successful migrate')
		},
		log: () => {
			throw new Error('must not log a retry on a successful migrate')
		},
	})
	expect(firstPass).toEqual({ status: 0, output: 'already applied' })

	const sqlError = runE2eMigrateWithLockRetry({
		run: () => ({ status: 1, output: 'duplicate column name: color' }),
		resetPersist: () => {
			throw new Error('must not reset persist for a real migrate failure')
		},
		log: () => {
			throw new Error('must not log a retry for a real migrate failure')
		},
	})
	expect(sqlError).toEqual({
		status: 1,
		output: 'duplicate column name: color',
	})
})

test('e2e webServer retries a mock Cloudflare start once with a fresh token', async () => {
	const tokens: Array<string> = []
	const logs: Array<string> = []
	let nextToken = 0
	const createToken = () => `token-${String((nextToken += 1))}`

	const mock = await startCloudflareMockWithRetry({
		start: async (token) => {
			tokens.push(token)
			if (tokens.length === 1) {
				throw new Error(
					'mock cloudflare did not become ready within 60000ms\nwrangler output',
				)
			}
			return { token }
		},
		createToken,
		log: (message) => logs.push(message),
	})
	expect(mock).toEqual({ token: 'token-2' })
	expect(tokens).toEqual(['token-1', 'token-2'])
	expect(logs).toEqual([
		'Mock Cloudflare did not start (mock cloudflare did not become ready within 60000ms); retrying once with a fresh process.',
	])

	const attempts: Array<string> = []
	await expect(
		startCloudflareMockWithRetry({
			start: async (token) => {
				attempts.push(token)
				throw new Error(`down ${token}`)
			},
			createToken,
			log: () => {},
		}),
	).rejects.toThrow('down token-4')
	expect(attempts).toEqual(['token-3', 'token-4'])
})

test('e2e webServer names an unhealthy leftover origin before starting Vite', async () => {
	const identity = { pid: 9, ppid: 1, comm: 'workerd', cmdline: 'workerd' }

	expect(
		await findUnhealthyOriginDevServerMessage({
			ports: [3742],
			probeHealth: async () => false,
			listListenerPids: () => [9],
			readProcess: () => identity,
			protectedPids: new Set(),
		}),
	).toMatch(/\/health is failing/)
	expect(
		await findUnhealthyOriginDevServerMessage({
			ports: [3742],
			probeHealth: async () => false,
			listListenerPids: () => [9],
			readProcess: () => identity,
			protectedPids: new Set(),
		}),
	).toMatch(/healthy origin can stay up/)

	expect(
		await findUnhealthyOriginDevServerMessage({
			ports: [3742],
			probeHealth: async () => true,
			listListenerPids: () => [9],
			readProcess: () => identity,
			protectedPids: new Set(),
		}),
	).toBeNull()

	expect(
		await findUnhealthyOriginDevServerMessage({
			ports: [3742],
			probeHealth: async () => false,
			listListenerPids: () => [],
			readProcess: () => null,
			protectedPids: new Set(),
		}),
	).toBeNull()

	expect(
		await findUnhealthyOriginDevServerMessage({
			ports: [3742, 3743],
			probeHealth: async (origin) => origin.includes(':3743'),
			listListenerPids: (port) => (port === 3742 || port === 3743 ? [9] : []),
			readProcess: () => identity,
			protectedPids: new Set(),
		}),
	).toMatch(/\/health is failing/)
})
