const { spawn } = require('node:child_process')

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
 * Run a command and kill it after `ms`. Portable replacement for GNU
 * `timeout` / Homebrew `gtimeout`, which are not reliably on PATH for the
 * macOS and Windows GitHub Actions runners used by desktop-release.
 */
function runWithTimeout(ms, command, args, options = {}) {
	const {
		spawnImpl = spawn,
		setTimeoutImpl = setTimeout,
		clearTimeoutImpl = clearTimeout,
		killGraceMs = 10_000,
		stdio = 'inherit',
		env = process.env,
		cwd,
	} = options

	return new Promise((resolve) => {
		const child = spawnImpl(command, args, {
			stdio,
			env,
			cwd,
			// `npm` is `npm.cmd` on Windows; shell keeps PATH resolution working.
			shell: process.platform === 'win32',
		})
		let timedOut = false
		let forceTimer
		const timer = setTimeoutImpl(() => {
			timedOut = true
			try {
				child.kill('SIGTERM')
			} catch {
				/* already exited */
			}
			forceTimer = setTimeoutImpl(() => {
				try {
					child.kill('SIGKILL')
				} catch {
					/* already exited */
				}
			}, killGraceMs)
		}, ms)

		const finish = (result) => {
			clearTimeoutImpl(timer)
			if (forceTimer) clearTimeoutImpl(forceTimer)
			resolve(result)
		}

		child.on('error', (error) => {
			finish({ status: 1, timedOut: false, error })
		})
		child.on('exit', (code, signal) => {
			if (timedOut) {
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

module.exports = { TIMED_OUT, parseDuration, runWithTimeout, main }

if (require.main === module) {
	main().catch((error) => {
		process.stderr.write(`${error.stack || error}\n`)
		process.exitCode = 1
	})
}
