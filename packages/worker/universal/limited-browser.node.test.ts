import { expect, test } from 'vitest'
import { authFormErrorMessage } from './auth-form-errors.ts'
import {
	isLimitedBrowserUserAgent,
	isPlainDocumentSearch,
} from './limited-browser.ts'
import { packageAppDeviceSignInTarget } from './package-app-oauth-paths.ts'

const kindleScribeUserAgent =
	'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.149 Safari/537.36 Kindle/3.0'

test('e-reader and old engines are limited browsers; current ones are not', () => {
	for (const userAgent of [
		kindleScribeUserAgent,
		'Mozilla/5.0 (Linux; Android 9; KFTRWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/124.3.2 like Chrome/124.0.6367.219 Safari/537.36',
		'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.162 Safari/537.36',
		'Mozilla/5.0 (Windows NT 10.0; rv:102.0) Gecko/20100101 Firefox/102.0',
		'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Safari/605.1.15',
	]) {
		expect({
			userAgent,
			limited: isLimitedBrowserUserAgent(userAgent),
		}).toEqual({
			userAgent,
			limited: true,
		})
	}
	for (const userAgent of [
		null,
		'',
		'curl/8.5.0',
		'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15',
	]) {
		expect({
			userAgent,
			limited: isLimitedBrowserUserAgent(userAgent),
		}).toEqual({
			userAgent,
			limited: false,
		})
	}
})

test('the plain document flag is exact', () => {
	expect(isPlainDocumentSearch('?plain=1&redirectTo=%2F')).toBe(true)
	expect(isPlainDocumentSearch('?plain=0')).toBe(false)
	expect(isPlainDocumentSearch('')).toBe(false)
})

test('device sign-in is offered for package app redirects only', () => {
	expect(
		packageAppDeviceSignInTarget(
			'/oauth/package-app/authorize?client_id=owner%2Fapp',
		),
	).toBe('/oauth/package-app/authorize?client_id=owner%2Fapp')
	expect(packageAppDeviceSignInTarget('/@owner/packages/app/open')).toBe(
		'/@owner/packages/app/open',
	)
	expect(packageAppDeviceSignInTarget('/@owner/packages/app/notes?x=1')).toBe(
		'/@owner/packages/app/notes?x=1',
	)
	for (const redirectTo of [
		null,
		'/account',
		'/@owner/packages',
		'/@owner/app',
		'/oauth/authorize?client_id=x',
	]) {
		expect(packageAppDeviceSignInTarget(redirectTo)).toBeNull()
	}
})

test('the human check error only mentions another device when it is offered', () => {
	expect(authFormErrorMessage('human_check', { deviceSignIn: true })).toMatch(
		/Sign in on another device/,
	)
	const withoutOption = authFormErrorMessage('human_check')
	expect(withoutOption).not.toMatch(/another device/i)
	expect(withoutOption).toMatch(/human check/)
})
