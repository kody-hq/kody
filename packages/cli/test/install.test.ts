import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInstall } from '../src/install.js'

const mcpUrl = 'https://kody.codes/mcp'

test('runInstall writes Cursor config for an explicit client', async () => {
	const upserts: Array<{
		agent: string
		name: string
		url?: string
		local?: boolean
	}> = []
	const opened: Array<string> = []
	let output = ''
	const result = await runInstall(
		{ mcpUrl, clients: 'cursor' },
		{
			stdout: (text) => {
				output += text
			},
			home: '/home/me',
			cwd: '/proj',
			isTTY: false,
			listProcesses: async () => [],
			runtime: {
				openUrl: async (url) => {
					opened.push(url)
					return true
				},
				upsertServer: (agent, name, config, options) => {
					upserts.push({ agent, name, url: config.url, local: options?.local })
					return { success: true, path: '/home/me/.cursor/mcp.json' }
				},
			},
		},
	)
	assert.equal(result.code, 0)
	assert.equal(result.results[0]?.status, 'wrote')
	assert.deepEqual(upserts, [
		{ agent: 'cursor', name: 'kody', url: mcpUrl, local: false },
	])
	assert.equal(opened.length, 1)
	assert.match(opened[0] ?? '', /^cursor:\/\//)
})

test('runInstall does not list web clients when nothing local is running', async () => {
	let output = ''
	const result = await runInstall(
		{ mcpUrl },
		{
			stdout: (text) => {
				output += text
			},
			isTTY: false,
			listProcesses: async () => [{ name: 'Safari' }, { name: 'chrome' }],
		},
	)
	assert.equal(result.code, 1)
	assert.equal(result.results.length, 0)
	assert.doesNotMatch(output, /chatgpt/)
})

test('runInstall writes Kilo Code config through add-mcp', async () => {
	const upserts: Array<{ agent: string; local?: boolean }> = []
	const result = await runInstall(
		{ mcpUrl, clients: 'kilo-code' },
		{
			stdout: () => undefined,
			home: '/home/me',
			cwd: '/proj',
			isTTY: false,
			listProcesses: async () => [],
			runtime: {
				upsertServer: (agent, _name, _config, options) => {
					upserts.push({ agent, local: options?.local })
					return { success: true, path: '/home/me/.config/kilo/kilo.json' }
				},
			},
		},
	)
	assert.equal(result.results[0]?.status, 'wrote')
	assert.deepEqual(upserts, [{ agent: 'kilo-code', local: false }])
})

test('runInstall writes leftover VS Code Insiders config without add-mcp', async () => {
	const files = new Map<string, string>()
	const upserts: Array<string> = []
	const result = await runInstall(
		{ mcpUrl, clients: 'vscode-insiders' },
		{
			stdout: () => undefined,
			home: '/home/me',
			cwd: '/proj',
			isTTY: false,
			listProcesses: async () => [],
			runtime: {
				platform: 'linux',
				openUrl: async () => true,
				upsertServer: (agent) => {
					upserts.push(agent)
					return { success: true, path: '/unused' }
				},
				readFile: async (path) => files.get(path) ?? null,
				writeFile: async (path, body) => {
					files.set(path, body)
				},
				mkdir: async () => undefined,
			},
		},
	)
	assert.equal(result.results[0]?.status, 'wrote')
	assert.deepEqual(upserts, [])
	assert.deepEqual(
		JSON.parse(
			files.get('/home/me/.config/Code - Insiders/User/mcp.json') ?? '{}',
		),
		{ servers: { kody: { type: 'http', url: mcpUrl } } },
	)
})

test('Claude Desktop stays instruction-only', async () => {
	const files = new Map<string, string>()
	const apps: Array<string> = []
	const result = await runInstall(
		{ mcpUrl, clients: 'claude-desktop' },
		{
			stdout: () => undefined,
			home: '/home/me',
			isTTY: false,
			listProcesses: async () => [],
			runtime: {
				openApp: async (name) => {
					apps.push(name)
					return true
				},
				writeFile: async (path, body) => {
					files.set(path, body)
				},
				mkdir: async () => undefined,
			},
		},
	)
	assert.equal(result.results[0]?.status, 'manual')
	assert.equal(apps[0], 'Claude')
	assert.equal(files.size, 0)
	assert.match(
		result.results[0]?.instructions.join('\n') ?? '',
		/claude_desktop_config\.json/,
	)
})
