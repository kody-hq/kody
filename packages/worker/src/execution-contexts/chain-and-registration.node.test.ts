import { expect, test } from 'vitest'
import { chainCloudOrderError } from './chain-rules.ts'
import { registrationAuthorizationError } from './errors.ts'
import { serverKeySetDocument } from './key-routes.ts'
import productionServerKeys from './server-keys.production.json'
import testServerKeys from './server-keys.local.json'
import testKeys from '@kody-internal/shared/execution-context-protocol/vectors/test-keys.json'
import { chainIsTooLong } from './store.ts'

test('Kody cloud must be the last chain entry when present', () => {
	expect(chainCloudOrderError([])).toBeNull()
	expect(chainCloudOrderError([{ kind: 'cloud' }])).toBeNull()
	expect(
		chainCloudOrderError([
			{ kind: 'context', id: 'ec_a' },
			{ kind: 'context', id: 'ec_b' },
			{ kind: 'cloud' },
		]),
	).toBeNull()
	// A strict chain (no cloud) is allowed.
	expect(chainCloudOrderError([{ kind: 'context', id: 'ec_a' }])).toBeNull()

	const cloudFirst = chainCloudOrderError([
		{ kind: 'cloud' },
		{ kind: 'context', id: 'ec_a' },
	])
	expect(cloudFirst).toEqual({
		cloudIndex: 0,
		message: expect.stringContaining('Kody cloud must be the last entry'),
	})
	expect(
		chainCloudOrderError([
			{ kind: 'context', id: 'ec_a' },
			{ kind: 'cloud' },
			{ kind: 'context', id: 'ec_b' },
		])?.cloudIndex,
	).toBe(1)
})

test('a chain holds at most 3 contexts, and Kody cloud does not count toward the cap', () => {
	const contexts = (n: number) =>
		Array.from({ length: n }, (_, i) => ({
			kind: 'context' as const,
			id: `ec_${i}`,
		}))
	expect(chainIsTooLong([...contexts(3), { kind: 'cloud' }])).toBe(false)
	expect(chainIsTooLong(contexts(3))).toBe(false)
	expect(chainIsTooLong([...contexts(4), { kind: 'cloud' }])).toBe(true)
	expect(chainIsTooLong(contexts(4))).toBe(true)
})

test('registration with a login that predates execution context permissions names the exact login command', () => {
	const error = registrationAuthorizationError({ code: 'credential_scope' })
	expect(error.status).toBe(403)
	expect(error.code).toBe('insufficient_scope')
	expect(error.message).toContain(
		'Your Kody login predates execution context permissions',
	)
	expect(error.message).toContain('Run `kody login` again')
	expect(error.details).toEqual({
		reason: 'credential_scope',
		requiredScope: 'execution_context:create',
		loginCommand: 'kody login',
	})
})

test('registration without the permission at all is a plain denial, not a re-login prompt', () => {
	const error = registrationAuthorizationError({ code: 'missing_permission' })
	expect(error.code).toBe('not_granted')
	expect(error.message).not.toContain('kody login')
	expect(error.details).toMatchObject({ reason: 'missing_permission' })
})

test('server-keys serves the test set only when the signer is a test key', () => {
	const testSigner = JSON.stringify([
		{ ...testKeys.server, notAfter: 4102444800000 },
	])
	expect(serverKeySetDocument({ ECP_FRAME_SIGNING_KEYS: testSigner })).toBe(
		testServerKeys,
	)
	// Production (or any env without the test signer) serves the production set.
	expect(serverKeySetDocument({ ECP_FRAME_SIGNING_KEYS: undefined })).toBe(
		productionServerKeys,
	)
	expect(serverKeySetDocument({ ECP_FRAME_SIGNING_KEYS: 'not json' })).toBe(
		productionServerKeys,
	)
	const productionSigner = JSON.stringify([
		{ ...testKeys.server, kid: 'ecp-frame-2026-10', notAfter: 4102444800000 },
	])
	expect(
		serverKeySetDocument({ ECP_FRAME_SIGNING_KEYS: productionSigner }),
	).toBe(productionServerKeys)
})
