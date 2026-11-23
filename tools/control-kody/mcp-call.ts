import { readFile } from 'node:fs/promises'
import {
	connectAppMcpClient,
	usernameFromEmail,
	type AppAuthUser,
	type AppMcpOAuthSession,
} from '../mcp-oauth-client.ts'
import { isProductionKodyOrigin } from './package-create.ts'
import {
	defaultMcpCallOptions,
	readExecuteResult,
	readApiResult,
	readSearchResult,
	type McpCallConnection,
} from './mcp-tool-result.ts'

export type AppMcpCallReport = {
	ok: true
	tool: 'execute' | 'search' | 'api'
	result: unknown
	cookieHeader: string
	oauth?: AppMcpOAuthSession
}

export async function readJsonObjectFile(filePath: string) {
	const raw = await readFile(filePath, 'utf8')
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		throw new Error(
			`Could not parse JSON from ${filePath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`${filePath} must contain a JSON object.`)
	}
	return parsed as Record<string, unknown>
}

export async function executeAppMcp(input: {
	origin: string
	email: string
	password: string
	code: string
	params?: Record<string, unknown>
	/** Other execute arguments, such as a `credentials` call map. */
	extraArguments?: Record<string, unknown>
	/** Read or resume the keyed run instead of starting a new one. */
	idempotencyKey?: string
	/** How long to keep re-reading an in-progress run. 0 returns the handle. */
	followTimeoutMs?: number
	followIntervalMs?: number
	cookieHeader?: string
	oauth?: AppMcpOAuthSession
	orgSlug?: string | null
	connect?: AppMcpConnect
}): Promise<AppMcpCallReport> {
	if (isProductionKodyOrigin(input.origin)) {
		throw new Error('execute refuses to run against https://kody.codes')
	}
	const followDeadline =
		Date.now() + (input.followTimeoutMs ?? defaultExecuteFollowTimeoutMs)
	const followIntervalMs =
		input.followIntervalMs ?? defaultExecuteFollowIntervalMs
	const baseArguments = {
		...input.extraArguments,
		code: input.code,
		...(input.params ? { params: input.params } : {}),
	}
	return callAppMcpTool({
		origin: input.origin,
		email: input.email,
		password: input.password,
		tool: 'execute',
		arguments: input.idempotencyKey
			? { ...baseArguments, idempotencyKey: input.idempotencyKey }
			: baseArguments,
		readResult: readExecuteResult,
		async followUp(result) {
			const idempotencyKey = inProgressIdempotencyKey(result)
			if (!idempotencyKey || Date.now() >= followDeadline) return null
			await new Promise((resolve) => setTimeout(resolve, followIntervalMs))
			return { ...baseArguments, idempotencyKey }
		},
		cookieHeader: input.cookieHeader,
		oauth: input.oauth,
		orgSlug: input.orgSlug,
		connect: input.connect,
	})
}

const defaultExecuteFollowTimeoutMs = 15 * 60_000
const defaultExecuteFollowIntervalMs = 5_000

function inProgressIdempotencyKey(result: unknown) {
	if (!result || typeof result !== 'object') return null
	const handle = result as { inProgress?: unknown; idempotencyKey?: unknown }
	return handle.inProgress === true && typeof handle.idempotencyKey === 'string'
		? handle.idempotencyKey
		: null
}

export async function searchAppMcp(input: {
	origin: string
	email: string
	password: string
	query?: string
	domain?: string
	entity?: string
	limit?: number
	cookieHeader?: string
	oauth?: AppMcpOAuthSession
	orgSlug?: string | null
	connect?: AppMcpConnect
}): Promise<AppMcpCallReport> {
	if (isProductionKodyOrigin(input.origin)) {
		throw new Error('search refuses to run against https://kody.codes')
	}
	const arguments_: Record<string, unknown> = {}
	if (input.query) arguments_.query = input.query
	if (input.domain) arguments_.domain = input.domain
	if (input.entity) arguments_.entity = input.entity
	if (input.limit !== undefined) arguments_.limit = input.limit
	return callAppMcpTool({
		origin: input.origin,
		email: input.email,
		password: input.password,
		tool: 'search',
		arguments: arguments_,
		readResult: readSearchResult,
		cookieHeader: input.cookieHeader,
		oauth: input.oauth,
		orgSlug: input.orgSlug,
		connect: input.connect,
	})
}

/** Call one MCP `api` operation (e.g. `cliCredentialBootstrap`) as the seed user. */
export async function apiAppMcp(input: {
	origin: string
	email: string
	password: string
	operationId: string
	params?: Record<string, unknown>
	cookieHeader?: string
	oauth?: AppMcpOAuthSession
	orgSlug?: string | null
	connect?: AppMcpConnect
}): Promise<AppMcpCallReport> {
	if (isProductionKodyOrigin(input.origin)) {
		throw new Error('api refuses to run against https://kody.codes')
	}
	return callAppMcpTool({
		origin: input.origin,
		email: input.email,
		password: input.password,
		tool: 'api',
		arguments: {
			operationId: input.operationId,
			...(input.params ? { params: input.params } : {}),
		},
		readResult: readApiResult,
		cookieHeader: input.cookieHeader,
		oauth: input.oauth,
		orgSlug: input.orgSlug,
		connect: input.connect,
	})
}

type AppMcpConnectOptions = {
	cookieHeader?: string
	oauth?: AppMcpOAuthSession
	orgSlug?: string
}

type AppMcpConnect = (
	origin: string,
	user: AppAuthUser,
	options: AppMcpConnectOptions,
) => Promise<McpCallConnection>

function mcpConnectOptions(input: {
	cookieHeader?: string
	oauth?: AppMcpOAuthSession
	orgSlug?: string | null
}): AppMcpConnectOptions {
	return {
		cookieHeader: input.cookieHeader,
		oauth: input.oauth,
		...(input.orgSlug ? { orgSlug: input.orgSlug } : {}),
	}
}

async function callAppMcpTool(input: {
	origin: string
	email: string
	password: string
	tool: 'execute' | 'search' | 'api'
	arguments: Record<string, unknown>
	readResult: (toolResult: unknown) => unknown
	/** Arguments for another call on the same connection, or null to stop. */
	followUp?: (result: unknown) => Promise<Record<string, unknown> | null>
	cookieHeader?: string
	oauth?: AppMcpOAuthSession
	orgSlug?: string | null
	connect?: AppMcpConnect
}): Promise<AppMcpCallReport> {
	const user: AppAuthUser = {
		email: input.email,
		password: input.password,
		username: usernameFromEmail(input.email),
	}
	const connectOptions = mcpConnectOptions(input)
	const connection = input.connect
		? await input.connect(input.origin, user, connectOptions)
		: await connectAppMcpClient(input.origin, user, connectOptions)
	try {
		let toolArguments: Record<string, unknown> | null = input.arguments
		let result: unknown
		while (toolArguments) {
			const toolResult = await connection.client.callTool(
				{
					name: input.tool,
					arguments: toolArguments,
				},
				defaultMcpCallOptions,
			)
			result = input.readResult(toolResult)
			toolArguments = input.followUp ? await input.followUp(result) : null
		}
		return {
			ok: true,
			tool: input.tool,
			result,
			cookieHeader: connection.cookieHeader,
			oauth: connection.oauth,
		}
	} finally {
		await connection[Symbol.asyncDispose]?.()
	}
}

export function formatMcpCallReport(report: AppMcpCallReport) {
	if (typeof report.result === 'string') return report.result
	return JSON.stringify(report.result, null, 2)
}
