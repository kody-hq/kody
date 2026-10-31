import { cp, realpath, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDevAuth } from '../src/dev-command.js'
import { type DevEvent } from '../src/dev/dev-events.js'
import {
	startPackageAppDev,
	type PackageAppDevOptions,
	type PackageAppDevServer,
} from '../src/package-app-dev.js'
import { loadPackageManifest } from '../src/package-manifest.js'
import { ensureWorkerdBinary } from '../src/workerd-binary.js'

const fixtureRoot = join(
	dirname(fileURLToPath(import.meta.url)),
	'fixtures/sample-package',
)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const appEntry = `import { message } from './message.ts'

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    console.log('handling', url.pathname, { n: 1 })
    if (url.pathname === '/boom') throw new Error('kaboom')
    return new Response('<!doctype html><html><head></head><body>' + message + '</body></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  },
}
`

export async function withDevServer(
	run: (input: {
		server: PackageAppDevServer
		root: string
		events: Array<DevEvent>
		writeMessage: (source: string) => Promise<void>
	}) => Promise<void>,
	options: Partial<PackageAppDevOptions> & {
		/** Runs after the fixture is copied and before the manifest is loaded. */
		prepare?: (root: string) => Promise<void>
	} = {},
): Promise<void> {
	const { prepare, ...devOptions } = options
	// Resolve workerd from the real cache before KODY_CACHE_DIR is pointed at scratch.
	const workerdPath = await ensureWorkerdBinary()
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'kody-dev-server-test-')),
	)
	const cache = await mkdtemp(join(tmpdir(), 'kody-dev-server-cache-'))
	const previousCache = process.env.KODY_CACHE_DIR
	process.env.KODY_CACHE_DIR = cache
	await cp(fixtureRoot, root, { recursive: true })
	await writeFile(join(root, 'app/entry.ts'), appEntry)
	const messagePath = join(root, 'app/message.ts')
	// Replace via rename so every write is a new inode (editor / sed -i style).
	const writeMessage = async (source: string) => {
		await writeFile(`${messagePath}.next`, source)
		await rename(`${messagePath}.next`, messagePath)
	}
	await writeMessage(`export const message = 'v0'\n`)
	await prepare?.(root)
	const auth = await resolveDevAuth({
		target: 'mock',
		token: 'mock',
		apiUrl: 'https://api.kody.codes',
		resetStorage: true,
		packageId: 'local:sample-dev-package',
	})
	const events: Array<DevEvent> = []
	const server = await startPackageAppDev({
		manifest: await loadPackageManifest(root),
		token: auth.token,
		apiUrl: auth.apiUrl,
		target: 'mock',
		debounceMs: 20,
		workerdPath,
		onEvent: (event) => events.push(event),
		...devOptions,
	})
	try {
		await run({ server, root, events, writeMessage })
	} finally {
		await server.close()
		await auth.closeMock?.()
		if (previousCache === undefined) delete process.env.KODY_CACHE_DIR
		else process.env.KODY_CACHE_DIR = previousCache
		await rm(root, { recursive: true, force: true, maxRetries: 10 })
		await rm(cache, { recursive: true, force: true, maxRetries: 10 })
	}
}

export async function waitFor<T>(
	probe: () => Promise<T | undefined>,
	label: string,
	timeoutMs = 15_000,
): Promise<T> {
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		const value = await probe()
		if (value !== undefined) return value
		await sleep(15)
	}
	throw new Error(`Timed out waiting for ${label}`)
}
