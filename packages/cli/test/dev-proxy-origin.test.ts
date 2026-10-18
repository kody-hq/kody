import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	buildDevProxyUpstreamHeaders,
	buildTrustedDevForwardUrl,
	buildTrustedDevPublicUrl,
	defaultLoopbackHostAliases,
	isAllowedDevHost,
	normalizeHostHeader,
	trustedDevHostFromHostedUrl,
	devPublicUrlHeader,
} from '../src/dev/dev-proxy-origin.js'
import { runSecretHeader } from '../src/local-runtime-source.js'
import { devRequestIdHeader } from '../src/dev/dev-protocol.js'

test('normalizeHostHeader lowercases and takes the first value', () => {
	assert.equal(normalizeHostHeader('127.0.0.1:4777'), '127.0.0.1:4777')
	assert.equal(normalizeHostHeader('LOCALHOST:4777'), 'localhost:4777')
	assert.equal(normalizeHostHeader('Evil.Example, other'), 'evil.example')
	assert.equal(normalizeHostHeader(undefined), null)
})

test('isAllowedDevHost accepts listen host and loopback aliases only', () => {
	assert.equal(
		isAllowedDevHost({
			incomingHost: '127.0.0.1:4777',
			trustedHost: '127.0.0.1:4777',
		}),
		true,
	)
	assert.equal(
		isAllowedDevHost({
			incomingHost: 'localhost:4777',
			trustedHost: '127.0.0.1:4777',
		}),
		true,
	)
	assert.equal(
		isAllowedDevHost({
			incomingHost: 'evil.example',
			trustedHost: '127.0.0.1:4777',
		}),
		false,
	)
	assert.equal(
		isAllowedDevHost({
			incomingHost: '127.0.0.1:9999',
			trustedHost: '127.0.0.1:4777',
		}),
		false,
	)
	assert.equal(
		isAllowedDevHost({
			incomingHost: 'dev.local:4777',
			trustedHost: '127.0.0.1:4777',
			aliases: ['dev.local:4777'],
		}),
		true,
	)
})

test('defaultLoopbackHostAliases covers localhost and ipv6 loopback', () => {
	assert.deepEqual(defaultLoopbackHostAliases('127.0.0.1:4777').sort(), [
		'[::1]:4777',
		'localhost:4777',
	])
})

test('buildTrustedDevPublicUrl uses hosted origin and mount-stripped path', () => {
	assert.equal(
		buildTrustedDevPublicUrl({
			hostedUrl: 'http://127.0.0.1:4777',
			restPath: '/form',
			search: '?n=1',
		}),
		'http://127.0.0.1:4777/form?n=1',
	)
	assert.equal(
		trustedDevHostFromHostedUrl('http://127.0.0.1:4777/'),
		'127.0.0.1:4777',
	)
})

test('buildTrustedDevPublicUrl keeps protocol-relative restPath on the hosted origin', () => {
	assert.equal(
		buildTrustedDevPublicUrl({
			hostedUrl: 'http://127.0.0.1:4777',
			restPath: '//evil.example/x',
			search: '?y=1',
		}),
		'http://127.0.0.1:4777//evil.example/x?y=1',
	)
	assert.equal(
		buildTrustedDevForwardUrl({
			baseUrl: 'http://127.0.0.1:8787',
			restPath: '//evil.example/x',
			search: '',
		}),
		'http://127.0.0.1:8787//evil.example/x',
	)
})

test('buildDevProxyUpstreamHeaders overwrites Host and strips forwarding spoofing', () => {
	const headers = buildDevProxyUpstreamHeaders({
		incoming: {
			host: 'evil.example',
			origin: 'http://127.0.0.1:4777',
			'x-forwarded-host': 'evil.example',
			'x-forwarded-proto': 'https',
			forwarded: 'host=evil.example',
			[devPublicUrlHeader]: 'http://evil.example/',
			[runSecretHeader]: 'stolen',
			'content-type': 'application/x-www-form-urlencoded',
		},
		trustedHost: '127.0.0.1:4777',
		publicUrl: 'http://127.0.0.1:4777/form',
		runSecret: 'real-secret',
		requestId: '9',
	})
	assert.equal(headers.host, '127.0.0.1:4777')
	assert.equal(headers[devPublicUrlHeader], 'http://127.0.0.1:4777/form')
	assert.equal(headers[runSecretHeader], 'real-secret')
	assert.equal(headers[devRequestIdHeader], '9')
	assert.equal(headers['x-forwarded-host'], undefined)
	assert.equal(headers['x-forwarded-proto'], undefined)
	assert.equal(headers.forwarded, undefined)
	assert.equal(headers['content-type'], 'application/x-www-form-urlencoded')
	assert.equal(headers.origin, 'http://127.0.0.1:4777')
})
