import { expect, test } from 'vitest'
import {
	acceptQuality,
	negotiatedAcceptQuality,
	parseAcceptHeader,
} from './accept-header.ts'

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

test('parseAcceptHeader keeps quoted commas and semicolons inside parameters', () => {
	expect(
		parseAcceptHeader(
			'application/json;profile="a, text/html; q=1", text/plain',
		),
	).toEqual([
		{ range: 'application/json', quality: 1 },
		{ range: 'text/plain', quality: 1 },
	])
	expect(acceptQuality('application/json;x="a,text/html"', 'text/html')).toBe(0)
})

test('negotiatedAcceptQuality prefers the most specific matching range', () => {
	expect(
		negotiatedAcceptQuality(
			'application/*;q=1, text/html;q=0.5',
			'application/json',
		),
	).toBe(1)
	expect(
		negotiatedAcceptQuality(
			'application/*;q=0.2, application/json;q=0.9',
			'application/json',
		),
	).toBe(0.9)
	expect(negotiatedAcceptQuality('*/*;q=0.3', 'text/html')).toBe(0.3)
	expect(negotiatedAcceptQuality('text/plain', 'text/html')).toBe(0)
})
