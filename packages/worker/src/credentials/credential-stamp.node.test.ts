import { expect, test } from 'vitest'
import {
	collectServerRuntimeModulePaths,
	mergeCredentialStampIntoManifestFiles,
	planCredentialStampSeal,
	isStoredCredentialStamp,
	scanCredentialStamp,
	scanLiteralMcpServerKeys,
} from './credential-stamp.ts'
import { listScannableModulePaths } from './module-placeholder-scan.ts'

function manifest(kody: Record<string, unknown> = {}) {
	return JSON.stringify({
		name: '@kody/stamp',
		exports: { '.': './src/index.ts' },
		kody: { id: 'stamp', description: 'Stamp test.', ...kody },
	})
}

test('scanCredentialStamp fails non-literal credential(), createAuthenticatedFetch, and secretJwtSign names', async () => {
	const credentialVar = await scanCredentialStamp({
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
		/call credential\("SLOT"\).*with its literal key/,
	)
	expect(credentialVar.failures[0]?.message).toMatch(/credentials call map/)

	const fetchVar = await scanCredentialStamp({
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

	const jwtVar = await scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			"const keyName = 'APNS_KEY'",
			'export const sign = () => kody.secretJwtSign({ private_key_secret_name: keyName, claims: {} })',
		].join('\n'),
	})
	expect(jwtVar.failures.some((f) => f.code === 'non_literal')).toBe(true)
})

test('scanCredentialStamp fails credential.named() in stamped packages', async () => {
	const result = await scanCredentialStamp({
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

	const viaKody = await scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			'export default async function run() {',
			'  return kody.credential.named("API_KEY")',
			'}',
		].join('\n'),
	})
	expect(viaKody.failures.some((f) => f.code === 'credential_named')).toBe(true)

	const computedMember = await scanCredentialStamp({
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

	const bound = await scanCredentialStamp({
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

test('scanCredentialStamp stamps credential.visitor literal keys', async () => {
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
		const result = await scanCredentialStamp({
			'package.json': manifest({ credentials }),
			'src/index.ts': source.join('\n'),
		})
		expect(result.failures).toEqual([])
		expect(result.keys).toEqual(['GITHUB'])
	}
	const escaped = await scanCredentialStamp({
		'package.json': manifest({ credentials }),
		'src/index.ts': [
			"import { credential } from 'kody:runtime'",
			'const open = credential.visitor',
			"export default async function run() { return open('GITHUB') }",
		].join('\n'),
	})
	expect(escaped.failures.some((f) => f.code === 'non_literal')).toBe(true)
	expect(escaped.failures[0]?.message).toMatch(/credential\.visitor\("SLOT"\)/)
	const computed = await scanCredentialStamp({
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

test('scanCredentialStamp ignores credential/credentials in erased type positions', async () => {
	const credentials = {
		API_KEY: { kind: 'secret', description: 'API key.' },
	}
	const typeOnlyForms = [
		'export type OpenClient = Awaited<ReturnType<typeof credential>>',
		'export type Clients = Awaited<ReturnType<typeof credentials>>',
		'type Visitor = Awaited<ReturnType<typeof credential.visitor>>',
		'type ViaKody = Awaited<ReturnType<typeof kody.credential>>',
		'interface Holder { open: typeof credential; many: typeof credentials }',
		'let open: typeof credential | undefined',
		'function take(open: typeof credential): ReturnType<typeof credentials> { throw new Error(String(open)) }',
		'class Box<T = typeof credential> implements Partial<Record<"x", typeof credentials>> { declare open: typeof credential }',
		'const value = {} as unknown as Awaited<ReturnType<typeof credential>>',
		'const checked = {} satisfies Partial<Record<"open", typeof credential>>',
		'const tagged = <T,>(value: T) => value; tagged<typeof credential | null>(null)',
		'declare const ambient: typeof credential',
		'declare function ambientOpen(open: typeof credentials): void',
		'declare module "x" { export const open: typeof credential }',
		'declare global { var kodyOpen: typeof credential }',
		'export type { LoginClient as Client }',
		'type Fn = (open: typeof credential) => typeof credentials',
		'type Mapped = { [K in "a"]: typeof credential }',
		'type Cond<T> = T extends typeof credential ? 1 : 0',
		'type Named = typeof credential.named',
		'type ViaKodyNamed = typeof kody.credential.named',
		'import Mcp = kody.mcp',
	]
	for (const form of typeOnlyForms) {
		const result = await scanCredentialStamp({
			'package.json': manifest({ credentials }),
			'src/index.ts': [
				"import { credential, credentials, kody, type KodyCredentialClient } from 'kody:runtime'",
				'export type LoginClient = KodyCredentialClient',
				form,
				'export default async function run() {',
				"  return [await credential('API_KEY'), await credentials('API_KEY')]",
				'}',
			].join('\n'),
		})
		expect({ form, failures: result.failures }).toEqual({ form, failures: [] })
		expect(result.keys).toEqual(['API_KEY'])
	}
	const declarationFile = await scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': 'export default async function run() { return 1 }',
		'src/client.d.ts': [
			"import type { credential } from 'kody:runtime'",
			'export type OpenClient = Awaited<ReturnType<typeof credential>>',
			'export declare const open: typeof credential',
		].join('\n'),
	})
	expect(declarationFile.failures).toEqual([])
})

test('scanCredentialStamp accepts a runtime typeof check but still rejects every runtime pass of credential/credentials', async () => {
	const credentials = {
		API_KEY: { kind: 'secret', description: 'API key.' },
	}
	const typeofCheck = await scanCredentialStamp({
		'package.json': manifest({ credentials }),
		'src/index.ts': [
			"import { credential, kody } from 'kody:runtime'",
			'export default async function run() {',
			"  if (typeof credential !== 'function') return null",
			"  if (typeof kody.credential.visitor !== 'function') return null",
			"  return credential('API_KEY')",
			'}',
		].join('\n'),
	})
	expect(typeofCheck.failures).toEqual([])
	expect(typeofCheck.keys).toEqual(['API_KEY'])

	const runtimeForms = [
		'const c = credential',
		'const c = credentials',
		'const c = kody.credential',
		'const v = credential.visitor',
		'take(credential)',
		'take(credentials)',
		'take(kody.credentials)',
		'const box = { credential }',
		'const box = { open: credential }',
		'const box = { ...credential }',
		'const list = [credential]',
		'export const open = () => credential',
		'function open() { return credential }',
		'export { credential }',
		'export default credential',
		'const c = credential as typeof credential',
		'const c = credential satisfies typeof credential',
		'const c = credential!',
		'const c = <typeof credential>credential',
		'const c = credential<string>',
		'const c = typeof (x = credential)',
		'const c = typeof (0, credential)',
		'const t = `${typeof credential}` + String(credential)',
		'class K { constructor(private open = credential) {} }',
		'enum E { A = String(credential).length }',
		'namespace N { export const open = credential }',
		'const c = void credential',
		'function f(open = credential) { return open }',
		'const c = credential.bind(null)',
		'import c = credential',
		'import c = kody.credential',
		'export import c = kody.credentials',
		'import v = credential.visitor',
		'import v = kody.credential.visitor',
		'@take(credential) class D {}',
	]
	for (const form of runtimeForms) {
		const result = await scanCredentialStamp({
			'package.json': manifest({ credentials }),
			'src/index.ts': [
				"import { credential, credentials, kody } from 'kody:runtime'",
				'let x: unknown',
				'declare function take(value: unknown): void',
				form,
				"export async function run() { return credential('API_KEY') }",
			].join('\n'),
		})
		expect({
			form,
			passed: result.failures.some(
				(failure) =>
					failure.code === 'non_literal' &&
					/passes credential/.test(failure.message),
			),
		}).toEqual({ form, passed: true })
	}
})

test('scanLiteralMcpServerKeys stamps literal servers and fails dynamic access', async () => {
	const literal = await scanLiteralMcpServerKeys({
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
	const optionalBracketForms = await scanLiteralMcpServerKeys({
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
	const kasaSealPlan = await planCredentialStampSeal({
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
	const destructuredHelper = await scanLiteralMcpServerKeys({
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

	const shadowedLooseHelper = await scanLiteralMcpServerKeys({
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

	const unrelatedMcpData = await scanLiteralMcpServerKeys({
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
	const unrelatedMatchingSlot = await scanLiteralMcpServerKeys({
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

	const serverNamedMcp = await scanLiteralMcpServerKeys({
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

	const viaAlias = await scanLiteralMcpServerKeys({
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

	const shadowedParam = await scanLiteralMcpServerKeys({
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

	const shadowedParamMember = await scanLiteralMcpServerKeys({
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

	const functionLocalAlias = await scanLiteralMcpServerKeys({
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

	const shadowedRestParam = await scanLiteralMcpServerKeys({
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

	const shadowedArrayParam = await scanLiteralMcpServerKeys({
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

	const dynamic = await scanLiteralMcpServerKeys({
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
	const constName = await scanLiteralMcpServerKeys({
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

	const computedDestructure = await scanLiteralMcpServerKeys({
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

	const nestedDestructure = await scanLiteralMcpServerKeys({
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

	const escapedRoot = await scanLiteralMcpServerKeys({
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

	const restDestructure = await scanLiteralMcpServerKeys({
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

test('planCredentialStampSeal infers MCP and OAuth descriptions without overwriting', async () => {
	const plan = await planCredentialStampSeal({
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

test('planCredentialStampSeal fills mcp kind on described slots and never forces signing for secretJwtSign', async () => {
	const fillKind = await planCredentialStampSeal({
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

	const jwt = await planCredentialStampSeal({
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

	const kindMismatch = await planCredentialStampSeal({
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

test('scanCredentialStamp fails missing descriptions without inventing placeholders', async () => {
	const result = await scanCredentialStamp({
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

test('server eval / new Function / non-literal import fail; UI client entry is exempt', async () => {
	const serverEval = await scanCredentialStamp(
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

	const uiOnly = await scanCredentialStamp(
		appManifestFiles({
			'src/server.ts':
				'export default { fetch() { return new Response("ok") } }',
			'src/client.ts':
				'const run = new Function("return 1"); import(name); export {}',
		}),
	)
	expect(uiOnly.failures.filter((f) => f.code === 'server_eval')).toEqual([])

	const shared = await scanCredentialStamp(
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
		const aliased = await scanCredentialStamp(
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

	const serverPaths = await collectServerRuntimeModulePaths(
		appManifestFiles({
			'src/server.ts':
				'export default { fetch() { return new Response("ok") } }',
			'src/client.ts': 'export {}',
		}),
	)
	expect(serverPaths.has('src/server.ts')).toBe(true)
	expect(serverPaths.has('src/client.ts')).toBe(false)
})

test('a server module the parser rejects fails closed when it mentions credential or kody; UI client entry is exempt', async () => {
	const unparseable = [
		"import { credential } from 'kody:runtime'",
		'const open = credential',
		'export default { fetch() { return open } } }',
	].join('\n')
	const server = await scanCredentialStamp(
		appManifestFiles({
			'src/server.ts': unparseable,
			'src/client.ts': 'export {}',
		}),
	)
	expect(server.failures).toEqual([
		expect.objectContaining({
			code: 'non_literal',
			path: 'src/server.ts',
			message: expect.stringMatching(/could not be parsed \(.+\)/),
		}),
	])

	const unrelated = await scanCredentialStamp(
		appManifestFiles({
			'src/server.ts': 'export default { fetch() { return 1 } } }',
			'src/client.ts': 'export {}',
		}),
	)
	expect(unrelated.failures).toEqual([])

	const clientOnly = await scanCredentialStamp(
		appManifestFiles({
			'src/server.ts':
				'export default { fetch() { return new Response("ok") } }',
			'src/client.ts': unparseable,
		}),
	)
	expect(clientOnly.failures.filter((f) => f.code === 'non_literal')).toEqual(
		[],
	)
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

test('large prebuilt client asset does not fail stamp and stays cheap to scan', async () => {
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

	const stamp = await scanCredentialStamp(files)
	expect(stamp.failures).toEqual([])
	expect(stamp.keys).toEqual(['API_KEY'])
	expect(await listScannableModulePaths(files)).not.toContain(
		'public/client/main.js',
	)

	const serverStillFails = await scanCredentialStamp(
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

test('computed |scope= fails the stamp gate and manifest-only secretMounts do not', async () => {
	const scoped = await scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts':
			"export const h = { Authorization: 'Bearer {{secret:TOKEN|scope=package}}' }",
	})
	expect(scoped.failures.some((f) => f.code === 'unstampable_pattern')).toBe(
		true,
	)

	const mounts = await scanCredentialStamp({
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

test('example vault references with angle-bracket or metavariable forms do not fail the stamp gate', async () => {
	const displayOnly = await scanCredentialStamp({
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

	const liveVaultInFetch = await scanCredentialStamp({
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

test('concrete vault refs in status/help display fields do not fail the stamp gate', async () => {
	const statusExamples = await scanCredentialStamp({
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

	const shapedExamples = await scanCredentialStamp({
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

	const liveVaultStillFails = await scanCredentialStamp({
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

	const docsNamedFetchBody = await scanCredentialStamp({
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

	const headerHelper = await scanCredentialStamp({
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

test('a secret-provider slot seals vault placeholders whose id its package declares', async () => {
	for (const provider of ['1password', 'bitwarden']) {
		const result = await scanCredentialStamp(
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

test('vault placeholders without a matching provider package still fail the stamp gate', async () => {
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
		const result = await scanCredentialStamp(
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

test('secret-provider slot resolution failures fail the stamp gate', async () => {
	const result = await scanCredentialStamp(
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

test('a vault placeholder with a computed provider id still fails the stamp gate', async () => {
	const result = await scanCredentialStamp(
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

test('a secret-provider slot does not seal display-only vault placeholders', async () => {
	const result = await scanCredentialStamp(
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

test('a literal name under a described prefix slot needs no description of its own', async () => {
	const source = [
		"import { credential } from 'kody:runtime'",
		'export default async function run() {',
		'  return credential("google-work")',
		'}',
	].join('\n')
	const prefixed = { prefix: true, description: 'Google accounts.' }
	for (const credentials of [
		{ google: prefixed },
		// The slot the stamp merge writes for the literal has no description.
		{ google: prefixed, 'google-work': {} },
	]) {
		const scan = await scanCredentialStamp({
			'package.json': manifest({ credentials }),
			'src/index.ts': source,
		})
		expect(scan.failures).toEqual([])
		expect(scan.keys).toEqual(['google-work'])
	}
	const otherKind = await scanCredentialStamp({
		'package.json': manifest({
			credentials: {
				google: { ...prefixed, kind: 'oauth' },
				'google-work': { kind: 'signing' },
			},
		}),
		'src/index.ts': source,
	})
	expect(otherKind.failures.map((failure) => failure.code)).toEqual([
		'missing_description',
	])
	const bare = await scanCredentialStamp({
		'package.json': manifest({
			credentials: { google: { description: 'Google.' } },
		}),
		'src/index.ts': source,
	})
	expect(bare.failures.map((failure) => failure.code)).toEqual([
		'missing_description',
	])
})
