import { expect, test } from 'vitest'
import { declareCredentialNeedsCodemod } from './0013-declare-credential-needs.ts'

const packageContext = { packageName: '@acme/demo' }

function manifest(kody: Record<string, unknown> = {}, indent = '\t') {
	return `${JSON.stringify(
		{
			name: '@acme/demo',
			exports: { '.': './index.ts' },
			kody: { description: 'Demo package.', ...kody },
		},
		null,
		indent,
	)}\n`
}

async function transform(source: string, kody: Record<string, unknown> = {}) {
	return await declareCredentialNeedsCodemod.transform(
		{ 'package.json': manifest(kody), 'index.ts': source },
		packageContext,
	)
}

function declaredSlots(result: { files: Record<string, string> }) {
	return JSON.parse(result.files['package.json']!).kody.credentials as Record<
		string,
		unknown
	>
}

const slot = {
	description:
		'Used by this package by name. Declared automatically from its source; describe what it is for.',
}
const messages = {
	declare:
		'Uses credentials by name that kody.credentials does not declare. Add a kody.credentials slot for each.',
	computed:
		'Builds a credential name or credential() key at run time, and its source states no default name or prefix. Declare each credential it can use as a kody.credentials slot by hand (a slot with "prefix": true also covers its key plus "-suffix" names).',
	vault:
		'Uses a vault ref ({{secret/provider:ref}}). Declare a kody.credentials slot keyed by the provider by hand.',
	invalidKey:
		'Uses a credential name that is not a valid kody.credentials slot key (a letter, then letters, numbers, dots, underscores, or hyphens; max 64). Rename it or declare it by hand.',
	kindMismatch:
		'Uses a credential that kody.credentials declares with a kind that cannot fill it. Fix the slot kind by hand.',
	undeclaredCredentialKey:
		'Calls credential() with a key that kody.credentials does not declare. Declare the slot with the kind it takes (a slot with no kind takes only secret, oauth, or login credentials) by hand.',
	indirectCredential:
		'Passes credential or credentials around instead of calling it. Declare each key it reads as a kody.credentials slot by hand.',
	invalidManifest:
		'package.json or its kody.credentials is not valid. Fix it, then declare each credential the package uses.',
	unparsedModule:
		'A module could not be parsed, so the credential names it uses were not read reliably. Declare each credential it uses as a kody.credentials slot by hand.',
}

test('0013 declares every literal name the fetch gateway fills', async () => {
	const result = await transform(
		[
			"import { createAuthenticatedFetch, secretHeaders, oauthClientCredentials } from 'kody:runtime'",
			"const TOKEN = 'RESEND_API_KEY'",
			'export default async function run() {',
			"\tconst google = await createAuthenticatedFetch('google')",
			"\tsecretHeaders.basic({ usernameSecret: 'U', passwordSecret: 'P' })",
			"\toauthClientCredentials({ clientIdSecret: 'CID', clientSecretSecret: 'CSECRET' })",
			'\tawait fetch(`https://api.resend.com?key={{secret:${TOKEN}}}`, {',
			"\t\theaders: { authorization: 'Bearer {{integration-token:github}}', x: '{{secret:STRIPE|scope=user}}' },",
			'\t})',
			"\treturn google('https://www.googleapis.com/calendar/v3/users/me')",
			'}',
		].join('\n'),
	)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['package.json'])
	expect(result.needsManual).toEqual([])
	expect(declaredSlots(result)).toEqual({
		CID: slot,
		CSECRET: slot,
		P: slot,
		RESEND_API_KEY: slot,
		STRIPE: slot,
		U: slot,
		github: slot,
		google: slot,
	})
})

test('0013 leaves undeclared credential() keys for the owner and accepts declared ones', async () => {
	const source = [
		"import { credential as cred, credentials } from 'kody:runtime'",
		"import kody from 'kody:runtime'",
		"const KEY = 'linear'",
		'export default async function run() {',
		"\tawait cred('resend')",
		'\tawait credentials(KEY)',
		"\tawait kody.credential('slack')",
		"\tconst signer = await cred('docusign')",
		'\tawait signer.sign?.({})',
		"\treturn cred.named('legacy')",
		'}',
	].join('\n')
	expect(await transform(source)).toMatchObject({
		changed: false,
		needsManual: [
			{
				path: 'index.ts',
				message: messages.undeclaredCredentialKey,
			},
		],
	})
	const declared = { description: 'Owner text.' }
	expect(
		await transform(source, {
			credentials: {
				docusign: { kind: 'keypair', description: 'Owner text.' },
				linear: declared,
				resend: declared,
				slack: declared,
			},
		}),
	).toMatchObject({ changed: false, needsManual: [] })
})

test('0013 does not read a kody.credential member as passing credential around', async () => {
	const result = await transform(
		[
			"import { credential } from 'kody:runtime'",
			"import kody from 'kody:runtime'",
			'export default async function run() {',
			"\tawait credential('resend')",
			"\treturn { credential: await kody.credential('resend') }",
			'}',
		].join('\n'),
		{ credentials: { resend: { description: 'Owner text.' } } },
	)
	expect(result).toMatchObject({ changed: false, needsManual: [] })
})

test('0013 keeps declared slots and helpers that bypass the gateway, and declares mounted names', async () => {
	const result = await transform(
		[
			"import { packageSecrets, secretJwtSign, integrationTokenRefresh } from 'kody:runtime'",
			'export default async function run() {',
			"\tawait packageSecrets.get('mounted')",
			"\tawait secretJwtSign({ private_key_secret_name: 'JWT_KEY' })",
			"\tawait integrationTokenRefresh({ name: 'gmail' })",
			"\treturn fetch('https://x.test', { headers: { a: '{{secret:DECLARED}}', b: '{{secret:REAL_NAME}}' } })",
			'}',
		].join('\n'),
		{
			credentials: { DECLARED: { kind: 'secret', description: 'Owner text.' } },
			secretMounts: { mounted: { name: 'REAL_NAME' } },
		},
	)
	expect(result.needsManual).toEqual([])
	expect(declaredSlots(result)).toEqual({
		DECLARED: { kind: 'secret', description: 'Owner text.' },
		REAL_NAME: slot,
	})
	expect(
		await declareCredentialNeedsCodemod.detect(
			{ 'package.json': manifest(), 'index.ts': 'export default 1' },
			packageContext,
		),
	).toEqual([])
})

test('0013 flags what it cannot declare and still declares the rest', async () => {
	const result = await transform(
		[
			"import { credential } from 'kody:runtime'",
			'export default async function run(input: { key: string; name: string }) {',
			'\tawait credential(input.key)',
			"\tawait fetch('https://x.test', { headers: {",
			'\t\ta: `{{secret:${input.name}}}`,',
			"\t\tb: '{{secret/1password:op://v/i/f}}',",
			"\t\tc: '{{secret:9bad}}',",
			"\t\td: '{{integration-token:MCP_ONLY}}',",
			"\t\te: '{{secret:FINE}}',",
			'\t} })',
			'\treturn [credential].length',
			'}',
		].join('\n'),
		{ credentials: { MCP_ONLY: { kind: 'mcp', description: 'Owner text.' } } },
	)
	expect(result.changed).toBe(true)
	expect(declaredSlots(result)).toEqual({
		FINE: slot,
		MCP_ONLY: { kind: 'mcp', description: 'Owner text.' },
	})
	expect(result.needsManual.map((finding) => finding.message).sort()).toEqual(
		[
			messages.computed,
			messages.indirectCredential,
			messages.invalidKey,
			messages.kindMismatch,
			messages.vault,
		].sort(),
	)
	expect(
		result.needsManual.every((finding) => finding.path === 'index.ts'),
	).toBe(true)
})

test('0013 reads a nested package from its source root', async () => {
	const files = {
		'package.json': '{ "name": "repo-root", "private": true }\n',
		'packages/demo/package.json': manifest(),
		'packages/demo/index.ts':
			"export default () => fetch('https://x.test?k={{secret:K}}')",
		'packages/other/index.ts':
			"export default () => fetch('https://x.test?k={{secret:OTHER}}')",
	}
	const nestedContext = {
		...packageContext,
		manifestPath: 'packages/demo/package.json',
		sourceRoot: '/packages/demo/',
	}
	const result = await declareCredentialNeedsCodemod.transform(
		files,
		nestedContext,
	)
	expect(result).toMatchObject({
		changed: true,
		changedPaths: ['packages/demo/package.json'],
		needsManual: [],
	})
	expect(result.files['package.json']).toBe(files['package.json'])
	expect(
		JSON.parse(result.files['packages/demo/package.json']!).kody.credentials,
	).toEqual({ K: slot })
	const rootKeyed = await declareCredentialNeedsCodemod.transform(
		{
			'package.json': manifest(),
			'index.ts': files['packages/demo/index.ts'],
		},
		nestedContext,
	)
	expect(rootKeyed.changedPaths).toEqual(['package.json'])
	expect(declaredSlots(rootKeyed)).toEqual({ K: slot })
	const sourceRelativeManifest = await declareCredentialNeedsCodemod.transform(
		{
			'package.json': manifest(),
			'index.ts': files['packages/demo/index.ts'],
		},
		{ ...nestedContext, manifestPath: 'package.json' },
	)
	expect(sourceRelativeManifest.changedPaths).toEqual(['package.json'])
	expect(declaredSlots(sourceRelativeManifest)).toEqual({ K: slot })
})

test('0013 does not declare names read from a module it cannot parse', async () => {
	const result = await transform(
		[
			"// createAuthenticatedFetch('commented') is not a call",
			'export default async function run( {',
		].join('\n'),
	)
	expect(result).toMatchObject({
		changed: false,
		needsManual: [
			{
				path: 'index.ts',
				message: messages.unparsedModule,
			},
		],
	})
})

test('0013 keeps manifest indentation, other kody fields, and is idempotent', async () => {
	const files = {
		'package.json': manifest(
			{ jobs: { tick: { handler: './tick.ts' } } },
			'  ',
		),
		'index.ts': "export default () => fetch('https://x.test?k={{secret:K}}')",
	}
	const once = await declareCredentialNeedsCodemod.transform(
		files,
		packageContext,
	)
	expect(once.files['package.json']).toContain('\n  "name"')
	expect(JSON.parse(once.files['package.json']!).kody).toMatchObject({
		jobs: { tick: { handler: './tick.ts' } },
		credentials: { K: slot },
	})
	expect(
		await declareCredentialNeedsCodemod.detect(files, packageContext),
	).toEqual([{ path: 'package.json', message: messages.declare }])
	const twice = await declareCredentialNeedsCodemod.transform(
		once.files,
		packageContext,
	)
	expect(twice).toMatchObject({ changed: false, needsManual: [] })
	expect(
		await declareCredentialNeedsCodemod.detect(once.files, packageContext),
	).toEqual([])
})

test('0013 reports an invalid manifest without writing', async () => {
	const result = await declareCredentialNeedsCodemod.transform(
		{
			'package.json': '{ not json',
			'index.ts': "export default () => '{{secret:K}}'",
		},
		packageContext,
	)
	expect(result).toMatchObject({
		changed: false,
		needsManual: [
			{
				path: 'package.json',
				message: messages.invalidManifest,
			},
		],
	})
})

test('0013 findings never carry credential names', async () => {
	const findings = await declareCredentialNeedsCodemod.detect(
		{
			'package.json': manifest(),
			'index.ts':
				"export default (n: string) => ['{{secret:SECRET_NAME_123}}', `{{secret:${n}}}`]",
		},
		packageContext,
	)
	expect(findings.length).toBeGreaterThan(0)
	for (const finding of findings) {
		expect(finding.message).not.toContain('SECRET_NAME_123')
	}
})

const prefixSlot = {
	prefix: true,
	description:
		'Used by this package by name, or by this name, a hyphen, and an account suffix chosen at run time. Declared automatically from its source; describe what it is for.',
}

test('0013 does not read a type-position credential as passing it around', async () => {
	const result = await transform(
		[
			"import { credential, credentials } from 'kody:runtime'",
			'type GithubCredentialClient = Awaited<ReturnType<typeof credential>>',
			'type Many = ReturnType<typeof credentials>',
			'let cached: typeof credential | undefined',
			"export const isFunction = typeof credential === 'function'",
			'export async function client(): Promise<GithubCredentialClient> {',
			"\treturn await credential('github')",
			'}',
		].join('\n'),
		{ credentials: { github: { kind: 'oauth', description: 'GitHub.' } } },
	)
	expect(result.changed).toBe(false)
	expect(result.needsManual).toEqual([])
	const passed = await transform(
		[
			"import { credential } from 'kody:runtime'",
			'export const open = credential as typeof credential',
		].join('\n'),
	)
	expect(passed.needsManual).toEqual([
		{ path: 'index.ts', message: messages.indirectCredential },
	])
})

test('0013 declares a prefix slot for a name built from a stated prefix', async () => {
	const result = await transform(
		[
			"import { createAuthenticatedFetch } from 'kody:runtime'",
			"export const DEFAULT_GOOGLE_INTEGRATION = 'google'",
			'function resolve(account?: string) {',
			'\tif (!account) return DEFAULT_GOOGLE_INTEGRATION',
			"\tif (account.startsWith('google-')) return account",
			'\treturn `${DEFAULT_GOOGLE_INTEGRATION}-${account}`',
			'}',
			'export function client(account?: string) {',
			'\treturn createAuthenticatedFetch(resolve(account))',
			'}',
			"export const work = createAuthenticatedFetch('google-work')",
		].join('\n'),
	)
	expect(declaredSlots(result)).toEqual({ google: prefixSlot })
	expect(result.needsManual).toEqual([])
	const again = await declareCredentialNeedsCodemod.transform(
		result.files,
		packageContext,
	)
	expect(again.changed).toBe(false)
	expect(again.needsManual).toEqual([])
})

test('0013 declares a prefix slot for each name in a closed prefix list', async () => {
	const result = await transform(
		[
			"const SECRET_PREFIXES = ['openaiApiKey', 'groqApiKey'] as const",
			'export function secretNameFor(prefix: string, account?: string, override?: string) {',
			'\tif (override) {',
			"\t\tif (!SECRET_PREFIXES.some((item) => override === item || override.startsWith(item + '-'))) throw new Error('no')",
			'\t\treturn override',
			'\t}',
			"\treturn account ? prefix + '-' + account : prefix",
			'}',
			'export function header(name: string) {',
			"\treturn 'Bearer {{secret:' + name + '}}'",
			'}',
		].join('\n'),
		{ credentials: { openaiApiKey: { kind: 'secret', description: 'Mine.' } } },
	)
	expect(declaredSlots(result)).toEqual({
		openaiApiKey: { kind: 'secret', description: 'Mine.', prefix: true },
		groqApiKey: prefixSlot,
	})
	expect(result.needsManual).toEqual([])
})

test('0013 declares a prefix slot for the default behind a run-time name', async () => {
	const result = await transform(
		[
			"import { createAuthenticatedFetch } from 'kody:runtime'",
			"const DEFAULT_SECRET = 'cloudflareApiToken'",
			'export function slack(input: { integration?: string }) {',
			"\treturn createAuthenticatedFetch(input.integration ?? 'slack')",
			'}',
			'export function run({ apiTokenSecret = DEFAULT_SECRET }: { apiTokenSecret?: string }) {',
			'\treturn `Bearer {{secret:${apiTokenSecret}}}`',
			'}',
		].join('\n'),
	)
	expect(declaredSlots(result)).toEqual({
		cloudflareApiToken: prefixSlot,
		slack: prefixSlot,
	})
	expect(result.needsManual).toEqual([])
})

test('0013 leaves a run-time name with no stated default or prefix for the owner', async () => {
	const result = await transform(
		[
			"import { createAuthenticatedFetch } from 'kody:runtime'",
			"const label = 'user'",
			'export function tag(id: string) {',
			'\treturn `${label}:${id}` + `item-${id}`',
			'}',
			'export function client(name: string) {',
			'\treturn createAuthenticatedFetch(name)',
			'}',
		].join('\n'),
	)
	expect(result.changed).toBe(false)
	expect(result.needsManual).toEqual([
		{ path: 'index.ts', message: messages.computed },
	])
	const kindBound = await transform(
		[
			"import { createAuthenticatedFetch } from 'kody:runtime'",
			'export function client(name?: string) {',
			"\treturn createAuthenticatedFetch(name ?? 'linear')",
			'}',
		].join('\n'),
		{ credentials: { linear: { kind: 'mcp', description: 'Linear.' } } },
	)
	expect(kindBound.changed).toBe(false)
	expect(kindBound.needsManual).toEqual([
		{ path: 'index.ts', message: messages.computed },
	])
})

test('0013 reads a declared prefix slot as covering built and literal names', async () => {
	const result = await transform(
		[
			"import { createAuthenticatedFetch, credential } from 'kody:runtime'",
			'export function client(name: string) {',
			'\treturn createAuthenticatedFetch(name)',
			'}',
			"export const work = createAuthenticatedFetch('google-work')",
			"export const other = credential('google-other')",
		].join('\n'),
		{ credentials: { google: { prefix: true, description: 'Google.' } } },
	)
	expect(result.changed).toBe(false)
	expect(result.needsManual).toEqual([])
})

test('0013 keeps a prefix from changing credential() resolution or hiding a kind mismatch', async () => {
	// A new slot would change how credential('acme') resolves.
	const called = await transform(
		[
			"import { createAuthenticatedFetch, credential } from 'kody:runtime'",
			'export function client(name?: string) {',
			"\treturn createAuthenticatedFetch(name ?? 'acme')",
			'}',
			"export const signer = credential('acme')",
		].join('\n'),
	)
	expect(called.changed).toBe(false)
	expect(called.needsManual).toEqual([
		{ path: 'index.ts', message: messages.computed },
		{ path: 'index.ts', message: messages.undeclaredCredentialKey },
	])
	// An OAuth prefix does not fill a Key placeholder, so that name gets a slot.
	const mixed = await transform(
		[
			"import { createAuthenticatedFetch } from 'kody:runtime'",
			'export function client(name: string) {',
			'\treturn createAuthenticatedFetch(name)',
			'}',
			"export const header = 'Bearer {{secret:google-key}}'",
		].join('\n'),
		{
			credentials: {
				google: { kind: 'oauth', prefix: true, description: 'G.' },
			},
		},
	)
	expect(Object.keys(declaredSlots(mixed))).toEqual(['google', 'google-key'])
})

test('0013 settles in one pass when credential() and the gateway share a default name', async () => {
	const result = await transform(
		[
			"import { createAuthenticatedFetch, credential } from 'kody:runtime'",
			'export function client(name?: string) {',
			"\treturn createAuthenticatedFetch(name ?? 'acme')",
			'}',
			"export const plain = createAuthenticatedFetch('acme')",
			"export const scoped = credential('acme')",
		].join('\n'),
	)
	expect(declaredSlots(result)).toEqual({ acme: prefixSlot })
	const again = await declareCredentialNeedsCodemod.transform(
		result.files,
		packageContext,
	)
	expect(again.changed).toBe(false)
})
