/**
 * Unattended end-to-end check for host commands on execution contexts
 * (ADR 0093). Registers a throwaway context in a temporary CLI config dir,
 * turns commands on locally, runs a daemon, executes a run on the context that
 * runs a foreground command and a background start/poll/kill, checks the audit
 * log, then revokes and deletes the context.
 *
 *   KODY_API_TOKEN=... node tools/e2e/execution-context-commands.ts \
 *     --api-url https://api.kody.codes [--cli "kody"] [--keep-temp]
 *
 * See docs/contributing/architecture/execution-contexts.md#end-to-end-check.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
	options: {
		'api-url': { type: 'string', default: 'https://api.kody.codes' },
		cli: { type: 'string' },
		'keep-temp': { type: 'boolean', default: false },
	},
})
const apiUrl = values['api-url']!
const token = process.env.KODY_API_TOKEN
if (!token) {
	console.error(
		'Set KODY_API_TOKEN (see the doc linked at the top of this file).',
	)
	process.exit(2)
}

const repoRoot = resolve(import.meta.dirname, '../..')
const cliArgv = values.cli
	? values.cli.split(' ').filter(Boolean)
	: [
			join(repoRoot, 'node_modules/.bin/tsx'),
			join(repoRoot, 'packages/cli/src/bin.ts'),
		]
const temp = mkdtempSync(join(tmpdir(), 'kody-ec-commands-e2e-'))
const env: NodeJS.ProcessEnv = {
	...process.env,
	// macOS keeps CLI config under $HOME/Library, ignoring XDG_*: isolate both.
	HOME: temp,
	XDG_CONFIG_HOME: join(temp, 'config'),
	XDG_STATE_HOME: join(temp, 'state'),
	XDG_DATA_HOME: join(temp, 'data'),
	APPDATA: join(temp, 'config'),
	LOCALAPPDATA: join(temp, 'data'),
	KODY_API_TOKEN: token,
	KODY_SKIP_SKILL_REFRESH: '1',
	KODY_SKIP_GIT_HELPER_REFRESH: '1',
	KODY_NO_UPDATE_CHECK: '1',
}
const secretEnvValue = `e2e-env-value-${Math.random().toString(36).slice(2)}`
const name = `e2e-commands-${Date.now().toString(36)}`

function step(text: string) {
	console.log(`• ${text}`)
}

function kody(args: Array<string>) {
	const [bin, ...pre] = cliArgv
	const result = spawnSync(bin!, [...pre, ...args, '--api-url', apiUrl], {
		env,
		encoding: 'utf8',
		timeout: 180_000,
	})
	if (result.status !== 0) {
		throw new Error(
			`kody ${args.join(' ')} exited ${result.status}: ${result.stderr || result.stdout}`,
		)
	}
	return result.stdout
}

function kodyJson(args: Array<string>) {
	const out = kody([...args, '--json'])
	return JSON.parse(out.slice(out.indexOf('{'))) as Record<string, unknown>
}

async function api(method: string, path: string) {
	const response = await fetch(new URL(path, apiUrl), {
		method,
		headers: { authorization: `Bearer ${token}` },
	})
	const body = (await response.json().catch(() => ({}))) as Record<
		string,
		unknown
	>
	if (!response.ok) {
		throw new Error(
			`${method} ${path} → ${response.status} ${JSON.stringify(body)}`,
		)
	}
	return body
}

function find(
	value: unknown,
	test: (item: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
	if (!value || typeof value !== 'object') return null
	if (!Array.isArray(value) && test(value as Record<string, unknown>)) {
		return value as Record<string, unknown>
	}
	for (const child of Object.values(value)) {
		const hit = find(child, test)
		if (hit) return hit
	}
	return null
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

// Windows runs PowerShell by default; macOS and Linux run $SHELL.
const [fgCommand, bgCommand] =
	process.platform === 'win32'
		? [
				'"$env:KODY_E2E_VALUE|$((Get-Location).Path)"; [Console]::Error.WriteLine(\'oops\'); exit 3',
				'1..6 | ForEach-Object { "tick$_"; Start-Sleep -Seconds 1 }; Start-Sleep -Seconds 120',
			]
		: [
				'printf "%s|%s" "$KODY_E2E_VALUE" "$(pwd)"; echo oops >&2; exit 3',
				'for i in 1 2 3 4 5 6; do echo tick$i; sleep 1; done; sleep 120',
			]

const runModule = `
import { kody } from 'kody:runtime'
export default async function main() {
	const cwd = ${JSON.stringify(temp)}
	const fg = await kody.command.run({
		command: ${JSON.stringify(fgCommand)},
		cwd,
		env: { KODY_E2E_VALUE: ${JSON.stringify(secretEnvValue)} },
	})
	const job = await kody.command.start({
		command: ${JSON.stringify(bgCommand)},
		cwd,
	})
	let chunk = { stdout: '', stdoutOffset: 0 }
	for (let i = 0; i < 40 && !chunk.stdout.includes('tick2'); i++) {
		await new Promise((done) => setTimeout(done, 500))
		const page = await kody.command.output({ commandId: job.commandId, stdoutOffset: 0 })
		chunk = { stdout: page.stdout, stdoutOffset: page.stdoutOffset }
	}
	const running = await kody.command.status({ commandId: job.commandId })
	const killed = await kody.command.kill({ commandId: job.commandId })
	let final = killed
	for (let i = 0; i < 20 && final.state === 'running'; i++) {
		await new Promise((done) => setTimeout(done, 250))
		final = await kody.command.status({ commandId: job.commandId })
	}
	return { e2e: 'host-commands', fg, job, chunk, running, final }
}
`

let daemon: ChildProcess | null = null
let ecid: string | null = null
let failed = false
try {
	step(`Registering throwaway context ${name} (config in ${temp})`)
	const registered = kodyJson([
		'context',
		'register',
		'--name',
		name,
		'--key-storage',
		'file',
		'--no-install',
		'--yes',
	])
	ecid =
		(find(registered, (item) => typeof item.ecid === 'string')
			?.ecid as string) ?? null
	assert(ecid, `register printed an ecid: ${JSON.stringify(registered)}`)

	const before = await api('GET', `/v1/execution-contexts/${ecid}`)
	assert(
		find(
			before,
			(item) => 'commands' in item && typeof item.commands === 'object',
		)
			? (
					find(before, (item) => typeof item.commands === 'object')!
						.commands as { enabled?: boolean }
				).enabled !== true
			: true,
		'commands are off for a new context',
	)

	step('Turning host commands on locally')
	const on = kodyJson(['context', 'commands', 'on', '--context', name])
	assert(
		(on.contexts as Array<{ commands?: { enabled?: boolean } }>)?.[0]?.commands
			?.enabled === true,
		`commands on reached Kody: ${JSON.stringify(on)}`,
	)

	step('Starting the daemon')
	const [bin, ...pre] = cliArgv
	daemon = spawn(
		bin!,
		[...pre, 'daemon', '--context', ecid, '--api-url', apiUrl],
		{
			env,
			stdio: ['ignore', 'inherit', 'inherit'],
		},
	)
	let online = false
	for (let i = 0; i < 60 && !online; i++) {
		await sleep(1000)
		const got = await api('GET', `/v1/execution-contexts/${ecid}`)
		online = find(got, (item) => item.status === 'online') !== null
	}
	assert(online, 'daemon came online within 60s')

	step('Running an execute on the context')
	const executed = JSON.parse(
		kody(['execute', '--context', name, '--code', runModule, '--json']),
	)
	const result = find(executed, (item) => item.e2e === 'host-commands') as {
		fg: { exitCode: number; stdout: string; stderr: string }
		job: { commandId: string }
		chunk: { stdout: string; stdoutOffset: number }
		running: { state: string }
		final: { state: string }
	} | null
	assert(
		result,
		`execute returned the run result: ${JSON.stringify(executed).slice(0, 2000)}`,
	)
	assert(
		result.fg.exitCode === 3,
		`foreground exit code 3, got ${result.fg.exitCode}`,
	)
	assert(
		result.fg.stdout.startsWith(`${secretEnvValue}|`),
		`foreground stdout has the env value: ${result.fg.stdout}`,
	)
	assert(result.fg.stderr.includes('oops'), 'foreground stderr captured')
	assert(result.chunk.stdout.includes('tick2'), 'background output polled')
	assert(result.chunk.stdoutOffset > 0, 'background output offset advanced')
	assert(result.running.state === 'running', 'background job was running')
	assert(
		result.final.state === 'killed',
		`background job killed, got ${result.final.state}`,
	)

	step('Checking the audit log')
	let audit: Record<string, unknown> = {}
	let finishedCount = 0
	for (let i = 0; i < 20 && finishedCount < 2; i++) {
		await sleep(1000)
		audit = await api('GET', `/v1/execution-contexts/${ecid}/audit?limit=50`)
		const events =
			(audit.events as Array<{ event?: string; action?: string }>) ?? []
		finishedCount = events.filter(
			(event) => (event.event ?? event.action) === 'command_finished',
		).length
	}
	const events =
		(audit.events as Array<{
			event?: string
			action?: string
			detail?: Record<string, unknown>
		}>) ?? []
	const started = events.filter(
		(event) => (event.event ?? event.action) === 'command_started',
	)
	assert(
		started.length >= 2,
		`two command_started events, got ${started.length}`,
	)
	assert(
		finishedCount >= 2,
		`two command_finished events, got ${finishedCount}`,
	)
	assert(
		events.some((event) => event.detail?.exitCode === 3),
		'command_finished recorded exit code 3',
	)
	assert(
		!JSON.stringify(audit).includes(secretEnvValue),
		'audit log never contains env values',
	)
	assert(
		started.some((event) =>
			(event.detail?.envKeys as Array<string> | undefined)?.includes(
				'KODY_E2E_VALUE',
			),
		),
		'audit log records env keys',
	)

	step('Turning commands off from the API is immediate')
	await fetch(new URL(`/v1/execution-contexts/${ecid}`, apiUrl), {
		method: 'PATCH',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify({ grant: { commands: { enabled: false } } }),
	}).then(async (response) => {
		assert(
			response.ok,
			`PATCH commands off → ${response.status} ${await response.text()}`,
		)
	})
	const denied = JSON.parse(
		spawnSync(
			bin!,
			[
				...pre,
				'execute',
				'--context',
				name,
				'--code',
				`import { kody } from 'kody:runtime'\nexport default async () => { try { await kody.command.run({ command: 'true' }); return { e2e: 'denied', code: null } } catch (error) { return { e2e: 'denied', code: String(error.message) } } }`,
				'--json',
				'--api-url',
				apiUrl,
			],
			{ env, encoding: 'utf8', timeout: 180_000 },
		).stdout || '{}',
	)
	const deniedResult = find(denied, (item) => item.e2e === 'denied')
	assert(
		String(deniedResult?.code).includes('execution_context_commands_off'),
		`commands off denial: ${JSON.stringify(denied).slice(0, 1000)}`,
	)
	console.log('✅ Host commands e2e passed')
} catch (error) {
	failed = true
	console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
} finally {
	if (daemon && daemon.exitCode === null) {
		daemon.kill('SIGTERM')
		await sleep(2000)
		if (daemon.exitCode === null) daemon.kill('SIGKILL')
	}
	if (ecid) {
		step(`Revoking and deleting ${ecid}`)
		await api('DELETE', `/v1/execution-contexts/${ecid}`).catch((error) =>
			console.error(`revoke failed: ${error.message}`),
		)
		await api('POST', `/v1/execution-contexts/${ecid}/delete`).catch(
			(error) => {
				failed = true
				console.error(`delete failed: ${error.message}`)
			},
		)
	}
	if (!values['keep-temp']) rmSync(temp, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
