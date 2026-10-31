import { expect, test } from 'vitest'
import {
	applyPackageAppResponseRewrite,
	deferPackageAppResponseRewrite,
	runWithPackageAppResponseRewrite,
} from './package-app-response-rewrite.ts'

const prefix = '__kapp_0123456789ab_'
const domainScrub = {
	responseHostname: 'alice.kody.run',
	packageAppApexHostnames: ['kody.run'],
}

function appResponse(init: ResponseInit = {}, body: BodyInit | null = 'ok') {
	const response = new Response(body, init)
	response.headers.append(
		'Set-Cookie',
		`${prefix}session=1; Path=/; Domain=kody.run`,
	)
	response.headers.append('Set-Cookie', 'other=1; Path=/')
	response.headers.append('Set-Cookie', `${prefix}theme=dark; Path=/`)
	return response
}

test('one pass filters, scrubs, and HttpOnly-enforces package cookies and adds platform headers', async () => {
	const fetched = appResponse({
		headers: {
			'Cache-Control': 'public, max-age=60',
			'x-kody-runtime-run-id': 'run-1',
		},
	})
	const { response, report } = applyPackageAppResponseRewrite(fetched, {
		domainScrub,
		cookiePrefix: prefix,
		httpOnly: { clientReadable: [] },
		stripRuntimeRunId: true,
		cacheAudience: 'signed-in',
		appendSetCookies: ['__Host-kody_app_ticket=t; Path=/; HttpOnly'],
		serverTiming: [{ name: 'entrypoint', durationMs: 3 }],
	})
	expect(response.headers.getSetCookie()).toEqual([
		`${prefix}session=1; Path=/; HttpOnly`,
		`${prefix}theme=dark; Path=/`,
		'__Host-kody_app_ticket=t; Path=/; HttpOnly',
	])
	expect(report.dropped).toEqual(['other'])
	expect(report.stripped).toEqual([
		{ cookieName: `${prefix}session`, domain: 'kody.run' },
	])
	expect(report.findings).toEqual([
		{ cookieName: `${prefix}session`, reason: 'added_httponly' },
		{ cookieName: `${prefix}theme`, reason: 'missing_httponly' },
	])
	expect(report.runtimeRunId).toBe('run-1')
	expect(response.headers.get('x-kody-runtime-run-id')).toBeNull()
	expect(response.headers.get('Cache-Control')).toBe('private, max-age=60')
	expect(response.headers.get('Vary')).toBe('Cookie')
	expect(response.headers.get('Server-Timing')).toBe('entrypoint;dur=3')
	expect(await response.text()).toBe('ok')
})

test('an unchanged response is returned as is', () => {
	const fetched = new Response('ok')
	expect(
		applyPackageAppResponseRewrite(fetched, { cookiePrefix: prefix }).response,
	).toBe(fetched)
})

test('null-body statuses keep their status without a body', () => {
	for (const status of [204, 205, 304]) {
		const { response } = applyPackageAppResponseRewrite(
			appResponse({ status }, null),
			{
				cookiePrefix: prefix,
				domainScrub,
				serverTiming: [{ name: 'total', durationMs: 1 }],
			},
		)
		expect(response.status).toBe(status)
		expect(response.body).toBeNull()
		expect(response.headers.get('Server-Timing')).toBe('total;dur=1')
	}
})

test('WebSocket handshakes only get cookie rewrites and keep the paired socket', () => {
	const socket = { kind: 'client-socket' } as unknown as WebSocket
	const handshake = appResponse({ status: 200 }, null)
	Object.defineProperty(handshake, 'webSocket', {
		value: socket,
		configurable: true,
	})
	const { response } = applyPackageAppResponseRewrite(handshake, {
		cookiePrefix: prefix,
		domainScrub,
		cacheAudience: 'signed-in',
		appendSetCookies: ['ticket=1'],
		serverTiming: [{ name: 'total', durationMs: 1 }],
	})
	expect(response.webSocket).toBe(socket)
	expect(response.headers.getSetCookie()).toEqual([
		`${prefix}session=1; Path=/`,
		`${prefix}theme=dark; Path=/`,
	])
	expect(response.headers.get('Server-Timing')).toBeNull()
	expect(response.headers.get('Vary')).toBeNull()
})

test('inside the boundary scope, layers defer and the response is rewritten once', async () => {
	let served: Response | null = null
	const result = await runWithPackageAppResponseRewrite(
		async () => {
			served = appResponse({ headers: { 'x-kody-runtime-run-id': 'run-2' } })
			const fromServe = deferPackageAppResponseRewrite(served, {
				cookiePrefix: prefix,
				serverTiming: [{ name: 'entrypoint', durationMs: 2 }],
			})
			expect(fromServe).toBe(served)
			const fromOrigin = deferPackageAppResponseRewrite(fromServe, {
				cacheAudience: 'anonymous',
				appendSetCookies: ['ticket=1; Path=/'],
			})
			expect(fromOrigin).toBe(served)
			expect(fromOrigin.headers.get('Vary')).toBeNull()
			return fromOrigin
		},
		({ reported }) => {
			expect(reported).toBe(false)
			return {
				stripRuntimeRunId: true,
				domainScrub,
				serverTiming: [{ name: 'total', durationMs: 9 }],
			}
		},
	)
	expect(result).not.toBe(served)
	expect(result?.headers.getSetCookie()).toEqual([
		`${prefix}session=1; Path=/`,
		`${prefix}theme=dark; Path=/`,
		'ticket=1; Path=/',
	])
	expect(result?.headers.get('Vary')).toBe('Cookie')
	expect(result?.headers.get('x-kody-runtime-run-id')).toBeNull()
	expect(result?.headers.get('Server-Timing')).toBe(
		'entrypoint;dur=2, total;dur=9',
	)
})

test('outside a boundary scope, a deferred rewrite applies immediately', () => {
	const response = deferPackageAppResponseRewrite(appResponse(), {
		cookiePrefix: prefix,
	})
	expect(response.headers.getSetCookie()).toHaveLength(2)
})

test('a visit nonce wraps the body so the visit ends when it is read', async () => {
	const fetched = new Response('ok')
	const { response } = applyPackageAppResponseRewrite(fetched, {
		visitNonce: 'nonce-1',
	})
	expect(response).not.toBe(fetched)
	expect(await response.text()).toBe('ok')
})
