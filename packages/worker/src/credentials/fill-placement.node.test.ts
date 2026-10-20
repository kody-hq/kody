import { expect, test, vi } from 'vitest'
import {
	credentialFillPlacementSchema,
	defaultNewCredentialFillPlacement,
	fillPlacementAllows,
	fillPlacementAllowsUnderResolution,
	fillPlacementPartLabels,
	fillPlacementRefusalMessage,
	fillPlacementSiteLabel,
	fillSiteFromCredentialInject,
	observeFillPlacementWouldBlock,
	observeFillPlacementWouldBlockSites,
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

test('headers-only resolution intersects and never widens placement', () => {
	const bodyAndHeaders = credentialFillPlacementSchema.parse({
		headers: true,
		body: true,
	})
	expect(
		fillPlacementAllowsUnderResolution(
			bodyAndHeaders,
			{ part: 'body' },
			'headers-only',
		),
	).toBe(false)
	expect(
		fillPlacementAllowsUnderResolution(
			bodyAndHeaders,
			{ part: 'header', name: 'Authorization' },
			'headers-only',
		),
	).toBe(true)
	expect(
		fillPlacementAllowsUnderResolution(null, { part: 'query' }, 'headers-only'),
	).toBe(false)
	expect(
		fillPlacementAllowsUnderResolution(null, { part: 'query' }, 'on'),
	).toBe(true)
	const named = credentialFillPlacementSchema.parse({
		headers: ['X-Api-Key'],
	})
	expect(
		fillPlacementAllowsUnderResolution(
			named,
			{ part: 'header', name: 'Authorization' },
			'headers-only',
		),
	).toBe(false)
})

test('inject maps to fill sites; refusal message names credential and parts', () => {
	expect(
		fillSiteFromCredentialInject({ kind: 'header', name: 'X-Api-Key' }),
	).toEqual({ part: 'header', name: 'X-Api-Key' })
	expect(fillSiteFromCredentialInject({ kind: 'basic' })).toEqual({
		part: 'header',
		name: 'Authorization',
	})
	expect(fillSiteFromCredentialInject({ kind: 'query' })).toEqual({
		part: 'query',
	})
	expect(
		fillPlacementSiteLabel({ part: 'header', name: 'Authorization' }),
	).toBe('header Authorization')
	expect(
		fillPlacementRefusalMessage({
			credentialName: 'apiKey',
			site: { part: 'body' },
			placement: defaultNewCredentialFillPlacement,
		}),
	).toBe('Credential "apiKey" may not fill body. Allowed parts: headers.')
})

test('observe logs would-block without throwing and skips allowed sites', () => {
	const info = vi.spyOn(console, 'info').mockImplementation(() => {})
	try {
		observeFillPlacementWouldBlock({
			credentialName: 'apiKey',
			placement: defaultNewCredentialFillPlacement,
			site: { part: 'header', name: 'Authorization' },
			surface: 'placeholder',
		})
		expect(info).not.toHaveBeenCalled()
		observeFillPlacementWouldBlockSites({
			credentialName: 'apiKey',
			placement: defaultNewCredentialFillPlacement,
			sites: [{ part: 'body' }, { part: 'body' }, { part: 'query' }],
			surface: 'credential-client',
		})
		expect(info).toHaveBeenCalledTimes(2)
		expect(info).toHaveBeenCalledWith(
			'credential-fill-placement-would-block',
			expect.objectContaining({
				credentialName: 'apiKey',
				part: 'body',
				allowedParts: ['headers'],
				surface: 'credential-client',
			}),
		)
		expect(info).toHaveBeenCalledWith(
			'credential-fill-placement-would-block',
			expect.objectContaining({ part: 'query' }),
		)
	} finally {
		info.mockRestore()
	}
})
