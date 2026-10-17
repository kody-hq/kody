import { expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTestServerFn } from '../src/test-support/start-server-function.ts'
import { firstPartySecurityHeaders } from '../src/app/security-headers.ts'
import { FathomTracker } from './components/fathom-tracker.tsx'

const env = vi.hoisted(() => ({
	COOKIE_SECRET: 'test',
	FATHOM_SITE_ID: undefined as string | undefined,
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: createTestServerFn,
	createServerOnlyFn: <T>(fn: T) => fn,
}))
vi.mock('cloudflare:workers', () => ({ env }))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => new Request('https://kody.test/'),
	setResponseHeader: vi.fn(),
}))
vi.mock('../src/app/env.ts', () => ({ getEnv: (value: unknown) => value }))
vi.mock('../src/app/auth-session.ts', () => ({ setAuthSessionSecret: vi.fn() }))
vi.mock('../src/app/session-info.ts', () => ({
	loadSessionInfo: async () => ({ session: null, setCookie: undefined }),
}))
vi.mock('../src/app/request-auth-cache.ts', () => ({
	loadResolvedRequestAuth: async () => ({ user: null }),
}))
vi.mock('../src/app/youtube-watch-ssr.ts', () => ({
	loadYoutubeWatchLoaderData: async () => null,
}))
vi.mock('../src/app-base-url.ts', () => ({
	getCanonicalAppBaseUrl: () => 'https://kody.test',
}))
import { loadShell } from '#start/server/shell'

test.each([
	{ binding: undefined, expected: null },
	{ binding: '   ', expected: null },
	{ binding: ' WKKSDJGN ', expected: 'WKKSDJGN' },
	{ binding: 'WKKSDJGN', expected: 'WKKSDJGN' },
])(
	'native shell Fathom contract for binding $binding',
	async ({ binding, expected }) => {
		env.FATHOM_SITE_ID = binding
		const shell = await loadShell({ data: { pathname: '/', search: '' } })
		expect(shell.fathomSiteId).toBe(expected)
		const html = renderToStaticMarkup(
			createElement(FathomTracker, { siteId: shell.fathomSiteId }),
		)
		if (expected === null) {
			expect(html).toBe('')
			return
		}
		expect(html).toContain('rel="preconnect" href="https://cdn.usefathom.com"')
		expect(html).toContain('src="https://cdn.usefathom.com/script.js"')
		expect(html).toContain('data-site="WKKSDJGN"')
		expect(html).toContain('data-spa="auto"')
		expect(html).toContain('defer=""')
	},
)

test('native tracker and beacon hosts are permitted by the first-party CSP without unsafe script execution', () => {
	const csp = firstPartySecurityHeaders['Content-Security-Policy']
	if (!csp) throw new Error('Missing first-party CSP')
	const directives = new Map(
		csp.split(';').map((value) => {
			const [name, ...sources] = value.trim().split(/\s+/)
			return [name, sources] as const
		}),
	)
	expect(directives.get('script-src')).toEqual([
		"'self'",
		'https://cdn.usefathom.com',
		'https://static.cloudflareinsights.com',
		'https://challenges.cloudflare.com',
	])
	expect(directives.get('script-src')).not.toContain("'unsafe-inline'")
	expect(directives.get('script-src')).not.toContain("'unsafe-eval'")
	expect(directives.get('img-src')).toEqual([
		"'self'",
		'data:',
		'blob:',
		'https://cdn.usefathom.com',
		'https://static.scarf.sh',
	])
	expect(directives.get('connect-src')).toEqual([
		"'self'",
		'https://cdn.usefathom.com',
		'https://cloudflareinsights.com',
		'https://challenges.cloudflare.com',
	])
})
