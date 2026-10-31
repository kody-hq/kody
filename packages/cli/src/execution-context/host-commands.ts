import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'

/**
 * Host commands (`kody.command.*`, ADR 0093): real OS processes on the
 * daemon's machine, run as the user running the daemon. Foreground commands
 * belong to one run; background jobs live in the daemon (not the run's
 * workerd), so builds can outlast the run timeout and later runs can poll or
 * kill them.
 */

export type HostCommandsDenialCode =
	| 'execution_context_commands_off'
	| 'execution_context_commands_unsupported'
	| 'invalid_request'
	| 'not_found'

export class HostCommandError extends Error {
	constructor(
		readonly code: HostCommandsDenialCode,
		message: string,
	) {
		super(`${message} (${code})`)
		this.name = 'HostCommandError'
	}
}

export type HostCommandSpec = {
	/** Shell command line, run with the user's shell (`$SHELL -c`, else /bin/sh). */
	command?: string
	/** Executable to run without a shell (with `args`). */
	file?: string
	args?: Array<string>
	cwd?: string
	env?: Record<string, string>
	stdin?: string
	timeoutMs?: number
	maxOutputBytes?: number
}

export type HostCommandLifecycle = 'status' | 'output' | 'kill' | 'list'

/**
 * Starts (`run`, `start`) are authorized and audited; lifecycle calls on
 * existing commands are authorized (grant, permission, token scope) only.
 */
export type HostCommandAuthorize = (
	input:
		| {
				commandId: string
				command: string
				cwd: string
				envKeys: Array<string>
				background: boolean
		  }
		| { lifecycle: HostCommandLifecycle },
) => Promise<void>

export type HostCommandFinished = {
	commandId: string
	runId: string
	command: string
	cwd: string
	exitCode: number | null
	signal: string | null
	durationMs: number
	background: boolean
	reason:
		| 'exited'
		| 'timed_out'
		| 'killed'
		| 'cancelled'
		| 'commands_off'
		| 'spawn_failed'
}

export type HostCommandRunContext = {
	runId: string
	requesterUserId: string
	signal: AbortSignal
	authorize: HostCommandAuthorize
}

export const hostCommandLimits = {
	foregroundDefaultTimeoutMs: 60_000,
	foregroundMaxTimeoutMs: 15 * 60_000,
	backgroundDefaultTimeoutMs: 2 * 60 * 60_000,
	backgroundMaxTimeoutMs: 24 * 60 * 60_000,
	defaultOutputBytes: 256 * 1024,
	maxOutputBytes: 4 * 1024 * 1024,
	backgroundBufferBytes: 4 * 1024 * 1024,
	maxOutputReadBytes: 1024 * 1024,
	maxBackgroundJobs: 16,
	keepFinishedJobsMs: 60 * 60_000,
	maxCommandChars: 64 * 1024,
	maxStdinBytes: 5 * 1024 * 1024,
}

/** Tail-keeping byte buffer with absolute offsets. */
class OutputBuffer {
	#chunks: Array<Buffer> = []
	#size = 0
	/** Bytes ever written. */
	total = 0
	constructor(readonly capacity: number) {}

	get dropped() {
		return this.total - this.#size
	}

	write(chunk: Buffer) {
		this.total += chunk.length
		this.#chunks.push(chunk)
		this.#size += chunk.length
		while (this.#size > this.capacity && this.#chunks.length > 0) {
			const head = this.#chunks[0]!
			const over = this.#size - this.capacity
			if (head.length <= over) {
				this.#chunks.shift()
				this.#size -= head.length
			} else {
				this.#chunks[0] = head.subarray(over)
				this.#size -= over
			}
		}
	}

	/** Bytes from absolute `offset` (clamped to what is still kept). */
	read(offset: number, maxBytes: number) {
		const all = Buffer.concat(this.#chunks)
		let start = Math.max(offset, this.dropped)
		// Never split a UTF-8 character across pages.
		while (
			start - this.dropped < all.length &&
			start > offset &&
			isUtf8Continuation(all[start - this.dropped]!)
		)
			start++
		let end = Math.min(start - this.dropped + maxBytes, all.length)
		if (end < all.length && isUtf8Continuation(all[end]!)) {
			let back = end
			while (back > start - this.dropped && isUtf8Continuation(all[back]!))
				back--
			if (back > start - this.dropped) end = back
			else {
				// The page is smaller than one character: finish that character.
				while (end < all.length && isUtf8Continuation(all[end]!)) end++
			}
		}
		const slice = all.subarray(start - this.dropped, end)
		return {
			text: slice.toString('utf8'),
			from: start,
			next: start + slice.length,
			skipped: start - offset,
		}
	}

	text() {
		return Buffer.concat(this.#chunks).toString('utf8')
	}
}

type Job = {
	id: string
	runId: string
	ownerUserId: string
	command: string
	cwd: string
	child: ChildProcess
	pid: number | undefined
	startedAt: number
	endedAt: number | null
	exitCode: number | null
	signal: string | null
	state: 'running' | 'exited' | 'killed' | 'timed_out' | 'failed'
	stdout: OutputBuffer
	stderr: OutputBuffer
	done: Promise<void>
	timer: ReturnType<typeof setTimeout> | null
	error: string | null
}

type PreparedCommand = {
	display: string
	cwd: string
	env: NodeJS.ProcessEnv
	envKeys: Array<string>
	stdin: string | undefined
	timeoutMs: number
	maxOutputBytes: number
	file: string
	argv: Array<string>
}

function newCommandId() {
	return `cmd_${randomBytes(9).toString('base64url')}`
}

function clampInt(value: unknown, fallback: number, max: number, min = 1) {
	if (value === undefined || value === null) return fallback
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new HostCommandError(
			'invalid_request',
			`Expected a number, got ${typeof value}.`,
		)
	}
	return Math.min(Math.max(Math.floor(value), min), max)
}

function isUtf8Continuation(byte: number) {
	return (byte & 0xc0) === 0x80
}

function shellFor(env: NodeJS.ProcessEnv) {
	const shell = env.SHELL
	return shell && isAbsolute(shell) ? shell : '/bin/sh'
}

function killTree(child: ChildProcess, signal: NodeJS.Signals) {
	// No exitCode guard: the shell leader can exit while the rest of its
	// group (e.g. `server &`) still runs and holds the pipes.
	if (child.pid === undefined) return
	try {
		// Detached children lead their own process group: signal the group so
		// `npm run build` does not leave its grandchildren running.
		process.kill(-child.pid, signal)
	} catch {
		try {
			child.kill(signal)
		} catch {
			// Already gone.
		}
	}
}

export type HostCommandsOptions = {
	/** This machine's local opt-in (`kody context commands on`). */
	localEnabled?: boolean
	platform?: NodeJS.Platform
}

export class HostCommands {
	#jobs = new Map<string, Job>()
	#onFinished:
		| ((finished: HostCommandFinished) => Promise<void> | void)
		| null = null
	/** Finishes that could not be sent yet (no live connection); sent on the next reporter. */
	#unreported: Array<HostCommandFinished> = []
	#foreground = new Map<
		ChildProcess,
		{ reason: HostCommandFinished['reason'] }
	>()
	#pendingStarts = 0
	#localEnabled: boolean
	/** The server grant's commands flag (off from website/API/CLI). */
	#grantEnabled = false
	readonly #platform: NodeJS.Platform

	constructor(options: HostCommandsOptions = {}) {
		this.#localEnabled = options.localEnabled === true
		this.#platform = options.platform ?? process.platform
	}

	/** Both layers allow commands and the OS is supported. */
	get enabled() {
		return (
			this.#platform !== 'win32' && this.#localEnabled && this.#grantEnabled
		)
	}

	setLocalEnabled(enabled: boolean) {
		this.#localEnabled = enabled
		if (!enabled) this.killAll('commands_off')
	}

	setGrantEnabled(enabled: boolean) {
		this.#grantEnabled = enabled
		if (!enabled) this.killAll('commands_off')
	}

	/** Clears the reporter if it is still `report` (a newer connection may own it). */
	clearReporter(
		report: (finished: HostCommandFinished) => Promise<void> | void,
	) {
		if (this.#onFinished === report) this.#onFinished = null
	}

	setReporter(
		report: ((finished: HostCommandFinished) => Promise<void> | void) | null,
	) {
		this.#onFinished = report
		if (!report) return
		const queued = this.#unreported.splice(0)
		for (const finished of queued) this.#report(finished)
	}

	/** Throws the denial a run sees when it may not run commands here. */
	assertAvailable() {
		if (this.#platform === 'win32') {
			throw new HostCommandError(
				'execution_context_commands_unsupported',
				'Host commands are not supported on Windows yet: the Kody runner supports macOS and Linux.',
			)
		}
		if (!this.#localEnabled) {
			throw new HostCommandError(
				'execution_context_commands_off',
				'Host commands are off on this machine: its owner has not opted in. Turn them on on the machine with `kody context commands on` or the Kody desktop app (Machine > Allow commands).',
			)
		}
		if (!this.#grantEnabled) {
			throw new HostCommandError(
				'execution_context_commands_off',
				'Host commands were turned off for this machine (from the website, API or CLI). Its owner turns them back on on the machine with `kody context commands on` or the Kody desktop app.',
			)
		}
	}

	/** Dispatches one `kody.command.<name>(args)` call from a run. */
	async call(name: string, args: unknown, run: HostCommandRunContext) {
		this.assertAvailable()
		if (
			name === 'status' ||
			name === 'output' ||
			name === 'kill' ||
			name === 'list'
		) {
			await run.authorize({ lifecycle: name })
			this.assertAvailable()
		}
		switch (name) {
			case 'run':
				return await this.run(args, run)
			case 'start':
				return await this.start(args, run)
			case 'status':
				return this.status(args, run)
			case 'output':
				return this.output(args, run)
			case 'kill':
				return this.kill(args, run)
			case 'list':
				return this.list(run)
			default:
				throw new HostCommandError(
					'invalid_request',
					`Unknown kody.command.${name}. Use run, start, status, output, kill or list.`,
				)
		}
	}

	async #prepare(
		input: unknown,
		background: boolean,
	): Promise<PreparedCommand> {
		const raw = typeof input === 'string' ? { command: input } : input
		const spec = (raw ?? {}) as HostCommandSpec
		if (typeof spec !== 'object' || Array.isArray(spec)) {
			throw new HostCommandError(
				'invalid_request',
				'Pass { command } or { file, args }.',
			)
		}
		const hasCommand =
			typeof spec.command === 'string' && spec.command.length > 0
		const hasFile = typeof spec.file === 'string' && spec.file.length > 0
		if (hasCommand === hasFile) {
			throw new HostCommandError(
				'invalid_request',
				'Pass exactly one of `command` (a shell command line) or `file` (an executable, with optional `args`).',
			)
		}
		const args = spec.args ?? []
		if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
			throw new HostCommandError(
				'invalid_request',
				'`args` must be an array of strings.',
			)
		}
		if (hasCommand && spec.args !== undefined) {
			throw new HostCommandError(
				'invalid_request',
				'`args` goes with `file`, not `command`.',
			)
		}
		const display = hasCommand
			? (spec.command as string)
			: [spec.file as string, ...args].join(' ')
		if (display.length > hostCommandLimits.maxCommandChars) {
			throw new HostCommandError('invalid_request', 'The command is too long.')
		}
		const cwd = spec.cwd ?? homedir()
		if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
			throw new HostCommandError(
				'invalid_request',
				'`cwd` must be an absolute path on the machine.',
			)
		}
		const cwdStat = await stat(cwd).catch(() => null)
		if (!cwdStat?.isDirectory()) {
			throw new HostCommandError(
				'invalid_request',
				`cwd ${cwd} is not a folder on this machine.`,
			)
		}
		const extraEnv = spec.env ?? {}
		if (
			typeof extraEnv !== 'object' ||
			Array.isArray(extraEnv) ||
			!Object.entries(extraEnv).every(
				([key, value]) =>
					/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string',
			)
		) {
			throw new HostCommandError(
				'invalid_request',
				'`env` must map variable names to string values.',
			)
		}
		if (spec.stdin !== undefined && typeof spec.stdin !== 'string') {
			throw new HostCommandError('invalid_request', '`stdin` must be a string.')
		}
		if ((spec.stdin?.length ?? 0) > hostCommandLimits.maxStdinBytes) {
			throw new HostCommandError(
				'invalid_request',
				'`stdin` is larger than 5 MB.',
			)
		}
		const timeoutMs = background
			? clampInt(
					spec.timeoutMs,
					hostCommandLimits.backgroundDefaultTimeoutMs,
					hostCommandLimits.backgroundMaxTimeoutMs,
					1000,
				)
			: clampInt(
					spec.timeoutMs,
					hostCommandLimits.foregroundDefaultTimeoutMs,
					hostCommandLimits.foregroundMaxTimeoutMs,
					100,
				)
		const maxOutputBytes = clampInt(
			spec.maxOutputBytes,
			hostCommandLimits.defaultOutputBytes,
			hostCommandLimits.maxOutputBytes,
			1024,
		)
		const env = { ...process.env, ...extraEnv }
		return {
			display,
			cwd,
			env,
			envKeys: Object.keys(extraEnv).sort(),
			stdin: spec.stdin,
			timeoutMs,
			maxOutputBytes,
			file: hasCommand ? shellFor(env) : (spec.file as string),
			argv: hasCommand ? ['-c', spec.command as string] : args,
		}
	}

	#spawn(prepared: PreparedCommand) {
		const child = spawn(prepared.file, prepared.argv, {
			cwd: prepared.cwd,
			env: prepared.env,
			detached: true,
			stdio: [prepared.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
		})
		if (prepared.stdin !== undefined && child.stdin) {
			child.stdin.on('error', () => {})
			child.stdin.end(prepared.stdin)
		}
		return child
	}

	#report(finished: HostCommandFinished) {
		const requeue = () => {
			if (this.#unreported.length < 256) this.#unreported.push(finished)
		}
		const report = this.#onFinished
		if (!report) return requeue()
		try {
			void Promise.resolve(report(finished)).catch(requeue)
		} catch {
			requeue()
		}
	}

	async run(raw: unknown, run: HostCommandRunContext) {
		const prepared = await this.#prepare(raw, false)
		const commandId = newCommandId()
		await run.authorize({
			commandId,
			command: prepared.display,
			cwd: prepared.cwd,
			envKeys: prepared.envKeys,
			background: false,
		})
		this.assertAvailable()
		const startedAt = Date.now()
		const stdout = new OutputBuffer(prepared.maxOutputBytes)
		const stderr = new OutputBuffer(prepared.maxOutputBytes)
		const ended = { reason: 'exited' as HostCommandFinished['reason'] }
		const child = this.#spawn(prepared)
		this.#foreground.set(child, ended)
		child.stdout?.on('data', (chunk: Buffer) => stdout.write(chunk))
		child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk))
		const timer = setTimeout(() => {
			ended.reason = 'timed_out'
			killTree(child, 'SIGKILL')
		}, prepared.timeoutMs)
		const onAbort = () => {
			ended.reason = 'cancelled'
			killTree(child, 'SIGKILL')
		}
		run.signal.addEventListener('abort', onAbort, { once: true })
		if (run.signal.aborted) onAbort()
		const outcome = await new Promise<{
			code: number | null
			signal: string | null
			error?: string
		}>((resolve) => {
			child.once('error', (error) =>
				resolve({ code: null, signal: null, error: error.message }),
			)
			child.once('close', (code, signal) => resolve({ code, signal }))
		})
		clearTimeout(timer)
		this.#foreground.delete(child)
		run.signal.removeEventListener('abort', onAbort)
		if (outcome.error) ended.reason = 'spawn_failed'
		const durationMs = Date.now() - startedAt
		this.#report({
			commandId,
			runId: run.runId,
			command: prepared.display,
			cwd: prepared.cwd,
			exitCode: outcome.code,
			signal: outcome.signal,
			durationMs,
			background: false,
			reason: ended.reason,
		})
		if (outcome.error) {
			throw new HostCommandError(
				'invalid_request',
				`Could not start the command: ${outcome.error}`,
			)
		}
		return {
			commandId,
			exitCode: outcome.code,
			signal: outcome.signal,
			timedOut: ended.reason === 'timed_out',
			stdout: stdout.text(),
			stderr: stderr.text(),
			stdoutTruncated: stdout.dropped > 0,
			stderrTruncated: stderr.dropped > 0,
			durationMs,
		}
	}

	async start(raw: unknown, run: HostCommandRunContext) {
		this.#sweep()
		const running = [...this.#jobs.values()].filter(
			(job) => job.state === 'running',
		)
		if (
			running.length + this.#pendingStarts >=
			hostCommandLimits.maxBackgroundJobs
		) {
			throw new HostCommandError(
				'invalid_request',
				`This machine already runs ${running.length + this.#pendingStarts} background commands. Kill one (kody.command.kill) first.`,
			)
		}
		this.#pendingStarts++
		let prepared: PreparedCommand
		let commandId: string
		let child: ChildProcess
		try {
			prepared = await this.#prepare(raw, true)
			commandId = newCommandId()
			await run.authorize({
				commandId,
				command: prepared.display,
				cwd: prepared.cwd,
				envKeys: prepared.envKeys,
				background: true,
			})
			this.assertAvailable()
			child = this.#spawn(prepared)
		} finally {
			this.#pendingStarts--
		}
		const job: Job = {
			id: commandId,
			runId: run.runId,
			ownerUserId: run.requesterUserId,
			command: prepared.display,
			cwd: prepared.cwd,
			child,
			pid: child.pid,
			startedAt: Date.now(),
			endedAt: null,
			exitCode: null,
			signal: null,
			state: 'running',
			stdout: new OutputBuffer(hostCommandLimits.backgroundBufferBytes),
			stderr: new OutputBuffer(hostCommandLimits.backgroundBufferBytes),
			done: Promise.resolve(),
			timer: null,
			error: null,
		}
		child.stdout?.on('data', (chunk: Buffer) => job.stdout.write(chunk))
		child.stderr?.on('data', (chunk: Buffer) => job.stderr.write(chunk))
		job.timer = setTimeout(() => {
			if (job.state !== 'running') return
			job.state = 'timed_out'
			killTree(child, 'SIGKILL')
		}, prepared.timeoutMs)
		job.timer.unref?.()
		job.done = new Promise<void>((resolve) => {
			const finish = (
				code: number | null,
				signal: string | null,
				error?: string,
			) => {
				if (job.endedAt !== null) return resolve()
				if (job.timer) clearTimeout(job.timer)
				job.endedAt = Date.now()
				job.exitCode = code
				job.signal = signal
				if (error) {
					job.state = 'failed'
					job.error = error
				} else if (job.state === 'running') {
					job.state = 'exited'
				}
				this.#report({
					commandId,
					runId: job.runId,
					command: job.command,
					cwd: job.cwd,
					exitCode: code,
					signal,
					durationMs: job.endedAt - job.startedAt,
					background: true,
					reason:
						job.state === 'failed'
							? 'spawn_failed'
							: job.state === 'killed'
								? job.error === 'commands_off'
									? 'commands_off'
									: 'killed'
								: job.state === 'timed_out'
									? 'timed_out'
									: 'exited',
				})
				resolve()
			}
			child.once('error', (error) => finish(null, null, error.message))
			child.once('close', (code, signal) => finish(code, signal))
		})
		this.#jobs.set(commandId, job)
		return {
			commandId,
			pid: job.pid ?? null,
			startedAt: new Date(job.startedAt).toISOString(),
			timeoutMs: prepared.timeoutMs,
		}
	}

	#job(raw: unknown, run: HostCommandRunContext) {
		const id =
			typeof raw === 'string'
				? raw
				: (raw as { commandId?: unknown } | null)?.commandId
		const job = typeof id === 'string' ? this.#jobs.get(id) : undefined
		// Another user's job looks the same as no job.
		if (!job || job.ownerUserId !== run.requesterUserId) {
			throw new HostCommandError(
				'not_found',
				`No background command ${String(id)} on this machine for you. kody.command.list() shows yours.`,
			)
		}
		return job
	}

	#describe(job: Job) {
		return {
			commandId: job.id,
			command: job.command,
			cwd: job.cwd,
			state: job.state,
			pid: job.pid ?? null,
			exitCode: job.exitCode,
			signal: job.signal,
			startedAt: new Date(job.startedAt).toISOString(),
			endedAt:
				job.endedAt === null ? null : new Date(job.endedAt).toISOString(),
			durationMs: (job.endedAt ?? Date.now()) - job.startedAt,
			stdoutBytes: job.stdout.total,
			stderrBytes: job.stderr.total,
			...(job.error && job.state === 'failed' ? { error: job.error } : {}),
		}
	}

	status(raw: unknown, run: HostCommandRunContext) {
		return this.#describe(this.#job(raw, run))
	}

	output(raw: unknown, run: HostCommandRunContext) {
		const job = this.#job(raw, run)
		const input = (typeof raw === 'object' && raw ? raw : {}) as {
			stdoutOffset?: unknown
			stderrOffset?: unknown
			maxBytes?: unknown
		}
		const maxBytes = clampInt(
			input.maxBytes,
			hostCommandLimits.defaultOutputBytes,
			hostCommandLimits.maxOutputReadBytes,
		)
		const stdout = job.stdout.read(
			clampInt(input.stdoutOffset, 0, Number.MAX_SAFE_INTEGER, 0),
			maxBytes,
		)
		const stderr = job.stderr.read(
			clampInt(input.stderrOffset, 0, Number.MAX_SAFE_INTEGER, 0),
			maxBytes,
		)
		return {
			commandId: job.id,
			state: job.state,
			exitCode: job.exitCode,
			stdout: stdout.text,
			stderr: stderr.text,
			stdoutOffset: stdout.next,
			stderrOffset: stderr.next,
			stdoutSkipped: stdout.skipped,
			stderrSkipped: stderr.skipped,
			done:
				job.state !== 'running' &&
				stdout.next >= job.stdout.total &&
				stderr.next >= job.stderr.total,
		}
	}

	kill(raw: unknown, run: HostCommandRunContext) {
		const job = this.#job(raw, run)
		const requested = (raw as { signal?: unknown } | null)?.signal
		const signal: NodeJS.Signals =
			requested === 'SIGINT' ||
			requested === 'SIGKILL' ||
			requested === 'SIGTERM'
				? requested
				: 'SIGTERM'
		if (job.state === 'running') {
			job.state = 'killed'
			killTree(job.child, signal)
			if (signal !== 'SIGKILL') {
				const escalate = setTimeout(() => killTree(job.child, 'SIGKILL'), 5000)
				escalate.unref?.()
			}
		}
		return this.#describe(job)
	}

	list(run: HostCommandRunContext) {
		this.#sweep()
		return {
			commands: [...this.#jobs.values()]
				.filter((job) => job.ownerUserId === run.requesterUserId)
				.map((job) => this.#describe(job)),
		}
	}

	/** Commands were turned off (or the daemon stops): end every background job. */
	killAll(reason: 'commands_off' | 'shutdown') {
		for (const [child, ended] of this.#foreground) {
			ended.reason = reason === 'commands_off' ? 'commands_off' : 'cancelled'
			killTree(child, 'SIGKILL')
		}
		for (const job of this.#jobs.values()) {
			if (job.state !== 'running') continue
			job.state = 'killed'
			job.error = reason === 'commands_off' ? 'commands_off' : null
			killTree(job.child, 'SIGKILL')
		}
	}

	async idle() {
		await Promise.all([...this.#jobs.values()].map((job) => job.done))
	}

	#sweep() {
		const cutoff = Date.now() - hostCommandLimits.keepFinishedJobsMs
		for (const [id, job] of this.#jobs) {
			if (job.endedAt !== null && job.endedAt < cutoff) this.#jobs.delete(id)
		}
	}
}
