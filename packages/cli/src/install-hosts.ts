import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import {
	addMcpAgentByHostId,
	addMcpUsesProjectScope,
	defaultUpsertServer,
	isAddMcpHostId,
	kodyRemoteConfig,
	type AddMcpHostId,
	type UpsertServerFn,
} from './add-mcp-install.js'
import {
	buildCursorInstallUrl,
	buildGooseInstallUrl,
	buildVsCodeInstallUrl,
	hostById,
	hostConfigPath,
	type HostId,
} from './host-catalog.js'
import { writeMergedConfig, type LeftoverHostId } from './host-config.js'
import {
	describeHeadlessLoginReason,
	detectHeadlessLoginReason,
	type HeadlessLoginReason,
} from './login-notice.js'
import { openUrl } from './open-url.js'
import { which as whichOnPath } from './which.js'

export type ApplyStatus = 'wrote' | 'unchanged' | 'manual' | 'command'

export type ApplyResult = {
	id: HostId
	label: string
	status: ApplyStatus
	path?: string
	opened?: string
	command?: string
	instructions: Array<string>
}

export type InstallRuntime = {
	home: string
	cwd: string
	project: boolean
	platform?: NodeJS.Platform
	which?: (command: string) => string | undefined
	openUrl?: (url: string) => Promise<boolean>
	openApp?: (name: string) => Promise<boolean>
	runCommand?: (command: string, args: Array<string>) => Promise<boolean>
	readFile?: (path: string) => Promise<string | null>
	writeFile?: (path: string, body: string) => Promise<void>
	mkdir?: (path: string) => Promise<void>
	upsertServer?: UpsertServerFn
	/** Defaults to detecting SSH or a missing display from the environment. */
	headlessLoginReason?: HeadlessLoginReason | null
}

const oauthNote = 'Approve Kody in the browser when the client starts OAuth.'

function headlessReasonFor(runtime: InstallRuntime) {
	if (runtime.headlessLoginReason !== undefined) {
		return runtime.headlessLoginReason
	}
	return detectHeadlessLoginReason(process.env, runtime.platform)
}

/** Mirrors docs/use/troubleshooting.md "Authorizing from a remote or headless machine". */
function headlessOAuthSteps(
	id: 'codex' | 'opencode',
	reason: HeadlessLoginReason,
): Array<string> {
	const lead = `${describeHeadlessLoginReason(reason)}, so a browser on another computer cannot reach the OAuth callback here. To sign in:`
	if (id === 'codex') {
		return [
			lead,
			'1. Run: codex mcp login kody --no-browser',
			'2. Open the printed link in the browser on your own computer and approve Kody.',
			'3. The last page fails to load; that is expected. Copy the whole URL from the address bar (it starts with http://127.0.0.1) and paste it into this terminal.',
		]
	}
	const portNote =
		'If you set oauth.callbackPort (or callback_port) for kody, use that port instead of 19876. Without it, newer OpenCode builds can pick a random port, so pin it to 19876 first.'
	if (reason === 'ssh') {
		return [
			lead,
			'1. From your own computer, reconnect with the callback port forwarded: ssh -L 127.0.0.1:19876:127.0.0.1:19876 user@host',
			'2. In that session, run: opencode mcp auth kody and approve Kody in your browser.',
			portNote,
		]
	}
	return [
		lead,
		'1. Run: opencode mcp auth kody and leave it waiting.',
		'2. Open the printed link in a browser on any computer and approve Kody.',
		"3. The last page fails to load; that is expected. Copy the whole URL from the address bar (it starts with http://127.0.0.1:19876/mcp/oauth/callback) and, in another terminal here, run: curl '<that URL>'",
		portNote,
	]
}

async function defaultReadFile(path: string): Promise<string | null> {
	try {
		return await readFile(path, 'utf8')
	} catch {
		return null
	}
}

async function defaultRunCommand(
	command: string,
	args: Array<string>,
): Promise<boolean> {
	return await new Promise((resolve) => {
		const child = spawn(command, args, { stdio: 'ignore' })
		child.on('error', () => resolve(false))
		child.on('exit', (code) => resolve(code === 0))
	})
}

async function defaultOpenApp(name: string): Promise<boolean> {
	if (process.platform === 'darwin')
		return defaultRunCommand('open', ['-a', name])
	if (process.platform === 'win32')
		return defaultRunCommand('cmd', ['/c', 'start', '', name])
	return defaultRunCommand(name, [])
}

function runtimeMethods(runtime: InstallRuntime) {
	return {
		which: runtime.which ?? whichOnPath,
		openUrl: runtime.openUrl ?? openUrl,
		openApp: runtime.openApp ?? defaultOpenApp,
		runCommand: runtime.runCommand ?? defaultRunCommand,
		readFile: runtime.readFile ?? defaultReadFile,
		writeFile:
			runtime.writeFile ??
			((path: string, body: string) => writeFile(path, body, 'utf8')),
		mkdir:
			runtime.mkdir ??
			((path: string) =>
				mkdir(path, { recursive: true }).then(() => undefined)),
		upsertServer: runtime.upsertServer ?? defaultUpsertServer,
	}
}

async function writeLeftoverFile(
	id: LeftoverHostId,
	mcpUrl: string,
	runtime: InstallRuntime,
): Promise<{ path: string; changed: boolean } | null> {
	const path = hostConfigPath({
		id,
		home: runtime.home,
		cwd: runtime.cwd,
		project: runtime.project,
		platform: runtime.platform,
	})
	if (!path) return null
	const io = runtimeMethods(runtime)
	return await writeMergedConfig({
		path,
		id,
		mcpUrl,
		readFile: io.readFile,
		writeFile: io.writeFile,
		mkdir: io.mkdir,
	})
}

function writeAddMcpHost(
	id: AddMcpHostId,
	mcpUrl: string,
	runtime: InstallRuntime,
): { path?: string; changed: boolean; error?: string } {
	const result = runtimeMethods(runtime).upsertServer(
		addMcpAgentByHostId[id],
		'kody',
		kodyRemoteConfig(mcpUrl),
		{
			local: addMcpUsesProjectScope(id, runtime.project),
			cwd: runtime.cwd,
		},
	)
	if (!result.success) {
		return {
			changed: false,
			error: result.error ?? `add-mcp could not configure ${id}.`,
		}
	}
	return { path: result.path, changed: true }
}

async function tryCommand(
	runtime: InstallRuntime,
	command: string,
	args: Array<string>,
): Promise<{ ran: boolean; command: string }> {
	const resolved = runtimeMethods(runtime).which(command)
	const line = `${command} ${args.join(' ')}`
	if (!resolved) return { ran: false, command: line }
	const ok = await runtimeMethods(runtime).runCommand(resolved, args)
	return { ran: ok, command: line }
}

export async function applyHost(input: {
	id: HostId
	mcpUrl: string
	runtime: InstallRuntime
}): Promise<ApplyResult> {
	const host = hostById(input.id)
	const io = runtimeMethods(input.runtime)
	switch (input.id) {
		case 'claude-desktop': {
			const opened = await io.openApp('Claude')
			return {
				id: input.id,
				label: host.label,
				status: 'manual',
				opened: opened ? 'Claude' : undefined,
				instructions: [
					'Open Settings → Connectors and add a custom connector with this MCP URL.',
					'Do not put the remote URL in claude_desktop_config.json.',
					'After connecting, start a new chat and ask Claude to list Kody tools.',
					oauthNote,
				],
			}
		}
		case 'jetbrains':
			return {
				id: input.id,
				label: host.label,
				status: 'manual',
				instructions: [
					'Open Settings → Tools → AI Assistant → MCP and add a remote HTTP server named kody.',
					oauthNote,
				],
			}
		case 'claude-code': {
			const added = await tryCommand(input.runtime, 'claude', [
				'mcp',
				'add',
				'--transport',
				'http',
				'-s',
				input.runtime.project ? 'project' : 'user',
				'kody',
				input.mcpUrl,
			])
			if (added.ran) {
				return {
					id: input.id,
					label: host.label,
					status: 'command',
					command: added.command,
					instructions: [oauthNote],
				}
			}
			return addMcpResult(input, [
				`Or run: claude mcp add --transport http -s user kody ${input.mcpUrl}`,
				oauthNote,
			])
		}
		case 'copilot-cli': {
			const added = await tryCommand(input.runtime, 'copilot', [
				'mcp',
				'add',
				'--transport',
				'http',
				'kody',
				input.mcpUrl,
			])
			if (added.ran) {
				return {
					id: input.id,
					label: host.label,
					status: 'command',
					command: added.command,
					instructions: [oauthNote],
				}
			}
			return addMcpResult(input, [
				`Or run: copilot mcp add --transport http kody ${input.mcpUrl}`,
				oauthNote,
			])
		}
		case 'gemini-cli': {
			const added = await tryCommand(input.runtime, 'gemini', [
				'mcp',
				'add',
				'--transport',
				'http',
				'--scope',
				input.runtime.project ? 'project' : 'user',
				'kody',
				input.mcpUrl,
			])
			if (added.ran) {
				return {
					id: input.id,
					label: host.label,
					status: 'command',
					command: added.command,
					instructions: [oauthNote],
				}
			}
			return addMcpResult(input, [
				`Or run: gemini mcp add --transport http --scope user kody ${input.mcpUrl}`,
				oauthNote,
			])
		}
		case 'cursor': {
			const written = writeMappedHost(input)
			const url = buildCursorInstallUrl(input.mcpUrl)
			const opened = written.status === 'wrote' ? await io.openUrl(url) : false
			return {
				...written,
				opened: opened ? url : undefined,
				instructions: [
					'Reload MCP servers in Cursor if the new server does not appear.',
					oauthNote,
				],
			}
		}
		case 'vscode': {
			const written = writeMappedHost(input)
			const url = buildVsCodeInstallUrl(input.mcpUrl)
			const opened = written.status === 'wrote' ? await io.openUrl(url) : false
			return {
				...written,
				opened: opened ? url : undefined,
				instructions: [
					'Use Agent mode in Copilot Chat after the server is added.',
					oauthNote,
				],
			}
		}
		case 'vscode-insiders': {
			const written = await writeLeftoverFile(
				input.id,
				input.mcpUrl,
				input.runtime,
			)
			const url = buildVsCodeInstallUrl(input.mcpUrl, 'vscode-insiders')
			const opened = written?.changed ? await io.openUrl(url) : false
			return leftoverResult(
				host.label,
				input.id,
				written,
				[
					'Use Agent mode in Copilot Chat after the server is added.',
					oauthNote,
				],
				opened ? url : undefined,
			)
		}
		case 'goose': {
			const written = writeMappedHost(input)
			const url = buildGooseInstallUrl(input.mcpUrl)
			const opened = written.status === 'wrote' ? await io.openUrl(url) : false
			return {
				...written,
				opened: opened ? url : undefined,
				instructions: [
					'Restart Goose if the extension does not appear.',
					oauthNote,
				],
			}
		}
		case 'codex': {
			const written = writeMappedHost(input)
			if (written.status === 'manual') return written
			const headless = headlessReasonFor(input.runtime)
			if (headless) {
				return {
					...written,
					instructions: headlessOAuthSteps('codex', headless),
				}
			}
			if (written.status === 'wrote') {
				await tryCommand(input.runtime, 'codex', ['mcp', 'login', 'kody'])
			}
			return {
				...written,
				instructions: [
					'If OAuth does not start, run: codex mcp login kody',
					oauthNote,
				],
			}
		}
		case 'opencode': {
			const written = writeMappedHost(input)
			if (written.status === 'manual') return written
			const headless = headlessReasonFor(input.runtime)
			if (headless) {
				return {
					...written,
					instructions: headlessOAuthSteps('opencode', headless),
				}
			}
			if (written.status === 'wrote') {
				await tryCommand(input.runtime, 'opencode', ['mcp', 'auth', 'kody'])
			}
			return {
				...written,
				instructions: [
					'If OAuth does not start, run: opencode mcp auth kody',
					oauthNote,
				],
			}
		}
		case 'windsurf':
		case 'zed':
		case 'antigravity':
		case 'cline':
		case 'cline-cli':
		case 'fx':
		case 'grok-build':
		case 'kilo-code':
		case 'kimi-code':
		case 'kiro-cli':
		case 'mastracode':
		case 'mcporter':
		case 'pi':
			return addMcpResult(input, [
				`Restart ${host.label} if the new server does not appear.`,
				oauthNote,
			])
		case 'qwen-code':
		case 'amazon-q':
		case 'visual-studio': {
			const written = await writeLeftoverFile(
				input.id,
				input.mcpUrl,
				input.runtime,
			)
			return leftoverResult(host.label, input.id, written, [
				`Restart ${host.label} if the new server does not appear.`,
				oauthNote,
			])
		}
		default: {
			const exhaustive: never = input.id
			throw new Error(`Unhandled host: ${String(exhaustive)}`)
		}
	}
}

function writeMappedHost(input: {
	id: HostId
	mcpUrl: string
	runtime: InstallRuntime
}): ApplyResult {
	const host = hostById(input.id)
	if (!isAddMcpHostId(input.id)) {
		return {
			id: input.id,
			label: host.label,
			status: 'manual',
			instructions: [`${host.label} has no add-mcp writer.`],
		}
	}
	const written = writeAddMcpHost(input.id, input.mcpUrl, input.runtime)
	if (written.error) {
		return {
			id: input.id,
			label: host.label,
			status: 'manual',
			instructions: [written.error, oauthNote],
		}
	}
	return {
		id: input.id,
		label: host.label,
		status: written.changed ? 'wrote' : 'unchanged',
		path: written.path,
		instructions: [],
	}
}

function addMcpResult(
	input: { id: HostId; mcpUrl: string; runtime: InstallRuntime },
	instructions: Array<string>,
): ApplyResult {
	return { ...writeMappedHost(input), instructions }
}

function leftoverResult(
	label: string,
	id: LeftoverHostId,
	written: { path: string; changed: boolean } | null,
	instructions: Array<string>,
	opened?: string,
): ApplyResult {
	if (!written) {
		return {
			id,
			label,
			status: 'manual',
			instructions: [
				`${label} has no automatic config path for this scope.`,
				...instructions,
			],
		}
	}
	return {
		id,
		label,
		status: written.changed ? 'wrote' : 'unchanged',
		path: written.path,
		opened,
		instructions,
	}
}
