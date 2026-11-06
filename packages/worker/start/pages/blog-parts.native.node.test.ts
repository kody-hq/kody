import { jsx } from 'react/jsx-runtime'
import { expect, test } from 'vitest'
import type { BlogPostSummaryLoaderData } from '#universal/loader-data.ts'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { BlogPostList } from './blog-parts.tsx'

function summary(
	slug: string,
	image: Pick<BlogPostSummaryLoaderData, 'image' | 'imageAlt'>,
): BlogPostSummaryLoaderData {
	return {
		slug,
		title: `Title ${slug}`,
		date: '2026-08-20',
		updated: null,
		description: `Description ${slug}`,
		category: 'essays',
		series: null,
		readingMinutes: 3,
		...image,
	}
}

test('post rows render a lazy thumbnail with the alt only when the post sets an image', async () => {
	const html = await renderStartPage(
		jsx(BlogPostList, {
			posts: [
				summary('with-art', {
					image: '/images/openclaw-2-needs-a-home.webp',
					imageAlt: 'Kody hugs OpenClaw.',
				}),
				summary('plain', { image: null, imageAlt: null }),
				summary('art-no-alt', {
					image: '/images/openclaw-2-needs-a-home.webp',
					imageAlt: null,
				}),
			],
		}),
		'/blog',
	)
	const rows = html.split('<li').slice(1)
	expect(rows).toHaveLength(3)
	const [withArt, plain, artNoAlt] = rows as [string, string, string]
	expect(withArt).toContain('href="/blog/with-art"')
	expect(withArt).toContain('Title with-art')
	expect(withArt).toMatch(
		/<img[^>]*src="[^"]*\/images\/openclaw-2-needs-a-home\.webp"[^>]*alt="Kody hugs OpenClaw\."[^>]*>/,
	)
	expect(withArt).toMatch(/<img[^>]*loading="lazy"[^>]*decoding="async"/)
	expect(withArt).toMatch(/<img[^>]*width="112"[^>]*height="112"/)
	expect(plain).toContain('href="/blog/plain"')
	expect(plain).toContain('Title plain')
	expect(plain).not.toContain('<img')
	expect(artNoAlt).toContain('href="/blog/art-no-alt"')
	expect(artNoAlt).not.toContain('<img')
})
