import { expect, test } from 'vitest'
import {
	credentialFillPlacementSchema,
	defaultNewCredentialFillPlacement,
	fillPlacementAllows,
	fillPlacementPartLabels,
	readCredentialFillPlacement,
	serializeCredentialFillPlacement,
} from './fill-placement.ts'

test('null placement means anywhere', () => {
	expect(readCredentialFillPlacement(null)).toBeNull()
	expect(readCredentialFillPlacement(undefined)).toBeNull()
	expect(readCredentialFillPlacement('')).toBeNull()
	expect(readCredentialFillPlacement('null')).toBeNull()
	expect(fillPlacementAllows(null, { part: 'body' })).toBe(true)
	expect(fillPlacementAllows(null, { part: 'header', name: 'X-Api-Key' })).toBe(
		true,
	)
	expect(fillPlacementPartLabels(null)).toEqual([
		'headers',
		'query',
		'path',
		'body',
	])
})

test('headers-only default for new credentials', () => {
	expect(defaultNewCredentialFillPlacement).toEqual({ headers: true })
	expect(
		fillPlacementAllows(defaultNewCredentialFillPlacement, {
			part: 'header',
			name: 'Authorization',
		}),
	).toBe(true)
	expect(
		fillPlacementAllows(defaultNewCredentialFillPlacement, { part: 'body' }),
	).toBe(false)
	expect(
		fillPlacementAllows(defaultNewCredentialFillPlacement, { part: 'query' }),
	).toBe(false)
	expect(
		fillPlacementAllows(defaultNewCredentialFillPlacement, { part: 'path' }),
	).toBe(false)
})

test('named headers are case-insensitive', () => {
	const placement = credentialFillPlacementSchema.parse({
		headers: ['Authorization', 'X-Api-Key'],
	})
	expect(
		fillPlacementAllows(placement, { part: 'header', name: 'authorization' }),
	).toBe(true)
	expect(
		fillPlacementAllows(placement, { part: 'header', name: 'x-api-key' }),
	).toBe(true)
	expect(
		fillPlacementAllows(placement, { part: 'header', name: 'X-Other' }),
	).toBe(false)
})

test('query path and body flags', () => {
	const placement = credentialFillPlacementSchema.parse({
		query: true,
		path: true,
		body: true,
	})
	expect(fillPlacementAllows(placement, { part: 'query' })).toBe(true)
	expect(fillPlacementAllows(placement, { part: 'path' })).toBe(true)
	expect(fillPlacementAllows(placement, { part: 'body' })).toBe(true)
	expect(
		fillPlacementAllows(placement, { part: 'header', name: 'Authorization' }),
	).toBe(false)
	expect(fillPlacementPartLabels(placement)).toEqual(['query', 'path', 'body'])
})

test('schema refuses an empty object and invalid header names', () => {
	expect(credentialFillPlacementSchema.safeParse({}).success).toBe(false)
	expect(
		credentialFillPlacementSchema.safeParse({ headers: ['Bad Name'] }).success,
	).toBe(false)
	expect(credentialFillPlacementSchema.safeParse({ headers: [] }).success).toBe(
		false,
	)
})

test('serialize round-trips', () => {
	const placement = { headers: true as const, body: true as const }
	const json = serializeCredentialFillPlacement(placement)
	expect(json).toBe('{"headers":true,"body":true}')
	expect(readCredentialFillPlacement(json)).toEqual(placement)
	expect(serializeCredentialFillPlacement(null)).toBeNull()
})

test('invalid stored JSON is treated as anywhere', () => {
	expect(readCredentialFillPlacement('{')).toBeNull()
	expect(readCredentialFillPlacement('{"headers":false}')).toBeNull()
})
