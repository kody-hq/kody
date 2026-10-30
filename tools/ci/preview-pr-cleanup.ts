import { appendFileSync } from 'node:fs'
import { isExecutedDirectly } from '../node-runtime.ts'
import {
	assertPreviewResourceName,
	cleanupPreviewResources,
	previewCleanupBudgetMsDefault,
} from './preview-resources.ts'
import {
	collectBranchPreviewSources,
	collectPreviewBranchWorkerNames,
	collectPreviewPullRequestNumbers,
	hasBudgetForAnotherCleanup,
	isPreviewDeployInProgress,
	previewSweepWallClockBudgetMsDefault,
} from './preview-sweep.ts'
import { cloudflareApiRequest, fail } from './resource-utils.ts'

/**
 * Daily preview cleanup keyed only on GitHub pull request state, never on
 * age. A preview is deleted when every pull request it belongs to is closed
 * or merged:
 *
 * - `kody-pr-<n>` belongs to PR `n`.
 * - `kody-branch-<slug>` belongs to the PRs opened from the branch it was
 *   last deployed from. That branch comes from preview.yml's run title, or,
 *   for runs older than that title format, from the dispatch runs of the
 *   commit the Worker serves (`APP_COMMIT_SHA`).
 *
 * Anything that cannot be tied to a PR (deployed from the default branch, a
 * branch with no PR, an ambiguous source, or a PR GitHub does not know) is
 * kept and reported. Deletes go through `cleanupPreviewResources`, which
 * applies the preview naming guard.
 */

export const previewPrCleanupMaxPerRunDefault = 10

export type PreviewPullRequest = {
	number: number
	state: 'open' | 'closed'
	merged: boolean
	closedAt: string | null
}

export type PreviewOwnership =
	| {
			kind: 'pr'
			pullRequests: ReadonlyArray<PreviewPullRequest>
			branch?: string
			deployedAt?: string
	  }
	| { kind: 'unresolved'; reason: string; branch?: string }

export type PreviewCleanupDecision = {
	workerName: string
	action: 'delete' | 'keep-open' | 'keep-unresolved'
	pullRequests: ReadonlyArray<PreviewPullRequest>
	branch?: string
	reason: string
}

export function decidePreviewCleanup(
	workerName: string,
	ownership: PreviewOwnership,
): PreviewCleanupDecision {
	if (ownership.kind === 'unresolved') {
		return {
			workerName,
			action: 'keep-unresolved',
			pullRequests: [],
			...(ownership.branch ? { branch: ownership.branch } : {}),
			reason: ownership.reason,
		}
	}
	const { pullRequests, branch, deployedAt } = ownership
	if (pullRequests.length === 0) {
		return {
			workerName,
			action: 'keep-unresolved',
			pullRequests,
			branch,
			reason: branch ? `branch ${branch} has no PR` : 'no PR found',
		}
	}
	const open = pullRequests.filter((pull) => pull.state === 'open')
	if (open.length > 0) {
		return {
			workerName,
			action: 'keep-open',
			pullRequests,
			branch,
			reason: `PR ${open.map((pull) => `#${String(pull.number)}`).join(', ')} still open`,
		}
	}
	// A branch redeployed after its PRs closed is new work, not a leftover.
	const deployedAtMs = deployedAt ? Date.parse(deployedAt) : Number.NaN
	if (
		Number.isFinite(deployedAtMs) &&
		pullRequests.every(
			(pull) => !pull.closedAt || Date.parse(pull.closedAt) < deployedAtMs,
		)
	) {
		return {
			workerName,
			action: 'keep-unresolved',
			pullRequests,
			branch,
			reason: `branch ${branch ?? ''} redeployed after its PRs closed`,
		}
	}
	return {
		workerName,
		action: 'delete',
		pullRequests,
		branch,
		reason: pullRequests
			.map(
				(pull) =>
					`#${String(pull.number)} ${pull.merged ? 'merged' : 'closed'}`,
			)
			.join(', '),
	}
}

/**
 * Branch a pre-title-format branch preview was deployed from: the single
 * branch of the successful preview.yml dispatch runs at the commit the Worker
 * serves. Several branches at one commit is ambiguous, so it returns null.
 */
export function branchFromCommitRuns(
	runs: ReadonlyArray<{
		head_branch?: unknown
		conclusion?: unknown
		updated_at?: unknown
	}>,
): { branch: string; deployedAt?: string } | null {
	const successful = runs.filter(
		(run) =>
			run.conclusion === 'success' && typeof run.head_branch === 'string',
	)
	const branches = new Set(successful.map((run) => run.head_branch as string))
	const branch = branches.size === 1 ? [...branches][0] : undefined
	if (!branch) return null
	const deployedAt = successful
		.map((run) => run.updated_at)
		.filter((value): value is string => typeof value === 'string')
		.sort()
		.at(-1)
	return deployedAt ? { branch, deployedAt } : { branch }
}

export function formatPreviewCleanupReport(input: {
	decisions: ReadonlyArray<PreviewCleanupDecision>
	deleted: ReadonlyArray<string>
	deferred: ReadonlyArray<string>
	skipped: ReadonlyMap<string, string>
	failed: ReadonlyArray<string>
	dryRun: boolean
}) {
	const status = (decision: PreviewCleanupDecision) => {
		const name = decision.workerName
		if (decision.action === 'keep-open') return 'kept (PR open)'
		if (decision.action === 'keep-unresolved') return 'kept (no PR resolved)'
		if (input.failed.includes(name)) return 'delete failed'
		if (input.skipped.has(name))
			return `skipped (${input.skipped.get(name) ?? ''})`
		if (input.deferred.includes(name)) return 'deferred to next run'
		if (input.deleted.includes(name)) {
			return input.dryRun ? 'would delete (dry run)' : 'deleted'
		}
		return 'not processed'
	}
	const rows = input.decisions.map(
		(decision) =>
			`| \`${decision.workerName}\` | ${decision.branch ? `\`${decision.branch}\`` : ''} | ${decision.reason} | ${status(decision)} |`,
	)
	return [
		`## Preview PR cleanup${input.dryRun ? ' (dry run)' : ''}`,
		'',
		'| Preview | Source branch | PR state | Result |',
		'| --- | --- | --- | --- |',
		...rows,
		'',
	].join('\n')
}

type GithubClient = {
	get: (path: string) => Promise<{ status: number; json: unknown }>
}

export async function readPreviewPullRequest(
	github: GithubClient,
	repository: string,
	number: number,
): Promise<PreviewPullRequest | null> {
	const response = await github.get(
		`/repos/${repository}/pulls/${String(number)}`,
	)
	if (response.status === 404) return null
	const pull = response.json as {
		state?: unknown
		merged_at?: unknown
		closed_at?: unknown
	}
	if (pull.state !== 'open' && pull.state !== 'closed') return null
	return {
		number,
		state: pull.state,
		merged: typeof pull.merged_at === 'string',
		closedAt: typeof pull.closed_at === 'string' ? pull.closed_at : null,
	}
}

export async function listBranchPreviewPullRequests(
	github: GithubClient,
	repository: string,
	branch: string,
): Promise<Array<PreviewPullRequest> | null> {
	const owner = repository.split('/')[0] ?? ''
	const head = encodeURIComponent(`${owner}:${branch}`)
	const pulls: Array<PreviewPullRequest> = []
	for (let page = 1; page <= 5; page += 1) {
		const { json } = await github.get(
			`/repos/${repository}/pulls?head=${head}&state=all&per_page=100&page=${String(page)}`,
		)
		if (!Array.isArray(json)) return pulls
		for (const pull of json as Array<{
			number?: unknown
			state?: unknown
			merged_at?: unknown
			closed_at?: unknown
		}>) {
			if (typeof pull.number !== 'number') continue
			if (pull.state !== 'open' && pull.state !== 'closed') continue
			pulls.push({
				number: pull.number,
				state: pull.state,
				merged: typeof pull.merged_at === 'string',
				closedAt: typeof pull.closed_at === 'string' ? pull.closed_at : null,
			})
		}
		if (json.length < 100) return pulls
	}
	// More PRs than we page through: ownership is ambiguous, keep it.
	return null
}

export type PreviewPrCleanupDeps = {
	repository: string
	defaultBranch: string
	dryRun: boolean
	maxPerRun: number
	github: GithubClient
	listScriptNames: () => Promise<Array<string>>
	readWorkerCommitSha: (workerName: string) => Promise<string | null>
	isDeployInProgress: () => Promise<boolean>
	cleanup: (workerName: string) => Promise<void>
	hasBudget: () => boolean
	log: (line: string) => void
}

type TitledSources = ReadonlyMap<string, { branch: string; deployedAt: string }>

async function resolveBranchOwnership(
	deps: PreviewPrCleanupDeps,
	workerName: string,
	titledSources: TitledSources,
): Promise<PreviewOwnership> {
	let source: { branch: string; deployedAt?: string } | null =
		titledSources.get(workerName) ?? null
	if (!source) {
		const sha = await deps.readWorkerCommitSha(workerName)
		if (!sha) {
			return { kind: 'unresolved', reason: 'no recorded deploy commit' }
		}
		const { json } = await deps.github.get(
			`/repos/${deps.repository}/actions/workflows/preview.yml/runs?event=workflow_dispatch&head_sha=${sha}&per_page=100`,
		)
		const runs = (json as { workflow_runs?: unknown }).workflow_runs
		source = branchFromCommitRuns(Array.isArray(runs) ? runs : [])
		if (!source) {
			return {
				kind: 'unresolved',
				reason: `no single deploy branch for commit ${sha.slice(0, 10)}`,
			}
		}
	}
	const { branch, deployedAt } = source
	if (branch === deps.defaultBranch) {
		return {
			kind: 'unresolved',
			branch,
			reason: `deployed from ${deps.defaultBranch}, which has no PR`,
		}
	}
	const pullRequests = await listBranchPreviewPullRequests(
		deps.github,
		deps.repository,
		branch,
	)
	if (!pullRequests) {
		return { kind: 'unresolved', reason: `too many PRs for branch ${branch}` }
	}
	return deployedAt
		? { kind: 'pr', pullRequests, branch, deployedAt }
		: { kind: 'pr', pullRequests, branch }
}

async function listTitledBranchSources(deps: PreviewPrCleanupDeps) {
	const runs: Array<Record<string, unknown>> = []
	for (let page = 1; page <= 3; page += 1) {
		const { json } = await deps.github.get(
			`/repos/${deps.repository}/actions/workflows/preview.yml/runs?event=workflow_dispatch&per_page=100&page=${String(page)}`,
		)
		const pageRuns = (json as { workflow_runs?: unknown }).workflow_runs
		if (!Array.isArray(pageRuns)) break
		runs.push(...(pageRuns as Array<Record<string, unknown>>))
		if (pageRuns.length < 100) break
	}
	return collectBranchPreviewSources(runs)
}

export async function resolvePreviewOwnership(
	deps: PreviewPrCleanupDeps,
	workerName: string,
	titledSources: TitledSources,
): Promise<PreviewOwnership> {
	const prNumber = collectPreviewPullRequestNumbers([workerName])[0]
	if (prNumber !== undefined) {
		const pull = await readPreviewPullRequest(
			deps.github,
			deps.repository,
			prNumber,
		)
		return pull
			? { kind: 'pr', pullRequests: [pull] }
			: { kind: 'unresolved', reason: `PR #${String(prNumber)} not found` }
	}
	return resolveBranchOwnership(deps, workerName, titledSources)
}

/** Bare preview Worker names on the account, PR previews first. */
export function listPreviewWorkerNames(scriptNames: ReadonlyArray<string>) {
	const live = new Set(scriptNames)
	const branchNames = collectPreviewBranchWorkerNames(scriptNames).filter(
		(name) => live.has(name),
	)
	return [
		...collectPreviewPullRequestNumbers(scriptNames).map(
			(number) => `kody-pr-${String(number)}`,
		),
		// A sibling like `kody-branch-x-mock-cloudflare` belongs to
		// `kody-branch-x`, whose cleanup already removes it.
		...branchNames.filter(
			(name) => !branchNames.some((base) => name.startsWith(`${base}-`)),
		),
	]
}

export async function runPreviewPrCleanup(deps: PreviewPrCleanupDeps) {
	const workerNames = listPreviewWorkerNames(await deps.listScriptNames())
	const titledSources = workerNames.some((name) =>
		name.startsWith('kody-branch-'),
	)
		? await listTitledBranchSources(deps)
		: new Map<string, { branch: string; deployedAt: string }>()
	const decisions: Array<PreviewCleanupDecision> = []
	for (const workerName of workerNames) {
		decisions.push(
			decidePreviewCleanup(
				workerName,
				await resolvePreviewOwnership(deps, workerName, titledSources),
			),
		)
	}
	const toDelete = decisions.filter((decision) => decision.action === 'delete')
	const deleted: Array<string> = []
	const deferred = toDelete
		.slice(Math.max(0, deps.maxPerRun))
		.map((decision) => decision.workerName)
	const skipped = new Map<string, string>()
	const failed: Array<string> = []
	for (const decision of toDelete.slice(0, Math.max(0, deps.maxPerRun))) {
		const { workerName } = decision
		if (!deps.hasBudget()) {
			deferred.push(workerName)
			continue
		}
		try {
			// Re-read ownership right before deleting: a PR may have reopened, or
			// a branch deploy may have started, since planning.
			if (
				workerName.startsWith('kody-branch-') &&
				(await deps.isDeployInProgress())
			) {
				skipped.set(workerName, 'a branch deploy is running')
				continue
			}
			const fresh = decidePreviewCleanup(
				workerName,
				await resolvePreviewOwnership(deps, workerName, titledSources),
			)
			if (fresh.action !== 'delete') {
				skipped.set(workerName, fresh.reason)
				continue
			}
			assertPreviewResourceName(workerName, 'worker')
			deps.log(
				`Cleaning up ${workerName} (${fresh.reason})${deps.dryRun ? ' (dry run)' : ''}.`,
			)
			await deps.cleanup(workerName)
			deleted.push(workerName)
		} catch (error) {
			deps.log(error instanceof Error ? error.message : String(error))
			failed.push(workerName)
		}
	}
	const report = formatPreviewCleanupReport({
		decisions,
		deleted,
		deferred,
		skipped,
		failed,
		dryRun: deps.dryRun,
	})
	deps.log(report)
	return { decisions, deleted, deferred, skipped, failed, report }
}

function parseArgs(argv: ReadonlyArray<string>) {
	let maxPerRun = previewPrCleanupMaxPerRunDefault
	let dryRun = false
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--dry-run') {
			dryRun = true
		} else if (arg === '--max') {
			const value = Number.parseInt(argv[index + 1] ?? '', 10)
			if (!Number.isSafeInteger(value) || value < 0) {
				fail('--max requires a non-negative integer.')
			}
			maxPerRun = value
			index += 1
		} else if (arg) {
			fail(
				`Unknown argument: ${arg}. Usage: node tools/ci/preview-pr-cleanup.ts [--max <n>] [--dry-run]`,
			)
		}
	}
	return { maxPerRun, dryRun }
}

function requireEnv(name: string) {
	const value = process.env[name]?.trim()
	if (!value) fail(`Missing ${name} for the preview PR cleanup.`)
	return value
}

async function main() {
	const { maxPerRun, dryRun } = parseArgs(process.argv.slice(2))
	const client = {
		accountId: requireEnv('CLOUDFLARE_ACCOUNT_ID'),
		apiToken: requireEnv('CLOUDFLARE_API_TOKEN'),
	}
	const repository = requireEnv('GITHUB_REPOSITORY')
	const githubToken = requireEnv('GITHUB_TOKEN')
	const deadlineMs = Date.now() + previewSweepWallClockBudgetMsDefault
	const github: GithubClient = {
		async get(path) {
			const response = await fetch(`https://api.github.com${path}`, {
				headers: {
					Accept: 'application/vnd.github+json',
					Authorization: `Bearer ${githubToken}`,
					'X-GitHub-Api-Version': '2022-11-28',
				},
				signal: AbortSignal.timeout(15_000),
			})
			if (response.status === 404) {
				await response.body?.cancel()
				return { status: 404, json: null }
			}
			if (!response.ok) {
				await response.body?.cancel()
				throw new Error(
					`GitHub API GET ${path.split('?')[0] ?? path} failed (${String(response.status)}).`,
				)
			}
			return { status: response.status, json: await response.json() }
		},
	}
	const result = await runPreviewPrCleanup({
		repository,
		defaultBranch: process.env.DEFAULT_BRANCH?.trim() || 'main',
		dryRun,
		maxPerRun,
		github,
		async listScriptNames() {
			const scripts = await cloudflareApiRequest<Array<{ id?: string }>>({
				...client,
				pathname: '/workers/scripts',
			})
			return (scripts.result ?? [])
				.map((script) => script.id)
				.filter((id): id is string => typeof id === 'string')
		},
		async readWorkerCommitSha(workerName) {
			const settings = await cloudflareApiRequest<{
				bindings?: Array<{ type?: string; name?: string; text?: unknown }>
			}>({
				...client,
				pathname: `/workers/scripts/${encodeURIComponent(workerName)}/settings`,
			})
			const binding = settings.result?.bindings?.find(
				(entry) =>
					entry.type === 'plain_text' && entry.name === 'APP_COMMIT_SHA',
			)
			return typeof binding?.text === 'string' &&
				/^[0-9a-f]{40}$/.test(binding.text)
				? binding.text
				: null
		},
		isDeployInProgress: () =>
			isPreviewDeployInProgress({ repository, githubToken }),
		cleanup: (workerName) =>
			cleanupPreviewResources({ workerName, dryRun, ...client }),
		hasBudget: () =>
			hasBudgetForAnotherCleanup({
				now: Date.now,
				deadlineMs,
				cleanupBudgetMs: previewCleanupBudgetMsDefault,
			}),
		log: (line) => console.log(line),
	})
	const summaryPath = process.env.GITHUB_STEP_SUMMARY
	if (summaryPath) appendFileSync(summaryPath, `${result.report}\n`)
	if (result.failed.length > 0) {
		fail(
			`Preview PR cleanup could not fully clean up: ${result.failed.join(', ')}. The next run retries them.`,
		)
	}
}

if (isExecutedDirectly(import.meta.url)) {
	try {
		await main()
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error))
	}
}
