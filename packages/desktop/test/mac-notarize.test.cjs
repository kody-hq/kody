const assert = require('node:assert/strict')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const { notarize, staple } = require('../scripts/mac-notarize.cjs')

const id = '3898b5d0-5d58-4758-b866-7264639a4ed0'
const auth = ['--key', 'key.p8', '--key-id', 'KEY', '--issuer', 'ISSUER']
const lost =
	'Error: HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1001 "The request timed out.")'

function script(handlers) {
	const calls = []
	return {
		calls,
		run: (cmd, argv) => {
			const call = [cmd, ...argv].join(' ')
			calls.push(call)
			for (const [pattern, results] of handlers)
				if (pattern.test(call))
					return results.length > 1 ? results.shift() : results[0]
			return { status: 0, stdout: '', stderr: '' }
		},
	}
}

const ok = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const options = (fake, extra = {}) => ({
	auth,
	run: fake.run,
	sleep: () => {},
	log: () => {},
	zipDir: mkdtempSync(join(tmpdir(), 'kody-notarize-test-')),
	...extra,
})

test('a timed-out poll resumes the same submission instead of resubmitting', () => {
	const fake = script([
		[/notarytool submit/, [ok({ id, message: 'Successfully uploaded file' })]],
		[
			/notarytool wait/,
			[{ status: 1, stdout: '', stderr: lost }, ok({ id, status: 'Accepted' })],
		],
		[
			/notarytool info/,
			[
				{ status: 1, stdout: '', stderr: lost },
				ok({ id, status: 'In Progress' }),
				ok({ id, status: 'Accepted' }),
			],
		],
	])
	assert.deepEqual(notarize('/build/Kody.app', options(fake)), { id })
	assert.equal(fake.calls.filter((call) => / submit /.test(call)).length, 1)
	assert.ok(
		fake.calls
			.filter((call) => /notarytool (?:wait|info)/.test(call))
			.every((call) => call.includes(id)),
	)
})

test('an invalid submission fails without resubmitting', () => {
	const fake = script([
		[/notarytool submit/, [ok({ id })]],
		[/notarytool wait/, [ok({ id, status: 'Invalid' })]],
		[/notarytool info/, [ok({ id, status: 'Invalid' })]],
	])
	assert.throws(() => notarize('/build/Kody.app', options(fake)), /is Invalid/)
	assert.equal(fake.calls.filter((call) => / submit /.test(call)).length, 1)
	assert.ok(
		fake.calls.some((call) => call.startsWith(`xcrun notarytool log ${id}`)),
	)
})

test('gives up on a submission that stays in progress past the deadline', () => {
	let clock = 0
	const fake = script([
		[/notarytool submit/, [ok({ id })]],
		[/notarytool info/, [ok({ id, status: 'In Progress' })]],
	])
	assert.throws(
		() =>
			notarize(
				'/build/Kody.app',
				options(fake, {
					now: () => clock,
					sleep: (ms) => (clock += ms),
					deadlineMs: 60_000,
				}),
			),
		/still in progress/,
	)
	assert.equal(fake.calls.filter((call) => / submit /.test(call)).length, 1)
})

test('stapling retries the CloudKit drop and never contacts the notary service', () => {
	const fake = script([
		[
			/stapler staple/,
			[
				{
					status: 68,
					stdout: '',
					stderr:
						'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\nThe staple and validate action failed! Error 68.',
				},
				ok({}),
			],
		],
	])
	staple('/build/Kody.app', { run: fake.run, sleep: () => {}, log: () => {} })
	assert.deepEqual(fake.calls, [
		'xcrun stapler staple -v /build/Kody.app',
		'xcrun stapler staple -v /build/Kody.app',
		'xcrun stapler validate /build/Kody.app',
	])
})

test('a missing ticket fails stapling at once', () => {
	const fake = script([
		[
			/stapler staple/,
			[
				{
					status: 65,
					stdout: '',
					stderr:
						'Could not find base64 encoded ticket in response for Kody.app',
				},
			],
		],
	])
	assert.throws(
		() =>
			staple('/build/Kody.app', {
				run: fake.run,
				sleep: () => assert.fail('no wait'),
				log: () => {},
			}),
		/failed with exit 65/,
	)
})
