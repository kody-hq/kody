import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
	readEdgeAuth,
	requestHeadersFor,
	makeSanitizer,
	deliveryHeaders,
} from './edge-auth.mjs'
const origin = 'https://private.example.test'
const auth = readEdgeAuth(
	JSON.stringify({
		[origin]: {
			'CF-Access-Client-Id': 'test-id',
			'CF-Access-Client-Secret': 'test-secret',
		},
	}),
)
test('Access tokens are origin scoped and never carried across redirects', () => {
	assert.equal(
		requestHeadersFor(origin + '/docs', {}, auth)['CF-Access-Client-Secret'],
		'test-secret',
	)
	const other = requestHeadersFor(
		'https://external.example.test/image',
		{
			'cf-access-client-secret': 'test-secret',
			Cookie: 'session=x',
			Accept: 'image/*',
		},
		auth,
	)
	assert.deepEqual(other, { Accept: 'image/*' })
})
test('configuration rejects non-origin keys and unsupported headers', () => {
	assert.throws(() => readEdgeAuth('{"https://private.example.test/path":{}}'))
	assert.throws(() => readEdgeAuth('{"http://private.example.test":{}}'))
	assert.throws(() =>
		readEdgeAuth('{"https://private.example.test":{"Cookie":"x"}}'),
	)
})
test('reports lose secret values and all raw header containers before writing', () => {
	const sanitize = makeSanitizer(auth)
	const report = sanitize({
		configSettings: { extraHeaders: { secret: 'test-secret' } },
		nested: ['value test-secret'],
		headers: { 'set-cookie': 'unknown-generated-cookie' },
	})
	assert.equal(JSON.stringify(report).includes('test-secret'), false)
	assert.equal(
		JSON.stringify(report).includes('unknown-generated-cookie'),
		false,
	)
})
test('delivery evidence only retains allowlisted response fields', () => {
	assert.deepEqual(
		deliveryHeaders({
			'set-cookie': 'secret',
			'content-encoding': 'br',
			'cf-cache-status': 'HIT',
		}),
		{ 'content-encoding': 'br', 'cf-cache-status': 'HIT' },
	)
})
