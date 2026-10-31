import { compareVersions } from './auto-update.js'
import { execFileSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { delimiter, dirname, join, sep } from 'node:path'
import { contextDir } from './keystore.js'

/**
 * `kody daemon install`: run one execution context's daemon as a per-user
 * background service (systemd --user on Linux, a LaunchAgent on macOS) so it
 * survives reboots and crashes. The unit holds paths and flags only, never a
 * secret: the daemon unwraps its own machine key at start.
 */

export type ServiceManager = 'systemd' | 'launchd'

/** Set in the unit so the daemon knows it runs as a service. */
export const serviceEnvVar = 'KODY_DAEMON_SERVICE'

/**
 * The daemon exits 0 only when it should stay stopped: a stop it was asked
 * for, or a context Kody revoked or deleted. systemd skips the restart for
 * it (RestartPreventExitStatus) and launchd only keeps a failed job alive
 * (KeepAlive SuccessfulExit=false), so a revoked context is never relaunched.
 */
export const stayStoppedExitCode = 0

export function serviceManagerFor(
	platform: NodeJS.Platform = process.platform,
) {
	if (platform === 'linux') return 'systemd' as const
	if (platform === 'darwin') return 'launchd' as const
	return null
}

export const unsupportedPlatformMessage =
	'Running kody daemon as a background service is supported on Linux (systemd) and macOS (launchd). Windows is not supported yet: keep `kody daemon` running in a terminal instead.'

export function serviceName(ecid: string) {
	return `kody-daemon-${ecid}`
}

export function launchdLabel(ecid: string) {
	return `codes.kody.daemon.${ecid}`
}

export type ServicePaths = {
	manager: ServiceManager
	unitPath: string
	logPath: string
	statePath: string
	stoppedPath: string
	workingDir: string
}

export function servicePaths(input: {
	apiUrl: string
	ecid: string
	manager: ServiceManager
	home?: string
	env?: NodeJS.ProcessEnv
}): ServicePaths {
	const home = input.home ?? homedir()
	const env = input.env ?? process.env
	const dir = contextDir(input.apiUrl, input.ecid)
	return {
		manager: input.manager,
		unitPath:
			input.manager === 'systemd'
				? join(
						env.XDG_CONFIG_HOME || join(home, '.config'),
						'systemd',
						'user',
						`${serviceName(input.ecid)}.service`,
					)
				: join(
						home,
						'Library',
						'LaunchAgents',
						`${launchdLabel(input.ecid)}.plist`,
					),
		logPath: join(dir, 'daemon.log'),
		statePath: join(dir, 'daemon.json'),
		stoppedPath: join(dir, 'stopped.json'),
		workingDir: dir,
	}
}

/** Paths that only exist for one `npx` / `pnpm dlx` / `bunx` run. */
export function ephemeralRuntimeReason(
	entryPath: string,
	tmp: string | null = tmpdir(),
) {
	const parts = entryPath.split(/[\\/]+/)
	if (parts.includes('_npx')) return 'npx'
	if (parts.some((part) => part === 'dlx' || part.startsWith('dlx-'))) {
		return 'pnpm dlx'
	}
	if (parts.some((part) => part.startsWith('bunx-'))) return 'bunx'
	if (tmp && entryPath.startsWith(tmp + sep)) return 'a temporary directory'
	return null
}

export const npxRefusal = (how: string) =>
	`This kody CLI is running from ${how}, which is deleted after the command ends, so a background service could not start it again. Install the CLI globally first:\n  npm install -g @kodycodes/cli\nthen run:\n  kody daemon install`

export type DaemonProgram = {
	node: string
	entry: string
	version: string
}

/** The node binary and CLI entry this process runs, with symlinks resolved. */
export function currentProgram(version: string): DaemonProgram {
	const entry = process.argv[1] ?? ''
	let resolved = entry
	try {
		resolved = realpathSync(entry)
	} catch {}
	return { node: process.execPath, entry: resolved, version }
}

export type UnitInput = {
	ecid: string
	contextName: string
	apiUrl: string
	program: DaemonProgram
	paths: ServicePaths
	maxConcurrent?: number
	env?: NodeJS.ProcessEnv
	platform?: NodeJS.Platform
}

function daemonArgs(input: UnitInput) {
	return [
		input.program.entry,
		'daemon',
		'--context',
		input.ecid,
		'--api-url',
		input.apiUrl,
		...(input.maxConcurrent === undefined
			? []
			: ['--max-concurrent', String(input.maxConcurrent)]),
	]
}

/** Services do not see the login shell's PATH; give them a fixed one. */
export function servicePath(input: {
	node: string
	platform?: NodeJS.Platform
}) {
	const platform = input.platform ?? process.platform
	const dirs = [
		dirname(input.node),
		...(platform === 'darwin' ? ['/opt/homebrew/bin'] : []),
		'/usr/local/bin',
		'/usr/bin',
		'/bin',
		'/usr/sbin',
		'/sbin',
	]
	return [...new Set(dirs)].join(platform === 'win32' ? ';' : delimiter)
}

/** Variables the service passes through (paths only, never secrets). */
function serviceEnvironment(input: UnitInput) {
	const env = input.env ?? process.env
	return {
		PATH: servicePath({
			node: input.program.node,
			...(input.platform ? { platform: input.platform } : {}),
		}),
		[serviceEnvVar]: input.paths.manager,
		...(env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } : {}),
	}
}

function systemdQuote(value: string) {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
}

/** Path settings take the value literally (no quotes); only % is special. */
function systemdPath(value: string) {
	return value.replace(/[\n\r]/g, '').replace(/%/g, '%%')
}

export function systemdUnit(input: UnitInput) {
	const env = serviceEnvironment(input)
	return [
		'# Written by `kody daemon install`. Re-run it to repair; remove with `kody daemon uninstall`.',
		'[Unit]',
		`Description=Kody execution context ${input.contextName.replace(/[\n\r]/g, ' ')} (${input.ecid})`,
		'Documentation=https://kody.codes/docs/use/execution-contexts',
		'StartLimitIntervalSec=300',
		'StartLimitBurst=5',
		'',
		'[Service]',
		'Type=simple',
		`ExecStart=${[input.program.node, ...daemonArgs(input)].map(systemdQuote).join(' ')}`,
		`WorkingDirectory=${systemdPath(input.paths.workingDir)}`,
		...Object.entries(env).map(
			([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`,
		),
		'Restart=always',
		'RestartSec=10',
		`RestartPreventExitStatus=${stayStoppedExitCode}`,
		'TimeoutStopSec=90',
		`StandardOutput=append:${systemdPath(input.paths.logPath)}`,
		`StandardError=append:${systemdPath(input.paths.logPath)}`,
		'',
		'[Install]',
		'WantedBy=default.target',
		'',
	].join('\n')
}

function xml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

export function launchdPlist(input: UnitInput) {
	const env = serviceEnvironment(input)
	const strings = (values: Array<string>) =>
		values.map((value) => `\t\t<string>${xml(value)}</string>`).join('\n')
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`kody daemon install\`. Re-run it to repair; remove with \`kody daemon uninstall\`. -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xml(launchdLabel(input.ecid))}</string>
	<key>ProgramArguments</key>
	<array>
${strings([input.program.node, ...daemonArgs(input)])}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${Object.entries(env)
	.map(
		([key, value]) =>
			`\t\t<key>${xml(key)}</key>\n\t\t<string>${xml(value)}</string>`,
	)
	.join('\n')}
	</dict>
	<key>WorkingDirectory</key>
	<string>${xml(input.paths.workingDir)}</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>ExitTimeOut</key>
	<integer>90</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${xml(input.paths.logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(input.paths.logPath)}</string>
</dict>
</plist>
`
}

export function unitFor(input: UnitInput) {
	return input.paths.manager === 'systemd'
		? systemdUnit(input)
		: launchdPlist(input)
}

/** Program paths a unit file starts, so status can tell they still exist. */
export function programInUnit(text: string, manager: ServiceManager) {
	if (manager === 'systemd') {
		const line = text.split('\n').find((l) => l.startsWith('ExecStart='))
		const quoted = [...(line ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(
			(match) => match[1]!.replace(/\\(.)/g, '$1').replace(/%%/g, '%'),
		)
		return { node: quoted[0] ?? null, entry: quoted[1] ?? null }
	}
	const args = text.match(
		/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
	)
	const values = [
		...(args?.[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g),
	].map((match) =>
		match[1]!
			.replace(/&quot;/g, '"')
			.replace(/&gt;/g, '>')
			.replace(/&lt;/g, '<')
			.replace(/&amp;/g, '&'),
	)
	return { node: values[0] ?? null, entry: values[1] ?? null }
}

export type CommandRunner = (
	command: string,
	args: Array<string>,
) => { ok: boolean; stdout: string; stderr: string }

export const runCommand: CommandRunner = (command, args) => {
	try {
		const stdout = execFileSync(command, args, {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 30_000,
		})
		return { ok: true, stdout, stderr: '' }
	} catch (error) {
		const failed = error as {
			stdout?: string
			stderr?: string
			message?: string
		}
		return {
			ok: false,
			stdout: String(failed.stdout ?? ''),
			stderr: String(failed.stderr ?? failed.message ?? ''),
		}
	}
}

function uid() {
	return process.getuid?.() ?? userInfo().uid
}

function launchdTarget(ecid: string) {
	return `gui/${uid()}/${launchdLabel(ecid)}`
}

export type ServiceRuntimeState = {
	pid: number
	version: string
	service: ServiceManager | null
	startedAt: string
}

export type StoppedState = { reason: string; at: string }

function readJson<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as T
	} catch {
		return null
	}
}

export function writeJson(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

export type ServiceProblem = {
	code:
		| 'unsupported-platform'
		| 'running-as-root'
		| 'not-installed'
		| 'context-missing'
		| 'context-stopped'
		| 'unit-outdated'
		| 'program-missing'
		| 'ephemeral-program'
		| 'user-manager-unavailable'
		| 'linger-disabled'
		| 'linger-unknown'
		| 'not-enabled'
		| 'not-running'
		| 'restart-pending'
		| 'key-needs-passphrase'
	message: string
	fix: string | null
}

export type ServiceStatus = {
	supported: boolean
	manager: ServiceManager | null
	ecid: string | null
	installed: boolean
	enabled: boolean | null
	running: boolean
	pid: number | null
	runningVersion: string | null
	cliVersion: string
	unitPath: string | null
	logPath: string | null
	stopped: StoppedState | null
	problems: Array<ServiceProblem>
}

export function lingerCommand(user = userInfo().username) {
	return `sudo loginctl enable-linger ${user}`
}

function managerState(input: {
	manager: ServiceManager
	ecid: string
	run: CommandRunner
}) {
	if (input.manager === 'systemd') {
		const unit = `${serviceName(input.ecid)}.service`
		const shown = input.run('systemctl', [
			'--user',
			'show',
			unit,
			'--property=ActiveState,UnitFileState,MainPID',
		])
		const props = Object.fromEntries(
			shown.stdout
				.split('\n')
				.filter(Boolean)
				.map((line) => [
					line.slice(0, line.indexOf('=')),
					line.slice(line.indexOf('=') + 1),
				]),
		)
		const pid = Number(props.MainPID)
		return {
			reachable: shown.ok,
			enabled: props.UnitFileState === 'enabled',
			running:
				props.ActiveState === 'active' || props.ActiveState === 'activating',
			pid: Number.isInteger(pid) && pid > 0 ? pid : null,
		}
	}
	const printed = input.run('launchctl', ['print', launchdTarget(input.ecid)])
	const disabled = input.run('launchctl', ['print-disabled', `gui/${uid()}`])
	const pid = Number(printed.stdout.match(/\bpid = (\d+)/)?.[1])
	return {
		reachable: true,
		enabled:
			printed.ok &&
			!new RegExp(
				`"${launchdLabel(input.ecid).replace(/\./g, '\\.')}" => (true|disabled)`,
			).test(disabled.stdout),
		running: /\bstate = running\b/.test(printed.stdout),
		pid: Number.isInteger(pid) && pid > 0 ? pid : null,
	}
}

/** Everything `kody daemon status` reports, each problem with its fix. */
export function serviceStatus(input: {
	apiUrl: string
	ecid: string | null
	contextName?: string
	cliVersion: string
	expectedUnit?: string | null
	keyWrap?: 'keyring' | 'passphrase' | 'file' | null
	run?: CommandRunner
	platform?: NodeJS.Platform
	isRoot?: boolean
	fileExists?: (path: string) => boolean
	readText?: (path: string) => string | null
	/** Where temporary directories live; null skips that check (tests). */
	tmpDir?: string | null
}): ServiceStatus {
	const run = input.run ?? runCommand
	const exists = input.fileExists ?? existsSync
	const readText =
		input.readText ??
		((path: string) => {
			try {
				return readFileSync(path, 'utf8')
			} catch {
				return null
			}
		})
	const manager = serviceManagerFor(input.platform)
	const base: ServiceStatus = {
		supported: manager !== null,
		manager,
		ecid: input.ecid,
		installed: false,
		enabled: null,
		running: false,
		pid: null,
		runningVersion: null,
		cliVersion: input.cliVersion,
		unitPath: null,
		logPath: null,
		stopped: null,
		problems: [],
	}
	if (!manager) {
		base.problems.push({
			code: 'unsupported-platform',
			message: unsupportedPlatformMessage,
			fix: 'kody daemon',
		})
		return base
	}
	if (input.isRoot ?? uid() === 0) {
		base.problems.push({
			code: 'running-as-root',
			message:
				'You are running kody as root. Install the service as the user whose account should run the code, not root.',
			fix: null,
		})
	}
	if (!input.ecid) {
		base.problems.push({
			code: 'context-missing',
			message: 'This machine has no registered execution context.',
			fix: 'kody connect --name <name>',
		})
		return base
	}
	const paths = servicePaths({
		apiUrl: input.apiUrl,
		ecid: input.ecid,
		manager,
	})
	base.unitPath = paths.unitPath
	base.logPath = paths.logPath
	base.stopped = readJson<StoppedState>(paths.stoppedPath)
	const unitText = readText(paths.unitPath)
	base.installed = unitText !== null
	if (base.stopped) {
		base.problems.push({
			code: 'context-stopped',
			message: `The daemon stopped for good: ${base.stopped.reason} (${base.stopped.at}). Kody will not accept this machine key again.`,
			fix: 'kody daemon uninstall, then kody connect --name <name>',
		})
	}
	if (input.keyWrap === 'passphrase') {
		base.problems.push({
			code: 'key-needs-passphrase',
			message:
				'This context key is protected by a passphrase, which a background service cannot type. Switch it to a file key (600 permissions) for the service.',
			fix: 'kody daemon install --key-storage file',
		})
	}
	if (!base.installed) {
		base.problems.push({
			code: 'not-installed',
			message:
				'The background service is not installed, so the daemon stops with your terminal and does not start after a reboot.',
			fix: 'kody daemon install',
		})
		return base
	}
	const program = programInUnit(unitText!, manager)
	const missing = [program.node, program.entry].filter(
		(path) => !path || !exists(path),
	)
	if (missing.length > 0) {
		base.problems.push({
			code: 'program-missing',
			message: `The service starts a program that no longer exists (${missing.join(', ') || 'unreadable unit'}), for example after a Node.js upgrade.`,
			fix: 'kody daemon install',
		})
	}
	const ephemeral = program.entry
		? ephemeralRuntimeReason(program.entry, input.tmpDir)
		: null
	if (ephemeral) {
		base.problems.push({
			code: 'ephemeral-program',
			message: `The service starts kody from ${ephemeral}, which does not survive.`,
			fix: 'npm install -g @kodycodes/cli && kody daemon install',
		})
	}
	if (input.expectedUnit && input.expectedUnit !== unitText) {
		base.problems.push({
			code: 'unit-outdated',
			message: `The service file differs from what this kody ${input.cliVersion} writes.`,
			fix: 'kody daemon install',
		})
	}
	const state = managerState({ manager, ecid: input.ecid, run })
	if (manager === 'systemd') {
		if (!state.reachable) {
			base.problems.push({
				code: 'user-manager-unavailable',
				message:
					'systemctl --user is not reachable. The service needs a systemd user manager (log in once as this user, or enable lingering).',
				fix: lingerCommand(),
			})
		}
		const linger = run('loginctl', [
			'show-user',
			userInfo().username,
			'--property=Linger',
			'--value',
		])
		const value = linger.stdout.trim()
		if (value === 'no') {
			base.problems.push({
				code: 'linger-disabled',
				message:
					'Lingering is off: the daemon stops when you log out and does not start at boot until you log in. An administrator can turn it on (do not run kody itself with sudo).',
				fix: lingerCommand(),
			})
		} else if (value !== 'yes') {
			base.problems.push({
				code: 'linger-unknown',
				message: 'Could not read whether lingering is on (loginctl failed).',
				fix: `loginctl show-user ${userInfo().username} --property=Linger`,
			})
		}
	}
	base.enabled = state.enabled
	base.running = state.running
	base.pid = state.pid
	if (!state.enabled && !base.stopped) {
		base.problems.push({
			code: 'not-enabled',
			message:
				'The service is installed but not enabled, so it will not start at boot or login.',
			fix: 'kody daemon install',
		})
	}
	if (!state.running && !base.stopped) {
		base.problems.push({
			code: 'not-running',
			message: 'The service is not running.',
			fix: 'kody daemon restart (and kody daemon logs to see why it stopped)',
		})
	}
	const runtime = readJson<ServiceRuntimeState>(paths.statePath)
	if (
		state.running &&
		runtime &&
		(state.pid === null || runtime.pid === state.pid)
	) {
		base.runningVersion = runtime.version
		// Auto-update may run a newer version than the installed CLI: that is fine.
		if (compareVersions(runtime.version, input.cliVersion) < 0) {
			base.problems.push({
				code: 'restart-pending',
				message: `The service runs kody ${runtime.version}; this CLI is ${input.cliVersion}.`,
				fix: 'kody daemon install',
			})
		}
	}
	return base
}

export function formatServiceStatus(
	status: ServiceStatus,
	contextName?: string,
) {
	const lines = [
		`Kody daemon service${contextName ? ` for ${contextName}` : ''}${status.ecid ? ` (${status.ecid})` : ''}`,
	]
	if (status.supported) {
		lines.push(
			`  Status: ${
				!status.installed
					? 'not installed'
					: status.running
						? `running${status.pid ? ` (pid ${status.pid})` : ''}${status.runningVersion ? `, kody ${status.runningVersion}` : ''}`
						: status.stopped
							? 'stopped for good'
							: 'not running'
			}`,
		)
		if (status.installed) {
			lines.push(
				`  Manager: ${status.manager}${status.enabled ? ', starts at boot/login' : ''}`,
			)
		}
		if (status.unitPath && status.installed)
			lines.push(`  Unit: ${status.unitPath}`)
		if (status.logPath && status.installed)
			lines.push(`  Logs: ${status.logPath} (kody daemon logs)`)
	}
	if (status.problems.length === 0) lines.push('  No problems found.')
	for (const problem of status.problems) {
		lines.push(`  [${problem.code}] ${problem.message}`)
		if (problem.fix) lines.push(`    Fix: ${problem.fix}`)
	}
	return lines.join('\n')
}

export type InstallResult = {
	changed: boolean
	restarted: boolean
	warnings: Array<string>
}

/** Writes the unit and (re)starts it. Running it again repairs the service. */
export function installService(input: {
	unit: string
	paths: ServicePaths
	ecid: string
	restart: boolean
	run?: CommandRunner
}): InstallResult {
	const run = input.run ?? runCommand
	const warnings: Array<string> = []
	let previous: string | null = null
	try {
		previous = readFileSync(input.paths.unitPath, 'utf8')
	} catch {}
	const changed = previous !== input.unit
	mkdirSync(dirname(input.paths.unitPath), { recursive: true })
	mkdirSync(input.paths.workingDir, { recursive: true, mode: 0o700 })
	if (changed) writeFileSync(input.paths.unitPath, input.unit, { mode: 0o644 })
	rmSync(input.paths.stoppedPath, { force: true })
	const must = (command: string, args: Array<string>, what: string) => {
		const result = run(command, args)
		if (!result.ok) {
			throw new Error(
				`Could not ${what}: ${command} ${args.join(' ')} failed. ${result.stderr.trim()}`,
			)
		}
		return result
	}
	if (input.paths.manager === 'systemd') {
		const unit = `${serviceName(input.ecid)}.service`
		must('systemctl', ['--user', 'daemon-reload'], 'reload systemd')
		must('systemctl', ['--user', 'enable', unit], 'enable the service')
		run('systemctl', ['--user', 'reset-failed', unit])
		const active =
			run('systemctl', ['--user', 'is-active', unit]).stdout.trim() === 'active'
		if (!active)
			must('systemctl', ['--user', 'start', unit], 'start the service')
		else if (changed || input.restart)
			must('systemctl', ['--user', 'restart', unit], 'restart the service')
		return {
			changed,
			restarted: active && (changed || input.restart),
			warnings,
		}
	}
	const target = launchdTarget(input.ecid)
	const loaded = run('launchctl', ['print', target]).ok
	run('launchctl', ['enable', target])
	if (loaded && !changed) {
		if (input.restart)
			must('launchctl', ['kickstart', '-k', target], 'restart the service')
		return { changed, restarted: input.restart, warnings }
	}
	if (loaded) run('launchctl', ['bootout', target])
	const booted = run('launchctl', [
		'bootstrap',
		`gui/${uid()}`,
		input.paths.unitPath,
	])
	if (!booted.ok) {
		warnings.push(
			`launchctl bootstrap failed (${booted.stderr.trim()}). Over SSH with nobody logged in at the Mac, the service starts at the next login.`,
		)
	}
	return { changed, restarted: loaded, warnings }
}

export function restartService(input: {
	manager: ServiceManager
	ecid: string
	run?: CommandRunner
}) {
	const run = input.run ?? runCommand
	const result =
		input.manager === 'systemd'
			? (run('systemctl', [
					'--user',
					'reset-failed',
					`${serviceName(input.ecid)}.service`,
				]),
				run('systemctl', [
					'--user',
					'restart',
					`${serviceName(input.ecid)}.service`,
				]))
			: run('launchctl', ['kickstart', '-k', launchdTarget(input.ecid)])
	if (!result.ok)
		throw new Error(`Could not restart the service: ${result.stderr.trim()}`)
}

export function startService(input: {
	manager: ServiceManager
	ecid: string
	run?: CommandRunner
}) {
	const run = input.run ?? runCommand
	const unit = `${serviceName(input.ecid)}.service`
	const result =
		input.manager === 'systemd'
			? (run('systemctl', ['--user', 'reset-failed', unit]),
				run('systemctl', ['--user', 'start', unit]))
			: (run('launchctl', ['enable', launchdTarget(input.ecid)]),
				run('launchctl', ['kickstart', launchdTarget(input.ecid)]))
	if (!result.ok)
		throw new Error(`Could not start the service: ${result.stderr.trim()}`)
}

/** Stops the service until the next login or boot (SIGTERM drains runs first). */
export function stopService(input: {
	manager: ServiceManager
	ecid: string
	run?: CommandRunner
}) {
	const run = input.run ?? runCommand
	const result =
		input.manager === 'systemd'
			? run('systemctl', [
					'--user',
					'stop',
					`${serviceName(input.ecid)}.service`,
				])
			: run('launchctl', ['kill', 'SIGTERM', launchdTarget(input.ecid)])
	if (!result.ok)
		throw new Error(`Could not stop the service: ${result.stderr.trim()}`)
}

export function uninstallService(input: {
	paths: ServicePaths
	ecid: string
	run?: CommandRunner
}) {
	const run = input.run ?? runCommand
	if (input.paths.manager === 'systemd') {
		const unit = `${serviceName(input.ecid)}.service`
		run('systemctl', ['--user', 'disable', '--now', unit])
		rmSync(input.paths.unitPath, { force: true })
		run('systemctl', ['--user', 'daemon-reload'])
		run('systemctl', ['--user', 'reset-failed', unit])
	} else {
		run('launchctl', ['bootout', launchdTarget(input.ecid)])
		rmSync(input.paths.unitPath, { force: true })
	}
}

/**
 * Called by a service daemon Kody refused for good: keep it from starting at
 * the next boot or login. The exit code already stops the immediate restart.
 */
export function disableOwnService(input: {
	manager: ServiceManager
	ecid: string
	run?: CommandRunner
}) {
	const run = input.run ?? runCommand
	if (input.manager === 'systemd') {
		run('systemctl', [
			'--user',
			'disable',
			`${serviceName(input.ecid)}.service`,
		])
	} else {
		run('launchctl', ['disable', launchdTarget(input.ecid)])
	}
}

/** Keeps the service log bounded: copy-truncate, since the manager holds it open. */
export function rotateLog(path: string, maxBytes = 10 * 1024 * 1024) {
	try {
		const text = readFileSync(path)
		if (text.byteLength <= maxBytes) return
		writeFileSync(`${path}.1`, text, { mode: 0o600 })
		writeFileSync(path, '', { mode: 0o600 })
	} catch {}
}
