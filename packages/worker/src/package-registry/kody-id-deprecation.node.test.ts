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
		buildKodyIdDeprecationHint(
			{
				name: '@owner/demo',
				package_id: 'pkg-uuid',
			},
			{ kody_id: 'demo' },
		),
	).toContain('name: "@owner/demo"')
	expect(
		buildKodyIdDeprecationHint(
			{
				name: '@owner/demo',
				package_id: 'pkg-uuid',
			},
			{ kody_id: 'demo' },
		),
	).toContain('package_id: "pkg-uuid"')
	expect(buildKodyIdDeprecationHint({}, { kody_id: 'demo' })).toContain(
		'Prefer `name`',
	)
	expect(buildKodyIdDeprecationHint({}, { kody_id: 'demo' })).toContain(
		'Stop sending `kody_id`',
	)
})

test('camelCase leftover callers are steered to packageId', () => {
	const hint = buildKodyIdDeprecationHint(
		{
			webhooks: [
				{ name: 'sentry', package_name: '@owner/hook', package_id: 'hook-id' },
			],
		},
		{ kodyId: 'hook' },
	)
	expect(hint).toContain('packageId: "hook-id"')
	expect(hint).toContain('Stop sending `kodyId`')
	expect(hint).not.toContain('name: "sentry"')
})

test('communityFork leftover kody_id hints to omit rather than name/package_id', () => {
	const hint = buildKodyIdDeprecationHint(
		{
			fork_id: 'fork-1',
			package_id: 'pkg-1',
			target_name: '@owner/leaf',
		},
		{ listing_id: 'listing-1', kody_id: 'leaf' },
	)
	expect(hint).toContain('Omit `kody_id`')
	expect(hint).not.toContain('Prefer `name`')
	expect(hint).toContain('@owner/leaf')
})

test('repo package targets prefer target.package_id after alias normalization', () => {
	const hint = buildKodyIdDeprecationHint(
		{
			session_id: 'session-1',
			resolved_target: {
				kind: 'package',
				package_id: 'pkg-1',
				name: '@owner/demo',
				kody_id: 'demo',
			},
		},
		// Post-preprocess shape: camelCase kodyId already became kody_id.
		{ target: { kind: 'package', kody_id: 'demo' } },
	)
	expect(hint).toContain('target: { kind: "package", package_id }')
	expect(hint).toContain('package_id: "pkg-1"')
	expect(hint).not.toContain('Prefer `name`')
})

test('ambiguous webhook leaves omit concrete package values', () => {
	expect(
		resolvePreferredPackageIdentity(
			{
				webhooks: [
					{
						name: 'a',
						package_name: '@owner/one',
						package_id: 'pkg-1',
						package_kody_id: 'shared',
					},
					{
						name: 'b',
						package_name: '@other/two',
						package_id: 'pkg-2',
						package_kody_id: 'shared',
					},
				],
			},
			{ kodyId: 'shared' },
		),
	).toEqual({ name: undefined, packageId: undefined })
})

test('singular minted webhook does not treat webhook name as package name', () => {
	expect(
		resolvePreferredPackageIdentity(
			{
				webhook: {
					package_id: 'pkg-1',
					package_kody_id: 'demo',
					name: 'sentry',
					endpoint_id: 'ep-1',
					handle: 'handle-1',
				},
			},
			{ kodyId: 'demo' },
		),
	).toEqual({ name: undefined, packageId: 'pkg-1' })
	const hint = buildKodyIdDeprecationHint(
		{
			webhook: {
				package_id: 'pkg-1',
				package_kody_id: 'demo',
				name: 'sentry',
				endpoint_id: 'ep-1',
				handle: 'handle-1',
			},
		},
		{ kodyId: 'demo' },
	)
	expect(hint).toContain('packageId: "pkg-1"')
	expect(hint).not.toContain('name: "sentry"')
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

test('resolvePreferredPackageIdentity ignores session id and webhook name', () => {
	expect(
		resolvePreferredPackageIdentity({
			id: 'session-uuid',
			session_id: 'session-uuid',
			resolved_target: {
				kind: 'package',
				package_id: 'pkg-1',
				name: '@owner/demo',
				kody_id: 'demo',
			},
		}),
	).toEqual({ name: '@owner/demo', packageId: 'pkg-1' })
	expect(
		resolvePreferredPackageIdentity({
			webhooks: [
				{
					name: 'inbound-hook',
					package_name: '@owner/bridge',
					package_id: 'bridge-id',
				},
			],
		}),
	).toEqual({ name: '@owner/bridge', packageId: 'bridge-id' })
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
