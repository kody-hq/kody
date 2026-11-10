import { expect, test } from 'vitest'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { renderEmailVerificationPrompt } from './email-verification-prompt.tsx'
import { parseEmailVerificationDelivery } from '#universal/email-verification-delivery.ts'

test('verification prompt maps delivery states and links help for a bounce', async () => {
	for (const [status, indicator] of [
		['accepted', 'waiting'],
		['delivered', 'delivered'],
		['deferred', 'delayed'],
		['bounced', 'failed'],
	] as const) {
		const html = await renderStartPage(
			renderEmailVerificationPrompt({
				description: 'Check your inbox.',
				delivery: parseEmailVerificationDelivery({ status }),
				resendStatus: 'idle',
				resendMessage: null,
				onResend() {},
			}),
		)
		expect(html).toContain(`data-indicator="${indicator}"`)
		expect(html).toContain('Resend verification email')
		if (indicator === 'failed')
			expect(html).toContain('href="/docs/cant-open-or-get-mail"')
		else expect(html).not.toContain('href="/docs/cant-open-or-get-mail"')
	}
})

test('checking verification fences both actions without labeling the request as sending email', async () => {
	const html = await renderStartPage(
		renderEmailVerificationPrompt({
			description: 'Check your inbox.',
			resendStatus: 'idle',
			checking: true,
			resendMessage: null,
			onResend() {},
			continueLabel: 'Continue',
			onContinue() {},
		}),
	)
	const buttons = html.match(/<button[^>]*>/g) ?? []
	expect(buttons).toHaveLength(2)
	expect(buttons.every((button) => button.includes('disabled'))).toBe(true)
	expect(buttons[1]).toContain('aria-busy="true"')
	expect(html).toContain('Resend verification email')
	expect(html).not.toContain('Sending...')
})
