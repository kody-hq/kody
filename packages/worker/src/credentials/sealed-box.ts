import { base64ToBytes, bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { blake2b } from '@noble/hashes/blake2b'
import { box } from '@stablelib/nacl'
import {
	PUBLIC_KEY_LENGTH,
	SECRET_KEY_LENGTH,
	scalarMultBase,
	sharedKey,
} from '@stablelib/x25519'

const nonceLength = 24

function readRecipientPublicKey(encoded: string) {
	// An X25519 public key has one canonical 44-character base64 encoding.
	if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return null
	const decoded = base64ToBytes(encoded)
	return bytesToBase64(decoded) === encoded ? decoded : null
}

/** Libsodium crypto_box_seal wire format, encoded as standard base64. */
export function sealToRecipientPublicKey(value: string, publicKey: string) {
	const recipient = readRecipientPublicKey(publicKey)
	if (!recipient) throw new Error('Invalid sealed-box recipient public key.')

	const ephemeralSecret = crypto.getRandomValues(
		new Uint8Array(SECRET_KEY_LENGTH),
	)
	try {
		try {
			sharedKey(ephemeralSecret, recipient, true).fill(0)
		} catch {
			throw new Error('Invalid sealed-box recipient public key.')
		}
		const ephemeralPublic = scalarMultBase(ephemeralSecret)
		const nonceInput = new Uint8Array(PUBLIC_KEY_LENGTH + recipient.length)
		nonceInput.set(ephemeralPublic)
		nonceInput.set(recipient, PUBLIC_KEY_LENGTH)
		const nonce = blake2b(nonceInput, { dkLen: nonceLength })
		const plaintext = new TextEncoder().encode(value)
		try {
			const ciphertext = box(recipient, ephemeralSecret, nonce, plaintext)
			const sealed = new Uint8Array(PUBLIC_KEY_LENGTH + ciphertext.length)
			sealed.set(ephemeralPublic)
			sealed.set(ciphertext, PUBLIC_KEY_LENGTH)
			return bytesToBase64(sealed)
		} finally {
			plaintext.fill(0)
		}
	} finally {
		ephemeralSecret.fill(0)
	}
}
