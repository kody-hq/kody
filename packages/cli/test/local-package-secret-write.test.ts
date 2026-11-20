import assert from 'node:assert/strict'
import test from 'node:test'
import {
	assertLocalPackageScopedSecretWriteAllowed,
	localPackageScopedSecretWriteBlockReason,
	localPackageScopedSecretMutationUnavailableMessage,
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
		localPackageScopedSecretMutationUnavailableMessage,
	)
})

test('blocks secretDelete with scope package', () => {
	assert.equal(
		localPackageScopedSecretWriteBlockReason(
			['kody', 'secretDelete'],
			[{ name: 'token', scope: 'package' }],
		),
		localPackageScopedSecretMutationUnavailableMessage,
	)
})

test('blocks secretDisconnect with scope package', () => {
	assert.equal(
		localPackageScopedSecretWriteBlockReason(
			['kody', 'secretDisconnect'],
			[{ name: 'token', scope: 'package' }],
		),
		localPackageScopedSecretMutationUnavailableMessage,
	)
})

test('forwards secretSet with a package_id target to Kody', () => {
	assert.equal(
		localPackageScopedSecretWriteBlockReason(
			['kody', 'secretSet'],
			[{ name: 'token', scope: 'package', value: 'x', package_id: 'pkg-1' }],
		),
		null,
	)
	assert.equal(
		localPackageScopedSecretWriteBlockReason(
			['kody', 'secretDelete'],
			[{ name: 'token', scope: 'package', package_id: 'pkg-1' }],
		),
		localPackageScopedSecretMutationUnavailableMessage,
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
