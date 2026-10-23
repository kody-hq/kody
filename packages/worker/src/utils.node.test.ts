import { expect, test } from 'vitest'
import { mergeHeaders } from './utils.ts'

test('mergeHeaders preserves every Set-Cookie header', () => {
	// Auth responses can both issue a session cookie and expire the pending
	// verification cookie; collapsing them locked 2FA logins out.
	const response = new Headers()
	response.append('Set-Cookie', 'kody_session=abc; Path=/; HttpOnly')
	response.append('Set-Cookie', 'kody_verify=; Max-Age=0; Path=/')

	const merged = mergeHeaders(response, {
		'Access-Control-Allow-Origin': 'http://localhost',
	})

	expect(merged.getSetCookie()).toEqual([
		'kody_session=abc; Path=/; HttpOnly',
		'kody_verify=; Max-Age=0; Path=/',
	])
	expect(merged.get('Access-Control-Allow-Origin')).toBe('http://localhost')
})
