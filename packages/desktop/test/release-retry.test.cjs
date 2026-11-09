const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
	appleDelaysMs,
	classifyFailure,
	runWithRetry,
} = require('../scripts/release-retry.cjs')

const stapleLost =
	'Processing: Kody.app\nCloudKit query for Kody.app failed due to "Error Domain=NSURLErrorDomain Code=-1005 \\"The network connection was lost.\\""\nThe staple and validate action failed! Error 68.'

function fakeRun(results) {
	const calls = []
	return {
		calls,
		run: (cmd, argv) => {
			calls.push([cmd, ...argv].join(' '))
			return results[Math.min(calls.length - 1, results.length - 1)]
		},
	}
}

test('classifies Apple and GitHub network drops as transient', () => {
	for (const output of [
		stapleLost,
		'NSURLErrorDomain Code=-1001 "The request timed out."',
		'Error Domain=NSURLErrorDomain Code=-1009 "The Internet connection appears to be offline."',
		'HTTPError(statusCode: 503, error: Service Unavailable)',
		'HTTP 502: Bad Gateway (https://uploads.github.com/repos/kody-hq/kody-desktop/releases/1/assets)',
		'Post "https://uploads.github.com/": read tcp: connection reset by peer',
		'Error: read ECONNRESET',
	])
		assert.equal(classifyFailure(output), 'transient', output)
})

test('fails fast on rejections, signature errors, and unknown failures', () => {
	for (const output of [
		'{"status":"Invalid","id":"abc","message":"Processing complete"}',
		'Kody.app: rejected\nsource=Unnotarized Developer ID',
		'Kody.app: invalid signature (code or signature have been modified)',
		'Kody.app does not have a ticket stapled to it.',
		'HTTP 401: Bad credentials',
		'HTTP 404: Not Found',
		'HTTP 422: Validation Failed',
		'',
	])
		assert.equal(classifyFailure(output), 'fatal', output)
	assert.equal(
		classifyFailure(`${stapleLost}\nstatus: Invalid`),
		'fatal',
		'a rejection wins even when the log also shows a network drop',
	)
})

test('the Apple window is six attempts over about ten minutes with exponential backoff', () => {
	assert.equal(appleDelaysMs.length + 1, 6)
	const total = appleDelaysMs.reduce((sum, ms) => sum + ms, 0)
	assert.ok(total >= 9 * 60_000 && total <= 11 * 60_000, `${total}ms`)
	for (let index = 1; index < appleDelaysMs.length; index++)
		assert.ok(appleDelaysMs[index] > appleDelaysMs[index - 1])
})

test('retries transient failures, then returns the successful output', () => {
	const fake = fakeRun([
		{ status: 68, stdout: '', stderr: stapleLost },
		{ status: 68, stdout: '', stderr: stapleLost },
		{ status: 0, stdout: 'The staple and validate action worked!', stderr: '' },
	])
	const delays = []
	const result = runWithRetry('xcrun', ['stapler', 'staple', 'Kody.app'], {
		run: fake.run,
		sleep: (ms) => delays.push(ms),
		log: () => {},
	})
	assert.equal(result.attempts, 3)
	assert.match(result.output, /worked/)
	assert.deepEqual(delays, appleDelaysMs.slice(0, 2))
})

test('stops after the bounded attempts and reports the network failure', () => {
	const fake = fakeRun([{ status: 68, stdout: '', stderr: stapleLost }])
	assert.throws(
		() =>
			runWithRetry('xcrun', ['stapler', 'staple', 'Kody.app'], {
				run: fake.run,
				sleep: () => {},
				log: () => {},
				delaysMs: [1, 2],
				label: 'stapler staple',
			}),
		(error) =>
			error.kind === 'transient' &&
			/stapler staple still failed with a network error after 3 attempts/.test(
				error.message,
			),
	)
	assert.equal(fake.calls.length, 3)
})

test('does not retry a fatal failure', () => {
	const fake = fakeRun([
		{ status: 1, stdout: '', stderr: 'HTTP 401: Bad credentials' },
	])
	assert.throws(
		() =>
			runWithRetry('gh', ['api', 'repos/x'], {
				run: fake.run,
				sleep: () => assert.fail('must not wait'),
				log: () => {},
			}),
		(error) =>
			error.kind === 'fatal' && /failed with exit 1/.test(error.message),
	)
	assert.equal(fake.calls.length, 1)
})
