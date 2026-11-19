import { expect, test } from 'vitest'
import {
	assertSecureCredentialUrl,
	isLoopbackHostname,
	isPublicCredentialEndpoint,
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

test('isPublicCredentialEndpoint refuses private, link-local, and reserved token hosts', () => {
	for (const value of [
		'https://169.254.169.254/token',
		'https://10.0.0.5/token',
		'https://192.168.1.10/token',
		'https://167772161/token',
		'https://[fd00::1]/token',
		'https://[::ffff:10.0.0.1]/token',
		'http://auth.example.com/token',
	]) {
		expect(isPublicCredentialEndpoint(value)).toBe(false)
	}
	for (const value of [
		'https://auth.example.com/token',
		'https://localhost:8787/token',
		'https://localhost./token',
		'http://127.0.0.1:8787/token',
	]) {
		expect(isPublicCredentialEndpoint(value)).toBe(true)
	}
	// Stored rows still parse; only save and fetch apply the host check.
	expect(isSecureCredentialUrl('https://169.254.169.254/token')).toBe(true)
	expect(assertSafeTokenUrl('https://169.254.169.254/token')).toBe(
		'Token URL must not target a private, link-local, or reserved address.',
	)
})
