import { jsx } from 'react/jsx-runtime'
import { expect, test } from 'vitest'
import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import { PackageCookieWarningsCallout } from './pages/package-cookie-warnings-callout.tsx'
import { type AccountPackageDetail } from '#universal/loader-data.ts'

type CookieWarning = NonNullable<AccountPackageDetail['cookieWarnings']>[number]

test('renders nothing when the cookie warning list is empty', async () => {
	const html = await renderToString(
		jsx(PackageCookieWarningsCallout, { warnings: [] }),
		'/account/packages/pkg-1',
	)
	expect(html).not.toContain('package-cookie-warnings')
})

test('renders both warning types, remediation copy, and cookie names only', async () => {
	const sensitiveValue = 'cookie-value-must-not-render'
	const html = await renderToString(
		jsx(PackageCookieWarningsCallout, {
			warnings: [
				{
					cookieName: '__kapp_a_session',
					reason: 'added_httponly',
					lastSeenAt: '2026-10-22T12:00:00.000Z',
					value: sensitiveValue,
				} as CookieWarning,
				{
					cookieName: '__kapp_a_theme',
					reason: 'missing_httponly',
					lastSeenAt: '2026-10-21T12:00:00.000Z',
				},
			],
		}),
		'/account/packages/pkg-1',
	)
	expect(html).toContain('data-testid="package-cookie-warnings"')
	expect(html).toContain('Cookies without HttpOnly')
	expect(html).toContain(
		'Your app set these cookies without the HttpOnly flag. Scripts on your app host can read a cookie without HttpOnly, and that includes other apps on the same host.',
	)
	expect(html).toContain('__kapp_a_session')
	expect(html).toContain('__kapp_a_theme')
	expect(html).toContain(
		'Kody added HttpOnly because this looks like a sign-in or session cookie. Set it yourself so your app matches what browsers receive. If your page scripts must read it, list it in kody.app.cookies.clientReadable.',
	)
	expect(html).toContain(
		'Not changed. Add HttpOnly unless your page scripts need to read this cookie.',
	)
	expect(html).toContain(
		'To fix it, add HttpOnly to the Set-Cookie header, for example',
	)
	expect(html).toContain(
		'Set-Cookie: name=value; Path=/; HttpOnly; Secure; SameSite=Lax',
	)
	expect(html).toContain(
		'Kody shows cookie names only, never values. Entries clear after 14 days without being seen.',
	)
	expect(html).not.toContain(sensitiveValue)
})
