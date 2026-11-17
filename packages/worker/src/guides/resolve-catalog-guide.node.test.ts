import { expect, test } from 'vitest'
import { guides } from './catalog.ts'
import {
	guideNotFoundMessage,
	resolveCatalogGuide,
	suggestCatalogGuideIds,
} from './resolve-catalog-guide.ts'

test('resolveCatalogGuide accepts ids, slugs, and merged-doc aliases', () => {
	expect(resolveCatalogGuide(guides, 'package_authoring')?.id).toBe(
		'package_authoring',
	)
	expect(resolveCatalogGuide(guides, 'package-authoring')?.id).toBe(
		'package_authoring',
	)
	expect(resolveCatalogGuide(guides, 'what_can_kody_do')).toEqual({
		id: 'what_is_kody',
	})
	expect(resolveCatalogGuide(guides, 'not_a_real_guide')).toBeNull()
})

test('suggestCatalogGuideIds names one close guide and hides admin guides', () => {
	expect(
		suggestCatalogGuideIds(guides, 'search', { includeAdmin: false }),
	).toEqual(['search_and_execute'])
	expect(
		suggestCatalogGuideIds(guides, 'not_a_real_guide', { includeAdmin: false }),
	).toEqual([])
	expect(
		suggestCatalogGuideIds(guides, 'admin_events', { includeAdmin: false }),
	).toEqual([])
	expect(
		suggestCatalogGuideIds(guides, 'admin-events', { includeAdmin: true }),
	).toEqual(['admin_events'])
})

test('guideNotFoundMessage names the requested id, suggestions, and search', () => {
	expect(guideNotFoundMessage('nope', [])).toBe(
		'Guide "nope" not found. Find guides with `search({ query: "<topic> guide" })`.',
	)
	expect(guideNotFoundMessage('search', ['search_and_execute'])).toBe(
		'Guide "search" not found. Did you mean `guide:search_and_execute`? Find guides with `search({ query: "<topic> guide" })`.',
	)
	expect(guideNotFoundMessage('x', ['a', 'b', 'c'])).toContain(
		'Did you mean `guide:a`, `guide:b`, or `guide:c`?',
	)
})
