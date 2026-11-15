import { expect, test } from 'vitest'
import { maxRunPackagesRecorded, mergeRunPackages } from './run-packages.ts'

test('a later package graph only adds to what the run already loaded', () => {
	const first = mergeRunPackages(undefined, {
		entryPackageIds: ['pkg_a'],
		packageIds: ['pkg_a', 'pkg_dep'],
	})
	expect(first).toEqual({ entries: ['pkg_a'], all: ['pkg_a', 'pkg_dep'] })
	expect(
		mergeRunPackages(first, {
			entryPackageIds: ['pkg_b', 'pkg_a'],
			packageIds: ['pkg_b'],
		}),
	).toEqual({
		entries: ['pkg_a', 'pkg_b'],
		all: ['pkg_a', 'pkg_dep', 'pkg_b'],
	})
})

test('an entry package counts as loaded even when the graph lists no binding for it', () => {
	expect(
		mergeRunPackages(undefined, { entryPackageIds: ['pkg_a'], packageIds: [] }),
	).toEqual({ entries: ['pkg_a'], all: ['pkg_a'] })
})

test('the recorded set is capped', () => {
	const many = Array.from(
		{ length: maxRunPackagesRecorded + 50 },
		(_, i) => `pkg_${i}`,
	)
	const merged = mergeRunPackages(undefined, {
		entryPackageIds: many,
		packageIds: many,
	})
	expect(merged.entries).toHaveLength(maxRunPackagesRecorded)
	expect(merged.all).toHaveLength(maxRunPackagesRecorded)
})
