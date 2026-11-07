const { spawn, spawnSync } = require('node:child_process')

// Match GNU `timeout` so workflow conditionals stay familiar.
const TIMED_OUT = 124

function parseDuration(spec) {
	const match = /^(\d+)(ms|s|m|h)?$/i.exec(String(spec).trim())
	if (!match) throw new Error(`Invalid duration: ${spec}`)
	const amount = Number(match[1])
	const unit = (match[2] || 's').toLowerCase()
	const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }
	return amount * multipliers[unit]
}

/**
 * Stop the spawned command and its descendants. Unix uses a dedicated process
 * group (see `detached` in `runWithTimeout`); Windows uses `taskkill /T`.
 */
function killProcessTree(pid, signal, options = {}) {
	const {
		platform = process.platform,
		kill = (target, sig) => process.kill(target, sig),
		taskkill = (args) =>
			spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true }),
	} = options
	if (pid == null) return
	if (platform === 'win32') {
		taskkill(['/pid', String(pid), '/T', '/F'])
		return
	}
	try {
		// Negative PID = whole process group (npm + electron-builder + notary).
		kill(-pid, signal)
	} catch {
		try {
			kill(pid, signal)
		} catch {
			/* already exited */
		}
	}
}

/**
 * Run a command and kill it after `ms`. Portable replacement for GNU
 * `timeout` / Homebrew `gtimeout`, which are not reliably on PATH for the
 * macOS and Windows GitHub Actions runners used by desktop-release.
 *
 * On timeout we SIGTERM the process group, then always escalate to SIGKILL
 * (either when the direct child exits, or after `killGraceMs`) so a
 * SIGTERM-resistant descendant cannot leak into the workflow retry.
 */
function runWithTimeout(ms, command, args, options = {}) {
	const {
		spawnImpl = spawn,
		setTimeoutImpl = setTimeout,
		clearTimeoutImpl = clearTimeout,
		killTree = killProcessTree,
		killGraceMs = 10_000,
		stdio = 'inherit',
		env = process.env,
		cwd,
		platform = process.platform,
	} = options

	return new Promise((resolve) => {
		const child = spawnImpl(command, args, {
			stdio,
			env,
			cwd,
			// Own process group on POSIX so kill(-pid) stops descendants
			// (notarization / electron-builder children of npm).
			detached: platform !== 'win32',
			// `npm` is `npm.cmd` on Windows; shell keeps PATH resolution working.
			shell: platform === 'win32',
		})
		let timedOut = false
		let forceTimer
		let escalated = false
		let finished = false
		const finish = (result) => {
			if (finished) return
			finished = true
			clearTimeoutImpl(timer)
			if (forceTimer) clearTimeoutImpl(forceTimer)
			resolve(result)
		}
		const escalateToKill = () => {
			if (escalated) return
			escalated = true
			killTree(child.pid, 'SIGKILL')
		}

		const timer = setTimeoutImpl(() => {
			timedOut = true
			killTree(child.pid, 'SIGTERM')
			forceTimer = setTimeoutImpl(escalateToKill, killGraceMs)
		}, ms)

		child.on('error', (error) => {
			finish({ status: 1, timedOut: false, error })
		})
		child.on('exit', (code, signal) => {
			if (timedOut) {
				// Direct child may exit on SIGTERM while a descendant ignores it.
				// Escalate immediately; do not leave the force-kill pending cleared.
				escalateToKill()
				finish({ status: TIMED_OUT, timedOut: true, signal })
				return
			}
			finish({ status: code ?? 1, timedOut: false, signal })
		})
	})
}

async function main(argv = process.argv.slice(2)) {
	if (argv.length < 2) {
		process.stderr.write(
			'Usage: run-with-timeout.cjs <duration> <command> [args...]\n',
		)
		process.exitCode = 2
		return
	}
	const [duration, command, ...args] = argv
	const result = await runWithTimeout(parseDuration(duration), command, args)
	if (result.error) {
		process.stderr.write(`${result.error.message}\n`)
	}
	process.exitCode = result.status
}

module.exports = {
	TIMED_OUT,
	parseDuration,
	killProcessTree,
	runWithTimeout,
	main,
}

if (require.main === module) {
	main().catch((error) => {
		process.stderr.write(`${error.stack || error}\n`)
		process.exitCode = 1
	})
}
