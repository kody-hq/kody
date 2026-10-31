import { test, expect } from 'vitest'
import {
	parseDesktopAuthRequest,
	desktopAuthHash,
} from './desktop-auth-request.ts'
const valid = {
	callback: 'http://127.0.0.1:54321/kody/desktop/callback',
	challenge: 'a'.repeat(43),
	state: 'b'.repeat(43),
	mode: 'signup',
}
test('desktop sign-in accepts only exact loopback callbacks with PKCE and state', () => {
	expect(parseDesktopAuthRequest(valid).mode).toBe('signup')
	for (const callback of [
		'https://evil.test/kody/desktop/callback',
		'http://127.0.0.1.evil.test:54321/kody/desktop/callback',
		'http://127.0.0.1:80/kody/desktop/callback',
		'http://user@127.0.0.1:54321/kody/desktop/callback',
		'http://127.0.0.1:54321/other',
		'http://127.0.0.1:54321/kody/desktop/callback?next=evil',
	])
		expect(() => parseDesktopAuthRequest({ ...valid, callback })).toThrow()
	expect(() =>
		parseDesktopAuthRequest({ ...valid, challenge: 'plain' }),
	).toThrow()
	expect(() => parseDesktopAuthRequest({ ...valid, state: '' })).toThrow()
})
test('PKCE uses S256 base64url', async () => {
	expect(
		await desktopAuthHash('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
	).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})
