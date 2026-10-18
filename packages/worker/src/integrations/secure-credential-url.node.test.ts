import { expect, test } from 'vitest'
import {
	assertSecureCredentialUrl,
	isLoopbackHostname,
	isSecureCredentialUrl,
} from './secure-credential-url.ts'
import {
	assertSafeDeviceAuthorizationUrl,
	assertSafeTokenUrl,
} from './device-flow.ts'

test('isSecureCredentialUrl requires https except for loopback http', () => {
	expect(isSecureCredentialUrl('https://auth.example.com/device')).toBe(true)
	expect(isSecureCredentialUrl('http://localhost:8787/device')).toBe(true)
	expect(isSecureCredentialUrl('http://127.0.0.1:8787/token')).toBe(true)
	expect(isSecureCredentialUrl('http://mock.localhost/token')).toBe(true)
	expect(isSecureCredentialUrl('http://[::1]:8787/token')).toBe(true)

	expect(isSecureCredentialUrl('http://auth.example.com/device')).toBe(false)
	expect(isSecureCredentialUrl('ftp://localhost/device')).toBe(false)
	expect(isSecureCredentialUrl('not-a-url')).toBe(false)
	expect(isSecureCredentialUrl('')).toBe(false)
})

test('assertSecureCredentialUrl returns a clear rejection for plain http', () => {
	expect(
		assertSecureCredentialUrl('http://evil.example/token', 'Token URL'),
	).toBe('Token URL must use https (http is only allowed for localhost).')
	expect(
		assertSecureCredentialUrl('https://auth.example.com/token', 'Token URL'),
	).toBeNull()
	expect(assertSecureCredentialUrl('  ', 'Token URL')).toBe(
		'Token URL is required.',
	)
})

test('assertSafeDeviceAuthorizationUrl and assertSafeTokenUrl reject non-loopback http', () => {
	expect(
		assertSafeDeviceAuthorizationUrl('http://oauth.example.com/device'),
	).toBe(
		'Device authorization URL must use https (http is only allowed for localhost).',
	)
	expect(assertSafeTokenUrl('http://oauth.example.com/token')).toBe(
		'Token URL must use https (http is only allowed for localhost).',
	)
	expect(
		assertSafeDeviceAuthorizationUrl('http://localhost:8787/device'),
	).toBeNull()
	expect(assertSafeTokenUrl('https://oauth.example.com/token')).toBeNull()
})

test('isLoopbackHostname covers localhost variants', () => {
	expect(isLoopbackHostname('localhost')).toBe(true)
	expect(isLoopbackHostname('127.0.0.1')).toBe(true)
	expect(isLoopbackHostname('::1')).toBe(true)
	expect(isLoopbackHostname('[::1]')).toBe(true)
	expect(isLoopbackHostname('mock.localhost')).toBe(true)
	expect(isLoopbackHostname('oauth.example.com')).toBe(false)
})
