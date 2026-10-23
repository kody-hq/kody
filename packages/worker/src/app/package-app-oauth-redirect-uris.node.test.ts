import { expect, test } from 'vitest'
import {
	isPackageAppOauthCallbackPathname,
	isPackageAppOauthHostAuthPathname,
	normalizePackageAppOauthHostAuthPathname,
} from '#universal/package-app-oauth-paths.ts'

test('host auth pathname helpers match canonical and legacy paths', () => {
	for (const pathname of [
		'/-/auth',
		'/-/auth/login',
		'/_kody/auth',
		'/_kody/auth/me',
	]) {
		expect(isPackageAppOauthHostAuthPathname(pathname)).toBe(true)
	}
	for (const pathname of [
		'/-/authx',
		'/_kody/authx',
		'/-/health',
		'/auth/me',
	]) {
		expect(isPackageAppOauthHostAuthPathname(pathname)).toBe(false)
	}
	expect(normalizePackageAppOauthHostAuthPathname('/_kody/auth/me')).toBe(
		'/-/auth/me',
	)
	expect(normalizePackageAppOauthHostAuthPathname('/-/auth/me')).toBe(
		'/-/auth/me',
	)
	expect(normalizePackageAppOauthHostAuthPathname('/other')).toBe('/other')
	expect(isPackageAppOauthCallbackPathname('/-/auth/callback')).toBe(true)
	expect(isPackageAppOauthCallbackPathname('/_kody/auth/callback')).toBe(true)
	expect(isPackageAppOauthCallbackPathname('/-/auth/login')).toBe(false)
})
