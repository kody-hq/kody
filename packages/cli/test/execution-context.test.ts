import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	ecpRunHeader,
	ecpSignatureHeader,
	ed25519JwkThumbprint,
	importEd25519PublicKey,
	parseEcpSignatureHeader,
	verifyEcpHttpSignature,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import {
	generateContextKey,
	importContextKey,
	registerContext,
} from '../src/execution-context/client.js'
import { runExecutionContextCommand } from '../src/execution-context/commands.js'
import { runScopedFetch } from '../src/execution-context/daemon.js'
import {
	decryptPrivateKey,
	encryptPrivateKey,
	resolveWrappingKey,
} from '../src/execution-context/keystore.js'

test('context key round trips through passphrase and keyring wrapping', async () => {
	const { privateKeyJwk } = await generateContextKey()
	const passphrase = resolveWrappingKey({
		ecid: 'ec_test',
		create: true,
		env: { KODY_CONTEXT_KEY_PASSPHRASE: 'correct horse battery staple' },
	})
	const file = encryptPrivateKey(privateKeyJwk, passphrase)
	assert.ok(!JSON.stringify(file).includes(privateKeyJwk.d))
	assert.deepEqual(decryptPrivateKey(file, passphrase), privateKeyJwk)
	const wrong = resolveWrappingKey({
		ecid: 'ec_test',
		create: true,
		env: { KODY_CONTEXT_KEY_PASSPHRASE: 'wrong' },
	})
	assert.throws(() => decryptPrivateKey(file, wrong), /Could not decrypt/)

	let stored: string | null = null
	const keyring = resolveWrappingKey({
		ecid: 'ec_test',
		create: true,
		env: {},
		keyringFactory: () => ({
			getPassword: () => stored,
			setPassword: (value) => {
				stored = value
			},
		}),
	})
	const keyringFile = encryptPrivateKey(privateKeyJwk, keyring)
	assert.deepEqual(decryptPrivateKey(keyringFile, keyring), privateKeyJwk)
})

test('registering with a pre-PR 2 login prints the exact kody login command', async () => {
	const { publicKeyJwk, privateKeyJwk } = await generateContextKey()
	const fetchFn = (async () =>
		Response.json(
			{
				error: {
					code: 'insufficient_scope',
					message:
						'Your Kody login predates execution context permissions, so it cannot register a machine.',
				},
			},
			{ status: 403 },
		)) as typeof fetch
	await assert.rejects(
		registerContext({
			apiUrl: 'https://api.kody.test',
			token: 'kody_at_test',
			name: 'my-machine',
			publicKeyJwk,
			privateKey: await importContextKey(privateKeyJwk),
			thumbprint: await ed25519JwkThumbprint(publicKeyJwk),
			capabilities: {},
			client: { name: 'kody-cli', version: '0.0.0' },
			fetchFn,
		}),
		(error: Error) => {
			assert.match(error.message, /Run `kody login` again/)
			assert.match(error.message, /kody context register/)
			return true
		},
	)
})

test('run-scoped fetch signs Kody API calls and never sends the bearer token', async () => {
	const { publicKeyJwk, privateKeyJwk } = await generateContextKey()
	const seen: Array<Request> = []
	const scoped = runScopedFetch({
		apiUrl: 'https://api.kody.test',
		ecid: 'ec_test',
		runId: 'run_1',
		privateKey: await importContextKey(privateKeyJwk),
		fetchFn: (async (
			resource: Parameters<typeof fetch>[0],
			init?: RequestInit,
		) => {
			seen.push(new Request(resource, init))
			return new Response('ok')
		}) as typeof fetch,
	})
	await scoped('https://api.kody.test/v1/capability-proxy/call?x=1', {
		method: 'POST',
		headers: {
			authorization: 'Bearer secret',
			'content-type': 'application/json',
		},
		body: '{"a":1}',
	})
	await scoped('https://example.test/data', {
		headers: { authorization: 'Bearer other' },
	})
	const [api, other] = seen
	assert.equal(api!.headers.get('authorization'), null)
	assert.equal(api!.headers.get(ecpRunHeader), 'run_1')
	const signature = parseEcpSignatureHeader(
		api!.headers.get(ecpSignatureHeader),
	)
	assert.ok(signature)
	assert.equal(
		await verifyEcpHttpSignature({
			signature: signature!,
			method: 'POST',
			pathAndQuery: '/v1/capability-proxy/call?x=1',
			body: '{"a":1}',
			publicKey: await importEd25519PublicKey(publicKeyJwk),
		}),
		'ok',
	)
	assert.equal(other!.headers.get('authorization'), 'Bearer other')
	assert.equal(other!.headers.get(ecpSignatureHeader), null)
})

test('kody chain show and add read the chain out of the API response', async () => {
	const chain = {
		entries: [{ kind: 'cloud' }],
		strict: false,
		updatedAt: '2026-01-01T00:00:00.000Z',
		updatedBy: null,
	}
	const puts: Array<unknown> = []
	const fetchFn = (async (url: URL | string, init?: RequestInit) => {
		const path = new URL(url).pathname
		if (path === '/v1/execution-contexts') {
			return Response.json({
				contexts: [
					{ id: 'ec_box', name: 'box', status: 'online', usable: true },
				],
			})
		}
		if (init?.method === 'PUT') {
			const body = JSON.parse(String(init.body)) as {
				entries: Array<{ kind: string; id?: string }>
			}
			puts.push(body)
			return Response.json({
				chain: { ...chain, entries: [...body.entries], strict: false },
			})
		}
		return Response.json({ chain })
	}) as typeof fetch
	const run = async (positionals: Array<string>) => {
		let text = ''
		await runExecutionContextCommand({
			command: 'chain',
			positionals,
			values: {},
			apiUrl: 'https://api.kody.test',
			token: async () => 'kody_at_test',
			clientVersion: '0.0.0',
			write: (chunk) => {
				text += chunk
			},
			fetchFn,
		})
		return text
	}
	assert.equal(await run(['show']), '1. Kody cloud (always last)\n')
	assert.equal(
		await run(['add', 'box']),
		'1. ec_box\n2. Kody cloud (always last)\n',
	)
	assert.deepEqual(puts, [
		{
			entries: [{ kind: 'context', id: 'ec_box' }, { kind: 'cloud' }],
			strict: false,
			ifMatch: '2026-01-01T00:00:00.000Z',
		},
	])
})
