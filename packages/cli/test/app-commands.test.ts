import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	appFetchOutMaxBytes,
	parseAppFetchCommand,
	runAppFetchPlan,
	runAppList,
} from '../src/app-commands.js'

function recorder(result: unknown) {
	const calls: Array<{ operationId: string; params: Record<string, unknown> }> =
		[]
	return {
		calls,
		call: async (operationId: string, params: Record<string, unknown>) => {
			calls.push({ operationId, params })
			return typeof result === 'function' ? result(params) : result
		},
	}
}

const ok = {
	status: 200,
	headers: { 'content-type': 'text/plain' },
	body: 'hello',
	body_encoding: 'text',
	truncated: false,
}

test('app fetch parses the address, path, method, headers, and body', () => {
	assert.deepEqual(
		parseAppFetchCommand({
			positionals: ['@acme/board', '/api/cards'],
			values: {
				method: 'POST',
				header: ['Content-Type: application/json', 'X-Trace:a:b'],
				body: '@card.json',
				out: 'out.bin',
			},
		}),
		{
			app: '@acme/board',
			path: '/api/cards',
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Trace': 'a:b' },
			body: { file: 'card.json' },
			out: 'out.bin',
			synthetic: false,
		},
	)
	assert.throws(
		() => parseAppFetchCommand({ positionals: [], values: {} }),
		/Usage: kody app fetch/,
	)
	assert.throws(
		() =>
			parseAppFetchCommand({
				positionals: ['@acme/board'],
				values: { header: ['nope'] },
			}),
		/--header takes "Name: value"/,
	)
})

test('app fetch takes the org from the address and refuses a different --org', () => {
	assert.equal(
		parseAppFetchCommand({
			positionals: ['@acme/board'],
			values: {},
			org: 'Acme',
		}).app,
		'@acme/board',
	)
	assert.throws(
		() =>
			parseAppFetchCommand({
				positionals: ['@acme/board'],
				values: {},
				org: 'other',
			}),
		/already names the org \(@acme\)\. Drop --org other/,
	)
	assert.throws(
		() =>
			parseAppFetchCommand({
				positionals: ['https://board--acme.kody.run/'],
				values: {},
				org: 'acme',
			}),
		/A hosted URL already names the app and its org\. Drop --org\./,
	)
})

test('app fetch prints the body at the default cap and only raises it with --out', async () => {
	const api = recorder(ok)
	const out: Array<string> = []
	const err: Array<string> = []
	const code = await runAppFetchPlan({
		plan: { app: '@acme/board', path: '/x', synthetic: true },
		call: api.call,
		json: false,
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
	})
	assert.equal(code, 0)
	assert.deepEqual(api.calls, [
		{
			operationId: 'appFetch',
			params: { app: '@acme/board', path: '/x', synthetic: true },
		},
	])
	assert.deepEqual(out, ['hello\n'])
	assert.match(err.join(''), /HTTP 200/)

	const dir = await mkdtemp(join(tmpdir(), 'kody-app-fetch-'))
	const bodyFile = join(dir, 'body.json')
	const outFile = join(dir, 'out.bin')
	await writeFile(bodyFile, '{"a":1}')
	const binary = recorder({
		...ok,
		body: Buffer.from([0, 1, 2, 255]).toString('base64'),
		body_encoding: 'base64',
	})
	const printed: Array<string> = []
	await runAppFetchPlan({
		plan: {
			app: '@acme/board',
			body: { file: bodyFile },
			out: outFile,
			synthetic: false,
		},
		call: binary.call,
		json: true,
		stdout: (text) => printed.push(text),
		stderr: () => {},
	})
	assert.deepEqual(binary.calls[0]?.params, {
		app: '@acme/board',
		body: '{"a":1}',
		max_bytes: appFetchOutMaxBytes,
	})
	assert.equal(appFetchOutMaxBytes, 10 * 1024 * 1024)
	assert.deepEqual([...(await readFile(outFile))], [0, 1, 2, 255])
	assert.deepEqual(JSON.parse(printed.join('')), {
		status: 200,
		headers: { 'content-type': 'text/plain' },
		truncated: false,
		out: outFile,
		bytes: 4,
	})
})

test('app list follows pages and filters by org', async () => {
	const app = (name: string, shared: boolean) => ({
		app: name,
		owner: name.slice(1).split('/')[0],
		name,
		package_id: `pkg-${name}`,
		description: '',
		hosted_url: `https://example.test/${name}`,
		visibility: 'private',
		shared,
	})
	const api = recorder((params: Record<string, unknown>) =>
		params.cursor
			? { apps: [app('@kent/mine', false)], next_cursor: null }
			: { apps: [app('@acme/board', true)], next_cursor: '1' },
	)
	const text = await runAppList({ call: api.call, json: false, org: 'acme' })
	assert.deepEqual(
		api.calls.map((call) => call.params),
		[{ owner: 'acme' }, { owner: 'acme', cursor: '1' }],
	)
	assert.match(text, /@acme\/board .* private, shared with you\n@kent\/mine /)
	const empty = recorder({ apps: [], next_cursor: null })
	assert.match(
		await runAppList({ call: empty.call, json: false }),
		/No apps you can run yet/,
	)
})
