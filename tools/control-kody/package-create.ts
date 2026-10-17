import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
	connectAppMcpClient,
	usernameFromEmail,
	type AppAuthUser,
	type AppMcpOAuthSession,
	type FetchLike,
} from '../mcp-oauth-client.ts'

const kodyIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const scopedPackageNamePattern =
	/^@([a-z0-9][a-z0-9._-]*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/i
export const headAheadFileName = 'preview-head-ahead.txt'

const packageCreateExecuteCode = `import { kody } from 'kody:runtime'
export default async function main(input = {}) {
	const requested = String(input.kodyId ?? '').trim()
	let remote = null
	let remoteError = null
	try {
		remote = await kody.packageGetGitRemote({
			create: true,
			kody_id: requested,
			...(input.description ? { description: input.description } : {}),
		})
	} catch (error) {
		remoteError = error instanceof Error ? error.message : String(error)
	}
	const listed = await kody.packageList({})
	const match = (listed.packages ?? []).find((pkg) => {
		const kodyId = pkg.kody_id ?? pkg.kodyId
		return kodyId === requested || pkg.name === requested
	})
	const packageId = remote?.package_id ?? match?.package_id ?? match?.id
	if (!packageId) {
		throw new Error(
			remoteError ??
				\`Saved package \${requested} was not found after create.\`,
		)
	}
	const detail = await kody.packageGet({ package_id: packageId })
	if (!remote && input.requireRemote) {
		throw new Error(
			remoteError ??
				'packageGetGitRemote did not return a minted remote for --head-ahead.',
		)
	}
	return { remote, remoteError, detail }
}
`

export type PackageCreateReport = {
	ok: true
	packageId: string
	kodyId: string
	name: string
	created: boolean
	username: string
	packagePagePath: string
	accountPackagePath: string
	packagePageUrl: string
	accountPackageUrl: string
	headAhead: boolean
	cookieHeader: string
	oauth?: AppMcpOAuthSession
}

type PackageCreateCallToolOptions = {
	timeout?: number
	resetTimeoutOnProgress?: boolean
	maxTotalTimeout?: number
}

export type PackageCreateCallTool = (
	params: {
		name: string
		arguments: Record<string, unknown>
	},
	options?: PackageCreateCallToolOptions,
) => Promise<unknown>

const executeCallTimeoutMs = 180_000

export type PackageCreateConnection = {
	cookieHeader: string
	oauth?: AppMcpOAuthSession
	client: { callTool: PackageCreateCallTool }
	[Symbol.asyncDispose]?: () => Promise<void> | void
}

export function isLowerKebabKodyId(value: string) {
	const trimmed = value.trim()
	if (kodyIdPattern.test(trimmed)) return true
	const scoped = trimmed.match(scopedPackageNamePattern)
	return Boolean(scoped && kodyIdPattern.test(scoped[2] ?? ''))
}

export function matchesCreatedPackage(input: {
	requested: string
	kodyId?: string
	name?: string
}) {
	const requested = input.requested.trim()
	return input.kodyId === requested || input.name === requested
}

export function isProductionKodyOrigin(origin: string) {
	try {
		const hostname = new URL(origin).hostname.replace(/\.+$/, '')
		return hostname === 'kody.codes' || hostname === 'www.kody.codes'
	} catch {
		return false
	}
}

export function usernameFromPackageName(name: string, kodyId: string) {
	const suffix = `/${kodyId}`
	if (!name.startsWith('@') || !name.endsWith(suffix)) return null
	const username = name.slice(1, name.length - suffix.length)
	return username.length > 0 ? username : null
}

export function formatPackageCreateReport(report: PackageCreateReport) {
	const lines = [
		`packageId ${report.packageId}`,
		`kodyId ${report.kodyId}`,
		`name ${report.name}`,
		`package-page ${report.packagePageUrl}`,
		`account-page ${report.accountPackageUrl}`,
	]
	if (report.headAhead) lines.push('head-ahead pushed')
	return lines.join('\n')
}

export async function createPreviewPackage(input: {
	origin: string
	email: string
	password: string
	kodyId: string
	description?: string | null
	headAhead: boolean
	cookieHeader?: string
	oauth?: AppMcpOAuthSession
	orgSlug?: string | null
	connect?: (
		origin: string,
		user: AppAuthUser,
		options: {
			cookieHeader?: string
			oauth?: AppMcpOAuthSession
			orgSlug?: string
		},
	) => Promise<PackageCreateConnection>
	pushHeadAhead?: (remote: GitRemoteResult) => Promise<void>
	fetchImpl?: FetchLike
}): Promise<PackageCreateReport> {
	if (isProductionKodyOrigin(input.origin)) {
		throw new Error('package-create refuses to run against https://kody.codes')
	}
	if (!isLowerKebabKodyId(input.kodyId)) {
		throw new Error(
			'--package-name must be a lower-kebab-case leaf or @scope/leaf (for example "preview-pkg")',
		)
	}

	const user: AppAuthUser = {
		email: input.email,
		password: input.password,
		username: usernameFromEmail(input.email),
	}
	const connectOptions = {
		cookieHeader: input.cookieHeader,
		oauth: input.oauth,
		...(input.orgSlug ? { orgSlug: input.orgSlug } : {}),
	}
	const connection = input.connect
		? await input.connect(input.origin, user, connectOptions)
		: await connectAppMcpClient(input.origin, user, connectOptions)
	try {
		const params: Record<string, unknown> = {
			kodyId: input.kodyId,
			requireRemote: input.headAhead,
		}
		if (input.description && input.description.length > 0) {
			params.description = input.description
		}
		const toolResult = await connection.client.callTool(
			{
				name: 'execute',
				arguments: {
					code: packageCreateExecuteCode,
					params,
				},
			},
			{
				timeout: executeCallTimeoutMs,
				resetTimeoutOnProgress: true,
				maxTotalTimeout: executeCallTimeoutMs,
			},
		)
		const created = readCreatedPackage(toolResult)
		const fetchImpl = input.fetchImpl ?? fetch
		const username =
			usernameFromPackageName(created.name, created.kodyId) ??
			(await usernameFromSession(
				input.origin,
				connection.cookieHeader,
				fetchImpl,
			))
		if (!username) {
			throw new Error(
				`Could not derive username from package name ${JSON.stringify(created.name)}.`,
			)
		}
		if (input.headAhead) {
			if (!created.remote) {
				throw new Error(
					created.remoteError ??
						'packageGetGitRemote did not return a minted remote for --head-ahead.',
				)
			}
			const push = input.pushHeadAhead ?? pushHeadAheadCommit
			await push(created.remote)
		}
		const packagePagePath = `/@${username}/${created.kodyId}`
		const accountPackagePath = `/account/packages/${created.packageId}`
		return {
			ok: true,
			packageId: created.packageId,
			kodyId: created.kodyId,
			name: created.name,
			created: created.created,
			username,
			packagePagePath,
			accountPackagePath,
			packagePageUrl: `${input.origin}${packagePagePath}`,
			accountPackageUrl: `${input.origin}${accountPackagePath}`,
			headAhead: input.headAhead,
			cookieHeader: connection.cookieHeader,
			oauth: connection.oauth,
		}
	} finally {
		await connection[Symbol.asyncDispose]?.()
	}
}

export type GitAuthorIdentity = {
	name: string
	email: string
}

export type GitRemoteResult = {
	package_id: string
	kody_id: string
	created?: boolean
	authenticated_remote: string
	git_author: GitAuthorIdentity
	setup_commands?: Array<string>
}

export async function pushHeadAheadCommit(remote: GitRemoteResult) {
	const parent = await mkdtemp(path.join(tmpdir(), 'control-kody-pkg-'))
	const cloneDir = path.join(parent, remote.kody_id)
	try {
		const identity = gitIdentityFromRemote(remote)
		runGit(['clone', '--quiet', remote.authenticated_remote, cloneDir])
		runGit(['config', 'user.email', identity.email], cloneDir)
		runGit(['config', 'user.name', identity.name], cloneDir)
		await writeFile(
			path.join(cloneDir, headAheadFileName),
			'preview HEAD-ahead marker\n',
		)
		runGit(['add', headAheadFileName], cloneDir)
		const staged = runGit(['status', '--porcelain'], cloneDir).trim()
		if (!staged) return
		runGit(['commit', '-m', 'chore: leave HEAD ahead of published'], cloneDir)
		runGit(['push', '--quiet', 'origin', 'HEAD'], cloneDir)
	} finally {
		await rm(parent, { recursive: true, force: true })
	}
}

function gitIdentityFromRemote(remote: GitRemoteResult): GitAuthorIdentity {
	const commands = remote.setup_commands ?? []
	let email = remote.git_author.email
	let name = remote.git_author.name
	for (const command of commands) {
		const emailMatch = command.match(
			/^git config --local user\.email -- '(.+)'$/,
		)
		const nameMatch = command.match(/^git config --local user\.name -- '(.+)'$/)
		if (emailMatch?.[1]) email = unquoteGitIdentity(emailMatch[1])
		if (nameMatch?.[1]) name = unquoteGitIdentity(nameMatch[1])
	}
	return { name, email }
}

function unquoteGitIdentity(value: string) {
	return value.replaceAll(`'"'"'`, `'`)
}

function runGit(args: Array<string>, cwd?: string) {
	try {
		return execFileSync('git', args, {
			cwd,
			encoding: 'utf8',
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
			stdio: ['ignore', 'pipe', 'pipe'],
		})
	} catch (error) {
		const stderr =
			error && typeof error === 'object' && 'stderr' in error
				? String(error.stderr)
				: error instanceof Error
					? error.message
					: String(error)
		throw new Error(
			`git ${args[0] ?? 'command'} failed: ${redactGitOutput(stderr)}`,
		)
	}
}

function redactGitOutput(text: string) {
	return text.replaceAll(/\/\/([^/@\s]+):([^@/\s]+)@/g, '//***:***@')
}

async function usernameFromSession(
	origin: string,
	cookieHeader: string,
	fetchImpl: FetchLike,
) {
	const response = await fetchImpl(`${origin}/session`, {
		headers: {
			Accept: 'application/json',
			Cookie: cookieHeader,
		},
	})
	if (!response.ok) return null
	let body: unknown
	try {
		body = await response.json()
	} catch {
		return null
	}
	if (!body || typeof body !== 'object') return null
	const session = Reflect.get(body, 'session')
	if (!session || typeof session !== 'object') return null
	const username = Reflect.get(session, 'username')
	return typeof username === 'string' && username.length > 0 ? username : null
}

function readCreatedPackage(toolResult: unknown) {
	const result = readExecuteResult(toolResult)
	if (!result || typeof result !== 'object') {
		throw new Error('execute returned an unexpected package-create result.')
	}
	const remoteValue = Reflect.get(result, 'remote')
	const detailValue = Reflect.get(result, 'detail')
	const remoteErrorValue = Reflect.get(result, 'remoteError')
	if (!detailValue || typeof detailValue !== 'object') {
		throw new Error('execute result is missing packageGet payload.')
	}
	const detail = detailValue as Record<string, unknown>
	const remote =
		remoteValue && typeof remoteValue === 'object'
			? (remoteValue as Record<string, unknown>)
			: null
	const packageId = remote
		? readRequiredString(remote, 'package_id')
		: readRequiredString(detail, 'package_id')
	const kodyId = remote
		? readRequiredString(remote, 'kody_id')
		: readRequiredString(detail, 'kody_id')
	const name = readRequiredString(detail, 'name')
	const remoteError =
		typeof remoteErrorValue === 'string' && remoteErrorValue.length > 0
			? remoteErrorValue
			: null
	return {
		packageId,
		kodyId,
		name,
		created: remote?.created === true,
		remoteError,
		remote: remote ? readGitRemoteResult(remote, packageId, kodyId) : null,
	}
}

function readGitRemoteResult(
	remote: Record<string, unknown>,
	packageId: string,
	kodyId: string,
): GitRemoteResult {
	const gitAuthorValue = remote.git_author
	if (!gitAuthorValue || typeof gitAuthorValue !== 'object') {
		throw new Error('packageGetGitRemote result is missing git_author.')
	}
	const gitAuthor = gitAuthorValue as Record<string, unknown>
	return {
		package_id: packageId,
		kody_id: kodyId,
		created: remote.created === true,
		authenticated_remote: readRequiredString(remote, 'authenticated_remote'),
		git_author: {
			name: readRequiredString(gitAuthor, 'name'),
			email: readRequiredString(gitAuthor, 'email'),
		},
		setup_commands: Array.isArray(remote.setup_commands)
			? remote.setup_commands.filter(
					(command): command is string => typeof command === 'string',
				)
			: [],
	}
}

function readExecuteResult(toolResult: unknown) {
	if (!toolResult || typeof toolResult !== 'object') {
		throw new Error('execute returned no MCP tool result.')
	}
	const record = toolResult as CallToolResult
	const structured = record.structuredContent as
		| { result?: unknown; error?: unknown }
		| undefined
	if (record.isError || structured?.error) {
		const text = executeErrorText(record, structured?.error)
		throw new Error(`execute failed: ${text}`)
	}
	if (structured?.result === undefined || structured.result === null) {
		throw new Error('execute returned no result.')
	}
	return structured.result
}

function executeErrorText(record: CallToolResult, error: unknown) {
	const contentText = record.content
		?.filter((block) => block.type === 'text')
		.map((block) => block.text)
		.join('\n')
		.trim()
	if (contentText) return contentText
	if (typeof error === 'string' && error.length > 0) return error
	if (error !== undefined) return JSON.stringify(error)
	return 'unknown execute error'
}

function readRequiredString(record: Record<string, unknown>, key: string) {
	const value = record[key]
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`Expected "${key}" to be a non-empty string.`)
	}
	return value
}
