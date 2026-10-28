import { expect, test } from 'vitest'
import { normalizePlacementApprovalParts } from '#universal/credential-placement-approval.ts'
import {
	buildCredentialPlacementApprovalUrl,
	buildCredentialPlacementSettingUrl,
} from './placement-approval-links.ts'

test('placement parts normalize to known opt-in parts in canonical order', () => {
	expect(
		normalizePlacementApprovalParts(['body,QUERY', 'headers', 'url-path', 'x']),
	).toEqual(['query', 'path', 'body'])
	expect(normalizePlacementApprovalParts(['headers'])).toEqual([])
})

test('the approval link names the credential, parts, hosts, and org', () => {
	const url = new URL(
		buildCredentialPlacementApprovalUrl({
			baseUrl: 'https://kody.codes',
			names: ['plaidSecret'],
			parts: ['body'],
			hosts: ['https://production.plaid.com/item/get'],
			orgSlug: 'kentcdodds',
		}),
	)
	expect(url.pathname).toBe('/connect/secrets')
	expect(url.searchParams.get('name')).toBe('plaidSecret')
	expect(url.searchParams.get('placement')).toBe('body')
	expect(url.searchParams.get('hosts')).toBe('production.plaid.com')
	expect(url.searchParams.get('org')).toBe('kentcdodds')
})

test('the approval link works without hosts and rejects an empty request', () => {
	const url = new URL(
		buildCredentialPlacementApprovalUrl({
			baseUrl: 'https://kody.codes',
			names: ['a', 'b'],
			parts: ['query', 'body'],
		}),
	)
	expect(url.searchParams.get('names')).toBe('a,b')
	expect(url.searchParams.has('hosts')).toBe(false)
	expect(url.searchParams.get('placement')).toBe('query,body')
	expect(() =>
		buildCredentialPlacementApprovalUrl({
			baseUrl: 'https://kody.codes',
			names: ['a'],
			parts: ['headers'],
		}),
	).toThrow(/placement part/)
})

test('the setting link opens the credential page at its fill placement', () => {
	expect(
		buildCredentialPlacementSettingUrl({
			baseUrl: 'https://kody.codes',
			orgSlug: 'kentcdodds',
			credentialId: 'cred_123',
		}),
	).toBe('https://kody.codes/@kentcdodds/-/credentials/cred_123#fill-placement')
})
