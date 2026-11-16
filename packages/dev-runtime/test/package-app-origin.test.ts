/**
 * Local Kody serves a package app at the root of its own origin,
 * `http://{leaf}--{handle}.localhost:<port>`, routed by Host exactly like the
 * hosted `{leaf}--{handle}` app host. `kody dev` relies on this.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { request, type IncomingHttpHeaders } from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const distDir = fileURLToPath(new URL('../dist', import.meta.url))
const built = existsSync(join(distDir, 'index.js'))
const username = 'origin'
// Stands in for the `kody dev` port: local Kody only reads it, nothing listens.
let packageAppPort = 0
let appHost = ''

const files = [
	{
		path: 'package.json',
		content: JSON.stringify({
			name: `@${username}/notes`,
			version: '0.0.0',
			type: 'module',
			exports: { '.': './src/index.ts' },
			kody: {
				description: 'package app origin fixture',
				app: { entry: 'src/app.ts' },
			},
		}),
	},
	{ path: 'README.md', content: '# notes\n\nApp origin fixture.\n' },
	{ path: 'AGENTS.md', content: '# notes\n\nTest fixture only.\n' },
	{
		path: 'src/index.ts',
		content: "export default async function main() {\n\treturn 'ok'\n}\n",
	},
	{
		path: 'src/app.ts',
		content: `import { packageContext } from 'kody:runtime'

export default {
	async fetch(request: Request) {
		const about = new URL('about', packageContext.hostedUrl + packageContext.appBasePath + '/')
		return Response.json(
			{
				url: request.url,
				method: request.method,
				hostedUrl: packageContext.hostedUrl,
				appBasePath: packageContext.appBasePath,
				aboutLink: about.href,
			},
			{
				headers: {
					'set-cookie': packageContext.cookiePrefix + 'pref=dark; Path=/; SameSite=Lax',
				},
			},
		)
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
	stateDir = await mkdtemp(join(tmpdir(), 'kody-dev-runtime-app-origin-'))
	packageAppPort = await freePort()
	appHost = `notes--${username}.localhost:${packageAppPort}`
	const mod = (await import(join(distDir, 'index.js'))) as {
		startDevRuntime: (input: {
			stateDir: string
			username: string
			packageAppPort: number
		}) => Promise<Runtime>
	}
	runtime = await mod.startDevRuntime({ stateDir, username, packageAppPort })
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

function freePort() {
	return new Promise<number>((resolve, reject) => {
		const server = createServer()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo
			server.close(() => resolve(port))
		})
	})
}

/** One request to local Kody with the Host a browser on `host` would send. */
function send(input: {
	host: string
	path: string
	method?: string
	headers?: Record<string, string>
}) {
	assert.ok(runtime)
	const target = new URL(input.path, runtime.origin)
	return new Promise<{
		status: number
		headers: IncomingHttpHeaders
		body: string
	}>((resolve, reject) => {
		const req = request(
			target,
			{
				method: input.method ?? 'GET',
				headers: { host: input.host, ...input.headers },
			},
			(res) => {
				let body = ''
				res.on('data', (chunk) => (body += chunk))
				res.on('end', () =>
					resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
				)
			},
		)
		req.on('error', reject)
		req.end()
	})
}

test(
	'a package app is served at the root of its own {leaf}--{handle}.localhost origin',
	{ skip: !built && !process.env.CI && 'build @kodycodes/dev-runtime first' },
	async () => {
		assert.ok(built, 'CI runs this after building @kodycodes/dev-runtime')
		assert.ok(runtime)

		// Signed out, the app host asks for a handoff instead of serving.
		const signedOut = await send({
			host: appHost,
			path: '/notes/1',
			headers: { accept: 'application/json' },
		})
		assert.equal(signedOut.status, 403)
		assert.equal(signedOut.headers['x-kody-handoff'], 'required')

		// Kody hands the session off to the app's own host.
		const open = await fetch(
			`${runtime.origin}/@${username}/packages/notes/open/notes/1?tab=a&__kody_app_host=1`,
			{ redirect: 'manual', headers: { cookie: runtime.sessionCookie } },
		)
		assert.equal(open.status, 302)
		const handoff = new URL(open.headers.get('location')!)
		assert.equal(handoff.host, appHost)
		assert.equal(handoff.pathname, '/notes/1')
		const consumed = await send({
			host: appHost,
			path: `${handoff.pathname}${handoff.search}`,
		})
		assert.equal(consumed.status, 302)
		assert.equal(consumed.headers.location, `http://${appHost}/notes/1?tab=a`)
		const setCookies = consumed.headers['set-cookie'] ?? []
		// Host-only cookies at the root: no Domain, Path=/.
		for (const cookie of setCookies) {
			assert.doesNotMatch(cookie, /domain=/i)
			assert.match(cookie, /Path=\//)
		}
		const cookie = setCookies
			.map((value) => value.split(';')[0]!)
			.filter((pair) => !pair.endsWith('='))
			.join('; ')
		assert.notEqual(cookie, '')

		// The app sees its own origin, an empty base path, and the full path.
		const page = await send({
			host: appHost,
			path: '/notes/1?tab=a',
			headers: { cookie },
		})
		assert.equal(page.status, 200, page.body)
		assert.deepEqual(JSON.parse(page.body), {
			url: `http://${appHost}/notes/1?tab=a`,
			method: 'GET',
			hostedUrl: `http://${appHost}`,
			appBasePath: '',
			aboutLink: `http://${appHost}/about`,
		})
		// The app's own cookie comes back host-only at the root.
		const appCookie = (page.headers['set-cookie'] ?? []).find((value) =>
			value.includes('pref=dark'),
		)
		assert.match(appCookie ?? '', /pref=dark; Path=\/; SameSite=Lax$/)

		// Same-origin POST is served; a cross-origin one is refused.
		const post = await send({
			host: appHost,
			path: '/save',
			method: 'POST',
			headers: { cookie, origin: `http://${appHost}` },
		})
		assert.equal(post.status, 200, post.body)
		assert.equal((JSON.parse(post.body) as { method: string }).method, 'POST')
		const crossOrigin = await send({
			host: appHost,
			path: '/save',
			method: 'POST',
			headers: {
				cookie,
				origin: `http://${username}.localhost:${packageAppPort}`,
			},
		})
		assert.equal(crossOrigin.status, 403)

		// Another port or a malformed label is not this app.
		for (const host of [
			`notes--${username}.localhost:${packageAppPort + 1}`,
			`notes---${username}.localhost:${packageAppPort}`,
		]) {
			const other = await send({ host, path: '/notes/1', headers: { cookie } })
			assert.notEqual(other.status, 200, host)
		}
	},
)
