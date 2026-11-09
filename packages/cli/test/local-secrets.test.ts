import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { deviceTokenName } from '../src/auth.ts'
import { runCli } from '../src/cli.ts'
import {
	envNameForSecret,
	fetchLocalSecrets,
	formatLocalSecrets,
	parseRunSecretFlags,
	revealRequiredMessage,
	runWithSecrets,
	type SpawnFn,
} from '../src/local-secrets.ts'
import { assertApiOperationAllowed } from '../src/open-api-client.ts'

const fixtureValue = 'synthetic-fixture-value'

test('env names come from secret names, and an explicit name wins', () => {
	assert.equal(envNameForSecret('databaseUrl'), 'DATABASE_URL')
	assert.equal(envNameForSecret('githubAPIToken'), 'GITHUB_API_TOKEN')
	assert.equal(envNameForSecret('stripe-key'), 'STRIPE_KEY')
	assert.equal(envNameForSecret('secret/doppler:prod/API_KEY'), 'API_KEY')
	assert.deepEqual(parseRunSecretFlags(['databaseUrl', 'databaseUrl=PG_URL']), [
		{ name: 'databaseUrl', envName: 'DATABASE_URL' },
		{ name: 'databaseUrl', envName: 'PG_URL' },
	])
	assert.throws(() => parseRunSecretFlags(['a=1BAD']), /not a valid/)
	assert.throws(
		() => parseRunSecretFlags(['apiKey', 'other=API_KEY']),
		/both set/,
	)
})

test('formats: raw prints one value, env quotes for a shell, json is one object', () => {
	const one = [{ name: 'databaseUrl', value: fixtureValue }]
	assert.equal(formatLocalSecrets(one, 'raw'), fixtureValue)
	assert.equal(
		formatLocalSecrets([{ name: 'apiKey', value: "it's" }], 'env'),
		"API_KEY='it'\\''s'\n",
	)
	assert.deepEqual(JSON.parse(formatLocalSecrets(one, 'json')), {
		databaseUrl: fixtureValue,
	})
	assert.throws(() => formatLocalSecrets([...one, ...one], 'raw'), /one secret/)
})

test('kody secret get refuses an interactive terminal without --reveal before any request', async () => {
	let stderr = ''
	const code = await runCli(
		['secret', 'get', 'databaseUrl', '--token', 'kody_at_test'],
		{
			stdout: () => assert.fail('nothing prints'),
			stderr: (text) => {
				stderr += text
			},
			isTTY: true,
		},
	)
	assert.equal(code, 1)
	assert.match(stderr, new RegExp(revealRequiredMessage.slice(0, 40)))
})

test('fetchLocalSecrets posts names and command, and a refusal keeps the approval link', async () => {
	const seen: Array<unknown> = []
	const ok: typeof fetch = async (input, init) => {
		const request = new Request(input, init)
		assert.equal(new URL(request.url).pathname, '/v1/secrets/local-read')
		seen.push(await request.json())
		return Response.json({
			secrets: [{ name: 'databaseUrl', value: fixtureValue }],
		})
	}
	const secrets = await fetchLocalSecrets({
		token: 'kody_at_test',
		apiUrl: 'https://api.kody.test',
		fetchFn: ok,
		names: ['databaseUrl'],
		command: 'get',
	})
	assert.deepEqual(seen, [{ names: ['databaseUrl'], command: 'get' }])
	assert.equal(secrets[0]?.value === fixtureValue, true)
	const link = 'https://kody.test/@acme/-/credentials/cred1/local-reads'
	const refused: typeof fetch = async () =>
		Response.json(
			{
				error: {
					code: 'insufficient_scope',
					message: `Local reads are off for the secret "databaseUrl". Turn on local reads: ${link}`,
				},
			},
			{ status: 403 },
		)
	await assert.rejects(
		fetchLocalSecrets({
			token: 'kody_at_test',
			apiUrl: 'https://api.kody.test',
			fetchFn: refused,
			names: ['databaseUrl'],
			command: 'run',
		}),
		(error: Error) => error.message.includes(link),
	)
})

test('runWithSecrets adds the values to the child env and returns its exit code', async () => {
	let seenEnv: NodeJS.ProcessEnv | undefined
	let seenArgs: ReadonlyArray<string> = []
	const spawnFn: SpawnFn = (command, args, options) => {
		seenArgs = [command, ...args]
		seenEnv = options.env
		const child = new EventEmitter() as ReturnType<SpawnFn>
		Object.assign(child, { kill: () => true })
		setImmediate(() => child.emit('exit', 3, null))
		return child
	}
	const code = await runWithSecrets({
		argv: ['node', 'app.js'],
		env: { DATABASE_URL: fixtureValue },
		spawnFn,
		baseEnv: { PATH: '/bin' },
	})
	assert.equal(code, 3)
	assert.deepEqual(seenArgs, ['node', 'app.js'])
	assert.equal(seenEnv?.DATABASE_URL === fixtureValue, true)
	assert.equal(seenEnv?.PATH, '/bin')
})

test('kody api refuses secretLocalRead, and login names the device', () => {
	assert.throws(
		() => assertApiOperationAllowed('secretLocalRead'),
		/kody secret get/,
	)
	assert.equal(
		deviceTokenName('my laptop.local'),
		'kody-cli on my-laptop.local',
	)
	assert.equal(deviceTokenName('  '), 'kody-cli')
})
