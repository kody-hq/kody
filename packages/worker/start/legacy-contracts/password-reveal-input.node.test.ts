import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { PasswordRevealInput } from '../components/password-reveal-input.tsx'
import { passwordManagerIgnoreProps } from '../../client/password-manager-ignore.ts'

test('password reveal input starts hidden with an accessible toggle', async () => {
	const html = await renderToString(
		jsx(PasswordRevealInput, {
			id: 'auth-password',
			name: 'password',
			required: true,
			autoComplete: 'current-password',
			'data-field-ring': true,
		}),
	)

	expect(html).toMatch(/<input[^>]*type="password"/)
	expect(html).toMatch(/id="auth-password"/)
	expect(html).toMatch(/name="password"/)
	expect(html).toMatch(/autoComplete="current-password"/)
	expect(html).toMatch(/type="button"/)
	expect(html).toMatch(/aria-label="Show password"/)
	expect(html).toMatch(/aria-pressed="false"/)
	expect(html).toContain('>Show<')
	expect(html).not.toMatch(/type="submit"/)
})

test('controlled reveal shows text and pressed state', async () => {
	const html = await renderToString(
		jsx(PasswordRevealInput, {
			name: 'value',
			revealNoun: 'secret value',
			revealed: true,
			onRevealedChange: () => {},
			value: 'super-secret',
			readOnly: true,
			...passwordManagerIgnoreProps,
		}),
	)

	expect(html).toMatch(/<input[^>]*type="text"/)
	expect(html).toMatch(/aria-label="Hide secret value"/)
	expect(html).toMatch(/aria-pressed="true"/)
	expect(html).toContain('>Hide<')
	expect(html).toMatch(/data-1p-ignore/)
})
