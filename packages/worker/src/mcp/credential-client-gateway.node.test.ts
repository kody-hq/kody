import { expect, test } from 'vitest'
import {
	applyCredentialClientPlacement,
	withoutCodePlacement,
} from './credential-client-gateway.ts'

const urlPlacement = {
	kind: 'url' as const,
	url: new URL('https://hooks.example.com/secret-token/v1/send?x=1'),
}

test('a url placement expands the code request against the host it is really sent to', () => {
	const stripped = withoutCodePlacement(
		new Request('https://api.code.example/v1/send?x=1', {
			headers: { 'x-extra': '{{secret:only-on-code-host}}' },
		}),
		urlPlacement,
	)
	expect(stripped.url).toBe('https://hooks.example.com/v1/send?x=1')
	expect(stripped.headers.get('x-extra')).toBe('{{secret:only-on-code-host}}')

	const placed = applyCredentialClientPlacement(
		stripped,
		urlPlacement,
		stripped,
	)
	expect(placed.url).toBe(urlPlacement.url.href)
	expect(placed.redirect).toBe('manual')
})

test('a url placement refuses a path that a placeholder changed', () => {
	const stripped = withoutCodePlacement(
		new Request('https://hooks.example.com/{{secret:path}}'),
		urlPlacement,
	)
	expect(() =>
		applyCredentialClientPlacement(
			new Request('https://hooks.example.com/expanded'),
			urlPlacement,
			stripped,
		),
	).toThrow(/\[invalid_request\]/)
})

test('header and query placements replace the code value of the same name', () => {
	const header = { kind: 'header' as const, name: 'X-Api-Key', value: 'k' }
	const strippedHeader = withoutCodePlacement(
		new Request('https://api.example.com/', {
			headers: { 'X-Api-Key': '{{secret:other}}', 'x-keep': '1' },
		}),
		header,
	)
	expect(strippedHeader.headers.has('x-api-key')).toBe(false)
	expect(strippedHeader.headers.get('x-keep')).toBe('1')
	const placedHeader = applyCredentialClientPlacement(
		strippedHeader,
		header,
		strippedHeader,
	)
	expect(placedHeader.headers.get('x-api-key')).toBe('k')

	const query = { kind: 'query' as const, param: 'api_key', value: 'k' }
	const strippedQuery = withoutCodePlacement(
		new Request('https://api.example.com/v1?api_key={{secret:other}}&x=1'),
		query,
	)
	expect(new URL(strippedQuery.url).searchParams.has('api_key')).toBe(false)
	const placedQuery = new URL(
		applyCredentialClientPlacement(strippedQuery, query, strippedQuery).url,
	)
	expect(placedQuery.searchParams.get('api_key')).toBe('k')
	expect(placedQuery.searchParams.get('x')).toBe('1')
})
