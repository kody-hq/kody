import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { AuthForm } from '../../pages/login-sections.tsx'

const shared = {
	handleId: 'auth',
	turnstileSiteKey: null,
	isSubmitting: false,
	isInteractive: true,
	onFieldEdit: () => {},
	signupUsername: '',
	onSignupUsernameInput: () => {},
}

test('credential errors associate the status message with email and password', async () => {
	const html = await renderToString(
		jsx(AuthForm, {
			...shared,
			status: 'error',
			message: 'Invalid email or password.',
			isSignup: false,
			submitLabel: 'Log in',
			submitBusyLabel: 'Logging in…',
			onSubmit: () => {},
			onPasskeySignIn: () => {},
		}),
	)

	expect(html).toContain('id="auth-form-status"')
	expect(html).toContain('role="alert"')
	expect(html).toMatch(/id="auth-email"[^>]*aria-invalid="true"/)
	expect(html).toMatch(/id="auth-password"[^>]*aria-invalid="true"/)
	expect(html).toMatch(
		/id="auth-email"[^>]*aria-describedby="auth-form-status"/,
	)
	expect(html).toMatch(/id="auth-email"[^>]*type="email"/)
	expect(html).toMatch(/id="auth-email"[^>]*autoComplete="username"/)
	expect(html).toMatch(/id="auth-password"[^>]*type="password"/)
	expect(html).toMatch(/id="auth-password"[^>]*autoComplete="current-password"/)
	expect(html).toMatch(/aria-label="Show password"/)
	expect(html).toMatch(/aria-pressed="false"/)
	expect(html).not.toContain('id="auth-username"')
})

test('username errors mark only that field', async () => {
	const usernameHtml = await renderToString(
		jsx(AuthForm, {
			...shared,
			status: 'error',
			message: 'Username is required.',
			isSignup: true,
			submitLabel: 'Create account',
			submitBusyLabel: 'Creating…',
			onSubmit: () => {},
			onPasskeySignIn: () => {},
		}),
	)
	expect(usernameHtml).toMatch(/id="auth-username"[^>]*aria-invalid="true"/)
	expect(usernameHtml).toMatch(/id="auth-email"[^>]*autoComplete="email"/)
	expect(usernameHtml).not.toMatch(/id="auth-email"[^>]*aria-invalid/)
})

test('signup form opts out of native validation and softens the username field for iOS', async () => {
	const html = await renderToString(
		jsx(AuthForm, {
			...shared,
			status: 'idle',
			message: null,
			isSignup: true,
			submitLabel: 'Create account',
			submitBusyLabel: 'Creating…',
			onSubmit: () => {},
			onPasskeySignIn: () => {},
		}),
	)
	expect(html).toMatch(/<form[^>]*novalidate/i)
	expect(html).toMatch(/id="auth-username"[^>]*autocapitalize="none"/i)
	expect(html).toMatch(/id="auth-username"[^>]*autocorrect="off"/i)
	expect(html).toMatch(/id="auth-username"[^>]*spellcheck="false"/i)
	expect(html).toContain('a–z')
})
