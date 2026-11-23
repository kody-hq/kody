import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { expect, test } from 'vitest'
import { isMcpCallerError } from '#mcp/caller-error.ts'
import { assertOptInCredentialValue } from './opt-in-credential-value.ts'
import { privateKeyPemToPkcs8 } from './private-key-pem.ts'

// Generated for this test run only; never real keys.
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const pkcs8Der = (key: typeof rsa.privateKey) =>
	new Uint8Array(key.export({ type: 'pkcs8', format: 'der' }))

function caught(run: () => unknown) {
	try {
		run()
	} catch (error) {
		return error as Error
	}
	throw new Error('expected a throw')
}

test('PKCS#1 RSA and SEC1 EC PEMs become PKCS#8 DER for the same key', () => {
	const samePkcs8 = (value: string, key: typeof rsa.privateKey) => {
		const { der } = privateKeyPemToPkcs8(value)
		const read = createPrivateKey({
			key: Buffer.from(der),
			format: 'der',
			type: 'pkcs8',
		})
		return Buffer.from(pkcs8Der(read)).equals(Buffer.from(pkcs8Der(key)))
	}
	const rsaPkcs1 = String(
		rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }),
	)
	expect(privateKeyPemToPkcs8(rsaPkcs1).format).toBe('PKCS#1 RSA')
	expect(samePkcs8(rsaPkcs1, rsa.privateKey)).toBe(true)
	const ecSec1 = String(ec.privateKey.export({ type: 'sec1', format: 'pem' }))
	// `openssl ecparam -genkey` writes an EC PARAMETERS block first.
	const withParams = `-----BEGIN EC PARAMETERS-----\nBggqhkjOPQMBBw==\n-----END EC PARAMETERS-----\n${ecSec1}`
	for (const pem of [ecSec1, withParams]) {
		expect(privateKeyPemToPkcs8(pem).format).toBe('SEC1 EC')
		expect(samePkcs8(pem, ec.privateKey)).toBe(true)
	}
	const pkcs8 = String(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }))
	expect(privateKeyPemToPkcs8(pkcs8.replace(/\n/g, '\\n')).der).toEqual(
		pkcs8Der(rsa.privateKey),
	)
})

test('unsupported or broken keys are caller errors that name the label, never the key', () => {
	const encrypted = String(
		rsa.privateKey.export({
			type: 'pkcs8',
			format: 'pem',
			cipher: 'aes-256-cbc',
			passphrase: 'test-only',
		}),
	)
	const legacyEncrypted = String(
		rsa.privateKey.export({
			type: 'pkcs1',
			format: 'pem',
			cipher: 'aes-256-cbc',
			passphrase: 'test-only',
		}),
	)
	const publicKey = String(
		rsa.publicKey.export({ type: 'spki', format: 'pem' }),
	)
	const body = String(
		rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
	).split('\n')[1]!
	const cases: Array<[string, string]> = [
		[encrypted, 'BEGIN ENCRYPTED PRIVATE KEY PEM block'],
		[legacyEncrypted, 'BEGIN RSA PRIVATE KEY block is encrypted'],
		[publicKey, 'BEGIN PUBLIC KEY PEM block, which holds no private key'],
		[
			`-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----`,
			'BEGIN OPENSSH PRIVATE KEY PEM block',
		],
		[`-----BEGIN PRIVATE KEY-----\n${body}`, 'without a matching END line'],
		['not a key!', 'is not a PEM private key'],
		[
			'-----BEGIN EC PRIVATE KEY-----\nMAA=\n-----END EC PRIVATE KEY-----',
			'not a valid SEC1 EC key',
		],
		[
			'-----BEGIN PRIVATE KEY-----\nMAA=\n-----END PRIVATE KEY-----',
			'not a valid PKCS#8 key',
		],
		[
			'-----BEGIN RSA PRIVATE KEY-----\nMAA=\n-----END RSA PRIVATE KEY-----',
			'not a valid PKCS#1 RSA key',
		],
		['abcd', 'is not a PEM private key'],
	]
	for (const [value, expected] of cases) {
		const error = caught(() => privateKeyPemToPkcs8(value))
		expect(isMcpCallerError(error)).toBe(true)
		expect(error.message).toContain(expected)
		expect(error.message).not.toContain(body)
	}
})

test('a signing credential holding a PEM is checked when saved', () => {
	const save = (value: string) =>
		assertOptInCredentialValue({ kind: 'signing', value, hosts: [] })
	expect(() =>
		save(String(ec.privateKey.export({ type: 'sec1', format: 'pem' }))),
	).not.toThrow()
	expect(() => save('hmac-material-checked-at-signing-time')).not.toThrow()
	const error = caught(() =>
		save(String(rsa.publicKey.export({ type: 'spki', format: 'pem' }))),
	)
	expect(isMcpCallerError(error)).toBe(true)
	expect(error.message).toContain('BEGIN PUBLIC KEY')
})
