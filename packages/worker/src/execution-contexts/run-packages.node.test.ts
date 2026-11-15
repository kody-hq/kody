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
		all: ['pkg_a', 'pkg_b', 'pkg_dep'],
	})
})

test('an entry package counts as loaded even when the graph lists no binding for it', () => {
	expect(
		mergeRunPackages(undefined, { entryPackageIds: ['pkg_a'], packageIds: [] }),
	).toEqual({ entries: ['pkg_a'], all: ['pkg_a'] })
})

test('past the cap the set is marked truncated and every entry stays in all', () => {
	const deps = Array.from(
		{ length: maxRunPackagesRecorded },
		(_, i) => `pkg_dep_${i}`,
	)
	const full = mergeRunPackages(undefined, {
		entryPackageIds: ['pkg_a'],
		packageIds: deps,
	})
	expect(full.truncated).toBe(true)
	const later = mergeRunPackages(full, {
		entryPackageIds: ['pkg_late'],
		packageIds: ['pkg_late'],
	})
	expect(later.entries).toEqual(['pkg_a', 'pkg_late'])
	expect(later.all).toHaveLength(maxRunPackagesRecorded)
	expect(later.all).toEqual(expect.arrayContaining(later.entries))
	expect(later.truncated).toBe(true)
})

test('a set under the cap is not marked truncated', () => {
	expect(
		mergeRunPackages(undefined, {
			entryPackageIds: ['pkg_a'],
			packageIds: ['pkg_a', 'pkg_dep'],
		}),
	).not.toHaveProperty('truncated')
})
