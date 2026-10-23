import assert from 'node:assert/strict'
import test from 'node:test'
import {
	assertLocalPackageScopedSecretWriteAllowed,
	localPackageScopedSecretWriteBlockReason,
	localPackageScopedSecretWriteUnavailableMessage,
} from '../src/local-package-secret-write.js'

test('blocks secretSet with scope package before CapabilityProxy hop', () => {
	assert.equal(
		localPackageScopedSecretWriteBlockReason(
			['kody', 'secretSet'],
			[{ name: 'token', scope: 'package', value: 'x' }],
		),
		localPackageScopedSecretWriteUnavailableMessage,
	)
	assert.throws(
		() =>
			assertLocalPackageScopedSecretWriteAllowed(
				['kody', 'secretSet'],
				[{ name: 'token', scope: 'package', value: 'x' }],
			),
		(error: unknown) =>
			error instanceof Error &&
			error.message === localPackageScopedSecretWriteUnavailableMessage,
	)
})

test('blocks secretSetMany when any entry is package-scoped', () => {
	assert.equal(
		localPackageScopedSecretWriteBlockReason(
			['kody', 'secretSetMany'],
			[
				{
					secrets: [
						{ name: 'a', scope: 'user', value: '1' },
						{ name: 'b', scope: 'package', value: '2' },
					],
				},
			],
		),
		localPackageScopedSecretWriteUnavailableMessage,
	)
})

test('blocks secretDelete with scope package', () => {
	assert.equal(
		localPackageScopedSecretWriteBlockReason(
			['kody', 'secretDelete'],
			[{ name: 'token', scope: 'package' }],
		),
		localPackageScopedSecretWriteUnavailableMessage,
	)
})

test('blocks secretDisconnect with scope package', () => {
	assert.equal(
		localPackageScopedSecretWriteBlockReason(
			['kody', 'secretDisconnect'],
			[{ name: 'token', scope: 'package' }],
		),
		localPackageScopedSecretWriteUnavailableMessage,
	)
})

test('allows user-scoped secretSet and unrelated paths', () => {
	assert.equal(
		localPackageScopedSecretWriteBlockReason(
			['kody', 'secretSet'],
			[{ name: 'token', scope: 'user', value: 'x' }],
		),
		null,
	)
	assert.equal(
		localPackageScopedSecretWriteBlockReason(['kody', 'secretList'], [{}]),
		null,
	)
	assert.equal(
		localPackageScopedSecretWriteBlockReason(['kody', 'emailSend'], [{}]),
		null,
	)
})
