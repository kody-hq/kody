import { execFileSync } from 'node:child_process'

const windowsHidden = {
	encoding: 'utf8' as const,
	stdio: ['ignore', 'pipe', 'ignore'] as Array<'ignore' | 'pipe'>,
	windowsHide: true,
	// PowerShell + CIM cold start takes over 15s on Windows on Arm runners.
	timeout: 60_000,
}

/** The command line of a running Windows process, or null when it is gone. */
export function windowsCommandLine(pid: number): string | null {
	try {
		const text = execFileSync(
			'powershell.exe',
			[
				'-NoProfile',
				'-NonInteractive',
				'-Command',
				`[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").CommandLine`,
			],
			windowsHidden,
		).trim()
		return text || null
	} catch {
		return null
	}
}

/**
 * Kills a process and everything it started. POSIX callers own a process
 * group; Windows has none, so this asks `taskkill` to walk the tree.
 */
export function killProcessTree(
	pid: number,
	platform: NodeJS.Platform = process.platform,
) {
	if (platform === 'win32') {
		try {
			execFileSync(
				'taskkill.exe',
				['/PID', String(Math.trunc(pid)), '/T', '/F'],
				windowsHidden,
			)
		} catch {
			// Already gone.
		}
		return
	}
	try {
		process.kill(pid, 'SIGKILL')
	} catch {
		// Already gone.
	}
}

/**
 * Re-raises a signal after cleanup. On Windows `process.kill(self)` is an
 * unhandled TerminateProcess, so remaining listeners (the daemon's graceful
 * drain) would never run: dispatch in-process instead.
 */
export function raiseSignal(
	signal: NodeJS.Signals,
	platform: NodeJS.Platform = process.platform,
) {
	if (platform !== 'win32') {
		process.kill(process.pid, signal)
		return
	}
	if (process.listenerCount(signal) > 0) {
		process.emit(signal, signal)
		return
	}
	process.exit(signal === 'SIGINT' ? 130 : 143)
}
