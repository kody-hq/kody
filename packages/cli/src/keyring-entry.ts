import { spawn, spawnSync } from 'node:child_process'
import { Entry } from '@napi-rs/keyring'
import {
	type ChildTracker,
	type TrackedChild,
	helperChildren,
} from './child-tracker.js'
import { keyringService } from './defaults.js'

/** Linux-only: require Secret Service. Ignored on macOS and Windows. */
export const secretServiceKeyringOptions = {
	linux: { store: 'secret-service' },
} as const

/** The subset of `@napi-rs/keyring` `Entry` the CLI uses. */
export type KeyringEntry = {
	getPassword(): string | null
	setPassword(value: string): void
	deleteCredential(): boolean
}

export const macSecurityPath = '/usr/bin/security'

/** `security` exit status for "The specified item could not be found". */
const itemNotFoundStatus = 44

const keychainTimeoutEnvVar = 'KODY_KEYCHAIN_TIMEOUT_MS'
const defaultKeychainTimeoutMs = 120_000
/** A Keychain call slower than this is waiting on an approval dialog. */
export const keychainNoticeAfterMs = 1_500

/** `KODY_KEYCHAIN_TIMEOUT_MS`, or 2 minutes. */
export function keychainTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
	const value = Number(env[keychainTimeoutEnvVar])
	return Number.isFinite(value) && value > 0 ? value : defaultKeychainTimeoutMs
}

function keychainWaitNotice(service: string, account: string) {
	return `Waiting for macOS Keychain approval for ${service} (${account}). Check for a Keychain dialog, possibly behind other windows.\n`
}

/** `security` was stopped because nobody answered the Keychain dialog. */
export class KeychainTimeoutError extends Error {
	constructor(input: { service: string; account: string; timeoutMs: number }) {
		const seconds = Math.round(input.timeoutMs / 1000)
		const fileKey = input.account.startsWith('execution-context:')
			? ' Or keep this machine key in a file instead of the Keychain: `kody daemon install --key-storage file` moves it after one approval, and `kody connect --name <name> --key-storage file` registers the machine again without the Keychain.'
			: ''
		super(
			`macOS Keychain did not answer within ${seconds}s for ${input.service} (${input.account}), so kody stopped the security process. Approve the Keychain dialog (choose "Always Allow" so it does not ask again) and retry.${fileKey} Set ${keychainTimeoutEnvVar} to wait longer.`,
		)
		this.name = 'KeychainTimeoutError'
	}
}

type MacSecurityResult = {
	status: number | null
	stdout: string
	stderr: string
}

export type MacSecurityRunner = (args: Array<string>) => MacSecurityResult

export type MacSecurityAsyncRunner = (
	args: Array<string>,
) => Promise<MacSecurityResult>

function runMacSecuritySync(
	item: { service: string; account: string },
	timeoutMs: number,
): MacSecurityRunner {
	return (args) => {
		const result = spawnSync(macSecurityPath, args, {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: timeoutMs,
		})
		if (
			(result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
		)
			throw new KeychainTimeoutError({ ...item, timeoutMs })
		if (result.error) throw result.error
		return {
			status: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
		}
	}
}

/** The part of a spawned `security` process the async runner reads. */
type SecurityChild = TrackedChild & {
	stdout: {
		on(event: 'data', listener: (chunk: Buffer) => void): unknown
	} | null
	stderr: {
		on(event: 'data', listener: (chunk: Buffer) => void): unknown
	} | null
	once(event: 'close', listener: (code: number | null) => void): unknown
	once(event: 'error', listener: (error: Error) => void): unknown
}

export type SpawnSecurity = (
	command: string,
	args: Array<string>,
	options: { stdio: ['ignore', 'pipe', 'pipe'] },
) => SecurityChild

/** Schedules `run` after `ms`; returns a cancel function. */
export type KeychainClock = (run: () => void, ms: number) => () => void

const realClock: KeychainClock = (run, ms) => {
	const timer = setTimeout(run, ms)
	return () => clearTimeout(timer)
}

/**
 * Runs `security` without blocking the event loop, so it can say when it is
 * waiting on a Keychain dialog, give up after a timeout, and be killed when
 * this process is signalled.
 */
export function createMacSecurityAsyncRunner(input: {
	service: string
	account: string
	spawn?: SpawnSecurity
	clock?: KeychainClock
	notice?: (text: string) => void
	timeoutMs?: number
	children?: ChildTracker
}): MacSecurityAsyncRunner {
	const spawnSecurity = input.spawn ?? (spawn as SpawnSecurity)
	const clock = input.clock ?? realClock
	const notice = input.notice ?? ((text) => process.stderr.write(text))
	const children = input.children ?? helperChildren
	return (args) =>
		new Promise((resolve, reject) => {
			const timeoutMs = input.timeoutMs ?? keychainTimeoutMs()
			const child = children.track(
				spawnSecurity(macSecurityPath, args, {
					stdio: ['ignore', 'pipe', 'pipe'],
				}),
			)
			let stdout = ''
			let stderr = ''
			child.stdout?.on('data', (chunk) => {
				stdout += chunk.toString('utf8')
			})
			child.stderr?.on('data', (chunk) => {
				stderr += chunk.toString('utf8')
			})
			const cancelNotice = clock(
				() => notice(keychainWaitNotice(input.service, input.account)),
				keychainNoticeAfterMs,
			)
			const cancelTimeout = clock(() => {
				settle()
				child.kill('SIGTERM')
				reject(
					new KeychainTimeoutError({
						service: input.service,
						account: input.account,
						timeoutMs,
					}),
				)
			}, timeoutMs)
			let settled = false
			function settle() {
				settled = true
				cancelNotice()
				cancelTimeout()
			}
			child.once('error', (error) => {
				if (settled) return
				settle()
				reject(error)
			})
			child.once('close', (code) => {
				if (settled) return
				settle()
				resolve({ status: code, stdout, stderr })
			})
		})
}

function securityFailure(
	args: Array<string>,
	result: MacSecurityResult,
): Error {
	return new Error(
		`security ${args[0]} failed (exit ${result.status}): ${result.stderr.trim()}`,
	)
}

/**
 * Parse `security find-generic-password -g` stderr: `password: "text"` when
 * every byte is printable ASCII, else `password: 0xHEX  "…"`. Unlike `-w`,
 * this cannot confuse a hex-looking secret with hex output.
 */
export function parseMacSecurityPassword(stderr: string): string | null {
	for (const line of stderr.split('\n')) {
		const hex = /^password: 0x([0-9A-Fa-f]*)(?:\s|$)/.exec(line)
		if (hex) return Buffer.from(hex[1]!, 'hex').toString('utf8')
		const text = /^password: "(.*)"$/.exec(line)
		if (text) return text[1]!
		if (line === 'password: ') return ''
	}
	return null
}

/** `security` argument lists and result handling shared by both runners. */
function macSecurityCalls(input: {
	service: string
	account: string
	keychain?: string
}) {
	const item = ['-s', input.service, '-a', input.account]
	const keychain = input.keychain ? [input.keychain] : []
	const checked = (args: Array<string>, result: MacSecurityResult) => {
		if (result.status === 0 || result.status === itemNotFoundStatus)
			return result
		throw securityFailure(args, result)
	}
	const find = ['find-generic-password', ...item, '-g', ...keychain]
	const remove = ['delete-generic-password', ...item, ...keychain]
	return {
		find,
		readPassword(result: MacSecurityResult) {
			checked(find, result)
			if (result.status === itemNotFoundStatus) return null
			const password = parseMacSecurityPassword(result.stderr)
			if (password === null) throw securityFailure(find, result)
			return password
		},
		add(value: string) {
			return [
				'add-generic-password',
				'-U',
				...item,
				'-X',
				Buffer.from(value, 'utf8').toString('hex'),
				...keychain,
			]
		},
		checkAdded(args: Array<string>, result: MacSecurityResult) {
			if (checked(args, result).status !== 0)
				throw securityFailure(args, result)
		},
		remove,
		deleted(result: MacSecurityResult) {
			return checked(remove, result).status === 0
		},
	}
}

/**
 * macOS login keychain through Apple's `/usr/bin/security` instead of an
 * in-process keychain call. The keychain trusts the program that asks, so
 * in-process reads count Kody.app, each node binary (terminal, npx, launchd
 * service) and each ad-hoc-signed node upgrade as a new requester and prompt
 * again. Every Kody process asks through the same Apple-signed `security`, so
 * one "Always Allow" covers all of them. Any process running as this user can
 * read the items through `security` without a prompt, the same as any script
 * run by the node binary that created them before.
 *
 * This blocking form gives up after `KODY_KEYCHAIN_TIMEOUT_MS` but cannot
 * print while it waits; use `createAsyncKeyringEntry` where a prompt is likely.
 */
export function createMacSecurityEntry(input: {
	service: string
	account: string
	/** Keychain file to use instead of the default search list (tests). */
	keychain?: string
	run?: MacSecurityRunner
}): KeyringEntry {
	const run = input.run ?? runMacSecuritySync(input, keychainTimeoutMs())
	const calls = macSecurityCalls(input)
	return {
		getPassword() {
			return calls.readPassword(run(calls.find))
		},
		setPassword(value: string) {
			const args = calls.add(value)
			calls.checkAdded(args, run(args))
		},
		deleteCredential() {
			return calls.deleted(run(calls.remove))
		},
	}
}

/** A keyring entry whose macOS calls never block the event loop. */
export type AsyncKeyringEntry = {
	getPassword(): Promise<string | null>
	setPassword(value: string): Promise<void>
}

export function createMacSecurityAsyncEntry(input: {
	service: string
	account: string
	keychain?: string
	run?: MacSecurityAsyncRunner
}): AsyncKeyringEntry {
	const run = input.run ?? createMacSecurityAsyncRunner(input)
	const calls = macSecurityCalls(input)
	return {
		async getPassword() {
			return calls.readPassword(await run(calls.find))
		},
		async setPassword(value: string) {
			const args = calls.add(value)
			calls.checkAdded(args, await run(args))
		},
	}
}

/**
 * The OS keyring entry for one CLI secret (`kody.codes` service). On macOS this
 * blocking form gives up after `KODY_KEYCHAIN_TIMEOUT_MS` but cannot print
 * while it waits; machine-key reads use `createAsyncKeyringEntry`.
 */
export function createKeyringEntry(
	account: string,
	platform: NodeJS.Platform = process.platform,
): KeyringEntry {
	if (platform === 'darwin') {
		return createMacSecurityEntry({ service: keyringService, account })
	}
	return new Entry(keyringService, account, secretServiceKeyringOptions)
}

/**
 * The OS keyring entry for one CLI secret, for callers that can wait: on
 * macOS it prints a notice while a Keychain dialog is pending, times out, and
 * stops `security` when this process is signalled.
 */
export function createAsyncKeyringEntry(
	account: string,
	platform: NodeJS.Platform = process.platform,
): AsyncKeyringEntry {
	if (platform === 'darwin') {
		return createMacSecurityAsyncEntry({ service: keyringService, account })
	}
	const entry = new Entry(keyringService, account, secretServiceKeyringOptions)
	return {
		async getPassword() {
			return entry.getPassword()
		},
		async setPassword(value) {
			entry.setPassword(value)
		},
	}
}
