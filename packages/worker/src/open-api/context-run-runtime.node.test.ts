import { expect, test } from 'vitest'
import { type ApiInvocationContext } from './context.ts'
import {
	assertContextRunRuntimePathAllowed,
	assertContextRunSpecialPathAllowed,
} from './native-operation-helpers.ts'

function contextRun(
	runtime: { mode: 'all' } | { mode: 'allowlist'; paths: Array<string> },
	byOperator = false,
) {
	return {
		principal: {
			kind: 'execution-context-run',
			ecid: 'ec_test',
			runId: 'run_test',
			deadline: Date.now() + 60_000,
			scopes: null,
			runtime,
			byOperator,
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

test("only the operator's own context runs start workflows", () => {
	expect(() =>
		assertContextRunSpecialPathAllowed(contextRun({ mode: 'all' }), [
			'workflows',
			'create',
		]),
	).toThrow(/Only this execution context's operator can start workflows/)
	expect(() =>
		assertContextRunSpecialPathAllowed(contextRun({ mode: 'all' }, true), [
			'workflows',
			'create',
		]),
	).not.toThrow()
})

test('every context run makes credentialed runtime calls, as in Kody cloud', () => {
	for (const name of [
		'authenticatedFetch',
		'gatewayFetch',
		'oauthClientCredentials',
		'credentialClientCheck',
	]) {
		for (const byOperator of [true, false]) {
			expect(() =>
				assertContextRunSpecialPathAllowed(
					contextRun({ mode: 'all' }, byOperator),
					['kody', name],
				),
			).not.toThrow()
		}
	}
})
