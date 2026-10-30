import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { writeLocalSiblingDevConfig } from './local-sibling-dev-config.ts'

async function writeSiblingFixture(
	dir: string,
	config: Record<string, unknown>,
) {
	const configPath = path.join(dir, 'wrangler.jsonc')
	await writeFile(configPath, JSON.stringify(config))
	return configPath
}

test('pins the registered name, drops always-remote bindings, and injects vars', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'sibling-dev-config-'))
	const previousAppBaseUrl = process.env.APP_BASE_URL
	delete process.env.APP_BASE_URL
	try {
		const configPath = await writeSiblingFixture(dir, {
			name: 'kody-platform',
			main: './src/index.ts',
			migrations: [
				{
					tag: 'v1',
					transferred_classes: [
						{
							from: 'StorageRunner',
							from_script: 'kody',
							to: 'StorageRunner',
						},
					],
				},
			],
			env: {
				production: {
					ai: { binding: 'AI' },
					artifacts: { binding: 'ARTIFACTS' },
					durable_objects: {
						bindings: [
							{
								name: 'STORAGE',
								class_name: 'StorageRunner',
								script_name: 'kody',
							},
						],
					},
					vars: { SENTRY_ENVIRONMENT: 'production' },
				},
			},
		})
		const outputPath = await writeLocalSiblingDevConfig({
			configPath,
			envName: 'production',
			mainWorkerDevName: 'kody-production',
			port: '3742',
			dropAlwaysRemoteBindings: ['ai', 'artifacts'],
		})
		expect(path.basename(outputPath)).toBe('wrangler-local-dev.generated.json')
		const written = JSON.parse(await readFile(outputPath, 'utf8')) as {
			migrations: Array<{ new_sqlite_classes?: Array<string> }>
			env: {
				production: {
					name: string
					ai?: unknown
					artifacts?: unknown
					durable_objects: {
						bindings: Array<{ script_name: string }>
					}
					vars: Record<string, string>
				}
			}
		}
		expect(written.env.production.name).toBe('kody-platform')
		expect(written.env.production.ai).toBeUndefined()
		expect(written.env.production.artifacts).toBeUndefined()
		expect(
			written.env.production.durable_objects.bindings[0]?.script_name,
		).toBe('kody-production')
		expect(written.env.production.vars.WRANGLER_IS_LOCAL_DEV).toBe('true')
		expect(written.env.production.vars.APP_BASE_URL).toBe(
			'http://localhost:3742',
		)
		expect(written.migrations).toEqual([
			{ tag: 'v1', new_sqlite_classes: ['StorageRunner'] },
		])
	} finally {
		if (previousAppBaseUrl === undefined) {
			delete process.env.APP_BASE_URL
		} else {
			process.env.APP_BASE_URL = previousAppBaseUrl
		}
		await rm(dir, { recursive: true, force: true })
	}
})

test('defaults to dropping only the ai always-remote binding', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'sibling-dev-config-ai-'))
	try {
		const configPath = await writeSiblingFixture(dir, {
			name: 'kody-runtime',
			main: './src/index.ts',
			env: {
				production: {
					ai: { binding: 'AI' },
					artifacts: { binding: 'ARTIFACTS' },
					vars: {},
				},
			},
		})
		const outputPath = await writeLocalSiblingDevConfig({
			configPath,
			envName: 'production',
			mainWorkerDevName: 'kody-production',
			port: undefined,
		})
		const written = JSON.parse(await readFile(outputPath, 'utf8')) as {
			env: {
				production: { ai?: unknown; artifacts?: unknown }
			}
		}
		expect(written.env.production.ai).toBeUndefined()
		expect(written.env.production.artifacts).toEqual({ binding: 'ARTIFACTS' })
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('forwards mock Artifacts settings to the RepoSession worker without copying live tokens', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'sibling-dev-mock-'))
	const keys = [
		'CLOUDFLARE_API_BASE_URL',
		'CLOUDFLARE_API_TOKEN',
		'CLOUDFLARE_ACCOUNT_ID',
		'CLOUDFLARE_API_SOURCE_SNAPSHOTS',
		'SKIP_CLOUDFLARE_MOCK',
	] as const
	const previous = Object.fromEntries(
		keys.map((key) => [key, process.env[key]]),
	)
	try {
		Object.assign(process.env, {
			CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9043',
			CLOUDFLARE_API_TOKEN: 'mock-test',
			CLOUDFLARE_ACCOUNT_ID: 'mock-account',
			CLOUDFLARE_API_SOURCE_SNAPSHOTS: 'true',
		})
		delete process.env.SKIP_CLOUDFLARE_MOCK
		const configPath = await writeSiblingFixture(dir, {
			name: 'kody-platform',
			env: { production: { vars: {} } },
		})
		const options = {
			configPath,
			envName: 'production',
			mainWorkerDevName: 'kody-production',
			port: '3743',
		}
		const output = await writeLocalSiblingDevConfig(options)
		const readVars = async () =>
			JSON.parse(await readFile(output, 'utf8')).env.production.vars
		expect(await readVars()).toMatchObject({
			CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9043',
			CLOUDFLARE_API_TOKEN: 'mock-test',
			CLOUDFLARE_ACCOUNT_ID: 'mock-account',
			CLOUDFLARE_API_SOURCE_SNAPSHOTS: 'true',
		})
		process.env.SKIP_CLOUDFLARE_MOCK = '1'
		process.env.CLOUDFLARE_API_TOKEN = 'live-token-must-not-be-written'
		await writeLocalSiblingDevConfig(options)
		expect((await readVars()).CLOUDFLARE_API_TOKEN).toBeUndefined()
	} finally {
		for (const key of keys) {
			if (previous[key] === undefined) delete process.env[key]
			else process.env[key] = previous[key]
		}
		await rm(dir, { recursive: true, force: true })
	}
})
