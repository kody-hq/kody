import { join } from 'node:path'
import {
	haystackMatches,
	nameEquals,
	type ProcessInfo,
} from './process-info.js'

export const hostIds = [
	'amazon-q',
	'antigravity',
	'claude-code',
	'claude-desktop',
	'cline',
	'cline-cli',
	'codex',
	'copilot-cli',
	'cursor',
	'fx',
	'gemini-cli',
	'goose',
	'grok-build',
	'jetbrains',
	'kilo-code',
	'kimi-code',
	'kiro-cli',
	'mastracode',
	'mcporter',
	'opencode',
	'pi',
	'qwen-code',
	'visual-studio',
	'vscode',
	'vscode-insiders',
	'windsurf',
	'zed',
] as const

export type HostId = (typeof hostIds)[number]

type HostKind = 'file' | 'command' | 'manual'

export type HostDefinition = {
	id: HostId
	label: string
	kind: HostKind
	matches: (process: ProcessInfo) => boolean
}

const hostAliases: Record<string, HostId> = {
	'cline-vscode': 'cline',
	codeium: 'windsurf',
	cascade: 'windsurf',
	gemini: 'gemini-cli',
	'github-copilot-cli': 'copilot-cli',
	kilo: 'kilo-code',
	kilocode: 'kilo-code',
	kimi: 'kimi-code',
	kiro: 'kiro-cli',
	mastra: 'mastracode',
	'pi-agent': 'pi',
}

function isClaudeDesktop(process: ProcessInfo): boolean {
	if (haystackMatches(process, /Claude\.app|claude-desktop|Claude Helper/iu)) {
		return true
	}
	const raw = process.name.replace(/\.exe$/iu, '').trim()
	return raw === 'Claude' || raw.startsWith('Claude ')
}

function isHostId(value: string): value is HostId {
	return (hostIds as ReadonlyArray<string>).includes(value)
}

export function parseHostIds(raw: string): Array<HostId> {
	const ids = raw
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean)
	if (ids.length === 0) {
		throw new Error(
			`Provide at least one client id. Known: ${hostIds.join(', ')}`,
		)
	}
	const known: Array<HostId> = []
	for (const id of ids) {
		if (id === 'grok' || id === 'chatgpt' || id === 'claude.ai') {
			throw new Error(
				`"${id}" is a web client. For the local Grok Build CLI use grok-build. For web-based clients see https://kody.codes/onboarding`,
			)
		}
		const resolved = hostAliases[id] ?? id
		if (!isHostId(resolved)) {
			throw new Error(`Unknown client "${id}". Known: ${hostIds.join(', ')}`)
		}
		known.push(resolved)
	}
	return known
}

const jetbrainsNames = [
	'clion',
	'datagrip',
	'goland',
	'idea',
	'idea64',
	'intellij',
	'phpstorm',
	'pycharm',
	'pycharm64',
	'rider',
	'rubymine',
	'rustrover',
	'webstorm',
	'webstorm64',
]

export const hostCatalog: ReadonlyArray<HostDefinition> = [
	{
		id: 'cursor',
		label: 'Cursor',
		kind: 'file',
		matches: (process) =>
			nameEquals(process, 'cursor') ||
			haystackMatches(process, /Cursor\.app/iu),
	},
	{
		id: 'vscode-insiders',
		label: 'VS Code Insiders',
		kind: 'file',
		matches: (process) =>
			/insiders/iu.test(process.name) &&
			(/code/iu.test(process.name) || haystackMatches(process, /code/iu)),
	},
	{
		id: 'vscode',
		label: 'VS Code',
		kind: 'file',
		matches: (process) => {
			if (haystackMatches(process, /insiders|cursor|windsurf|antigravity/iu))
				return false
			const base = process.name
				.replace(/\.exe$/iu, '')
				.trim()
				.toLowerCase()
			return (
				base === 'code' ||
				base === 'code - oss' ||
				base.startsWith('code helper') ||
				haystackMatches(process, /Visual Studio Code\.app/iu)
			)
		},
	},
	{
		id: 'claude-desktop',
		label: 'Claude Desktop',
		kind: 'manual',
		matches: isClaudeDesktop,
	},
	{
		id: 'claude-code',
		label: 'Claude Code',
		kind: 'command',
		matches: (process) =>
			nameEquals(process, 'claude') && !isClaudeDesktop(process),
	},
	{
		id: 'codex',
		label: 'Codex',
		kind: 'file',
		matches: (process) =>
			nameEquals(process, 'codex') || haystackMatches(process, /Codex\.app/iu),
	},
	{
		id: 'opencode',
		label: 'OpenCode',
		kind: 'file',
		matches: (process) => nameEquals(process, 'opencode'),
	},
	{
		id: 'goose',
		label: 'Goose',
		kind: 'file',
		matches: (process) =>
			nameEquals(process, 'goose', 'goosed') ||
			haystackMatches(process, /Goose\.app/iu),
	},
	{
		id: 'windsurf',
		label: 'Windsurf',
		kind: 'file',
		matches: (process) =>
			nameEquals(process, 'windsurf') ||
			haystackMatches(process, /Windsurf\.app/iu),
	},
	{
		id: 'zed',
		label: 'Zed',
		kind: 'file',
		matches: (process) =>
			nameEquals(process, 'zed') || haystackMatches(process, /Zed\.app/iu),
	},
	{
		id: 'copilot-cli',
		label: 'Copilot CLI',
		kind: 'command',
		matches: (process) => nameEquals(process, 'copilot'),
	},
	{
		id: 'gemini-cli',
		label: 'Gemini CLI',
		kind: 'command',
		matches: (process) => nameEquals(process, 'gemini'),
	},
	{
		id: 'qwen-code',
		label: 'Qwen Code',
		kind: 'file',
		matches: (process) => nameEquals(process, 'qwen'),
	},
	{
		id: 'amazon-q',
		label: 'Amazon Q',
		kind: 'file',
		matches: (process) =>
			haystackMatches(process, /amazon.?q/iu) ||
			(nameEquals(process, 'q') && haystackMatches(process, /amazon/iu)),
	},
	{
		id: 'antigravity',
		label: 'Antigravity',
		kind: 'file',
		matches: (process) =>
			nameEquals(process, 'antigravity') ||
			haystackMatches(process, /Antigravity\.app/iu),
	},
	{
		id: 'cline',
		label: 'Cline',
		kind: 'file',
		matches: (process) =>
			nameEquals(process, 'cline-vscode') ||
			haystackMatches(process, /cline-vscode/iu),
	},
	{
		id: 'cline-cli',
		label: 'Cline CLI',
		kind: 'command',
		matches: (process) => nameEquals(process, 'cline'),
	},
	{
		id: 'grok-build',
		label: 'Grok Build',
		kind: 'file',
		matches: (process) => nameEquals(process, 'grok'),
	},
	{
		id: 'mcporter',
		label: 'MCPorter',
		kind: 'file',
		matches: (process) => nameEquals(process, 'mcporter'),
	},
	{
		id: 'kilo-code',
		label: 'Kilo Code',
		kind: 'file',
		matches: (process) =>
			nameEquals(process, 'kilo') ||
			haystackMatches(process, /Kilo\.app|kilocode\.kilo-code|kilo-code/iu),
	},
	{
		id: 'kimi-code',
		label: 'Kimi Code',
		kind: 'command',
		matches: (process) => nameEquals(process, 'kimi'),
	},
	{
		id: 'kiro-cli',
		label: 'Kiro CLI',
		kind: 'file',
		matches: (process) =>
			nameEquals(process, 'kiro') || haystackMatches(process, /Kiro\.app/iu),
	},
	{
		id: 'mastracode',
		label: 'Mastra Code',
		kind: 'file',
		matches: (process) => nameEquals(process, 'mastra', 'mastracode'),
	},
	{
		id: 'fx',
		label: 'fx',
		kind: 'file',
		matches: (process) => nameEquals(process, 'fx'),
	},
	{
		id: 'pi',
		label: 'Pi',
		kind: 'file',
		matches: (process) => nameEquals(process, 'pi'),
	},
	{
		id: 'visual-studio',
		label: 'Visual Studio',
		kind: 'file',
		matches: (process) => nameEquals(process, 'devenv'),
	},
	{
		id: 'jetbrains',
		label: 'JetBrains IDE',
		kind: 'manual',
		matches: (process) =>
			nameEquals(process, ...jetbrainsNames) ||
			haystackMatches(
				process,
				/IntelliJ IDEA|PyCharm|WebStorm|GoLand|RustRover|PhpStorm|CLion|Rider|RubyMine|DataGrip/u,
			),
	},
]

export function hostById(id: HostId): HostDefinition {
	const host = hostCatalog.find((candidate) => candidate.id === id)
	if (!host) throw new Error(`Unknown host: ${id}`)
	return host
}

function configHome(
	home: string,
	platform: NodeJS.Platform = process.platform,
): string {
	return platform === 'win32'
		? join(home, 'AppData', 'Roaming')
		: join(home, '.config')
}

function applicationSupport(
	home: string,
	app: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform === 'darwin')
		return join(home, 'Library', 'Application Support', app)
	if (platform === 'win32') return join(home, 'AppData', 'Roaming', app)
	return join(home, '.config', app)
}

export function hostConfigPath(input: {
	id: HostId
	home: string
	cwd: string
	project: boolean
	platform?: NodeJS.Platform
}): string | null {
	const platform = input.platform ?? process.platform
	if (input.project) {
		switch (input.id) {
			case 'cursor':
				return join(input.cwd, '.cursor', 'mcp.json')
			case 'vscode':
			case 'vscode-insiders':
			case 'copilot-cli':
				return join(input.cwd, '.vscode', 'mcp.json')
			case 'claude-code':
				return join(input.cwd, '.mcp.json')
			case 'opencode':
				return join(input.cwd, 'opencode.json')
			case 'codex':
				return join(input.cwd, '.codex', 'config.toml')
			case 'gemini-cli':
				return join(input.cwd, '.gemini', 'settings.json')
			case 'qwen-code':
				return join(input.cwd, '.qwen', 'settings.json')
			case 'amazon-q':
				return join(input.cwd, '.amazonq', 'mcp.json')
			case 'zed':
				return join(input.cwd, '.zed', 'settings.json')
			case 'grok-build':
				return join(input.cwd, '.grok', 'config.toml')
			case 'mcporter':
				return join(input.cwd, 'config', 'mcporter.json')
			case 'kilo-code':
				return join(input.cwd, 'kilo.json')
			case 'kimi-code':
				return join(input.cwd, '.kimi-code', 'mcp.json')
			case 'kiro-cli':
				return join(input.cwd, '.kiro', 'settings', 'mcp.json')
			case 'mastracode':
				return join(input.cwd, '.mastracode', 'mcp.json')
			case 'pi':
				return join(input.cwd, '.pi', 'mcp.json')
			case 'antigravity':
			case 'claude-desktop':
			case 'cline':
			case 'cline-cli':
			case 'fx':
			case 'goose':
			case 'windsurf':
			case 'visual-studio':
			case 'jetbrains':
				return null
			default: {
				const exhaustive: never = input.id
				return exhaustive
			}
		}
	}
	switch (input.id) {
		case 'cursor':
			return join(input.home, '.cursor', 'mcp.json')
		case 'vscode':
			return join(
				applicationSupport(input.home, 'Code', platform),
				'User',
				'mcp.json',
			)
		case 'vscode-insiders':
			return join(
				applicationSupport(input.home, 'Code - Insiders', platform),
				'User',
				'mcp.json',
			)
		case 'claude-code':
			return join(input.home, '.claude.json')
		case 'codex':
			return join(input.home, '.codex', 'config.toml')
		case 'opencode':
			return join(configHome(input.home, platform), 'opencode', 'opencode.json')
		case 'goose':
			return join(configHome(input.home, platform), 'goose', 'config.yaml')
		case 'windsurf':
			return join(input.home, '.codeium', 'windsurf', 'mcp_config.json')
		case 'zed':
			return join(configHome(input.home, platform), 'zed', 'settings.json')
		case 'copilot-cli':
			return join(input.home, '.copilot', 'mcp-config.json')
		case 'gemini-cli':
			return join(input.home, '.gemini', 'settings.json')
		case 'qwen-code':
			return join(input.home, '.qwen', 'settings.json')
		case 'amazon-q':
			return join(input.home, '.aws', 'amazonq', 'mcp.json')
		case 'antigravity':
			return join(input.home, '.gemini', 'config', 'mcp_config.json')
		case 'cline':
			return join(
				applicationSupport(input.home, 'Code', platform),
				'User',
				'globalStorage',
				'saoudrizwan.claude-dev',
				'settings',
				'cline_mcp_settings.json',
			)
		case 'cline-cli':
			return join(
				input.home,
				'.cline',
				'data',
				'settings',
				'cline_mcp_settings.json',
			)
		case 'grok-build':
			return join(input.home, '.grok', 'config.toml')
		case 'mcporter':
			return join(input.home, '.mcporter', 'mcporter.json')
		case 'kilo-code':
			return join(configHome(input.home, platform), 'kilo', 'kilo.json')
		case 'kimi-code':
			return join(input.home, '.kimi-code', 'mcp.json')
		case 'kiro-cli':
			return join(input.home, '.kiro', 'settings', 'mcp.json')
		case 'mastracode':
			return join(input.home, '.mastracode', 'mcp.json')
		case 'fx':
			return join(input.home, '.fx', 'mcp.json')
		case 'pi':
			return join(input.home, '.pi', 'agent', 'mcp.json')
		case 'visual-studio':
			return join(input.home, '.mcp.json')
		case 'claude-desktop':
		case 'jetbrains':
			return null
		default: {
			const exhaustive: never = input.id
			return exhaustive
		}
	}
}

function encodeBase64Url(value: string): string {
	return Buffer.from(value)
		.toString('base64')
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/u, '')
}

export function buildCursorInstallUrl(mcpServerUrl: string): string {
	const config = encodeBase64Url(JSON.stringify({ url: mcpServerUrl }))
	return `cursor://anysphere.cursor-deeplink/mcp/install?name=kody&config=${config}`
}

export function buildVsCodeInstallUrl(
	mcpServerUrl: string,
	scheme: 'vscode' | 'vscode-insiders' = 'vscode',
): string {
	const config = encodeURIComponent(
		JSON.stringify({
			name: 'kody',
			type: 'http',
			url: mcpServerUrl,
		}),
	)
	return `${scheme}:mcp/install?${config}`
}

export function buildGooseInstallUrl(mcpServerUrl: string): string {
	const params = new URLSearchParams({
		url: mcpServerUrl,
		type: 'streamable_http',
		id: 'kody',
		name: 'Kody',
		description: 'Kody personal assistant',
	})
	return `goose://extension?${params.toString()}`
}
