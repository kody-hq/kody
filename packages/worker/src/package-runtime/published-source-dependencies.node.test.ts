import { expect, test } from 'vitest'
import {
	assertPublishedSourceCanRebuildWithoutInstallingDeps,
	canKeepPreviousNpmBundleDuringRebuild,
	isPublishedRuntimeBundleMissingError,
	isPublishedSourceWithinNpmBundleRebuildWindow,
	publishedNpmBundleRebuildWindowMs,
	publishedRuntimeBundleMissingMessage,
} from './published-source-dependencies.ts'

test('npm rebuild window uses publishedAt and ignores missing timestamps', () => {
	const nowMs = Date.parse('2026-10-05T00:04:00.000Z')
	expect(
		isPublishedSourceWithinNpmBundleRebuildWindow({
			publishedAt: '2026-10-05T00:03:00.000Z',
			nowMs,
		}),
	).toBe(true)
	expect(
		isPublishedSourceWithinNpmBundleRebuildWindow({
			publishedAt: new Date(
				nowMs - publishedNpmBundleRebuildWindowMs - 1,
			).toISOString(),
			nowMs,
		}),
	).toBe(false)
	expect(
		isPublishedSourceWithinNpmBundleRebuildWindow({
			publishedAt: null,
			nowMs,
		}),
	).toBe(false)
})

test('keep-previous treats a missing finalize clock as still in the rebuild window', () => {
	const nowMs = Date.parse('2026-10-05T00:04:00.000Z')
	expect(
		canKeepPreviousNpmBundleDuringRebuild({
			publishedAt: null,
			nowMs,
		}),
	).toBe(true)
	expect(
		canKeepPreviousNpmBundleDuringRebuild({
			publishedAt: '2026-10-05T00:03:00.000Z',
			nowMs,
		}),
	).toBe(true)
	expect(
		canKeepPreviousNpmBundleDuringRebuild({
			publishedAt: new Date(
				nowMs - publishedNpmBundleRebuildWindowMs - 1,
			).toISOString(),
			nowMs,
		}),
	).toBe(false)
})

test('isPublishedRuntimeBundleMissingError matches the assert message only', () => {
	expect(isPublishedRuntimeBundleMissingError(null)).toBe(false)
	expect(isPublishedRuntimeBundleMissingError(new Error('other'))).toBe(false)
	expect(() =>
		assertPublishedSourceCanRebuildWithoutInstallingDeps({
			sourceFiles: {
				'package.json': JSON.stringify({
					dependencies: { kleur: '^4.1.5' },
				}),
			},
			bundleLabel: 'Saved package app "example"',
		}),
	).toThrow(publishedRuntimeBundleMissingMessage)
	try {
		assertPublishedSourceCanRebuildWithoutInstallingDeps({
			sourceFiles: {
				'package.json': JSON.stringify({
					dependencies: { kleur: '^4.1.5' },
				}),
			},
			bundleLabel: 'Saved package app "example"',
		})
	} catch (error) {
		expect(isPublishedRuntimeBundleMissingError(error)).toBe(true)
	}
})
