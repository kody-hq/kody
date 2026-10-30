import { expect, test } from 'vitest'
import { type ContextRunCredentials } from '#worker/execution-contexts/credential-grant.ts'
import { type ApiInvocationContext } from './context.ts'
import {
	assertContextRunRuntimePathAllowed,
	assertContextRunSpecialPathAllowed,
} from './native-operation-helpers.ts'

function contextRun(
	runtime: { mode: 'all' } | { mode: 'allowlist'; paths: Array<string> },
	credentials: ContextRunCredentials = { mode: 'none' },
) {
	return {
		principal: {
			kind: 'execution-context-run',
			ecid: 'ec_test',
			runId: 'run_test',
			deadline: Date.now() + 60_000,
			scopes: null,
			runtime,
			credentials,
		},
	} as unknown as ApiInvocationContext
}

test('a context run may only call runtime paths its grant allows', () => {
	expect(() =>
		assertContextRunRuntimePathAllowed(contextRun({ mode: 'all' }), [
			'kody',
			'emailSend',
		]),
	).not.toThrow()
	const allowlist = contextRun({
		mode: 'allowlist',
		paths: ['kody.packageStorageGet'],
	})
	expect(() =>
		assertContextRunRuntimePathAllowed(allowlist, [
			'kody',
			'packageStorageGet',
		]),
	).not.toThrow()
	expect(() =>
		assertContextRunRuntimePathAllowed(allowlist, ['kody', 'emailSend']),
	).toThrow(/does not allow kody\.emailSend/)
})

test('other principals are not narrowed by a context grant', () => {
	const token = {
		principal: { kind: 'mcp-oauth' },
	} as unknown as ApiInvocationContext
	expect(() =>
		assertContextRunRuntimePathAllowed(token, ['kody', 'emailSend']),
	).not.toThrow()
})

test('context runs never start workflows', () => {
	expect(() =>
		assertContextRunSpecialPathAllowed(contextRun({ mode: 'all' }), [
			'workflows',
			'create',
		]),
	).toThrow(/cannot start workflows/)
})

test('credentialed runtime calls need a grant that allows credentials', () => {
	for (const name of [
		'authenticatedFetch',
		'gatewayFetch',
		'oauthClientCredentials',
		'credentialClientCheck',
	]) {
		expect(() =>
			assertContextRunSpecialPathAllowed(contextRun({ mode: 'all' }), [
				'kody',
				name,
			]),
		).toThrow(/allows no credentials/)
		expect(() =>
			assertContextRunSpecialPathAllowed(
				contextRun({ mode: 'all' }, { mode: 'list', ids: ['cred_test'] }),
				['kody', name],
			),
		).not.toThrow()
		expect(() =>
			assertContextRunSpecialPathAllowed(
				contextRun({ mode: 'all' }, { mode: 'requester' }),
				['kody', name],
			),
		).not.toThrow()
		expect(() =>
			assertContextRunSpecialPathAllowed(
				contextRun({ mode: 'all' }, { mode: 'requester_shared' }),
				['kody', name],
			),
		).toThrow(/only while it is not shared/)
	}
	expect(() =>
		assertContextRunSpecialPathAllowed(contextRun({ mode: 'all' }), [
			'kody',
			'packageStorageGet',
		]),
	).not.toThrow()
})
