import { expect, test } from 'vitest'
import {
	isVaultCredentialUsePlacement,
	scanPackageCredentials,
	type CredentialPlacement,
} from './credential-inventory-scan.ts'

function other(
	context: string,
	key: string | null = null,
	callee: string | null = null,
) {
	return { type: 'other', context, key, callee }
}

function placementsByName(source: string) {
	const result = scan(source)
	const byName: Record<string, Array<unknown>> = {}
	for (const ref of result.references) {
		;(byName[ref.name] ??= []).push(ref.placement)
	}
	return byName
}

function scan(
	source: string,
	slots?: Parameters<typeof scanPackageCredentials>[0]['slots'],
) {
	return scanPackageCredentials({ files: { 'index.ts': source }, slots })
}

test('angle-bracket example vault references are not counted as placeholders', () => {
	const result = scan(`
		export function status() {
			return { example: '{{secret/bwvault:i/<item-uuid>/<field>}}' }
		}
		export const help = 'Use {{secret/<provider>:<ref>}} in fetch.'
	`)
	expect(result.placeholders.vault).toBe(0)
	expect(result.vaultPlacements).toEqual([])
})

test('concrete vault refs in status display fields are not credential-use placements', () => {
	const result = scan(`
		export function status() {
			return {
				example: '{{secret/bwvault:i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password}}',
				help: '{{secret/bitwarden:i/00000000-0000-4000-8000-000000000000/value}}',
			}
		}
	`)
	expect(result.placeholders.vault).toBe(2)
	expect(
		result.vaultPlacements.every((p) => !isVaultCredentialUsePlacement(p)),
	).toBe(true)
})

test('URL-shaped and nested-header vault examples under status() stay display-only', () => {
	const result = scan(`
		export function status() {
			return {
				example: 'https://api.example.com/v1?token={{secret/bwvault:i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password}}',
				help: {
					headers: {
						Authorization: 'Bearer {{secret/bitwarden:i/00000000-0000-4000-8000-000000000000/value}}',
					},
				},
			}
		}
	`)
	expect(result.placeholders.vault).toBe(2)
	expect(result.vaultPlacements).toEqual([
		other('display', 'example'),
		other('display', 'help'),
	])
	expect(
		result.vaultPlacements.every((p) => !isVaultCredentialUsePlacement(p)),
	).toBe(true)
})

test('assigned status arrow returns stay display-only for vault examples', () => {
	const result = scan(`
		export const status = () => ({
			example: 'https://api.example.com/?t={{secret/bwvault:i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password}}',
		})
	`)
	expect(result.vaultPlacements).toEqual([other('display', 'example')])
	expect(
		result.vaultPlacements.every((p) => !isVaultCredentialUsePlacement(p)),
	).toBe(true)

	const directReturn = scan(`
		export const status = () =>
			'https://api.example.com/?t={{secret/bwvault:i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password}}'
	`)
	expect(directReturn.vaultPlacements).toEqual([other('display')])
})

test('interpolated status help text with a vault ref stays display-only', () => {
	const result = scan(`
		export function status(host) {
			return \`curl https://\${host}/?t={{secret/bwvault:i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password}}\`
		}
	`)
	expect(result.vaultPlacements).toEqual([other('display')])
})

test('status returns the module itself reads or calls are not display-only', () => {
	const vault =
		'{{secret/bwvault:i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password}}'
	for (const source of [
		`export function status() { return 'https://api.example.com/?t=${vault}' }
		export const run = () => fetch(status())`,
		`export default {
			help() { return { headers: { Authorization: 'Bearer ${vault}' } } },
			run() { return fetch('https://api.example.com', this.help()) },
		}`,
		`export default {
			status() { return 'https://api.example.com/?t=${vault}' },
			run() { const url = this.status; return fetch(url()) },
		}`,
		`export default {
			status() { return 'https://api.example.com/?t=${vault}' },
			run() { return fetch(this['status']()) },
		}`,
		`export default {
			status() { return 'https://api.example.com/?t=${vault}' },
			run(key) { return fetch(this[key]()) },
		}`,
		`export default {
			status() { return 'https://api.example.com/?t=${vault}' },
			run() { const { status } = this; return fetch(status()) },
		}`,
		`export default {
			status() { return 'https://api.example.com/?t=${vault}' },
			run() { const self = this as any; return fetch(self.status()) },
		}`,
		`export default {
			status() { return 'https://api.example.com/?t=${vault}' },
			run() { return fetch((this as any).status()) },
		}`,
		`export default {
			status() { return 'https://api.example.com/?t=${vault}' },
			run() { return go(this) },
		}`,
	]) {
		expect(
			scan(source).vaultPlacements.some(isVaultCredentialUsePlacement),
		).toBe(true)
	}
})

test('calling an unrelated client.status() keeps the own status() return display-only', () => {
	const result = scan(`
		export function status() {
			return { example: 'https://api.example.com/?t={{secret/bwvault:i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password}}' }
		}
		export const run = (client) => client.status()
	`)
	expect(result.vaultPlacements).toEqual([other('display', 'example')])
})

test('vault refs in separately bound objects that feed a request stay credential uses', () => {
	const vault =
		'{{secret/bwvault:i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password}}'
	for (const source of [
		`const spec = { description: '${vault}' }
		export const run = (url) => fetch(url, { headers: { Authorization: spec.description } })`,
		`const opts = { token: '${vault}' }
		export const run = (url) => fetch(url, { headers: { Authorization: opts.token } })`,
		`const headers = { Authorization: 'Bearer ${vault}' }
		export const run = (url) => fetch(url, { headers })`,
		`const body = { token: '${vault}' }
		export const run = (url) => fetch(url, { method: 'POST', body: JSON.stringify(body) })`,
	]) {
		expect(
			scan(source).vaultPlacements.some(isVaultCredentialUsePlacement),
		).toBe(true)
	}
})

test('unnamed nested functions inside status do not inherit display-only returns', () => {
	const result = scan(`
		export function status(build = () => ({
			headers: {
				Authorization: 'Bearer {{secret/bwvault:i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password}}',
			},
		})) {
			return { example: 'docs only' }
		}
	`)
	expect(result.vaultPlacements.some(isVaultCredentialUsePlacement)).toBe(true)
})

test('docs-named body fields and header helpers under fetch stay credential uses', () => {
	const bodyField = scan(`
		await fetch('https://api.example.com/v1', {
			method: 'POST',
			body: JSON.stringify({
				description: '{{secret/bwvault:i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password}}',
			}),
		})
	`)
	expect(bodyField.vaultPlacements.some(isVaultCredentialUsePlacement)).toBe(
		true,
	)

	const headerHelper = scan(`
		function authHeaders() {
			return {
				headers: {
					Authorization: 'Bearer {{secret/bwvault:i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password}}',
				},
			}
		}
		export default authHeaders
	`)
	expect(headerHelper.vaultPlacements.some(isVaultCredentialUsePlacement)).toBe(
		true,
	)
})

test('isVaultCredentialUsePlacement fails closed outside display sites', () => {
	const uses: Array<CredentialPlacement> = [
		{ type: 'header', name: 'authorization', format: 'Bearer {value}' },
		{ type: 'query', param: 'token' },
		{ type: 'header-custom' },
		{ type: 'basic' },
		{ type: 'path' },
		{ type: 'url' },
		{ type: 'body', field: 'password', endpoint: 'login' },
		{ type: 'signing' },
		{ type: 'other', context: 'sdk-option', key: 'apiKey', callee: 'OpenAI' },
		{ type: 'other', context: 'argument', key: null, callee: 'connect' },
		{ type: 'other', context: 'url-host', key: null, callee: null },
		{ type: 'other', context: 'unparsed', key: null, callee: null },
		{ type: 'other', context: 'object', key: 'example', callee: null },
		{ type: 'other', context: 'return', key: null, callee: null },
		{ type: 'other', context: 'assignment', key: 'help', callee: null },
		{ type: 'other', context: 'array', key: null, callee: null },
		{ type: 'other', context: 'default-param', key: null, callee: null },
		{ type: 'other', context: 'comparison', key: null, callee: null },
		{ type: 'other', context: 'reassigned-binding', key: null, callee: null },
		{ type: 'other', context: 'template-computed', key: null, callee: null },
		{ type: 'other', context: 'other', key: null, callee: null },
	]
	const display: Array<CredentialPlacement> = [
		{ type: 'binding' },
		{ type: 'other', context: 'display', key: 'example', callee: null },
		{ type: 'other', context: 'unused-binding', key: null, callee: null },
	]
	expect(uses.every(isVaultCredentialUsePlacement)).toBe(true)
	expect(display.every((p) => !isVaultCredentialUsePlacement(p))).toBe(true)
})

test('counts every placeholder by kind, including ones that match a declared slot', () => {
	const result = scan(
		`
		const a = '{{secret:RESEND_API_KEY}}'
		const b = '{{secret-basic:username=USER,password=PASS}}'
		const c = '{{integration-token:github}}'
		const d = '{{secret/1password:op://vault/item/field}}'
		const e = \`{{secret:\${name}}}\`
		const f = 'help text: {{secret:<name>}}'
		`,
		{
			RESEND_API_KEY: {
				kind: 'secret',
				provider: 'resend',
				description: 'Sends email.',
			},
		},
	)
	expect(result.placeholders).toEqual({
		secret: 1,
		'secret-basic': 1,
		'integration-token': 1,
		vault: 1,
		computed: 1,
	})
	expect(result.references.map((ref) => [ref.nameKind, ref.name])).toEqual([
		['secret', 'RESEND_API_KEY'],
		['secret', 'USER'],
		['secret', 'PASS'],
		['integration', 'github'],
	])
	expect(result.slots).toEqual([
		{ name: 'RESEND_API_KEY', kind: 'secret', provider: 'resend' },
	])
})

test('classifies header, query, path, body, and basic placements', () => {
	const result = scan(`
		const BASE = 'https://api.example.com'
		await fetch(\`\${BASE}/v1/send\`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer {{secret:BEARER_KEY}}',
				'X-Api-Key': '{{secret:HEADER_KEY}}',
				'X-Custom': 'k={{secret:CUSTOM_KEY}};v=1',
				Basic: 'Basic {{secret-basic:username=U,password=P}}',
			},
			body: JSON.stringify({
				token: '{{secret:BODY_KEY}}',
				callback: 'https://cb.example.com/hook?token={{secret:BODY_URL_KEY}}',
			}),
		})
		await fetch('https://api.example.com/v1/items?limit=5&api_key={{secret:QUERY_KEY}}')
		await fetch('https://api.example.com/bot{{secret:PATH_KEY}}/send')
		const headers = new Headers({ 'x-token': 'Token {{secret:NEW_HEADERS_KEY}}' })
		headers.set('X-Set', '{{secret:SET_KEY}}')
		headers.set('X-Wrapped', ('{{secret:WRAPPED_SET_KEY}}' as string))
		const url = new URL('https://api.example.com')
		url.searchParams.set('key', '{{secret:SEARCH_KEY}}')
		const stashed = '{{secret:STASHED_KEY}}'
	`)
	expect(
		Object.fromEntries(
			result.references.map((ref) => [ref.name, ref.placement]),
		),
	).toEqual({
		BEARER_KEY: {
			type: 'header',
			name: 'authorization',
			format: 'Bearer {value}',
		},
		HEADER_KEY: { type: 'header', name: 'x-api-key', format: '{value}' },
		CUSTOM_KEY: { type: 'header-custom' },
		U: { type: 'basic' },
		P: { type: 'basic' },
		BODY_KEY: { type: 'body', field: 'token', endpoint: 'other' },
		BODY_URL_KEY: { type: 'body', field: 'callback', endpoint: 'other' },
		QUERY_KEY: { type: 'query', param: 'api_key' },
		PATH_KEY: { type: 'path' },
		NEW_HEADERS_KEY: {
			type: 'header',
			name: 'x-token',
			format: 'Token {value}',
		},
		SET_KEY: { type: 'header', name: 'x-set', format: '{value}' },
		WRAPPED_SET_KEY: {
			type: 'header',
			name: 'x-wrapped',
			format: '{value}',
		},
		SEARCH_KEY: { type: 'query', param: 'key' },
		STASHED_KEY: other('unused-binding'),
	})
})

test('keeps literal scopes, skips test files, and reads unparseable modules as text', () => {
	const result = scanPackageCredentials({
		files: {
			'src/index.ts': `const a = '{{secret:PKG_KEY|scope=package}}'`,
			'src/index.test.ts': `const b = '{{secret:FIXTURE}}'`,
			'src/broken.ts': `const c = '{{secret:BROKEN_KEY}}' +++ {`,
			'README.md': '{{secret:DOCS_ONLY}}',
		},
		slots: undefined,
	})
	expect(result.references).toEqual([
		{
			nameKind: 'secret',
			name: 'BROKEN_KEY',
			scope: null,
			placement: other('unparsed'),
		},
		{
			nameKind: 'secret',
			name: 'PKG_KEY',
			scope: 'package',
			placement: other('unused-binding'),
		},
	])
	expect(result.unparsedModules).toBe(1)
	expect(result.placeholders.secret).toBe(2)
})

test('follows a bound placeholder to each read of the variable', () => {
	expect(
		placementsByName(`
		const TOP_KEY = '{{secret:TOP_KEY}}'
		export async function send(body) {
			const token = '{{secret:LOCAL_KEY}}'
			const hook = '{{secret:HOOK_URL}}'
			const bot = \`https://api.telegram.org/bot{{secret:BOT_TOKEN}}\`
			await fetch('https://api.example.com/v1', {
				headers: { 'x-api-key': token, Authorization: \`Bearer \${TOP_KEY}\` },
			})
			await fetch(hook, { method: 'POST', body })
			await fetch(\`\${bot}/sendMessage\`)
		}
		function unrelated() {
			return token
		}
	`),
	).toEqual({
		TOP_KEY: [
			{ type: 'binding' },
			{ type: 'header', name: 'authorization', format: 'Bearer {value}' },
		],
		LOCAL_KEY: [
			{ type: 'binding' },
			{ type: 'header', name: 'x-api-key', format: '{value}' },
		],
		HOOK_URL: [{ type: 'binding' }, { type: 'url' }],
		BOT_TOKEN: [{ type: 'binding' }, { type: 'path' }],
	})
})

test('classifies signing keys, SDK options, arguments, and login bodies', () => {
	const result = scan(`
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode('{{secret:HMAC_KEY}}'),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		)
		const client = new OpenAI({ apiKey: '{{secret:OPENAI_KEY}}' })
		connect('{{secret:ARG_KEY}}')
		const config = { RAW_NAME: '{{secret:RAW_NAME}}' }
		await fetch('https://api.example.com/v1/auth/login', {
			method: 'POST',
			body: JSON.stringify({ password: '{{secret:LOGIN_PASSWORD}}' }),
		})
		await fetch('https://{{secret:TENANT}}.example.com/v1')
		await fetch('https://api.example.com/v1', {
			headers: { Authorization: 'Bearer {{secret/1password:op://v/i/f}}' },
		})
		await kody.secretJwtSign({ private_key_secret_name: 'SIGNER', claims: {} })
		export default config
	`)
	expect(
		Object.fromEntries(
			result.references.map((ref) => [ref.name, ref.placement]),
		),
	).toEqual({
		HMAC_KEY: { type: 'signing' },
		OPENAI_KEY: other('sdk-option', 'apiKey', 'OpenAI'),
		ARG_KEY: other('argument', null, 'connect'),
		// A key that spells the credential name is not stored.
		RAW_NAME: other('object'),
		LOGIN_PASSWORD: { type: 'body', field: 'password', endpoint: 'login' },
		TENANT: other('url-host'),
	})
	expect(result.vaultPlacements).toEqual([
		{ type: 'header', name: 'authorization', format: 'Bearer {value}' },
	])
	expect(result.jwtSignCalls).toBe(1)
})

test('a name resolves to its nearest declaration, so shadows and reassigned bindings are not followed', () => {
	expect(
		placementsByName(`
		const key = '{{secret:OUTER_KEY}}'
		let token = '{{secret:TOP_LET}}'
		var hook = '{{secret:TOP_VAR}}'
		let moved = '{{secret:MOVED}}'
		moved = 'https://other.example.com'
		function send(key) {
			fetch('https://x.example.com', { headers: { 'x-api-key': key } })
		}
		function local() {
			const key = 'not a credential'
			try {
				fetch('https://x.example.com', { headers: { 'x-api-key': key } })
			} catch (token) {
				fetch(\`https://x.example.com/?k=\${token}\`)
			}
			fetch(\`https://x.example.com/?k=\${key}\`)
		}
		fetch('https://x.example.com', {
			headers: { Authorization: \`Bearer \${token}\`, 'x-hook': hook },
		})
		fetch(moved)
	`),
	).toEqual({
		OUTER_KEY: [other('unused-binding')],
		TOP_LET: [
			{ type: 'binding' },
			{ type: 'header', name: 'authorization', format: 'Bearer {value}' },
		],
		TOP_VAR: [
			{ type: 'binding' },
			{ type: 'header', name: 'x-hook', format: '{value}' },
		],
		MOVED: [other('reassigned-binding')],
	})
})

test('a local alias resolves against the bindings visible where it is declared', () => {
	expect(
		placementsByName(`
		const key = 'not a credential'
		function send() {
			const k = '{{secret:LOCAL_ALIAS}}'
			const h = k
			fetch('https://x.example.com', { headers: { 'x-api-key': h } })
		}
		function moved() {
			let m = '{{secret:MOVED_LOCAL}}'
			m = 'plain'
			const alias = m
			fetch('https://x.example.com', { headers: { 'x-api-key': alias } })
		}
		function shadowed() {
			const key = '{{secret:SHADOWED}}'
			const alias = key
			fetch(\`https://x.example.com/?k=\${alias}\`)
		}
		const handlers = {
			body: async () => {
				await fetch('https://api.example.com/v1/auth/login', {
					method: 'POST',
					body: JSON.stringify({ password: '{{secret:INNER_LOGIN}}' }),
				})
			},
		}
		export default handlers
	`),
	).toEqual({
		LOCAL_ALIAS: [
			{ type: 'binding' },
			{ type: 'binding' },
			{ type: 'header', name: 'x-api-key', format: '{value}' },
		],
		MOVED_LOCAL: [other('reassigned-binding')],
		SHADOWED: [
			{ type: 'binding' },
			{ type: 'binding' },
			{ type: 'query', param: 'k' },
		],
		INNER_LOGIN: [{ type: 'body', field: 'password', endpoint: 'login' }],
	})
})

test('reads of a binding add placements, not placeholder occurrences', () => {
	const result = scan(`
		const key = '{{secret:KEY}}'
		const vault = '{{secret/1password:op://v/i/f}}'
		fetch('https://x.example.com', { headers: { Authorization: key } })
		fetch('https://x.example.com', { headers: { Authorization: key } })
		fetch(\`https://x.example.com/?k=\${vault}\`)
	`)
	expect(result.placeholders).toMatchObject({ secret: 1, vault: 1 })
	expect(result.references).toHaveLength(3)
	expect(result.vaultPlacements).toEqual([
		{ type: 'binding' },
		{ type: 'query', param: 'k' },
	])
})

test('only the key argument of a signing call is signing key material', () => {
	expect(
		placementsByName(`
		jwt.sign({ aud: '{{secret:AUDIENCE}}' }, '{{secret:JWT_KEY}}')
		await new SignJWT({ sub: '{{secret:SUBJECT}}' }).sign('{{secret:JOSE_KEY}}')
		crypto.subtle.sign('HMAC', '{{secret:SUBTLE_KEY}}', '{{secret:SIGNED_DATA}}')
		crypto.createHmac('sha256', '{{secret:NODE_KEY}}')
		createSign('RSA-SHA256').sign('{{secret:SIGNER_KEY}}', 'hex')
		await new SignJWT(claims).sign('{{secret:JOSE_OPTIONS_KEY}}', { crit: {} })
		jwt.sign(claims, '{{secret:JWT_VAR_PAYLOAD_KEY}}')
		toString('{{secret:PROTOTYPE_NAME}}')
	`),
	).toEqual({
		AUDIENCE: [other('sdk-option', 'aud', 'sign')],
		JWT_KEY: [{ type: 'signing' }],
		SUBJECT: [other('sdk-option', 'sub', 'SignJWT')],
		JOSE_KEY: [{ type: 'signing' }],
		SUBTLE_KEY: [{ type: 'signing' }],
		SIGNED_DATA: [other('argument', null, 'sign')],
		NODE_KEY: [{ type: 'signing' }],
		SIGNER_KEY: [{ type: 'signing' }],
		JOSE_OPTIONS_KEY: [{ type: 'signing' }],
		JWT_VAR_PAYLOAD_KEY: [{ type: 'signing' }],
		PROTOTYPE_NAME: [other('argument', null, 'toString')],
	})
})
