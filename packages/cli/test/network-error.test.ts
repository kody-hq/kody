import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	describeNetworkError,
	formatUnreachableApiMessage,
	networkErrorCauseCode,
	requestSentStatus,
} from '../src/network-error.js'

function fetchFailed(code: string): TypeError {
	return new TypeError('fetch failed', {
		cause: Object.assign(new Error(code), { code }),
	})
}

test('describeNetworkError appends undici cause codes', () => {
	assert.equal(
		describeNetworkError(fetchFailed('ECONNREFUSED')),
		'fetch failed: ECONNREFUSED',
	)
	assert.equal(describeNetworkError(new Error('plain')), 'plain')
	assert.equal(networkErrorCauseCode(fetchFailed('ENOTFOUND')), 'ENOTFOUND')
})

test('requestSentStatus is false for connect-phase causes', () => {
	for (const code of [
		'UND_ERR_CONNECT_TIMEOUT',
		'ECONNREFUSED',
		'ENOTFOUND',
		'EAI_AGAIN',
		'ENETUNREACH',
		'EHOSTUNREACH',
	]) {
		assert.equal(requestSentStatus(fetchFailed(code)), false, code)
	}
	assert.equal(
		requestSentStatus(
			new Error('Kody API did not connect within 200ms (/v1/x).'),
		),
		false,
	)
})

test('requestSentStatus is unknown after the request may have been sent', () => {
	assert.equal(requestSentStatus(fetchFailed('UND_ERR_SOCKET')), 'unknown')
	assert.equal(
		requestSentStatus(new Error('Kody API sent nothing for 1000ms (/v1/x).')),
		'unknown',
	)
	assert.equal(requestSentStatus(new Error('fetch failed')), 'unknown')
})

test('formatUnreachableApiMessage distinguishes not-sent from unknown', () => {
	const notSent = formatUnreachableApiMessage({
		origin: 'https://api.kody.codes',
		error: fetchFailed('UND_ERR_CONNECT_TIMEOUT'),
	})
	assert.match(
		notSent,
		/Could not reach the Kody API at https:\/\/api\.kody\.codes/,
	)
	assert.match(notSent, /fetch failed: UND_ERR_CONNECT_TIMEOUT/)
	assert.match(notSent, /The request was not sent/)
	assert.doesNotMatch(notSent, /workflowRunList/)

	const unknown = formatUnreachableApiMessage({
		origin: 'https://api.kody.codes',
		error: fetchFailed('UND_ERR_SOCKET'),
	})
	assert.match(unknown, /The request may have been sent; outcome is unknown/)
	assert.match(unknown, /kody api workflowRunList/)
	assert.match(unknown, /workflowRunList/)
})
