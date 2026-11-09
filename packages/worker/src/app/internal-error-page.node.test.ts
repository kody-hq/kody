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

test('illustrated 500 prompt names this path and the internal_error contract', async () => {
	const path = '/account?tab=usage'
	const body = await renderInternalServerErrorPage(path).text()
	expect(body).toContain(`Path: ${path}`)
	expect(body).toContain('Error code: internal_error')
	expect(body).toContain('illustrated internal error')
	expect(body).toContain('runList')
	expect(body).toContain('guide:sentry_issues')
})
