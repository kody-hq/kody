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

function cliHostRuntime(
	headlessLoginReason: 'ssh' | 'no_display' | null,
	commands: Array<string>,
) {
	return {
		headlessLoginReason,
		which: (command: string) => `/usr/bin/${command}`,
		runCommand: async (command: string, args: Array<string>) => {
			commands.push(`${command} ${args.join(' ')}`)
			return true
		},
		upsertServer: (): { success: boolean; path: string; error?: string } => ({
			success: true,
			path: '/home/me/.codex/config.toml',
		}),
	}
}

async function installOne(
	clients: string,
	runtime: ReturnType<typeof cliHostRuntime>,
) {
	let output = ''
	const result = await runInstall(
		{ mcpUrl, clients },
		{
			stdout: (text) => {
				output += text
			},
			home: '/home/me',
			cwd: '/proj',
			isTTY: false,
			listProcesses: async () => [],
			runtime,
		},
	)
	return { result, output }
}

test('Codex over SSH prints the --no-browser paste-back steps instead of starting OAuth', async () => {
	const commands: Array<string> = []
	const { result, output } = await installOne(
		'codex',
		cliHostRuntime('ssh', commands),
	)
	assert.equal(result.results[0]?.status, 'wrote')
	assert.deepEqual(commands, [])
	assert.match(output, /This looks like an SSH session/)
	assert.match(output, /Run: codex mcp login kody --no-browser/)
	assert.match(
		output,
		/Copy the whole URL from the address bar \(it starts with http:\/\/127\.0\.0\.1\) and paste it into this terminal/,
	)
	assert.doesNotMatch(output, /If OAuth does not start/)
})

test('OpenCode over SSH prints the callback port forward', async () => {
	const commands: Array<string> = []
	const { result, output } = await installOne(
		'opencode',
		cliHostRuntime('ssh', commands),
	)
	assert.equal(result.results[0]?.status, 'wrote')
	assert.deepEqual(commands, [])
	assert.match(output, /This looks like an SSH session/)
	assert.match(output, /ssh -L 127\.0\.0\.1:19876:127\.0\.0\.1:19876 user@host/)
	assert.match(output, /run: opencode mcp auth kody/)
	assert.match(output, /oauth\.callbackPort \(or callback_port\)/)
})

test('OpenCode without a display prints the curl callback steps, not a tunnel', async () => {
	const commands: Array<string> = []
	const { result, output } = await installOne(
		'opencode',
		cliHostRuntime('no_display', commands),
	)
	assert.equal(result.results[0]?.status, 'wrote')
	assert.deepEqual(commands, [])
	assert.match(output, /No display was found on this machine/)
	assert.match(output, /Run: opencode mcp auth kody and leave it waiting/)
	assert.match(
		output,
		/it starts with http:\/\/127\.0\.0\.1:19876\/mcp\/oauth\/callback/,
	)
	assert.match(output, /run: curl '<that URL>'/)
	assert.doesNotMatch(output, /ssh -L/)
})

test('a failed config write keeps its error instead of headless OAuth steps', async () => {
	const commands: Array<string> = []
	const { result, output } = await installOne('codex', {
		...cliHostRuntime('ssh', commands),
		upsertServer: () => ({
			success: false,
			path: '',
			error: 'config.toml is not writable',
		}),
	})
	assert.equal(result.results[0]?.status, 'manual')
	assert.match(output, /config\.toml is not writable/)
	assert.doesNotMatch(output, /--no-browser/)
})

test('Codex with a local browser still starts OAuth and keeps the short hint', async () => {
	const commands: Array<string> = []
	const { result, output } = await installOne(
		'codex',
		cliHostRuntime(null, commands),
	)
	assert.equal(result.results[0]?.status, 'wrote')
	assert.deepEqual(commands, ['/usr/bin/codex mcp login kody'])
	assert.match(output, /If OAuth does not start, run: codex mcp login kody/)
	assert.doesNotMatch(output, /--no-browser/)
})
