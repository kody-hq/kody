import { expect, test } from 'vitest'
import { buildCredentialPatternCheck } from './credential-pattern-check.ts'

const hintsHeading =
	'Optional, if you want a scoped credential type for these (ADR 0068):'
const injectHint =
	"- Header, query, or basic auth placeholders: a Key with an inject (credentialUpdate) can be opened with credential(key), and its client places the value and sends it only to the Key's hosts."
const oauthHint =
	'- Integration token headers: credential(key) for an OAuth connection sends Authorization: Bearer and refreshes the token for you.'
const loginHint =
	'- Password or token exchange bodies: a login credential (secretSet kind "login") runs the exchange on the host and places the session token.'

function manifest(kody: Record<string, unknown> = {}) {
	return JSON.stringify({
		name: '@kody/hints',
		exports: { '.': './src/index.ts' },
		kody: { id: 'hints', description: 'Hints test.', ...kody },
	})
}

function check(source: string, kody: Record<string, unknown> = {}) {
	return buildCredentialPatternCheck({
		'package.json': manifest(kody),
		'src/index.ts': source,
	})
}

function hintLines(text: string) {
	const lines = text.split('\n')
	const index = lines.indexOf(hintsHeading)
	return index === -1 ? [] : lines.slice(index)
}

test('buildCredentialPatternCheck hard-fails non-literal createAuthenticatedFetch', () => {
	const result = check(
		'export const run = (name: string) => createAuthenticatedFetch(name)',
	)
	expect(result.ok).toBe(false)
	expect(result.message).toMatch(/Credential stamp publish gate/)
	expect(result.message).toMatch(/Publish failed/)
	expect(result.message).toMatch(/conversion-ready/)
	expect(result.message).toMatch(/credentials call map/)
})

test('buildCredentialPatternCheck auto-writes missing keys and fails without descriptions', () => {
	const result = check(
		"export const send = () => fetch('https://api.example.com', { headers: { Authorization: 'Bearer {{secret:TOKEN}}' } })",
	)
	expect(result.ok).toBe(false)
	expect(result.stampKeys).toEqual(['TOKEN'])
	expect(result.message).toMatch(/missing a description/)
	expect(result.message).toMatch(/Missing kody.credentials keys/)
	expect(result.message).not.toMatch(/Auto-wrote/)
	const parsed = JSON.parse(result.sourceFiles['package.json']!) as {
		kody: { credentials: Record<string, unknown> }
	}
	expect(parsed.kody.credentials.TOKEN).toEqual({})
})

test('buildCredentialPatternCheck passes when literal uses have descriptions', () => {
	const result = check(
		"export const send = () => fetch('https://api.example.com', { headers: { Authorization: 'Bearer {{secret:TOKEN}}' } })",
		{
			credentials: {
				TOKEN: { kind: 'secret', description: 'API token.' },
			},
		},
	)
	expect(result.ok).toBe(true)
	expect(result.stampKeys).toEqual(['TOKEN'])
	expect(result.message).toMatch(/Credential stamp keys \(sorted\): TOKEN/)
})

test('oauth hints are only Authorization Bearer integration headers', () => {
	// Undeclared slots fail the stamp gate on missing descriptions; hints still
	// appear on the failure message for undeclared placements.
	const otherShapes = check(
		"export const send = () => fetch('https://api.example.com', { headers: { 'X-Token': '{{integration-token:github}}', Authorization: 'Token {{integration-token:gitlab}}', 'X-Api-Key': '{{secret:KEY}}' } })",
	)
	expect(otherShapes.ok).toBe(false)
	expect(hintLines(otherShapes.message)).toEqual([hintsHeading, injectHint])

	const bearer = check(
		"export const gh = () => fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer {{integration-token:github}}', 'X-Token': '{{integration-token:github}}' } })",
	)
	expect(bearer.ok).toBe(false)
	expect(hintLines(bearer.message)).toEqual([hintsHeading, oauthHint])
})

test('secret-basic pairs do not get an inject hint', () => {
	const pair = check(
		"export const send = () => fetch('https://api.example.com', { headers: { Authorization: 'Basic {{secret-basic:username=USER,password=PASS}}' } })",
	)
	expect(pair.ok).toBe(false)
	expect(hintLines(pair.message)).toEqual([])
})

test('login hints require an exchange endpoint and an exact credential field', () => {
	const exchange = check(
		"export const login = () => fetch('https://api.example.com/oauth/token', { method: 'POST', body: JSON.stringify({ pass: '{{secret:PASSWORD}}', refreshToken: '{{secret:REFRESH}}', client_secret: '{{secret:CLIENT}}' }) })",
	)
	expect(exchange.ok).toBe(false)
	expect(hintLines(exchange.message)).toEqual([hintsHeading, loginHint])
})

test('hints skip placeholders a declared slot of the same kind already covers', () => {
	const covered = check(
		[
			"export const send = () => fetch('https://api.example.com', { headers: { Authorization: 'Bearer {{secret:TOKEN}}' } })",
			"export const gh = () => fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer {{integration-token:github}}' } })",
		].join('\n'),
		{
			credentials: {
				TOKEN: { kind: 'secret', provider: 'api', description: 'API token.' },
				github: { kind: 'oauth', provider: 'github', description: 'GitHub.' },
			},
		},
	)
	expect(covered.ok).toBe(true)
	expect(hintLines(covered.message)).toEqual([])
})

const signingHint =
	'- Signing (secretJwtSign or signature key material): a signing credential (secretSet kind "signing") signs through credential(key).sign() without exposing the key.'

test('declared signing keys do not get a signing hint from jwtSignCalls', () => {
	const covered = check(
		"export const sign = () => kody.secretJwtSign({ private_key_secret_name: 'KEY', claims: {} })",
		{
			credentials: {
				KEY: { kind: 'secret', description: 'Signing key.' },
			},
		},
	)
	expect(covered.ok).toBe(true)
	expect(hintLines(covered.message)).toEqual([])
})

test('secretJwtSign with a non-literal key name fails the stamp gate', () => {
	const dynamic = check(
		[
			"const keyName = 'APNS_KEY'",
			'export const sign = () => kody.secretJwtSign({ private_key_secret_name: keyName, claims: {} })',
		].join('\n'),
	)
	expect(dynamic.ok).toBe(false)
	expect(dynamic.message).toMatch(/non-literal/)
	expect(hintLines(dynamic.message)).toEqual([hintsHeading, signingHint])
})

test('large kody.app.assets client bundle does not fail the publish gate', () => {
	const chunk =
		'function x(){eval("1");new Function("return 1");import(n);return 1}'
	const largeClient = `${chunk};`.repeat(
		Math.ceil((1.7 * 1024 * 1024) / (chunk.length + 1)),
	)
	const started = performance.now()
	const result = buildCredentialPatternCheck({
		'package.json': JSON.stringify({
			name: '@kody/world-like',
			exports: { '.': './src/server.ts' },
			kody: {
				id: 'world-like',
				description: 'Large asset regression.',
				app: { entry: './src/server.ts', assets: './public' },
				credentials: {
					API_KEY: { kind: 'secret', description: 'API key.' },
				},
			},
		}),
		'src/server.ts': [
			"import { credential } from 'kody:runtime'",
			'export default {',
			'  async fetch() {',
			'    await credential("API_KEY")',
			'    return new Response("ok")',
			'  },',
			'}',
		].join('\n'),
		'public/client/main.js': largeClient,
	})
	const elapsedMs = performance.now() - started
	expect(result.ok).toBe(true)
	expect(result.stampKeys).toEqual(['API_KEY'])
	expect(result.message).not.toMatch(/server_eval|eval|new Function/)
	expect(elapsedMs).toBeLessThan(2_000)
})

test('manifest-only secretMounts is an ok compat note', () => {
	const result = check(
		[
			"import { credential } from 'kody:runtime'",
			'export default async function wake() {',
			'  return await credential("wakeToken")',
			'}',
		].join('\n'),
		{
			credentials: {
				wakeToken: { kind: 'secret', description: 'Wake token.' },
			},
			secretMounts: {
				wakeToken: { name: 'wakeToken', scope: 'package' },
			},
		},
	)
	expect(result.ok).toBe(true)
	expect(result.message).toContain(
		'kody.secretMounts kept only for stale static dependents: wakeToken. Removing a mount or deleting its secret breaks those dependents.',
	)
	expect(result.message).not.toMatch(/Publish failed/)
})

test('packageSecrets.get still fails the stamp gate when secretMounts remain', () => {
	const result = check(
		[
			"import { packageSecrets } from 'kody:runtime'",
			'export default async function wake() {',
			'  return await packageSecrets.get("wakeToken")',
			'}',
		].join('\n'),
		{
			credentials: {
				wakeToken: { kind: 'secret', description: 'Wake token.' },
			},
			secretMounts: {
				wakeToken: { name: 'wakeToken', scope: 'package' },
			},
		},
	)
	expect(result.ok).toBe(false)
	expect(result.message).toMatch(/packageSecrets\.get/)
	expect(result.message).toMatch(/Publish failed/)
})
