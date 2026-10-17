import { acquisitionPageSummaries } from '#universal/acquisition/metadata.ts'
import { expect, test } from 'vitest'
import { staticDocumentHead } from './document-head.ts'

test('native route metadata keeps canonical origin, descriptions, social cards and stylesheets', () => {
	const head = staticDocumentHead('featurePackages')({
		match: { pathname: '/features/packages', context: {} },
		matches: [{ loaderData: { canonicalOrigin: 'https://kody.codes' } }],
		params: {},
	})
	expect(head.links).toContainEqual({
		rel: 'canonical',
		href: 'https://kody.codes/features/packages',
	})
	expect(head.links).toContainEqual({
		rel: 'stylesheet',
		href: '/feature-pages.css',
	})
	expect(head.meta).toContainEqual({
		property: 'og:image',
		content: 'https://kody.codes/og/feature-packages.png',
	})
	expect(head.meta).toContainEqual({
		name: 'twitter:card',
		content: 'summary_large_image',
	})
	expect(
		head.meta.some((entry) => 'name' in entry && entry.name === 'description'),
	).toBe(true)
})
test('metadata uses the selected native resolver and route params without rematching the URL', () => {
	const head = staticDocumentHead('profile')({
		match: { pathname: '/another-native-path', context: {} },
		matches: [{ loaderData: { canonicalOrigin: 'https://kody.codes' } }],
		params: { username: 'tanner' },
	})
	expect(head.meta).toContainEqual({ title: '@tanner' })
})

test.each(acquisitionPageSummaries)(
	'acquisition route $key keeps its title, canonical and description',
	(page) => {
		const head = staticDocumentHead(page.key)({
			match: { pathname: page.path, context: {} },
			matches: [{ loaderData: { canonicalOrigin: 'https://kody.codes' } }],
			params: {},
		})
		expect(head.meta).toContainEqual({ title: `${page.title} | Kody` })
		expect(head.meta).toContainEqual({
			name: 'description',
			content: page.description,
		})
		expect(head.links).toContainEqual({
			rel: 'canonical',
			href: `https://kody.codes${page.path}`,
		})
		expect(head.meta).toContainEqual({
			property: 'og:url',
			content: `https://kody.codes${page.path}`,
		})
	},
)
