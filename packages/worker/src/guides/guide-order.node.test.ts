import { expect, test } from 'vitest'
import { sortGuidesByAuthoredOrder } from './guide-order.ts'
import { guides as webGuides } from './catalog.ts'

test('sortGuidesByAuthoredOrder throws when a guide is missing from the docs nav', () => {
	const guidesWithUnknownSlug = [
		...webGuides,
		{ ...webGuides[0]!, slug: 'not-in-guide-order' },
	]
	expect(() => sortGuidesByAuthoredOrder(guidesWithUnknownSlug)).toThrow(
		/docs-nav\.ts is missing nav \(or unadvertisedDocSlugs\) entr(?:y|ies) for: not-in-guide-order/,
	)
})

test('sortGuidesByAuthoredOrder throws when the docs nav names a slug with no matching guide', () => {
	const guidesMissingOneEntry = webGuides.filter(
		(guide) => guide.slug !== 'oauth',
	)
	expect(() => sortGuidesByAuthoredOrder(guidesMissingOneEntry)).toThrow(
		/docs-nav\.ts lists entr(?:y|ies) with no matching guide: oauth/,
	)
})
