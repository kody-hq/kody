import { expect, test } from 'vitest'
import {
	renderInternalServerErrorPage,
	retryHrefFromRequest,
} from '#app/internal-error-page.ts'

test('retryHrefFromRequest keeps same-origin paths and rejects protocol-relative URLs', async () => {
	expect(
		retryHrefFromRequest(new Request('https://example.com/account?tab=usage')),
	).toBe('/account?tab=usage')
	expect(retryHrefFromRequest(new Request('https://example.com/'))).toBe('/')
	expect(
		retryHrefFromRequest(new Request('https://example.com//evil.example')),
	).toBe('/')
	expect(
		retryHrefFromRequest(
			new Request('https://example.com//evil.example/phish?retry=1'),
		),
	).toBe('/')
	expect(
		retryHrefFromRequest(new Request('https://example.com/\\evil.example')),
	).toBe('/')

	const body = await renderInternalServerErrorPage(
		retryHrefFromRequest(new Request('https://example.com//evil.example')),
	).text()
	expect(body).toContain('data-variant="pill" href="/"')
	expect(body).not.toContain('data-variant="pill" href="//evil.example"')
	expect(body).toContain('data-error-agent-prompt')
	expect(body).toContain(
		'<script src="/error-agent-prompt-copy.js" defer></script>',
	)
})
