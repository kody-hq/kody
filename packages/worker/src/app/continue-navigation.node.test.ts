import { expect, test } from 'vitest'
import {
	continueNavigationResponse,
	isCrossOriginRedirect,
} from './continue-navigation.ts'

test('the continue page refreshes to the target and escapes the link', async () => {
	const response = continueNavigationResponse({
		location: 'https://owner.kody.run/-/auth/login?app=a&x="<y>',
		setCookies: ['a=1; Path=/', 'b=2; Path=/'],
	})
	expect(response.status).toBe(200)
	expect(response.headers.get('Refresh')).toBe(
		'0; url=https://owner.kody.run/-/auth/login?app=a&x="<y>',
	)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	expect(response.headers.getSetCookie()).toEqual([
		'a=1; Path=/',
		'b=2; Path=/',
	])
	const body = await response.text()
	expect(body).toContain('app=a&amp;x=&quot;&lt;y&gt;')
	expect(body).not.toContain('<script')
})

test('only redirects that leave the request origin count as cross-origin', () => {
	const at = 'https://kody.codes/oauth/package-app/authorize'
	const redirect = (location: string, status = 302) =>
		new Response(null, { status, headers: { Location: location } })
	expect(isCrossOriginRedirect(redirect('https://a.kody.run/-/auth'), at)).toBe(
		true,
	)
	expect(isCrossOriginRedirect(redirect('/device?result=approved'), at)).toBe(
		false,
	)
	expect(isCrossOriginRedirect(redirect('https://kody.codes/login'), at)).toBe(
		false,
	)
	expect(
		isCrossOriginRedirect(
			new Response('no', { status: 403, headers: { Location: 'https://x' } }),
			at,
		),
	).toBe(false)
})
