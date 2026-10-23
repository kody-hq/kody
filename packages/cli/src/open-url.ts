import { spawn } from 'node:child_process'

/** How long to wait for the system opener to report a failure. */
const openerSettleMs = 1500

export type OpenUrlOptions = {
	platform?: NodeJS.Platform
	/** Test seam for the child process launcher. */
	spawnFn?: typeof spawn
	settleMs?: number
}

/**
 * Ask the OS to open `url` in the default browser. Resolves false when the
 * opener could not start or exited with an error (for example no default
 * browser). Resolves true when it exited cleanly or is still running after a
 * short wait. True does not prove a browser window appeared, so callers should
 * always print the URL too.
 */
export async function openUrl(
	url: string,
	options: OpenUrlOptions = {},
): Promise<boolean> {
	const platform = options.platform ?? process.platform
	const command =
		platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
	const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
	const spawnFn = options.spawnFn ?? spawn
	return await new Promise((resolve) => {
		let settled = false
		const finish = (opened: boolean) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(opened)
		}
		const timer = setTimeout(
			() => finish(true),
			options.settleMs ?? openerSettleMs,
		)
		timer.unref?.()
		let child: ReturnType<typeof spawn>
		try {
			child = spawnFn(command, args, {
				detached: true,
				stdio: 'ignore',
				windowsHide: true,
			})
		} catch {
			finish(false)
			return
		}
		child.on('error', () => finish(false))
		child.on('exit', (code) => finish(code === 0 || code === null))
		child.unref()
	})
}
