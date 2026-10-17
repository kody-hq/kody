import { expect, test } from 'vitest'
import {
	absolutizeDocumentHead,
	resolveDocumentHead,
} from '#universal/document-head.ts'
import { homeDocumentHead } from './home-document-head.ts'

const base = absolutizeDocumentHead(
	resolveDocumentHead('home', '/'),
	'https://kody.codes',
)
test('home share variants preserve canonical origin and use the shared variant metadata', () => {
	const head = homeDocumentHead(base, 'triggers')
	expect(head?.canonicalUrl).toBe('https://kody.codes/')
	expect(head?.og?.imageUrl).toBe('https://kody.codes/og/home.png?og=triggers')
	expect(head?.og?.title).toBe('Invoke deterministic code from anything')
	expect(base.og?.imageUrl).toBe('https://kody.codes/og/home.png')
})
test('unknown or absent home variants retain the default share card', () => {
	expect(homeDocumentHead(base, 'unknown')).toEqual(base)
	expect(homeDocumentHead(base, undefined)).toEqual(base)
})
