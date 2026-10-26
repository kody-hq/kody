import { expect, test } from 'vitest'
import {
	buildProviderSecretPlaceholder,
	containsSecretPlaceholder,
	parseProviderSecretPlaceholders,
	parseSecretPlaceholders,
} from '#mcp/secrets/placeholders.ts'
import {
	canonicalizeOpSecretReference,
	isCanonicalProviderRef,
	tryCanonicalizeProviderRef,
} from './canonicalize.ts'
import { providerHostsAllowRequestHost } from './hosts.ts'
import { isSealedSecretProviderExport } from './sealed-export.ts'

test('provider placeholders split on the first colon after secret/ and leave user secrets unchanged', () => {
	const text = [
		'Authorization: Bearer {{secret/1password:i/11111111-1111-4111-8111-111111111111/password}}',
		'X-User: {{secret:githubAccessToken}}',
		'X-Op: {{secret/1password:op://Vault/Item/password}}',
		'X-Scoped: {{secret:token|scope=user}}',
	].join('\n')

	expect(parseSecretPlaceholders(text)).toEqual([
		{ name: 'githubAccessToken', scope: null },
		{ name: 'token', scope: 'user' },
	])
	expect(parseProviderSecretPlaceholders(text)).toEqual([
		{
			provider: '1password',
			ref: 'i/11111111-1111-4111-8111-111111111111/password',
			placeholder:
				'{{secret/1password:i/11111111-1111-4111-8111-111111111111/password}}',
		},
		{
			provider: '1password',
			ref: 'op://Vault/Item/password',
			placeholder: '{{secret/1password:op://Vault/Item/password}}',
		},
	])
	expect(
		buildProviderSecretPlaceholder({
			provider: '1password',
			ref: 'i/11111111-1111-4111-8111-111111111111/password',
		}),
	).toBe('{{secret/1password:i/11111111-1111-4111-8111-111111111111/password}}')
	expect(containsSecretPlaceholder('{{secret/1password:i/x/y}}')).toBe(true)
	expect(containsSecretPlaceholder('{{secret:name}}')).toBe(true)
	expect(
		containsSecretPlaceholder('{{secret-basic:username=a,password=b}}'),
	).toBe(true)
	expect(containsSecretPlaceholder('plain text')).toBe(false)
})

test('angle-bracket example markers make provider placeholders inert', () => {
	for (const text of [
		'{{secret/<provider>:<ref>}}',
		'{{secret/bwvault:i/<item-uuid>/<field>}}',
		'{{secret/1password:i/<item-id>/password}}',
		'{{secret/bwvault:i/%3Citem-uuid%3E/%3Cfield%3E}}',
	]) {
		expect(parseProviderSecretPlaceholders(text)).toEqual([])
		expect(containsSecretPlaceholder(text)).toBe(false)
	}
	// A live vault token without markers still parses; an example beside it does not.
	expect(
		parseProviderSecretPlaceholders(
			'live {{secret/bwvault:i/11111111-1111-4111-8111-111111111111/password}} and example {{secret/bwvault:i/<item-uuid>/<field>}}',
		),
	).toEqual([
		{
			provider: 'bwvault',
			ref: 'i/11111111-1111-4111-8111-111111111111/password',
			placeholder:
				'{{secret/bwvault:i/11111111-1111-4111-8111-111111111111/password}}',
		},
	])
	// Grammar metavariables only (platform docs / error-copy form) are inert.
	expect(parseProviderSecretPlaceholders('{{secret/provider:ref}}')).toEqual([])
	expect(containsSecretPlaceholder('{{secret/provider:ref}}')).toBe(false)
	expect(
		parseProviderSecretPlaceholders('{{secret/provider:i/item-id/field}}'),
	).toEqual([])
	// A concrete provider id with a metavariable-looking ref stays live.
	expect(parseProviderSecretPlaceholders('{{secret/bwvault:ref}}')).toEqual([
		{
			provider: 'bwvault',
			ref: 'ref',
			placeholder: '{{secret/bwvault:ref}}',
		},
	])
})

test('provider placeholder parse keeps the original mixed-case and spaced token', () => {
	const token =
		'{{secret/1Password: i/11111111-1111-4111-8111-111111111111/password }}'
	expect(parseProviderSecretPlaceholders(token)).toEqual([
		{
			provider: '1Password',
			ref: 'i/11111111-1111-4111-8111-111111111111/password',
			placeholder: token,
		},
	])
	expect(
		buildProviderSecretPlaceholder({
			provider: '1Password',
			ref: 'i/11111111-1111-4111-8111-111111111111/password',
			placeholder: token,
		}),
	).toBe(token)
})

test('canonicalize maps op:// UUID synonyms to i/<uuid>/<field> and leaves name-based refs for the provider', () => {
	const itemId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
	expect(tryCanonicalizeProviderRef(`i/${itemId}/password`)).toBe(
		`i/${itemId}/password`,
	)
	expect(tryCanonicalizeProviderRef(`op://Personal/${itemId}/password`)).toBe(
		`i/${itemId}/password`,
	)
	expect(
		canonicalizeOpSecretReference(`op://Work/${itemId}/section/field`),
	).toBe(`i/${itemId}/section/field`)
	expect(tryCanonicalizeProviderRef('op://Vault/Item/password')).toBeNull()
	expect(isCanonicalProviderRef('op://Vault/Item/password')).toBe(false)
	expect(isCanonicalProviderRef(`i/${itemId}/password`)).toBe(true)
})

test('canonicalize accepts 1Password Connect 26-char item ids and rejects invalid ids', () => {
	const connectId = 'tz23g2vsmvctvfdujkxu4ezgie'
	expect(isCanonicalProviderRef(`i/${connectId}/password`)).toBe(true)
	expect(tryCanonicalizeProviderRef(`i/${connectId}/password`)).toBe(
		`i/${connectId}/password`,
	)
	expect(
		tryCanonicalizeProviderRef(`op://Personal/${connectId}/password`),
	).toBe(`i/${connectId}/password`)
	expect(
		canonicalizeOpSecretReference(`op://Work/${connectId}/section/field`),
	).toBe(`i/${connectId}/section/field`)

	expect(isCanonicalProviderRef('i/TZ23G2VSMVCTVFDUJKXU4EZGIE/password')).toBe(
		false,
	)
	expect(isCanonicalProviderRef('i/not-a-valid-id/password')).toBe(false)
	expect(isCanonicalProviderRef('i/tz23g2vsmvctvfdujkxu4ezgi/password')).toBe(
		false,
	)
	expect(isCanonicalProviderRef('i/tz23g2vsmvctvfdujkxu4ezgiex/password')).toBe(
		false,
	)
	expect(tryCanonicalizeProviderRef('i/Item Name/password')).toBeNull()
	expect(tryCanonicalizeProviderRef('op://Vault/Item Name/password')).toBeNull()
})

test('provider host match uses hostname only and empty hosts deny every use', () => {
	expect(
		providerHostsAllowRequestHost(
			['https://app.example.com/login'],
			'app.example.com',
		),
	).toBe(true)
	expect(
		providerHostsAllowRequestHost(
			['https://app.example.com/login'],
			'other.example.com',
		),
	).toBe(false)
	expect(providerHostsAllowRequestHost([], 'app.example.com')).toBe(false)
	expect(providerHostsAllowRequestHost(['https://'], 'app.example.com')).toBe(
		false,
	)
})

test('sealed secret-provider export names are reserved', () => {
	expect(isSealedSecretProviderExport('secretProvider')).toBe(true)
	expect(isSealedSecretProviderExport('./secretProvider')).toBe(true)
	expect(isSealedSecretProviderExport('./run')).toBe(false)
})
