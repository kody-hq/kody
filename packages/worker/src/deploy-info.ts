export const defaultGithubRepoUrl = 'https://github.com/kody-hq/kody'
export const maxCommitMessageLength = 500

export type DeployCommitInfo = {
	sha: string
	message: string
	committedAt: string | null
}

export type DeployPullRequestInfo = {
	number: number
	url: string
	title: string | null
}

export type DeployRunInfo = {
	deployedAt: string
	environment: string
	workflow: string | null
	job: string | null
	runId: string | null
	runUrl: string | null
}

export type DeployInfo = {
	repoUrl: string
	commit: DeployCommitInfo
	pullRequest: DeployPullRequestInfo | null
	deploy: DeployRunInfo
}

export type HealthCommit = {
	sha: string
	url: string
	message: string | null
	committedAt: string | null
}

export type HealthReport = {
	ok: boolean
	commitSha: string | null
	commit: HealthCommit | null
	pullRequest: DeployPullRequestInfo | null
	deploy: DeployRunInfo | null
}

export function githubCommitUrl(repoUrl: string, sha: string) {
	return `${trimTrailingSlash(repoUrl)}/commit/${sha}`
}

export function githubPullRequestUrl(repoUrl: string, number: number) {
	return `${trimTrailingSlash(repoUrl)}/pull/${number}`
}

export function githubActionsRunUrl(
	repoUrl: string,
	runId: string,
	attempt?: string | null,
) {
	const url = `${trimTrailingSlash(repoUrl)}/actions/runs/${runId}`
	return attempt && attempt !== '1' ? `${url}/attempts/${attempt}` : url
}

export function truncateCommitMessage(message: string) {
	const normalized = message.replaceAll('\r\n', '\n').trim()
	if (normalized.length <= maxCommitMessageLength) return normalized
	return `${normalized.slice(0, maxCommitMessageLength - 1)}…`
}

export function pullRequestNumberFromCommitMessage(message: string) {
	const matches = [...message.matchAll(/\(#(\d+)\)/g)]
	const last = matches.at(-1)?.[1]
	if (!last) return null
	const number = Number(last)
	return Number.isInteger(number) && number > 0 ? number : null
}

export function encodeDeployInfo(info: DeployInfo) {
	return encodeBase64Url(JSON.stringify(info))
}

export function parseDeployInfo(raw: string | undefined) {
	if (!raw) return null
	const trimmed = raw.trim()
	if (!trimmed) return null
	try {
		const json = trimmed.startsWith('{') ? trimmed : decodeBase64Url(trimmed)
		return validateDeployInfo(JSON.parse(json) as unknown)
	} catch {
		return null
	}
}

export function buildHealthReport(env: {
	APP_COMMIT_SHA?: string
	APP_DEPLOY_INFO?: string
}): HealthReport {
	const commitSha = env.APP_COMMIT_SHA ?? null
	const parsed = parseDeployInfo(env.APP_DEPLOY_INFO)
	const info =
		parsed &&
		(!commitSha || parsed.commit.sha.toLowerCase() === commitSha.toLowerCase())
			? parsed
			: null
	const repoUrl = info?.repoUrl ?? defaultGithubRepoUrl
	const sha = commitSha ?? info?.commit.sha ?? null
	return {
		ok: true,
		commitSha,
		commit: sha
			? {
					sha,
					url: githubCommitUrl(repoUrl, sha),
					message: info?.commit.message ?? null,
					committedAt: info?.commit.committedAt ?? null,
				}
			: null,
		pullRequest: info?.pullRequest ?? null,
		deploy: info?.deploy ?? null,
	}
}

export function prefersHtml(accept: string | null) {
	if (!accept) return false
	const html = accept.indexOf('text/html')
	if (html === -1) return false
	const json = accept.indexOf('application/json')
	return json === -1 || html < json
}

function trimTrailingSlash(value: string) {
	return value.endsWith('/') ? value.slice(0, -1) : value
}

function encodeBase64Url(text: string) {
	const bytes = new TextEncoder().encode(text)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '')
}

function decodeBase64Url(encoded: string) {
	const padded = encoded.replaceAll('-', '+').replaceAll('_', '/')
	const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
	const binary = atob(padded + pad)
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
	return new TextDecoder().decode(bytes)
}

function validateDeployInfo(value: unknown): DeployInfo | null {
	if (!isRecord(value)) return null
	if (typeof value.repoUrl !== 'string' || !value.repoUrl.trim()) return null
	if (!isRecord(value.commit)) return null
	if (typeof value.commit.sha !== 'string' || !value.commit.sha.trim()) {
		return null
	}
	if (typeof value.commit.message !== 'string') return null
	if (
		value.commit.committedAt !== null &&
		typeof value.commit.committedAt !== 'string'
	) {
		return null
	}
	if (!isRecord(value.deploy)) return null
	if (typeof value.deploy.deployedAt !== 'string') return null
	if (typeof value.deploy.environment !== 'string') return null
	const pullRequest = validatePullRequest(value.pullRequest)
	if (
		value.pullRequest !== null &&
		value.pullRequest !== undefined &&
		!pullRequest
	) {
		return null
	}
	return {
		repoUrl: value.repoUrl.trim(),
		commit: {
			sha: value.commit.sha.trim(),
			message: value.commit.message,
			committedAt: value.commit.committedAt,
		},
		pullRequest,
		deploy: {
			deployedAt: value.deploy.deployedAt,
			environment: value.deploy.environment,
			workflow: optionalString(value.deploy.workflow),
			job: optionalString(value.deploy.job),
			runId: optionalString(value.deploy.runId),
			runUrl: optionalString(value.deploy.runUrl),
		},
	}
}

function validatePullRequest(value: unknown): DeployPullRequestInfo | null {
	if (value == null) return null
	if (!isRecord(value)) return null
	if (typeof value.number !== 'number' || !Number.isInteger(value.number)) {
		return null
	}
	if (typeof value.url !== 'string' || !value.url.trim()) return null
	if (
		value.title !== null &&
		value.title !== undefined &&
		typeof value.title !== 'string'
	) {
		return null
	}
	return {
		number: value.number,
		url: value.url,
		title: typeof value.title === 'string' ? value.title : null,
	}
}

function optionalString(value: unknown) {
	return typeof value === 'string' && value.trim() ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}
