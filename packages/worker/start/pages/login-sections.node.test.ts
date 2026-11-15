import { createElement } from 'react'
import { expect, test, vi } from 'vitest'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { AuthForm } from './login-sections.tsx'

test.each([true, false])(
	'newsletter signup checkbox is optional, styled and unchecked: signup=%s',
	async (isSignup) => {
		const html = await renderStartPage(
			createElement(AuthForm, {
				handleId: 'auth',
				turnstileSiteKey: null,
				status: 'idle',
				message: null,
				isSubmitting: false,
				isInteractive: true,
				onFieldEdit: vi.fn(),
				isSignup,
				signupUsername: '',
				signupEmail: '',
				usernameConfirming: false,
				onSignupUsernameInput: vi.fn(),
				onSignupEmailInput: vi.fn(),
				onUsernameAvailabilityChange: vi.fn(),
				submitLabel: 'Continue',
				submitBusyLabel: 'Working',
				onSubmit: vi.fn(),
				onPasskeySignIn: vi.fn(),
			}),
		)
		const checkbox = html.match(
			/<input[^>]*name="whatsNewEmailOptIn"[^>]*>/,
		)?.[0]
		if (isSignup) {
			expect(checkbox).toContain('type="checkbox"')
			expect(checkbox).not.toContain('checked')
			expect(checkbox).not.toContain('required')
			expect(html).toContain('Send me What&#x27;s New in Kody emails')
		} else {
			expect(checkbox).toBeUndefined()
		}
	},
)
