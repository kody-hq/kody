const { spawnSync } = require('node:child_process')

// Apple's notary, ticket (CloudKit), and GitHub's release APIs drop
// connections often enough to fail releases. Retry only those network
// failures; signing, notarization, and policy errors fail at once.
const transientPatterns = [
	/NSURLErrorDomain Code=-(?:1001|1003|1004|1005|1009)\b/,
	/CloudKit's response is inconsistent/,
	/The network connection was lost/,
	/The request timed out/,
	/HTTPError\(statusCode: 5\d\d\b/,
	/\bHTTP 5\d\d\b/,
	/\bHTTP 429\b/,
	/\b(?:502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out)\b/,
	/\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN)\b/,
	/connection reset by peer/i,
	/TLS handshake timeout/,
	/i\/o timeout/,
	/unexpected EOF/,
	/secondary rate limit/i,
]

// These always mean the artifact or credentials are wrong, so a retry would
// only hide the failure.
const fatalPatterns = [
	/"status"\s*:\s*"(?:Invalid|Rejected)"/,
	/\bstatus: (?:Invalid|Rejected)\b/,
	/Invalid notarization status/i,
	/source=Unnotarized/,
	/code object is not signed/i,
	/invalid signature/i,
	/a sealed resource is missing or invalid/i,
	/\bHTTP 40[134]\b/,
	/\b(?:401|403) Unauthorized\b|\bForbidden\b/,
]

function classifyFailure(output) {
	const text = String(output ?? '')
	if (fatalPatterns.some((pattern) => pattern.test(text))) return 'fatal'
	if (transientPatterns.some((pattern) => pattern.test(text)))
		return 'transient'
	return 'fatal'
}

function isTransientFailure(output) {
	return classifyFailure(output) === 'transient'
}

// About ten minutes in total, which outlasts the CloudKit ticket lookup drops
// that a 30 second wait did not.
const appleDelaysMs = [20_000, 40_000, 80_000, 160_000, 300_000]
const githubDelaysMs = [5_000, 15_000, 45_000, 120_000]

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function defaultRun(command, args, options) {
	return spawnSync(command, args, {
		encoding: 'utf8',
		stdio: 'pipe',
		maxBuffer: 64 * 1024 * 1024,
		...options,
	})
}

/**
 * Run `command` until it succeeds, retrying transient network failures with
 * the given backoff. `label` is what gets logged, so callers keep secrets that
 * appear in `args` out of the log.
 */
function runWithRetry(command, args, options = {}) {
	const {
		delaysMs = appleDelaysMs,
		attempts = delaysMs.length + 1,
		label = `${command} ${args[0] ?? ''}`.trim(),
		classify = classifyFailure,
		run = defaultRun,
		spawnOptions,
		sleep = sleepSync,
		log = (line) => process.stderr.write(`${line}\n`),
		echo = true,
	} = options
	for (let attempt = 1; ; attempt++) {
		const result = run(command, args, spawnOptions)
		const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}`
		if (echo && output.trim()) log(output.trimEnd())
		if (result.status === 0) return { attempts: attempt, output, result }
		const kind = classify(output)
		if (kind !== 'transient' || attempt >= attempts) {
			const error = new Error(
				kind === 'transient'
					? `${label} still failed with a network error after ${attempt} attempts`
					: `${label} failed with exit ${result.status ?? result.signal}`,
			)
			error.output = output
			error.kind = kind
			throw error
		}
		const delay = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)]
		log(
			`::warning::${label} hit a transient network error (attempt ${attempt}/${attempts}); retrying in ${delay / 1000}s.`,
		)
		sleep(delay)
	}
}

module.exports = {
	appleDelaysMs,
	classifyFailure,
	defaultRun,
	githubDelaysMs,
	isTransientFailure,
	runWithRetry,
	sleepSync,
}

// `node release-retry.cjs gh <args>` runs one GitHub CLI call with the GitHub
// backoff and passes its stdout through, for workflow shell steps.
if (require.main === module) {
	const [command, ...args] = process.argv.slice(2)
	if (!command) throw new Error('Usage: release-retry.cjs <command> [args...]')
	try {
		const { result } = runWithRetry(command, args, {
			delaysMs: githubDelaysMs,
			echo: false,
		})
		process.stdout.write(result.stdout ?? '')
		process.stderr.write(result.stderr ?? '')
	} catch (error) {
		process.stderr.write(`${error.output ?? ''}\n${error.message}\n`)
		process.exitCode = 1
	}
}
