import { spawnSync } from 'node:child_process'
import path from 'node:path'

/**
 * Advisory scan of migration filenames on open pull requests. Pagination
 * follows tools/ci/merge-conflict-check.ts `listOpenPullRequests`: open pulls
 * against one base ref, 100 per page, hard stop past the page cap. A missing
 * token or repository skips the scan. Callers must not fail migration checks
 * on skip.
 */
const githubApiVersion = '2022-11-28'
const openPullRequestPageSize = 100
const openPullRequestMaxPages = 20
const pullFilesPageSize = 100
const pullFilesMaxPages = 10
const openPullRequestScanConcurrency = 4
const githubTimeoutMs = 20_000
const commandTimeoutMs = 5_000
const safeBaseRefPattern = /^[A-Za-z0-9._/-]+$/
const repositorySlugPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export type OpenPullRequestFileClaim = {
	number: number
	filenames: Array<string>
}

export type OpenPullRequestMigrationScan =
	| {
			status: 'skipped'
			reason: 'no-token' | 'no-repository' | 'unauthorized' | 'error'
			detail?: string
	  }
	| {
			status: 'ok'
			claims: Array<OpenPullRequestFileClaim>
	  }

type FetchLike = typeof fetch

export function githubTokenFromEnv(env: NodeJS.ProcessEnv): string | null {
	const ghToken = env.GH_TOKEN?.trim()
	if (ghToken) return ghToken
	const githubToken = env.GITHUB_TOKEN?.trim()
	if (githubToken) return githubToken
	return null
}

export function parseGithubRepository(remoteOrSlug: string): string | null {
	const trimmed = remoteOrSlug.trim()
	if (repositorySlugPattern.test(trimmed)) return trimmed
	const ssh =
		/^git@github\.com:(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
			trimmed,
		)
	if (ssh?.groups?.owner && ssh.groups.repo) {
		return `${ssh.groups.owner}/${ssh.groups.repo}`
	}
	try {
		const parsed = new URL(trimmed)
		if (parsed.hostname === 'github.com') {
			return repositorySlugFromPath(parsed.pathname, { exact: true })
		}
		// Proxy remotes keep the GitHub path after another host, for example
		// https://git-manager.devin.ai/proxy/github.com/owner/repo.
		const embedded =
			/\/github\.com\/(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
				parsed.pathname,
			)
		return repositorySlug(embedded?.groups?.owner, embedded?.groups?.repo)
	} catch {
		return null
	}
}

function repositorySlugFromPath(pathname: string, options: { exact: boolean }) {
	const parts = pathname.split('/').filter((part) => part.length > 0)
	if (options.exact && parts.length !== 2) return null
	return repositorySlug(parts[0], parts[1])
}

function repositorySlug(owner: string | undefined, repo: string | undefined) {
	if (!owner || !repo) return null
	const slug = `${owner}/${repo.replace(/\.git$/, '')}`
	return repositorySlugPattern.test(slug) ? slug : null
}

export async function scanOpenPullRequestMigrationPrefixes(input: {
	migrationsDir: string
	env?: NodeJS.ProcessEnv
	cwd?: string
	fetchImpl?: FetchLike
	repository?: string | null
	token?: string | null
	baseRef?: string
	currentPullNumber?: number | null
}): Promise<OpenPullRequestMigrationScan> {
	const env = input.env ?? process.env
	const cwd = input.cwd ?? process.cwd()
	const repository =
		input.repository !== undefined ? input.repository : readRepository(env, cwd)
	if (!repository) return { status: 'skipped', reason: 'no-repository' }
	if (!repositorySlugPattern.test(repository)) {
		return {
			status: 'skipped',
			reason: 'error',
			detail: 'Unrecognized GitHub repository.',
		}
	}
	const token = input.token !== undefined ? input.token : readToken(env, cwd)
	if (!token) return { status: 'skipped', reason: 'no-token' }
	const baseRef = input.baseRef ?? (env.GITHUB_BASE_REF?.trim() || 'main')
	if (!safeBaseRefPattern.test(baseRef)) {
		return {
			status: 'skipped',
			reason: 'error',
			detail: 'Unsafe GitHub base ref.',
		}
	}
	const currentPullNumber =
		input.currentPullNumber !== undefined
			? input.currentPullNumber
			: resolveCurrentPullNumber(env, cwd)
	try {
		const claims = await listClaimedMigrationFiles({
			repository,
			token,
			baseRef,
			migrationsDir: relativeMigrationsDir(input.migrationsDir, cwd),
			currentPullNumber,
			fetchImpl: input.fetchImpl ?? fetch,
		})
		return { status: 'ok', claims }
	} catch (error) {
		if (
			error instanceof GithubRequestError &&
			error.reason === 'unauthorized'
		) {
			return {
				status: 'skipped',
				reason: 'unauthorized',
				detail: redactToken(error.message, token),
			}
		}
		const message = error instanceof Error ? error.message : String(error)
		return {
			status: 'skipped',
			reason: 'error',
			detail: redactToken(message, token).slice(0, 500),
		}
	}
}

function readRepository(env: NodeJS.ProcessEnv, cwd: string) {
	const fromEnv = env.GITHUB_REPOSITORY?.trim()
	if (fromEnv) {
		const parsed = parseGithubRepository(fromEnv)
		if (parsed) return parsed
	}
	const remote = commandOutput(cwd, 'git', ['remote', 'get-url', 'origin'])
	if (remote) {
		const parsed = parseGithubRepository(remote)
		if (parsed) return parsed
	}
	// gh resolves the checkout even when origin is a proxy remote.
	const fromGh = commandOutput(cwd, 'gh', [
		'repo',
		'view',
		'--json',
		'nameWithOwner',
		'--jq',
		'.nameWithOwner',
	])
	if (!fromGh) return null
	return parseGithubRepository(fromGh)
}

function readToken(env: NodeJS.ProcessEnv, cwd: string) {
	const fromEnv = githubTokenFromEnv(env)
	if (fromEnv) return fromEnv
	return commandOutput(cwd, 'gh', ['auth', 'token'])
}

/**
 * This checkout's pull request number: GITHUB_PULL_REQUEST_NUMBER, then a
 * `refs/pull/<n>/...` GITHUB_REF (pull_request events), then `gh pr view`.
 */
export function resolveCurrentPullNumber(
	env: NodeJS.ProcessEnv,
	cwd: string,
): number | null {
	const explicit = env.GITHUB_PULL_REQUEST_NUMBER?.trim()
	if (explicit && /^\d+$/.test(explicit)) return Number(explicit)
	const ref = /^refs\/pull\/(?<number>\d+)\//.exec(env.GITHUB_REF ?? '')
	if (ref?.groups?.number) return Number(ref.groups.number)
	const raw = commandOutput(cwd, 'gh', ['pr', 'view', '--json', 'number'])
	if (!raw) return null
	try {
		const parsed: unknown = JSON.parse(raw)
		if (!parsed || typeof parsed !== 'object' || !('number' in parsed)) {
			return null
		}
		const number = (parsed as { number?: unknown }).number
		return typeof number === 'number' && Number.isInteger(number)
			? number
			: null
	} catch {
		return null
	}
}

function commandOutput(
	cwd: string,
	command: string,
	args: ReadonlyArray<string>,
) {
	const result = spawnSync(command, [...args], {
		cwd,
		encoding: 'utf8',
		timeout: commandTimeoutMs,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	if (result.status !== 0) return null
	const stdout = result.stdout.trim()
	return stdout.length > 0 ? stdout : null
}

function relativeMigrationsDir(migrationsDir: string, cwd: string) {
	const relative = path.relative(cwd, path.resolve(cwd, migrationsDir))
	return relative.split(path.sep).join('/').replace(/\/$/, '')
}

class GithubRequestError extends Error {
	readonly reason: 'unauthorized' | 'error'

	constructor(message: string, reason: 'unauthorized' | 'error') {
		super(message)
		this.name = 'GithubRequestError'
		this.reason = reason
	}
}

async function listClaimedMigrationFiles(input: {
	repository: string
	token: string
	baseRef: string
	migrationsDir: string
	currentPullNumber: number | null
	fetchImpl: FetchLike
}) {
	const [owner, repo] = input.repository.split('/')
	if (!owner || !repo) {
		throw new GithubRequestError('Unrecognized GitHub repository.', 'error')
	}
	const signal = AbortSignal.timeout(githubTimeoutMs)
	const pulls = await listOpenPullRequests({
		owner,
		repo,
		baseRef: input.baseRef,
		token: input.token,
		fetchImpl: input.fetchImpl,
		signal,
	})
	const selected = pulls.filter(
		(pull) => pull.number !== input.currentPullNumber,
	)
	const claims: Array<OpenPullRequestFileClaim> = []
	await mapPool(selected, openPullRequestScanConcurrency, async (pull) => {
		const filenames = await listMigrationFilenames({
			owner,
			repo,
			pullNumber: pull.number,
			migrationsDir: input.migrationsDir,
			token: input.token,
			fetchImpl: input.fetchImpl,
			signal,
		})
		if (filenames.length === 0) return
		claims.push({ number: pull.number, filenames })
	})
	claims.sort((left, right) => left.number - right.number)
	return claims
}

async function listOpenPullRequests(input: {
	owner: string
	repo: string
	baseRef: string
	token: string
	fetchImpl: FetchLike
	signal: AbortSignal
}) {
	const pulls: Array<{ number: number }> = []
	for (let page = 1; page <= openPullRequestMaxPages; page += 1) {
		const url = new URL(
			`https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`,
		)
		url.searchParams.set('state', 'open')
		url.searchParams.set('base', input.baseRef)
		url.searchParams.set('per_page', String(openPullRequestPageSize))
		url.searchParams.set('page', String(page))
		const payload = await githubGet({
			url,
			token: input.token,
			fetchImpl: input.fetchImpl,
			signal: input.signal,
		})
		const pagePulls = parseOpenPullRequestPage(payload)
		pulls.push(...pagePulls)
		if (pagePulls.length < openPullRequestPageSize) return pulls
	}
	throw new GithubRequestError(
		`More than ${String(openPullRequestMaxPages * openPullRequestPageSize)} open pull requests target ${input.baseRef}.`,
		'error',
	)
}

async function listMigrationFilenames(input: {
	owner: string
	repo: string
	pullNumber: number
	migrationsDir: string
	token: string
	fetchImpl: FetchLike
	signal: AbortSignal
}) {
	const filenames: Array<string> = []
	for (let page = 1; page <= pullFilesMaxPages; page += 1) {
		const url = new URL(
			`https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${String(input.pullNumber)}/files`,
		)
		url.searchParams.set('per_page', String(pullFilesPageSize))
		url.searchParams.set('page', String(page))
		const payload = await githubGet({
			url,
			token: input.token,
			fetchImpl: input.fetchImpl,
			signal: input.signal,
		})
		const files = parsePullFiles(payload, input.pullNumber)
		for (const file of files) {
			if (claimsMigrationFile(file, input.migrationsDir)) {
				filenames.push(file.filename)
			}
		}
		if (files.length < pullFilesPageSize) {
			filenames.sort()
			return filenames
		}
	}
	throw new GithubRequestError(
		`Pull request ${String(input.pullNumber)} has more than ${String(pullFilesMaxPages * pullFilesPageSize)} files.`,
		'error',
	)
}

function claimsMigrationFile(
	file: { filename: string; status: string },
	migrationsDir: string,
) {
	if (file.status === 'removed') return false
	const normalizedFile = file.filename.replaceAll('\\', '/')
	if (!normalizedFile.startsWith(`${migrationsDir}/`)) return false
	const base = normalizedFile.slice(migrationsDir.length + 1)
	return base.length > 0 && !base.includes('/') && base.endsWith('.sql')
}

async function githubGet(input: {
	url: URL
	token: string
	fetchImpl: FetchLike
	signal: AbortSignal
}) {
	let response: Response
	try {
		response = await input.fetchImpl(input.url, {
			method: 'GET',
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${input.token}`,
				'User-Agent': 'kody-migration-prefix-check',
				'X-GitHub-Api-Version': githubApiVersion,
			},
			signal: input.signal,
		})
	} catch (error) {
		const timedOut =
			error instanceof Error &&
			(error.name === 'TimeoutError' || error.name === 'AbortError')
		const message = timedOut
			? 'GitHub migration prefix scan timed out.'
			: `GitHub migration prefix scan failed: ${error instanceof Error ? error.message : String(error)}`
		throw new GithubRequestError(redactToken(message, input.token), 'error')
	}
	const text = await response.text()
	const described = `${input.url.pathname}${input.url.search}`
	if (!response.ok) {
		throw new GithubRequestError(
			redactToken(
				`GitHub API GET ${described} failed (${String(response.status)}): ${text.slice(0, 200)}`,
				input.token,
			),
			response.status === 401 || response.status === 403
				? 'unauthorized'
				: 'error',
		)
	}
	if (!text) return null
	try {
		return JSON.parse(text) as unknown
	} catch {
		throw new GithubRequestError(
			`GitHub API GET ${described} returned non-JSON`,
			'error',
		)
	}
}

function redactToken(text: string, token: string) {
	if (token.length < 8 || !text.includes(token)) return text
	return text.split(token).join('[redacted]')
}

function parseOpenPullRequestPage(payload: unknown): Array<{ number: number }> {
	if (!Array.isArray(payload)) {
		throw new GithubRequestError(
			'Open pull request list was not an array',
			'error',
		)
	}
	return payload.map((entry) => {
		if (!entry || typeof entry !== 'object') {
			throw new GithubRequestError(
				'Open pull request entry was not an object',
				'error',
			)
		}
		const number = (entry as { number?: unknown }).number
		if (typeof number !== 'number' || !Number.isInteger(number)) {
			throw new GithubRequestError(
				'Open pull request entry is missing a number',
				'error',
			)
		}
		return { number }
	})
}

function parsePullFiles(payload: unknown, pullNumber: number) {
	if (!Array.isArray(payload)) {
		throw new GithubRequestError(
			`Pull request ${String(pullNumber)} file list was not an array`,
			'error',
		)
	}
	return payload.map((entry) => {
		if (!entry || typeof entry !== 'object') {
			throw new GithubRequestError(
				`Pull request ${String(pullNumber)} file entry was not an object`,
				'error',
			)
		}
		const record = entry as { filename?: unknown; status?: unknown }
		if (typeof record.filename !== 'string' || record.filename.length === 0) {
			throw new GithubRequestError(
				`Pull request ${String(pullNumber)} file entry is missing a filename`,
				'error',
			)
		}
		return {
			filename: record.filename,
			status: typeof record.status === 'string' ? record.status : '',
		}
	})
}

async function mapPool<T>(
	items: ReadonlyArray<T>,
	concurrency: number,
	run: (item: T) => Promise<void>,
) {
	if (concurrency < 1) {
		throw new Error('concurrency must be at least 1')
	}
	let next = 0
	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		async () => {
			while (next < items.length) {
				const index = next
				next += 1
				const item = items[index]
				if (item === undefined) return
				await run(item)
			}
		},
	)
	await Promise.all(workers)
}
