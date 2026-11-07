import { spawnSync } from 'node:child_process'
import { Entry } from '@napi-rs/keyring'
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

export type MacSecurityRunner = (args: Array<string>) => {
	status: number | null
	stdout: string
	stderr: string
}

const runMacSecurity: MacSecurityRunner = (args) => {
	const result = spawnSync(macSecurityPath, args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	if (result.error) throw result.error
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	}
}

function securityFailure(
	args: Array<string>,
	result: ReturnType<MacSecurityRunner>,
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

/**
 * macOS login keychain through Apple's `/usr/bin/security` instead of an
 * in-process keychain call. The keychain trusts the program that asks, so
 * in-process reads count Kody.app, each node binary (terminal, npx, launchd
 * service) and each ad-hoc-signed node upgrade as a new requester and prompt
 * again. Every Kody process asks through the same Apple-signed `security`, so
 * one "Always Allow" covers all of them. Any process running as this user can
 * read the items through `security` without a prompt, the same as any script
 * run by the node binary that created them before.
 */
export function createMacSecurityEntry(input: {
	service: string
	account: string
	/** Keychain file to use instead of the default search list (tests). */
	keychain?: string
	run?: MacSecurityRunner
}): KeyringEntry {
	const run = input.run ?? runMacSecurity
	const item = ['-s', input.service, '-a', input.account]
	const keychain = input.keychain ? [input.keychain] : []
	const call = (args: Array<string>) => {
		const result = run(args)
		if (result.status === 0 || result.status === itemNotFoundStatus)
			return result
		throw securityFailure(args, result)
	}
	return {
		getPassword() {
			const args = ['find-generic-password', ...item, '-g', ...keychain]
			const result = call(args)
			if (result.status === itemNotFoundStatus) return null
			const password = parseMacSecurityPassword(result.stderr)
			if (password === null) throw securityFailure(args, result)
			return password
		},
		setPassword(value: string) {
			const args = [
				'add-generic-password',
				'-U',
				...item,
				'-X',
				Buffer.from(value, 'utf8').toString('hex'),
				...keychain,
			]
			const result = call(args)
			if (result.status !== 0) throw securityFailure(args, result)
		},
		deleteCredential() {
			return (
				call(['delete-generic-password', ...item, ...keychain]).status === 0
			)
		},
	}
}

/** The OS keyring entry for one CLI secret (`kody.codes` service). */
export function createKeyringEntry(
	account: string,
	platform: NodeJS.Platform = process.platform,
): KeyringEntry {
	if (platform === 'darwin') {
		return createMacSecurityEntry({ service: keyringService, account })
	}
	return new Entry(keyringService, account, secretServiceKeyringOptions)
}
