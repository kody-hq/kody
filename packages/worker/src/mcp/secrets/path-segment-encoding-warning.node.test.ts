import { expect, test } from 'vitest'
import {
	buildPathSegmentEncodingWarning,
	credentialValueHasPathRoutingCharacters,
	pathSegmentEncodedCredentialNames,
	pathSegmentEncodingWarningHeaderName,
	withPathSegmentEncodingWarning,
} from './path-segment-encoding-warning.ts'

test('credentialValueHasPathRoutingCharacters detects /, ?, and #', () => {
	expect(credentialValueHasPathRoutingCharacters('token')).toBe(false)
	expect(credentialValueHasPathRoutingCharacters('a/b')).toBe(true)
	expect(credentialValueHasPathRoutingCharacters('a?b')).toBe(true)
	expect(credentialValueHasPathRoutingCharacters('a#b')).toBe(true)
})

test('pathSegmentEncodedCredentialNames lists path fills that encode routing chars', () => {
	const names = pathSegmentEncodedCredentialNames({
		pathname: '/hooks/{{secret:webhookPath}}/events',
		replacements: new Map([
			['{{secret:webhookPath}}', 'T000/B000/xxx'],
			['{{secret:plainToken}}', 'one-segment'],
			['{{secret:other}}', 'a/b'],
		]),
		credentialNames: new Map([
			['{{secret:webhookPath}}', 'webhookPath'],
			['{{secret:plainToken}}', 'plainToken'],
			['{{secret:other}}', 'other'],
		]),
	})
	expect(names).toEqual(['webhookPath'])
})

test('buildPathSegmentEncodingWarning names the credential and status, never a value', () => {
	const warning = buildPathSegmentEncodingWarning('webhookPath', 404)
	expect(warning).toContain('Credential "webhookPath"')
	expect(warning).toContain('404')
	expect(warning).toContain('one encoded segment')
	expect(warning).toContain('%2F')
	expect(warning).toContain('literal path prefix')
	expect(warning).not.toContain('T000')
})

test('withPathSegmentEncodingWarning attaches the header only on 4xx', async () => {
	const ok = withPathSegmentEncodingWarning(
		new Response('ok', { status: 200 }),
		['webhookPath'],
	)
	expect(ok.headers.get(pathSegmentEncodingWarningHeaderName)).toBeNull()

	const missing = withPathSegmentEncodingWarning(
		new Response('gone', { status: 404 }),
		[],
	)
	expect(missing.headers.get(pathSegmentEncodingWarningHeaderName)).toBeNull()

	const failed = withPathSegmentEncodingWarning(
		new Response('gone', { status: 404 }),
		['webhookPath'],
	)
	expect(failed.headers.get(pathSegmentEncodingWarningHeaderName)).toBe(
		buildPathSegmentEncodingWarning('webhookPath', 404),
	)
	expect(await failed.text()).toBe('gone')
})

test('withPathSegmentEncodingWarning strips upstream copies of the header', () => {
	const spoofedOk = withPathSegmentEncodingWarning(
		new Response('ok', {
			status: 200,
			headers: {
				[pathSegmentEncodingWarningHeaderName]: 'spoofed',
			},
		}),
		['webhookPath'],
	)
	expect(spoofedOk.headers.get(pathSegmentEncodingWarningHeaderName)).toBeNull()

	const spoofedEmpty = withPathSegmentEncodingWarning(
		new Response('gone', {
			status: 404,
			headers: {
				[pathSegmentEncodingWarningHeaderName]: 'spoofed',
			},
		}),
		[],
	)
	expect(
		spoofedEmpty.headers.get(pathSegmentEncodingWarningHeaderName),
	).toBeNull()
})
