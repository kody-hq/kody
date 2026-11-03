import { expect, test } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
	createAppSessionCookie,
	createMcpClient,
	createUniqueTestUser,
	getSharedMcpE2eServer,
} from '../../../../tools/mcp-test-support.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'
import { createRemixPackageAppFiles } from '#worker/test-support/remix-package-app-fixture.ts'

const kodyId = 'remix-notes-smoke'

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
	const structured = toolResult.structuredContent as ExecuteStructured
	if (toolResult.isError || structured.error != null) {
		expect.fail(
			`execute failed: ${JSON.stringify(
				{
					isError: toolResult.isError,
					error: structured.error,
					content: toolResult.content,
				},
				null,
				2,
			)}`,
		)
	}
	expect(structured.result).toBeTruthy()
	return structured.result as T
}

test('a Remix package app publishes and serves SSR routes, a form action, middleware, and the hydration module on a real local worker', async () => {
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

	try {
		const files = Object.entries(
			await createRemixPackageAppFiles({ username, kodyId }),
		).map(([path, content]) => ({ path, content }))
		const saved = readExecuteResult<PackageSaveResult>(
			(await mcp.client.callTool({
				name: 'execute',
				arguments: {
					code: `import { kody } from 'kody:runtime'
export default async function main(input) {
	return await kody.packageSave({ files: input.files })
}
`,
					params: { files },
				},
			})) as CallToolResult,
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
				redirect: 'manual',
			})

		// GET / — the Remix recipe renders the home controller: Kody from the
		// request context, the custom middleware's header, and the hydrated
		// island's serialized entry pointing at the platform-built module.
		const home = await authedFetch(appOrigin)
		const homeHtml = await home.text()
		expect({ status: home.status, homeHtml }).toMatchObject({ status: 200 })
		expect(home.headers.get('content-type')).toMatch(/^text\/html/)
		expect(home.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
		expect(homeHtml).toContain(
			`<html lang="en" data-app-base="${appBasePath}">`,
		)
		expect(homeHtml).toContain('<h1 id="title">Remix notes</h1>')
		expect(homeHtml).toContain(`<p id="mount">Mounted at ${appBasePath}</p>`)
		expect(homeHtml).toContain('Notes: 0')
		expect(homeHtml).toContain(`<a href="${appBasePath}/notes">Add a note</a>`)
		expect(homeHtml).toContain(`href="${appBasePath}/_assets/styles.css"`)
		const clientModuleMatch = homeHtml.match(
			/<script type="module" src="([^"]+)"><\/script>/,
		)
		const clientModuleUrl = clientModuleMatch?.[1]
		expect(clientModuleUrl).toMatch(
			new RegExp(
				`^${appOrigin.replaceAll('.', '\\.')}/_assets/client\\.[A-Za-z0-9_-]{16}\\.js$`,
			),
		)
		expect(homeHtml).toContain('<!-- rmx:h:')
		expect(homeHtml).toContain('"moduleUrl":"kody:app"')
		expect(homeHtml).toContain('"exportName":"Counter"')

		// The mount root with a trailing slash is the same page.
		const homeSlash = await authedFetch(`${appOrigin}/`)
		expect(homeSlash.status).toBe(200)
		expect(await homeSlash.text()).toContain('<h1 id="title">Remix notes</h1>')

		// POST action: formData middleware + data-schema validation +
		// packageStorage() through the real runtime bridge, then a 303 whose
		// Location stays inside the mount.
		const created = await authedFetch(`${appOrigin}/notes`, {
			method: 'POST',
			body: new URLSearchParams({ text: 'Ship Remix mini-apps' }),
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
		})
		expect({
			status: created.status,
			body: created.status === 303 ? null : await created.text(),
		}).toEqual({ status: 303, body: null })
		expect(created.headers.get('location')).toBe(`${appBasePath}/notes`)

		const invalid = await authedFetch(`${appOrigin}/notes`, {
			method: 'POST',
			body: new URLSearchParams({ text: '   ' }),
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
		})
		expect(invalid.status).toBe(400)
		expect(await invalid.text()).toContain(
			'<p id="error">A note needs some text.</p>',
		)

		const notes = await authedFetch(`${appOrigin}/notes`)
		const notesHtml = await notes.text()
		expect({ status: notes.status, notesHtml }).toMatchObject({ status: 200 })
		expect(notesHtml).toContain('<li>Ship Remix mini-apps</li>')
		expect(notesHtml).toContain(
			`<form method="post" action="${appBasePath}/notes">`,
		)
		const homeAfter = await authedFetch(appOrigin)
		expect(await homeAfter.text()).toContain('Notes: 1')

		// Router-owned behaviour under the mount: verb routes, 404, 405.
		const health = await authedFetch(`${appOrigin}/healthz`)
		expect(await health.json()).toEqual({ ok: true })
		expect((await authedFetch(`${appOrigin}/nope`)).status).toBe(404)
		expect(
			(await authedFetch(`${appOrigin}/healthz`, { method: 'POST' })).status,
		).toBe(405)

		// The browser module: run() plus the island, compiled from the same
		// package-supplied remix as the server, served fingerprinted and immutable.
		const clientModule = await authedFetch(clientModuleUrl as string)
		const clientSource = await clientModule.text()
		expect({ status: clientModule.status }).toEqual({ status: 200 })
		expect(clientModule.headers.get('content-type')).toBe(
			'text/javascript; charset=utf-8',
		)
		expect(clientModule.headers.get('cache-control')).toBe(
			'private, max-age=31536000, immutable',
		)
		expect(clientSource).toContain('Unknown client entry')
		expect(clientSource).toContain('data-rmx-')
		expect(clientSource).not.toMatch(/from\s+["']remix\//)
		expect(clientSource).not.toContain('kody:runtime')

		const css = await authedFetch(`${appOrigin}/_assets/styles.css`)
		expect(css.status).toBe(200)
		expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
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
