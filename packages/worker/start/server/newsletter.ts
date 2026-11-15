import { createServerFn } from '@tanstack/react-start'

export type NewsletterPageError =
	| 'invalid_email'
	| 'rate_limited'
	| 'unavailable'
	| 'invalid_link'

type NewsletterPageStatus = 'sent' | 'confirmed'

export type NewsletterPageData = {
	status: NewsletterPageStatus | null
	error: NewsletterPageError | null
	latest: { slug: string; title: string; description: string } | null
}

const pageErrors = new Set<NewsletterPageError>([
	'invalid_email',
	'rate_limited',
	'unavailable',
	'invalid_link',
])

export const loadNewsletterPage = createServerFn({ method: 'GET' })
	.validator((search: string) => {
		if (
			typeof search !== 'string' ||
			(search !== '' && !search.startsWith('?'))
		)
			throw new Error('Invalid search')
		return search
	})
	.handler(async ({ data: search }): Promise<NewsletterPageData> => {
		const { listBlogCategoryPosts, listBlogPosts } =
			await import('../../src/blog/catalog.ts')
		const params = new URLSearchParams(search)
		const status = params.get('status')
		const error = params.get('error')
		// Product updates are the closest thing to a newsletter issue; fall
		// back to the newest post of any kind.
		const post = listBlogCategoryPosts('updates')[0] ?? listBlogPosts()[0]
		return {
			status: status === 'sent' || status === 'confirmed' ? status : null,
			error: pageErrors.has(error as NewsletterPageError)
				? (error as NewsletterPageError)
				: null,
			latest: post
				? { slug: post.slug, title: post.title, description: post.description }
				: null,
		}
	})
