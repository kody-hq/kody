/**
 * Reads a stored private key into PKCS#8 DER, the only private-key format
 * WebCrypto imports. PKCS#1 RSA (`BEGIN RSA PRIVATE KEY`) and SEC1 EC
 * (`BEGIN EC PRIVATE KEY`) keys, which GitHub Apps, OpenSSL, and many other
 * tools emit, are wrapped in a PrivateKeyInfo. Every failure is a
 * caller-clearable {@link McpCallerError}; messages name the PEM label found
 * but never repeat key material.
 */
import { base64ToBytes } from '@kody-internal/shared/base64.ts'
import { McpCallerError } from '#mcp/caller-error.ts'

export type PrivateKeyFormat = 'PKCS#8' | 'PKCS#1 RSA' | 'SEC1 EC'

export const acceptedPrivateKeyPems =
	'Kody accepts an unencrypted PEM private key: BEGIN PRIVATE KEY (PKCS#8), BEGIN RSA PRIVATE KEY (PKCS#1), or BEGIN EC PRIVATE KEY (SEC1).'

const convertHint =
	'To convert one, run: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem'

const pemBlockPattern =
	/-----BEGIN ([A-Z0-9 ]{1,60})-----([\s\S]*?)-----END \1-----/g

const labelFormats: Record<string, PrivateKeyFormat> = {
	'PRIVATE KEY': 'PKCS#8',
	'RSA PRIVATE KEY': 'PKCS#1 RSA',
	'EC PRIVATE KEY': 'SEC1 EC',
}

// AlgorithmIdentifier { rsaEncryption, NULL }
const rsaEncryptionAlgorithm = [
	0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
	0x05, 0x00,
]
// OID 1.2.840.10045.2.1 (id-ecPublicKey)
const ecPublicKeyOid = [0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]
const pkcs8Version = [0x02, 0x01, 0x00]

/**
 * Returns the PKCS#8 DER for the first private-key PEM block in `value`. A
 * value with no PEM armor is read as base64 PKCS#8 DER. Literal `\n` escapes
 * (a PEM pasted from JSON or a `.env` file) count as newlines.
 */
export function privateKeyPemToPkcs8(value: string): {
	der: Uint8Array<ArrayBuffer>
	format: PrivateKeyFormat
} {
	const text = value.replace(/\\r\\n|\\n/g, '\n')
	const blocks = [...text.matchAll(pemBlockPattern)]
	if (blocks.length === 0) {
		if (text.includes('-----BEGIN ')) {
			throw new McpCallerError(
				`The signing key has a PEM header without a matching END line. ${acceptedPrivateKeyPems}`,
			)
		}
		return { der: decodeBody(text, null), format: 'PKCS#8' }
	}
	const block = blocks.find(([, label]) => label! in labelFormats)
	if (!block) throw unsupportedLabelError(blocks[0]![1]!)
	const label = block[1]!
	const body = block[2]!
	const format = labelFormats[label]!
	if (/^Proc-Type:\s*4,ENCRYPTED/im.test(body)) {
		throw new McpCallerError(
			`The signing key's BEGIN ${label} block is encrypted. ${acceptedPrivateKeyPems} ${convertHint}`,
		)
	}
	const der = decodeBody(body, label)
	switch (format) {
		case 'PKCS#8':
			return { der, format }
		case 'PKCS#1 RSA':
			return { der: wrapPkcs8(rsaEncryptionAlgorithm, der), format }
		case 'SEC1 EC':
			return {
				der: wrapPkcs8(
					derTlv(0x30, [...ecPublicKeyOid, ...sec1CurveOid(der)]),
					der,
				),
				format,
			}
		default: {
			const exhaustive: never = format
			throw new Error(`Unhandled private key format: ${String(exhaustive)}`)
		}
	}
}

/** Imports a stored private key for signing; `fits` says what the algorithm needs. */
export async function importPrivateKeyPem(input: {
	value: string
	algorithm:
		| AlgorithmIdentifier
		| RsaHashedImportParams
		| HmacImportParams
		| EcKeyImportParams
	fits: string
}) {
	const { der, format } = privateKeyPemToPkcs8(input.value)
	try {
		return await crypto.subtle.importKey('pkcs8', der, input.algorithm, false, [
			'sign',
		])
	} catch {
		throw new McpCallerError(
			`The signing key (${format}) could not be imported for ${input.fits}. Check the key type and curve, and that the PEM is complete.`,
		)
	}
}

function unsupportedLabelError(label: string) {
	if (/PUBLIC KEY|CERTIFICATE/.test(label)) {
		return new McpCallerError(
			`The signing key is a BEGIN ${label} PEM block, which holds no private key. ${acceptedPrivateKeyPems}`,
		)
	}
	return new McpCallerError(
		`The signing key is a BEGIN ${label} PEM block. ${acceptedPrivateKeyPems} ${convertHint}`,
	)
}

function decodeBody(body: string, label: string | null) {
	const base64 = body.replace(/\s/g, '')
	const where = label ? `BEGIN ${label} block` : 'value'
	if (!base64) {
		throw new McpCallerError(
			label
				? `The signing key's ${where} is empty.`
				: `The signing key is empty. ${acceptedPrivateKeyPems}`,
		)
	}
	let der: Uint8Array
	try {
		der = base64ToBytes(base64)
	} catch {
		throw new McpCallerError(
			label
				? `The signing key's ${where} is not valid base64.`
				: `The signing key is not a PEM private key. ${acceptedPrivateKeyPems}`,
		)
	}
	return new Uint8Array(der)
}

type DerElement = { tag: number; start: number; end: number }

function readDer(bytes: Uint8Array, offset: number): DerElement {
	const tag = bytes[offset]
	let length = bytes[offset + 1]
	let start = offset + 2
	if (tag === undefined || length === undefined) throw malformedSec1()
	if (length & 0x80) {
		const count = length & 0x7f
		if (count === 0 || count > 4) throw malformedSec1()
		length = 0
		for (let index = 0; index < count; index += 1) {
			const byte = bytes[start + index]
			if (byte === undefined) throw malformedSec1()
			length = length * 256 + byte
		}
		start += count
	}
	const end = start + length
	if (end > bytes.length) throw malformedSec1()
	return { tag, start, end }
}

/** The namedCurve OID (whole TLV) from a SEC1 ECPrivateKey's `[0]` parameters. */
function sec1CurveOid(der: Uint8Array) {
	const outer = readDer(der, 0)
	if (outer.tag !== 0x30) throw malformedSec1()
	const version = readDer(der, outer.start)
	const privateKey = readDer(der, version.end)
	if (version.tag !== 0x02 || privateKey.tag !== 0x04) throw malformedSec1()
	let offset = privateKey.end
	while (offset < outer.end) {
		const field = readDer(der, offset)
		if (field.tag === 0xa0) {
			const oid = readDer(der, field.start)
			if (oid.tag !== 0x06) break
			return [...der.subarray(field.start, oid.end)]
		}
		offset = field.end
	}
	throw new McpCallerError(
		`The signing key's BEGIN EC PRIVATE KEY block does not name its curve. ${convertHint}`,
	)
}

function malformedSec1() {
	return new McpCallerError(
		"The signing key's BEGIN EC PRIVATE KEY block is not a valid SEC1 EC key.",
	)
}

function derLength(length: number) {
	if (length < 0x80) return [length]
	const bytes: Array<number> = []
	for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
		bytes.unshift(rest & 0xff)
	}
	return [0x80 | bytes.length, ...bytes]
}

function derTlv(tag: number, content: ArrayLike<number>) {
	return [tag, ...derLength(content.length), ...Array.from(content)]
}

/** PrivateKeyInfo { version 0, algorithm, OCTET STRING privateKey }. */
function wrapPkcs8(algorithm: Array<number>, privateKey: Uint8Array) {
	const octet = [0x04, ...derLength(privateKey.length)]
	const bodyLength =
		pkcs8Version.length + algorithm.length + octet.length + privateKey.length
	const out = new Uint8Array(1 + derLength(bodyLength).length + bodyLength)
	out.set([
		0x30,
		...derLength(bodyLength),
		...pkcs8Version,
		...algorithm,
		...octet,
	])
	out.set(privateKey, out.length - privateKey.length)
	return out
}
