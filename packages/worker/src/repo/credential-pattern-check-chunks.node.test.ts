import { expect, test } from 'vitest'
import { credentialStampMaxModuleScanBytes } from '#worker/credentials/credential-stamp.ts'
import {
	buildCredentialPatternCheck,
	type CredentialTreeChunkRequest,
	type CredentialTreeScanner,
	planCredentialTreeScan,
	scanCredentialTreeChunk,
} from './credential-pattern-check.ts'

function overTheWire<Value>(value: Value): Value {
	return JSON.parse(JSON.stringify(value)) as Value
}

/**
 * A scanner that works the way the isolated one does: the plan and every
 * chunk read their own copy of the tree and trade only plain data, and no
 * chunk holds more than `maxChunkAstNodes` syntax nodes unless one module
 * does.
 */
function chunkedScanner(
	files: Record<string, string>,
	maxChunkAstNodes: number,
) {
	const requests: Array<CredentialTreeChunkRequest> = []
	const scanner: CredentialTreeScanner = {
		plan: async () =>
			overTheWire(
				await planCredentialTreeScan(overTheWire(files), maxChunkAstNodes),
			),
		async chunks(chunkRequests) {
			requests.push(...chunkRequests)
			// Answer out of order: results must not depend on finish order.
			const answers = await Promise.all(
				[...chunkRequests]
					.reverse()
					.map(async (request) =>
						overTheWire(
							await scanCredentialTreeChunk(
								overTheWire(files),
								overTheWire(request),
							),
						),
					),
			)
			return answers.reverse()
		},
	}
	return { scanner, requests }
}

function manifest(credentials: Record<string, unknown>) {
	return JSON.stringify(
		{
			name: '@example/chunked',
			exports: { '.': './src/index.ts', './admin': './src/admin.ts' },
			kody: {
				id: 'chunked',
				description: 'Chunked credential scan test.',
				app: { entry: './src/app.ts' },
				credentials,
			},
		},
		null,
		2,
	)
}

function manyModules() {
	const files: Record<string, string> = {}
	const imports: Array<string> = []
	for (let index = 0; index < 24; index += 1) {
		files[`src/generated/chunk-${index}.ts`] =
			`export const value${index} = (items: Array<{ value: number }>) => items.map((item) => ({ ...item, score: item.value * ${index + 1} }))\n`
		imports.push(`export * from './generated/chunk-${index}.ts'`)
	}
	return { files, imports }
}

function tree(credentials: Record<string, unknown>) {
	const { files, imports } = manyModules()
	return {
		...files,
		'package.json': manifest(credentials),
		// The secret name is a constant another chunk's module declares.
		'src/a-names.ts': "export const tokenName = 'API_TOKEN'\n",
		'src/index.ts': [
			"import { credential, kody } from 'kody:runtime'",
			"import { tokenName } from './a-names.ts'",
			...imports,
			'export default async function main() {',
			'\tconst client = await credential("BILLING")',
			'\tawait kody.mcp.linear.listIssues({})',
			'\tawait kody.secretJwtSign({ private_key_secret_name: "SIGNING_KEY", claims: {} })',
			'\treturn await client.fetch(`https://api.example.com/items?key={{secret:${tokenName}}}`)',
			'}',
		].join('\n'),
		'src/admin.ts': [
			"import { run } from './z-eval.ts'",
			'export default async function admin(input: { body: string; name: string }) {',
			"\tawait fetch('https://api.example.com/admin', { method: 'POST', body: input.body })",
			'\tawait createAuthenticatedFetch(input.name)',
			'\treturn run(input.body)',
			'}',
		].join('\n'),
		'src/app.ts': [
			'export default {',
			"\tfetch: () => fetch('http://plain.example.com', { headers: { Authorization: 'Bearer {{secret:PLAIN_TOKEN}}' } }),",
			'}',
		].join('\n'),
		'src/z-eval.ts': 'export const run = (code: string) => eval(code)\n',
		'src/z-broken.ts': 'export const broken = {{secret:BROKEN_TOKEN}} (\n',
	}
}

const describedCredentials = {
	API_TOKEN: { kind: 'secret', description: 'API token.' },
	BILLING: { description: 'Billing API key.' },
	STALE: { description: 'No longer used.' },
}

async function expectChunkedMatchesInProcess(files: Record<string, string>) {
	const inProcess = await buildCredentialPatternCheck(files)
	const { scanner, requests } = chunkedScanner(files, 60)
	const chunked = await buildCredentialPatternCheck(files, { scanner })
	expect(chunked).toEqual(inProcess)
	return { result: chunked, requests }
}

test('a credential scan split into chunks reports what one walk of the tree reports', async () => {
	const { result, requests } = await expectChunkedMatchesInProcess(
		tree(describedCredentials),
	)

	expect(result.ok).toBe(false)
	expect(result.stampKeys).toEqual(
		expect.arrayContaining(['API_TOKEN', 'BILLING', 'SIGNING_KEY', 'linear']),
	)
	expect(result.message).toContain('src/z-eval.ts')
	expect(result.fetchBodyHits).toEqual([{ path: 'src/admin.ts', line: 3 }])
	// The missing keys were written to package.json, so the tree was scanned
	// again with that manifest: every chunk ran once for each.
	const rescans = requests.filter((request) => request.manifest != null)
	expect(rescans.length).toBeGreaterThan(3)
	expect(requests.length).toBe(rescans.length * 2)
	const visited = requests
		.filter((request) => request.manifest == null)
		.flatMap((request) => request.visit.map((module) => module.path))
	expect(visited).toEqual([...visited].sort())
	expect(new Set(visited).size).toBe(visited.length)
	expect(visited).toEqual(
		expect.arrayContaining([
			'src/a-names.ts',
			'src/index.ts',
			'src/z-broken.ts',
			'src/z-eval.ts',
		]),
	)
})

test('a chunked scan of a passing tree passes with the same stamp', async () => {
	const files = tree({})
	const { files: generated, imports } = manyModules()
	const passing = {
		...generated,
		'package.json': manifest(describedCredentials),
		'src/a-names.ts': files['src/a-names.ts']!,
		'src/admin.ts': 'export default async function admin() {}\n',
		'src/app.ts': 'export default { fetch: () => new Response("ok") }\n',
		'src/index.ts': [
			"import { credential } from 'kody:runtime'",
			"import { tokenName } from './a-names.ts'",
			...imports,
			'export default async function main() {',
			'\tconst client = await credential("BILLING")',
			'\treturn await client.fetch(`https://api.example.com/items?key={{secret:${tokenName}}}`)',
			'}',
		].join('\n'),
	}
	const { result, requests } = await expectChunkedMatchesInProcess(passing)

	expect(result.ok).toBe(true)
	expect(result.stampKeys).toEqual(['API_TOKEN', 'BILLING'])
	expect(requests.length).toBeGreaterThan(3)
	expect(requests.every((request) => request.manifest == null)).toBe(true)
})

test('a chunked scan still reads the modules the stamp leaves out as oversized', async () => {
	const oversized = `export const send = () => fetch('https://api.example.com/big?key={{secret:BIG_TOKEN}}')\nexport const filler = ${JSON.stringify('x'.repeat(credentialStampMaxModuleScanBytes))}\n`
	const { result, requests } = await expectChunkedMatchesInProcess({
		...tree(describedCredentials),
		'src/generated/oversized.ts': oversized,
	})

	const views = new Set(requests.map((request) => request.view))
	expect(views).toEqual(new Set(['stamp', 'full']))
	expect(
		requests
			.filter((request) => request.view === 'stamp')
			.flatMap((request) => request.visit.map((module) => module.path)),
	).not.toContain('src/generated/oversized.ts')
	expect(result.stampKeys).not.toContain('BIG_TOKEN')
})
