import { afterEach, expect, test, vi } from 'vitest'
import {
	assertMcpEventCallbackUrl,
	fetchMcpEventCallback,
	isPublicFetchHostname,
	isPublicIpv4,
	isPublicIpv6,
	McpEventCallbackUrlError,
} from './ssrf.ts'

afterEach(() => {
	vi.unstubAllGlobals()
})

test('public https callback URLs are accepted and normalized', () => {
	for (const value of [
		'https://hooks.example.com/kody',
		'https://hooks.chatgpt.com/mcp/events?x=1',
		'https://HOOKS.Example.COM./path',
		'https://8.8.8.8/hook',
		'https://[2606:4700:4700::1111]/hook',
	]) {
		expect(assertMcpEventCallbackUrl(value)).toBeInstanceOf(URL)
	}
	expect(assertMcpEventCallbackUrl('https://HOOKS.Example.COM/a').href).toBe(
		'https://hooks.example.com/a',
	)
})

test('non-https, credentials, fragments, and malformed URLs are rejected', () => {
	const cases: Array<[string, RegExp]> = [
		['not a url', /absolute URL/],
		['http://hooks.example.com/kody', /must use https/],
		['ftp://hooks.example.com/kody', /must use https/],
		['https://user:pass@hooks.example.com/kody', /credentials/],
		['https://hooks.example.com/kody#frag', /fragment/],
	]
	for (const [value, message] of cases) {
		expect(() => assertMcpEventCallbackUrl(value)).toThrow(
			McpEventCallbackUrlError,
		)
		expect(() => assertMcpEventCallbackUrl(value)).toThrow(message)
	}
})

test('special-use and single-label hostnames are rejected', () => {
	for (const value of [
		'https://localhost/hook',
		'https://localhost./hook',
		'https://api.localhost/hook',
		'https://printer.local/hook',
		'https://metadata.google.internal/computeMetadata/v1',
		'https://router.home.arpa/hook',
		'https://nas.lan/hook',
		'https://service.test/hook',
		'https://example/hook',
		'https://intranet/hook',
		'https://abc.onion/hook',
		'https://1.0.0.127.in-addr.arpa/hook',
	]) {
		expect(() => assertMcpEventCallbackUrl(value)).toThrow(
			McpEventCallbackUrlError,
		)
	}
})

test('non-public IPv4 literals are rejected, including WHATWG-normalized forms', () => {
	for (const value of [
		'https://127.0.0.1/hook',
		'https://0.0.0.0/hook',
		'https://10.1.2.3/hook',
		'https://172.16.0.1/hook',
		'https://172.31.255.255/hook',
		'https://192.168.1.1/hook',
		'https://169.254.169.254/latest/meta-data',
		'https://100.64.0.1/hook',
		'https://192.0.2.10/hook',
		'https://198.18.0.1/hook',
		'https://224.0.0.1/hook',
		'https://255.255.255.255/hook',
		// Decimal / hex / short forms the URL parser normalizes to 127.0.0.1.
		'https://2130706433/hook',
		'https://0x7f000001/hook',
		'https://127.1/hook',
	]) {
		expect(() => assertMcpEventCallbackUrl(value)).toThrow(/IPv4 address/)
	}
	expect(isPublicIpv4([172, 15, 255, 255])).toBe(true)
	expect(isPublicIpv4([172, 32, 0, 0])).toBe(true)
	expect(isPublicIpv4([1, 1, 1, 1])).toBe(true)
})

test('only global unicast IPv6 literals are accepted', () => {
	for (const value of [
		'https://[::1]/hook',
		'https://[::]/hook',
		'https://[fe80::1]/hook',
		'https://[fc00::1]/hook',
		'https://[fd12:3456::1]/hook',
		'https://[ff02::1]/hook',
		'https://[::ffff:127.0.0.1]/hook',
		'https://[::ffff:8.8.8.8]/hook',
		'https://[64:ff9b::a00:1]/hook',
		'https://[2001:db8::1]/hook',
		'https://[2001::1]/hook',
		'https://[2002:7f00:1::1]/hook',
	]) {
		expect(() => assertMcpEventCallbackUrl(value)).toThrow(/IPv6 address/)
	}
	expect(isPublicIpv6('2606:4700:4700::1111')).toBe(true)
	expect(isPublicIpv6('2a00:1450:4001:80b::200e')).toBe(true)
	expect(isPublicIpv6('2001:4860:4860::8888')).toBe(true)
	expect(isPublicIpv6('not-an-address')).toBe(false)
	expect(isPublicIpv6('2606:4700::1111::1')).toBe(false)
})

test('fetchMcpEventCallback re-validates, never follows redirects, and bounds the request', async () => {
	const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
	vi.stubGlobal('fetch', fetchSpy)

	await expect(
		fetchMcpEventCallback('https://10.0.0.1/hook', {
			headers: {},
			body: '{}',
		}),
	).rejects.toThrow(McpEventCallbackUrlError)
	expect(fetchSpy).not.toHaveBeenCalled()

	const response = await fetchMcpEventCallback(
		'https://hooks.example.com/kody',
		{ headers: { 'webhook-id': 'evt_1' }, body: '{"a":1}' },
	)
	expect(response.status).toBe(204)
	expect(fetchSpy).toHaveBeenCalledWith(
		new URL('https://hooks.example.com/kody'),
		expect.objectContaining({
			method: 'POST',
			headers: { 'webhook-id': 'evt_1' },
			body: '{"a":1}',
			redirect: 'error',
			signal: expect.any(AbortSignal),
		}),
	)
})

test('isPublicFetchHostname refuses loopback names and non-public IP literals', () => {
	for (const value of [
		'http://localhost/',
		'http://app.localhost/',
		'http://127.0.0.1/',
		'http://2130706433/',
		'http://0177.0.0.1/',
		'http://0x7f.1/',
		'http://169.254.169.254/latest/meta-data/',
		'http://10.0.0.1/',
		'http://192.168.1.1/',
		'http://[::1]/',
		'http://[fd00::1]/',
		'http://[fe80::1]/',
		'http://[::ffff:127.0.0.1]/',
		'http://[::ffff:169.254.169.254]/',
	]) {
		expect(isPublicFetchHostname(new URL(value).hostname)).toBe(false)
	}
	for (const value of [
		'https://api.example.com/',
		'https://1.1.1.1/',
		'https://[2606:4700::1111]/',
	]) {
		expect(isPublicFetchHostname(new URL(value).hostname)).toBe(true)
	}
})
