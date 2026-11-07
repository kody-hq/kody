import { createVerify, generateKeyPairSync } from 'node:crypto'
import { expect, test } from 'vitest'
import { CredentialRequestRefusedError } from './credential-request.ts'
import {
	type HttpSignatureOperation,
	importRsaSigningKey,
	prepareHttpSignature,
	signHttpRequest,
	signRawRsaSha256,
} from './http-signature.ts'

// Generated for this test run only; never a real key.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
})
const pkcs8Pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const pkcs1Pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
const keyId =
	'ocid1.tenancy.oc1..test/ocid1.user.oc1..test/20:3b:97:13:55:1c:5b:0d:d3:37:d8:50:4e:c5:3a:34'
const date = 'Thu, 05 Jan 2014 21:31:40 GMT'

function verify(signingString: string, signature: string) {
	const verifier = createVerify('RSA-SHA256')
	verifier.update(signingString)
	return verifier.verify(publicKey, signature, 'base64')
}

function parseAuthorization(header: string) {
	expect(header.startsWith('Signature ')).toBe(true)
	return Object.fromEntries(
		[...header.slice('Signature '.length).matchAll(/(\w+)="([^"]*)"/g)].map(
			(match) => [match[1]!, match[2]!],
		),
	)
}

async function refusal(promise: Promise<unknown>) {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(error).toBeInstanceOf(CredentialRequestRefusedError)
	return error as CredentialRequestRefusedError
}

const oracleGet: HttpSignatureOperation = {
	type: 'http-signature',
	keyId,
	method: 'GET',
	url: 'https://iaas.us-phoenix-1.oraclecloud.com/20160918/instances?availabilityDomain=Pjwf%3A%20PHX-AD-1&compartmentId=ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa&displayName=TeamXInstances&volumeId=ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q',
	headers: { date },
}

test('Oracle GET: the documented signing string and Authorization header', async () => {
	const prepared = await prepareHttpSignature(oracleGet)
	// Oracle's "Request Signatures" GET example, headers in Oracle's order.
	expect(prepared.signingString).toBe(
		[
			`date: ${date}`,
			'(request-target): get /20160918/instances?availabilityDomain=Pjwf%3A%20PHX-AD-1&compartmentId=ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa&displayName=TeamXInstances&volumeId=ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q',
			'host: iaas.us-phoenix-1.oraclecloud.com',
		].join('\n'),
	)
	const headers = await signHttpRequest(pkcs8Pem, oracleGet, prepared)
	expect(Object.keys(headers)).toEqual(['authorization'])
	const params = parseAuthorization(headers.authorization!)
	expect(params).toMatchObject({
		version: '1',
		keyId,
		algorithm: 'rsa-sha256',
		headers: 'date (request-target) host',
	})
	expect(verify(prepared.signingString, params.signature!)).toBe(true)
	expect(headers.authorization).toMatch(
		/^Signature version="1",keyId="[^"]+",algorithm="rsa-sha256",headers="date \(request-target\) host",signature="[A-Za-z0-9+/=]+"$/,
	)
})

test('Oracle POST: x-content-sha256, content-length, and content-type are computed and signed', async () => {
	const body =
		'{\n    "compartmentId": "ocid1.compartment.oc1..test",\n    "instanceId": "ocid1.instance.oc1.phx.test"\n}'
	const operation: HttpSignatureOperation = {
		type: 'http-signature',
		keyId,
		method: 'POST',
		url: 'https://iaas.us-phoenix-1.oraclecloud.com/20160918/volumeAttachments',
		headers: { date, 'Content-Type': 'application/json' },
		body,
	}
	const prepared = await prepareHttpSignature(operation)
	const digest = Buffer.from(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)),
	).toString('base64')
	expect(prepared.signingString).toBe(
		[
			`date: ${date}`,
			'(request-target): post /20160918/volumeAttachments',
			'host: iaas.us-phoenix-1.oraclecloud.com',
			`content-length: ${new TextEncoder().encode(body).byteLength}`,
			'content-type: application/json',
			`x-content-sha256: ${digest}`,
		].join('\n'),
	)
	const headers = await signHttpRequest(pkcs1Pem, operation, prepared)
	expect(headers['x-content-sha256']).toBe(digest)
	expect(headers['content-length']).toBe(String(Buffer.byteLength(body)))
	const params = parseAuthorization(headers.authorization!)
	expect(params.headers).toBe(
		'date (request-target) host content-length content-type x-content-sha256',
	)
	expect(verify(prepared.signingString, params.signature!)).toBe(true)
})

test('Oracle PUT with no body signs the empty-body digest', async () => {
	const prepared = await prepareHttpSignature({
		...oracleGet,
		method: 'PUT',
		url: 'https://objectstorage.us-ashburn-1.oraclecloud.com/n/ns/b/bucket',
	})
	expect(prepared.addedHeaders).toEqual({
		'x-content-sha256': '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
		'content-length': '0',
		'content-type': 'application/json',
	})
})

test('generic draft-cavage: Signature header with a Digest and Kody-set date', async () => {
	const now = new Date('2026-11-07T17:00:00.000Z')
	const operation: HttpSignatureOperation = {
		type: 'http-signature',
		profile: 'generic',
		keyId: 'test-key',
		method: 'post',
		url: 'https://api.example.com:8443/a%20b/c?x=1&y=two',
		headers: { 'X-Extra': '  padded value  ' },
		body: 'hello',
		signedHeaders: ['(request-target)', 'host', 'date', 'digest', 'x-extra'],
	}
	const prepared = await prepareHttpSignature(operation, { now })
	expect(prepared.signingString).toBe(
		[
			'(request-target): post /a%20b/c?x=1&y=two',
			'host: api.example.com:8443',
			'date: Sat, 07 Nov 2026 17:00:00 GMT',
			'digest: SHA-256=LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=',
			'x-extra: padded value',
		].join('\n'),
	)
	expect(prepared.host).toBe('api.example.com')
	const headers = await signHttpRequest(pkcs8Pem, operation, prepared)
	expect(headers.date).toBe('Sat, 07 Nov 2026 17:00:00 GMT')
	expect(headers.digest).toBe(
		'SHA-256=LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=',
	)
	expect(headers.authorization).toBeUndefined()
	const signature = /signature="([^"]+)"/.exec(headers.signature!)![1]!
	expect(headers.signature).toMatch(
		/^keyId="test-key",algorithm="rsa-sha256",headers="\(request-target\) host date digest x-extra",signature="/,
	)
	expect(verify(prepared.signingString, signature)).toBe(true)
})

test('a caller-supplied digest or length that does not match the body is refused', async () => {
	const base = {
		type: 'http-signature' as const,
		keyId,
		method: 'POST',
		url: 'https://iaas.us-phoenix-1.oraclecloud.com/x',
		body: '{"a":1}',
	}
	expect(
		(
			await refusal(
				prepareHttpSignature({
					...base,
					headers: { 'x-content-sha256': 'not-the-digest' },
				}),
			)
		).message,
	).toContain('does not match the body')
	await refusal(
		prepareHttpSignature({ ...base, headers: { 'content-length': '999' } }),
	)
	await refusal(prepareHttpSignature({ ...oracleGet, body: 'sneaky' }))
})

test('the signature always binds the destination host and request target', async () => {
	await refusal(
		prepareHttpSignature({ ...oracleGet, signedHeaders: ['date', 'host'] }),
	)
	await refusal(
		prepareHttpSignature({
			...oracleGet,
			signedHeaders: ['date', '(request-target)'],
		}),
	)
	expect(
		(
			await refusal(
				prepareHttpSignature({
					...oracleGet,
					headers: { date, host: 'evil.example.com' },
				}),
			)
		).message,
	).toBe('The host header must match the URL host.')
	await refusal(
		prepareHttpSignature({
			...oracleGet,
			method: 'POST',
			signedHeaders: ['date', '(request-target)', 'host'],
			body: '{}',
		}),
	)
})

test('requests that cannot be signed safely are refused before any key is read', async () => {
	const cases: Array<Partial<HttpSignatureOperation>> = [
		{ url: 'http://iaas.us-phoenix-1.oraclecloud.com/x' },
		{ url: 'https://user:pw@iaas.us-phoenix-1.oraclecloud.com/x' },
		{ url: 'https://iaas.us-phoenix-1.oraclecloud.com/x#frag' },
		{ url: 'not a url' },
		{ method: 'GET\r\nX: y' },
		{ keyId: 'a"b' },
		{ headers: { date: 'x\r\ninjected: 1' } },
		{ headers: { authorization: 'Bearer x' } },
		{ headers: { Date: date, date } },
		{ signedHeaders: ['date', '(request-target)', 'host', 'x-missing'] },
		{ scheme: 'rfc9421' as 'draft-cavage' },
	]
	for (const change of cases) {
		const error = await refusal(
			prepareHttpSignature({ ...oracleGet, ...change }),
		)
		expect(['invalid_request', 'insecure_transport']).toContain(error.code)
	}
})

test('raw RSA-SHA256 signs the bytes given, in each encoding', async () => {
	const message = 'any string at all'
	const base64 = await signRawRsaSha256(pkcs8Pem, {
		type: 'rsa-sha256',
		message,
	})
	expect(verify(message, base64)).toBe(true)
	const hex = await signRawRsaSha256(pkcs1Pem, {
		type: 'rsa-sha256',
		message: Buffer.from(message).toString('base64'),
		messageEncoding: 'base64',
		encoding: 'hex',
	})
	expect(Buffer.from(hex, 'hex').toString('base64')).toBe(base64)
	const url = await signRawRsaSha256(pkcs8Pem, {
		type: 'rsa-sha256',
		message,
		encoding: 'base64url',
	})
	expect(Buffer.from(url, 'base64url').toString('base64')).toBe(base64)
	const fromJson = await signRawRsaSha256(
		JSON.stringify({ private_key: pkcs8Pem }),
		{ type: 'rsa-sha256', message, jsonField: 'private_key' },
	)
	expect(fromJson).toBe(base64)
})

test('a bad or encrypted key fails without the key in the error', async () => {
	const encrypted = privateKey.export({
		type: 'pkcs1',
		format: 'pem',
		cipher: 'aes-256-cbc',
		passphrase: 'test-only',
	}) as string
	const broken = pkcs8Pem.replace(/[A-Za-z0-9]{20}\n/, 'AAAAAAAAAAAAAAAAAAAA\n')
	for (const pem of [encrypted, broken, 'not a key']) {
		const error = await importRsaSigningKey(pem).then(
			() => null,
			(caught: unknown) => caught as Error,
		)
		expect(error?.message).toContain('unencrypted RSA private key')
		const body = pkcs8Pem.split('\n')[1]!
		expect(error?.message).not.toContain(body)
		expect(String(error?.stack)).not.toContain(body)
	}
})
