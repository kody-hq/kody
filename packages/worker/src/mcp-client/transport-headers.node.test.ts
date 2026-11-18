import { expect, test } from 'vitest'
import {
	splitPersistedStaticHeaders,
	withStaticTransportHeaders,
} from './transport-headers.ts'

type AutoTransport = {
	type: 'auto'
	headers?: HeadersInit
	requestInit?: RequestInit
}

test('static Authorization headers reach requestInit so transports send them', () => {
	const transport = withStaticTransportHeaders<AutoTransport>({
		type: 'auto',
		headers: { Authorization: 'Bearer secret-token' },
	})

	// `headers` alone is dropped by StreamableHTTPClientTransport /
	// SSEClientTransport; only `requestInit` is merged into outbound fetches.
	// Keys come back lowercased because they round-trip through `Headers`.
	expect(transport.requestInit?.headers).toEqual({
		authorization: 'Bearer secret-token',
	})
	expect(transport.headers).toEqual({ Authorization: 'Bearer secret-token' })
	expect(transport.type).toBe('auto')

	const withoutHeaders = withStaticTransportHeaders<AutoTransport>({
		type: 'auto',
	})
	expect(withoutHeaders).toEqual({ type: 'auto' })
	expect(withoutHeaders.requestInit).toBeUndefined()

	const withExistingRequestInit = withStaticTransportHeaders({
		headers: { Authorization: 'Bearer stored', 'X-From-Headers': 'yes' },
		requestInit: {
			redirect: 'follow' as const,
			headers: { Authorization: 'Bearer explicit' },
		},
	})
	expect(withExistingRequestInit.requestInit?.redirect).toBe('follow')
	expect(withExistingRequestInit.requestInit?.headers).toEqual({
		authorization: 'Bearer explicit',
		'x-from-headers': 'yes',
	})
})

test('splitPersistedStaticHeaders strips stored headers and returns them', () => {
	const stored = JSON.stringify({
		client: { versionNegotiation: { mode: 'auto' } },
		transport: {
			type: 'auto',
			headers: { Authorization: 'Bearer stored' },
			requestInit: { redirect: 'follow', headers: { 'X-Extra': 'yes' } },
		},
	})
	const split = splitPersistedStaticHeaders(stored)
	expect(split.headers).toEqual({
		authorization: 'Bearer stored',
		'x-extra': 'yes',
	})
	expect(split.serverOptions).not.toContain('Bearer stored')
	expect(JSON.parse(split.serverOptions!)).toEqual({
		client: { versionNegotiation: { mode: 'auto' } },
		transport: { type: 'auto', requestInit: { redirect: 'follow' } },
	})

	const plain = JSON.stringify({ transport: { type: 'auto' } })
	expect(splitPersistedStaticHeaders(plain)).toEqual({
		serverOptions: plain,
		headers: null,
	})
	expect(splitPersistedStaticHeaders(null)).toEqual({
		serverOptions: null,
		headers: null,
	})
	expect(splitPersistedStaticHeaders('not json')).toEqual({
		serverOptions: 'not json',
		headers: null,
	})
})
