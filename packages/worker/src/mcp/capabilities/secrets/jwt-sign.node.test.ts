import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	constants,
	createHmac,
	createVerify,
	generateKeyPairSync,
	timingSafeEqual,
	verify,
} from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { lookupSecretsThroughResolveSecret } from '#worker/test-support/secret-lookup.ts'
import { isMcpCallerError, McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createSecretScopeUnavailableMessage } from '#mcp/secrets/errors.ts'
import * as secretService from '#mcp/secrets/service.ts'
import * as unresolvedSecret from '#mcp/secrets/unresolved-secret.ts'
import { personalOrgAccessD1 } from '#worker/test-support/org-binding-query.ts'
import * as sealedToken from '#worker/credentials/sealed-token.ts'
import { jwtSignCapability } from './jwt-sign.ts'
import { decodeHmacKeyMaterial, extractSecretMaterial } from './jwt-signing.ts'

const pem = { type: 'pkcs8', format: 'pem' } as const
const spki = { type: 'spki', format: 'pem' } as const
const ctx = {
	env: {
		APP_DB: personalOrgAccessD1(),
		SENTRY_ENVIRONMENT: 'test',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env,
	callerContext: createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		user: {
			userId: personIdFromStored('user-123'),
			email: 'user@example.com',
			displayName: 'User',
		},
	}),
}
type SignInput = Parameters<typeof jwtSignCapability.handler>[0]

function createKeyPair() {
	return generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: spki,
		privateKeyEncoding: pem,
	})
}

function createEcKeyPair(namedCurve: 'prime256v1' | 'secp384r1' | 'secp521r1') {
	return generateKeyPairSync('ec', {
		namedCurve,
		publicKeyEncoding: spki,
		privateKeyEncoding: pem,
	})
}

function stubSecret(value: string | null) {
	return vi.spyOn(secretService, 'resolveSecret').mockResolvedValue({
		credentialId: value === null ? null : 'cred-signing-key',
		found: value !== null,
		value,
		scope: value === null ? null : 'user',
		allowedHosts: [],
		allowedPackages: [],
		placement: null,
	})
}

/** Signs, checks the result is sealed, and returns the JWT it sealed. */
async function signWith(
	value: string,
	input: SignInput,
	context: Parameters<typeof jwtSignCapability.handler>[1] = ctx,
) {
	stubSecret(value)
	const seal = vi.spyOn(sealedToken, 'sealToken')
	const result = await jwtSignCapability.handler(input, context)
	const sealedInput = seal.mock.calls.at(-1)?.[0]
	seal.mockRestore()
	if (!sealedInput) throw new Error('secretJwtSign returned an unsealed JWT.')
	expect(result.jwt).not.toContain(sealedInput.value)
	expect(result.jwt).toMatch(
		/^\{\{integration-token:kody-sealed\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\}\}$/,
	)
	return { ...result, jwt: sealedInput.value, sealedTo: sealedInput.to }
}

function decodeJwtPart(value: string | undefined) {
	return JSON.parse(
		Buffer.from(value ?? '', 'base64url').toString('utf8'),
	) as Record<string, unknown>
}

function jwtParts(jwt: string) {
	const [header, claims, signature] = jwt.split('.')
	return {
		header: decodeJwtPart(header),
		claims: decodeJwtPart(claims),
		data: `${header}.${claims}`,
		signature: Buffer.from(signature ?? '', 'base64url'),
	}
}

function verifyRsaJwt(jwt: string, publicKey: string, hash: string) {
	const { data, signature } = jwtParts(jwt)
	return createVerify(`RSA-${hash}`).update(data).verify(publicKey, signature)
}

function verifyHmacJwt(
	jwt: string,
	keyBytes: Uint8Array,
	hash: 'sha256' | 'sha384' | 'sha512',
) {
	const { data, signature } = jwtParts(jwt)
	const expected = createHmac(hash, keyBytes).update(data).digest()
	return (
		expected.length === signature.length && timingSafeEqual(expected, signature)
	)
}

function rejectsWithoutLeaking(fragment: string, leaked: string) {
	return (error: unknown) => {
		const message = error instanceof Error ? error.message : String(error)
		return message.includes(fragment) && !message.includes(leaked)
	}
}

test('secretJwtSign resolves keys and never leaks key material', async () => {
	lookupSecretsThroughResolveSecret()
	const { privateKey, publicKey } = createKeyPair()
	const signed = await signWith(privateKey, {
		private_key_secret_name: 'serviceAccountKey',
		algorithm: 'RS256',
		header: { kid: 'key-1' },
		claims: {
			iss: 'service@example.com',
			sub: 'user@example.com',
			aud: 'https://example.com/token',
			iat: 1,
			exp: 3601,
		},
	})
	const rs256 = jwtParts(signed.jwt)
	expect(signed.jwt.split('.').every(Boolean)).toBe(true)
	expect(signed.algorithm).toBe('RS256')
	expect(rs256.header).toMatchObject({
		alg: 'RS256',
		typ: 'JWT',
		kid: 'key-1',
	})
	expect(rs256.claims).toMatchObject({
		iss: 'service@example.com',
		sub: 'user@example.com',
	})
	expect(verifyRsaJwt(signed.jwt, publicKey, 'SHA256')).toBe(true)
	expect(signed.jwt).not.toContain('PRIVATE KEY')

	const ed25519 = generateKeyPairSync('ed25519', {
		publicKeyEncoding: spki,
		privateKeyEncoding: pem,
	})
	const edSigned = await signWith(ed25519.privateKey, {
		private_key_secret_name: 'originAppPrivateKey',
		algorithm: 'EdDSA',
		header: { kid: 'app_01example' },
		claims: { iss: 'app_01example', aud: 'origin-apps', iat: 1, exp: 301 },
	})
	const ed = jwtParts(edSigned.jwt)
	expect(edSigned.algorithm).toBe('EdDSA')
	expect(ed.header).toMatchObject({
		alg: 'EdDSA',
		typ: 'JWT',
		kid: 'app_01example',
	})
	expect(ed.claims).toEqual({
		iss: 'app_01example',
		aud: 'origin-apps',
		iat: 1,
		exp: 301,
	})
	expect(
		verify(null, Buffer.from(ed.data), ed25519.publicKey, ed.signature),
	).toBe(true)
	expect(edSigned.jwt).not.toContain(ed25519.privateKey)

	const jsonSigned = await signWith(
		JSON.stringify({
			client_email: 'service@example.com',
			private_key: privateKey,
		}),
		{
			private_key_secret_name: 'serviceAccountJson',
			private_key_json_field: 'private_key',
			algorithm: 'RS256',
			claims: { iss: 'service@example.com' },
		},
	)
	expect(verifyRsaJwt(jsonSigned.jwt, publicKey, 'SHA256')).toBe(true)

	stubSecret(null)
	await expect(
		jwtSignCapability.handler(
			{
				private_key_secret_name: 'missingKey',
				algorithm: 'RS256',
				claims: { iss: 'service@example.com' },
			},
			ctx,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			isMcpCallerError(error) &&
			error.message === 'Secret "missingKey" was not found.',
	)

	const scopeUnavailableMessage = createSecretScopeUnavailableMessage([
		{
			secretName: 'cortexReadKey',
			scope: 'package',
			packageId: 'pkg-cortex-read',
			packageName: 'cortex-read',
			sessionId: null,
			editorUrl: null,
		},
	])
	vi.spyOn(unresolvedSecret, 'createUnresolvedSecretMessage').mockResolvedValue(
		scopeUnavailableMessage,
	)
	await expect(
		jwtSignCapability.handler(
			{
				private_key_secret_name: 'cortexReadKey',
				algorithm: 'RS256',
				claims: { iss: 'service@example.com' },
			},
			ctx,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			isMcpCallerError(error) &&
			error.message === scopeUnavailableMessage,
	)

	expect(() =>
		extractSecretMaterial({
			secretValue: JSON.stringify({ private_key: 'super-secret-key' }),
			jsonField: 'missing_key',
		}),
	).toThrow(
		'Signing key secret JSON field "missing_key" must be a non-empty string.',
	)
})

test('secretJwtSign signs HMAC JWTs from encoded secrets', async () => {
	lookupSecretsThroughResolveSecret()
	const hmacKey = Buffer.from('doordash-test-signing-key-32byte')
	const utf8Secret = 'door-dash-utf8-hmac-secret-padded-to-48-bytes!!!'
	const hs512Key = Buffer.alloc(64, 7)
	const invalidBase64 = '%%%not-valid-base64%%%'
	const doorDashClaims = {
		aud: 'doordash',
		iss: 'developer-id',
		kid: 'key-id',
		iat: 1,
		exp: 301,
	}
	const hs256 = {
		private_key_secret_name: 'doorDashSigningSecret',
		algorithm: 'HS256',
		claims: { aud: 'doordash' },
	} as const

	const signed = await signWith(hmacKey.toString('base64'), {
		...hs256,
		header: { 'dd-ver': 'DD-JWT-V1' },
		claims: doorDashClaims,
	})
	expect(signed.jwt.split('.').every(Boolean)).toBe(true)
	expect(signed.algorithm).toBe('HS256')
	expect(jwtParts(signed.jwt).header).toEqual({
		alg: 'HS256',
		typ: 'JWT',
		'dd-ver': 'DD-JWT-V1',
	})
	expect(jwtParts(signed.jwt).claims).toEqual(doorDashClaims)
	expect(verifyHmacJwt(signed.jwt, hmacKey, 'sha256')).toBe(true)
	expect(signed.jwt).not.toContain(hmacKey.toString('base64'))
	expect(signed.jwt).not.toContain(hmacKey.toString('utf8'))
	await expect(
		jwtSignCapability.handler({ ...hs256, header: { alg: 'RS256' } }, ctx),
	).rejects.toThrow('JWT header alg must match the requested algorithm.')

	const utf8Signed = await signWith(utf8Secret, {
		private_key_secret_name: 'utf8HmacSecret',
		algorithm: 'HS384',
		key_encoding: 'utf8',
		claims: { aud: 'example' },
	})
	expect(utf8Signed.algorithm).toBe('HS384')
	expect(jwtParts(utf8Signed.jwt).header).toMatchObject({ alg: 'HS384' })
	expect(
		verifyHmacJwt(utf8Signed.jwt, Buffer.from(utf8Secret, 'utf8'), 'sha384'),
	).toBe(true)
	expect(utf8Signed.jwt).not.toContain(utf8Secret)

	const base64urlSigned = await signWith(hs512Key.toString('base64url'), {
		private_key_secret_name: 'base64urlHmacSecret',
		algorithm: 'HS512',
		key_encoding: 'base64url',
		claims: { aud: 'example' },
	})
	expect(base64urlSigned.algorithm).toBe('HS512')
	expect(verifyHmacJwt(base64urlSigned.jwt, hs512Key, 'sha512')).toBe(true)

	const jsonSigned = await signWith(
		JSON.stringify({ signing_secret: hmacKey.toString('base64') }),
		{ ...hs256, private_key_json_field: 'signing_secret' },
	)
	expect(verifyHmacJwt(jsonSigned.jwt, hmacKey, 'sha256')).toBe(true)

	const shortHs256Secret = 'too-short-for-hs256'
	await expect(
		signWith(Buffer.from(shortHs256Secret).toString('base64'), hs256),
	).rejects.toSatisfy(
		rejectsWithoutLeaking(
			'HMAC signing key for HS256 must be at least 32 bytes.',
			shortHs256Secret,
		),
	)
	await expect(
		signWith(hmacKey.toString('utf8'), {
			...hs256,
			algorithm: 'HS512',
			key_encoding: 'utf8',
		}),
	).rejects.toThrow('HMAC signing key for HS512 must be at least 64 bytes.')
	await expect(signWith(invalidBase64, hs256)).rejects.toSatisfy(
		rejectsWithoutLeaking(
			'HMAC signing key secret is not valid base64.',
			invalidBase64,
		),
	)
	await expect(
		signWith(invalidBase64, { ...hs256, key_encoding: 'hex' } as never),
	).rejects.toSatisfy(
		rejectsWithoutLeaking(
			'Invalid input for capability "secretJwtSign"',
			invalidBase64,
		),
	)
	await expect(
		signWith(invalidBase64, { ...hs256, key_encoding: 'base64url' }),
	).rejects.toThrow('HMAC signing key secret is not valid base64url.')
	await expect(
		signWith(hmacKey.toString('base64'), {
			private_key_secret_name: 'rsaKey',
			algorithm: 'RS256',
			key_encoding: 'base64',
			claims: { iss: 'service@example.com' },
		}),
	).rejects.toThrow(
		'key_encoding is only valid when algorithm is HS256, HS384, or HS512.',
	)
	await expect(
		signWith(hmacKey.toString('base64'), {
			...hs256,
			algorithm: 'none',
		} as never),
	).rejects.toThrow(/Invalid input for capability "secretJwtSign"/)
})

test('secretJwtSign signs RS, PS, and ES JWTs from PKCS#8 PEM secrets', async () => {
	lookupSecretsThroughResolveSecret()
	const rsa = createKeyPair()
	const p256 = createEcKeyPair('prime256v1')
	const p384 = createEcKeyPair('secp384r1')
	const p521 = createEcKeyPair('secp521r1')
	const claims = { iss: 'service@example.com', aud: 'example' }
	const signWithPem = (
		privateKey: string,
		algorithm: 'RS384' | 'RS512' | 'PS256' | 'ES256' | 'ES384' | 'ES512',
	) =>
		signWith(privateKey, {
			private_key_secret_name: 'signingKey',
			algorithm,
			claims,
		})
	const verifyEc = (jwt: string, hash: string, publicKey: string): boolean => {
		const { data, signature } = jwtParts(jwt)
		return verify(
			hash,
			Buffer.from(data),
			{ key: publicKey, dsaEncoding: 'ieee-p1363' },
			signature,
		)
	}

	const rs384 = await signWithPem(rsa.privateKey, 'RS384')
	expect(rs384.algorithm).toBe('RS384')
	expect(jwtParts(rs384.jwt).header).toMatchObject({ alg: 'RS384' })
	expect(verifyRsaJwt(rs384.jwt, rsa.publicKey, 'SHA384')).toBe(true)
	expect(rs384.jwt).not.toContain('PRIVATE KEY')
	const rs512 = await signWithPem(rsa.privateKey, 'RS512')
	expect(verifyRsaJwt(rs512.jwt, rsa.publicKey, 'SHA512')).toBe(true)

	const ps256 = await signWithPem(rsa.privateKey, 'PS256')
	const ps256Parts = jwtParts(ps256.jwt)
	expect(ps256.algorithm).toBe('PS256')
	expect(
		verify(
			'sha256',
			Buffer.from(ps256Parts.data),
			{
				key: rsa.publicKey,
				padding: constants.RSA_PKCS1_PSS_PADDING,
				saltLength: 32,
			},
			ps256Parts.signature,
		),
	).toBe(true)

	const es256 = await signWithPem(p256.privateKey, 'ES256')
	expect(es256.algorithm).toBe('ES256')
	expect(verifyEc(es256.jwt, 'sha256', p256.publicKey)).toBe(true)
	const es384 = await signWithPem(p384.privateKey, 'ES384')
	expect(verifyEc(es384.jwt, 'sha384', p384.publicKey)).toBe(true)
	const es512 = await signWithPem(p521.privateKey, 'ES512')
	expect(verifyEc(es512.jwt, 'sha512', p521.publicKey)).toBe(true)

	await expect(
		signWith(p256.privateKey, {
			private_key_secret_name: 'signingKey',
			algorithm: 'ES256',
			key_encoding: 'utf8',
			claims,
		}),
	).rejects.toThrow(
		'key_encoding is only valid when algorithm is HS256, HS384, or HS512.',
	)
})

test('decodeHmacKeyMaterial accepts encodings and rejects invalid input without leaking the key', () => {
	lookupSecretsThroughResolveSecret()
	const hmacKey = Buffer.from('doordash-test-signing-key-32byte')
	const utf8Secret = 'plain-hmac-secret-32-bytes-long!'
	const decode = (
		secretValue: string,
		encoding: 'base64' | 'base64url' | 'utf8',
		algorithm: 'HS256' | 'HS384' = 'HS256',
	) => decodeHmacKeyMaterial({ secretValue, encoding, algorithm })

	const accepted = [
		[hmacKey.toString('base64'), 'base64', hmacKey],
		[` ${hmacKey.toString('base64')}\n`, 'base64', hmacKey],
		[hmacKey.toString('base64url'), 'base64url', hmacKey],
		[utf8Secret, 'utf8', Buffer.from(utf8Secret)],
	] as const
	for (const [secretValue, encoding, expected] of accepted) {
		expect(Buffer.from(decode(secretValue, encoding))).toEqual(expected)
	}

	const invalid = '%%%not-valid-base64%%%'
	const rejected = [
		[
			invalid,
			'base64',
			'HS256',
			'HMAC signing key secret is not valid base64.',
		],
		[
			invalid,
			'base64url',
			'HS256',
			'HMAC signing key secret is not valid base64url.',
		],
		[
			'',
			'utf8',
			'HS256',
			'HMAC signing key secret must be a non-empty string.',
		],
		[
			hmacKey.toString('base64'),
			'base64',
			'HS384',
			'HMAC signing key for HS384 must be at least 48 bytes.',
		],
	] as const
	for (const [secretValue, encoding, algorithm, message] of rejected) {
		expect(() => decode(secretValue, encoding, algorithm)).toThrow(message)
	}
	expect(() => decode(invalid, 'base64')).toThrow(
		expect.objectContaining({
			message: expect.not.stringContaining(invalid),
		}),
	)
})

test('secretJwtSign accepts opaque {{secret:…}} refs and remaps share-grant guests to the package owner', async () => {
	lookupSecretsThroughResolveSecret()
	const { privateKey } = createKeyPair()
	const refInput = {
		private_key_secret_name: '{{secret:serviceAccountKey|scope=user}}',
		algorithm: 'RS256',
		claims: { iss: 'service@example.com', iat: 1, exp: 3601 },
	} as const
	const signed = await signWith(privateKey, refInput)
	expect(signed.jwt.split('.')).toHaveLength(3)
	expect(secretService.resolveSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-123'),
			name: 'serviceAccountKey',
			scope: 'user',
		}),
	)
	expect(JSON.stringify(signed)).not.toContain('PRIVATE KEY')
})

test('secretJwtSign seals the JWT to the aud URL or send_to_host domain', async () => {
	lookupSecretsThroughResolveSecret()
	const { privateKey } = createKeyPair()
	const claims = { iss: 'app', iat: 1, exp: 3601 }
	const byAudience = await signWith(privateKey, {
		private_key_secret_name: 'serviceAccountKey',
		algorithm: 'RS256',
		claims: { ...claims, aud: 'https://oauth2.example.com/token' },
	})
	expect(byAudience.sealedTo).toMatchObject({
		binding: null,
		domains: ['example.com'],
	})
	const byHost = await signWith(privateKey, {
		private_key_secret_name: 'serviceAccountKey',
		algorithm: 'RS256',
		send_to_host: 'api.example.org',
		claims: { ...claims, aud: 'not-a-url' },
	})
	expect(byHost.sealedTo.domains).toEqual(['example.org'])
	expect(byAudience.warning).toBeUndefined()
	expect(byHost.warning).toBeUndefined()
	const anyHost = await signWith(privateKey, {
		private_key_secret_name: 'serviceAccountKey',
		algorithm: 'RS256',
		claims,
	})
	expect(anyHost.sealedTo.domains).toEqual([sealedToken.anySealedTokenDomain])
	expect(anyHost.warning).toMatch(/Deprecated: .*Pass send_to_host/)
})

test('secretJwtSign rejects a send_to_host that is not a bare host', async () => {
	lookupSecretsThroughResolveSecret()
	const { privateKey } = createKeyPair()
	for (const sendToHost of [' ', 'https://api.example.com/x']) {
		await expect(
			signWith(privateKey, {
				private_key_secret_name: 'serviceAccountKey',
				algorithm: 'RS256',
				send_to_host: sendToHost,
				claims: { iss: 'app', aud: 'not-a-url' },
			}),
		).rejects.toThrow(/send_to_host must be a bare host/)
	}
})

test('secretJwtSign binds the sealed JWT to the host-set run binding', async () => {
	lookupSecretsThroughResolveSecret()
	const { privateKey } = createKeyPair()
	const signed = await signWith(
		privateKey,
		{
			private_key_secret_name: 'serviceAccountKey',
			algorithm: 'RS256',
			claims: { iss: 'app', aud: 'https://api.example.com/' },
		},
		{ ...ctx, credentialClientBinding: 'run:example' },
	)
	expect(signed.sealedTo.binding).toBe('run:example')
})
