import { setTimeout as delay } from 'node:timers/promises'
import { expect, test } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
	createAppSessionCookie,
	createMcpClient,
	createUniqueTestUser,
	getSharedMcpE2eServer,
} from '../../../../tools/mcp-test-support.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'

const kodyId = 'app-realtime-smoke'

type ExecuteStructured = {
	result?: unknown
	error?: unknown
}

function readExecuteResult<T>(toolResult: CallToolResult): T {
	expect(toolResult.isError).toBeFalsy()
	const structured = toolResult.structuredContent as ExecuteStructured
	expect(structured.error).toBeUndefined()
	return structured.result as T
}

function buildPackageFiles(username: string) {
	const packageJson = {
		name: `@${username}/${kodyId}`,
		private: true,
		exports: { '.': './src/index.ts' },
		kody: {
			id: kodyId,
			description: 'MCP e2e smoke package for package-app realtime websockets',
			app: {
				entry: './src/app.ts',
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
				'# App realtime smoke\n\n## Intent\n\nProve a browser websocket to the package app /ws reaches the realtime hook.\n',
		},
		{
			path: 'AGENTS.md',
			content: '# Agents\n\nOpen the package app /ws websocket.\n',
		},
		{
			path: 'src/index.ts',
			content:
				'export default async function main() {\n\treturn { ok: true }\n}\n',
		},
		{
			path: 'src/app.ts',
			content: `export default {
	async fetch() {
		return new Response('realtime smoke', { status: 426 })
	},
}

export async function handleRealtimeEvent(payload) {
	if (payload.event === 'connect') {
		return [{
			type: 'send',
			data: {
				type: 'connected',
				facet: payload.facet,
				upgrade: payload.request?.headers?.upgrade ?? null,
				hasCookie: Boolean(payload.request?.headers?.cookie),
			},
		}]
	}
	if (payload.event === 'message') {
		return [{ type: 'send', data: { type: 'echo', text: payload.message?.text ?? null } }]
	}
	return []
}
`,
		},
	]
}

function openWebSocket(url: string, cookie: string) {
	// Node's WebSocket (undici) accepts request headers as a non-standard init.
	const socket = new WebSocket(url, {
		headers: { Cookie: cookie },
	} as unknown as Array<string>)
	const messages: Array<unknown> = []
	const waiters: Array<() => void> = []
	socket.addEventListener('message', (event) => {
		messages.push(JSON.parse(String(event.data)))
		for (const wake of waiters.splice(0)) wake()
	})
	const opened = new Promise<void>((resolve, reject) => {
		socket.addEventListener('open', () => resolve(), { once: true })
		socket.addEventListener(
			'error',
			() => reject(new Error(`WebSocket to ${url} failed before open`)),
			{ once: true },
		)
	})
	async function nextMessage(timeoutMs = 15_000) {
		const deadline = Date.now() + timeoutMs
		while (messages.length === 0) {
			if (Date.now() > deadline)
				throw new Error('Timed out waiting for message')
			await Promise.race([
				new Promise<void>((resolve) => waiters.push(resolve)),
				delay(250),
			])
		}
		return messages.shift()
	}
	return { socket, opened, nextMessage }
}

test('browser websocket to a package app /ws upgrades and runs the realtime hook', async () => {
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
		const saved = readExecuteResult<{ package_id: string; has_app: boolean }>(
			(await mcp.client.callTool({
				name: 'execute',
				arguments: {
					code: `import { kody } from 'kody:runtime'
export default async function main(input) {
	return await kody.packageSave({ files: input.files })
}
`,
					params: { files: buildPackageFiles(username) },
				},
			})) as CallToolResult,
		)
		expect(saved.has_app).toBe(true)
		packageId = saved.package_id

		const cookie = await createAppSessionCookie(server.origin, user)
		const wsUrl = `${server.origin.replace(/^http/, 'ws')}/@${username}/packages/${kodyId}/ws`
		const ws = openWebSocket(wsUrl, cookie)
		await ws.opened
		expect(await ws.nextMessage()).toEqual({
			type: 'connected',
			facet: 'main',
			upgrade: 'websocket',
			hasCookie: false,
		})
		ws.socket.send('ping')
		expect(await ws.nextMessage()).toEqual({ type: 'echo', text: 'ping' })

		const sessions = readExecuteResult<{ sessions: Array<unknown> }>(
			(await mcp.client.callTool({
				name: 'execute',
				arguments: {
					code: `import { kody } from 'kody:runtime'
export default async function main(input) {
	return await kody.sessionList({ package_id: input.packageId })
}
`,
					params: { packageId },
				},
			})) as CallToolResult,
		)
		expect(sessions.sessions).toHaveLength(1)

		let realtimeRuns: Array<unknown> = []
		for (let attempt = 0; attempt < 20 && realtimeRuns.length < 2; attempt++) {
			const listed = readExecuteResult<{ runs: Array<unknown> }>(
				(await mcp.client.callTool({
					name: 'execute',
					arguments: {
						code: `import { kody } from 'kody:runtime'
export default async function main(input) {
	return await kody.runList({ surface: 'app_realtime', package_id: input.packageId })
}
`,
						params: { packageId },
					},
				})) as CallToolResult,
			)
			realtimeRuns = listed.runs
			if (realtimeRuns.length < 2) await delay(500)
		}
		expect(realtimeRuns.length).toBeGreaterThanOrEqual(2)

		ws.socket.close(1000, 'done')
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
					params: { packageId, confirmName: `@${username}/${kodyId}` },
				},
			})
		}
	}
}, 180_000)
