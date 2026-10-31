import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	ecpRootPublicKeys,
	ecpTestRootPublicKey,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import {
	fetchServerKeys,
	serverKeyRootsFor,
} from '../src/execution-context/client.js'

const vectorsDir = join(
	import.meta.dirname,
	'..',
	'..',
	'shared',
	'src',
	'execution-context-protocol',
	'vectors',
)
const testKeySet = JSON.parse(
	readFileSync(join(vectorsDir, 'signing.json'), 'utf8'),
).keySet.document as { k: string }
const testKeys = JSON.parse(
	readFileSync(join(vectorsDir, 'test-keys.json'), 'utf8'),
)

const trust = { KODY_ECP_TRUST_TEST_ROOT: '1' }
const serve: typeof fetch = async () => Response.json(testKeySet)
const fetchKeys = (apiUrl: string, env: NodeJS.ProcessEnv) =>
	fetchServerKeys({ apiUrl, env, fetchFn: serve })

test('the test root is the committed test-keys.json root, never a pinned root', () => {
	assert.equal(testKeySet.k, 'root-test-1')
	assert.deepEqual(ecpTestRootPublicKey, {
		kid: testKeys.root.kid,
		x: testKeys.root.privateKeyJwk.x,
	})
	assert.ok(!ecpRootPublicKeys.some((root) => root.kid === 'root-test-1'))
})

test('KODY_ECP_TRUST_TEST_ROOT=1 trusts the test root for workers.dev previews and localhost', async () => {
	for (const apiUrl of [
		'https://kody-pr-1-api.example.workers.dev',
		'http://localhost:8787',
		'https://LOCALHOST:3000',
	]) {
		const keys = await fetchKeys(apiUrl, trust)
		assert.deepEqual(
			keys.map((key) => key.kid),
			['ecp-frame-test-1'],
			apiUrl,
		)
	}
})

test('the test root is ignored for kody.codes and every other host, even with the variable set', async () => {
	for (const apiUrl of [
		'https://kody.codes',
		'https://api.kody.codes',
		'https://kody.codes.workers.dev.example.com',
		'https://workers.dev',
		'http://kody-pr-1-api.example.workers.dev',
		'http://127.0.0.1:8787',
		'https://evil.localhost.example.com',
	]) {
		assert.deepEqual(
			serverKeyRootsFor(apiUrl, trust),
			ecpRootPublicKeys,
			apiUrl,
		)
		await assert.rejects(
			fetchKeys(apiUrl, trust),
			/failed root signature verification/,
			apiUrl,
		)
	}
})

test('the test root is ignored unless KODY_ECP_TRUST_TEST_ROOT is exactly 1', async () => {
	const preview = 'https://kody-pr-1-api.example.workers.dev'
	for (const env of [
		{},
		{ KODY_ECP_TRUST_TEST_ROOT: '' },
		{ KODY_ECP_TRUST_TEST_ROOT: '0' },
		{ KODY_ECP_TRUST_TEST_ROOT: 'true' },
	]) {
		assert.deepEqual(serverKeyRootsFor(preview, env), ecpRootPublicKeys)
		await assert.rejects(
			fetchKeys(preview, env),
			/failed root signature verification/,
		)
	}
})
