import { expect, test } from 'vitest'
import { acceptQuality, parseAcceptHeader } from './accept-header.ts'

test('parseAcceptHeader reads ranges and q weights in header order', () => {
	expect(
		parseAcceptHeader('text/html;q=0.5, Application/JSON, */*;q=0'),
	).toEqual([
		{ range: 'text/html', quality: 0.5 },
		{ range: 'application/json', quality: 1 },
		{ range: '*/*', quality: 0 },
	])
})

test('acceptQuality matches whole media ranges, not substrings', () => {
	expect(acceptQuality('text/html;q=0', 'text/html')).toBe(0)
	expect(acceptQuality('application/xtext/html', 'text/html')).toBe(0)
	expect(acceptQuality('text/plain; x=text/html', 'text/html')).toBe(0)
	expect(acceptQuality('text/html;q=0.8', 'text/html')).toBe(0.8)
})
