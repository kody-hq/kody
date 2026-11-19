import { expect, test } from 'vitest'
import { pathPlacementSchema, preparePathPlacement } from './path-placement.ts'

const placement = pathPlacementSchema.parse({
	kind: 'path',
	origin: 'https://api.example.org',
	method: 'GET',
	packageId: 'pkg-example',
	segments: [
		'teams',
		{ parameter: 'integer' },
		{ credential: true },
		'messages',
	],
})

test('fills only the configured path segment', () => {
	const apply = preparePathPlacement(
		placement,
		new Request('https://api.example.org/teams/42/messages'),
	)
	expect(apply('synthetic-token').url.pathname).toBe(
		'/teams/42/synthetic-token/messages',
	)
	for (const value of ['.', '..', 'a/b', 'a%2fb', 'a?b']) {
		expect(() => apply(value)).toThrow(/not a valid single path segment/)
	}
})

test('refuses a changed origin, route, parameters or method', () => {
	for (const request of [
		new Request('https://api.example.org/teams/42/messages', {
			method: 'POST',
		}),
		new Request('https://api.example.org:444/teams/42/messages'),
		new Request('https://api.example.org/teams/route/messages'),
		new Request('https://api.example.org/teams/42/messages/extra'),
		new Request('https://api.example.org/teams/42/messages?method=delete'),
		new Request('https://api.example.org/teams/42/events'),
	]) {
		expect(() => preparePathPlacement(placement, request)).toThrow(
			/does not match/,
		)
	}
})
