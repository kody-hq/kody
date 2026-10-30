import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildExecuteToolArgs } from '../src/cli.js'
import {
	formatExecuteCapabilityResult,
	resolveRemoteExecuteCode,
	runRemoteExecuteWithToken,
} from '../src/remote-execute.js'
import {
	isPublishedPackageInvokeSpecifier,
	parseExecuteInvokeSpecifier,
} from '../src/invoke-passthrough.js'

test('parseExecuteInvokeSpecifier normalizes @scope and hash exports', () => {
	assert.equal(
		parseExecuteInvokeSpecifier('kody:@scope/pkg/export'),
		'kody:@scope/pkg/export',
	)
	assert.equal(
		parseExecuteInvokeSpecifier('@scope/pkg#export'),
		'kody:@scope/pkg/export',
	)
	assert.throws(
		() => parseExecuteInvokeSpecifier('https://example.com/x'),
		/Unsupported/,
	)
})

test('isPublishedPackageInvokeSpecifier distinguishes local export keys', () => {
	assert.equal(
		isPublishedPackageInvokeSpecifier('kody:@scope/pkg/export'),
		true,
	)
	assert.equal(isPublishedPackageInvokeSpecifier('@scope/pkg#export'), true)
	assert.equal(isPublishedPackageInvokeSpecifier('@scope/pkg/export'), true)
	assert.equal(isPublishedPackageInvokeSpecifier('./greet'), false)
	assert.equal(isPublishedPackageInvokeSpecifier('.'), false)
	assert.equal(
		isPublishedPackageInvokeSpecifier('https://example.com/x'),
		false,
	)
})

test('resolveRemoteExecuteCode prefers invoke minting and rejects empty input', () => {
	assert.match(
		resolveRemoteExecuteCode({ invoke: '@scope/pkg#go' }),
		/kody:@scope\/pkg\/go/,
	)
	assert.equal(
		resolveRemoteExecuteCode({ code: 'export default () => 1' }),
		'export default () => 1',
	)
	assert.throws(() => resolveRemoteExecuteCode({}), /Provide --invoke, --code/)
	assert.throws(
		() => resolveRemoteExecuteCode({ code: 'a', invoke: 'kody:@x/y' }),
		/--invoke cannot be combined/,
	)
})

test('formatExecuteCapabilityResult maps ok/error envelopes', () => {
	const ok = formatExecuteCapabilityResult({
		ok: true,
		conversationId: 'c1',
		result: { hi: 1 },
		logs: [],
	})
	assert.equal(ok.isError, false)
	assert.match(ok.content[0]?.text ?? '', /"hi": 1/)
	const failed = formatExecuteCapabilityResult({
		ok: false,
		error: 'boom',
		logs: ['[error] boom'],
	})
	assert.equal(failed.isError, true)
	assert.equal(failed.content[0]?.text, 'Error: boom')
})

test('formatExecuteCapabilityResult keeps ranOn and names where it ran', () => {
	const ranOn = {
		kind: 'context',
		id: 'ec_box',
		name: 'build-box',
		yours: true,
		attempts: [{ target: 'ec_box', name: 'build-box', outcome: 'ran' }],
		fellBackToCloud: false,
	}
	const ran = formatExecuteCapabilityResult({
		ok: true,
		result: 1,
		logs: [],
		ranOn,
		executionContext: { id: 'ec_box', name: 'build-box' },
	})
	assert.deepEqual(
		(ran.structuredContent as Record<string, unknown>).ranOn,
		ranOn,
	)
	assert.deepEqual(
		(ran.structuredContent as Record<string, unknown>).executionContext,
		{
			id: 'ec_box',
			name: 'build-box',
		},
	)
	assert.equal(ran.content.at(-1)?.text, 'Ran on build-box (your machine).')
	const cloud = formatExecuteCapabilityResult({
		ok: false,
		error: 'boom',
		logs: [],
		ranOn: { kind: 'cloud', id: 'cloud', name: 'Kody cloud' },
	})
	assert.equal(cloud.content.at(-1)?.text, 'Ran on Kody cloud.')
	assert.ok(!JSON.stringify(ran.content).includes('ec_box'))
})

test('runRemoteExecuteWithToken posts /v1/execute', async () => {
	const calls: Array<{ method: string; url: string; body: unknown }> = []
	const fetchFn = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const url = String(input)
		const body = init?.body ? JSON.parse(String(init.body)) : null
		calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url, body })
		return new Response(
			JSON.stringify({ ok: true, result: { ran: true }, logs: [] }),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		)
	}) as typeof fetch

	const result = await runRemoteExecuteWithToken({
		code: 'export default async () => ({ ran: true })',
		params: { a: 1 },
		token: 'tok',
		apiUrl: 'https://api.kody.codes',
		fetchFn,
	})
	assert.equal(result.isError, false)
	assert.deepEqual(JSON.parse(result.content[0]?.text ?? ''), { ran: true })
	assert.equal(calls.length, 1)
	assert.equal(calls[0]!.method, 'POST')
	assert.match(calls[0]!.url, /\/v1\/execute$/)
	assert.deepEqual(calls[0]!.body, {
		code: 'export default async () => ({ ran: true })',
		params: { a: 1 },
	})

	calls.length = 0
	const invokeArgs = buildExecuteToolArgs({ invoke: '@scope/pkg#go' })
	await runRemoteExecuteWithToken({
		code: invokeArgs.code as string,
		token: 'tok',
		apiUrl: 'https://api.kody.codes',
		fetchFn,
	})
	assert.deepEqual(calls[0]!.body, {
		code: resolveRemoteExecuteCode({ invoke: '@scope/pkg#go' }),
	})
})

test('runRemoteExecuteWithToken surfaces missing-token session 401 clearly', async () => {
	const fetchFn = (async () =>
		new Response(
			JSON.stringify({ error: { code: 'unauthorized', message: 'nope' } }),
			{
				status: 401,
				headers: { 'content-type': 'application/json' },
			},
		)) as typeof fetch
	await assert.rejects(
		() =>
			runRemoteExecuteWithToken({
				code: 'export default () => 1',
				token: 'kody_at_bad',
				apiUrl: 'https://api.kody.codes',
				fetchFn,
			}),
		/rejected the API token[\s\S]*cliCredentialBootstrap[\s\S]*never ask a human to paste a token[\s\S]*unset or replace that rejected value/,
	)
})

test('runRemoteExecuteWithToken refuses to send the token over cleartext http', async () => {
	await assert.rejects(
		() =>
			runRemoteExecuteWithToken({
				code: 'export default () => 1',
				token: 'tok',
				apiUrl: 'http://api.example.com',
			}),
		/Refusing to send the API token|https/,
	)
})

test('runRemoteExecuteWithToken surfaces insufficient_scope on session', async () => {
	const fetchFn = (async () =>
		new Response(
			JSON.stringify({
				error: { code: 'insufficient_scope', message: 'need local-execute' },
			}),
			{ status: 403, headers: { 'content-type': 'application/json' } },
		)) as typeof fetch
	await assert.rejects(
		() =>
			runRemoteExecuteWithToken({
				code: 'export default () => 1',
				token: 'tok',
				apiUrl: 'https://api.kody.codes',
				fetchFn,
			}),
		/insufficient_scope[\s\S]*cliCredentialBootstrap[\s\S]*tokenCreate[\s\S]*local-execute/,
	)
})
