import { expect, test } from 'vitest'
import { resolvePackageAppOauthInlineIdentity } from '#app/package-app-oauth-inline-identity.ts'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'

test('inline identity prefers org+app query params (case-normalized)', () => {
	const url = new URL(
		`https://preview.example${packageAppOauthPaths.login}?org=Acme&app=Demo&return_to=%2Fother`,
	)
	expect(resolvePackageAppOauthInlineIdentity(url)).toEqual({
		orgUsername: 'acme',
		kodyId: 'demo',
	})
})

test('inline identity falls back to package-shaped return_to', () => {
	const url = new URL(
		`https://preview.example${packageAppOauthPaths.login}?return_to=%2F%40acme%2Fpackages%2FDemo%2Fnotes`,
	)
	expect(resolvePackageAppOauthInlineIdentity(url)).toEqual({
		orgUsername: 'acme',
		kodyId: 'demo',
	})
})

test('inline identity rejects missing identity', () => {
	const url = new URL(
		`https://preview.example${packageAppOauthPaths.login}?return_to=%2Fnotes`,
	)
	expect(resolvePackageAppOauthInlineIdentity(url)).toBeNull()
})

test('inline identity reads return_to as a same-origin URL', () => {
	const withQuery = new URL(
		`https://preview.example${packageAppOauthPaths.login}?return_to=${encodeURIComponent('/@acme/packages/demo/notes?tab=1#top')}`,
	)
	expect(resolvePackageAppOauthInlineIdentity(withQuery)).toEqual({
		orgUsername: 'acme',
		kodyId: 'demo',
	})
	const crossOrigin = new URL(
		`https://preview.example${packageAppOauthPaths.login}?return_to=${encodeURIComponent('/\\other.example/@acme/packages/demo')}`,
	)
	expect(resolvePackageAppOauthInlineIdentity(crossOrigin)).toBeNull()
})
