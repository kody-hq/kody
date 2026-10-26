import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	filterPackageAppSetCookies,
	logPackageAppSetCookieNamesDropped,
	createPackageAppSetCookieScrubHostSource,
	logPackageAppSetCookieDomainStripped,
	normalizeSetCookieDomain,
	rewritePackageAppSetCookieHeader,
	scrubPackageAppSetCookieDomains,
	shouldStripPackageAppSetCookieDomain,
} from './package-app-set-cookie.ts'
import { packageAppCookiePrefix } from './package-app-cookie-prefix.ts'

const apexes = ['kody.run']

test('normalizeSetCookieDomain lowercases and drops a leading dot', () => {
	expect(normalizeSetCookieDomain('.Kody.Run.')).toBe('kody.run')
	expect(normalizeSetCookieDomain('alice.kody.run')).toBe('alice.kody.run')
})

test('shouldStripPackageAppSetCookieDomain blocks apex and sibling Domains', () => {
	expect(
		[
			{
				cookieDomain: 'kody.run',
				responseHostname: 'alice.kody.run',
				expectStrip: true,
			},
			{
				cookieDomain: '.kody.run',
				responseHostname: 'alice.kody.run',
				expectStrip: true,
			},
			{
				cookieDomain: 'kody.run',
				responseHostname: 'kody.run',
				expectStrip: true,
			},
			{
				cookieDomain: 'bob.kody.run',
				responseHostname: 'alice.kody.run',
				expectStrip: true,
			},
			{
				cookieDomain: 'alice.kody.run',
				responseHostname: 'alice.kody.run',
				expectStrip: false,
			},
			{
				cookieDomain: 'example.com',
				responseHostname: 'alice.kody.run',
				expectStrip: false,
			},
		].map(({ cookieDomain, responseHostname, expectStrip }) => ({
			cookieDomain,
			stripped: shouldStripPackageAppSetCookieDomain({
				cookieDomain,
				responseHostname,
				packageAppApexHostnames: apexes,
			}),
			expectStrip,
		})),
	).toEqual(
		[
			{ cookieDomain: 'kody.run', expectStrip: true },
			{ cookieDomain: '.kody.run', expectStrip: true },
			{ cookieDomain: 'kody.run', expectStrip: true },
			{ cookieDomain: 'bob.kody.run', expectStrip: true },
			{ cookieDomain: 'alice.kody.run', expectStrip: false },
			{ cookieDomain: 'example.com', expectStrip: false },
		].map(({ cookieDomain, expectStrip }) => ({
			cookieDomain,
			stripped: expectStrip,
			expectStrip,
		})),
	)
})

test('rewritePackageAppSetCookieHeader drops Domain and keeps host-only cookies', () => {
	const tossed = rewritePackageAppSetCookieHeader(
		'session=abc; Domain=kody.run; Path=/; HttpOnly; Secure',
		{ responseHostname: 'alice.kody.run', packageAppApexHostnames: apexes },
	)
	expect(tossed.strippedDomain).toBe('kody.run')
	expect(tossed.header).toBe('session=abc; Path=/; HttpOnly; Secure')
	expect(tossed.header).not.toMatch(/domain=/i)

	const hostOnly = rewritePackageAppSetCookieHeader(
		'ok=1; Path=/; SameSite=Lax',
		{ responseHostname: 'alice.kody.run', packageAppApexHostnames: apexes },
	)
	expect(hostOnly.strippedDomain).toBeNull()
	expect(hostOnly.header).toBe('ok=1; Path=/; SameSite=Lax')

	const exactHost = rewritePackageAppSetCookieHeader(
		'local=1; Domain=alice.kody.run; Path=/',
		{ responseHostname: 'alice.kody.run', packageAppApexHostnames: apexes },
	)
	expect(exactHost.strippedDomain).toBeNull()
	expect(exactHost.header).toContain('Domain=alice.kody.run')
})

test('scrubPackageAppSetCookieDomains preserves multi Set-Cookie and scrubs websocket handshakes', async () => {
	const response = new Response('ok', {
		headers: [
			['Set-Cookie', 'toss=1; Domain=.kody.run; Path=/'],
			['Set-Cookie', 'keep=1; Path=/; HttpOnly'],
			['Set-Cookie', 'sibling=1; Domain=bob.kody.run; Path=/'],
			['Cache-Control', 'no-store'],
		],
	})
	const scrubbed = scrubPackageAppSetCookieDomains(response, {
		responseHostname: 'alice.kody.run',
		packageAppApexHostnames: apexes,
	})
	expect(scrubbed.stripped).toEqual([
		{ cookieName: 'toss', domain: 'kody.run' },
		{ cookieName: 'sibling', domain: 'bob.kody.run' },
	])
	expect(scrubbed.response.headers.getSetCookie()).toEqual([
		'toss=1; Path=/',
		'keep=1; Path=/; HttpOnly',
		'sibling=1; Path=/',
	])
	expect(scrubbed.response.headers.get('Cache-Control')).toBe('no-store')
	await expect(scrubbed.response.text()).resolves.toBe('ok')

	// Node's Response rejects status 101; Workers still pair via `webSocket`.
	const client = { kind: 'client-socket' } as unknown as WebSocket
	const upgrade = new Response(null, {
		headers: { 'Set-Cookie': 'toss=1; Domain=kody.run; Path=/' },
	})
	Object.defineProperty(upgrade, 'webSocket', {
		value: client,
		configurable: true,
	})
	const scrubbedUpgrade = scrubPackageAppSetCookieDomains(upgrade, {
		responseHostname: 'alice.kody.run',
		packageAppApexHostnames: apexes,
	})
	expect(scrubbedUpgrade.stripped).toEqual([
		{ cookieName: 'toss', domain: 'kody.run' },
	])
	expect(scrubbedUpgrade.response.headers.getSetCookie()).toEqual([
		'toss=1; Path=/',
	])
	expect(scrubbedUpgrade.response.webSocket).toBe(client)
})

test('rewrite does not treat a cookie named domain as a Domain attribute', () => {
	const result = rewritePackageAppSetCookieHeader(
		'domain=kody.run; Path=/; HttpOnly',
		{ responseHostname: 'alice.kody.run', packageAppApexHostnames: apexes },
	)
	expect(result.strippedDomain).toBeNull()
	expect(result.header).toBe('domain=kody.run; Path=/; HttpOnly')
})

test('parent of a nested package-app apex is stripped', () => {
	expect(
		shouldStripPackageAppSetCookieDomain({
			cookieDomain: 'example.dev',
			responseHostname: 'alice.apps.example.dev',
			packageAppApexHostnames: ['apps.example.dev'],
		}),
	).toBe(true)
})

test('logPackageAppSetCookieDomainStripped warns only when cookies were stripped', () => {
	consoleWarn.mockImplementation(() => {})
	logPackageAppSetCookieDomainStripped({
		hostname: 'alice.kody.run',
		pathname: '/demo',
		stripped: [],
	})
	expect(consoleWarn).not.toHaveBeenCalled()

	logPackageAppSetCookieDomainStripped({
		hostname: 'alice.kody.run',
		pathname: '/demo',
		stripped: [{ cookieName: 'toss', domain: 'kody.run' }],
		surface: 'package-app-origin',
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'package-app-set-cookie-domain-stripped',
		{
			hostname: 'alice.kody.run',
			pathname: '/demo',
			surface: 'package-app-origin',
			stripped: [{ cookieName: 'toss', domain: 'kody.run' }],
		},
	)
	consoleWarn.mockReset()
})

test('createPackageAppSetCookieScrubHostSource embeds apexes and the scrub helpers', () => {
	const source = createPackageAppSetCookieScrubHostSource({
		packageAppApexHostnames: ['kody.run', 'legacy.example'],
		cookiePrefix: '__kapp_123456789abc_',
	})
	expect(source).toContain('"kody.run"')
	expect(source).toContain('"legacy.example"')
	expect(source).toContain('__kodyScrubPackageAppSetCookieDomains')
	expect(source).toContain('__kodyShouldStripPackageAppSetCookieDomain')
	expect(source).toContain('__kodyPackageAppCookiePrefix')
	expect(source).toContain('__kodyIsPackageAppOwnCookieName')
})

test('package app cookie prefixes follow the saved package id', async () => {
	const original = await packageAppCookiePrefix('package-one')
	expect(await packageAppCookiePrefix('package-one')).toBe(original)
	expect(await packageAppCookiePrefix('package-two')).not.toBe(original)
	// A rename keeps the package id; name reuse is a different saved id.
	expect(await packageAppCookiePrefix('package-one')).toBe(original)
	expect(await packageAppCookiePrefix('package-two')).not.toBe(original)
})

test('filterPackageAppSetCookies keeps only package-prefixed cookies', () => {
	const response = new Response('body', {
		headers: [
			['Set-Cookie', '__kapp_123456789abc_a=1; Path=/'],
			['Set-Cookie', 'other=1; Path=/'],
		],
	})
	const filtered = filterPackageAppSetCookies(response, '__kapp_123456789abc_')
	expect(filtered.dropped).toEqual(['other'])
	expect(filtered.response.headers.getSetCookie()).toEqual([
		'__kapp_123456789abc_a=1; Path=/',
	])
})

test('filterPackageAppSetCookies preserves websocket responses', () => {
	const client = { kind: 'client-socket' } as unknown as WebSocket
	const response = new Response(null, {
		headers: { 'Set-Cookie': 'other=1; Path=/' },
	})
	Object.defineProperty(response, 'webSocket', {
		value: client,
		configurable: true,
	})
	const filtered = filterPackageAppSetCookies(response, '__kapp_123456789abc_')
	expect(filtered.dropped).toEqual(['other'])
	expect(filtered.response.webSocket).toBe(client)
})

test('logPackageAppSetCookieNamesDropped logs names without values', () => {
	consoleWarn.mockImplementation(() => {})
	logPackageAppSetCookieNamesDropped({
		hostname: 'alice.kody.run',
		dropped: ['other'],
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'package-app-set-cookie-name-dropped',
		expect.objectContaining({ dropped: ['other'] }),
	)
	expect(JSON.stringify(consoleWarn.mock.calls[0]?.[1])).not.toContain('=1')
	consoleWarn.mockReset()
})

test('generated package-app scrubber strips unsafe cookie domains', () => {
	const source = createPackageAppSetCookieScrubHostSource({
		packageAppApexHostnames: ['kody.run', 'legacy.example'],
	})
	const scrub = new Function(
		`${source}; return __kodyScrubPackageAppSetCookieDomains;`,
	)() as (
		response: Response,
		responseHostname: string,
	) => {
		response: Response
		stripped: Array<{ cookieName: string; domain: string }>
	}

	const result = scrub(
		new Response(null, {
			headers: {
				'Set-Cookie': 'toss=1; Domain=kody.run; Path=/',
			},
		}),
		'alice.kody.run',
	)

	expect(result.stripped).toEqual([{ cookieName: 'toss', domain: 'kody.run' }])
	expect(result.response.headers.getSetCookie()).toEqual(['toss=1; Path=/'])
})

test('generated package-app scrubber returns dropped names for untouched responses', () => {
	const source = createPackageAppSetCookieScrubHostSource({
		packageAppApexHostnames: [],
	})
	const scrub = new Function(
		`${source}; return __kodyScrubPackageAppSetCookieDomains;`,
	)() as (
		response: Response,
		responseHostname: string,
	) => { response: Response; dropped: Array<string> }

	expect(scrub(new Response('ok'), 'alice.kody.run').dropped).toEqual([])
})

test('legacy package-app apex list also strips Domain under that apex', () => {
	const scrubbed = scrubPackageAppSetCookieDomains(
		new Response(null, {
			headers: {
				'Set-Cookie': 'x=1; Domain=legacy.example; Path=/',
			},
		}),
		{
			responseHostname: 'alice.legacy.example',
			packageAppApexHostnames: ['kody.run', 'legacy.example'],
		},
	)
	expect(scrubbed.stripped).toEqual([
		{ cookieName: 'x', domain: 'legacy.example' },
	])
	expect(scrubbed.response.headers.getSetCookie()).toEqual(['x=1; Path=/'])
})

test('no apex configuration leaves Set-Cookie untouched', () => {
	const response = new Response(null, {
		headers: { 'Set-Cookie': 'x=1; Domain=kody.run; Path=/' },
	})
	const scrubbed = scrubPackageAppSetCookieDomains(response, {
		responseHostname: 'alice.kody.run',
		packageAppApexHostnames: [],
	})
	expect(scrubbed.stripped).toEqual([])
	expect(scrubbed.response.headers.getSetCookie()).toEqual([
		'x=1; Domain=kody.run; Path=/',
	])
})

test('null-body statuses keep status and strip Domain without throwing', async () => {
	for (const status of [204, 205, 304] as const) {
		const scrubbed = scrubPackageAppSetCookieDomains(
			new Response(null, {
				status,
				headers: { 'Set-Cookie': 'toss=1; Domain=kody.run; Path=/' },
			}),
			{
				responseHostname: 'alice.kody.run',
				packageAppApexHostnames: apexes,
			},
		)
		expect(scrubbed.stripped).toEqual([
			{ cookieName: 'toss', domain: 'kody.run' },
		])
		expect(scrubbed.response.status).toBe(status)
		expect(scrubbed.response.headers.getSetCookie()).toEqual(['toss=1; Path=/'])
		await expect(scrubbed.response.text()).resolves.toBe('')
	}
})
