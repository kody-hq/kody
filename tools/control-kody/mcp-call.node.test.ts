import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	executeAppMcp,
	formatMcpCallReport,
	readJsonObjectFile,
	searchAppMcp,
} from './mcp-call.ts'
import {
	readExecuteResult,
	readMcpToolPayload,
	readSearchResult,
} from './mcp-tool-result.ts'

test('control-kody MCP execute and search reuse the OAuth client and print structured results', async () => {
	const parent = await mkdtemp(path.join(tmpdir(), 'control-kody-mcp-'))
	try {
		const codeFile = path.join(parent, 'fixture.ts')
		const paramsFile = path.join(parent, 'params.json')
		await writeFile(
			codeFile,
			'export default async function main(params) { return params }\n',
		)
		await writeFile(paramsFile, '{"kody_id":"preview-pkg"}\n')
		expect(await readJsonObjectFile(paramsFile)).toEqual({
			kody_id: 'preview-pkg',
		})
		await expect(
			writeFile(path.join(parent, 'array.json'), '[]\n').then(() =>
				readJsonObjectFile(path.join(parent, 'array.json')),
			),
		).rejects.toThrow(/must contain a JSON object/)

		const execute = await executeAppMcp({
			origin: 'https://kody-pr-9.kody.workers.dev',
			email: 'me@kentcdodds.com',
			password: 'ilikecode',
			code: await readFile(codeFile, 'utf8'),
			params: { kody_id: 'preview-pkg' },
			connect: async () => ({
				cookieHeader: 'kody_session=abc',
				client: {
					async callTool(params, options) {
						expect(params.name).toBe('execute')
						expect(options?.timeout).toBeGreaterThan(60_000)
						expect(options?.resetTimeoutOnProgress).toBe(true)
						expect(params.arguments).toEqual({
							code: expect.stringContaining('export default'),
							params: { kody_id: 'preview-pkg' },
						})
						return {
							isError: false,
							structuredContent: {
								result: { ok: true, kody_id: 'preview-pkg' },
							},
						}
					},
				},
			}),
		})
		expect(execute).toMatchObject({
			ok: true,
			tool: 'execute',
			result: { ok: true, kody_id: 'preview-pkg' },
			cookieHeader: 'kody_session=abc',
		})
		expect(formatMcpCallReport(execute)).toContain('"kody_id": "preview-pkg"')

		const search = await searchAppMcp({
			origin: 'https://kody-pr-9.kody.workers.dev',
			email: 'me@kentcdodds.com',
			password: 'ilikecode',
			query: 'packageSave',
			domain: 'packages',
			connect: async () => ({
				cookieHeader: 'kody_session=abc',
				client: {
					async callTool(params) {
						expect(params.name).toBe('search')
						expect(params.arguments).toEqual({
							query: 'packageSave',
							domain: 'packages',
						})
						return {
							isError: false,
							structuredContent: {
								conversationId: 'conv-1',
								result: { matches: [{ id: 'packageSave' }] },
							},
						}
					},
				},
			}),
		})
		expect(search.result).toEqual({ matches: [{ id: 'packageSave' }] })

		const oauth = {
			clientId: 'client-1',
			clientSecret: 'secret-1',
			redirectUri: 'http://127.0.0.1/oauth/callback',
			accessToken: 'token-team',
		}
		const seen: Array<unknown> = []
		const orgConnect = async (
			_origin: string,
			_user: { email: string },
			options: unknown,
		) => {
			seen.push(options)
			return {
				cookieHeader: 'kody_session=abc',
				oauth,
				client: {
					async callTool() {
						return {
							isError: false,
							structuredContent: { result: { ok: true } },
						}
					},
				},
			}
		}
		await executeAppMcp({
			origin: 'https://kody-pr-9.kody.workers.dev',
			email: 'me@kentcdodds.com',
			password: 'ilikecode',
			code: 'export default async function main() { return 1 }',
			orgSlug: 'x-org',
			cookieHeader: 'kody_session=abc',
			oauth,
			connect: orgConnect,
		})
		await searchAppMcp({
			origin: 'https://kody-pr-9.kody.workers.dev',
			email: 'me@kentcdodds.com',
			password: 'ilikecode',
			query: 'packageSave',
			orgSlug: 'x-org',
			connect: orgConnect,
		})
		expect(seen).toEqual([
			{
				cookieHeader: 'kody_session=abc',
				oauth,
				orgSlug: 'x-org',
			},
			{
				cookieHeader: undefined,
				oauth: undefined,
				orgSlug: 'x-org',
			},
		])

		await expect(
			executeAppMcp({
				origin: 'https://kody.codes',
				email: 'me@kentcdodds.com',
				password: 'ilikecode',
				code: 'export default async function main() { return 1 }',
			}),
		).rejects.toThrow(/refuses to run against https:\/\/kody\.codes/)
		await expect(
			searchAppMcp({
				origin: 'https://www.kody.codes.',
				email: 'me@kentcdodds.com',
				password: 'ilikecode',
				query: 'packageSave',
			}),
		).rejects.toThrow(/refuses to run against https:\/\/kody\.codes/)

		expect(
			readExecuteResult({
				isError: false,
				structuredContent: { result: { ok: true } },
			}),
		).toEqual({ ok: true })
		expect(
			readExecuteResult({
				isError: false,
				structuredContent: { result: null },
			}),
		).toBeNull()
		expect(
			readExecuteResult({
				isError: false,
				structuredContent: {
					inProgress: true,
					runId: 'run-follow-budget',
					idempotencyKey: 'execute:budget-key',
				},
			}),
		).toEqual({
			inProgress: true,
			runId: 'run-follow-budget',
			idempotencyKey: 'execute:budget-key',
		})
		expect(
			readSearchResult({
				isError: false,
				structuredContent: {
					conversationId: 'conv-1',
					result: { matches: [{ id: 'packageSave' }] },
				},
			}),
		).toEqual({ matches: [{ id: 'packageSave' }] })
		expect(() =>
			readExecuteResult({
				isError: true,
				content: [{ type: 'text', text: 'Saved package not found' }],
				structuredContent: { error: 'missing' },
			}),
		).toThrow(/MCP tool failed: Saved package not found/)
		expect(
			readMcpToolPayload({
				isError: false,
				content: [{ type: 'text', text: 'no structured payload' }],
			}),
		).toBe('no structured payload')
	} finally {
		await rm(parent, { recursive: true, force: true })
	}
})
