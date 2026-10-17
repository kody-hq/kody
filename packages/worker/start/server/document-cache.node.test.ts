import type * as StartServer from '@tanstack/react-start/server'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	context: {
		nonce: 'requestnonce',
		documentFailure: undefined as { status: 403 | 404 | 500 } | undefined,
	},
	headers: new Headers(),
	policy: 'marketing' as 'marketing' | 'visibility' | undefined,
	pending: [] as Promise<unknown>[],
}))
vi.mock('@tanstack/react-start', () => ({
	getGlobalStartContext: () => state.context,
	getRouterInstance: async () => {
		const route = {
			options: { staticData: { anonymousDocumentCache: state.policy } },
		}
		return { getMatchedRoutes: () => [[route], {}, route] }
	},
}))
vi.mock('@tanstack/react-start/server', async (importOriginal) => {
	const original = await importOriginal<typeof StartServer>()
	return {
		...original,
		getResponseHeaders: () => state.headers,
		transferResponseBodyOwnership: vi.fn(
			original.transferResponseBodyOwnership,
		),
	}
})
vi.mock('./request-env.ts', () => ({
	getStartRequestEnv: () => ({
		APP_BASE_URL: 'https://kody.test',
		CF_VERSION_METADATA: { id: 'test-version' },
	}),
}))
vi.mock('../../src/deferred-work.ts', () => ({
	deferWork: (_label: string, work: () => Promise<unknown>) => {
		const promise = work()
		state.pending.push(promise)
		return promise
	},
}))
import { serveNativeDocument } from './document-cache.ts'
import { transferResponseBodyOwnership } from '@tanstack/react-start/server'
const stored = new Map<string, Response>()
beforeEach(() => {
	stored.clear()
	vi.mocked(transferResponseBodyOwnership).mockClear()
	state.headers = new Headers()
	state.policy = 'marketing'
	state.context = { nonce: 'requestnonce', documentFailure: undefined }
	state.pending = []
	vi.stubGlobal('caches', {
		default: {
			match: async (key: Request) => stored.get(key.url)?.clone(),
			put: async (key: Request, response: Response) => {
				stored.set(key.url, response.clone())
			},
		},
	})
})
afterEach(() => vi.unstubAllGlobals())
const document = () =>
	new Response('index', { headers: { 'Content-Type': 'text/plain' } })
test('native middleware secures its response and serves GET/HEAD hits before loaders', async () => {
	const request = new Request('https://kody.test/llms.txt')
	const source = document()
	const next = vi.fn(async () => source)
	const miss = await serveNativeDocument(request, next)
	expect(transferResponseBodyOwnership).toHaveBeenCalledExactlyOnceWith(
		source,
		miss,
	)
	expect(miss.headers.get('X-Kody-Cache')).toBe('MISS')
	expect(miss.headers.get('Content-Security-Policy')).toContain(
		"'nonce-requestnonce'",
	)
	expect(await miss.text()).toBe('index')
	await Promise.all(state.pending)
	state.context.nonce = 'nextrequestnonce'
	const hit = await serveNativeDocument(request, next)
	expect(hit.headers.get('X-Kody-Cache')).toBe('HIT')
	expect(await hit.text()).toBe('index')
	const head = await serveNativeDocument(
		new Request(request.url, { method: 'HEAD' }),
		next,
	)
	expect(head.headers.get('X-Kody-Cache')).toBe('HIT')
	expect(await head.text()).toBe('')
	expect(next).toHaveBeenCalledTimes(1)
	// Cache hits never acquire an SSR stream and HEAD never claims a null body.
	expect(transferResponseBodyOwnership).toHaveBeenCalledTimes(1)
})
test('native middleware never stores pending Start cookies or error pages', async () => {
	const response = await serveNativeDocument(
		new Request('https://kody.test/login'),
		async () => {
			// Start merges event cookies after route middleware, so storage must see them now.
			state.headers.append('Set-Cookie', 'kody_session=secret')
			return new Response('index', {
				headers: {
					'Content-Type': 'text/plain',
					'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
				},
			})
		},
	)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	await Promise.all(state.pending)
	expect(stored.size).toBe(0)
	state.headers = new Headers()
	const missing = await serveNativeDocument(
		new Request('https://kody.test/missing'),
		async () =>
			new Response('missing', {
				status: 404,
				headers: { 'Content-Type': 'text/html' },
			}),
	)
	expect(missing.status).toBe(404)
	await Promise.all(state.pending)
	expect(stored.size).toBe(0)
})
test('routes without explicit public policy and session requests always run the loader', async () => {
	const next = vi.fn(async () => document())
	state.policy = undefined
	await serveNativeDocument(new Request('https://kody.test/verify-email'), next)
	state.policy = 'marketing'
	await serveNativeDocument(
		new Request('https://kody.test/login', {
			headers: { Cookie: 'kody_session=secret' },
		}),
		next,
	)
	expect(next).toHaveBeenCalledTimes(2)
	await Promise.all(state.pending)
	expect(stored.size).toBe(0)
})
