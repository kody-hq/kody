import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	assertHttpsPublicUrl,
	extractPngFromIco,
	parseHtmlIconCandidates,
	resolveFaviconOrigin,
	shouldFetchUserOauthAppFavicon,
} from './user-oauth-app-favicon.ts'
import { type UserOauthApp } from './types.ts'

test('favicon origin resolution prefers authorize hosts and skips unsafe URLs', () => {
	const google = resolveFaviconOrigin([
		'https://accounts.google.com/o/oauth2/v2/auth',
		'https://www.googleapis.com',
		'https://oauth2.googleapis.com/token',
	])
	expect(google?.host).toBe('google.com')
	expect(google?.origin.href).toBe('https://google.com/')

	expect(
		resolveFaviconOrigin([
			'http://dropbox.com/oauth2/authorize',
			'https://localhost/token',
			'https://www.dropbox.com/oauth2/authorize',
		])?.host,
	).toBe('dropbox.com')

	const unsafeUrls = [
		{ url: 'http://example.com/icon.png', reason: /https/ },
		{ url: 'https://user:pass@example.com/icon.png', reason: /credentials/ },
		{ url: 'https://127.0.0.1/icon.png', reason: /public/ },
		{ url: 'https://169.254.169.254/latest/meta-data', reason: /public/ },
		{ url: 'https://[::1]/icon.png', reason: /public/ },
	]
	for (const { url, reason } of unsafeUrls) {
		expect(() => assertHttpsPublicUrl(url)).toThrow(reason)
	}
})

test('parseHtmlIconCandidates ranks apple-touch-icon then larger icons', () => {
	const html = `
		<link rel="icon" href="/favicon-16.png" sizes="16x16">
		<link rel="apple-touch-icon" href="/apple-180.png" sizes="180x180">
		<link rel="icon" href="https://cdn.example.com/favicon.svg">
	`
	const candidates = parseHtmlIconCandidates(
		html,
		new URL('https://example.com/'),
	)
	expect(candidates.map((candidate) => candidate.href)).toEqual([
		'https://example.com/apple-180.png',
		'https://example.com/favicon-16.png',
		'https://cdn.example.com/favicon.svg',
	])
})

test('shouldFetchUserOauthAppFavicon skips explicit uploads and stale-host refetches', () => {
	const base: UserOauthApp = {
		userId: ownerIdFromStored('user-1'),
		slug: 'dropbox',
		provider: 'dropbox',
		label: null,
		clientId: 'client',
		hasClientSecret: false,
		tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
		authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
		deviceAuthorizationUrl: null,
		apiBaseUrl: 'https://api.dropboxapi.com/2',
		flow: 'pkce',
		usePkce: null,
		tokenExchangeStyle: null,
		scopeSeparator: null,
		extraAuthorizeParams: {},
		logoKey: null,
		logoContentType: null,
		logoSource: null,
		faviconSourceHost: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
	expect(shouldFetchUserOauthAppFavicon(base)).toBe(true)
	expect(
		shouldFetchUserOauthAppFavicon({
			...base,
			logoKey: 'user-oauth-app-logos/u/dropbox/abc.png',
			logoSource: 'upload',
		}),
	).toBe(false)
	expect(
		shouldFetchUserOauthAppFavicon({
			...base,
			logoKey: 'user-oauth-app-logos/u/dropbox/abc.png',
			logoSource: 'favicon',
			faviconSourceHost: 'dropbox.com',
		}),
	).toBe(false)
	expect(
		shouldFetchUserOauthAppFavicon({
			...base,
			logoKey: 'user-oauth-app-logos/u/dropbox/abc.png',
			logoSource: 'favicon',
			faviconSourceHost: 'old.example',
		}),
	).toBe(true)
})

test('extractPngFromIco returns the largest embedded PNG and skips BMP ICO', () => {
	const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	const header = new Uint8Array(6 + 16)
	const view = new DataView(header.buffer)
	view.setUint16(0, 0, true)
	view.setUint16(2, 1, true)
	view.setUint16(4, 1, true)
	view.setUint32(6 + 8, png.byteLength, true)
	view.setUint32(6 + 12, header.byteLength, true)
	const ico = new Uint8Array(header.byteLength + png.byteLength)
	ico.set(header)
	ico.set(png, header.byteLength)
	expect(extractPngFromIco(ico)).toEqual(png)
	expect(extractPngFromIco(new Uint8Array([0, 0, 1, 0, 0, 0]))).toBeNull()
})
