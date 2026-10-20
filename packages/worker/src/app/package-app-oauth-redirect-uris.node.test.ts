import { expect, test } from 'vitest'
import {
	isPackageAppOauthCallbackPathname,
	isPackageAppOauthHostAuthPathname,
	normalizePackageAppOauthHostAuthPathname,
	packageAppOauthLegacyPaths,
	packageAppOauthPaths,
} from '#universal/package-app-oauth-paths.ts'

test('package-app OAuth paths are canonical under /-/auth', () => {
	expect(packageAppOauthPaths.callback).toBe('/-/auth/callback')
	expect(packageAppOauthPaths.authorize).toBe('/oauth/package-app/authorize')
	expect(packageAppOauthPaths.login).toBe('/-/auth/login')
	expect(packageAppOauthPaths.logout).toBe('/-/auth/logout')
	expect(packageAppOauthPaths.me).toBe('/-/auth/me')
})

test('package-app OAuth legacy paths stay at /_kody/auth', () => {
	expect(packageAppOauthLegacyPaths.callback).toBe('/_kody/auth/callback')
	expect(packageAppOauthLegacyPaths.login).toBe('/_kody/auth/login')
	expect(packageAppOauthLegacyPaths.logout).toBe('/_kody/auth/logout')
	expect(packageAppOauthLegacyPaths.me).toBe('/_kody/auth/me')
})

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
