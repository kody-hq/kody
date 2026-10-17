import { expect, it } from 'vitest'
import { isPublicDocSlug } from './page-access.ts'
it('classifies catalog public, unadvertised and canonical alias guides without exposing admin or unknown guides', () => {
	for (const slug of ['what-is-kody', 'integration-backed-app-happy-path'])
		expect(isPublicDocSlug(slug)).toBe(true)
	for (const slug of [
		'admin-events',
		'unknown',
		'account-package-invocation-token-setup',
		'connect',
		'../what-is-kody',
		'',
	])
		expect(isPublicDocSlug(slug)).toBe(false)
})
