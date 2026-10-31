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
	experimentOffError,
	isExperimentOffError,
} from './client.js'
import { runDaemon } from './daemon.js'
import { createPackageGraphCache } from './package-graph-cache.js'
import {
	type FsMode,
	allowLocalPath,
	effectiveFs,
	localPolicyPath,
	readLocalPolicy,
	removeLocalPath,
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
		if (paths) rotateLog(paths.logPath)
		const { context, privateJwk } = loadContext({
			apiUrl: input.apiUrl,
			ecid,
			wrapping: wrappingKeyForStoredContext({ apiUrl: input.apiUrl, ecid }),
		})
		const privateKey = await importContextKey(privateJwk)
		const serverKeys = await fetchServerKeys({ apiUrl: input.apiUrl })
		const { runContextRun } = await import('./run-executor.js')
		const abort = new AbortController()
		const drain = new AbortController()
		let hardStop: NodeJS.Timeout | undefined
		const onSignal = () => {
			if (drain.signal.aborted) return abort.abort()
			drain.abort()
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
				execute: (run) =>
					runContextRun({
						...run,
						apiUrl: input.apiUrl,
						workerTracker,
						packageGraphCache,
					}),
				fs: {
					effective: async (grantFs) =>
						await effectiveFs(grantFs, (await readLocalPolicy()).fs),
					onChange: (listener) => {
						const path = localPolicyPath()
						watchFile(path, { interval: 2000 }, listener)
						return () => unwatchFile(path, listener)
					},
				},
				log: (line) => input.write(`${line}\n`),
				signal: abort.signal,
				drainSignal: drain.signal,
			})
		} finally {
			workerTracker.killAll()
			workerTracker.dispose()
			if (hardStop) clearTimeout(hardStop)
			process.off('SIGINT', onSignal)
			process.off('SIGTERM', onSignal)
			rmSync(statePath, { force: true })
		}
		if (stop !== 'shutdown') {
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
		'Usage: kody context register --name <name> [--org <slug>] | kody context list | kody context revoke <name> | kody context delete <name> | kody context policy [show | allow <path> [--mode ro|rw] | remove <path>] | kody chain show | add <name> | remove <name> | kody connect --name <name> | kody daemon [--context <ec id>] [--max-concurrent <n>] | kody daemon install | status | logs | restart | uninstall | kody update',
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
