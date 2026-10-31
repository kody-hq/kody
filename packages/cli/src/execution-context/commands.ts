import { readFileSync, rmSync, unwatchFile, watchFile } from 'node:fs'
import { cpus, platform, totalmem } from 'node:os'
import {
	ed25519JwkThumbprint,
	ecpMaxConcurrentRunsCap,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import {
	apiJson,
	fetchServerKeys,
	generateContextKey,
	importContextKey,
	registerContext,
	setContextCommands,
	experimentOffError,
	isExperimentOffError,
} from './client.js'
import {
	type CurrentVersion,
	autoUpdateSetting,
	newerInstalledVersion,
	relaunchExitCode,
	startupRefusedExitCode,
	startDaemonUpdater,
	superviseNewerVersion,
	supervisedEnvVar,
} from './auto-update.js'
import { runDaemon } from './daemon.js'
import {
	type RunnerLauncher,
	acquireRunnerLock,
	describeHolder,
	launcherEnvVar,
	lockPathFor,
	otherLocalDaemons,
} from './runner-lock.js'
import { HostCommands } from './host-commands.js'
import { createPackageGraphCache } from './package-graph-cache.js'
import {
	type FsMode,
	allowLocalPath,
	effectiveFs,
	localPolicyPath,
	readLocalCommandsEnabled,
	readLocalPolicy,
	removeLocalPath,
	setLocalCommandsEnabled,
} from './fs-access.js'
import {
	contextWorkersDir,
	loadContext,
	fileWrappingKey,
	resolveWrappingKey,
	saveContext,
	wrappingKeyForStoredContext,
} from './keystore.js'
import {
	type ServiceCommandEnv,
	localContextId,
	offerInstall,
	offerUninstallAfterRevoke,
	runAutoUpdateCommand,
	runDaemonServiceCommand,
	runUpdate,
	storedContextIds,
	terminalConfirm,
} from './service-commands.js'
import {
	disableOwnService,
	rotateLog,
	serviceEnvVar,
	serviceManagerFor,
	servicePaths,
	stayStoppedExitCode,
	writeJson,
} from './service.js'
import {
	createLocalWorkerTracker,
	reapLeftoverWorkers,
} from './worker-tracker.js'

export type ExecutionContextCommandInput = {
	command: 'context' | 'chain' | 'daemon' | 'connect' | 'update'
	positionals: Array<string>
	values: {
		name?: string
		context?: string
		mode?: string
		json?: boolean
		maxConcurrent?: string
		yes?: boolean
		/** true: --install, false: --no-install, undefined: ask. */
		install?: boolean
		keyStorage?: string
		lines?: string
		follow?: boolean
		unregister?: boolean
	}
	apiUrl: string
	org?: string
	token: () => Promise<string>
	clientVersion: string
	write: (text: string) => void
	fetchFn?: typeof fetch
	/** Overrides for tests: prompts, service manager commands, platform. */
	service?: Partial<ServiceCommandEnv>
}

export const defaultMaxConcurrentRuns = 2

/** `--max-concurrent` or KODY_CONTEXT_MAX_CONCURRENT, 1..ecpMaxConcurrentRunsCap. */
export function maxConcurrentRuns(
	value: string | undefined = process.env.KODY_CONTEXT_MAX_CONCURRENT,
) {
	if (value === undefined || value === '') return defaultMaxConcurrentRuns
	const parsed = Number(value)
	if (
		!Number.isInteger(parsed) ||
		parsed < 1 ||
		parsed > ecpMaxConcurrentRunsCap
	) {
		throw new Error(
			`--max-concurrent (or KODY_CONTEXT_MAX_CONCURRENT) must be a whole number from 1 to ${ecpMaxConcurrentRunsCap}; got ${value}.`,
		)
	}
	return parsed
}

export function localCapabilities(
	maxConcurrent: number = defaultMaxConcurrentRuns,
) {
	return {
		runtime: 'workerd',
		node: process.versions.node,
		os: platform(),
		cpuCount: cpus().length,
		memoryMb: Math.round(totalmem() / (1024 * 1024)),
		maxConcurrent,
		features: [],
	}
}

function out(
	input: ExecutionContextCommandInput,
	value: unknown,
	text: string,
) {
	input.write(
		input.values.json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`,
	)
}

export async function runExecutionContextCommand(
	input: ExecutionContextCommandInput,
): Promise<number> {
	try {
		return await runCommand(input)
	} catch (error) {
		if (isExperimentOffError(error)) throw experimentOffError(input.apiUrl)
		throw error
	}
}

async function runCommand(
	input: ExecutionContextCommandInput,
): Promise<number> {
	const [sub, ...rest] = input.positionals
	const base = {
		apiUrl: input.apiUrl,
		...(input.org ? { org: input.org } : {}),
		...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
	}
	if (input.command === 'context' && sub === 'commands') {
		return await runCommandsOptInCommand(input, rest)
	}
	if (input.command === 'context' && sub === 'policy') {
		return await runPolicyCommand(input, rest)
	}
	const serviceEnv: ServiceCommandEnv = {
		apiUrl: input.apiUrl,
		clientVersion: input.clientVersion,
		write: input.write,
		...(input.values.json ? { json: true } : {}),
		...(input.values.yes ? { yes: true } : {}),
		confirm: input.values.json ? null : terminalConfirm(),
		...input.service,
	}
	const maxConcurrentFlag = () => {
		if (input.values.maxConcurrent === '') {
			throw new Error('--max-concurrent needs a value.')
		}
		return input.values.maxConcurrent === undefined
			? undefined
			: maxConcurrentRuns(input.values.maxConcurrent)
	}
	if (input.command === 'update') return await runUpdate(serviceEnv)
	if (input.command === 'daemon' && sub === 'auto-update') {
		return await runAutoUpdateCommand(serviceEnv, rest[0])
	}
	if (input.command === 'daemon' && sub !== undefined) {
		const maxConcurrent = maxConcurrentFlag()
		return await runDaemonServiceCommand(serviceEnv, {
			sub,
			...(input.values.context ? { context: input.values.context } : {}),
			...(maxConcurrent === undefined ? {} : { maxConcurrent }),
			...(input.values.keyStorage
				? { keyStorage: input.values.keyStorage }
				: {}),
			...(input.values.lines ? { lines: input.values.lines } : {}),
			...(input.values.follow ? { follow: true } : {}),
			...(input.values.unregister === undefined
				? {}
				: { unregister: input.values.unregister }),
			revoke: async (ecid) => {
				await apiJson({
					...base,
					token: await input.token(),
					method: 'DELETE',
					path: `/v1/execution-contexts/${encodeURIComponent(ecid)}`,
				})
			},
		})
	}
	if (
		input.command === 'connect' &&
		!input.values.name &&
		!sub &&
		localContextId(input.apiUrl, input.values.context)
	) {
		const ecid = localContextId(input.apiUrl, input.values.context)!
		input.write(`This machine is already registered as ${ecid}.\n`)
		const maxConcurrent = maxConcurrentFlag()
		await offerInstall(serviceEnv, {
			ecid,
			install: input.values.install ?? true,
			...(input.values.keyStorage
				? { keyStorage: input.values.keyStorage }
				: {}),
			...(maxConcurrent === undefined ? {} : { maxConcurrent }),
		})
		return 0
	}
	if (
		(input.command === 'context' && sub === 'register') ||
		input.command === 'connect'
	) {
		const connect = input.command === 'connect'
		const name = input.values.name ?? (connect ? sub : rest[0])
		if (!name) throw new Error('Pass --name <name> for this machine.')
		const maxConcurrent = maxConcurrentFlag()
		if (
			input.values.keyStorage !== undefined &&
			input.values.keyStorage !== 'file' &&
			input.values.keyStorage !== 'keyring'
		) {
			throw new Error('--key-storage must be keyring or file.')
		}
		const wrappingFor = async (ecid: string) => {
			if (input.values.keyStorage === 'file') {
				return fileWrappingKey({ apiUrl: input.apiUrl, ecid, create: true })
			}
			try {
				const source = resolveWrappingKey({ ecid, create: true })
				if (source.kind === 'keyring') source.key(Buffer.alloc(16))
				return source
			} catch (error) {
				if (input.values.keyStorage === 'keyring') throw error
				const question = `No unlocked OS keyring is available (${error instanceof Error ? error.message : String(error)}).\nStore the machine key wrapping key in a file instead (only readable by your user, 600 permissions, in the kody state directory)?`
				const useFile = serviceEnv.yes
					? true
					: serviceEnv.confirm
						? await serviceEnv.confirm(question, true)
						: false
				if (!useFile) {
					throw new Error(
						`${error instanceof Error ? error.message : String(error)} Or re-run with --key-storage file.`,
					)
				}
				return fileWrappingKey({ apiUrl: input.apiUrl, ecid, create: true })
			}
		}
		const { publicKeyJwk, privateKeyJwk } = await generateContextKey()
		const privateKey = await importContextKey(privateKeyJwk)
		const thumbprint = await ed25519JwkThumbprint(publicKeyJwk)
		const registered = await registerContext({
			...base,
			token: await input.token(),
			name,
			publicKeyJwk,
			privateKey,
			thumbprint,
			capabilities: localCapabilities(),
			client: { name: 'kody-cli', version: input.clientVersion },
		})
		let wrapping: Awaited<ReturnType<typeof wrappingFor>>
		try {
			wrapping = await wrappingFor(registered.ecid)
		} catch (error) {
			// Best effort: never leave a server-side context with no local key.
			const path = `/v1/execution-contexts/${encodeURIComponent(registered.ecid)}`
			const token = await input.token()
			await apiJson({ ...base, token, method: 'DELETE', path })
				.then(() =>
					apiJson({ ...base, token, method: 'POST', path: `${path}/delete` }),
				)
				.catch(() => {})
			throw error
		}
		saveContext({
			context: {
				version: 1,
				ecid: registered.ecid,
				name: registered.name,
				apiUrl: input.apiUrl,
				orgSlug: registered.owner.orgSlug,
				publicKeyJwk,
			},
			privateJwk: privateKeyJwk,
			wrapping,
		})
		const steps = (registered.nextSteps ?? [])
			.map(
				(step) => `  ${step.text ?? ''}${step.cli ? `\n    ${step.cli}` : ''}`,
			)
			.join('\n')
		out(
			input,
			registered,
			[
				registered.notice ??
					`Registered ${registered.name} (${registered.ecid}).`,
				steps ? `Next steps:\n${steps}` : '',
			]
				.filter(Boolean)
				.join('\n'),
		)
		if (input.values.json && input.values.install === undefined) return 0
		const install = {
			ecid: registered.ecid,
			...(input.values.install !== undefined
				? { install: input.values.install }
				: connect && !serviceEnv.confirm
					? { install: true }
					: {}),
			...(maxConcurrent === undefined ? {} : { maxConcurrent }),
		}
		if (input.values.install === true) {
			// --json keeps stdout a single JSON document; install progress goes to stderr.
			const installEnv = input.values.json
				? {
						...serviceEnv,
						write: (text: string) => {
							process.stderr.write(text)
						},
					}
				: serviceEnv
			return (await offerInstall(installEnv, install)) ? 0 : 1
		}
		// Registration already succeeded: a default install that cannot run
		// (npx, root, no systemd) is a hint, not a failure to retry.
		try {
			await offerInstall(serviceEnv, install)
		} catch (error) {
			input.write(
				`Registered, but the background service was not installed: ${error instanceof Error ? error.message : String(error)}
Run \`kody daemon\` in a terminal, or fix that and run: kody daemon install --context ${registered.ecid}
`,
			)
		}
		return 0
	}
	if (input.command === 'context' && (sub === 'list' || sub === undefined)) {
		const body = await apiJson({
			...base,
			token: await input.token(),
			method: 'GET',
			path: '/v1/execution-contexts',
		})
		const contexts = (body.contexts ?? []) as Array<{
			id: string
			name: string
			status: string
			usable: boolean
			unusableReason?: string
		}>
		out(
			input,
			body,
			contexts.length === 0
				? 'No execution contexts yet. Register this machine with `kody context register --name <name>`.'
				: contexts
						.map(
							(c) =>
								`${c.name} (${c.id}) ${c.status}${c.usable ? '' : `, not usable: ${c.unusableReason}`}`,
						)
						.join('\n'),
		)
		return 0
	}
	if (input.command === 'context' && (sub === 'revoke' || sub === 'delete')) {
		const ref = rest[0]
		if (!ref) throw new Error(`Usage: kody context ${sub} <name|ec id>`)
		const id = encodeURIComponent(ref)
		const body = await apiJson({
			...base,
			token: await input.token(),
			...(sub === 'revoke'
				? { method: 'DELETE', path: `/v1/execution-contexts/${id}` }
				: { method: 'POST', path: `/v1/execution-contexts/${id}/delete` }),
		})
		out(
			input,
			body,
			sub === 'revoke'
				? `Revoked ${ref}. Delete it for good with: kody context delete ${ref}`
				: `Deleted ${ref}.`,
		)
		const revokedId =
			typeof body.id === 'string'
				? body.id
				: typeof (body.context as { id?: unknown } | undefined)?.id === 'string'
					? (body.context as { id: string }).id
					: null
		await offerUninstallAfterRevoke(
			input.values.json ? { ...serviceEnv, write: () => {} } : serviceEnv,
			{
				ref,
				ecid:
					revokedId && localContextId(input.apiUrl, revokedId)
						? revokedId
						: null,
			},
		)
		return 0
	}
	if (input.command === 'context' && sub === 'cancel-run') {
		const [ref, runId] = rest
		if (!ref || !runId) {
			throw new Error('Usage: kody context cancel-run <name|ec id> <run id>')
		}
		const body = await apiJson({
			...base,
			token: await input.token(),
			method: 'POST',
			path: `/v1/execution-contexts/${encodeURIComponent(ref)}/runs/${encodeURIComponent(runId)}/cancel`,
		})
		out(
			input,
			body,
			body.cancelled === true
				? `Cancelled run ${runId} on ${ref}.`
				: `Run ${runId} already ended (${typeof body.state === 'string' ? body.state : 'finished'}).`,
		)
		return 0
	}
	if (input.command === 'chain') {
		const token = await input.token()
		const read = await apiJson({
			...base,
			token,
			method: 'GET',
			path: '/v1/execution-chain',
		})
		const current = chainOf(read)
		const contexts = async () =>
			contextsById(
				await apiJson({
					...base,
					token,
					method: 'GET',
					path: '/v1/execution-contexts',
				}),
			)
		// Names and status are display-only; never fail the chain command on them.
		const contextMetadata = async () => {
			if (input.values.json) return new Map<string, ContextSummary>()
			try {
				return await contexts()
			} catch {
				return new Map<string, ContextSummary>()
			}
		}
		if (sub === 'show' || sub === undefined) {
			out(input, read, describeChain(current, await contextMetadata()))
			return 0
		}
		if (sub !== 'add' && sub !== 'remove') {
			throw new Error('Usage: kody chain show | add <name> | remove <name>')
		}
		const ref = rest[0]
		if (!ref) throw new Error(`Pass the context name: kody chain ${sub} <name>`)
		const id = await resolveContextId({
			...base,
			token,
			ref,
		})
		const entries = (
			(current.entries ?? []) as Array<{ kind: string; id?: string }>
		)
			.map((entry) =>
				entry.kind === 'cloud'
					? { kind: 'cloud' }
					: { kind: 'context', id: entry.id },
			)
			.filter((entry) => !(entry.kind === 'context' && entry.id === id))
		if (sub === 'add') {
			// Kody cloud is always last; an empty chain starts as [context, cloud].
			if (entries.length === 0) entries.push({ kind: 'cloud' })
			const cloudAt = entries.findIndex((entry) => entry.kind === 'cloud')
			entries.splice(cloudAt === -1 ? entries.length : cloudAt, 0, {
				kind: 'context',
				id,
			})
		}
		const updated = await apiJson({
			...base,
			token,
			method: 'PUT',
			path: '/v1/execution-chain',
			body: {
				entries,
				strict: !entries.some((entry) => entry.kind === 'cloud'),
				ifMatch: current.updatedAt ?? null,
			},
		})
		out(
			input,
			updated,
			describeChain(chainOf(updated), await contextMetadata()),
		)
		return 0
	}
	if (input.command === 'daemon') {
		if (input.values.maxConcurrent === '') {
			throw new Error('--max-concurrent needs a value.')
		}
		const maxConcurrent = maxConcurrentRuns(input.values.maxConcurrent)
		const ecid = input.values.context
			? (localContextId(input.apiUrl, input.values.context) ??
				input.values.context)
			: storedContextIds(input.apiUrl)[0]
		if (!ecid) {
			throw new Error(
				'This machine has no registered execution context. Run `kody connect --name <name>` first.',
			)
		}
		const asService = process.env[serviceEnvVar]
		const manager =
			asService === 'systemd' || asService === 'launchd' ? asService : null
		const paths = manager
			? servicePaths({ apiUrl: input.apiUrl, ecid, manager })
			: null
		const supervised = process.env[supervisedEnvVar] === '1'
		if (paths && !supervised) rotateLog(paths.logPath)
		const readAutoUpdate = async () =>
			autoUpdateSetting(await readLocalPolicy().catch(() => null))
		const relaunchArgs = [
			'daemon',
			'--context',
			ecid,
			'--api-url',
			input.apiUrl,
			...(input.values.maxConcurrent === undefined
				? []
				: ['--max-concurrent', input.values.maxConcurrent]),
		]
		const log = (line: string) => input.write(`${line}\n`)
		// A newer verified CLI is installed (by this or another daemon): run it.
		if (!supervised && (await readAutoUpdate()).enabled) {
			const newer = newerInstalledVersion({ selfVersion: input.clientVersion })
			if (newer) {
				const outcome = await superviseNewerVersion({
					first: newer,
					selfVersion: input.clientVersion,
					args: relaunchArgs,
					log,
				})
				if (outcome.kind === 'exit') return outcome.code
			}
		}
		let started: {
			context: ReturnType<typeof loadContext>['context']
			privateKey: Awaited<ReturnType<typeof importContextKey>>
			serverKeys: Awaited<ReturnType<typeof fetchServerKeys>>
		}
		try {
			const { context, privateJwk } = loadContext({
				apiUrl: input.apiUrl,
				ecid,
				wrapping: wrappingKeyForStoredContext({ apiUrl: input.apiUrl, ecid }),
			})
			started = {
				context,
				privateKey: await importContextKey(privateJwk),
				serverKeys: await fetchServerKeys({ apiUrl: input.apiUrl }),
			}
		} catch (error) {
			if (!supervised) throw error
			// Not this version's fault (offline at boot, say): the supervisor
			// must not count it as a failed update.
			log(
				`Could not start: ${error instanceof Error ? error.message : String(error)}`,
			)
			return startupRefusedExitCode
		}
		const { context, privateKey } = started
		let { serverKeys } = started
		const { runContextRun } = await import('./run-executor.js')
		const hostCommands = new HostCommands({
			localEnabled: await readLocalCommandsEnabled().catch(() => false),
		})
		const commandsPolicyPath = localPolicyPath()
		const onCommandsPolicyChange = () => {
			void readLocalCommandsEnabled()
				.catch(() => false)
				.then((enabled) => hostCommands.setLocalEnabled(enabled))
		}
		watchFile(commandsPolicyPath, { interval: 2000 }, onCommandsPolicyChange)
		const lockStatePath = servicePaths({
			apiUrl: input.apiUrl,
			ecid,
			manager: serviceManagerFor() ?? 'systemd',
		}).statePath
		const launcher: RunnerLauncher =
			manager ??
			(process.env[launcherEnvVar] === 'desktop' ? 'desktop' : 'terminal')
		const lockInfo = {
			version: input.clientVersion,
			launcher,
			startedAt: new Date().toISOString(),
		}
		let lock = acquireRunnerLock(lockPathFor(lockStatePath), lockInfo)
		if (!lock.ok && manager) {
			// A service waits instead of exiting, so the manager neither restarts
			// it in a loop nor gives up on it: it takes over once the other stops.
			let holder = lock.holder
			log(
				`Another kody daemon already runs ${context.name} (${describeHolder(holder)}). One runner per context: this service waits for it to stop instead of replacing it.`,
			)
			let stopWaiting = false
			const onWaitSignal = () => {
				stopWaiting = true
			}
			process.on('SIGINT', onWaitSignal)
			process.on('SIGTERM', onWaitSignal)
			try {
				while (!lock.ok && !stopWaiting) {
					await new Promise((resolve) => setTimeout(resolve, 15_000))
					lock = acquireRunnerLock(lockPathFor(lockStatePath), lockInfo)
					if (!lock.ok && lock.holder.pid !== holder.pid) {
						holder = lock.holder
						log(
							`The runner for ${context.name} is now ${describeHolder(holder)}. Still waiting.`,
						)
					}
				}
			} finally {
				process.off('SIGINT', onWaitSignal)
				process.off('SIGTERM', onWaitSignal)
			}
			if (!lock.ok) {
				unwatchFile(commandsPolicyPath, onCommandsPolicyChange)
				return stayStoppedExitCode
			}
			log(`The other daemon stopped. Starting ${context.name}.`)
			// Kody may have rotated its signing keys while this service waited.
			serverKeys = await fetchServerKeys({ apiUrl: input.apiUrl })
		}
		if (!lock.ok) {
			unwatchFile(commandsPolicyPath, onCommandsPolicyChange)
			const message = `Another kody daemon already runs ${context.name} (${describeHolder(lock.holder)}). One runner per context on a machine: use that one, or stop it first (\`kody daemon stop\`, or Machine > Stop runner in the desktop app).`
			if (!supervised) throw new Error(message)
			log(message)
			return startupRefusedExitCode
		}
		const releaseLock = lock.release
		const abort = new AbortController()
		const drain = new AbortController()
		let hardStop: NodeJS.Timeout | undefined
		let signalled = false
		let signalledAt = 0
		let updateTo: CurrentVersion | null = null
		let forcedUpdate = false
		const onSignal = () => {
			if (signalled) {
				// A supervisor forwards the signal the terminal or service manager
				// already sent the whole group: only a later repeat is a hard stop.
				if (Date.now() - signalledAt < 2_000) return
				return abort.abort()
			}
			signalled = true
			signalledAt = Date.now()
			updateTo = null
			if (!drain.signal.aborted) drain.abort()
			hardStop = setTimeout(() => abort.abort(), 80_000)
			hardStop.unref()
		}
		process.on('SIGINT', onSignal)
		process.on('SIGTERM', onSignal)
		input.write(
			`Starting ${context.name} (${context.ecid}) against ${input.apiUrl}${manager ? ` as a ${manager} service` : ''}.\n`,
		)
		if (!manager && serviceManagerFor()) {
			input.write(
				'Tip: keep it running after reboots and crashes with: kody daemon install\n',
			)
		}
		const statePath = servicePaths({
			apiUrl: input.apiUrl,
			ecid,
			manager: serviceManagerFor() ?? 'systemd',
		}).statePath
		writeJson(statePath, {
			pid: process.pid,
			version: input.clientVersion,
			service: manager,
			startedAt: new Date().toISOString(),
			...(supervised ? { supervisorPid: process.ppid } : {}),
		})
		const workersDir = contextWorkersDir(input.apiUrl, context.ecid)
		const reaped = reapLeftoverWorkers(workersDir)
		if (reaped.length > 0) {
			input.write(
				`Stopped ${reaped.length} local worker(s) left running by an earlier daemon for this context.\n`,
			)
		}
		const workerTracker = createLocalWorkerTracker(workersDir)
		const packageGraphCache = createPackageGraphCache()
		let stop: Awaited<ReturnType<typeof runDaemon>> = 'shutdown'
		let autoUpdateEnabled = (await readAutoUpdate()).enabled
		const activity = { runs: 0 }
		const updater = startDaemonUpdater({
			selfVersion: input.clientVersion,
			setting: async () => {
				const setting = await readAutoUpdate()
				autoUpdateEnabled = setting.enabled
				return setting
			},
			busy: () => ({
				runs: activity.runs,
				background: hostCommands.runningBackground(),
			}),
			log,
			onReady: (current, forced) => {
				if (signalled) return
				updateTo = current
				forcedUpdate = forced
				if (!drain.signal.aborted) drain.abort()
			},
		})
		try {
			stop = await runDaemon({
				apiUrl: input.apiUrl,
				ecid: context.ecid,
				privateKey,
				serverKeys,
				maxConcurrent,
				client: { name: 'kody-cli', version: input.clientVersion },
				capabilities: {
					...localCapabilities(maxConcurrent),
					...(manager ? { service: manager } : {}),
				},
				extraCapabilities: () => ({
					autoUpdate: autoUpdateEnabled ? 'on' : 'off',
				}),
				activity,
				// An update drain also waits for background host commands.
				drainHold: () =>
					updateTo !== null &&
					!signalled &&
					!forcedUpdate &&
					hostCommands.runningBackground() > 0,
				hostCommands,
				execute: (run) =>
					runContextRun({
						...run,
						apiUrl: input.apiUrl,
						workerTracker,
						packageGraphCache,
					}),
				fs: {
					effective: async (grantFs) => {
						const policy = await readLocalPolicy()
						autoUpdateEnabled = autoUpdateSetting(policy).enabled
						return await effectiveFs(grantFs, policy.fs)
					},
					onChange: (listener) => {
						const path = localPolicyPath()
						watchFile(path, { interval: 2000 }, listener)
						return () => unwatchFile(path, listener)
					},
				},
				log,
				signal: abort.signal,
				drainSignal: drain.signal,
			})
		} finally {
			updater.stop()
			unwatchFile(commandsPolicyPath, onCommandsPolicyChange)
			// Background commands are the daemon's children: they stop with it.
			hostCommands.killAll('shutdown')
			workerTracker.killAll()
			workerTracker.dispose()
			if (hardStop) clearTimeout(hardStop)
			process.off('SIGINT', onSignal)
			process.off('SIGTERM', onSignal)
			rmSync(statePath, { force: true })
			releaseLock()
		}
		if (stop === 'replaced') {
			const others = await otherLocalDaemons({ ecid: context.ecid })
			log(
				others.length > 0
					? `Another kody daemon for ${context.name} connected and replaced this one: ${others.map((other) => `pid ${other.pid} (${other.cmd})`).join('; ')}. It predates the one-runner lock. Stopping this daemon instead of reconnecting, so they do not keep replacing each other. Keep one: stop the other, or run \`kody update\` so both use the lock.`
					: `Another kody daemon for ${context.name} connected and replaced this one (not on this machine as far as kody can tell: is the same context key copied to another machine?). Stopping this daemon instead of reconnecting, so they do not keep replacing each other. Restart it with \`kody daemon restart\` once the other is gone.`,
			)
			if (manager) return stayStoppedExitCode
			// Being replaced says nothing about this version's health.
			return supervised ? startupRefusedExitCode : 1
		}
		const target: CurrentVersion | null = updateTo
		if (stop === 'shutdown' && target && !signalled) {
			// Services and supervised daemons exit so they come back on the new
			// version; a terminal daemon runs it in place.
			if (manager || supervised) return relaunchExitCode
			const outcome = await superviseNewerVersion({
				first: target,
				selfVersion: input.clientVersion,
				args: relaunchArgs,
				log,
			})
			if (outcome.kind === 'exit') return outcome.code
			log(`Auto-update: back on kody ${input.clientVersion}.`)
			return await runExecutionContextCommand(input)
		}
		if (stop === 'revoked' || stop === 'unknown_context') {
			const reason =
				stop === 'revoked'
					? 'Kody revoked this context'
					: 'Kody no longer knows this context (deleted)'
			writeJson(
				servicePaths({
					apiUrl: input.apiUrl,
					ecid,
					manager: serviceManagerFor() ?? 'systemd',
				}).stoppedPath,
				{ reason, at: new Date().toISOString() },
			)
			if (manager) disableOwnService({ manager, ecid })
			input.write(
				`${reason}. Stopping for good${manager ? ' and disabling the service' : ''}. Register again with: kody connect --name <name>\n`,
			)
		}
		return stayStoppedExitCode
	}
	throw new Error(
		'Usage: kody context register --name <name> [--org <slug>] | kody context list | kody context revoke <name> | kody context delete <name> | kody context cancel-run <name> <run id> | kody context policy [show | allow <path> [--mode ro|rw] | remove <path>] | kody context commands [status | on | off] [--context <name>] | kody chain show | add <name> | remove <name> | kody connect --name <name> | kody daemon [--context <ec id>] [--max-concurrent <n>] | kody daemon install | status | logs | restart | start | stop | uninstall | auto-update [on | off | status] | kody update',
	)
}

async function resolveContextId(input: {
	apiUrl: string
	org?: string
	token: string
	ref: string
	fetchFn?: typeof fetch
}) {
	if (input.ref.startsWith('ec_')) return input.ref
	const body = await apiJson({
		...input,
		method: 'GET',
		path: '/v1/execution-contexts',
	})
	const match = (
		(body.contexts ?? []) as Array<{ id: string; name: string }>
	).find((c) => c.name === input.ref)
	if (!match)
		throw new Error(`No execution context named ${input.ref} in this org.`)
	return match.id
}

function chainOf(body: Record<string, unknown>) {
	return (body.chain ?? {}) as Record<string, unknown>
}

type ContextSummary = { id: string; name?: string | null; status?: string }

function contextsById(body: Record<string, unknown>) {
	const contexts = (body.contexts ?? []) as Array<ContextSummary>
	return new Map(contexts.map((context) => [context.id, context]))
}

function describeChain(
	chain: Record<string, unknown>,
	contexts: ReadonlyMap<string, ContextSummary> = new Map(),
) {
	const entries = (chain.entries ?? []) as Array<{
		kind: string
		id?: string
		name?: string | null
		usable?: boolean
		unusableReason?: string
	}>
	const lines = entries.map((entry, index) => {
		if (entry.kind === 'cloud') return `${index + 1}. Kody cloud (always last)`
		const known = entry.id ? contexts.get(entry.id) : undefined
		const name = entry.name ?? known?.name
		const label = name ? `${name} (${entry.id})` : String(entry.id)
		const offline =
			known?.status && known.status !== 'online' ? ` [${known.status}]` : ''
		const skipped =
			entry.usable === false ? ` (skipped: ${entry.unusableReason})` : ''
		return `${index + 1}. ${label}${offline}${skipped}`
	})
	if (chain.strict) lines.push('Strict: Kody cloud is not in this chain.')
	return lines.join('\n') || 'Empty chain.'
}

export function readCodeFile(path: string) {
	return readFileSync(path, 'utf8')
}

const policyUsage =
	'Usage: kody context policy [show] | kody context policy allow <path> [--mode ro|rw] | kody context policy remove <path>'

const commandsUsage =
	'Usage: kody context commands [status | on | off] [--context <name>] [--json]'

/**
 * Host commands opt-in (ADR 0093). `on` is a local action: it writes this
 * machine's policy and tells Kody with a request signed by the context key.
 * `off` works here, in the desktop app, or on the website.
 */
async function runCommandsOptInCommand(
	input: ExecutionContextCommandInput,
	[action = 'status', ...extra]: Array<string>,
): Promise<number> {
	if (extra.length > 0 || !['status', 'on', 'off'].includes(action)) {
		throw new Error(commandsUsage)
	}
	if (process.platform === 'win32' && action === 'on') {
		throw new Error(
			'Host commands are not supported on Windows yet: the Kody runner supports macOS and Linux. (execution_context_commands_unsupported)',
		)
	}
	const ecids = input.values.context
		? [
				localContextId(input.apiUrl, input.values.context) ??
					input.values.context,
			]
		: storedContextIds(input.apiUrl)
	if (action === 'on' && input.values.context) {
		// Fails for an unknown context before the shared local switch changes.
		loadContext({
			apiUrl: input.apiUrl,
			ecid: ecids[0]!,
			wrapping: wrappingKeyForStoredContext({
				apiUrl: input.apiUrl,
				ecid: ecids[0]!,
			}),
		})
	}
	if (action !== 'status') {
		await setLocalCommandsEnabled({ enabled: action === 'on' })
	}
	const local = await readLocalCommandsEnabled()
	const contexts: Array<{
		id: string
		name: string
		commands: { enabled: boolean; enabledAt?: string | null } | null
		error?: string
	}> = []
	for (const ecid of ecids) {
		try {
			const { context, privateJwk } = loadContext({
				apiUrl: input.apiUrl,
				ecid,
				wrapping: wrappingKeyForStoredContext({ apiUrl: input.apiUrl, ecid }),
			})
			const result = await setContextCommands({
				apiUrl: input.apiUrl,
				ecid: context.ecid,
				privateKey: await importContextKey(privateJwk),
				...(action === 'status' ? {} : { enabled: action === 'on' }),
				...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
			})
			contexts.push({
				id: result.id,
				name: result.name,
				commands: result.commands,
			})
		} catch (error) {
			contexts.push({
				id: ecid,
				name: ecid,
				commands: null,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}
	const lines = [
		`Host commands on this machine: ${local ? 'on' : 'off'} (local opt-in, ${localPolicyPath()}).`,
		...contexts.map((context) =>
			context.commands
				? `  ${context.name}: ${context.commands.enabled ? 'on' : 'off'} in Kody`
				: `  ${context.name}: could not reach Kody (${context.error})`,
		),
	]
	if (contexts.length === 0) {
		lines.push(
			'  This machine has no registered execution context. Run `kody connect --name <name>` first.',
		)
	}
	if (action === 'on') {
		lines.push(
			'Runs with the command grant (you on your own context; others only if you share it with commands) can now run any command as your OS user, with no per-command approval. Every command is recorded in the context audit log. Turn it off any time: kody context commands off, the desktop app, or the website.',
		)
	} else if (action === 'off') {
		lines.push('Background commands started by runs were stopped.')
	} else if (!local) {
		lines.push('Turn them on with: kody context commands on')
	}
	out(
		input,
		{ local: { enabled: local, path: localPolicyPath() }, contexts },
		lines.join('\n'),
	)
	return contexts.some((context) => context.error) ? 1 : 0
}

async function runPolicyCommand(
	input: ExecutionContextCommandInput,
	[action, path, ...extra]: Array<string>,
): Promise<number> {
	const file = localPolicyPath()
	const describe = (rules: Array<{ path: string; mode: FsMode }>) =>
		rules.length === 0
			? `No host folders are allowed on this machine (${file}). Execution-context runs only see their virtual filesystem.`
			: [
					`Host folders this machine allows (${file}):`,
					...rules.map((rule) => `  ${rule.mode}  ${rule.path}`),
					'A run can use a folder only if its context grant (grant.fs) also lists it; the narrower mode wins.',
				].join('\n')
	if (action === undefined || action === 'show') {
		const policy = await readLocalPolicy(file)
		out(input, { path: file, ...policy }, describe(policy.fs))
		return 0
	}
	if (!path || extra.length > 0) throw new Error(policyUsage)
	if (action === 'allow') {
		const mode = input.values.mode ?? 'ro'
		if (mode !== 'ro' && mode !== 'rw') {
			throw new Error('--mode must be ro (read-only) or rw (read-write).')
		}
		const { policy, added } = await allowLocalPath({
			path,
			mode,
			policyPath: file,
		})
		out(
			input,
			{ path: file, ...policy },
			`Allowed ${added.path} (${added.mode}). Running daemons pick this up within a few seconds.\n${describe(policy.fs)}`,
		)
		return 0
	}
	if (action === 'remove') {
		const { policy, removed } = await removeLocalPath({
			path,
			policyPath: file,
		})
		out(
			input,
			{ path: file, removed, ...policy },
			`${removed ? `Removed ${path}.` : `${path} was not in the policy.`}\n${describe(policy.fs)}`,
		)
		return 0
	}
	throw new Error(policyUsage)
}
