import { expect, test } from 'vitest'
import { bodyPlacementSchema, prepareBodyPlacement } from './body-placement.ts'

const endpoint = 'https://api.example.com/resources/approved'
const config = {
	kind: 'body',
	packageId: 'approved-package',
	endpoint,
	method: 'PUT',
	mediaType: 'application/json',
	fields: [['variables', 'updates', 0, 'value']],
	selectors: [
		{ path: ['variables', 'resource'], value: 'approved-resource' },
		{ path: ['variables', 'updates', 0, 'name'], value: 'approved-field' },
	],
	graphql: {
		document:
			'mutation Set($resource: ID!, $updates: [Update!]!) { set(resource: $resource, updates: $updates) { ok } }',
		operationName: 'Set',
	},
} as const

const approved = bodyPlacementSchema.parse(config)
const validBody =
	'{"variables":{"resource":"approved-resource","updates":[{"name":"approved-field"}]}}'

function outbound(
	body: string,
	url = endpoint,
	method = 'PUT',
	headers = { 'content-type': 'application/json' },
) {
	return new Request(url, { method, headers, body })
}

test('fills only the pinned GraphQL field and uses the owner operation', async () => {
	const place = await prepareBodyPlacement(approved, outbound(validBody))
	const value = 'synthetic"\nvalue'
	const wire = place(value)
	expect(JSON.parse(wire.body)).toEqual({
		query: config.graphql.document,
		operationName: config.graphql.operationName,
		variables: {
			resource: 'approved-resource',
			updates: [{ name: 'approved-field', value }],
		},
	})
	expect(wire.substitutedValues).toEqual([value])
})

test.each([
	[
		'wrong origin',
		() => outbound(validBody, 'https://other.example.com/resources/approved'),
	],
	[
		'wrong endpoint',
		() => outbound(validBody, 'https://api.example.com/resources/other'),
	],
	['dynamic query', () => outbound(validBody, `${endpoint}?resource=other`)],
	['wrong method', () => outbound(validBody, endpoint, 'POST')],
	[
		'wrong media type',
		() =>
			outbound(validBody, endpoint, 'PUT', { 'content-type': 'text/plain' }),
	],
	[
		'wrong resource',
		() => outbound(validBody.replace('approved-resource', 'other-resource')),
	],
	[
		'wrong field',
		() => outbound(validBody.replace('approved-field', 'other-field')),
	],
	[
		'duplicate key',
		() =>
			outbound(
				validBody.replace(
					'"resource":',
					'"resource":"other","res\\u006furce":',
				),
			),
	],
	[
		'caller operation',
		() =>
			outbound(
				validBody.replace(
					'{"variables":',
					'{"query":"unapproved","variables":',
				),
			),
	],
	[
		'caller value',
		() => outbound(validBody.replace('"name":', '"value":null,"name":')),
	],
	[
		'ambiguous parent',
		() =>
			outbound(
				validBody
					.replace('"updates":[', '"updates":{"0":[')
					.replace(']}}', ']}}}'),
			),
	],
	['body overflow', () => outbound(validBody + ' '.repeat(256 * 1024))],
])('refuses %s', async (_, request) => {
	await expect(prepareBodyPlacement(approved, request())).rejects.toMatchObject(
		{
			code: 'invalid_request',
		},
	)
})

test('rejects overlapping paths and encoded endpoints at approval time', () => {
	expect(
		bodyPlacementSchema.safeParse({
			...config,
			fields: [...config.fields, ['variables', 'updates']],
		}).success,
	).toBe(false)
	expect(
		bodyPlacementSchema.safeParse({
			...config,
			endpoint: 'https://api.example.com/resources/%2fapproved',
		}).success,
	).toBe(false)
})

test('sets only the approved key id with sealed-box output, never plaintext', async () => {
	const encrypted = bodyPlacementSchema.parse({
		...config,
		output: {
			format: 'sealed-box-base64',
			keyIdField: ['variables', 'keyId'],
			recipientKeyId: 'approved-key',
			recipientPublicKey: 'NYBy1jZYgNGu6jKa35EhODhR7SGijjt16WXQ0s0WYlQ=',
		},
	})
	const place = await prepareBodyPlacement(encrypted, outbound(validBody))
	const value = 'synthetic plaintext'
	const wire = place(value)
	expect(wire.sealed).toBe(true)
	expect(wire.body).not.toContain(value)
	const variables = JSON.parse(wire.body).variables
	expect(variables.keyId).toBe('approved-key')
	expect(wire.substitutedValues).toEqual([value, variables.updates[0].value])
	await expect(
		prepareBodyPlacement(
			encrypted,
			outbound(
				validBody.replace('"resource":', '"keyId":"caller-key","resource":'),
			),
		),
	).rejects.toMatchObject({ code: 'invalid_request' })
})
