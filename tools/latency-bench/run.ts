import { writeFile } from 'node:fs/promises'
import { Client as LegacyMcpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as LegacyMcpTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { isExecutedDirectly } from '../node-runtime.ts'
import {
	connectStatelessMcpClient,
	resolveAppMcpAuth,
	usernameFromEmail,
} from '../mcp-oauth-client.ts'
import {
	addedOverhead,
	formatMarkdown,
	summarizePath,
	type OverheadSummary,
	type PathSummary,
	type PhaseSample,
} from './stats.ts'

/**
 * Measures the latency Kody adds on top of the underlying call for the hosted
 * MCP paths (noop execute, `kody.mcp[...]`, `{{secret:}}` fetch through the
 * gateway, saved package export, search) and the direct baselines (plain fetch,
 * direct MCP tool call). Each path records one cold sample followed by `n`
 * warm samples. Execute paths also record the server-reported tool duration and
 * `serverTiming` phases returned in `structuredContent.timing`.
 */

export type LatencyBenchOptions = {
	origin: string
	email: string
	password: string
	token?: string
	n: number
	/** Warm samples run in batches of this many concurrent calls. */
	concurrency: number
	paths: Set<string> | null
	mcpServer?: string
	mcpTool: string
	mcpArgs: Record<string, unknown>
	mcpDirectUrl?: string
	fetchUrl?: string
	secretName?: string
	packageImport?: string
	searchQuery: string
	json: boolean
	out?: string
}

export type LatencyBenchReport = {
	origin: string
	measuredAt: string
	n: number
	paths: Record<string, PathSummary>
	overhead: Array<OverheadSummary>
}

export const latencyBenchClientName = 'kody-latency-bench'

function isProductionOrigin(origin: string) {
	const hostname = new URL(origin).hostname
	return hostname === 'kody.codes' || hostname === 'www.kody.codes'
}

export function parseArgs(argv: Array<string>): LatencyBenchOptions {
	const options: LatencyBenchOptions = {
		origin: 'http://localhost:3742',
		email: 'kody@example.com',
		password: 'ilikecode',
		n: 30,
		concurrency: 1,
		paths: null,
		mcpTool: 'ping',
		mcpArgs: {},
		searchQuery: 'ping tool',
		json: false,
	}
	const takeValue = (flag: string, index: number) => {
		const value = argv[index]
		if (value === undefined || value.startsWith('--')) {
			throw new Error(`${flag} requires a value`)
		}
		return value
	}
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] as string
		switch (arg) {
			case '--json':
				options.json = true
				break
			case '--origin':
				options.origin = new URL(takeValue(arg, ++index)).origin
				break
			case '--email':
				options.email = takeValue(arg, ++index)
				break
			case '--password':
				options.password = takeValue(arg, ++index)
				break
			case '--token':
				options.token = takeValue(arg, ++index)
				break
			case '--n':
				options.n = Number(takeValue(arg, ++index))
				if (!Number.isInteger(options.n) || options.n < 1) {
					throw new Error('--n must be a positive integer')
				}
				break
			case '--concurrency':
				options.concurrency = Number(takeValue(arg, ++index))
				if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
					throw new Error('--concurrency must be a positive integer')
				}
				break
			case '--paths':
				options.paths = new Set(
					takeValue(arg, ++index)
						.split(',')
						.map((path) => path.trim())
						.filter(Boolean),
				)
				break
			case '--mcp-server':
				options.mcpServer = takeValue(arg, ++index)
				break
			case '--mcp-tool':
				options.mcpTool = takeValue(arg, ++index)
				break
			case '--mcp-args':
				options.mcpArgs = JSON.parse(takeValue(arg, ++index)) as Record<
					string,
					unknown
				>
				break
			case '--mcp-direct-url':
				options.mcpDirectUrl = takeValue(arg, ++index)
				break
			case '--fetch-url':
				options.fetchUrl = takeValue(arg, ++index)
				break
			case '--secret-name':
				options.secretName = takeValue(arg, ++index)
				break
			case '--package-import':
				options.packageImport = takeValue(arg, ++index)
				break
			case '--search-query':
				options.searchQuery = takeValue(arg, ++index)
				break
			case '--out':
				options.out = takeValue(arg, ++index)
				break
			default:
				throw new Error(`Unknown argument: ${arg}`)
		}
	}
	if (isProductionOrigin(options.origin) && !options.token) {
		throw new Error(
			'Refusing to log in to https://kody.codes with a password. Pass --token for a dedicated test account instead.',
		)
	}
	return options
}

type ExecuteResult = {
	isError?: boolean
	content?: unknown
	structuredContent?: {
		timing?: {
			durationMs?: number
			serverTiming?: Array<{ name: string; durationMs: number }>
		}
	}
}

export async function runLatencyBench(
	options: LatencyBenchOptions,
): Promise<LatencyBenchReport> {
	const token =
		options.token ??
		(
			await resolveAppMcpAuth(
				options.origin,
				{
					email: options.email,
					username: usernameFromEmail(options.email),
					password: options.password,
				},
				{ clientName: latencyBenchClientName },
			)
		).oauth.accessToken

	const { client, transport } = await connectStatelessMcpClient(
		options.origin,
		{ Authorization: `Bearer ${token}` },
		{ name: latencyBenchClientName },
	)

	const paths: Record<string, PathSummary> = {}
	const overhead: Array<OverheadSummary> = []

	async function measure(name: string, sample: () => Promise<PhaseSample>) {
		if (options.paths && !options.paths.has(name)) return
		let cold: PhaseSample | null = null
		const warm: Array<PhaseSample> = []
		const failures: Record<string, number> = {}
		let errors = 0
		const recordError = (error: unknown) => {
			errors++
			const message = error instanceof Error ? error.message : String(error)
			const key = message.slice(0, 160)
			failures[key] = (failures[key] ?? 0) + 1
			if (errors <= 2) console.error(`${name}: ${message.slice(0, 400)}`)
		}
		try {
			cold = await sample()
		} catch (error) {
			recordError(error)
		}
		for (let done = 0; done < options.n; done += options.concurrency) {
			const batch = Math.min(options.concurrency, options.n - done)
			const results = await Promise.allSettled(
				Array.from({ length: batch }, () => sample()),
			)
			for (const result of results) {
				if (result.status === 'fulfilled') warm.push(result.value)
				else recordError(result.reason)
			}
		}
		paths[name] = summarizePath({ cold, warm, errors, failures })
		if (!options.json)
			console.error(`${name}: ${JSON.stringify(paths[name].warm)}`)
	}

	function assertToolSucceeded(result: ExecuteResult) {
		if (result.isError) {
			throw new Error(JSON.stringify(result.content).slice(0, 400))
		}
		return result
	}

	/** Wall time around the whole call, including body transfer and parsing. */
	async function timed(run: () => Promise<unknown>): Promise<PhaseSample> {
		const startedAt = performance.now()
		await run()
		return { wallMs: performance.now() - startedAt }
	}

	// Execute admission refuses identical code + params repeated within a
	// minute (loop detection), so every sample carries a distinct param.
	let executeSample = 0
	async function execute(code: string): Promise<PhaseSample> {
		const startedAt = performance.now()
		const result = assertToolSucceeded(
			(await client.callTool({
				name: 'execute',
				arguments: { code, params: { sample: ++executeSample } },
			})) as ExecuteResult,
		)
		const wallMs = performance.now() - startedAt
		const timing = result.structuredContent?.timing
		const phases: Record<string, number> = {}
		for (const entry of timing?.serverTiming ?? []) {
			phases[entry.name] = entry.durationMs
		}
		return { wallMs, toolMs: timing?.durationMs, phases }
	}

	async function fetchOk(url: string | URL) {
		const response = await fetch(url)
		if (!response.ok) throw new Error(`${url} responded ${response.status}`)
		return response.text()
	}

	await measure('health', () =>
		timed(() => fetchOk(new URL('/health', options.origin))),
	)
	await measure('mcp-tools-list', () => timed(() => client.listTools()))
	await measure('execute-noop', () => execute('export default async () => 1'))

	if (options.fetchUrl) {
		const fetchUrl = JSON.stringify(options.fetchUrl)
		await measure('direct-fetch', () =>
			timed(() => fetchOk(options.fetchUrl as string)),
		)
		await measure('execute-fetch-plain', () =>
			execute(`export default async () => (await fetch(${fetchUrl})).text()`),
		)
		if (options.secretName) {
			await measure('execute-fetch-secret', () =>
				execute(
					`export default async () => (await fetch(${fetchUrl}, { headers: { Authorization: 'Bearer {{secret:${options.secretName}}}' } })).text()`,
				),
			)
		}
	}

	if (options.mcpServer) {
		const call = `kody.mcp[${JSON.stringify(options.mcpServer)}][${JSON.stringify(options.mcpTool)}](${JSON.stringify(options.mcpArgs)})`
		await measure('execute-mcp-tool', () =>
			execute(
				`import { kody } from 'kody:runtime'\nexport default async () => ${call}`,
			),
		)
	}
	if (options.mcpDirectUrl) {
		const direct = new LegacyMcpClient({
			name: latencyBenchClientName,
			version: '1.0.0',
		})
		let connected = false
		await measure('direct-mcp-tool', async () => {
			if (!connected) {
				await direct.connect(
					new LegacyMcpTransport(new URL(options.mcpDirectUrl as string)),
				)
				connected = true
			}
			return timed(async () =>
				assertToolSucceeded(
					(await direct.callTool({
						name: options.mcpTool,
						arguments: options.mcpArgs,
					})) as ExecuteResult,
				),
			)
		})
		if (connected) await direct.close().catch(() => undefined)
	}

	if (options.packageImport) {
		await measure('execute-package-export', () =>
			execute(
				`import run from ${JSON.stringify(options.packageImport)}\nexport default async () => run({})`,
			),
		)
	}

	await measure('search', () =>
		timed(async () =>
			assertToolSucceeded(
				(await client.callTool({
					name: 'search',
					arguments: { query: options.searchQuery },
				})) as ExecuteResult,
			),
		),
	)

	await client.close().catch(() => undefined)
	await transport.close().catch(() => undefined)

	const pairs: Array<[string, string]> = [
		['execute-fetch-plain', 'direct-fetch'],
		['execute-fetch-secret', 'direct-fetch'],
		['execute-mcp-tool', 'direct-mcp-tool'],
	]
	for (const [kodyPath, directPath] of pairs) {
		const kody = paths[kodyPath]
		const direct = paths[directPath]
		if (
			kody &&
			direct &&
			isComplete(kody, options.n) &&
			isComplete(direct, options.n)
		) {
			overhead.push(addedOverhead(kodyPath, kody, directPath, direct))
		}
	}

	return {
		origin: options.origin,
		measuredAt: new Date().toISOString(),
		n: options.n,
		paths,
		overhead,
	}
}

export function isComplete(path: PathSummary, n: number) {
	return path.cold !== null && path.warm.n === n && path.errors === 0
}

export function incompletePaths(report: LatencyBenchReport) {
	return Object.entries(report.paths)
		.filter(([, path]) => !isComplete(path, report.n))
		.map(([name]) => name)
}

export async function main(argv = process.argv.slice(2)) {
	const options = parseArgs(argv)
	const report = await runLatencyBench(options)
	if (options.out) {
		await writeFile(options.out, JSON.stringify(report, null, 2))
	}
	console.log(
		options.json ? JSON.stringify(report, null, 2) : formatMarkdown(report),
	)
	const incomplete = incompletePaths(report)
	if (incomplete.length) {
		console.error(
			`Incomplete paths (missing cold sample, fewer than ${report.n} warm samples, or errors): ${incomplete.join(', ')}`,
		)
		process.exitCode = 1
	}
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
