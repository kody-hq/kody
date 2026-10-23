import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileStorePath, type StoreResolution } from './store.js'

/** Error codes that mean "this folder cannot be written", not a bug. */
const folderErrorCodes = new Set([
	'EACCES',
	'EPERM',
	'EROFS',
	'ENOTDIR',
	'EEXIST',
	'ENOENT',
])

function errorCode(error: unknown): string | undefined {
	if (error && typeof error === 'object' && 'code' in error) {
		const code = (error as { code?: unknown }).code
		return typeof code === 'string' ? code : undefined
	}
	return undefined
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}

/** True when a failed save looks like a folder permission or path problem. */
export function isCredentialFolderError(error: unknown): boolean {
	const code = errorCode(error)
	return code !== undefined && folderErrorCodes.has(code)
}

/**
 * Folder where `kody login` keeps its credential file (and falls back to when
 * the OS keychain is unavailable).
 */
export function credentialDirFor(
	mcpUrl: string,
	resolution?: StoreResolution,
): string {
	return dirname(resolution?.fileStorePath?.(mcpUrl) ?? fileStorePath(mcpUrl))
}

function quote(path: string): string {
	return `"${path.replaceAll('"', '\\"')}"`
}

/** Plain-language steps to make the credential folder writable again. */
export function credentialDirFixSteps(
	dir: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform === 'win32') {
		return [
			'To fix it:',
			`  1. Open File Explorer and go to ${dir}`,
			'  2. Right-click the folder, choose Properties, then Security, and give your user "Full control".',
			'  3. Run `kody login` again.',
		].join('\n')
	}
	const lines = [
		'To fix it, open Terminal and run these two commands (your Mac or computer password may be requested):',
		`  sudo mkdir -p ${quote(dir)}`,
		`  sudo chown -R "$(whoami)" ${quote(dir)} && chmod u+rwx ${quote(dir)}`,
		'Then run `kody login` again.',
	]
	if (platform === 'darwin') {
		lines.push(
			'If macOS still blocks it, open System Settings, then Privacy & Security, then Full Disk Access, and turn on your terminal app (for example Terminal or iTerm). Quit and reopen the terminal, then run `kody login` again.',
		)
	}
	return lines.join('\n')
}

/** Thrown when the credential folder is missing and cannot be created, or is read-only. */
export class CredentialDirError extends Error {
	readonly dir: string
	readonly code: string | undefined
	constructor(input: {
		dir: string
		cause: unknown
		phase: 'preflight' | 'save'
		platform?: NodeJS.Platform
	}) {
		const code = errorCode(input.cause)
		const detail = errorText(input.cause)
		const intro =
			input.phase === 'preflight'
				? 'Kody cannot sign you in yet because it is not allowed to save files in this folder:'
				: 'You approved the sign-in, but Kody could not save it on this computer because it is not allowed to write to this folder:'
		super(
			[
				intro,
				`  ${input.dir}`,
				`What went wrong: ${detail}`,
				'',
				credentialDirFixSteps(input.dir, input.platform),
			].join('\n'),
			{ cause: input.cause },
		)
		this.name = 'CredentialDirError'
		this.dir = input.dir
		this.code = code
	}
}

/**
 * Make sure the credential folder exists and accepts writes. Creates it when
 * missing (mode 0700), then writes and removes a tiny probe file so a folder
 * that exists but is read-only (for example macOS blocking
 * ~/Library/Application Support) fails here, before the browser opens.
 */
export function ensureCredentialDirWritable(
	dir: string,
	options: { platform?: NodeJS.Platform } = {},
): void {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 })
		if (!statSync(dir).isDirectory()) {
			const error = new Error(`${dir} is a file, not a folder.`) as Error & {
				code: string
			}
			error.code = 'ENOTDIR'
			throw error
		}
		const probe = join(dir, `.kody-write-check-${process.pid}-${Date.now()}`)
		writeFileSync(probe, '', { mode: 0o600 })
		rmSync(probe, { force: true })
	} catch (error) {
		throw new CredentialDirError({
			dir,
			cause: error,
			phase: 'preflight',
			platform: options.platform,
		})
	}
}
