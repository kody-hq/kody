import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	buildSecrets,
	buildSpawnEnv,
	buildWranglerSecretBulkFlags,
	collectSpawnedProcessOutput,
	parseDotenv,
	parseEnvSourceSpec,
	retrySecretBulkUpload,
	toDotenv,
} from './sync-worker-secrets'

const baseOptions = {
	env: undefined,
	name: undefined,
	config: undefined,
	dotenvPaths: [],
	setPairs: [],
	setFromEnv: [],
	setFromEnvOptional: [],
	generateCookieSecret: false,
	includeEmpty: false,
	emptyAsSpace: false,
}

test('toDotenv and parseDotenv round-trip multiline PEM values and literal backslash-n', () => {
	const cases: Array<[string, string, string]> = [
		[
			'OIDC_SIGNING_PRIVATE_KEY_PEM',
			'-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----',
			'OIDC_SIGNING_PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----"\n',
		],
		['LITERAL_ESCAPE', '\\n', 'LITERAL_ESCAPE="\\\\n"\n'],
	]
	for (const [key, value, encoded] of cases) {
		expect(toDotenv(new Map([[key, value]]))).toBe(encoded)
		expect(parseDotenv(encoded).get(key)).toBe(value)
	}
})

test('buildSpawnEnv preserves optional vars only when they have values', () => {
	const options = {
		...baseOptions,
		setFromEnvOptional: ['CLOUDFLARE_API_BASE_URL', 'SENTRY_DSN'],
	}
	const withoutOptionalValues = buildSpawnEnv(options, {
		CLOUDFLARE_API_BASE_URL: '',
		COOKIE_SECRET: 'cookie',
		PATH: '/usr/bin',
		SENTRY_DSN: '',
	})
	expect(withoutOptionalValues).toMatchObject({
		COOKIE_SECRET: 'cookie',
		PATH: '/usr/bin',
	})
	expect(withoutOptionalValues.CLOUDFLARE_API_BASE_URL).toBeUndefined()
	expect(withoutOptionalValues.SENTRY_DSN).toBeUndefined()

	const optionalValues = {
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.com',
		PATH: '/usr/bin',
		SENTRY_DSN: 'https://examplePublicKey@o0.ingest.sentry.io/0',
	}
	expect(buildSpawnEnv(options, optionalValues)).toMatchObject(optionalValues)
})

test('NAME=SOURCE specs upload the source variable under the worker secret name', async () => {
	expect(parseEnvSourceSpec('SENTRY_DSN')).toEqual({
		key: 'SENTRY_DSN',
		sourceKey: 'SENTRY_DSN',
	})
	expect(
		parseEnvSourceSpec('CLOUDFLARE_API_TOKEN=CLOUDFLARE_RUNTIME_API_TOKEN'),
	).toEqual({
		key: 'CLOUDFLARE_API_TOKEN',
		sourceKey: 'CLOUDFLARE_RUNTIME_API_TOKEN',
	})

	vi.stubEnv('CLOUDFLARE_API_TOKEN', 'deploy-token')
	vi.stubEnv('CLOUDFLARE_RUNTIME_API_TOKEN', 'runtime-token')
	vi.stubEnv('COOKIE_SECRET', 'cookie')
	try {
		const secrets = await buildSecrets({
			...baseOptions,
			setFromEnv: ['COOKIE_SECRET'],
			setFromEnvOptional: ['CLOUDFLARE_API_TOKEN=CLOUDFLARE_RUNTIME_API_TOKEN'],
		})
		expect(secrets.get('CLOUDFLARE_API_TOKEN')).toBe('runtime-token')
		expect(secrets.get('COOKIE_SECRET')).toBe('cookie')
		expect(secrets.has('CLOUDFLARE_RUNTIME_API_TOKEN')).toBe(false)

		vi.stubEnv('CLOUDFLARE_RUNTIME_API_TOKEN', '')
		const withoutRuntimeToken = await buildSecrets({
			...baseOptions,
			setFromEnvOptional: ['CLOUDFLARE_API_TOKEN=CLOUDFLARE_RUNTIME_API_TOKEN'],
		})
		expect(withoutRuntimeToken.has('CLOUDFLARE_API_TOKEN')).toBe(false)
	} finally {
		vi.unstubAllEnvs()
	}

	// Required specs fail closed on the empty string GitHub Actions renders for
	// an unset secret instead of silently skipping it.
	vi.stubEnv('CLOUDFLARE_API_TOKEN', 'deploy-token')
	vi.stubEnv('CLOUDFLARE_RUNTIME_API_TOKEN', '')
	const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
		throw new Error('process.exit called')
	}) as never)
	consoleError.mockImplementation(() => {})
	try {
		await expect(
			buildSecrets({
				...baseOptions,
				setFromEnv: ['CLOUDFLARE_API_TOKEN=CLOUDFLARE_RUNTIME_API_TOKEN'],
			}),
		).rejects.toThrow('process.exit called')
		expect(consoleError).toHaveBeenCalledWith(
			'Missing required environment variable: CLOUDFLARE_RUNTIME_API_TOKEN',
		)
	} finally {
		exitSpy.mockRestore()
		vi.unstubAllEnvs()
	}

	const spawnEnv = buildSpawnEnv(
		{
			...baseOptions,
			setFromEnvOptional: ['CLOUDFLARE_API_TOKEN=CLOUDFLARE_RUNTIME_API_TOKEN'],
		},
		{ CLOUDFLARE_API_TOKEN: 'deploy-token', CLOUDFLARE_RUNTIME_API_TOKEN: '' },
	)
	expect(spawnEnv.CLOUDFLARE_API_TOKEN).toBe('deploy-token')
	expect(spawnEnv.CLOUDFLARE_RUNTIME_API_TOKEN).toBeUndefined()
})

test('secret bulk omits empty --env so --name pins the unsuffixed script', () => {
	const secretsFile = '/tmp/wrangler-secrets.env'
	expect(
		buildWranglerSecretBulkFlags(
			{
				...baseOptions,
				env: '',
				name: 'kody-runtime',
				config: 'packages/runtime-worker/wrangler-production.generated.json',
			},
			secretsFile,
		),
	).toEqual([
		'secret',
		'bulk',
		secretsFile,
		'--name',
		'kody-runtime',
		'--config',
		'packages/runtime-worker/wrangler-production.generated.json',
	])

	expect(
		buildWranglerSecretBulkFlags(
			{
				...baseOptions,
				env: 'production',
				config: 'packages/worker/wrangler-production.generated.json',
			},
			secretsFile,
		),
	).toEqual([
		'secret',
		'bulk',
		secretsFile,
		'--env',
		'production',
		'--config',
		'packages/worker/wrangler-production.generated.json',
	])
})

test('versioned secrets stage bindings without deploying pending code', () => {
	expect(
		buildWranglerSecretBulkFlags(
			{ ...baseOptions, versioned: true, env: '', name: 'kody-platform' },
			'/tmp/secrets.env',
		),
	).toEqual([
		'versions',
		'secret',
		'bulk',
		'/tmp/secrets.env',
		'--name',
		'kody-platform',
	])
})

test('secret bulk rejects --env with --name so it cannot target name-env', () => {
	const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
		throw new Error('process.exit called')
	}) as never)
	consoleError.mockImplementation(() => {})
	try {
		expect(() =>
			buildWranglerSecretBulkFlags(
				{
					...baseOptions,
					env: 'production',
					name: 'kody-runtime',
				},
				'/tmp/wrangler-secrets.env',
			),
		).toThrow('process.exit called')
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining('kody-runtime-production'),
		)
	} finally {
		exitSpy.mockRestore()
	}
})

test('secret bulk retries a Cloudflare 503 then fails fast on real errors', async () => {
	const secretBulk503 = {
		exitCode: 1,
		output: [
			'🚨 Secrets failed to upload',
			'',
			'Received a malformed response from the API',
			'',
			'  upstream connect error or disconnect/reset before headers. reset reason: connection termination',
			'  PATCH /accounts/acct/workers/scripts/kody-runtime/secrets-bulk -> 503 Service Unavailable',
		].join('\n'),
	}
	const upload = async (
		results: Array<{ exitCode: number; output: string }>,
	) => {
		let calls = 0
		const delays: Array<number> = []
		const retries: Array<number> = []
		const final = await retrySecretBulkUpload(
			async () => {
				const next = results[Math.min(calls, results.length - 1)]
				calls += 1
				if (!next) throw new Error('missing upload fixture')
				return next
			},
			{
				attempts: 3,
				baseDelayMs: 25,
				sleep: async (ms) => {
					delays.push(ms)
				},
				onRetry: ({ attempt }) => {
					retries.push(attempt)
				},
			},
		)
		return { ...final, calls, delays, retries }
	}

	expect(
		await upload([secretBulk503, { exitCode: 0, output: 'Uploaded' }]),
	).toEqual({
		exitCode: 0,
		output: 'Uploaded',
		calls: 2,
		delays: [25],
		retries: [1],
	})
	expect(await upload([secretBulk503])).toMatchObject({ exitCode: 1, calls: 3 })
	expect(
		await upload([
			{ exitCode: 1, output: 'Authentication error [code: 9109]' },
		]),
	).toMatchObject({ exitCode: 1, calls: 1, delays: [], retries: [] })
})

test('secret bulk output includes stderr that arrives after exit', async () => {
	const stdout = new PassThrough()
	const stderr = new PassThrough()
	const proc = Object.assign(new EventEmitter(), { stdout, stderr })
	const resultPromise = collectSpawnedProcessOutput(proc)

	proc.emit('exit', 1)
	stderr.write(
		'PATCH /accounts/acct/workers/scripts/kody-runtime/secrets-bulk -> 503 Service Unavailable\n',
	)
	stdout.end()
	stderr.end()
	proc.emit('close', 1)

	const result = await resultPromise
	expect(result.exitCode).toBe(1)
	expect(result.output).toContain('secrets-bulk -> 503 Service Unavailable')
})
