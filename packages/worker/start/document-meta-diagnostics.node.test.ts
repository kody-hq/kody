import { expect, test } from 'vitest'
import { documentMetaDiagnostics } from './document-meta-diagnostics.ts'

test('identifies reordered theme tags and identity differences without reporting values', () => {
	const elements: Record<string, Array<Record<string, string>>> = {
		'meta[charset]': [{ charset: 'utf-8' }],
		'meta[name="viewport"]': [
			{ content: 'width=device-width, initial-scale=1' },
		],
		'meta[name="theme-color"]': [
			{ content: '#111417', media: '(prefers-color-scheme: dark)' },
			{ content: '#e6e8ea', media: '(prefers-color-scheme: light)' },
		],
		'meta[name="kody:canonical-origin"]': [{ content: 'https://kody.codes' }],
		'meta[name="kody-document-actor"]': [{ content: '"private-actor"' }],
	}
	const doc = {
		head: {
			querySelectorAll: (selector: string) =>
				(elements[selector] ?? []).map((attributes) => ({
					getAttribute: (name: string) => attributes[name] ?? null,
				})),
		},
	} as unknown as Document
	const result = documentMetaDiagnostics(doc, {
		actorKey: 'another-private-actor',
		canonicalOrigin: 'https://kody.codes',
	})
	expect(result.find((entry) => entry.name === 'theme-color-light')).toEqual({
		name: 'theme-color-light',
		count: 2,
		index: 0,
		differingAttributes: ['content', 'media'],
	})
	expect(
		result.find((entry) => entry.name === 'document-actor')
			?.differingAttributes,
	).toEqual(['content'])
	expect(JSON.stringify(result)).not.toContain('private-actor')
	expect(JSON.stringify(result)).not.toContain('https://')
	delete elements['meta[name="viewport"]']
	expect(
		documentMetaDiagnostics(doc, undefined).find(
			(entry) => entry.name === 'viewport',
		),
	).toEqual({
		name: 'viewport',
		count: 0,
		index: 0,
		differingAttributes: ['content'],
	})
})
