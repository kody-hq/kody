import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	collectLocalOriginDevVars,
	writeLocalOriginDevConfig,
} from './local-origin-dev-config.ts'

test('keeps an explicit APP_BASE_URL and does not invent Cloudflare vars', () => {
	expect(
		collectLocalOriginDevVars({
			WRANGLER_IS_LOCAL_DEV: 'true',
			APP_BASE_URL: 'http://localhost:4000',
		}),
	).toEqual({
		WRANGLER_IS_LOCAL_DEV: 'true',
		APP_BASE_URL: 'http://localhost:4000',
	})
})

test('does not serialize Worker secrets or a live Cloudflare token', () => {
	expect(
		collectLocalOriginDevVars({
			COOKIE_SECRET: 'cookie-secret',
			SECRET_STORE_KEY: 'secret-store-key',
			SKIP_CLOUDFLARE_MOCK: '1',
			CLOUDFLARE_API_TOKEN: 'live-token',
			CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.com',
		}),
	).toEqual({
		WRANGLER_IS_LOCAL_DEV: 'true',
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.com',
	})
})

test('forwards explicitly configured local email domains without inventing them', () => {
	expect(
		collectLocalOriginDevVars({
			USER_EMAIL_DOMAIN: 'inbox.localhost',
			SYSTEM_EMAIL_DOMAIN: 'localhost',
		}),
	).toEqual({
		WRANGLER_IS_LOCAL_DEV: 'true',
		USER_EMAIL_DOMAIN: 'inbox.localhost',
		SYSTEM_EMAIL_DOMAIN: 'localhost',
	})
})

test('always injects WRANGLER_IS_LOCAL_DEV and copies mock Cloudflare vars', () => {
	expect(
		collectLocalOriginDevVars(
			{
				CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9028',
				CLOUDFLARE_API_TOKEN: 'mock-token',
				CLOUDFLARE_ACCOUNT_ID: 'cf_account_mock_123',
				CLOUDFLARE_API_SOURCE_SNAPSHOTS: 'true',
			},
			'3742',
		),
	).toEqual({
		WRANGLER_IS_LOCAL_DEV: 'true',
		APP_BASE_URL: 'http://localhost:3742',
		CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9028',
		CLOUDFLARE_API_TOKEN: 'mock-token',
		CLOUDFLARE_ACCOUNT_ID: 'cf_account_mock_123',
		CLOUDFLARE_API_SOURCE_SNAPSHOTS: 'true',
	})
})

test('writes local-dev vars onto the selected env without dropping committed vars', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'origin-dev-config-'))
	try {
		const originConfigPath = path.join(dir, 'wrangler.jsonc')
		await writeFile(
			originConfigPath,
			JSON.stringify({
				name: 'kody',
				main: './src/index.ts',
				env: {
					production: {
						vars: { SENTRY_ENVIRONMENT: 'production' },
					},
				},
			}),
		)
		const outputPath = await writeLocalOriginDevConfig({
			originConfigPath,
			envName: 'production',
			vars: {
				WRANGLER_IS_LOCAL_DEV: 'true',
				CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9028',
			},
		})
		expect(path.basename(outputPath)).toBe('wrangler-local-dev.generated.json')
		const written = JSON.parse(await readFile(outputPath, 'utf8')) as {
			vars: Record<string, string>
			env: { production: { vars: Record<string, string> } }
		}
		expect(written.env.production.vars).toEqual({
			SENTRY_ENVIRONMENT: 'production',
			WRANGLER_IS_LOCAL_DEV: 'true',
			CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9028',
		})
		expect(written.vars).toEqual({
			WRANGLER_IS_LOCAL_DEV: 'true',
			CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9028',
		})
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('drops always-remote origin bindings from the generated local env only', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'origin-dev-config-'))
	try {
		const originConfigPath = path.join(dir, 'wrangler.jsonc')
		await writeFile(
			originConfigPath,
			JSON.stringify({
				name: 'kody',
				main: './src/index.ts',
				env: {
					production: {
						artifacts: [{ binding: 'ARTIFACTS', namespace: 'production' }],
						ai: { binding: 'AI' },
						vars: { ARTIFACTS_NAMESPACE: 'production' },
					},
				},
			}),
		)
		const outputPath = await writeLocalOriginDevConfig({
			originConfigPath,
			envName: 'production',
			vars: { WRANGLER_IS_LOCAL_DEV: 'true' },
			dropAlwaysRemoteBindings: ['artifacts'],
		})
		const written = JSON.parse(await readFile(outputPath, 'utf8')) as {
			env: {
				production: {
					artifacts?: unknown
					ai?: unknown
					vars: Record<string, string>
				}
			}
		}
		expect(written.env.production.artifacts).toBeUndefined()
		expect(written.env.production.ai).toEqual({ binding: 'AI' })
		expect(written.env.production.vars.ARTIFACTS_NAMESPACE).toBe('production')
		expect(written.env.production.vars.WRANGLER_IS_LOCAL_DEV).toBe('true')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('Stripe simulator config is restricted to the isolated test runner', () => {
	const values = {
		KODY_E2E_WEB_SERVER: '1',
		CLOUDFLARE_ENV: 'test',
		KODY_E2E_STRIPE_TOKEN: 'sk_test_e2e_fixture',
		STRIPE_API_BASE_URL: 'http://127.0.0.1:1234',
		STRIPE_SECRET_KEY: 'never-use-live-key',
	}
	expect(collectLocalOriginDevVars(values)).toMatchObject({
		STRIPE_SECRET_KEY: 'sk_test_e2e_fixture',
		STRIPE_API_BASE_URL: 'http://127.0.0.1:1234',
	})
	expect(
		collectLocalOriginDevVars({ ...values, CLOUDFLARE_ENV: 'production' }),
	).not.toHaveProperty('STRIPE_SECRET_KEY')
	expect(() =>
		collectLocalOriginDevVars({
			...values,
			STRIPE_API_BASE_URL: 'https://api.stripe.com',
		}),
	).toThrow('loopback')
})
