import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { http, HttpResponse } from 'msw'
import { test } from 'node:test'
import {
	installMockFetchShimModules,
	mockGatewayFetchShimModuleName,
} from '../src/mock/install-mock-fetch-shim.js'
import { loadPackageMocks } from '../src/mock/load-package-mocks.js'
import {
	createMockFetchGateway,
	dispatchMockGatewayFetch,
	hostMatchesPassthrough,
	parsePassthroughHosts,
} from '../src/mock/mock-fetch-gateway.js'
import { createMockGatewayFetchShimSource } from '../src/mock/mock-gateway-fetch-shim.js'
import { StructuredCliError } from '../src/structured-error.js'

test('parsePassthroughHosts splits and lowercases', () => {
	assert.deepEqual(parsePassthroughHosts('API.Example.com, *.github.com, '), [
		'api.example.com',
		'*.github.com',
	])
	assert.deepEqual(parsePassthroughHosts(undefined), [])
})

test('hostMatchesPassthrough supports exact and wildcard hosts', () => {
	assert.equal(
		hostMatchesPassthrough('api.example.com', ['api.example.com']),
		true,
	)
	assert.equal(hostMatchesPassthrough('foo.github.com', ['*.github.com']), true)
	assert.equal(hostMatchesPassthrough('github.com', ['*.github.com']), false)
	assert.equal(hostMatchesPassthrough('evil.com', ['api.example.com']), false)
})

test('dispatchMockGatewayFetch returns MSW handler responses', async () => {
	const handlers = [
		http.get('https://api.example.com/v1/hello', () =>
			HttpResponse.json({ ok: true }, { status: 200 }),
		),
	]
	const result = await dispatchMockGatewayFetch({
		handlers,
		passthroughHosts: [],
		allowPrivateNetwork: false,
		request: {
			url: 'https://api.example.com/v1/hello',
			method: 'GET',
			headers: {},
		},
	})
	assert.equal(result.status, 200)
	const body = JSON.parse(
		Buffer.from(result.bodyBase64, 'base64').toString('utf8'),
	) as {
		ok: boolean
	}
	assert.equal(body.ok, true)
})

test('dispatchMockGatewayFetch fails closed with unmocked_request + stub', async () => {
	await assert.rejects(
		() =>
			dispatchMockGatewayFetch({
				handlers: [],
				passthroughHosts: [],
				allowPrivateNetwork: false,
				request: {
					url: 'https://api.example.com/v1/missing',
					method: 'POST',
				},
			}),
		(error: unknown) => {
			assert.ok(error instanceof StructuredCliError)
			assert.equal(error.code, 'unmocked_request')
			assert.match(error.message, /Unmocked POST/)
			assert.match(error.fix ?? '', /http\.post/)
			assert.match(error.fix ?? '', /api\.example\.com\/v1\/missing/)
			return true
		},
	)
})

test('passthrough hosts use real network without credential headers', async () => {
	const seen: Array<{ url: string; authorization: string | null }> = []
	const result = await dispatchMockGatewayFetch({
		handlers: [],
		passthroughHosts: ['example.com'],
		allowPrivateNetwork: false,
		request: {
			url: 'https://example.com/ok',
			method: 'GET',
			headers: {
				authorization: 'Bearer should-not-forward-as-secret',
				'x-kody-credential-client': 'opaque-handle',
				accept: 'application/json',
			},
		},
		fetchFn: async (input, init) => {
			const headers = new Headers(init?.headers)
			seen.push({
				url: String(input),
				authorization: headers.get('authorization'),
			})
			assert.equal(headers.get('x-kody-credential-client'), null)
			return new Response(JSON.stringify({ passthrough: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		},
	})
	assert.equal(seen.length, 1)
	assert.equal(seen[0]?.url, 'https://example.com/ok')
	// Authorization from the package is forwarded as a normal header (not a
	// secret placement); the opaque credential handle is stripped.
	assert.equal(seen[0]?.authorization, 'Bearer should-not-forward-as-secret')
	const body = JSON.parse(
		Buffer.from(result.bodyBase64, 'base64').toString('utf8'),
	) as {
		passthrough: boolean
	}
	assert.equal(body.passthrough, true)
})

test('loadPackageMocks reads handlers from .kody/mocks.ts', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-mocks-pkg-'))
	try {
		await mkdir(join(root, '.kody'), { recursive: true })
		await writeFile(
			join(root, '.kody/mocks.ts'),
			`
import { http, HttpResponse } from 'msw'
export const handlers = [
  http.get('https://api.example.com/ping', () => HttpResponse.json({ pong: true })),
]
`,
		)
		const loaded = await loadPackageMocks(root)
		assert.ok(loaded)
		assert.equal(loaded.handlers.length, 1)
		const gateway = createMockFetchGateway({ handlers: loaded.handlers })
		const result = await gateway.handle({
			request: { url: 'https://api.example.com/ping', method: 'GET' },
		})
		assert.equal(result.status, 200)
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 10 })
	}
})

test('loadPackageMocks returns null when the file is missing', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-mocks-miss-'))
	try {
		assert.equal(await loadPackageMocks(root), null)
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 10 })
	}
})

test('mock gateway fetch shim uses a flat module name (no path-join)', async () => {
	assert.equal(mockGatewayFetchShimModuleName.includes('/'), false)
	const source = createMockGatewayFetchShimSource()
	assert.match(source, /from "kody:runtime"/)
	assert.doesNotMatch(source, /from "\.\.\/kody:runtime"/)

	const root = await mkdtemp(join(tmpdir(), 'kody-mock-shim-'))
	try {
		const installed = await installMockFetchShimModules({
			workDir: root,
			packageModules: [
				{ name: '.__kody_virtual__/runtime.js', file: 'pkg-0.js' },
				{ name: 'kody:@demo/pkg', file: 'pkg-1.js' },
			],
		})
		assert.ok(
			installed.packageModules.some(
				(m) => m.name === '.__kody_virtual__/runtime.js',
			),
		)
		assert.ok(
			installed.packageModules.some(
				(m) => m.name === mockGatewayFetchShimModuleName,
			),
		)
		assert.deepEqual(installed.sideEffectModules, [
			'.__kody_virtual__/runtime.js',
			mockGatewayFetchShimModuleName,
		])
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 10 })
	}
})
