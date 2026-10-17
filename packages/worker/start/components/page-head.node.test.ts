import { expect, it } from 'vitest'
import { type RouterManagedTag } from '@tanstack/react-router'
import { mergePageHeadTags } from './page-head.tsx'

it('replaces content metadata while retaining Router assets, nonce, identity and structured data', () => {
	const retained: Array<RouterManagedTag> = [
		{ tag: 'meta', attrs: { property: 'csp-nonce', content: 'request-nonce' } },
		{ tag: 'meta', attrs: { name: 'kody-document-actor', content: 'actor-a' } },
		{
			tag: 'link',
			attrs: {
				rel: 'modulepreload',
				href: '/assets/route.js',
				nonce: 'request-nonce',
			},
		},
		{ tag: 'style', children: 'body{}', attrs: { nonce: 'request-nonce' } },
		{
			tag: 'script',
			attrs: { type: 'application/ld+json' },
			children: '{"name":"Kody"}',
		},
	]
	const tags: Array<RouterManagedTag> = [
		...retained,
		{ tag: 'title', children: 'Old title' },
		{ tag: 'meta', attrs: { name: 'description', content: 'Old description' } },
		{ tag: 'meta', attrs: { property: 'og:title', content: 'Old OG' } },
		{ tag: 'meta', attrs: { name: 'twitter:title', content: 'Old Twitter' } },
		{ tag: 'link', attrs: { rel: 'canonical', href: '/old' } },
		{ tag: 'link', attrs: { rel: 'alternate', href: '/old-feed' } },
	]
	const previous = {
		title: 'Old title',
		links: [{ rel: 'alternate', href: '/old-feed' }],
	}
	const updated = mergePageHeadTags(
		tags,
		{
			title: 'New title',
			description: 'New description',
			canonicalUrl: '/new',
		},
		previous,
	)
	expect(updated).toEqual([
		...retained,
		{ tag: 'title', children: 'New title' },
		{ tag: 'meta', attrs: { name: 'description', content: 'New description' } },
		{ tag: 'link', attrs: { rel: 'canonical', href: '/new' } },
	])
	expect(mergePageHeadTags(tags, { title: 'Not found' }, previous)).toEqual([
		...retained,
		{ tag: 'title', children: 'Not found' },
	])
})
