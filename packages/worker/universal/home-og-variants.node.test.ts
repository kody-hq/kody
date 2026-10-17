import { expect, test } from 'vitest'
import {
	absolutizeDocumentHead,
	resolveDocumentHead,
} from '#universal/document-head.ts'
import {
	getHomeOgVariant,
	locationWithoutHomeOgParam,
	readHomeOgVariant,
} from './home-og-variants.ts'

test('unknown homepage og keys stay off and known doors highlight the right orb', () => {
	expect(getHomeOgVariant(null)).toBeNull()
	expect(getHomeOgVariant('')).toBeNull()
	expect(getHomeOgVariant('Triggers')).toBeNull()
	expect(getHomeOgVariant('not-a-door')).toBeNull()

	expect(getHomeOgVariant('memory')?.highlight).toBe('memory')
	expect(getHomeOgVariant('packages')?.highlight).toBe('packages')
	expect(getHomeOgVariant('integrations')?.highlight).toBe('integrations')
	expect(getHomeOgVariant('apps')?.highlight).toBe('apps')
	expect(getHomeOgVariant('secrets')?.group).toBe('icp')
	expect(getHomeOgVariant('secrets')?.highlight).toBe('integrations')
	for (const id of [
		'triggers',
		'webhooks',
		'email',
		'cron',
		'subscriptions',
	] as const) {
		expect(getHomeOgVariant(id)?.highlight).toBe('triggers')
	}
	for (const id of [
		'switch',
		'cursor-claude',
		'skills',
		'forever',
		'shared',
	] as const) {
		expect(getHomeOgVariant(id)?.highlight).toBeNull()
	}
})

test('?og= rewrites share images and drops the query from the visible url', () => {
	expect(readHomeOgVariant('?og=email&utm_source=youtube')?.id).toBe('email')
	expect(readHomeOgVariant('og=memory')?.id).toBe('memory')
	expect(readHomeOgVariant('?utm_source=youtube')).toBeNull()
	expect(readHomeOgVariant('?og=nope')).toBeNull()
	expect(
		locationWithoutHomeOgParam(
			'https://kody.codes/?utm_source=youtube&og=triggers#invite',
		),
	).toBe('/?utm_source=youtube#invite')
	expect(locationWithoutHomeOgParam('https://kody.codes/?og=skills')).toBe('/')
	expect(locationWithoutHomeOgParam('https://kody.codes/#primitives')).toBe(
		null,
	)
	expect(locationWithoutHomeOgParam('not a url')).toBeNull()

	const switchHead = absolutizeDocumentHead(
		resolveDocumentHead('home', '/', undefined, '?og=switch'),
		'https://kody.codes',
	)
	const cursorHead = absolutizeDocumentHead(
		resolveDocumentHead('home', '/', undefined, '?og=cursor-claude'),
		'https://kody.codes',
	)
	expect(switchHead.og?.imageUrl).toBe(
		'https://kody.codes/og/home.png?og=switch',
	)
	expect(cursorHead.og?.imageUrl).toBe(
		'https://kody.codes/og/home.png?og=cursor-claude',
	)
	expect(switchHead.og?.imageUrl).not.toBe(cursorHead.og?.imageUrl)
	expect(switchHead.og?.title).toBe('Switch agents. Keep the work.')
	expect(switchHead.canonicalUrl).toBe('https://kody.codes/')

	const fallback = absolutizeDocumentHead(
		resolveDocumentHead('home', '/', undefined, '?og=nope'),
		'https://kody.codes',
	)
	const plain = absolutizeDocumentHead(
		resolveDocumentHead('home', '/'),
		'https://kody.codes',
	)
	expect(fallback.og).toEqual(plain.og)
	expect(plain.og?.imageUrl).toBe('https://kody.codes/og/home.png')
})
