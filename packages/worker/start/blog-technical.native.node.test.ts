import { jsx } from 'react/jsx-runtime'
import { expect, test } from 'vitest'
import type { BlogCategoryLoaderData } from '#universal/loader-data.ts'
import { BlogCategoryRoute } from './pages/blog-category.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'

function categoryData(
	slug: BlogCategoryLoaderData['slug'],
): BlogCategoryLoaderData {
	return {
		ok: true,
		slug,
		label: slug,
		description: 'Description.',
		categories: [
			{ slug: 'stories', label: 'Customer stories', count: 1 },
			{ slug: 'technical', label: 'Technical', count: 1 },
		],
		posts: [],
	}
}

test('the technical archive gets the ~/blog/technical breadcrumb; other categories keep the back link', async () => {
	const technical = await renderStartPage(
		jsx(BlogCategoryRoute, { data: categoryData('technical') }),
		'/blog/category/technical',
	)
	expect(technical).toContain('aria-label="Breadcrumb"')
	expect(technical).toContain('~/blog')
	expect(technical).not.toContain('← Blog')

	const stories = await renderStartPage(
		jsx(BlogCategoryRoute, { data: categoryData('stories') }),
		'/blog/category/stories',
	)
	expect(stories).not.toContain('aria-label="Breadcrumb"')
	expect(stories).toContain('← Blog')
})
