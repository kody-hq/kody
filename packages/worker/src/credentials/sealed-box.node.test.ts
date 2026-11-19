import { createHash } from 'node:crypto'
import { base64ToBytes, bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { blake2b } from '@noble/hashes/blake2b'
import { generateKeyPair, openBox } from '@stablelib/nacl'
import { generateKeyPairFromSeed, PUBLIC_KEY_LENGTH } from '@stablelib/x25519'
import { expect, test, vi } from 'vitest'
import { sealToRecipientPublicKey } from './sealed-box.ts'

test('matches a fixture independently opened with libsodium crypto_box_seal_open', () => {
	const random = vi
		.spyOn(crypto, 'getRandomValues')
		.mockImplementationOnce((target) => {
			;(target as Uint8Array).set(Uint8Array.from({ length: 32 }, (_, i) => i))
			return target
		})
	try {
		expect(
			sealToRecipientPublicKey(
				'line one\nline two 🗝',
				'NYBy1jZYgNGu6jKa35EhODhR7SGijjt16WXQ0s0WYlQ=',
			),
		).toBe(
			'j0DFrbaPJWJK5bIU6nZ6bslNgp09e14a0bpvPiE4KF8Ks2MG7Rj9C6zG+Z/+9GKqva0AvFoLfrhTHFHU4VOs5jWKSqpD1Q==',
		)
	} finally {
		random.mockRestore()
	}
})

test('seals to the recipient with a new ephemeral key each time', () => {
	const recipient = generateKeyPairFromSeed(
		createHash('sha256').update('test recipient').digest(),
	)
	const publicKey = bytesToBase64(recipient.publicKey)
	const value = 'line one\nline two 🗝'
	const first = sealToRecipientPublicKey(value, publicKey)
	const second = sealToRecipientPublicKey(value, publicKey)
	const sealed = base64ToBytes(first)
	const boxOverhead = PUBLIC_KEY_LENGTH + 16
	expect(sealed.length).toBe(
		new TextEncoder().encode(value).length + boxOverhead,
	)
	expect(second).not.toBe(first)
	const sender = sealed.subarray(0, PUBLIC_KEY_LENGTH)
	const nonce = blake2b(Buffer.concat([sender, recipient.publicKey]), {
		dkLen: 24,
	})
	const ciphertext = sealed.subarray(PUBLIC_KEY_LENGTH)
	const message = openBox(sender, recipient.secretKey, nonce, ciphertext)
	expect(message && new TextDecoder().decode(message)).toBe(value)
	expect(
		openBox(sender, generateKeyPair().secretKey, nonce, ciphertext),
	).toBeNull()
})

test('refuses malformed and small-order recipient keys', () => {
	expect(() => sealToRecipientPublicKey('test', 'not-base64')).toThrow(
		'Invalid sealed-box recipient public key.',
	)
	const lowOrder = new Uint8Array(PUBLIC_KEY_LENGTH)
	for (const firstByte of [0, 1]) {
		lowOrder[0] = firstByte
		expect(() =>
			sealToRecipientPublicKey('test', bytesToBase64(lowOrder)),
		).toThrow('Invalid sealed-box recipient public key.')
	}
})
