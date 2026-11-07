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

test('the webhook error names the refused part and how to fix it, never a value', () => {
	expect(
		buildCredentialPlacementRefusedWebhookError({
			slot: 'acmeApiKey',
			part: 'body',
		}),
	).toEqual({
		code: 'credential_placement_refused',
		message:
			"The package tried to send a credential (slot \"acmeApiKey\") in the request body, which the credential's fill placement does not allow, so Kody refused the request. The credential's owner can allow it in the credential's fill placement setting, or the package owner can send the credential where it is allowed.",
		slot: 'acmeApiKey',
		part: 'body',
	})
	expect(
		buildCredentialPlacementRefusedWebhookError({ slot: null, part: null }),
	).toEqual({
		code: 'credential_placement_refused',
		message:
			"The package tried to send a credential to a host the credential does not allow, over plain HTTP, or in the URL host, so Kody refused the request. The package owner or the credential's owner needs to fix it.",
	})
})
