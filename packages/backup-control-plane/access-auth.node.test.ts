import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
	assertSameOriginMutation,
	resetAccessJwksCacheForTests,
	verifyAccessJwt,
} from './access-auth.ts'
import { BackupError } from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'
import {
	accessClaims,
	accessSigner,
	backupError,
	environment,
} from './backup-control-plane-test-support.ts'

function verify(
	env: BackupEnvironment,
	jwt: string | null,
	fetcher: typeof fetch,
) {
	return verifyAccessJwt(
		env,
		new Request('https://backup.example/', {
			headers: jwt === null ? {} : { 'cf-access-jwt-assertion': jwt },
		}),
		fetcher,
	)
}

test('verifyAccessJwt accepts self-signed RS256 Access assertions, including service tokens with common_name', async () => {
	resetAccessJwksCacheForTests()
	const { fetcher, sign } = accessSigner()
	const env = environment()
	const identity = await verify(env, sign(accessClaims(env)), fetcher)
	assert.equal(identity.email, 'ops@example.com')

	const serviceToken = sign(
		accessClaims(env, {
			email: undefined,
			common_name: 'cursor-seal-operator',
		}),
	)
	assert.equal(
		(await verify(env, serviceToken, fetcher)).email,
		env.ACCESS_ALLOWED_EMAIL,
	)
})

test('verifyAccessJwt rejects wrong aud, email, iss, expiry, signature, and missing header', async () => {
	resetAccessJwksCacheForTests()
	const { fetcher, sign } = accessSigner()
	const env = environment()

	await assert.rejects(
		verify(env, null, fetcher),
		backupError('access-jwt-missing'),
	)
	for (const [overrides, code] of [
		[{ aud: 'other-aud' }, 'access-jwt-aud-mismatch'],
		[{ iss: 'https://other.example' }, 'access-jwt-iss-mismatch'],
		[{ email: 'other@example.com' }, 'access-jwt-email-denied'],
		[{ exp: Math.floor(Date.now() / 1000) - 120 }, 'access-jwt-expired'],
	] as const) {
		await assert.rejects(
			verify(env, sign(accessClaims(env, overrides)), fetcher),
			backupError(code),
		)
	}

	const tampered = `${sign(accessClaims(env)).slice(0, -4)}abcd`
	await assert.rejects(
		verify(env, tampered, fetcher),
		(error: unknown) =>
			error instanceof BackupError &&
			(error.code === 'access-jwt-bad-signature' ||
				error.code === 'access-jwt-malformed'),
	)
})

test('unknown kid refreshes once and JWKS fetch failures use structured errors', async () => {
	resetAccessJwksCacheForTests()
	const env = environment()
	const { jwks, sign } = accessSigner()
	const unknownKidJwt = sign(accessClaims(env), 'missing-kid')
	let fetches = 0
	const fetcher = async () => {
		fetches += 1
		return Response.json(jwks)
	}

	await assert.rejects(
		verify(env, unknownKidJwt, fetcher),
		backupError('access-jwt-unknown-kid'),
	)
	assert.equal(fetches, 2) // initial cache fill + one forced refresh
	await assert.rejects(
		verify(env, unknownKidJwt, fetcher),
		backupError('access-jwt-unknown-kid'),
	)
	assert.equal(fetches, 2) // cooldown: no additional JWKS fetch

	resetAccessJwksCacheForTests()
	await assert.rejects(
		verify(env, sign(accessClaims(env)), async () => {
			throw new DOMException('The operation was aborted', 'AbortError')
		}),
		backupError('access-jwks-fetch-failed'),
	)
})

test('assertSameOriginMutation rejects absent or cross-site Sec-Fetch-Site', () => {
	const mutation = (secFetchSite?: string) =>
		assertSameOriginMutation(
			new Request('https://backup.example/actions/run-backup', {
				method: 'POST',
				headers: secFetchSite ? { 'sec-fetch-site': secFetchSite } : {},
			}),
		)
	for (const secFetchSite of [undefined, 'none']) {
		assert.throws(() => mutation(secFetchSite), backupError('csrf-rejected'))
	}
	assert.doesNotThrow(() => mutation('same-origin'))
})
