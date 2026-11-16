import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { executeParityCases } from '@kody-internal/shared/execute-parity.fixture.ts'
import type { EcpRunRequestBody } from '@kody-internal/shared/execution-context-protocol/index.ts'
import { runContextRun } from '../src/execution-context/run-executor.js'
import { runLocalExecute } from '../src/local-execute.js'
import { localExecuteGatewayFetchShimModuleName } from '../src/local-package-graph.js'

const graphServer = createServer(async (request, response) => {
	for await (const _chunk of request) {
		// Drain the package graph request body.
	}
	response.writeHead(200, { 'content-type': 'application/json' })
	response.end(
		JSON.stringify({
			modules: [
				{
					name: localExecuteGatewayFetchShimModuleName,
					esModule: 'export {}\n',
				},
			],
			imports: [],
			packageBindings: {},
			packageIdsByImport: {},
		}),
	)
})
let apiUrl = ''

before(async () => {
	await new Promise<void>((resolve) =>
		graphServer.listen(0, '127.0.0.1', resolve),
	)
	apiUrl = `http://127.0.0.1:${(graphServer.address() as AddressInfo).port}`
})

after(() => {
	graphServer.close()
})

type RunResult = {
	isError?: boolean
	content?: unknown
	structuredContent?: unknown
}

function assertMatchesCase(
	result: RunResult,
	expected: (typeof executeParityCases)[number]['expected'],
) {
	const text = JSON.stringify(result.content)
	if ('errorIncludes' in expected) {
		assert.equal(result.isError, true, text)
		assert.ok(text.includes(expected.errorIncludes), text)
		return
	}
	assert.equal(result.isError, false, text)
	const structured = result.structuredContent as {
		result: unknown
		logs: Array<string>
	}
	assert.deepEqual(structured.result, expected.result)
	for (const line of expected.logs ?? []) {
		assert.ok(structured.logs.includes(line), JSON.stringify(structured.logs))
	}
}

for (const parity of executeParityCases) {
	test(`execute --local parity: ${parity.name}`, async () => {
		const result = await runLocalExecute({
			code: parity.code,
			params: parity.params ?? {},
			token: 'kody_tok_parity',
			apiUrl,
		})
		assertMatchesCase(result as RunResult, parity.expected)
	})

	test(`execution context parity: ${parity.name}`, async () => {
		const request: EcpRunRequestBody = {
			runId: 'run_parity',
			deadline: Date.now() + 60_000,
			acceptBy: Date.now() + 60_000,
			requestedBy: {
				userId: 'user_parity',
				handle: 'parity',
				orgId: 'org_parity',
				orgSlug: 'parity',
			},
			source: { kind: 'code', code: parity.code, sha256: 'x' },
			params: parity.params ?? {},
			credentialPicks: {},
			limits: { timeoutMs: 60_000, maxResultBytes: 102_400, memoryMb: 512 },
			grantVersion: 1,
			apiUrl,
		}
		const result = await runContextRun({
			request,
			fetchFn: fetch,
			signal: new AbortController().signal,
			apiUrl,
		})
		assertMatchesCase(result, parity.expected)
	})
}
