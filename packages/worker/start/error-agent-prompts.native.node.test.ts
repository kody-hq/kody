import { createElement } from 'react'
import { expect, test } from 'vitest'
import { renderStartPage } from './test-support/render-start-page.ts'
import { VerifyEmailRoute } from './pages/verify-email.tsx'
import { renderStatusCallout } from './pages/connect-oauth-sections.tsx'

const marker = /data-error-agent-prompt=/g

test('email verification failures offer the agent prompt, successful verification does not', async () => {
	const failure = await renderStartPage(
		createElement(VerifyEmailRoute, {
			data: {
				ok: false,
				error: 'The verification link expired.',
				reason: 'expired_token',
			},
		}),
		'/verify-email',
	)
	expect(failure.match(marker)).toHaveLength(1)
	expect(failure).toContain('Copy prompt for your agent')
	const success = await renderStartPage(
		createElement(VerifyEmailRoute, {
			data: { ok: true, kind: 'email_verify', message: 'Email verified.' },
		}),
		'/verify-email',
	)
	expect(success).not.toContain('data-error-agent-prompt')
})

test('OAuth failures have one prompt unless the incomplete configuration card owns it', async () => {
	const input = {
		statusTone: 'error' as const,
		statusMessage: 'Provider denied access.',
		currentStep: 'setup' as const,
		provider: 'github',
	}
	const failure = await renderStartPage(renderStatusCallout(input))
	expect(failure.match(marker)).toHaveLength(1)
	const incomplete = await renderStartPage(
		renderStatusCallout({ ...input, includePrompt: false }),
	)
	expect(incomplete).toContain('role="alert"')
	expect(incomplete).not.toContain('data-error-agent-prompt')
})
