import { expect, test } from 'vitest'
import { pickPrimaryVerifiedAppCustomHostname } from './lookup.ts'

test('pickPrimaryVerifiedAppCustomHostname prefers a verified hostname', () => {
	expect(
		pickPrimaryVerifiedAppCustomHostname([
			{
				hostname: 'pending.app.example.com',
				hostnameStatus: 'pending',
				sslStatus: 'pending',
			},
			{
				hostname: 'app.example.com',
				hostnameStatus: 'active',
				sslStatus: 'active',
			},
		]),
	).toBe('app.example.com')
})

test('pickPrimaryVerifiedAppCustomHostname ignores pending-only candidates', () => {
	expect(
		pickPrimaryVerifiedAppCustomHostname([
			{
				hostname: 'pending.app.example.com',
				hostnameStatus: 'pending',
				sslStatus: 'pending',
			},
			{
				hostname: 'issuing.app.example.com',
				hostnameStatus: 'active',
				sslStatus: 'pending_validation',
			},
		]),
	).toBeNull()
})

test('pickPrimaryVerifiedAppCustomHostname returns null when none exist', () => {
	expect(pickPrimaryVerifiedAppCustomHostname([])).toBeNull()
})

test('pickPrimaryVerifiedAppCustomHostname picks the lexicographically smallest verified hostname', () => {
	expect(
		pickPrimaryVerifiedAppCustomHostname([
			{
				hostname: 'zeta.app.example.com',
				hostnameStatus: 'active',
				sslStatus: 'active',
			},
			{
				hostname: 'alpha.app.example.com',
				hostnameStatus: 'active',
				sslStatus: 'active',
			},
			{
				hostname: 'pending.app.example.com',
				hostnameStatus: 'pending',
				sslStatus: 'pending',
			},
		]),
	).toBe('alpha.app.example.com')
})
