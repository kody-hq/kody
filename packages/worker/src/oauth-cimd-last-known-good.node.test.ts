import { expect, test } from 'vitest'
import {
	cimdFallbackDecision,
	cimdLastKnownGoodKey,
	cimdLastKnownGoodTtlSeconds,
	classifyCimdFetchError,
	isCimdClientIdUrl,
} from '#worker/oauth-cimd-last-known-good.ts'
import {
	builtInFallbackCimdDocument,
	knownCimdClientKind,
	normalizeCimdClientId,
	pinnedCimdDocument,
} from '#worker/oauth-known-cimd-clients.ts'

test('isCimdClientIdUrl matches HTTPS client ids with a path', () => {
	expect(
		isCimdClientIdUrl('https://vscode.dev/oauth/client-metadata.json'),
	).toBe(true)
	expect(isCimdClientIdUrl('https://vscode.dev/')).toBe(false)
	expect(isCimdClientIdUrl('http://vscode.dev/client.json')).toBe(false)
	expect(isCimdClientIdUrl('https://user:pw@vscode.dev/client.json')).toBe(
		false,
	)
	expect(isCimdClientIdUrl('https://vscode.dev/client.json#x')).toBe(false)
	expect(isCimdClientIdUrl('FDUN-3EVGH5LdgdI')).toBe(false)
})

test('cimdLastKnownGoodKey hashes the client id under the derived cache prefix', async () => {
	const key = await cimdLastKnownGoodKey(
		'https://vscode.dev/oauth/client-metadata.json',
	)
	expect(key).toMatch(
		/^derived-cache:v1:oauth-cimd-last-known-good:[0-9a-f]{64}$/,
	)
	expect(key).not.toContain('vscode')
})

test('last known good copies live for 14 days', () => {
	expect(cimdLastKnownGoodTtlSeconds).toBe(14 * 24 * 60 * 60)
})

test('classifyCimdFetchError reads the provider status and messages', () => {
	expect(
		classifyCimdFetchError(
			Object.assign(new Error('Failed to fetch client metadata: HTTP 404'), {
				status: 404,
			}),
		),
	).toEqual({ type: 'http', status: 404 })
	expect(
		classifyCimdFetchError(
			new Error('Failed to fetch client metadata: HTTP 503'),
		),
	).toEqual({ type: 'http', status: 503 })
	expect(
		classifyCimdFetchError(
			new Error('Client metadata fetch timed out after 10000ms'),
		),
	).toEqual({ type: 'timeout' })
	expect(classifyCimdFetchError(new TypeError('fetch failed'))).toEqual({
		type: 'network_error',
	})
	expect(
		classifyCimdFetchError(
			new Error('Client metadata response is not valid JSON'),
		),
	).toEqual({ type: 'invalid_document' })
})

test('a 404 falls back only for hosts known to refuse Worker fetches', () => {
	const chatgpt = 'https://chatgpt.com/oauth/abc/client.json'
	const other = 'https://vscode.dev/oauth/client-metadata.json'
	for (const status of [401, 403, 404]) {
		expect(
			cimdFallbackDecision({
				clientId: chatgpt,
				failure: { type: 'http', status },
			}),
		).toEqual({ allowed: true, reason: 'worker_blocked_host' })
		expect(
			cimdFallbackDecision({
				clientId: other,
				failure: { type: 'http', status },
			}).allowed,
		).toBe(false)
	}
	// Explicit withdrawal and bad content never fall back, even for chatgpt.com.
	expect(
		cimdFallbackDecision({
			clientId: chatgpt,
			failure: { type: 'http', status: 410 },
		}).allowed,
	).toBe(false)
	expect(
		cimdFallbackDecision({
			clientId: chatgpt,
			failure: { type: 'invalid_document' },
		}).allowed,
	).toBe(false)
	// Outages fall back for every host.
	for (const failure of [
		{ type: 'timeout' },
		{ type: 'network_error' },
		{ type: 'http', status: 429 },
		{ type: 'http', status: 502 },
	] as const) {
		expect(cimdFallbackDecision({ clientId: other, failure })).toEqual({
			allowed: true,
			reason: 'outage',
		})
	}
})

test('Codex documents are pinned, ChatGPT is a live-first fallback', () => {
	const stable = 'https://chatgpt.com/oauth/codex/client.json'
	expect(pinnedCimdDocument(stable)).toMatchObject({
		client_id: stable,
		client_name: 'Codex',
		redirect_uris: ['http://127.0.0.1/callback', 'http://localhost/callback'],
		token_endpoint_auth_method: 'none',
	})
	const callback = 'https://chatgpt.com/oauth/codex/Ab_9-x/client.json'
	expect(pinnedCimdDocument(callback)).toMatchObject({
		client_id: callback,
		redirect_uris: [
			'http://127.0.0.1/callback/Ab_9-x',
			'http://localhost/callback/Ab_9-x',
		],
	})
	for (const notPinned of [
		'https://chatgpt.com/oauth/client.json',
		'https://chatgpt.com/oauth/codex/a.b/client.json',
		'https://chatgpt.com/oauth/codex/x/y/client.json',
		'https://evil.example/oauth/codex/client.json',
		'https://chatgpt.com.evil.example/oauth/codex/client.json',
	]) {
		expect(pinnedCimdDocument(notPinned)).toBeUndefined()
	}
	expect(
		builtInFallbackCimdDocument('https://chatgpt.com/oauth/client.json'),
	).toMatchObject({ client_name: 'ChatGPT' })
	expect(builtInFallbackCimdDocument(stable)).toBeUndefined()
	expect(knownCimdClientKind(stable)).toBe('codex')
	expect(knownCimdClientKind(callback)).toBe('codex')
	expect(knownCimdClientKind('https://chatgpt.com/oauth/client.json')).toBe(
		'chatgpt',
	)
	expect(knownCimdClientKind('https://vscode.dev/x.json')).toBe('other')
})

test('normalizeCimdClientId hides per-install ids', () => {
	expect(
		normalizeCimdClientId('https://chatgpt.com/oauth/codex/Ab12cd/client.json'),
	).toEqual({
		host: 'chatgpt.com',
		path: '/oauth/codex/<callback_id>/client.json',
	})
	expect(
		normalizeCimdClientId('https://chatgpt.com/oauth/vG3-MLZWUV83/client.json'),
	).toEqual({ host: 'chatgpt.com', path: '/oauth/<id>/client.json' })
	expect(
		normalizeCimdClientId('https://vscode.dev/oauth/client-metadata.json'),
	).toEqual({ host: 'vscode.dev', path: '/oauth/client-metadata.json' })
})
