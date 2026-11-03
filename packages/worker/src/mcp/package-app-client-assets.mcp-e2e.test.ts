import { expect, test } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
	createAppSessionCookie,
	createMcpClient,
	createUniqueTestUser,
	getSharedMcpE2eServer,
} from '../../../../tools/mcp-test-support.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'

const kodyId = 'client-assets-smoke'

type ExecuteStructured = {
	result?: unknown
	error?: unknown
}

type PackageSaveResult = {
	package_id: string
	kody_id: string
	has_app: boolean
}

function readExecuteResult<T>(toolResult: CallToolResult): T {
	expect(toolResult.isError).toBeFalsy()
	const structured = toolResult.structuredContent as ExecuteStructured
	expect(structured.error).toBeUndefined()
	expect(structured.result).toBeTruthy()
	return structured.result as T
}

function buildPackageFiles(input: { username: string; clientSource: string }) {
	const packageJson = {
		name: `@${input.username}/${kodyId}`,
		private: true,
		exports: { '.': './src/index.ts' },
		kody: {
			id: kodyId,
			description:
				'MCP e2e smoke package for kody.app.client and kody.app.assets',
			app: {
				entry: './src/app.ts',
				client: { entry: './src/client.ts', externals: ['lit'] },
				assets: './public',
			},
		},
	}
	return [
		{
			path: 'package.json',
			content: `${JSON.stringify(packageJson, null, '\t')}\n`,
		},
		{
			path: 'README.md',
			content:
				'# Client assets smoke\n\n## Intent\n\nProve the platform-built browser client and static assets serve end-to-end.\n',
		},
		{
			path: 'AGENTS.md',
			content:
				'# Agents\n\nOpen the hosted app and confirm the client module loads.\n',
		},
		{
			path: 'src/index.ts',
			content:
				'export default async function main() {\n\treturn { ok: true }\n}\n',
		},
		{
			path: 'src/app.ts',
			content: `import { packageContext } from 'kody:runtime'

export default {
	async fetch(request: Request) {
		const url = new URL(request.url)
		if (url.pathname === '/context.json') {
			return Response.json({ packageContext, seenPath: url.pathname })
		}
		const context = packageContext ?? {}
		const importMap = JSON.stringify({
			imports: { 'lit': \`\${context.assetBasePath}/vendor/ui.js\` },
		})
		const pakConfig = JSON.stringify({ theme: 'dark' })
		return new Response(
			\`<!doctype html><html lang="en" data-app-base="\${context.appBasePath}" data-client-module="\${context.clientModuleUrl}" data-pak-config='\${pakConfig}'><head><meta charset="utf-8" /><title>Client smoke</title>
<link rel="stylesheet" href="\${context.assetBasePath}/styles.css" />
<script type="importmap">\${importMap}</script></head>
<body><h1 id="title">Client smoke</h1><button id="inc" type="button">Clicked 0 times</button>
<script type="module" src="\${context.clientModuleUrl}"></script></body></html>\`,
			{ headers: { 'content-type': 'text/html; charset=utf-8' } },
		)
	},
}
`,
		},
		{ path: 'src/client.ts', content: input.clientSource },
		{
			path: 'src/format.ts',
			content:
				'export function formatCount(count: number): string {\n\treturn `Clicked ${count} time${count === 1 ? "" : "s"}`\n}\n',
		},
		{
			path: 'public/styles.css',
			content: 'body { font-family: system-ui, sans-serif; }\n',
		},
		{
			path: 'public/client.production.js',
			content: 'console.log("static lookalike, not the bundle")\n',
		},
		{
			path: 'public/vendor/ui.js',
			content:
				'export function html(label) {\n\treturn `<button>${label}</button>`\n}\n',
		},
		{
			path: 'public/sw.js',
			content: "self.addEventListener('install', () => self.skipWaiting())\n",
		},
	]
}

const browserClientSource = `import { html } from 'lit'
import { formatCount } from './format.ts'

type State = { count: number }
const state: State = { count: 0 }
const button = document.querySelector<HTMLButtonElement>('#inc')!
button.addEventListener('click', () => {
	state.count += 1
	button.textContent = formatCount(state.count)
})
document.querySelector<HTMLHeadingElement>('#title')!.dataset.hydrated = 'true'
export const ready = html('ready')
`

test('kody.app.client and kody.app.assets publish and serve end-to-end on a real local worker', async () => {
	silenceExpectedConsoleWarns([
		/Ignoring duplicate module:.*generated\/esbuild\.wasm/,
	])
	const server = await getSharedMcpE2eServer()
	const user = createUniqueTestUser()
	await using mcp = await createMcpClient(server.origin, user, {
		ensureUser: server.ensureUser,
		markEmailVerified: server.markEmailVerified,
		clearAuthRateLimits: server.clearAuthRateLimits,
	})
	const { username } = user
	let packageId: string | undefined

	const save = async (input: { clientSource: string }) =>
		(await mcp.client.callTool({
			name: 'execute',
			arguments: {
				code: `import { kody } from 'kody:runtime'
export default async function main(input) {
	return await kody.packageSave({ files: input.files })
}
`,
				params: {
					files: buildPackageFiles({ username, ...input }),
				},
			},
		})) as CallToolResult

	try {
		const saved = readExecuteResult<PackageSaveResult>(
			await save({ clientSource: browserClientSource }),
		)
		expect(saved.kody_id).toBe(kodyId)
		expect(saved.has_app).toBe(true)
		packageId = saved.package_id

		const cookie = await createAppSessionCookie(server.origin, user)
		const appBasePath = `/@${username}/packages/${kodyId}`
		const appOrigin = `${server.origin}${appBasePath}`
		const authedFetch = (url: string, init?: RequestInit) =>
			fetch(url, {
				...init,
				headers: { Cookie: cookie, ...init?.headers },
				redirect: 'follow',
			})

		const contextResponse = await authedFetch(`${appOrigin}/context.json`)
		const contextBodyText = await contextResponse.text()
		expect({ status: contextResponse.status, contextBodyText }).toMatchObject({
			status: 200,
		})
		const context = JSON.parse(contextBodyText) as {
			packageContext: {
				appBasePath: string
				hostedUrl: string
				assetBasePath: string
				clientModuleUrl: string | null
			}
			seenPath: string
		}
		expect(context.seenPath).toBe('/context.json')
		expect(context.packageContext.assetBasePath).toBe(`${appBasePath}/_assets`)
		expect(context.packageContext.clientModuleUrl).toMatch(
			new RegExp(
				`^${appOrigin.replaceAll('.', '\\.')}/_assets/client\\.[A-Za-z0-9_-]{16}\\.js$`,
			),
		)
		const clientModuleUrl = context.packageContext.clientModuleUrl as string

		const page = await authedFetch(`${appOrigin}/`)
		const pageHtml = await page.text()
		expect({ status: page.status, pageHtml }).toMatchObject({ status: 200 })
		expect(pageHtml).toContain(
			`<script type="module" src="${clientModuleUrl}">`,
		)
		expect(pageHtml).toContain(`href="${appBasePath}/_assets/styles.css"`)
		// Kit conventions: runtime config and the module URL ride on <html>
		// data attributes rendered from packageContext.
		expect(pageHtml).toContain(`data-app-base="${appBasePath}"`)
		expect(pageHtml).toContain(`data-client-module="${clientModuleUrl}"`)
		expect(pageHtml).toContain(`data-pak-config='{"theme":"dark"}'`)

		// Platform-served version JSON: how a service worker discovers the
		// fingerprinted URL without a hash in its source.
		const version = await authedFetch(`${appOrigin}/_assets/__version.json`)
		expect(version.status).toBe(200)
		expect(version.headers.get('cache-control')).toBe('private, no-cache')
		expect(await version.json()).toMatchObject({
			clientModuleUrl,
			assetBasePath: `${appBasePath}/_assets`,
		})

		const clientModule = await authedFetch(clientModuleUrl)
		const clientSource = await clientModule.text()
		expect({ status: clientModule.status, clientSource }).toMatchObject({
			status: 200,
		})
		expect(clientModule.headers.get('content-type')).toBe(
			'text/javascript; charset=utf-8',
		)
		expect(clientModule.headers.get('cache-control')).toBe(
			'private, max-age=31536000, immutable',
		)
		expect(clientModule.headers.get('x-content-type-options')).toBe('nosniff')
		const etag = clientModule.headers.get('etag')
		expect(etag).toMatch(/^"client\.[A-Za-z0-9_-]{16}\.js"$/)
		// Real esbuild output: TypeScript stripped, relative graph inlined,
		// nothing left for the browser to resolve, exports preserved.
		expect(clientSource).toContain('Clicked ${count} time')
		expect(clientSource).not.toContain('type State')
		// The declared external stays a bare import for the page's import map;
		// the relative graph is inlined so nothing else is left to resolve.
		expect(clientSource).toMatch(/from\s+"lit"/)
		expect(clientSource).not.toMatch(/from\s+["']\.\//)
		expect(clientSource).toMatch(/export\s*\{/)
		expect(pageHtml).toContain(
			`<script type="importmap">{"imports":{"lit":"${appBasePath}/_assets/vendor/ui.js"}}</script>`,
		)
		const vendorModule = await authedFetch(`${appOrigin}/_assets/vendor/ui.js`)
		expect(vendorModule.status).toBe(200)
		expect(vendorModule.headers.get('content-type')).toBe(
			'text/javascript; charset=utf-8',
		)

		// A service worker script from the assets directory may claim the
		// app mount as its scope, so it can precache clientModuleUrl.
		const serviceWorker = await authedFetch(`${appOrigin}/_assets/sw.js`)
		expect(serviceWorker.status).toBe(200)
		expect(serviceWorker.headers.get('service-worker-allowed')).toBe(
			`${appBasePath}/`,
		)

		const revalidated = await authedFetch(clientModuleUrl, {
			headers: { 'If-None-Match': etag ?? '' },
		})
		expect(revalidated.status).toBe(304)

		const css = await authedFetch(`${appOrigin}/_assets/styles.css`)
		expect(await css.text()).toBe(
			'body { font-family: system-ui, sans-serif; }\n',
		)
		expect(css.status).toBe(200)
		expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
		expect(css.headers.get('cache-control')).toBe('private, max-age=300')
		expect(css.headers.get('etag')).toMatch(/^"[^"]+:public\/styles\.css"$/)

		const lookalike = await authedFetch(
			`${appOrigin}/_assets/client.production.js`,
		)
		expect(lookalike.status).toBe(200)
		expect(await lookalike.text()).toBe(
			'console.log("static lookalike, not the bundle")\n',
		)

		const stale = await authedFetch(
			`${appOrigin}/_assets/client.0000000000000000.js`,
		)
		expect(stale.status).toBe(404)
		const missing = await authedFetch(`${appOrigin}/_assets/nope.txt`)
		expect(missing.status).toBe(404)
		// Encoded traversal never reaches the manifest: the URL layer collapses
		// the segment before routing (author page) or the resolver rejects it
		// (unit-tested); either way no source file leaks.
		const traversal = await authedFetch(
			`${appOrigin}/_assets/%2e%2e/package.json`,
		)
		expect(await traversal.text()).not.toContain('"kody"')
		// Author code never sees the reserved prefix, but sibling paths do
		// reach it.
		const authorPath = await authedFetch(`${appOrigin}/assets-not-reserved`)
		expect(authorPath.status).toBe(200)
		expect(await authorPath.text()).toContain(
			'<h1 id="title">Client smoke</h1>',
		)

		// Publish-check rejection of a client that imports kody:runtime is
		// covered by checks-app-client.node.test.ts: the local-dev mock lane
		// writes a first publish without running repo checks.
	} finally {
		if (packageId) {
			await mcp.client.callTool({
				name: 'execute',
				arguments: {
					code: `import { kody } from 'kody:runtime'
export default async function main(input) {
	return await kody.packageDelete({
		package_id: input.packageId,
		confirm_name: input.confirmName,
	})
}
`,
					params: {
						packageId,
						confirmName: `@${username}/${kodyId}`,
					},
				},
			})
		}
	}
})
