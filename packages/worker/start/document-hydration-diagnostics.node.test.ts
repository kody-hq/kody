import { expect, test } from 'vitest'
import { normalize } from '@sentry/core'
import { documentHydrationDiagnostics } from './document-hydration-diagnostics.ts'

test('reports Emotion style placement counts without document contents', () => {
	const doc = {
		body: {
			querySelectorAll: (selector: string) => {
				if (selector === 'style[data-emotion]') return [1, 2, 3]
				if (selector === 'style[data-emotion]:not([data-s])') return [1, 2]
				return []
			},
		},
		head: {
			querySelectorAll: (selector: string) =>
				selector === 'style[data-emotion]' ? [1] : [],
		},
		defaultView: { location: { pathname: '/oauth/authorize' } },
	} as unknown as Document
	const result = documentHydrationDiagnostics(doc)
	expect(result).toEqual({
		bodyEmotionStyleCount: 3,
		headEmotionStyleCount: 1,
		bodyEmotionUnmarkedCount: 2,
		pathname: '/oauth/authorize',
	})
	expect(normalize({ documentHydration: result }, 3)).toEqual({
		documentHydration: result,
	})
})
