import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	HostCommands,
	inheritedCommandEnv,
	type HostCommandFinished,
	type HostCommandRunContext,
} from '../src/execution-context/host-commands.js'
import {
	readLocalCommandsEnabled,
	readLocalPolicy,
	allowLocalPath,
	setLocalCommandsEnabled,
} from '../src/execution-context/fs-access.js'

import { parseMachineCommandDefinition } from '../src/execution-context/machine-capabilities.js'

type Authorized = Parameters<HostCommandRunContext['authorize']>[0]

function runContext(overrides: Partial<HostCommandRunContext> = {}) {
	const authorized: Array<Authorized> = []
	const run: HostCommandRunContext = {
		runId: 'run_1',
		requesterUserId: 'user_a',
		signal: new AbortController().signal,
		authorize: async (input) => {
			authorized.push(input)
		},
		...overrides,
	}
	return { run, authorized }
}

const onWindows = process.platform === 'win32'
const posixOnly = { skip: onWindows && 'POSIX shell commands' }
const windowsOnly = { skip: !onWindows && 'Windows shells' }

function enabledCommands() {
	const commands = new HostCommands({ localEnabled: true })
	commands.setGrantEnabled(true)
	const finished: Array<HostCommandFinished> = []
	commands.setReporter((entry) => {
		finished.push(entry)
	})
	return { commands, finished }
}

async function waitFor(check: () => boolean, ms = 10_000) {
	const end = Date.now() + ms
	while (!check()) {
		if (Date.now() > end) throw new Error('timed out waiting')
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
}

test('host commands are off by default: local opt-in and the grant both start off', async () => {
	const commands = new HostCommands({ platform: 'linux' })
	assert.equal(commands.enabled, false)
	const { run, authorized } = runContext()
	await assert.rejects(
		commands.call('run', { command: 'echo hi' }, run),
		/off on this machine.*execution_context_commands_off/s,
	)
	assert.equal(authorized.length, 0)
	const policyPath = join(
		mkdtempSync(join(tmpdir(), 'kody-cmd-policy-')),
		'p.json',
	)
	assert.equal(await readLocalCommandsEnabled(policyPath), false)
})

test('denial names the missing layer: local opt-in off vs turned off in Kody', async () => {
	const { run } = runContext()
	const localOff = new HostCommands({ localEnabled: false, platform: 'linux' })
	localOff.setGrantEnabled(true)
	await assert.rejects(localOff.call('run', 'true', run), /has not opted in/)
	const grantOff = new HostCommands({ localEnabled: true })
	await assert.rejects(
		grantOff.call('run', 'true', run),
		/were turned off for this machine/,
	)
})

test(
	'a foreground command runs for real: stdout, stderr, exit code, cwd, env, stdin, and the audit hop',
	posixOnly,
	async () => {
		const cwd = realpathSync.native(
			mkdtempSync(join(tmpdir(), 'kody-cmd-cwd-')),
		)
		const { commands, finished } = enabledCommands()
		const { run, authorized } = runContext()
		const result = (await commands.call(
			'run',
			{
				command: 'pwd; echo "$KODY_TEST_VALUE"; cat; echo oops >&2; exit 3',
				cwd,
				env: { KODY_TEST_VALUE: 'secret-value' },
				stdin: 'from stdin',
			},
			run,
		)) as Record<string, unknown>
		assert.equal(result.exitCode, 3)
		assert.equal(result.stdout, `${cwd}\nsecret-value\nfrom stdin`)
		assert.equal(result.stderr, 'oops\n')
		assert.equal(typeof result.durationMs, 'number')
		// Kody authorizes (and audits) before the process starts; env values never leave.
		assert.equal(authorized.length, 1)
		assert.deepEqual(
			{ ...authorized[0], commandId: undefined },
			{
				commandId: undefined,
				command: 'pwd; echo "$KODY_TEST_VALUE"; cat; echo oops >&2; exit 3',
				cwd,
				envKeys: ['KODY_TEST_VALUE'],
				background: false,
			},
		)
		assert.equal(JSON.stringify(authorized).includes('secret-value'), false)
		assert.equal(finished.length, 1)
		assert.equal(finished[0]?.exitCode, 3)
		assert.equal(finished[0]?.commandId, result.commandId)
		assert.equal(JSON.stringify(finished).includes('secret-value'), false)
	},
)

test(
	'a refused authorization never starts the process',
	posixOnly,
	async () => {
		const { commands, finished } = enabledCommands()
		const { run } = runContext({
			authorize: async () => {
				throw new Error(
					'You are not granted host commands (execution_context_command_not_granted)',
				)
			},
		})
		const marker = join(mkdtempSync(join(tmpdir(), 'kody-cmd-')), 'ran')
		await assert.rejects(
			commands.call('run', { command: `touch ${marker}` }, run),
			/execution_context_command_not_granted/,
		)
		assert.equal(finished.length, 0)
		const { existsSync } = await import('node:fs')
		assert.equal(existsSync(marker), false)
	},
)

test(
	'file + args runs without a shell, and timeouts kill the command',
	posixOnly,
	async () => {
		const { commands } = enabledCommands()
		const { run } = runContext()
		const echoed = (await commands.call(
			'run',
			{ file: 'printf', args: ['%s', '$HOME; not expanded'] },
			run,
		)) as Record<string, unknown>
		assert.equal(echoed.stdout, '$HOME; not expanded')
		const slow = (await commands.call(
			'run',
			{ command: 'sleep 5', timeoutMs: 200 },
			run,
		)) as Record<string, unknown>
		assert.equal(slow.timedOut, true)
		assert.ok((slow.durationMs as number) < 4000)
	},
)

test(
	'background job lifecycle: start, poll status and output by offset, kill',
	posixOnly,
	async () => {
		const { commands, finished } = enabledCommands()
		const { run, authorized } = runContext()
		const started = (await commands.call(
			'start',
			{ command: 'echo started; while true; do echo tick; sleep 0.05; done' },
			run,
		)) as { commandId: string }
		assert.match(started.commandId, /^cmd_/)
		assert.equal(
			(authorized[0] as { background?: boolean } | undefined)?.background,
			true,
		)
		await waitFor(() => {
			const output = commands.output({ commandId: started.commandId }, run)
			return output.stdout.includes('tick')
		})
		const first = commands.output({ commandId: started.commandId }, run)
		assert.ok(first.stdout.startsWith('started\n'))
		assert.equal(first.state, 'running')
		const next = commands.output(
			{ commandId: started.commandId, stdoutOffset: first.stdoutOffset },
			run,
		)
		assert.equal(next.stdout.includes('started'), false)
		assert.equal(
			commands.status({ commandId: started.commandId }, run).state,
			'running',
		)
		// Another person cannot see or kill it.
		const other = runContext({ requesterUserId: 'user_b' }).run
		assert.throws(
			() => commands.kill({ commandId: started.commandId }, other),
			/No background command/,
		)
		assert.deepEqual(commands.list(other).commands, [])
		commands.kill({ commandId: started.commandId }, run)
		await waitFor(() => finished.length === 1)
		const status = commands.status({ commandId: started.commandId }, run)
		assert.equal(status.state, 'killed')
		assert.equal(finished[0]?.background, true)
		assert.equal(finished[0]?.reason, 'killed')
		assert.equal(commands.list(run).commands.length, 1)
		const done = commands.output(
			{ commandId: started.commandId, stdoutOffset: status.stdoutBytes },
			run,
		)
		assert.equal(done.done, true)
	},
)

test(
	'a background job outlives its run, and turning commands off kills it',
	posixOnly,
	async () => {
		const { commands, finished } = enabledCommands()
		const abort = new AbortController()
		const { run } = runContext({ signal: abort.signal })
		const started = (await commands.call('start', 'sleep 30', run)) as {
			commandId: string
		}
		abort.abort()
		await new Promise((resolve) => setTimeout(resolve, 100))
		assert.equal(commands.status(started.commandId, run).state, 'running')
		commands.setGrantEnabled(false)
		await waitFor(() => finished.length === 1)
		assert.equal(finished[0]?.reason, 'commands_off')
		await assert.rejects(
			commands.call('status', started.commandId, run),
			/turned off/,
		)
	},
)

test(
	'turning commands off kills the whole group after the shell leader exits',
	posixOnly,
	async () => {
		const { commands, finished } = enabledCommands()
		const { run } = runContext()
		// sh exits at once; the backgrounded sleep keeps the pipes open.
		const started = (await commands.call(
			'start',
			{ command: 'sleep 30 & echo leader-done' },
			run,
		)) as { commandId: string }
		await waitFor(() =>
			commands
				.output({ commandId: started.commandId }, run)
				.stdout.includes('leader-done'),
		)
		await new Promise((resolve) => setTimeout(resolve, 200))
		assert.equal(commands.status(started.commandId, run).state, 'running')
		commands.setLocalEnabled(false)
		await waitFor(() => finished.length === 1, 5_000)
		assert.equal(finished[0]?.reason, 'commands_off')
	},
)

test('output pages never split a UTF-8 character', posixOnly, async () => {
	const { commands, finished } = enabledCommands()
	const { run } = runContext()
	const started = (await commands.call(
		'start',
		{ command: "printf 'aé€😀b'" },
		run,
	)) as { commandId: string }
	await waitFor(() => finished.length === 1)
	let offset = 0
	let text = ''
	for (let i = 0; i < 20; i++) {
		const page = commands.output(
			{ commandId: started.commandId, stdoutOffset: offset, maxBytes: 2 },
			run,
		)
		text += page.stdout
		if (page.stdoutOffset === offset) break
		offset = page.stdoutOffset
	}
	assert.equal(text, 'aé€😀b')
})

test(
	'turning commands off also kills a running foreground command',
	posixOnly,
	async () => {
		const { commands } = enabledCommands()
		const { run } = runContext()
		const pending = commands.call(
			'run',
			{ command: 'sleep 30', timeoutMs: 60_000 },
			run,
		)
		await new Promise((resolve) => setTimeout(resolve, 200))
		commands.setGrantEnabled(false)
		const result = (await pending) as {
			exitCode: number | null
			durationMs: number
		}
		assert.equal(result.exitCode, null)
		assert.ok(result.durationMs < 5000)
	},
)

test(
	'Windows: PowerShell by default, UTF-8 output, cwd, env, stdin, exit code',
	windowsOnly,
	async () => {
		const cwd = realpathSync.native(
			mkdtempSync(join(tmpdir(), 'kody-cmd-cwd-')),
		)
		const { commands, finished } = enabledCommands()
		const { run } = runContext()
		const result = (await commands.call(
			'run',
			{
				command:
					"(Get-Location).Path; $env:KODY_TEST_VALUE; [Console]::In.ReadToEnd(); 'héllo ✓'; [Console]::Error.WriteLine('oops'); exit 3",
				cwd,
				env: { KODY_TEST_VALUE: 'secret-value' },
				stdin: 'from stdin',
			},
			run,
		)) as Record<string, unknown>
		assert.equal(result.exitCode, 3)
		assert.deepEqual(String(result.stdout).trim().split(/\r?\n/), [
			cwd,
			'secret-value',
			'from stdin',
			'héllo ✓',
		])
		assert.equal(String(result.stderr).trim(), 'oops')
		assert.equal(finished[0]?.exitCode, 3)
	},
)

test(
	'Windows: cmd on request, and .cmd files resolve and run with quoted args',
	windowsOnly,
	async () => {
		const dir = realpathSync.native(
			mkdtempSync(join(tmpdir(), 'kody-cmd-bat-')),
		)
		writeFileSync(
			join(dir, 'kody-tool.cmd'),
			'@echo off\r\necho [%~1] [%~2]\r\n',
		)
		const { commands } = enabledCommands()
		const { run } = runContext()
		const viaCmd = (await commands.call(
			'run',
			{
				command: 'echo %KODY_TEST_VALUE%',
				shell: 'cmd',
				env: { KODY_TEST_VALUE: 'ok' },
			},
			run,
		)) as Record<string, unknown>
		assert.equal(String(viaCmd.stdout).trim(), 'ok')
		const viaFile = (await commands.call(
			'run',
			{
				file: 'kody-tool',
				args: ['two words', '50%'],
				env: { PATH: `${dir};${process.env.PATH}` },
			},
			run,
		)) as Record<string, unknown>
		assert.equal(String(viaFile.stdout).trim(), '[two words] [50%]')
	},
)

test(
	'Windows: timeouts and kill end the whole process tree',
	windowsOnly,
	async () => {
		const { commands, finished } = enabledCommands()
		const { run } = runContext()
		const slow = (await commands.call(
			'run',
			{ command: 'Start-Sleep -Seconds 30', timeoutMs: 500 },
			run,
		)) as Record<string, unknown>
		assert.equal(slow.timedOut, true)
		assert.equal(slow.exitCode, null)
		assert.equal(slow.signal, 'SIGKILL')
		assert.ok((slow.durationMs as number) < 15_000)
		const started = (await commands.call(
			'start',
			'while ($true) { "tick"; Start-Sleep -Milliseconds 50 }',
			run,
		)) as { commandId: string }
		await waitFor(() =>
			commands
				.output({ commandId: started.commandId }, run)
				.stdout.includes('tick'),
		)
		commands.kill({ commandId: started.commandId }, run)
		await waitFor(() => finished.some((entry) => entry.background))
		assert.equal(
			commands.status({ commandId: started.commandId }, run).state,
			'killed',
		)
	},
)

test('local policy keeps the commands opt-in alongside host folders', async () => {
	const dir = realpathSync.native(
		mkdtempSync(join(tmpdir(), 'kody-cmd-policy-')),
	)
	const policyPath = join(dir, 'policy.json')
	await setLocalCommandsEnabled({ enabled: true, policyPath })
	await allowLocalPath({ path: dir, mode: 'ro', policyPath })
	const policy = await readLocalPolicy(policyPath)
	assert.equal(policy.commands?.enabled, true)
	assert.deepEqual(
		policy.fs.map(({ path, mode }) => ({ path, mode })),
		[{ path: dir, mode: 'ro' }],
	)
	await setLocalCommandsEnabled({ enabled: false, policyPath })
	assert.equal(await readLocalCommandsEnabled(policyPath), false)
})

test('commands never inherit KODY_* variables from the daemon', () => {
	const env = inheritedCommandEnv({
		PATH: '/usr/bin',
		KODY_API_TOKEN: 'kody_at_secret',
		KODY_CONTEXT_KEY_PASSPHRASE: 'hunter2',
		kody_lower: 'x',
	})
	assert.deepEqual(env, { PATH: '/usr/bin' })
})

test('a command cannot use a credential folder as its cwd', async () => {
	const denied = realpathSync.native(
		mkdtempSync(join(tmpdir(), 'kody-cmd-denied-')),
	)
	const commands = new HostCommands({
		localEnabled: true,
		deniedPaths: [denied],
	})
	commands.setGrantEnabled(true)
	const { run, authorized } = runContext()
	await assert.rejects(
		commands.call('run', { command: 'pwd', cwd: denied }, run),
		/holds credentials/,
	)
	assert.equal(authorized.length, 0)
})

function namedCommands(input: { shell?: boolean } = {}) {
	const definitions = [
		parseMachineCommandDefinition({
			name: 'echo',
			description: 'Print one word',
			exec: [
				process.execPath,
				'-e',
				'console.log(process.argv.slice(1).join(" "))',
			],
			args: [[{ pattern: 'hello|bye' }, { pattern: '[a-z]+' }]],
			timeoutMs: 20_000,
		}),
		parseMachineCommandDefinition({
			name: 'wait',
			exec: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
			args: [[]],
			background: true,
		}),
		parseMachineCommandDefinition({
			name: 'wait-too',
			exec: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
			args: [[]],
			background: true,
		}),
	]
	const commands = new HostCommands({
		localEnabled: input.shell === true,
		namedCommand: async (name) =>
			definitions.find((definition) => definition.name === name),
	})
	commands.setGrantEnabled(input.shell === true)
	return commands
}

test('a named command runs with the shell off, from the definition and the caller arguments only', async () => {
	const commands = namedCommands()
	const { run, authorized } = runContext()
	const result = (await commands.call(
		'run',
		{ capability: 'echo', args: ['hello', 'world'] },
		run,
	)) as { stdout: string; exitCode: number }
	assert.equal(result.exitCode, 0)
	assert.equal(result.stdout.trim(), 'hello world')
	const [sent] = authorized as Array<Record<string, unknown>>
	assert.equal(sent?.capability, 'echo')
	assert.deepEqual(sent?.args, ['hello', 'world'])
	// Kody sees the name and arguments, not the executable or its folder.
	assert.equal(sent?.command, 'echo hello world')
	assert.equal(sent?.cwd, '')
	// The shell is still off.
	await assert.rejects(
		commands.call('run', 'echo hi', run),
		/execution_context_commands_off/,
	)
})

test('a named command refuses arguments outside its shapes, unknown names and shell fields, before asking Kody', async () => {
	const commands = namedCommands({ shell: true })
	const { run, authorized } = runContext()
	await assert.rejects(
		commands.call(
			'run',
			{ capability: 'echo', args: ['hello', 'a; rm -rf /'] },
			run,
		),
		/machine_command_args_refused/,
	)
	await assert.rejects(
		commands.call('run', { capability: 'nope', args: [] }, run),
		/machine_capability_off/,
	)
	for (const extra of [
		{ cwd: tmpdir() },
		{ env: { PATH: '/tmp' } },
		{ command: 'echo hi' },
		{ file: '/bin/sh' },
		{ stdin: 'x' },
	]) {
		await assert.rejects(
			commands.call(
				'run',
				{ capability: 'echo', args: ['hello', 'world'], ...extra },
				run,
			),
			/invalid_request/,
		)
	}
	await assert.rejects(
		commands.call(
			'start',
			{ capability: 'echo', args: ['hello', 'world'] },
			run,
		),
		/does not run in the background/,
	)
	assert.equal(authorized.length, 0)
})

test('a named command is not run when Kody refuses it', async () => {
	const commands = namedCommands()
	const { run } = runContext({
		authorize: async () => {
			throw new Error('nope (machine_capability_not_granted)')
		},
	})
	await assert.rejects(
		commands.call('run', { capability: 'echo', args: ['hello', 'world'] }, run),
		/machine_capability_not_granted/,
	)
})

test('a named background job is polled and killed against its own command, and survives the shell turning off', async () => {
	const commands = namedCommands({ shell: true })
	const { run, authorized } = runContext()
	const started = (await commands.call(
		'start',
		{ capability: 'wait' },
		run,
	)) as {
		commandId: string
	}
	const shell = (await commands.call(
		'start',
		{ file: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] },
		run,
	)) as { commandId: string }
	commands.setGrantEnabled(false)
	const status = (await commands.call('status', started.commandId, run)) as {
		state: string
		capability?: string
	}
	assert.equal(status.state, 'running')
	assert.equal(status.capability, 'wait')
	assert.deepEqual(authorized.at(-1), {
		lifecycle: 'status',
		capability: 'wait',
	})
	// The shell job ended with the shell, and is not reachable with it off.
	await assert.rejects(
		commands.call('status', shell.commandId, run),
		/execution_context_commands_off/,
	)
	const listed = (await commands.call('list', undefined, run)) as {
		commands: Array<{ commandId: string }>
	}
	assert.deepEqual(
		listed.commands.map((entry) => entry.commandId),
		[started.commandId],
	)
	const killed = (await commands.call('kill', started.commandId, run)) as {
		state: string
	}
	assert.equal(killed.state, 'killed')
	await commands.idle()
})

test('list shows the named jobs the caller may still use when the shell rules or one command refuse', async () => {
	const commands = namedCommands({ shell: true })
	const refuse = new Set<string>(['shell'])
	const { run } = runContext({
		authorize: async (input) => {
			const key =
				'capability' in input && input.capability ? input.capability : 'shell'
			if (refuse.has(key)) throw new Error(`refused ${key}`)
		},
	})
	const wait = (await commands.call('start', { capability: 'wait' }, run)) as {
		commandId: string
	}
	const other = (await commands.call(
		'start',
		{ capability: 'wait-too' },
		run,
	)) as { commandId: string }
	const ids = async () =>
		(
			(await commands.call('list', undefined, run)) as {
				commands: Array<{ commandId: string }>
			}
		).commands.map((entry) => entry.commandId)
	// The shell is on here, but this caller's token is refused the shell.
	assert.deepEqual(await ids(), [wait.commandId, other.commandId])
	// One command was removed: only its jobs disappear.
	refuse.add('wait-too')
	assert.deepEqual(await ids(), [wait.commandId])
	refuse.add('wait')
	await assert.rejects(ids(), /refused shell/)
	commands.killAll('shutdown')
	await commands.idle()
})

test("another person's run uses the named commands Kody allows and never the shell, even with the shell on", async () => {
	const commands = namedCommands({ shell: true })
	const { run, authorized } = runContext({
		requesterUserId: 'user_b',
		namedOnly: true,
	})
	const result = (await commands.call(
		'run',
		{ capability: 'echo', args: ['hello', 'world'] },
		run,
	)) as { stdout: string }
	assert.equal(result.stdout.trim(), 'hello world')
	for (const call of [
		() => commands.call('run', 'echo hi', run),
		() => commands.call('start', { file: 'echo', args: ['hi'] }, run),
		() => commands.call('status', 'cmd_missing', run),
		() => commands.call('list', undefined, run),
	]) {
		await assert.rejects(call(), /execution_context_command_not_granted/)
	}
	// Kody was only ever asked about the named command.
	assert.deepEqual(
		authorized.map((entry) => (entry as { capability?: string }).capability),
		['echo'],
	)
})
