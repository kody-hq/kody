import { expect, test } from 'vitest'
import {
	credentialCompositionSchema,
	prepareCredentialComposition,
} from './credential-composition.ts'

const endpoint = 'https://api.example.com/resource'
const target = {
	kind: 'composition',
	packageId: 'package',
	endpoint,
	method: 'POST',
	entryCredentialId: 'one',
}

test('composition emits two-secret Basic auth, cookies, and a query credential', async () => {
	const profile = credentialCompositionSchema.parse({
		...target,
		sites: [
			{ kind: 'basic', usernameId: 'one', passwordId: 'two' },
			{
				kind: 'header',
				name: 'Cookie',
				parts: ['a=', { credentialId: 'one' }, '; b=', { credentialId: 'two' }],
			},
			{ kind: 'query', param: 'token', credentialId: 'three' },
		],
	})
	const values = new Map([
		['one', 'user'],
		['two', 'pass'],
		['three', 'token+1'],
	])
	const apply = await prepareCredentialComposition(
		profile,
		new Request(endpoint, {
			method: 'POST',
			headers: { 'X-HTTP-Method-Override': 'DELETE' },
		}),
	)
	const result = apply(values)
	expect(result).toMatchObject({
		placement: { kind: 'composition', sealed: false },
	})
	if (result.placement.kind !== 'composition')
		throw new Error('Expected composition')
	expect(result.placement.headers.get('authorization')).toBe(
		'Basic dXNlcjpwYXNz',
	)
	expect(result.placement.headers.get('cookie')).toBe('a=user; b=pass')
	expect(result.placement.headers.has('X-HTTP-Method-Override')).toBe(false)
	expect(result.placement.url.href).toBe(endpoint + '?token=token%2B1')
	expect(result.substitutedValues).toContain('dXNlcjpwYXNz')

	for (const url of [
		endpoint + '?token=override',
		'https://other.example/resource',
	]) {
		await expect(
			prepareCredentialComposition(
				profile,
				new Request(url, { method: 'POST' }),
			),
		).rejects.toThrow('does not match')
	}
	await expect(
		prepareCredentialComposition(profile, new Request(endpoint)),
	).rejects.toThrow('does not match')
	await expect(
		prepareCredentialComposition(
			profile,
			new Request(endpoint, {
				method: 'POST',
				headers: { cookie: 'override' },
			}),
		),
	).rejects.toThrow('distinct')
})

test('composition refuses duplicate locations case-insensitively and Basic auth collisions', async () => {
	const profile = credentialCompositionSchema.parse({
		...target,
		sites: [
			{ kind: 'basic', usernameId: 'one', passwordId: 'two' },
			{
				kind: 'header',
				name: 'AUTHORIZATION',
				parts: [{ credentialId: 'one' }],
			},
		],
	})
	await expect(
		prepareCredentialComposition(
			profile,
			new Request(endpoint, { method: 'POST' }),
		),
	).rejects.toThrow('distinct')
})

test('two-Key Basic auth can carry an explicitly approved public JSON body', async () => {
	const profile = credentialCompositionSchema.parse({
		...target,
		sites: [{ kind: 'basic', usernameId: 'one', passwordId: 'two' }],
	})
	const jsonRequest = (contentType = 'application/json') =>
		new Request(endpoint, {
			method: 'POST',
			headers: { 'content-type': contentType },
			body: '{"limit":10}',
		})
	await expect(
		prepareCredentialComposition(profile, jsonRequest()),
	).rejects.toThrow('explicitly approve')
	const approved = credentialCompositionSchema.parse({
		...profile,
		publicBody: 'application/json',
	})
	const apply = await prepareCredentialComposition(approved, jsonRequest())
	const { placement } = apply(
		new Map([
			['one', 'user'],
			['two', 'pass'],
		]),
	)
	expect(placement).toMatchObject({ kind: 'composition', body: '{"limit":10}' })
	if (placement.kind !== 'composition') throw new Error('Expected composition')
	expect(placement.headers.get('content-type')).toBe('application/json')
	expect(placement.headers.get('authorization')).toBe('Basic dXNlcjpwYXNz')
	await expect(
		prepareCredentialComposition(approved, jsonRequest('text/plain')),
	).rejects.toThrow('application/json')
})
