const { spawnSync } = require('node:child_process')

// `stapler validate` and `spctl --assess` both look the ticket up on Apple's
// CloudKit service. A dropped connection there is not a signing problem, so
// retry only those network errors; any other failure is reported at once.
const transientNetworkError =
	/NSURLErrorDomain Code=-(?:1001|1003|1004|1005|1009)\b|CloudKit's response is inconsistent/

function isTransientNetworkFailure(output) {
	return transientNetworkError.test(output)
}

function runWithNetworkRetry(command, args, options = {}) {
	const {
		attempts = 3,
		delaysMs = [15_000, 45_000],
		run = (cmd, argv) =>
			spawnSync(cmd, argv, { encoding: 'utf8', stdio: 'pipe' }),
		sleep = (ms) =>
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
		log = (line) => process.stderr.write(`${line}\n`),
	} = options
	for (let attempt = 1; ; attempt++) {
		const result = run(command, args)
		const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
		if (output) log(output.trimEnd())
		if (result.status === 0) return { attempts: attempt }
		const transient = isTransientNetworkFailure(output)
		if (!transient || attempt >= attempts) {
			const reason = transient
				? `still lost the Apple network connection after ${attempt} attempts`
				: `failed with exit ${result.status ?? result.signal}`
			throw new Error(`${command} ${args.join(' ')} ${reason}`)
		}
		const delay = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)]
		log(
			`::warning::${command} ${args[0]} lost the Apple network connection (attempt ${attempt}/${attempts}); retrying in ${delay / 1000}s.`,
		)
		sleep(delay)
	}
}

if (require.main === module) {
	const bundle = process.argv[2]
	if (!bundle) throw new Error('Usage: verify-mac-notarization.cjs <Kody.app>')
	runWithNetworkRetry('xcrun', ['stapler', 'validate', bundle])
	runWithNetworkRetry('spctl', [
		'--assess',
		'--type',
		'execute',
		'--verbose',
		bundle,
	])
}

module.exports = { isTransientNetworkFailure, runWithNetworkRetry }
