import { expect, test } from 'vitest'
import { SecretPlacementError } from '#mcp/secrets/secret-placement.ts'
import {
	buildCredentialPlacementRefusedWebhookError,
	formatCredentialPlacementRefusalTag,
	readCredentialPlacementRefusal,
	readCredentialPlacementRefusalFromInvocationBody,
	stripCredentialPlacementRefusalTag,
} from './placement-refusal.ts'

test('a placement refusal round-trips its slot through the error message', () => {
	const error = new SecretPlacementError(
		'Secret "clerkReviewUserId" cannot be sent to host "example.com" over plain HTTP.',
		'clerkReviewUserId',
	)
	expect(error.code).toBe('credential_placement_refused')
	expect(readCredentialPlacementRefusal(`Error: ${error.message}`)).toEqual({
		slot: 'clerkReviewUserId',
		part: null,
	})
	expect(
		readCredentialPlacementRefusal(
			new SecretPlacementError('Vault secret is over plain HTTP.', null)
				.message,
		),
	).toEqual({ slot: null, part: null })
	expect(readCredentialPlacementRefusal('Secret "x" was not found.')).toBeNull()
})

test('a tag never carries a slot outside the name charset', () => {
	expect(formatCredentialPlacementRefusalTag('bad name")')).toBe(
		'(credential_placement_refused)',
	)
})

test('the invocation body reader finds the tag in error.message only', () => {
	expect(
		readCredentialPlacementRefusalFromInvocationBody({
			error: {
				message: 'boom (credential_placement_refused, slot "token")',
			},
		}),
	).toEqual({ slot: 'token', part: null })
	expect(
		readCredentialPlacementRefusalFromInvocationBody({
			logs: ['(credential_placement_refused, slot "token")'],
		}),
	).toBeNull()
	expect(readCredentialPlacementRefusalFromInvocationBody(null)).toBeNull()
})

test('stripping the tag leaves a structured message parseable', () => {
	const message = new SecretPlacementError(
		'Secrets require host approval: {}',
		'token',
	).message
	expect(stripCredentialPlacementRefusalTag(message)).toBe(
		'Secrets require host approval: {}',
	)
	expect(stripCredentialPlacementRefusalTag('no tag here')).toBe('no tag here')
})

test('a fill placement refusal round-trips its refused part', () => {
	const error = new SecretPlacementError(
		'Credential "acmeApiKey" may not fill the body.',
		'acmeApiKey',
		'body',
	)
	expect(error.message).toMatch(
		/\(credential_placement_refused, slot "acmeApiKey", part "body"\)$/,
	)
	expect(readCredentialPlacementRefusal(error.message)).toEqual({
		slot: 'acmeApiKey',
		part: 'body',
	})
	expect(
		readCredentialPlacementRefusal(
			new SecretPlacementError(
				'Vault ref may not fill the query.',
				null,
				'query',
			).message,
		),
	).toEqual({ slot: null, part: 'query' })
	expect(stripCredentialPlacementRefusalTag(error.message)).toBe(
		'Credential "acmeApiKey" may not fill the body.',
	)
	expect(
		readCredentialPlacementRefusal(
			'boom (credential_placement_refused, slot "acmeApiKey", part "cookie")',
		),
	).toBeNull()
})

test('the webhook error names the refused slot and part', () => {
	const withPart = buildCredentialPlacementRefusedWebhookError({
		slot: 'acmeApiKey',
		part: 'body',
	})
	expect(withPart).toMatchObject({
		code: 'credential_placement_refused',
		slot: 'acmeApiKey',
		part: 'body',
	})
	expect(withPart.message).toContain('acmeApiKey')
	expect(withPart.message).toContain('request body')

	const hostOnly = buildCredentialPlacementRefusedWebhookError({
		slot: null,
		part: null,
	})
	expect(hostOnly.code).toBe('credential_placement_refused')
	expect(hostOnly).not.toHaveProperty('slot')
	expect(hostOnly).not.toHaveProperty('part')
	expect(hostOnly.message).not.toContain('acmeApiKey')
	expect(hostOnly.message).not.toContain('request body')
})
