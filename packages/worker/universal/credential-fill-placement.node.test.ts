import { expect, test } from 'vitest'
import {
	defaultFillPlacementDraft,
	fillPlacementDraftFromView,
	fillPlacementViewFromDraft,
	formatFillPlacementSummary,
} from './credential-fill-placement.ts'

test('new credentials draft headers-only', () => {
	expect(defaultFillPlacementDraft()).toEqual({
		headers: true,
		query: false,
		path: false,
		body: false,
		namedHeaders: '',
	})
	expect(fillPlacementViewFromDraft(defaultFillPlacementDraft())).toEqual({
		headers: true,
	})
})

test('anywhere (null) round-trips as all parts checked', () => {
	const draft = fillPlacementDraftFromView(null)
	expect(draft).toEqual({
		headers: true,
		query: true,
		path: true,
		body: true,
		namedHeaders: '',
	})
	expect(fillPlacementViewFromDraft(draft)).toBeNull()
})

test('named headers and summary', () => {
	const placement = fillPlacementViewFromDraft({
		headers: true,
		query: false,
		path: true,
		body: false,
		namedHeaders: 'Authorization, X-Api-Key',
	})
	expect(placement).toEqual({
		headers: ['Authorization', 'X-Api-Key'],
		path: true,
	})
	expect(formatFillPlacementSummary(placement)).toBe(
		'headers (Authorization, X-Api-Key), path',
	)
	expect(formatFillPlacementSummary(null)).toBe(
		'Anywhere (headers, query, path, body)',
	)
})

test('at least one part is required', () => {
	expect(
		fillPlacementViewFromDraft({
			headers: false,
			query: false,
			path: false,
			body: false,
			namedHeaders: '',
		}),
	).toBeNull()
})

test('invalid named headers throw instead of saving as anywhere', () => {
	expect(() =>
		fillPlacementViewFromDraft({
			headers: true,
			query: true,
			path: true,
			body: true,
			namedHeaders: 'Bad Header Name',
		}),
	).toThrow(/header name|RFC 9110/i)
	expect(() =>
		fillPlacementViewFromDraft({
			headers: true,
			query: false,
			path: false,
			body: false,
			namedHeaders: 'not a token!!!',
		}),
	).toThrow(/header name|RFC 9110/i)
	expect(() =>
		fillPlacementViewFromDraft({
			headers: true,
			query: false,
			path: false,
			body: false,
			namedHeaders: ', ,',
		}),
	).toThrow()
	expect(
		fillPlacementViewFromDraft({
			headers: true,
			query: false,
			path: false,
			body: false,
			namedHeaders: '',
		}),
	).toEqual({ headers: true })
})
