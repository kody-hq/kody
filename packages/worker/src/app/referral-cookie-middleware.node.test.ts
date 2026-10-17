import { expect, test } from 'vitest'
import { applyReferralCookie } from './referral-cookie-middleware.ts'
import { referralCookieName } from '#universal/referral-cookie.ts'

test('referral middleware overwrites kody_ref and no-stores the response', async () => {
	const respond = (request: Request) =>
		applyReferralCookie(
			request,
			new Response('signup', {
				headers: { 'Cache-Control': 'public, max-age=60' },
			}),
		)

	const first = await respond(new Request('http://localhost/signup?ref=Ada'))
	expect(await first.text()).toBe('signup')
	expect(first.headers.get('Set-Cookie')).toBe(
		`${referralCookieName}=ada; Path=/; Max-Age=604800; SameSite=Lax`,
	)
	expect(first.headers.get('Cache-Control')).toBe('no-store')

	const later = await respond(
		new Request('https://kody.codes/signup?ref=KentCDodds'),
	)
	expect(later.headers.get('Set-Cookie')).toBe(
		`${referralCookieName}=kentcdodds; Path=/; Max-Age=604800; SameSite=Lax; Secure`,
	)

	const untouched = await respond(new Request('http://localhost/signup'))
	expect(untouched.headers.get('Set-Cookie')).toBeNull()
	expect(untouched.headers.get('Cache-Control')).toBe('public, max-age=60')
})

test('referral policy preserves redirect status and existing session cookies', () => {
	const response = applyReferralCookie(
		new Request('https://kody.codes/signup?ref=ada'),
		new Response(null, {
			status: 302,
			headers: {
				Location: '/account',
				'Set-Cookie': 'session=existing; HttpOnly',
			},
		}),
	)
	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe('/account')
	expect(response.headers.getSetCookie()).toEqual([
		'session=existing; HttpOnly',
		expect.stringContaining('kody_ref=ada;'),
	])
	expect(response.headers.get('Cache-Control')).toBe('no-store')
})
