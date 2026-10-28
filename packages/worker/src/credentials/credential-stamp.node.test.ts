import { expect, test } from 'vitest'
import {
	buildCredentialStamp,
	collectServerRuntimeModulePaths,
	credentialStampMaxModuleScanBytes,
	mergeCredentialStampIntoManifestFiles,
	omitOversizedCredentialStampModules,
	planCredentialStampSeal,
	isStoredCredentialStamp,
	scanCredentialStamp,
	scanLiteralMcpServerKeys,
} from './credential-stamp.ts'
import {
	isPackageAppAssetPath,
	listScannableModulePaths,
	readPackageAppAssetsDirectory,
} from './module-placeholder-scan.ts'

function manifest(kody: Record<string, unknown> = {}) {
	return JSON.stringify({
		name: '@kody/stamp',
		exports: { '.': './src/index.ts' },
		kody: { id: 'stamp', description: 'Stamp test.', ...kody },
	})
}

test('omitOversizedCredentialStampModules drops huge prebuilt client bundles from the stamp scan', () => {
	const huge = `${'a'.repeat(credentialStampMaxModuleScanBytes + 1)}`
	const files = {
		'package.json': manifest(),
		'index.ts': [
			"import { credential } from 'kody:runtime'",
			'export default async function run() { return credential("API_KEY") }',
		].join('\n'),
		'public/client/main.js': huge,
	}
	const filtered = omitOversizedCredentialStampModules(files)
	expect(filtered['public/client/main.js']).toBeUndefined()
	expect(filtered['index.ts']).toBe(files['index.ts'])
	expect(filtered['package.json']).toBe(files['package.json'])

	const scanned = scanCredentialStamp(files)
	expect(scanned.keys).toEqual(['API_KEY'])
	expect(scanned.failures.some((f) => f.code === 'missing_description')).toBe(
		true,
	)
})

test('scanCredentialStamp collects sorted literal keys from credential() and placeholders', () => {
	const result = scanCredentialStamp({
		'package.json': manifest({
			credentials: {
				GITHUB: { kind: 'oauth', description: 'GitHub OAuth.' },
				API_KEY: { kind: 'secret', description: 'API key.' },
			},
		}),
		'src/index.ts': [
			"import { credential } from 'kody:runtime'",
			'export default async function run() {',
			'  const gh = await credential("GITHUB")',
			"  return fetch('https://api.example.com', { headers: { Authorization: 'Bearer {{secret:API_KEY}}' } })",
			'}',
		].join('\n'),
	})
	expect(result.failures).toEqual([])
	expect(result.keys).toEqual(['API_KEY', 'GITHUB'])
})

test('scanCredentialStamp fails non-literal credential(), createAuthenticatedFetch, and secretJwtSign names', () => {
	const credentialVar = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			"import { credential } from 'kody:runtime'",
			'export default async function run(key: string) {',
			'  return credential(key)',
			'}',
		].join('\n'),
	})
	expect(credentialVar.failures.some((f) => f.code === 'non_literal')).toBe(
		true,
	)
	expect(credentialVar.failures[0]?.message).toMatch(
		/literal keys \(credential\("SLOT"\)/,
	)
	expect(credentialVar.failures[0]?.message).toMatch(/credentials call map/)

	const fetchVar = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			"import { createAuthenticatedFetch } from 'kody:runtime'",
			'export default async function run(account: string) {',
			'  return createAuthenticatedFetch(account)',
			'}',
		].join('\n'),
	})
	expect(fetchVar.failures.some((f) => f.code === 'unstampable_pattern')).toBe(
		true,
	)

	const jwtVar = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			"const keyName = 'APNS_KEY'",
			'export const sign = () => kody.secretJwtSign({ private_key_secret_name: keyName, claims: {} })',
		].join('\n'),
	})
	expect(jwtVar.failures.some((f) => f.code === 'non_literal')).toBe(true)
})

test('scanCredentialStamp fails credential.named() in stamped packages', () => {
	const result = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			"import { credential } from 'kody:runtime'",
			'export default async function run() {',
			'  return credential.named("API_KEY")',
			'}',
		].join('\n'),
	})
	expect(result.failures.some((f) => f.code === 'credential_named')).toBe(true)
	expect(result.failures[0]?.message).toMatch(/ad hoc execute/)

	const viaKody = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'export default async function run() {',
			'  return kody.credential.named("API_KEY")',
			'}',
		].join('\n'),
	})
	expect(viaKody.failures.some((f) => f.code === 'credential_named')).toBe(true)

	const computedMember = scanCredentialStamp({
		'package.json': manifest({
			credentials: {
				API_KEY: { kind: 'secret', description: 'API key.' },
			},
		}),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'export default async function run() {',
			'  return kody["credential"]("API_KEY")',
			'}',
		].join('\n'),
	})
	expect(computedMember.failures).toEqual([])
	expect(computedMember.keys).toEqual(['API_KEY'])

	const bound = scanCredentialStamp({
		'package.json': manifest({
			credentials: {
				API_KEY: { kind: 'secret', description: 'API key.' },
			},
		}),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'const get = kody.credential.bind(kody)',
			'export default async function run() { return get("API_KEY") }',
		].join('\n'),
	})
	expect(bound.failures.some((f) => f.code === 'non_literal')).toBe(true)
	expect(bound.failures[0]?.message).toMatch(/passes credential/)
	expect(bound.keys).toEqual([])
})

test('scanCredentialStamp stamps credential.visitor literal keys', () => {
	const credentials = {
		GITHUB: { kind: 'secret', description: 'GitHub token.' },
	}
	for (const source of [
		[
			"import { credential } from 'kody:runtime'",
			'export default async function run() {',
			"  return await credential.visitor('GITHUB')",
			'}',
		],
		[
			"import { kody } from 'kody:runtime'",
			'export default async function run() {',
			"  return await kody.credential.visitor('GITHUB')",
			'}',
		],
	]) {
		const result = scanCredentialStamp({
			'package.json': manifest({ credentials }),
			'src/index.ts': source.join('\n'),
		})
		expect(result.failures).toEqual([])
		expect(result.keys).toEqual(['GITHUB'])
	}
	const escaped = scanCredentialStamp({
		'package.json': manifest({ credentials }),
		'src/index.ts': [
			"import { credential } from 'kody:runtime'",
			'const open = credential.visitor',
			"export default async function run() { return open('GITHUB') }",
		].join('\n'),
	})
	expect(escaped.failures.some((f) => f.code === 'non_literal')).toBe(true)
	expect(escaped.failures[0]?.message).toMatch(/credential\.visitor\("SLOT"\)/)
	const computed = scanCredentialStamp({
		'package.json': manifest({ credentials }),
		'src/index.ts': [
			"import { credential } from 'kody:runtime'",
			'export default async function run(key: string) {',
			'  return await credential.visitor(key)',
			'}',
		].join('\n'),
	})
	expect(computed.failures.some((f) => f.code === 'non_literal')).toBe(true)
})

test('scanLiteralMcpServerKeys stamps literal servers and fails dynamic access', () => {
	const literal = scanLiteralMcpServerKeys({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'export default async function run() {',
			'\tawait kody.mcp.linear.list_issues({})',
			'\tawait kody.mcp["home"].set_pin({ pin: "1" })',
			'}',
		].join('\n'),
	})
	expect(literal.keys).toEqual(['home', 'linear'])
	expect(literal.failures).toEqual([])

	// Optional chaining + brackets + static templates on kody.mcp, and on a
	// non-kody helper root only when the server is already a declared mcp slot
	// (kasa: cm.mcp?.['home']).
	const optionalBracketForms = scanLiteralMcpServerKeys({
		'package.json': manifest({
			credentials: {
				home: { kind: 'mcp', description: 'Home connector.' },
			},
		}),
		'src/home-tools.ts': [
			'export type KodyKasa = { mcp: { home: unknown } }',
			'export function getHomeKasaTools(cm: KodyKasa) {',
			"\treturn cm.mcp?.['home']",
			'}',
		].join('\n'),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'export default async function run() {',
			'\treturn kody.mcp?.home',
			'\treturn kody.mcp?.[`linear`]',
			"\treturn kody?.mcp?.['canva']",
			'}',
		].join('\n'),
	})
	expect(optionalBracketForms.keys).toEqual(['canva', 'home', 'linear'])
	expect(optionalBracketForms.failures).toEqual([])

	// adminCredentialStampBackfill sets stampKeyCount = plan.keys.length.
	// Kasa 1.2.1 only uses cm.mcp?.['home']; before optional/bracket detection
	// the plan was [] so a matching empty KV stamp reported stamped + 0.
	const kasaSealPlan = planCredentialStampSeal({
		'package.json': manifest({
			credentials: {
				home: {
					kind: 'mcp',
					description: 'Home connector for Kasa plugs.',
				},
			},
		}),
		'src/home-tools.ts': [
			'export type KodyKasa = { mcp: { home: unknown } }',
			'export function getHomeKasaTools(cm: KodyKasa) {',
			"\treturn cm.mcp?.['home']",
			'}',
		].join('\n'),
		'src/index.ts': [
			"import { getHomeKasaTools } from './home-tools.ts'",
			"import { kody } from 'kody:runtime'",
			'export default () => getHomeKasaTools(kody as never)',
		].join('\n'),
	})
	expect(kasaSealPlan.keys).toEqual(['home'])
	expect(kasaSealPlan.blockingFailures).toEqual([])
	expect(kasaSealPlan.sealReady).toBe(true)

	// Destructured helper params bind the same way as a direct `cm` param.
	const destructuredHelper = scanLiteralMcpServerKeys({
		'package.json': manifest({
			credentials: {
				home: { kind: 'mcp', description: 'Home connector.' },
			},
		}),
		'src/index.ts': [
			'export type KodyKasa = { mcp: { home: unknown } }',
			'export function getHome({ cm }: { cm: KodyKasa }) {',
			"\treturn cm.mcp?.['home']",
			'}',
		].join('\n'),
	})
	expect(destructuredHelper.keys).toEqual(['home'])
	expect(destructuredHelper.failures).toEqual([])

	const shadowedLooseHelper = scanLiteralMcpServerKeys({
		'package.json': manifest({
			credentials: {
				home: { kind: 'mcp', description: 'Home connector.' },
			},
		}),
		'src/index.ts': [
			'export type KodyKasa = { mcp: { home: unknown } }',
			'export function getHome(cm: KodyKasa) {',
			'\t{',
			'\t\tconst cm = { mcp: { home: true } }',
			'\t\treturn cm.mcp.home',
			'\t}',
			'}',
		].join('\n'),
	})
	expect(shadowedLooseHelper.keys).toEqual([])
	expect(shadowedLooseHelper.failures).toEqual([])

	const unrelatedMcpData = scanLiteralMcpServerKeys({
		'package.json': manifest(),
		'src/index.ts': [
			'const settings = { mcp: { enabled: true } }',
			'export default async function run() {',
			'\treturn settings.mcp.enabled',
			'}',
		].join('\n'),
	})
	expect(unrelatedMcpData.keys).toEqual([])
	expect(unrelatedMcpData.failures).toEqual([])

	// Declared slot name on unrelated local data must not count as use.
	const unrelatedMatchingSlot = scanLiteralMcpServerKeys({
		'package.json': manifest({
			credentials: {
				home: { kind: 'mcp', description: 'Home connector.' },
			},
		}),
		'src/index.ts': [
			'const settings = { mcp: { home: { enabled: true } } }',
			'export default async function run() {',
			'\treturn settings.mcp.home',
			'}',
		].join('\n'),
	})
	expect(unrelatedMatchingSlot.keys).toEqual([])
	expect(unrelatedMatchingSlot.failures).toEqual([])

	const serverNamedMcp = scanLiteralMcpServerKeys({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'const servers = kody.mcp',
			'export default async function run() {',
			'\treturn servers.mcp.tool({})',
			'}',
		].join('\n'),
	})
	expect(serverNamedMcp.keys).toEqual(['mcp'])
	expect(serverNamedMcp.failures).toEqual([])

	const viaAlias = scanLiteralMcpServerKeys({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'const mcp = kody.mcp',
			'export default async function run() {',
			'\treturn mcp.linear.list_issues({})',
			'}',
		].join('\n'),
	})
	expect(viaAlias.keys).toEqual(['linear'])
	expect(viaAlias.failures).toEqual([])

	const shadowedParam = scanLiteralMcpServerKeys({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'const mcp = kody.mcp',
			'export default async function run(mcp: unknown) {',
			'\treturn mcp',
			'}',
			'export function other() {',
			'\treturn mcp.linear.list_issues({})',
			'}',
		].join('\n'),
	})
	expect(shadowedParam.keys).toEqual(['linear'])
	expect(shadowedParam.failures).toEqual([])

	const shadowedParamMember = scanLiteralMcpServerKeys({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'const mcp = kody.mcp',
			'export default async function run(mcp: { linear: { list_issues: Function } }) {',
			'\treturn mcp.linear.list_issues({})',
			'}',
		].join('\n'),
	})
	expect(shadowedParamMember.keys).toEqual([])
	expect(shadowedParamMember.failures).toEqual([])

	const functionLocalAlias = scanLiteralMcpServerKeys({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'export default async function run() {',
			'\tconst mcp = kody.mcp',
			'\treturn mcp.home.set_pin({ pin: "1" })',
			'}',
		].join('\n'),
	})
	expect(functionLocalAlias.keys).toEqual(['home'])
	expect(functionLocalAlias.failures).toEqual([])

	const shadowedRestParam = scanLiteralMcpServerKeys({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'const mcp = kody.mcp',
			'export default async function run(...mcp: unknown[]) {',
			'\treturn mcp',
			'}',
			'export function other() {',
			'\treturn mcp.linear.list_issues({})',
			'}',
		].join('\n'),
	})
	expect(shadowedRestParam.keys).toEqual(['linear'])
	expect(shadowedRestParam.failures).toEqual([])

	const shadowedArrayParam = scanLiteralMcpServerKeys({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'const mcp = kody.mcp',
			'export default async function run([mcp]: [unknown]) {',
			'\treturn mcp',
			'}',
			'export function other() {',
			'\treturn mcp.home.set_pin({ pin: "1" })',
			'}',
		].join('\n'),
	})
	expect(shadowedArrayParam.keys).toEqual(['home'])
	expect(shadowedArrayParam.failures).toEqual([])

	const dynamic = scanLiteralMcpServerKeys({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'export default async function run(server: string) {',
			'\treturn kody.mcp[server]',
			'}',
		].join('\n'),
	})
	expect(dynamic.keys).toEqual([])
	expect(dynamic.failures.some((f) => f.code === 'non_literal')).toBe(true)

	// Official *-mcp helpers use `kody.mcp?.[SERVER_NAME]` with a module const.
	const constName = scanLiteralMcpServerKeys({
		'package.json': manifest(),
		'src/mcp.ts': [
			"import { kody } from 'kody:runtime'",
			"export const CANVA_MCP_NAME = 'canva'",
			'export function getCanvaMcp() {',
			'\treturn kody.mcp?.[CANVA_MCP_NAME] ?? null',
			'}',
		].join('\n'),
		'src/index.ts': [
			"import { getCanvaMcp } from './mcp.ts'",
			'export default async function run() {',
			'\treturn getCanvaMcp()',
			'}',
		].join('\n'),
	})
	expect(constName.keys).toEqual(['canva'])
	expect(constName.failures).toEqual([])

	const computedDestructure = scanLiteralMcpServerKeys({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'export default async function run(server: string) {',
			'\tconst { [server]: tool } = kody.mcp',
			'\treturn tool',
			'}',
		].join('\n'),
	})
	expect(computedDestructure.keys).toEqual([])
	expect(
		computedDestructure.failures.some((f) => f.code === 'non_literal'),
	).toBe(true)

	const nestedDestructure = scanLiteralMcpServerKeys({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'export default async function run() {',
			'\tconst { mcp: { linear } } = kody',
			'\treturn linear.list_issues({})',
			'}',
		].join('\n'),
	})
	expect(nestedDestructure.keys).toEqual(['linear'])
	expect(nestedDestructure.failures).toEqual([])

	const escapedRoot = scanLiteralMcpServerKeys({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'export default async function run(call: (mcp: unknown) => unknown) {',
			'\treturn call(kody.mcp)',
			'}',
		].join('\n'),
	})
	expect(escapedRoot.keys).toEqual([])
	expect(escapedRoot.failures.some((f) => f.code === 'non_literal')).toBe(true)

	const restDestructure = scanLiteralMcpServerKeys({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'export default async function run() {',
			'\tconst { ...servers } = kody.mcp',
			'\treturn servers',
			'}',
		].join('\n'),
	})
	expect(restDestructure.keys).toEqual([])
	expect(restDestructure.failures.some((f) => f.code === 'non_literal')).toBe(
		true,
	)
})

test('planCredentialStampSeal infers MCP and OAuth descriptions without overwriting', () => {
	const plan = planCredentialStampSeal({
		'package.json': manifest({
			credentials: {
				EXISTING: { description: 'Keep me.' },
			},
		}),
		'src/index.ts': [
			"import { createAuthenticatedFetch, kody } from 'kody:runtime'",
			'export default async function run() {',
			"\tawait createAuthenticatedFetch('google')",
			'\tawait kody.mcp.linear.list_issues({})',
			'\treturn 1',
			'}',
		].join('\n'),
	})
	expect(plan.blockingFailures).toEqual([])
	expect(plan.updates.map((slot) => slot.key).sort()).toEqual([
		'google',
		'linear',
	])
	expect(plan.updates.find((slot) => slot.key === 'linear')).toMatchObject({
		kind: 'mcp',
		description: 'Calls tools on the attached MCP server "linear".',
	})
	expect(plan.updates.find((slot) => slot.key === 'google')).toMatchObject({
		kind: 'oauth',
		description: 'OAuth access for google.',
	})
	expect(plan.sealReady).toBe(true)
})

test('planCredentialStampSeal fills mcp kind on described slots and never forces signing for secretJwtSign', () => {
	const fillKind = planCredentialStampSeal({
		'package.json': manifest({
			credentials: {
				linear: { description: 'Linear MCP server.' },
			},
		}),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'export default async function run() {',
			'\treturn kody.mcp.linear.list_issues({})',
			'}',
		].join('\n'),
	})
	expect(fillKind.blockingFailures).toEqual([])
	expect(fillKind.updates).toEqual([
		{
			key: 'linear',
			description: 'Linear MCP server.',
			kind: 'mcp',
		},
	])
	expect(fillKind.sealReady).toBe(true)

	const jwt = planCredentialStampSeal({
		'package.json': manifest(),
		'src/index.ts': [
			"import { secretJwtSign } from 'kody:runtime'",
			'export default async function run() {',
			'\treturn secretJwtSign({ private_key_secret_name: "JWT_KEY", claims: {} })',
			'}',
		].join('\n'),
	})
	expect(jwt.blockingFailures).toEqual([])
	expect(jwt.updates.find((slot) => slot.key === 'JWT_KEY')).toMatchObject({
		description: 'Signs tokens with the "JWT_KEY" signing credential.',
	})
	expect(jwt.updates.find((slot) => slot.key === 'JWT_KEY')?.kind).toBe(
		undefined,
	)

	const kindMismatch = planCredentialStampSeal({
		'package.json': manifest({
			credentials: {
				linear: { kind: 'oauth', description: 'Wrong kind for MCP.' },
			},
		}),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'export default async function run() {',
			'\treturn kody.mcp.linear.list_issues({})',
			'}',
		].join('\n'),
	})
	expect(kindMismatch.sealReady).toBe(false)
	expect(
		kindMismatch.blockingFailures.some(
			(failure) => failure.code === 'unstampable_pattern',
		),
	).toBe(true)
})

test('scanCredentialStamp fails missing descriptions without inventing placeholders', () => {
	const result = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			"import { credential } from 'kody:runtime'",
			'export default async function run() { return credential("API_KEY") }',
		].join('\n'),
	})
	expect(result.keys).toEqual(['API_KEY'])
	expect(result.failures.some((f) => f.code === 'missing_description')).toBe(
		true,
	)
	expect(result.failures[0]?.message).toMatch(/Describe what API_KEY is for/)
	expect(result.failures[0]?.message).not.toMatch(/Auto-detected from stamp/)
})

test('mergeCredentialStampIntoManifestFiles adds missing keys and never overwrites descriptions', () => {
	const before = {
		'package.json': manifest({
			credentials: {
				EXISTING: { description: 'Keep me.' },
			},
		}),
		'src/index.ts': 'export default async function run() { return 1 }',
	}
	const { files, addedKeys } = mergeCredentialStampIntoManifestFiles(before, [
		'EXISTING',
		'NEW_KEY',
	])
	expect(addedKeys).toEqual(['NEW_KEY'])
	const parsed = JSON.parse(files['package.json']!) as {
		kody: { credentials: Record<string, { description?: string }> }
	}
	expect(parsed.kody.credentials.EXISTING).toEqual({ description: 'Keep me.' })
	expect(parsed.kody.credentials.NEW_KEY).toEqual({})
})

test('buildCredentialStamp sorts keys and hashes dep stamp pins', async () => {
	const stamp = await buildCredentialStamp({
		keys: ['B', 'A'],
		depStamps: [
			{
				packageId: 'pkg-2',
				publishedCommit: 'bbb',
				stampHash: 'hash-b',
			},
			{
				packageId: 'pkg-1',
				publishedCommit: 'aaa',
				stampHash: 'hash-a',
			},
		],
	})
	expect(stamp.keys).toEqual(['A', 'B'])
	expect(stamp.depStamps.map((d) => d.packageId)).toEqual(['pkg-1', 'pkg-2'])
	expect(stamp.stampHash).toMatch(/^[0-9a-f]{64}$/)
	const again = await buildCredentialStamp({
		keys: ['A', 'B'],
		depStamps: stamp.depStamps,
	})
	expect(again.stampHash).toBe(stamp.stampHash)
})

function appManifestFiles(extra: Record<string, string>) {
	return {
		'package.json': JSON.stringify({
			name: '@kody/app',
			exports: { '.': './src/server.ts' },
			kody: {
				id: 'app',
				description: 'App.',
				app: { entry: './src/server.ts', client: './src/client.ts' },
			},
		}),
		...extra,
	}
}

test('literal dynamic import with TS assertion is not server_eval', () => {
	const stamped = scanCredentialStamp(
		appManifestFiles({
			'src/server.ts': [
				'export default {',
				'  async fetch() {',
				"    const mod = await import('kody:@kentcdodds/helper/run' as `kody:@${string}/${string}`)",
				'    return mod.default()',
				'  },',
				'}',
			].join('\n'),
			'src/client.ts': 'export {}',
		}),
	)
	expect(stamped.failures.filter((f) => f.code === 'server_eval')).toEqual([])
})

test('server eval / new Function / non-literal import fail; UI client entry is exempt', () => {
	const serverEval = scanCredentialStamp(
		appManifestFiles({
			'src/server.ts': 'export default { fetch() { return eval("1") } }',
			'src/client.ts': 'eval("ok"); export {}',
		}),
	)
	expect(serverEval.failures.some((f) => f.code === 'server_eval')).toBe(true)
	expect(serverEval.failures.some((f) => f.path === 'src/server.ts')).toBe(true)
	expect(serverEval.failures.some((f) => f.path === 'src/client.ts')).toBe(
		false,
	)

	const uiOnly = scanCredentialStamp(
		appManifestFiles({
			'src/server.ts':
				'export default { fetch() { return new Response("ok") } }',
			'src/client.ts':
				'const run = new Function("return 1"); import(name); export {}',
		}),
	)
	expect(uiOnly.failures.filter((f) => f.code === 'server_eval')).toEqual([])

	const shared = scanCredentialStamp(
		appManifestFiles({
			'src/server.ts':
				'import { boom } from "./shared.ts"; export default { fetch: boom }',
			'src/client.ts': 'import { boom } from "./shared.ts"; boom()',
			'src/shared.ts': 'export const boom = () => eval("1")',
		}),
	)
	expect(shared.failures.some((f) => f.path === 'src/shared.ts')).toBe(true)

	const aliases = [
		'globalThis.eval("1")',
		'window.eval("1")',
		'globalThis["eval"]("1")',
		'globalThis[`eval`]("1")',
		'globalThis[name]("1")',
		'(eval)("1")',
		'(eval as any)("1")',
		'new globalThis.Function("return 1")',
		'Function("return 1")()',
		'globalThis.Function("return 1")()',
	]
	for (const expression of aliases) {
		const aliased = scanCredentialStamp(
			appManifestFiles({
				'src/server.ts': `export default { fetch() { return ${expression} } }`,
				'src/client.ts': 'export {}',
			}),
		)
		expect(
			aliased.failures.some(
				(f) => f.code === 'server_eval' && f.path === 'src/server.ts',
			),
			expression,
		).toBe(true)
	}

	const serverPaths = collectServerRuntimeModulePaths(
		appManifestFiles({
			'src/server.ts':
				'export default { fetch() { return new Response("ok") } }',
			'src/client.ts': 'export {}',
		}),
	)
	expect(serverPaths.has('src/server.ts')).toBe(true)
	expect(serverPaths.has('src/client.ts')).toBe(false)
})

function assetsAppFiles(extra: Record<string, string>) {
	return {
		'package.json': JSON.stringify({
			name: '@kody/assets-app',
			exports: { '.': './src/server.ts' },
			kody: {
				id: 'assets-app',
				description: 'Assets app.',
				app: { entry: './src/server.ts', assets: './public' },
				credentials: {
					API_KEY: { kind: 'secret', description: 'API key.' },
				},
			},
		}),
		...extra,
	}
}

test('unreferenced kody.app.assets modules are not scannable; server-imported assets stay covered', () => {
	expect(
		readPackageAppAssetsDirectory(
			JSON.stringify({ kody: { app: { assets: './public/' } } }),
		),
	).toBe('public')
	expect(isPackageAppAssetPath('public/client/main.js', 'public')).toBe(true)
	expect(isPackageAppAssetPath('src/server.ts', 'public')).toBe(false)

	const unreferenced = assetsAppFiles({
		'src/server.ts': 'export default { fetch() { return new Response("ok") } }',
		'public/client/main.js':
			'eval("asset"); new Function("return 1"); import(name); credential("LEAK")',
	})
	expect(listScannableModulePaths(unreferenced)).toEqual(['src/server.ts'])
	expect(listScannableModulePaths(unreferenced)).not.toContain(
		'public/client/main.js',
	)
	const unreferencedServer = collectServerRuntimeModulePaths(unreferenced)
	expect(unreferencedServer.has('src/server.ts')).toBe(true)
	expect(unreferencedServer.has('public/client/main.js')).toBe(false)

	const unreferencedStamp = scanCredentialStamp(unreferenced)
	expect(
		unreferencedStamp.failures.filter((f) => f.code === 'server_eval'),
	).toEqual([])
	expect(unreferencedStamp.keys).not.toContain('LEAK')

	// A server import of an asset module must still stamp credentials and
	// enforce server_eval (reviewers: do not exempt by directory alone).
	const imported = assetsAppFiles({
		'src/server.ts':
			'import "../public/helper.js"; export default { fetch() { return new Response("ok") } }',
		'public/helper.js':
			'import { credential } from "kody:runtime"; export const leak = () => credential("LEAK"); eval("1")',
	})
	expect(listScannableModulePaths(imported)).toContain('public/helper.js')
	expect(
		collectServerRuntimeModulePaths(imported).has('public/helper.js'),
	).toBe(true)
	const importedStamp = scanCredentialStamp(imported)
	expect(importedStamp.keys).toContain('LEAK')
	expect(
		importedStamp.failures.some(
			(f) => f.code === 'server_eval' && f.path === 'public/helper.js',
		),
	).toBe(true)
})

test('large prebuilt client asset does not fail stamp and stays cheap to scan', () => {
	// ~1.7 MB of minified-shaped JS with eval / Function / dynamic import —
	// mirrors @kentcdodds/world-builder public/client/main.js before the
	// assets skip. The scan must stay well under DO CPU limits.
	const chunk =
		'function x(){eval("1");new Function("return 1");import(n);return 1}'
	const largeClient = `${chunk};`.repeat(
		Math.ceil((1.7 * 1024 * 1024) / (chunk.length + 1)),
	)
	expect(largeClient.length).toBeGreaterThan(1.5 * 1024 * 1024)

	const files = assetsAppFiles({
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

	const started = performance.now()
	const stamp = scanCredentialStamp(files)
	const elapsedMs = performance.now() - started
	expect(stamp.failures).toEqual([])
	expect(stamp.keys).toEqual(['API_KEY'])
	expect(listScannableModulePaths(files)).not.toContain('public/client/main.js')
	// Soft budget: parsing a 1.7 MB asset used to blow the DO CPU limit;
	// skipping it should finish in well under a second on Node.
	expect(elapsedMs).toBeLessThan(2_000)

	const serverStillFails = scanCredentialStamp(
		assetsAppFiles({
			'src/server.ts': 'export default { fetch() { return eval("1") } }',
			'public/client/main.js': largeClient,
		}),
	)
	expect(
		serverStillFails.failures.some(
			(f) => f.code === 'server_eval' && f.path === 'src/server.ts',
		),
	).toBe(true)
})

test('computed |scope= fails the stamp gate and manifest-only secretMounts do not', () => {
	const scoped = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts':
			"export const h = { Authorization: 'Bearer {{secret:TOKEN|scope=package}}' }",
	})
	expect(scoped.failures.some((f) => f.code === 'unstampable_pattern')).toBe(
		true,
	)

	const mounts = scanCredentialStamp({
		'package.json': manifest({
			secretMounts: { token: { name: 'TOKEN' } },
		}),
		'src/index.ts': 'export const ready = true',
	})
	expect(mounts.failures.some((f) => f.message.includes('secretMounts'))).toBe(
		false,
	)
	expect(mounts.failures).toEqual([])
})

test('example vault references with angle-bracket or metavariable forms do not fail the stamp gate', () => {
	const displayOnly = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			'export function status() {',
			"\treturn { example: '{{secret/bwvault:i/<item-uuid>/<field>}}' }",
			'}',
			"export const docs = 'Write {{secret/<provider>:<ref>}} or {{secret/provider:ref}}.'",
		].join('\n'),
	})
	expect(displayOnly.failures).toEqual([])
	expect(displayOnly.keys).toEqual([])

	const liveVaultInFetch = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			'export default async function run() {',
			"\treturn fetch('https://api.example.com/v1', {",
			"\t\theaders: { Authorization: 'Bearer {{secret/bwvault:i/11111111-1111-4111-8111-111111111111/password}}' },",
			'\t})',
			'}',
		].join('\n'),
	})
	expect(
		liveVaultInFetch.failures.some((f) => f.code === 'unstampable_pattern'),
	).toBe(true)
	expect(liveVaultInFetch.failures[0]?.message).toMatch(
		/vault placeholder \{\{secret\/provider:ref\}\}/,
	)
})

test('concrete vault refs in status/help display fields do not fail the stamp gate', () => {
	const statusExamples = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			'export function status() {',
			'\treturn {',
			"\t\texample: '{{secret/bwvault:i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password}}',",
			"\t\thelp: 'Use {{secret/bitwarden:i/00000000-0000-4000-8000-000000000000/value}}',",
			"\t\tdescription: 'Item field ref shape for callers',",
			'\t}',
			'}',
		].join('\n'),
	})
	expect(statusExamples.failures).toEqual([])
	expect(statusExamples.keys).toEqual([])

	const shapedExamples = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			'export function status() {',
			'\treturn {',
			"\t\texample: 'https://api.example.com/?t={{secret/bwvault:i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password}}',",
			'\t\thelp: {',
			'\t\t\theaders: {',
			"\t\t\t\tAuthorization: 'Bearer {{secret/bitwarden:i/00000000-0000-4000-8000-000000000000/value}}',",
			'\t\t\t},',
			'\t\t},',
			'\t}',
			'}',
		].join('\n'),
	})
	expect(shapedExamples.failures).toEqual([])

	const liveVaultStillFails = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			'export function status() {',
			"\treturn { example: '{{secret/bwvault:i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password}}' }",
			'}',
			'export default async function run() {',
			"\treturn fetch('https://api.example.com/v1', {",
			"\t\theaders: { Authorization: 'Bearer {{secret/bwvault:i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password}}' },",
			'\t})',
			'}',
		].join('\n'),
	})
	expect(
		liveVaultStillFails.failures.some((f) => f.code === 'unstampable_pattern'),
	).toBe(true)
	expect(liveVaultStillFails.failures[0]?.message).toMatch(
		/request or credential-mapped site/,
	)

	const docsNamedFetchBody = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			'export default async function run() {',
			"\treturn fetch('https://api.example.com/v1', {",
			"\t\tmethod: 'POST',",
			"\t\tbody: JSON.stringify({ description: '{{secret/bwvault:i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password}}' }),",
			'\t})',
			'}',
		].join('\n'),
	})
	expect(
		docsNamedFetchBody.failures.some((f) => f.code === 'unstampable_pattern'),
	).toBe(true)

	const headerHelper = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			'function authHeaders() {',
			'\treturn {',
			"\t\theaders: { Authorization: 'Bearer {{secret/bwvault:i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password}}' },",
			'\t}',
			'}',
			'export default authHeaders',
		].join('\n'),
	})
	expect(
		headerHelper.failures.some((f) => f.code === 'unstampable_pattern'),
	).toBe(true)
})

test('isStoredCredentialStamp rejects a dependency pin that is not an object', () => {
	const stamp = {
		version: 1,
		keys: ['RESEND'],
		depStamps: [null],
		stampHash: 'abc',
	}
	expect(isStoredCredentialStamp(stamp)).toBe(false)
	expect(
		isStoredCredentialStamp({
			...stamp,
			depStamps: [
				{
					packageId: 'pkg',
					publishedCommit: 'commit',
					stampHash: 'dep',
				},
			],
		}),
	).toBe(true)
})

const vaultRef = 'i/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/password'

function vaultFetchModule(provider: string) {
	return [
		'function authHeaders() {',
		`\treturn { Authorization: 'Bearer {{secret/${provider}:${vaultRef}}}' }`,
		'}',
		'export default async function run() {',
		"\treturn fetch('https://api.example.com/v1', {",
		"\t\tmethod: 'POST',",
		'\t\theaders: authHeaders(),',
		`\t\tbody: JSON.stringify({ token: '{{secret/${provider}:${vaultRef}}}' }),`,
		'\t})',
		'}',
	].join('\n')
}

const vaultSlot = {
	vault: {
		kind: 'secret-provider',
		package: '@acme/vault-provider',
		description: 'Reads the deploy token from the team vault.',
	},
}

test('a secret-provider slot seals vault placeholders whose id its package declares', () => {
	for (const provider of ['1password', 'bitwarden']) {
		const result = scanCredentialStamp(
			{
				'package.json': manifest({ credentials: vaultSlot }),
				'src/index.ts': vaultFetchModule(provider),
			},
			{ secretProviders: { ids: { vault: provider }, failures: [] } },
		)
		expect(result.failures, provider).toEqual([])
		expect(result.keys, provider).toEqual(['vault'])
		expect(result.staleManifestKeys, provider).toEqual([])
	}
})

test('vault placeholders without a matching provider package still fail the stamp gate', () => {
	const cases: Array<
		[
			string,
			Record<string, unknown> | undefined,
			Record<string, string> | undefined,
		]
	> = [
		['no slot', undefined, {}],
		['package declares another id', vaultSlot, { vault: 'bitwarden' }],
		['package not resolved', vaultSlot, undefined],
		[
			'slot keyed by the provider without the kind',
			{ '1password': { description: 'Reads from 1Password.' } },
			{},
		],
		[
			'no description',
			{ vault: { kind: 'secret-provider', package: '@acme/vault-provider' } },
			{ vault: '1password' },
		],
	]
	for (const [label, credentials, ids] of cases) {
		const result = scanCredentialStamp(
			{
				'package.json': manifest(credentials ? { credentials } : {}),
				'src/index.ts': vaultFetchModule('1password'),
			},
			ids ? { secretProviders: { ids, failures: [] } } : {},
		)
		const failure = result.failures.find(
			(f) => f.code === 'unstampable_pattern',
		)
		expect(failure, label).toBeDefined()
		expect(failure?.message, label).toContain('provider id "1password"')
		expect(failure?.message, label).toContain('"kind": "secret-provider"')
		expect(result.keys, label).not.toContain('vault')
	}
})

test('secret-provider slot resolution failures fail the stamp gate', () => {
	const result = scanCredentialStamp(
		{
			'package.json': manifest({ credentials: vaultSlot }),
			'src/index.ts': 'export default () => 1',
		},
		{
			secretProviders: {
				ids: {},
				failures: [
					{
						code: 'unstampable_pattern',
						message: 'kody.credentials.vault names provider package x.',
					},
				],
			},
		},
	)
	expect(result.failures.map((f) => f.message)).toContain(
		'kody.credentials.vault names provider package x.',
	)
})

test('a vault placeholder with a computed provider id still fails the stamp gate', () => {
	const result = scanCredentialStamp(
		{
			'package.json': manifest({ credentials: vaultSlot }),
			'src/index.ts': [
				'export default async function run(provider) {',
				"\treturn fetch('https://api.example.com/v1', {",
				`\t\theaders: { Authorization: \`Bearer {{secret/\${provider}:${vaultRef}}}\` },`,
				'\t})',
				'}',
			].join('\n'),
		},
		{ secretProviders: { ids: { vault: '1password' }, failures: [] } },
	)
	expect(result.failures.some((f) => f.code === 'unstampable_pattern')).toBe(
		true,
	)
	expect(result.keys).not.toContain('vault')
})

test('a secret-provider slot does not seal display-only vault placeholders', () => {
	const result = scanCredentialStamp(
		{
			'package.json': manifest({ credentials: vaultSlot }),
			'src/index.ts': [
				'export function status() {',
				`\treturn { example: '{{secret/1password:${vaultRef}}}' }`,
				'}',
			].join('\n'),
		},
		{ secretProviders: { ids: { vault: '1password' }, failures: [] } },
	)
	expect(result.failures).toEqual([])
	expect(result.keys).toEqual([])
	expect(result.staleManifestKeys).toEqual(['vault'])
})
