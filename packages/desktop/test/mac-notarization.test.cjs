const assert = require('node:assert/strict')
const { test } = require('node:test')
const { appleDelaysMs } = require('../scripts/release-retry.cjs')
const {
	isTransientNetworkFailure,
	runWithNetworkRetry,
} = require('../scripts/verify-mac-notarization.cjs')

const lostConnection =
	'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\nCloudKit\'s response is inconsistent with expections: (null)\nThe validate action failed! Error 68.'

function fakeRun(results) {
	const calls = []
	return {
		calls,
		run: (cmd, argv) => {
			calls.push([cmd, ...argv].join(' '))
			return results[calls.length - 1]
		},
	}
}

const quiet = { sleep: () => {}, log: () => {} }

test('classifies only Apple network drops as transient', () => {
	assert.equal(isTransientNetworkFailure(lostConnection), true)
	assert.equal(
		isTransientNetworkFailure(
			'NSURLErrorDomain Code=-1001 "The request timed out."',
		),
		true,
	)
	assert.equal(
		isTransientNetworkFailure(
			'Kody.app: rejected\nsource=Unnotarized Developer ID',
		),
		false,
	)
	assert.equal(
		isTransientNetworkFailure('Kody.app does not have a ticket stapled to it.'),
		false,
	)
})

test('retries a lost connection and succeeds on a later attempt', () => {
	const fake = fakeRun([
		{ status: 68, stdout: '', stderr: lostConnection },
		{ status: 0, stdout: 'The validate action worked!', stderr: '' },
	])
	const delays = []
	const result = runWithNetworkRetry(
		'xcrun',
		['stapler', 'validate', 'Kody.app'],
		{
			...quiet,
			run: fake.run,
			sleep: (ms) => delays.push(ms),
		},
	)
	assert.deepEqual(result, { attempts: 2 })
	assert.deepEqual(delays, appleDelaysMs.slice(0, 1))
	assert.ok(delays[0] > 0)
	assert.equal(fake.calls.length, 2)
})

test('a real rejection fails at once without retrying', () => {
	const fake = fakeRun([
		{
			status: 3,
			stdout: '',
			stderr: 'Kody.app: rejected\nsource=Unnotarized Developer ID',
		},
	])
	assert.throws(
		() =>
			runWithNetworkRetry('spctl', ['--assess', 'Kody.app'], {
				...quiet,
				run: fake.run,
			}),
		/failed with exit 3/,
	)
	assert.equal(fake.calls.length, 1)
})

test('gives up after the bounded number of network retries', () => {
	const bound = appleDelaysMs.length + 1
	const fake = fakeRun(
		Array.from({ length: bound + 3 }, () => ({
			status: 68,
			stdout: '',
			stderr: lostConnection,
		})),
	)
	assert.throws(
		() =>
			runWithNetworkRetry('xcrun', ['stapler', 'validate', 'Kody.app'], {
				...quiet,
				run: fake.run,
			}),
		new RegExp(`after ${bound} attempts`),
	)
	assert.equal(fake.calls.length, bound)
})
