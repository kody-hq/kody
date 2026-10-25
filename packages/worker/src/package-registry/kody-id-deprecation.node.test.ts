import { expect, test } from 'vitest'
import {
	argsUsedKodyIdPackageIdentity,
	attachKodyIdDeprecationHint,
	buildKodyIdDeprecationHint,
	kodyIdDeprecationField,
	resolvePreferredPackageIdentity,
} from './kody-id-deprecation.ts'

test('argsUsedKodyIdPackageIdentity detects top-level and target leftovers', () => {
	expect(argsUsedKodyIdPackageIdentity({ package_id: 'pkg-1' })).toBe(false)
	expect(argsUsedKodyIdPackageIdentity({ name: '@owner/leaf' })).toBe(false)
	expect(argsUsedKodyIdPackageIdentity({ kody_id: 'leaf' })).toBe(true)
	expect(argsUsedKodyIdPackageIdentity({ kodyId: 'leaf' })).toBe(true)
	expect(
		argsUsedKodyIdPackageIdentity({
			target: { kind: 'package', kody_id: 'leaf' },
		}),
	).toBe(true)
	expect(
		argsUsedKodyIdPackageIdentity({
			target: { kind: 'package', package_id: 'pkg-1' },
		}),
	).toBe(false)
	expect(argsUsedKodyIdPackageIdentity({ kody_id: '   ' })).toBe(false)
})

test('buildKodyIdDeprecationHint includes resolved name and package_id', () => {
	expect(
		buildKodyIdDeprecationHint({
			name: '@owner/demo',
			package_id: 'pkg-uuid',
		}),
	).toContain('name: "@owner/demo"')
	expect(
		buildKodyIdDeprecationHint({
			name: '@owner/demo',
			package_id: 'pkg-uuid',
		}),
	).toContain('package_id: "pkg-uuid"')
	expect(buildKodyIdDeprecationHint({})).toContain('Prefer `name`')
	expect(buildKodyIdDeprecationHint({})).toContain('Stop sending `kody_id`')
})

test('resolvePreferredPackageIdentity reads nested package summaries', () => {
	expect(
		resolvePreferredPackageIdentity({
			package: { name: '@owner/nested', package_id: 'nested-id' },
		}),
	).toEqual({ name: '@owner/nested', packageId: 'nested-id' })
	expect(
		resolvePreferredPackageIdentity({
			target_name: '@owner/forked',
			package_id: 'fork-id',
		}),
	).toEqual({ name: '@owner/forked', packageId: 'fork-id' })
	expect(
		resolvePreferredPackageIdentity({
			webhooks: [{ package_name: '@owner/hook', package_id: 'hook-id' }],
		}),
	).toEqual({ name: '@owner/hook', packageId: 'hook-id' })
	expect(
		resolvePreferredPackageIdentity({
			enablement: { package_id: 'en-id' },
		}),
	).toEqual({ name: undefined, packageId: 'en-id' })
})

test('attachKodyIdDeprecationHint only when leftover kody_id was used', () => {
	const result = {
		package_id: 'pkg-1',
		name: '@owner/demo',
		slug: 'demo',
	}
	expect(attachKodyIdDeprecationHint({ package_id: 'pkg-1' }, result)).toEqual(
		result,
	)
	const withHint = attachKodyIdDeprecationHint({ kody_id: 'demo' }, result)
	expect(withHint).toMatchObject({
		package_id: 'pkg-1',
		name: '@owner/demo',
		[kodyIdDeprecationField]: expect.stringContaining('Deprecated:'),
	})
	expect(
		(withHint as Record<string, unknown>)[kodyIdDeprecationField],
	).toContain('name: "@owner/demo"')
	expect(attachKodyIdDeprecationHint({ kody_id: 'demo' }, ['a', 'b'])).toEqual([
		'a',
		'b',
	])
})
