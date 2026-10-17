import { expect, test } from 'vitest'
import {
	absolutizeDocumentHead,
	resolveDocumentHead,
	NOT_FOUND_DOCUMENT_TITLE,
} from '#universal/document-head.ts'

const featureHeads = {
	'': 'features',
	'/memory': 'featureMemory',
	'/packages': 'featurePackages',
	'/triggers': 'featureTriggers',
	'/credentials': 'featureCredentials',
	'/apps': 'featureApps',
} as const

test.each(['', '/memory', '/packages', '/triggers', '/credentials', '/apps'])(
	'feature page %s has canonical metadata and its stylesheet',
	(suffix) => {
		const path = `/features${suffix}`
		const head = absolutizeDocumentHead(
			resolveDocumentHead(
				featureHeads[suffix as keyof typeof featureHeads],
				path,
			),
			'https://kody.codes',
		)
		expect(head.title).not.toBe(NOT_FOUND_DOCUMENT_TITLE)
		expect(head.description).toBeTruthy()
		expect(head.canonicalUrl).toBe(`https://kody.codes${path}`)
		expect(head.og?.imageUrl).toBe(
			`https://kody.codes/og/${suffix ? `feature-${suffix.slice(1)}` : 'features'}.png`,
		)
		expect(head.links).toContainEqual({
			rel: 'stylesheet',
			href: '/feature-pages.css',
		})
		const sceneLinks = (head.links ?? []).filter((link) =>
			link.href.startsWith('/feature-scenes/'),
		)
		expect(sceneLinks).toEqual(
			suffix === '/credentials'
				? ['secrets', 'integrations'].map((scene) => ({
						rel: 'stylesheet',
						href: `/feature-scenes/${scene}.css`,
					}))
				: suffix
					? [{ rel: 'stylesheet', href: `/feature-scenes${suffix}.css` }]
					: [],
		)
	},
)
