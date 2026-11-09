const {
	appleDelaysMs,
	isTransientFailure,
	runWithRetry,
} = require('./release-retry.cjs')

// `stapler validate` and `spctl --assess` both look the ticket up on Apple's
// CloudKit service. A dropped connection there is not a signing problem, so
// retry only those network errors; any other failure is reported at once.
function runWithNetworkRetry(command, args, options = {}) {
	const { attempts, delaysMs = appleDelaysMs, ...rest } = options
	const result = runWithRetry(command, args, {
		...rest,
		delaysMs,
		attempts: attempts ?? delaysMs.length + 1,
		label: `${command} ${args[0]}`,
	})
	return { attempts: result.attempts }
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

module.exports = {
	isTransientNetworkFailure: isTransientFailure,
	runWithNetworkRetry,
}
