/**
 * kody#4067: `execute --local --file` from a package checkout where the entry
 * imports its own package exports (resolved from the working tree) and those
 * exports import published packages. The package-graph request must be built
 * from the imports that are still unresolved, not from the original entry.
 *
 * The fake API below mirrors origin: when `code` is present it ignores
 * `imports` and builds root aliases only from the code's static `kody:@`
 * imports, and unpublished exports fail with `package_import_unpublished`.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { runCli } from '../src/cli.js'
import {
	localExecuteGatewayFetchShimModuleName,
	localPackageGraphPath,
} from '../src/local-package-graph.js'

const goodToken = 'kody_tok_4067'

/** What origin has published. The self-package `./helper` is stale there. */
const published: Record<string, string> = {
	'kody:@local/demo/helper':
		"export const greet = () => 'published-stale-helper'\n",
	'kody:@pub/lib/util': "export const suffix = '!pub'\n",
}

type GraphRequest = { code?: string; imports?: Array<string> }
const graphRequests: Array<GraphRequest> = []
/** When true, the fake origin drops every root alias (forces the error path). */
let omitAliases = false
let apiUrl = ''
let server: Server
let root = ''
const originalCwd = process.cwd()
const originalHome = process.env.HOME
const originalXdg = process.env.XDG_CONFIG_HOME

function staticKodyImports(code: string): Array<string> {
	const found = new Set<string>()
	const pattern = /^\s*import\s+(?:[^'"]*?\s+from\s+)?['"](kody:@[^'"]+)['"]/gm
	for (const match of code.matchAll(pattern)) found.add(match[1]!)
	return [...found]
}

function synthesize(imports: Array<string>): string {
	return `${imports.map((s) => `import ${JSON.stringify(s)}`).join('\n')}\nexport default async function main() {}\n`
}

before(async () => {
	server = createServer(async (request, response) => {
		const send = (status: number, payload: unknown) => {
			response.writeHead(status, { 'content-type': 'application/json' })
			response.end(JSON.stringify(payload))
		}
		const chunks: Array<Buffer> = []
		for await (const chunk of request) chunks.push(chunk as Buffer)
		const raw = Buffer.concat(chunks).toString('utf8')
		if (request.headers.authorization !== `Bearer ${goodToken}`) {
			send(401, { error: { code: 'invalid_token', message: 'unknown token' } })
			return
		}
		if (request.url?.startsWith(`/${localPackageGraphPath}`)) {
			const body = JSON.parse(raw) as GraphRequest
			graphRequests.push(body)
			// Origin: `code` wins; `imports` only matters when `code` is absent.
			const code = body.code ?? synthesize(body.imports ?? [])
			const modules: Array<{ name: string; esModule: string }> = [
				{
					name: localExecuteGatewayFetchShimModuleName,
					esModule: 'export {}\n',
				},
			]
			const roots = staticKodyImports(code)
			for (const specifier of roots) {
				const source = published[specifier]
				if (source === undefined) {
					send(400, {
						error: {
							code: 'package_import_unpublished',
							message: `Saved package import ${specifier} has no published importable-module artifact for local execute. Publish the package export, then retry.`,
						},
					})
					return
				}
				if (!omitAliases) modules.push({ name: specifier, esModule: source })
			}
			send(200, { modules, imports: roots, warnings: [] })
			return
		}
		send(404, { error: { code: 'not_found', message: request.url } })
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

	root = mkdtempSync(join(tmpdir(), 'kody-4067-'))
	const home = join(root, '.home')
	mkdirSync(home, { recursive: true })
	process.env.HOME = home
	process.env.XDG_CONFIG_HOME = join(home, '.config')
	const pkg = join(root, 'pkg')
	mkdirSync(join(pkg, 'src'), { recursive: true })
	writeFileSync(
		join(pkg, 'package.json'),
		JSON.stringify({
			name: '@local/demo',
			type: 'module',
			exports: {
				'.': './src/index.ts',
				'./helper': './src/helper.ts',
				'./fresh': './src/fresh.ts',
			},
			kody: { id: 'demo' },
		}),
	)
	writeFileSync(join(pkg, 'src/index.ts'), 'export default async () => null\n')
	// Working-tree helper: newer than the published one, and it depends on a
	// published package that only package-graph can supply.
	writeFileSync(
		join(pkg, 'src/helper.ts'),
		`import { suffix } from 'kody:@pub/lib/util'\nexport const greet = (name: string) => 'local:' + name + suffix\n`,
	)
	// Never published: only the working tree has it.
	writeFileSync(
		join(pkg, 'src/fresh.ts'),
		`export const fresh: string = 'working-tree'\n`,
	)
	writeFileSync(
		join(pkg, 'entry-partial.ts'),
		`import { greet } from 'kody:@local/demo/helper'\nexport default async function main() { return { value: greet('x') } }\n`,
	)
	writeFileSync(
		join(pkg, 'entry-local.ts'),
		`import { fresh } from 'kody:@local/demo/fresh'\nexport default async function main() { return { fresh } }\n`,
	)
	process.chdir(pkg)
})

after(async () => {
	process.chdir(originalCwd)
	if (originalHome === undefined) delete process.env.HOME
	else process.env.HOME = originalHome
	if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
	else process.env.XDG_CONFIG_HOME = originalXdg
	await new Promise<void>((resolve) => server.close(() => resolve()))
	rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
	graphRequests.length = 0
	omitAliases = false
})

async function run(args: Array<string>) {
	let stdout = ''
	let stderr = ''
	const code = await runCli(
		['execute', ...args, '--token', goodToken, '--api-url', apiUrl, '--json'],
		{
			stdout: (text) => (stdout += text),
			stderr: (text) => (stderr += text),
		},
	)
	return { code, stdout, stderr }
}

function assertGraphRequestedOnly(expected: Array<string>) {
	assert.ok(graphRequests.length >= 1, 'package-graph was called')
	for (const request of graphRequests) {
		const posted = staticKodyImports(
			request.code ?? synthesize(request.imports ?? []),
		)
		assert.deepEqual(posted.sort(), [...expected].sort())
		assert.deepEqual([...(request.imports ?? [])].sort(), [...expected].sort())
	}
}

test(
	'prod: partial-local entry resolves self export from the working tree and its published dep from package-graph',
	{ timeout: 180_000 },
	async () => {
		const result = await run([
			'--local',
			'--target',
			'prod',
			'--file',
			'entry-partial.ts',
		])
		assert.equal(result.code, 0, result.stderr)
		const body = JSON.parse(result.stdout)
		assert.equal(body.isError, false)
		assert.deepEqual(body.structuredContent.result, { value: 'local:x!pub' })
		assertGraphRequestedOnly(['kody:@pub/lib/util'])
	},
)

test(
	'mock: partial-local entry resolves the published dep through prod package-graph',
	{ timeout: 180_000 },
	async () => {
		const result = await run(['--target', 'mock', '--file', 'entry-partial.ts'])
		assert.equal(result.code, 0, result.stderr)
		const body = JSON.parse(result.stdout)
		assert.equal(body.isError, false)
		assert.deepEqual(body.structuredContent.result, { value: 'local:x!pub' })
		assertGraphRequestedOnly(['kody:@pub/lib/util'])
	},
)

test(
	'prod: fully local graph with an unpublished working-tree export still runs',
	{ timeout: 180_000 },
	async () => {
		const result = await run([
			'--local',
			'--target',
			'prod',
			'--file',
			'entry-local.ts',
		])
		assert.equal(result.code, 0, result.stderr)
		const body = JSON.parse(result.stdout)
		assert.equal(body.isError, false)
		assert.deepEqual(body.structuredContent.result, { fresh: 'working-tree' })
		// Only the gateway-fetch shim is needed: no kody:@ roots posted.
		assertGraphRequestedOnly([])
	},
)

test(
	'--json prints a structured package-graph error and says the module never ran',
	{ timeout: 180_000 },
	async () => {
		omitAliases = true
		const result = await run([
			'--local',
			'--target',
			'prod',
			'--file',
			'entry-partial.ts',
		])
		assert.equal(result.code, 1)
		assert.notEqual(result.stdout.trim(), '', 'stdout must carry JSON')
		const body = JSON.parse(result.stdout)
		assert.equal(body.isError, true)
		const error = body.structuredContent.error
		assert.equal(error.code, 'incomplete_package_graph')
		assert.equal(error.phase, 'package_graph')
		assert.equal(error.moduleRan, false)
		assert.deepEqual(error.missing, ['kody:@pub/lib/util'])
		assert.match(error.message, /never ran/)
		assert.match(error.message, /not an auth/i)
		assert.match(result.stderr, /never ran/)
	},
)
