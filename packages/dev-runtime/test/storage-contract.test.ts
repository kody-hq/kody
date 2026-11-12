/**
 * The local half of the packageStorage() contract: a package app on the
 * built local Kody (real workers, local Durable Objects) runs the same steps
 * the hosted StorageRunner test runs in storage-runner.workers.test.ts.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
	runStorageKvContract,
	type StorageKvContractEntry,
} from '../../shared/src/storage-kv-contract.fixture.ts'

const distDir = fileURLToPath(new URL('../dist', import.meta.url))
const built = existsSync(join(distDir, 'index.js'))
const username = 'contract'

const files = [
	{
		path: 'package.json',
		content: JSON.stringify({
			name: `@${username}/kvcontract`,
			version: '0.0.0',
			type: 'module',
			exports: { '.': './src/index.ts' },
			kody: {
				description: 'packageStorage contract fixture',
				app: { entry: 'src/app.ts' },
			},
		}),
	},
	{ path: 'README.md', content: '# kvcontract\n\nStorage contract fixture.\n' },
	{ path: 'AGENTS.md', content: '# kvcontract\n\nTest fixture only.\n' },
	{
		path: 'src/index.ts',
		content: "export default async function main() {\n\treturn 'ok'\n}\n",
	},
	{
		path: 'src/app.ts',
		content: `import { packageStorage } from 'kody:runtime'

export default {
	async fetch(request: Request) {
		const { op, key, value, prefix } = await request.json()
		const storage = packageStorage()
		let result: unknown = null
		if (op === 'get') result = await storage.get(key)
		if (op === 'set') result = await storage.set(key, value)
		if (op === 'delete') result = await storage.delete(key)
		if (op === 'clear') result = await storage.clear()
		if (op === 'list') result = await storage.list(prefix === undefined ? {} : { prefix })
		return Response.json({ result })
	},
}
`,
	},
]

type Runtime = {
	origin: string
	apiToken: string
	sessionCookie: string
	close: () => Promise<void>
}

let runtime: Runtime | null = null
let stateDir = ''

before(async () => {
	if (!built) return
	stateDir = await mkdtemp(join(tmpdir(), 'kody-dev-runtime-contract-'))
	const mod = (await import(join(distDir, 'index.js'))) as {
		startDevRuntime: (input: {
			stateDir: string
			username: string
		}) => Promise<Runtime>
	}
	runtime = await mod.startDevRuntime({ stateDir, username })
	const saved = await fetch(`${runtime.origin}/v1/packages`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${runtime.apiToken}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify({ files }),
	})
	assert.equal(saved.status, 200, await saved.clone().text())
})

after(async () => {
	await runtime?.close()
	if (stateDir) await rm(stateDir, { recursive: true, force: true })
})

async function app(body: Record<string, unknown>) {
	assert.ok(runtime)
	const response = await fetch(
		`${runtime.origin}/@${username}/packages/kvcontract/kv`,
		{
			method: 'POST',
			redirect: 'manual',
			headers: {
				cookie: runtime.sessionCookie,
				'content-type': 'application/json',
			},
			body: JSON.stringify(body),
		},
	)
	const text = await response.text()
	assert.equal(response.status, 200, text)
	return (JSON.parse(text) as { result: unknown }).result
}

test(
	'packageStorage() on local Kody matches the shared hosted contract',
	{ skip: !built && !process.env.CI && 'build @kodycodes/dev-runtime first' },
	async () => {
		assert.ok(built, 'CI runs this after building @kodycodes/dev-runtime')
		const results = await runStorageKvContract({
			get: async (key) => await app({ op: 'get', key }),
			set: async (key, value) => {
				await app({ op: 'set', key, value })
			},
			delete: async (key) =>
				((await app({ op: 'delete', key })) as { deleted: boolean }).deleted,
			list: async (input) =>
				(
					(await app({ op: 'list', prefix: input?.prefix })) as {
						entries: Array<StorageKvContractEntry>
					}
				).entries,
			clear: async () => {
				await app({ op: 'clear' })
			},
		})
		for (const result of results) {
			assert.deepEqual(result.actual, result.expected, result.step)
		}
	},
)
