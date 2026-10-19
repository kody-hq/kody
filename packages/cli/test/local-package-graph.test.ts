import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	fetchLocalPackageGraph,
	hasLiteralDynamicSavedPackageImports,
	hasSavedPackageImports,
	listSavedPackageImports,
	LocalPackageGraphError,
	localExecuteGatewayFetchShimModuleName,
	localPackageGraphPath,
	localPackageGraphPlatformIssueUrl,
	packageGraphInlineCodePreferImportsChars,
	resolveLocalPackageGraph,
	synthesizePackageGraphEntry,
} from '../src/local-package-graph.js'

const goodToken = 'kody_tok_pkg'

test('listSavedPackageImports finds static and literal-dynamic kody:@ specifiers', async () => {
	assert.deepEqual(
		await listSavedPackageImports(`import skill from 'kody:@me/skills/get'`),
		['kody:@me/skills/get'],
	)
	assert.deepEqual(
		await listSavedPackageImports(
			`const m = await import("kody:@me/skills/get")`,
		),
		['kody:@me/skills/get'],
	)
	assert.deepEqual(
		await listSavedPackageImports(`
import { a } from 'kody:@a/pkg/one'
import b from "kody:@b/pkg/two"
export default async () => {
  const c = await import('kody:@a/pkg/one')
  return c
}`),
		['kody:@a/pkg/one', 'kody:@b/pkg/two'],
	)
	assert.equal(
		await hasSavedPackageImports(`import { kody } from 'kody:runtime'`),
		false,
	)
	assert.equal(
		await hasLiteralDynamicSavedPackageImports(`import x from 'kody:@me/p/e'`),
		false,
	)
	assert.equal(
		await hasLiteralDynamicSavedPackageImports(`await import('kody:@me/p/e')`),
		true,
	)
})

test('listSavedPackageImports ignores kody:@ specifiers inside strings and comments', async () => {
	assert.deepEqual(
		await listSavedPackageImports(`
import post from 'kody:@kentcdodds/discord/post-message'
const hint = "import scan from 'kody:@kentcdodds/gift-cliff-ops/scan'"
const hint2 = 'from "kody:@kentcdodds/gift-cliff-ops/settings"'
// import dead from 'kody:@dead/pkg/x'
/* import block from 'kody:@dead/pkg/y' */
/**
 * importPattern: from 'kody:@kentcdodds/linkedin/<utility-name>'
 */
export default async () => post
`),
		['kody:@kentcdodds/discord/post-message'],
	)
	assert.equal(
		await hasLiteralDynamicSavedPackageImports(
			`const docs = "await import('kody:@me/p/e')"; export default async () => 1`,
		),
		false,
	)
})

test('fetchLocalPackageGraph rejects literal dynamic kody:@ imports before calling the API', async () => {
	const code = `const m = await import('kody:@me/skills/get')
export default async () => m`
	await assert.rejects(
		() =>
			fetchLocalPackageGraph({
				apiUrl: 'http://127.0.0.1:9',
				token: goodToken,
				code,
				fetchFn: async () => {
					throw new Error('should not fetch')
				},
			}),
		(error: unknown) => {
			assert.ok(error instanceof LocalPackageGraphError)
			assert.match(error.message, /literal dynamic import/)
			assert.match(error.message, /2808/)
			assert.equal(error.code, 'unsupported_dynamic_package_import')
			return true
		},
	)
})

test('fetchLocalPackageGraph posts even when there are no kody:@ imports to load the gateway-fetch shim', async () => {
	const code = `export default async function main() {
  return fetch('https://api.example.com', {
    headers: { authorization: 'Bearer {{secret:cloudflarePagesApiToken}}' },
  })
}`
	const requests: Array<{ url: string; body: unknown }> = []
	const result = await fetchLocalPackageGraph({
		apiUrl: 'https://api.kody.codes',
		token: goodToken,
		code,
		fetchFn: async (input, init) => {
			requests.push({
				url: String(input),
				body: init?.body ? JSON.parse(String(init.body)) : null,
			})
			return new Response(
				JSON.stringify({
					imports: [],
					warnings: [],
					modules: [
						{
							name: localExecuteGatewayFetchShimModuleName,
							esModule: 'export {}\n',
						},
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		},
	})
	assert.equal(requests.length, 1)
	assert.match(requests[0]!.url, new RegExp(`${localPackageGraphPath}$`))
	// Zero imports still POSTs (for the shim) with an empty synthetic entry.
	assert.deepEqual(requests[0]!.body, {
		code: synthesizePackageGraphEntry([]),
		imports: [],
	})
	assert.deepEqual(result, {
		imports: [],
		modules: [
			{
				name: localExecuteGatewayFetchShimModuleName,
				esModule: 'export {}\n',
			},
		],
	})
})

test('fetchLocalPackageGraph posts code + imports and returns embeddable modules', async () => {
	const code = `import { greet } from 'kody:@test/pkg/hello'
export default async function main(params) { return greet(params.name) }`
	const requests: Array<{
		url: string
		body: unknown
		authorization: string | null
	}> = []
	const result = await fetchLocalPackageGraph({
		apiUrl: 'https://api.kody.codes',
		token: goodToken,
		code,
		conversationId: 'conv-pkg',
		fetchFn: async (input, init) => {
			const url = String(input)
			const body = init?.body ? JSON.parse(String(init.body)) : null
			requests.push({
				url,
				body,
				authorization:
					(init?.headers as Record<string, string> | undefined)
						?.authorization ?? null,
			})
			assert.equal(init?.method, 'POST')
			return new Response(
				JSON.stringify({
					imports: ['kody:@test/pkg/hello'],
					modules: [
						{
							name: 'kody:@test/pkg/hello',
							esModule: 'export function greet(name) { return "hi " + name }\n',
						},
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		},
	})
	assert.equal(requests.length, 1)
	assert.match(requests[0]!.url, new RegExp(`${localPackageGraphPath}$`))
	assert.equal(requests[0]!.authorization, `Bearer ${goodToken}`)
	// The request is built from the imports, not the entry source (kody#4067):
	// origin derives root aliases from posted `code`, so they must match.
	assert.deepEqual(requests[0]!.body, {
		code: synthesizePackageGraphEntry(['kody:@test/pkg/hello']),
		imports: ['kody:@test/pkg/hello'],
		conversationId: 'conv-pkg',
	})
	assert.deepEqual(result, {
		imports: ['kody:@test/pkg/hello'],
		modules: [
			{
				name: 'kody:@test/pkg/hello',
				esModule: 'export function greet(name) { return "hi " + name }\n',
			},
		],
	})
})

test('synthesizePackageGraphEntry builds a tiny scannable stub', () => {
	assert.equal(
		synthesizePackageGraphEntry([]),
		'export default async function main() {}\n',
	)
	assert.equal(
		synthesizePackageGraphEntry([
			'kody:@b/pkg/x',
			'kody:@a/pkg/x',
			'kody:@b/pkg/x',
		]),
		`import "kody:@a/pkg/x"\nimport "kody:@b/pkg/x"\nexport default async function main() {}\n`,
	)
})

test('fetchLocalPackageGraph posts a synthetic entry for multi-megabyte bundles', async () => {
	const importLine = `import { greet } from 'kody:@test/pkg/hello'\n`
	const padding = 'x'.repeat(packageGraphInlineCodePreferImportsChars)
	const code = `${importLine}//${padding}\nexport default async function main(params) { return greet(params.name) }`
	assert.ok(code.length > packageGraphInlineCodePreferImportsChars)
	const requests: Array<{ body: unknown }> = []
	const result = await fetchLocalPackageGraph({
		apiUrl: 'https://api.kody.codes',
		token: goodToken,
		code,
		fetchFn: async (_input, init) => {
			requests.push({ body: init?.body ? JSON.parse(String(init.body)) : null })
			return new Response(
				JSON.stringify({
					imports: ['kody:@test/pkg/hello'],
					modules: [
						{
							name: 'kody:@test/pkg/hello',
							esModule: 'export function greet(name) { return "hi " + name }\n',
						},
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		},
	})
	assert.equal(requests.length, 1)
	assert.deepEqual(requests[0]!.body, {
		code: synthesizePackageGraphEntry(['kody:@test/pkg/hello']),
		imports: ['kody:@test/pkg/hello'],
	})
	assert.ok(
		typeof (requests[0]!.body as { code: string }).code === 'string' &&
			(requests[0]!.body as { code: string }).code.length < 500,
	)
	assert.equal(result.modules[0]?.name, 'kody:@test/pkg/hello')
})

test('fetchLocalPackageGraph fails clearly when the platform endpoint is missing', async () => {
	const code = `import x from 'kody:@missing/pkg/export'\nexport default async () => x`
	await assert.rejects(
		() =>
			fetchLocalPackageGraph({
				apiUrl: 'https://api.kody.codes',
				token: goodToken,
				code,
				fetchFn: async () =>
					new Response(
						JSON.stringify({ error: { code: 'not_found', message: 'nope' } }),
						{
							status: 404,
							headers: { 'content-type': 'application/json' },
						},
					),
			}),
		(error: unknown) => {
			assert.ok(error instanceof LocalPackageGraphError)
			assert.equal(error.status, 404)
			assert.match(
				error.message,
				/will not silently fall back to cloud kody\.execute/,
			)
			assert.match(
				error.message,
				new RegExp(localPackageGraphPlatformIssueUrl.replace(/\./g, '\\.')),
			)
			assert.match(error.message, /kody:@missing\/pkg\/export/)
			return true
		},
	)
})

test('fetchLocalPackageGraph surfaces unresolved package errors from the API', async () => {
	const code = `import x from 'kody:@nope/pkg/export'\nexport default async () => x`
	await assert.rejects(
		() =>
			fetchLocalPackageGraph({
				apiUrl: 'https://api.kody.codes',
				token: goodToken,
				code,
				fetchFn: async () =>
					new Response(
						JSON.stringify({
							error: {
								code: 'package_import_unresolved',
								message:
									'Could not resolve saved package import kody:@nope/pkg/export.',
							},
						}),
						{ status: 422, headers: { 'content-type': 'application/json' } },
					),
			}),
		/Could not resolve saved package import kody:@nope\/pkg\/export/,
	)
})

test('fetchLocalPackageGraph surfaces oversized code limit and actual size from the API', async () => {
	const code = `import x from 'kody:@a/pkg/one'\nexport default async () => x`
	const sizeMessage =
		'code is 5242881 UTF-8 bytes; the maximum is 5177344 (Open API JSON body limit minus wrapper headroom). Pass imports instead of inlining a large bundle.'
	await assert.rejects(
		() =>
			fetchLocalPackageGraph({
				apiUrl: 'https://api.kody.codes',
				token: goodToken,
				code,
				fetchFn: async () =>
					new Response(
						JSON.stringify({
							error: {
								code: 'invalid_request',
								message: sizeMessage,
							},
						}),
						{ status: 400, headers: { 'content-type': 'application/json' } },
					),
			}),
		(error: unknown) => {
			assert.ok(error instanceof LocalPackageGraphError)
			assert.match(error.message, /code is 5242881 UTF-8 bytes/)
			assert.match(error.message, /the maximum is 5177344/)
			assert.doesNotMatch(error.message, /^Invalid parameters\.?$/)
			return true
		},
	)
})

test('fetchLocalPackageGraph lifts oversized size details buried under Invalid parameters', async () => {
	const code = `import x from 'kody:@a/pkg/one'\nexport default async () => x`
	const sizeMessage =
		'code is 5242881 UTF-8 bytes; the maximum is 5177344 (Open API JSON body limit minus wrapper headroom). Pass imports instead of inlining a large bundle.'
	await assert.rejects(
		() =>
			fetchLocalPackageGraph({
				apiUrl: 'https://api.kody.codes',
				token: goodToken,
				code,
				fetchFn: async () =>
					new Response(
						JSON.stringify({
							error: {
								code: 'invalid_request',
								message: 'Invalid parameters.',
								details: {
									issues: [{ path: 'code', message: sizeMessage }],
								},
							},
						}),
						{ status: 400, headers: { 'content-type': 'application/json' } },
					),
			}),
		(error: unknown) => {
			assert.ok(error instanceof LocalPackageGraphError)
			assert.match(error.message, /code is 5242881 UTF-8 bytes/)
			assert.match(error.message, /the maximum is 5177344/)
			assert.doesNotMatch(error.message, /^Invalid parameters\.?$/)
			return true
		},
	)
})

test('fetchLocalPackageGraph rejects incomplete module lists', async () => {
	const code = `import x from 'kody:@a/pkg/one'\nexport default async () => x`
	await assert.rejects(
		() =>
			fetchLocalPackageGraph({
				apiUrl: 'https://api.kody.codes',
				token: goodToken,
				code,
				fetchFn: async () =>
					new Response(
						JSON.stringify({
							modules: [{ name: 'other', esModule: 'export {}' }],
						}),
						{
							status: 200,
							headers: { 'content-type': 'application/json' },
						},
					),
			}),
		(error: unknown) => {
			assert.ok(error instanceof LocalPackageGraphError)
			assert.equal(error.code, 'incomplete_package_graph')
			assert.deepEqual(error.details, { missing: ['kody:@a/pkg/one'] })
			assert.match(error.message, /omitted modules for kody:@a\/pkg\/one/)
			assert.match(error.message, /never ran/)
			assert.match(error.message, /not an auth problem/)
			return true
		},
	)
})

test('resolveLocalPackageGraph uses depResolve client for mock → prod package-graph', async () => {
	const code = `import x from 'kody:@a/pkg/one'\nexport default async () => x`
	const urls: Array<string> = []
	const result = await resolveLocalPackageGraph({
		code,
		apiUrl: 'http://127.0.0.1:9',
		token: 'kody_mock_session',
		depResolve: {
			apiUrl: 'https://api.kody.codes',
			token: goodToken,
			fetchFn: async (input) => {
				urls.push(String(input))
				return new Response(
					JSON.stringify({
						imports: ['kody:@a/pkg/one'],
						modules: [
							{
								name: 'kody:@a/pkg/one',
								esModule: 'export default 1\n',
							},
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				)
			},
		},
	})
	assert.equal(urls.length, 1)
	assert.match(urls[0]!, /api\.kody\.codes/)
	assert.equal(result.modules[0]?.name, 'kody:@a/pkg/one')
})

test('resolveLocalPackageGraph refuses mock deps without depResolve auth', async () => {
	const code = `import x from 'kody:@a/pkg/one'\nexport default async () => x`
	await assert.rejects(
		() =>
			resolveLocalPackageGraph({
				code,
				apiUrl: 'http://127.0.0.1:9',
				token: 'kody_mock_session',
				fetchFn: async () => {
					throw new Error('should not fetch mock package-graph')
				},
			}),
		(error: unknown) => {
			assert.ok(error instanceof LocalPackageGraphError)
			assert.equal(error.code, 'mock_package_deps_need_auth')
			assert.match(error.message, /KODY_API_TOKEN/)
			return true
		},
	)
})

test('resolveLocalPackageGraph still hits prod package-graph with zero imports (gateway shim)', async () => {
	const code = `export default async () => ({ ok: true })`
	let called = false
	const result = await resolveLocalPackageGraph({
		code,
		apiUrl: 'https://api.kody.codes',
		token: goodToken,
		fetchFn: async () => {
			called = true
			return new Response(
				JSON.stringify({
					imports: [],
					modules: [
						{
							name: localExecuteGatewayFetchShimModuleName,
							esModule: 'export {}\n',
						},
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		},
	})
	assert.equal(called, true)
	assert.equal(result.modules[0]?.name, localExecuteGatewayFetchShimModuleName)
})
