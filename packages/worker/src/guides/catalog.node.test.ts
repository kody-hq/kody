import { expect, test } from 'vitest'
import { getGuideById, getGuideBySlug, guides, listGuides } from './catalog.ts'

test('guide catalog resolves every guide by id and slug and hides admin guides by default', () => {
	expect(new Set(guides.map((guide) => guide.id)).size).toBe(guides.length)
	expect(new Set(guides.map((guide) => guide.slug)).size).toBe(guides.length)
	for (const guide of guides) {
		expect(getGuideBySlug(guide.slug)?.id).toBe(guide.id)
		expect(getGuideById(guide.id)?.slug).toBe(guide.slug)
	}

	const listedIds = (options?: { includeAdmin: boolean }) =>
		listGuides(options).map((guide) => guide.id)
	expect(getGuideById('admin_events')?.adminOnly).toBe(true)
	expect(listedIds()).not.toContain('admin_events')
	expect(listedIds({ includeAdmin: true })).toContain('admin_events')
})
