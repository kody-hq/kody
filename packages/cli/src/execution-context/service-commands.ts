import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import {
	contextsDir,
	fileWrappingKey,
	loadContext,
	readStoredContext,
	rewrapContextKey,
	storedKeyWrap,
	wrappingKeyForStoredContext,
	type WrappingKeySource,
} from './keystore.js'
import {
	type CommandRunner,
	type ServiceManager,
	type ServiceRuntimeState,
	currentProgram,
	ephemeralRuntimeReason,
	formatServiceStatus,
	installService,
	lingerCommand,
	npxRefusal,
	restartService,
	runCommand,
	serviceManagerFor,
	servicePaths,
	serviceStatus,
	uninstallService,
	unitFor,
	unsupportedPlatformMessage,
} from './service.js'

export type ServiceCommandEnv = {
	apiUrl: string
	clientVersion: string
	write: (text: string) => void
	json?: boolean
	yes?: boolean
	/** Asks a yes/no question. Absent when stdin is not a terminal. */
	confirm?: ((question: string, defaultYes: boolean) => Promise<boolean>) | null
	run?: CommandRunner
	platform?: NodeJS.Platform
	isRoot?: boolean
	entryPath?: string
	nodePath?: string
	/** Temporary directory root; null skips that check (tests). */
	tmpDir?: string | null
	/** How long install waits for the service to report it is up. */
	startupWaitMs?: number
}

export function terminalConfirm() {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return null
	return async (question: string, defaultYes: boolean) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout })
		try {
			const answer = await new Promise<string>((resolve) =>
				rl.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `, (line) =>
					resolve(line.trim().toLowerCase()),
				),
			)
			if (!answer) return defaultYes
			return answer === 'y' || answer === 'yes'
		} finally {
			rl.close()
		}
	}
}

export function storedContextIds(apiUrl: string) {
	try {
		return readdirSync(contextsDir(apiUrl))
			.filter((entry) => entry.startsWith('ec_'))
			.sort()
	} catch {
		return []
	}
}

/** `--context` (id or local name), else the only context on this machine. */
export function localContextId(apiUrl: string, ref?: string) {
	const ids = storedContextIds(apiUrl)
	if (!ref) return ids[0] ?? null
	if (ids.includes(ref)) return ref
	return ids.find((id) => readStoredContext(apiUrl, id)?.name === ref) ?? null
}

function program(env: ServiceCommandEnv) {
	const current = currentProgram(env.clientVersion)
	return {
		...current,
		...(env.entryPath ? { entry: env.entryPath } : {}),
		...(env.nodePath ? { node: env.nodePath } : {}),
	}
}

function ephemeral(env: ServiceCommandEnv) {
	return ephemeralRuntimeReason(
		program(env).entry,
		...(env.tmpDir === undefined ? [] : [env.tmpDir]),
	)
}

function isRoot(env: ServiceCommandEnv) {
	return env.isRoot ?? process.getuid?.() === 0
}

export function maxConcurrentInUnit(text: string | null) {
	const match = text?.match(
		/--max-concurrent(?:"?\s+"?|<\/string>\s*<string>)(\d+)/,
	)
	return match ? Number(match[1]) : undefined
}

function readText(path: string) {
	try {
		return readFileSync(path, 'utf8')
	} catch {
		return null
	}
}

function expectedUnit(
	env: ServiceCommandEnv,
	ecid: string,
	manager: ServiceManager,
	maxConcurrent?: number,
) {
	const paths = servicePaths({ apiUrl: env.apiUrl, ecid, manager })
	const existing = readText(paths.unitPath)
	const context = readStoredContext(env.apiUrl, ecid)
	const concurrent = maxConcurrent ?? maxConcurrentInUnit(existing)
	return {
		paths,
		existing,
		unit: unitFor({
			ecid,
			contextName: context?.name ?? ecid,
			apiUrl: env.apiUrl,
			program: program(env),
			paths,
			...(concurrent === undefined ? {} : { maxConcurrent: concurrent }),
			...(env.platform ? { platform: env.platform } : {}),
		}),
	}
}

function runtimeState(path: string) {
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as ServiceRuntimeState
	} catch {
		return null
	}
}

/**
 * Makes sure a background service can unwrap the machine key with nobody
 * there to type a passphrase or unlock a keyring.
 */
async function ensureServiceKey(
	env: ServiceCommandEnv,
	ecid: string,
	keyStorage?: string,
) {
	const wrap = storedKeyWrap(env.apiUrl, ecid)
	if (wrap === 'file') return
	if (wrap === 'passphrase' && keyStorage === 'keyring') {
		throw new Error(
			'A passphrase-protected context cannot run as a service with --key-storage keyring. Re-run with --key-storage file.',
		)
	}
	if (
		keyStorage !== undefined &&
		keyStorage !== 'file' &&
		keyStorage !== 'keyring'
	) {
		throw new Error('--key-storage must be keyring or file.')
	}
	let current: WrappingKeySource
	try {
		current = wrappingKeyForStoredContext({ apiUrl: env.apiUrl, ecid })
		loadContext({ apiUrl: env.apiUrl, ecid, wrapping: current })
	} catch (error) {
		throw new Error(
			`Could not unlock this machine's execution context key: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	const linux = (env.platform ?? process.platform) === 'linux'
	let toFile = keyStorage === 'file'
	if (!toFile && keyStorage !== 'keyring' && (wrap === 'passphrase' || linux)) {
		const why =
			wrap === 'passphrase'
				? 'This context key is protected by a passphrase, which a background service cannot type.'
				: 'On Linux the login keyring is usually locked until you log in, so after a reboot the service could not unlock its key.'
		const question = `${why}\nStore a separate file key instead (only readable by your user, 600 permissions, in the kody state directory)?`
		// --yes only consents for a passphrase key, which a service cannot use;
		// a working keyring stays unless --key-storage file is passed.
		toFile = env.yes
			? wrap === 'passphrase'
			: env.confirm
				? await env.confirm(question, true)
				: wrap === 'passphrase'
		if (!toFile && wrap === 'passphrase') {
			throw new Error(
				`${why} Re-run with --key-storage file, or keep running \`kody daemon\` in a terminal.`,
			)
		}
		if (!toFile) {
			env.write(
				'Keeping the OS keyring. If the service cannot unlock it after a reboot, run: kody daemon install --key-storage file\n',
			)
		}
	}
	if (!toFile) return
	rewrapContextKey({
		apiUrl: env.apiUrl,
		ecid,
		from: current,
		to: fileWrappingKey({ apiUrl: env.apiUrl, ecid, create: true }),
	})
	env.write(
		'Moved the context key to a file key (600 permissions) the service can read.\n',
	)
}

export async function installDaemonService(
	env: ServiceCommandEnv,
	input: { ecid: string; maxConcurrent?: number; keyStorage?: string },
) {
	const manager = serviceManagerFor(env.platform)
	if (!manager) throw new Error(unsupportedPlatformMessage)
	if (isRoot(env)) {
		throw new Error(
			'Refusing to install the kody daemon service as root. Run `kody daemon install` as the user whose account should run the code, without sudo.',
		)
	}
	const how = ephemeral(env)
	if (how) throw new Error(npxRefusal(how))
	if (!readStoredContext(env.apiUrl, input.ecid)) {
		throw new Error(
			`No execution context ${input.ecid} is registered on this machine. Run \`kody connect --name <name>\`.`,
		)
	}
	await ensureServiceKey(env, input.ecid, input.keyStorage)
	const { paths, unit } = expectedUnit(
		env,
		input.ecid,
		manager,
		input.maxConcurrent,
	)
	const before = runtimeState(paths.statePath)
	const result = installService({
		unit,
		paths,
		ecid: input.ecid,
		restart: before !== null && before.version !== env.clientVersion,
		...(env.run ? { run: env.run } : {}),
	})
	for (const warning of result.warnings) env.write(`${warning}\n`)
	const started = await waitForStart(env, paths.statePath, before)
	const status = serviceStatus({
		apiUrl: env.apiUrl,
		ecid: input.ecid,
		cliVersion: env.clientVersion,
		expectedUnit: unit,
		keyWrap: storedKeyWrap(env.apiUrl, input.ecid),
		...(env.run ? { run: env.run } : {}),
		...(env.platform ? { platform: env.platform } : {}),
		isRoot: false,
		...(env.tmpDir === undefined ? {} : { tmpDir: env.tmpDir }),
	})
	const name = readStoredContext(env.apiUrl, input.ecid)?.name
	env.write(
		`${result.changed ? 'Installed' : 'Checked'} the kody daemon service for ${name ?? input.ecid} (${manager}).${result.restarted ? ' Restarted it onto this version.' : ''}\n`,
	)
	if (!started) {
		env.write(
			`The service has not reported in yet. Recent log lines (${paths.logPath}):\n${tail(paths.logPath, 15) || '  (empty)'}\n`,
		)
	}
	env.write(`${formatServiceStatus(status, name)}\n`)
	return { ...status, started, ok: started && status.running }
}

async function waitForStart(
	env: ServiceCommandEnv,
	statePath: string,
	before: ServiceRuntimeState | null,
) {
	const deadline = Date.now() + (env.startupWaitMs ?? 10_000)
	while (Date.now() < deadline) {
		const state = runtimeState(statePath)
		if (
			state &&
			state.version === env.clientVersion &&
			(!before ||
				state.pid !== before.pid ||
				state.startedAt !== before.startedAt)
		) {
			return true
		}
		await sleep(250)
	}
	return env.startupWaitMs === 0
}

function tail(path: string, lines: number) {
	const text = readText(path)
	if (!text) return ''
	return text.trimEnd().split('\n').slice(-lines).join('\n')
}

/** `kody daemon install|status|logs|restart|uninstall`. */
export async function runDaemonServiceCommand(
	env: ServiceCommandEnv,
	input: {
		sub: string
		context?: string
		maxConcurrent?: number
		keyStorage?: string
		lines?: string
		follow?: boolean
		unregister?: boolean
		revoke: (ecid: string) => Promise<void>
	},
): Promise<number> {
	const ecid = localContextId(env.apiUrl, input.context)
	const manager = serviceManagerFor(env.platform)
	if (input.sub === 'status') {
		const status = serviceStatus({
			apiUrl: env.apiUrl,
			ecid,
			cliVersion: env.clientVersion,
			expectedUnit:
				ecid && manager && !ephemeral(env)
					? expectedUnit(env, ecid, manager).unit
					: null,
			keyWrap: ecid ? storedKeyWrap(env.apiUrl, ecid) : null,
			...(env.run ? { run: env.run } : {}),
			...(env.platform ? { platform: env.platform } : {}),
			isRoot: isRoot(env),
			...(env.tmpDir === undefined ? {} : { tmpDir: env.tmpDir }),
		})
		const name = ecid ? readStoredContext(env.apiUrl, ecid)?.name : undefined
		env.write(
			env.json
				? `${JSON.stringify({ ...status, contextName: name ?? null }, null, 2)}\n`
				: `${formatServiceStatus(status, name)}\n`,
		)
		return status.problems.length === 0 ? 0 : 1
	}
	if (!manager) throw new Error(unsupportedPlatformMessage)
	if (!ecid) {
		throw new Error(
			input.context
				? `No execution context ${input.context} is registered on this machine.`
				: 'This machine has no registered execution context. Run `kody connect --name <name>`.',
		)
	}
	const paths = servicePaths({ apiUrl: env.apiUrl, ecid, manager })
	if (input.sub === 'install') {
		const status = await installDaemonService(env, {
			ecid,
			...(input.maxConcurrent === undefined
				? {}
				: { maxConcurrent: input.maxConcurrent }),
			...(input.keyStorage ? { keyStorage: input.keyStorage } : {}),
		})
		return status.ok ? 0 : 1
	}
	if (input.sub === 'logs') {
		if (!existsSync(paths.logPath)) {
			env.write(
				`No service log yet at ${paths.logPath}. Install the service with: kody daemon install\n`,
			)
			return 1
		}
		const lines = input.lines ? Number(input.lines) : 100
		if (!Number.isInteger(lines) || lines < 1)
			throw new Error('--lines must be a positive whole number.')
		if (input.follow) {
			const child = spawn('tail', ['-n', String(lines), '-F', paths.logPath], {
				stdio: 'inherit',
			})
			return await new Promise<number>((resolve) => {
				const stop = () => child.kill('SIGTERM')
				process.once('SIGINT', stop)
				child.on('exit', () => resolve(0))
			})
		}
		env.write(`${tail(paths.logPath, lines)}\n`)
		return 0
	}
	if (!existsSync(paths.unitPath)) {
		throw new Error(
			'The kody daemon service is not installed. Install it with: kody daemon install',
		)
	}
	if (input.sub === 'restart') {
		const before = runtimeState(paths.statePath)
		restartService({ manager, ecid, ...(env.run ? { run: env.run } : {}) })
		env.write(
			'Restarting the kody daemon service. Runs in flight finish first.\n',
		)
		if (
			await waitForStart(
				{ ...env, clientVersion: before?.version ?? env.clientVersion },
				paths.statePath,
				before,
			)
		) {
			env.write('The service is back up.\n')
		}
		return 0
	}
	if (input.sub === 'uninstall') {
		uninstallService({ paths, ecid, ...(env.run ? { run: env.run } : {}) })
		env.write(
			`Removed the kody daemon service for ${ecid}. The context stays registered.\n`,
		)
		const unregister =
			input.unregister ??
			(env.confirm
				? await env.confirm(
						`Also revoke ${ecid} in Kody so this machine can no longer run code?`,
						false,
					)
				: false)
		if (unregister) {
			await input.revoke(ecid)
			env.write(
				`Revoked ${ecid}. Delete it for good with: kody context delete ${ecid}\n`,
			)
		} else {
			env.write(
				`To stop Kody from routing runs here, revoke it with: kody context revoke ${ecid}\n`,
			)
		}
		return 0
	}
	throw new Error(
		'Usage: kody daemon [install | status [--json] | logs [--lines <n>] [--follow] | restart | uninstall [--unregister]]',
	)
}

/** After `kody context register`: offer the service (default yes). */
export async function offerInstall(
	env: ServiceCommandEnv,
	input: {
		ecid: string
		install?: boolean
		keyStorage?: string
		maxConcurrent?: number
	},
) {
	const manager = serviceManagerFor(env.platform)
	if (input.install === false) return false
	if (!manager || ephemeral(env) || isRoot(env)) {
		if (input.install) {
			if (!manager) throw new Error(unsupportedPlatformMessage)
			const how = ephemeral(env)
			if (how) throw new Error(npxRefusal(how))
			throw new Error('Refusing to install the kody daemon service as root.')
		}
		if (!manager) env.write(`${unsupportedPlatformMessage}\n`)
		else if (!isRoot(env)) {
			env.write(
				'To keep it running after reboots, install the CLI globally (npm install -g @kodycodes/cli) and run: kody daemon install\n',
			)
		}
		return false
	}
	const yes =
		input.install ??
		(env.yes
			? true
			: env.confirm
				? await env.confirm(
						'Run it as a background service that starts at boot and restarts after crashes?',
						true,
					)
				: false)
	if (!yes) {
		env.write(
			'Start it with: kody daemon (or keep it running with: kody daemon install)\n',
		)
		return false
	}
	const status = await installDaemonService(env, {
		ecid: input.ecid,
		...(input.keyStorage ? { keyStorage: input.keyStorage } : {}),
		...(input.maxConcurrent === undefined
			? {}
			: { maxConcurrent: input.maxConcurrent }),
	})
	return status.ok
}

/** After `kody context revoke|delete`: remove this machine's service for it. */
export async function offerUninstallAfterRevoke(
	env: ServiceCommandEnv,
	input: { ref: string; ecid?: string | null },
) {
	const manager = serviceManagerFor(env.platform)
	if (!manager) return
	const ecid = input.ecid ?? localContextId(env.apiUrl, input.ref)
	if (!ecid) return
	const paths = servicePaths({ apiUrl: env.apiUrl, ecid, manager })
	if (!existsSync(paths.unitPath)) return
	const yes = env.yes
		? true
		: env.confirm
			? await env.confirm(
					'This machine runs it as a background service. Remove the service?',
					true,
				)
			: true
	if (!yes) {
		env.write(
			'The service will stop on its own and stay stopped. Remove it later with: kody daemon uninstall\n',
		)
		return
	}
	uninstallService({ paths, ecid, ...(env.run ? { run: env.run } : {}) })
	env.write(`Removed the kody daemon service for ${ecid}.\n`)
}

/**
 * `kody update`: install the latest CLI globally, then let the new CLI
 * repair each installed service, which restarts it after runs in flight
 * finish.
 */
export async function runUpdate(env: ServiceCommandEnv) {
	const how = ephemeral(env)
	if (how) {
		env.write(
			`This kody runs from ${how}, which always fetches the latest version. For a background service, install it globally:\n  npm install -g @kodycodes/cli\n`,
		)
		return 0
	}
	env.write('Installing the latest @kodycodes/cli globally...\n')
	const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
	const installed = spawnSync(npm, ['install', '-g', '@kodycodes/cli@latest'], {
		stdio: 'inherit',
		shell: process.platform === 'win32',
	})
	if (installed.status !== 0) {
		throw new Error(
			`npm install -g @kodycodes/cli@latest failed${installed.error ? ` (${installed.error.message})` : ''}. Fix the npm error above and run \`kody update\` again.`,
		)
	}
	const manager = serviceManagerFor(env.platform)
	const services = manager
		? storedContextIds(env.apiUrl).filter((ecid) =>
				existsSync(
					servicePaths({ apiUrl: env.apiUrl, ecid, manager }).unitPath,
				),
			)
		: []
	let restarted = 0
	for (const ecid of services) {
		const repaired = spawnSync(
			process.execPath,
			[
				program(env).entry,
				'daemon',
				'install',
				'--context',
				ecid,
				'--api-url',
				env.apiUrl,
				'--yes',
			],
			{ stdio: 'inherit' },
		)
		if (repaired.status === 0) restarted++
		else
			env.write(
				`Could not restart the service for ${ecid}. Check it with: kody daemon status --context ${ecid}\n`,
			)
	}
	const version = spawnSync(process.execPath, [program(env).entry, 'version'], {
		encoding: 'utf8',
	}).stdout.trim()
	env.write(
		`kody is now ${version || 'up to date'}.${restarted === 0 ? '' : ` Restarted ${restarted} service(s) onto it.`}\n`,
	)
	return restarted === services.length ? 0 : 1
}

export { lingerCommand, runCommand }
