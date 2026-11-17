/**
 * `kody dev --target mock` on the real local Kody: an app that imports
 * mapped local deps (`.kody/deps.json` and `package.json#kody.localDeps`),
 * one of them only through another, serves, and an edit to the deepest dep
 * reaches the app without restarting.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import {
	mkdir,
	mkdtemp,
	realpath,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises'
import { request } from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveDevAuth } from '../src/dev-command.js'
import {
	createLocalKodyUpstream,
	startLocalKody,
} from '../src/dev/local-kody.js'
import { startPackageAppDev } from '../src/package-app-dev.js'
import { loadPackageManifest } from '../src/package-manifest.js'
import { waitFor } from './dev-server-harness.js'

const devRuntimeBuilt = existsSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		'../../dev-runtime/dist/index.js',
	),
)

async function writeTree(root: string, files: Record<string, string>) {
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true })
		await writeFile(join(root, path), content)
	}
}

function packageFiles(input: {
	name: string
	source: string
	extra?: Record<string, unknown>
	files?: Record<string, string>
}) {
	const leaf = input.name.split('/')[1]
	return {
		'package.json': `${JSON.stringify(
			{
				name: input.name,
				version: '0.0.0',
				type: 'module',
				exports: { '.': './src/index.ts' },
				kody: { description: `${leaf} fixture`, ...input.extra },
			},
			null,
			2,
		)}\n`,
		'README.md': `# ${leaf}\n\nFixture.\n`,
		'AGENTS.md': `# ${leaf}\n\nTest fixture only.\n`,
		'src/index.ts': input.source,
		...input.files,
	}
}

async function freePort() {
	const server = createServer()
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	await new Promise((resolve) => server.close(resolve))
	return port
}

function get(url: string, host: string) {
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const req = request(url, { headers: { host } }, (res) => {
			let body = ''
			res.on('data', (chunk) => (body += chunk))
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
		})
		req.on('error', reject)
		req.end()
	})
}

test(
	'kody dev --target mock saves mapped local deps into local Kody and re-saves them on change',
	{
		skip:
			!devRuntimeBuilt &&
			!process.env.KODY_REQUIRE_DEV_RUNTIME &&
			'build @kodycodes/dev-runtime first',
		timeout: 240_000,
	},
	async () => {
		const scratch = await realpath(
			await mkdtemp(join(tmpdir(), 'kody-dev-mapped-deps-')),
		)
		const cache = await mkdtemp(join(tmpdir(), 'kody-dev-mapped-deps-cache-'))
		const previousCache = process.env.KODY_CACHE_DIR
		process.env.KODY_CACHE_DIR = cache
		const appRoot = join(scratch, 'app')
		const tokenSource = (version: string) =>
			`export function token() {\n\treturn 'token ${version}'\n}\n`
		// The dep's own package.json name and kody.id differ from the name it
		// is mapped under, like a checkout of someone else's package.
		await writeTree(
			join(scratch, 'token'),
			packageFiles({
				name: '@upstream/tokens',
				extra: { id: 'tokens' },
				source: tokenSource('v1'),
			}),
		)
		await writeTree(
			join(scratch, 'auth'),
			packageFiles({
				name: '@danj/audible-auth',
				extra: { dependencies: { '@danj/token': '*' } },
				source: `import { token } from 'kody:@danj/token'\n\nexport function auth() {\n\treturn 'auth with ' + token()\n}\n`,
			}),
		)
		await writeTree(appRoot, {
			...packageFiles({
				name: '@danj/app',
				source: "export default async function main() {\n\treturn 'ok'\n}\n",
				extra: {
					app: { entry: 'src/app.ts' },
					dependencies: { '@danj/audible-auth': '*' },
					localDeps: { '@danj/token': '../token' },
				},
				files: {
					'src/app.ts': `import { auth } from 'kody:@danj/audible-auth'\n\nexport default {\n\tasync fetch() {\n\t\treturn new Response(auth())\n\t}\n}\n`,
				},
			}),
			'.kody/deps.json': `${JSON.stringify({ '@danj/audible-auth': '../auth' })}\n`,
		})
		const manifest = await loadPackageManifest(appRoot)
		const port = await freePort()
		const auth = await resolveDevAuth({
			target: 'mock',
			token: 'mock',
			apiUrl: 'https://api.kody.codes',
			resetStorage: true,
			packageId: 'local:app',
		})
		const kody = await startLocalKody({ manifest, packageAppPort: port })
		try {
			const server = await startPackageAppDev({
				manifest,
				localKody: createLocalKodyUpstream({ kody, manifest }),
				token: auth.token,
				apiUrl: auth.apiUrl,
				target: 'mock',
				port,
				debounceMs: 20,
			})
			try {
				const host = new URL(server.hostedUrl).host
				const first = await get(server.localUrl, host)
				assert.equal(first.status, 200, first.body)
				assert.equal(first.body, 'auth with token v1')

				const tokenPath = join(scratch, 'token/src/index.ts')
				await writeFile(`${tokenPath}.next`, tokenSource('v2'))
				await rename(`${tokenPath}.next`, tokenPath)
				await waitFor(
					async () => {
						const next = await get(server.localUrl, host)
						return next.body === 'auth with token v2' ? next : undefined
					},
					'the edited mapped dep to reach the app',
					60_000,
				)
			} finally {
				await server.close()
			}
		} finally {
			await kody.close()
			await auth.closeMock?.()
			if (previousCache === undefined) delete process.env.KODY_CACHE_DIR
			else process.env.KODY_CACHE_DIR = previousCache
			await rm(scratch, { recursive: true, force: true, maxRetries: 10 })
			await rm(cache, { recursive: true, force: true, maxRetries: 10 })
		}
	},
)
