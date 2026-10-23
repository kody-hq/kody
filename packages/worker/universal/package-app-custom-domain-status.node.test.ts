import { expect, test } from 'vitest'
import {
	describePackageAppCustomDomainStatus,
	packageAppCustomDomainRecheckIntervalMs,
} from './package-app-custom-domain-status.ts'

const base = {
	hostnameStatus: 'pending',
	sslStatus: 'pending_validation',
	needsAttentionAt: null,
	verificationErrors: [] as Array<string>,
}

test('active needs both the hostname and the certificate', () => {
	expect(
		describePackageAppCustomDomainStatus({
			...base,
			hostnameStatus: 'active',
			sslStatus: 'active',
		}),
	).toEqual({ state: 'active', reason: null })
	expect(
		describePackageAppCustomDomainStatus({ ...base, hostnameStatus: 'active' })
			.reason,
	).toMatch(/certificate validation TXT/)
})

test('pending explains what Cloudflare is waiting on, preferring its own error', () => {
	expect(describePackageAppCustomDomainStatus(base)).toMatchObject({
		state: 'pending',
		reason: expect.stringMatching(/CNAME and ownership TXT/),
	})
	expect(
		describePackageAppCustomDomainStatus({
			...base,
			verificationErrors: ['custom hostname does not CNAME to this zone.'],
		}).reason,
	).toBe('Waiting on Cloudflare: custom hostname does not CNAME to this zone.')
})

test('needs attention after the window or on a terminal Cloudflare status', () => {
	expect(
		describePackageAppCustomDomainStatus({
			...base,
			needsAttentionAt: '2026-10-20T00:00:00.000Z',
		}),
	).toMatchObject({
		state: 'needs_attention',
		reason: expect.stringMatching(/48 hours.*DNS only/),
	})
	expect(
		describePackageAppCustomDomainStatus({ ...base, hostnameStatus: 'moved' }),
	).toMatchObject({
		state: 'needs_attention',
		reason: expect.stringMatching(/no longer points at Kody/),
	})
	expect(
		describePackageAppCustomDomainStatus({
			...base,
			sslStatus: 'validation_timed_out',
		}).state,
	).toBe('needs_attention')
})

test('re-check interval backs off and then stops', () => {
	const minute = 60 * 1000
	expect(packageAppCustomDomainRecheckIntervalMs(30 * minute)).toBe(0)
	expect(packageAppCustomDomainRecheckIntervalMs(2 * 60 * minute)).toBe(
		15 * minute,
	)
	expect(packageAppCustomDomainRecheckIntervalMs(24 * 60 * minute)).toBe(
		60 * minute,
	)
	expect(packageAppCustomDomainRecheckIntervalMs(48 * 60 * minute)).toBeNull()
})
