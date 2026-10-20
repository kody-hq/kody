import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	formatExecuteCapabilityResult,
	resolveRemoteExecuteCode,
	runRemoteExecuteWithToken,
} from '../src/remote-execute.js'
import {
	buildExecuteInvokePassthroughSource,
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

test('buildExecuteInvokePassthroughSource matches the MCP thin glue shape', () => {
	assert.equal(
		buildExecuteInvokePassthroughSource('kody:@me/pkg/export'),
		`import action from "kody:@me/pkg/export"

export default async function main(params) {
	return await action(params)
}`,
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
	await runRemoteExecuteWithToken({
		invoke: '@scope/pkg#go',
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
		/rejected the API token[\s\S]*cliCredentialBootstrap[\s\S]*never ask a human to paste a token/,
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
