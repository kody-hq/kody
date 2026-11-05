import { expect, test } from 'vitest'
import {
	buildErrorAgentPrompt,
	escapeErrorAgentPromptHtml,
	redactErrorAgentPromptText,
	renderErrorAgentPromptStaticHtml,
} from './error-agent-prompt.ts'

test('redactErrorAgentPromptText strips bearer, jwt, keys, and query secrets', () => {
	expect(
		redactErrorAgentPromptText('Authorization: Bearer abcdefghijklmnop.secret'),
	).toContain(`Bearer [REDACTED]`)
	expect(
		redactErrorAgentPromptText(
			'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepartishere',
		),
	).toContain('[REDACTED]')
	expect(
		redactErrorAgentPromptText('key sk_live_abcdefghijklmnopqrstuv'),
	).toContain('[REDACTED]')
	expect(
		redactErrorAgentPromptText(
			'https://kody.codes/connect/oauth?code=splendid-secret-code&provider=github',
		),
	).toContain('code=[REDACTED]')
	expect(
		redactErrorAgentPromptText(
			'https://kody.codes/callback?access_token%3Dsuper-secret-token-value-here',
		),
	).toContain('access_token=[REDACTED]')
	expect(
		redactErrorAgentPromptText(
			'Authorization: Bearer abc+def/ghi=padded-token-value',
		),
	).toContain('Bearer [REDACTED]')
	expect(
		redactErrorAgentPromptText(
			'Authorization: Bearer abc+def/ghi=padded-token-value',
		),
	).not.toContain('abc def')
	// Encoded JWT dots (`%2E`): plain matchers stop at `%` and would leave the
	// payload/signature visible if we kept the raw redaction.
	const encodedJwt =
		'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9%2EeyJzdWIiOiIxMjM0NTY3ODkwIn0%2Esignaturepartishere'
	const redactedEncodedJwt = redactErrorAgentPromptText(encodedJwt)
	expect(redactedEncodedJwt).toContain('Bearer [REDACTED]')
	expect(redactedEncodedJwt).not.toContain('signaturepartishere')
	expect(redactedEncodedJwt).not.toContain('%2E')
	expect(
		redactErrorAgentPromptText('password: hunter2-extra-long-value'),
	).toContain('password: [REDACTED]')
	expect(
		redactErrorAgentPromptText(
			'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
		),
	).toBe('[REDACTED]')
})

test('buildErrorAgentPrompt redacts secrets inside free-form fields', () => {
	const prompt = buildErrorAgentPrompt({
		activity: 'Opened callback with access_token=super-secret-token-value-here',
		errorMessage:
			'Exchange failed for Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature-extra-chars',
	})
	expect(prompt).toContain('access_token=[REDACTED]')
	expect(prompt).not.toContain('super-secret-token-value-here')
	expect(prompt).toContain('Bearer [REDACTED]')
})

test('static HTML block escapes prompt text', () => {
	const html = renderErrorAgentPromptStaticHtml(
		'Exact error: use <script>alert(1)</script> & fail',
	)
	expect(html).toContain('&lt;script&gt;')
	expect(html).toContain('&amp; fail')
	expect(html).not.toContain('<script>alert')
	expect(escapeErrorAgentPromptHtml('<&>')).toBe('&lt;&amp;&gt;')
})

test('static HTML block renders a hidden, non-submitting Copy prompt button', () => {
	const html = renderErrorAgentPromptStaticHtml('Exact error: boom')
	expect(html).toContain(
		'<button type="button" data-error-agent-prompt-copy="" hidden>',
	)
	expect(html).toContain('Copy prompt</span>')
	expect(html).toContain('role="status" aria-live="polite"')
	expect(html).toContain(
		'<pre data-error-agent-prompt-text="" style="margin:0;padding:0.75rem;overflow:auto;white-space:pre-wrap;word-break:break-word;border:1px solid currentColor;border-radius:0.5rem;font-size:0.85rem">Exact error: boom</pre>',
	)
})
