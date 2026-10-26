import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createPackageAppWorkerCacheKey } from './package-app.ts'

test('createPackageAppWorkerCacheKey does not vary by visitor', () => {
	const base = {
		userId: ownerIdFromStored('org-1'),
		orgSlug: 'acme',
		packageId: 'pkg-1',
		kodyId: 'demo',
		sourceId: 'src-1',
		publishedCommit: 'commit-1',
		baseUrl: 'https://kody.dev',
		appBasePath: '/@acme/demo',
		hostedUrl: 'https://kody.dev/@acme/demo',
	}
	const first = createPackageAppWorkerCacheKey(base)
	expect(first).toBe(createPackageAppWorkerCacheKey(base))
	expect(JSON.parse(first!)).not.toContain('person-a')
	expect(JSON.parse(first!)).not.toContain('person-b')
	expect(first).toBe(
		createPackageAppWorkerCacheKey({
			...base,
		}),
	)
	expect(
		createPackageAppWorkerCacheKey({ ...base, appBasePath: '/other' }),
	).not.toBe(first)
	expect(
		createPackageAppWorkerCacheKey({
			...base,
			hostedUrl: 'https://custom.example',
		}),
	).not.toBe(first)
	expect(
		createPackageAppWorkerCacheKey({ ...base, publishedCommit: null }),
	).toBe(null)
})
