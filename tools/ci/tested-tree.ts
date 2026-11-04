import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { isExecutedDirectly } from '../node-runtime.ts'

/**
 * Reuse a passing PR Validate run for the identical tree on `main`.
 *
 * `stamp` (PR gate, same-repo PRs only): records the tested merge-ref tree,
 * its base tree, and CI inputs that live outside the tree as a commit status
 * on the PR head. `lookup` (main push): recomputes that key for the pushed
 * commit and its parent and reports `skip=true` only when a stamp created by
 * github-actions[bot] points at a successful pull_request Validate run of
 * that same-repo PR head. Commit SHAs never appear in the key because the
 * squash commit differs from the tested merge commit. Every unexpected state
 * reports `skip=false`, so main runs the full suite.
 */

export const stampContext = 'kody/tested-tree'
const stampCreator = 'github-actions[bot]'
const validateWorkflowPath = '.github/workflows/validate.yml'

export type TreeKey = {
	tree: string
	baseTree: string
	githubTree: string
	ciRunner: string
	nodeVersion: string
}

export function treeStampDescription(key: TreeKey) {
	const inputs = createHash('sha256')
		.update(
			JSON.stringify({
				github: key.githubTree,
				runner: key.ciRunner,
				node: key.nodeVersion,
			}),
		)
		.digest('hex')
		.slice(0, 16)
	return `v1 tree=${key.tree} base=${key.baseTree} inputs=${inputs}`
}

type PullRequest = {
	number: number
	html_url: string
	merged_at: string | null
	merge_commit_sha: string | null
	base: { ref: string }
	head: { sha: string; repo: { full_name: string } | null }
}

type CommitStatus = {
	context: string
	state: string
	description: string | null
	target_url: string | null
	creator: { login: string } | null
}

type WorkflowRun = {
	path: string
	event: string
	status: string
	conclusion: string | null
	head_sha: string
	head_repository: { full_name: string } | null
}

export type LookupResult =
	| { skip: true; prUrl: string; runUrl: string }
	| { skip: false; reason: string }

export async function findTestedTreeStamp(input: {
	repository: string
	serverUrl: string
	sha: string
	parents: Array<string>
	before: string
	description: string
	api: <T>(path: string) => Promise<T>
}): Promise<LookupResult> {
	const { repository, sha, api } = input
	if (input.parents.length !== 1 || input.parents[0] !== input.before) {
		return {
			skip: false,
			reason: `push is not a single squash commit on top of ${input.before}.`,
		}
	}
	const pulls = await api<Array<PullRequest>>(
		`/repos/${repository}/commits/${sha}/pulls`,
	)
	const pr = pulls.find(
		(pull) =>
			pull.merged_at &&
			pull.merge_commit_sha === sha &&
			pull.base.ref === 'main',
	)
	if (!pr)
		return { skip: false, reason: `no merged PR has merge commit ${sha}.` }
	if (pr.head.repo?.full_name !== repository) {
		return { skip: false, reason: `PR #${pr.number} comes from a fork.` }
	}
	const statuses = await api<Array<CommitStatus>>(
		`/repos/${repository}/commits/${pr.head.sha}/statuses?per_page=100`,
	)
	const stamps = statuses.filter(
		(status) =>
			status.context === stampContext &&
			status.state === 'success' &&
			status.creator?.login === stampCreator,
	)
	const runPrefix = `${input.serverUrl}/${repository}/actions/runs/`
	for (const stamp of stamps) {
		if (stamp.description !== input.description) continue
		const runId = stamp.target_url?.startsWith(runPrefix)
			? /^(\d+)/.exec(stamp.target_url.slice(runPrefix.length))?.[1]
			: undefined
		if (!runId) continue
		const run = await api<WorkflowRun>(
			`/repos/${repository}/actions/runs/${runId}`,
		)
		if (
			run.path === validateWorkflowPath &&
			run.event === 'pull_request' &&
			run.status === 'completed' &&
			run.conclusion === 'success' &&
			run.head_sha === pr.head.sha &&
			run.head_repository?.full_name === repository
		) {
			return { skip: true, prUrl: pr.html_url, runUrl: `${runPrefix}${runId}` }
		}
	}
	return {
		skip: false,
		reason: stamps.length
			? `PR #${pr.number} head ${pr.head.sha} was stamped for a different tree or run (main moved after its Validate run).`
			: `PR #${pr.number} head ${pr.head.sha} has no ${stampContext} stamp.`,
	}
}

function git(...args: Array<string>) {
	const result = spawnSync('git', args, { encoding: 'utf8' })
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
	}
	return result.stdout.trim()
}

function readTreeKey(): TreeKey {
	return {
		tree: git('rev-parse', 'HEAD^{tree}'),
		baseTree: git('rev-parse', 'HEAD^1^{tree}'),
		githubTree: git('rev-parse', 'HEAD:.github'),
		ciRunner: requireEnv('VALIDATE_RUNNER'),
		nodeVersion: process.version,
	}
}

function requireEnv(name: string) {
	const value = process.env[name]?.trim()
	if (!value) throw new Error(`Missing ${name}.`)
	return value
}

function githubApi(token: string) {
	const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com'
	return async <T>(path: string, init?: RequestInit): Promise<T> => {
		const response = await fetch(`${apiUrl}${path}`, {
			...init,
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${token}`,
				'X-GitHub-Api-Version': '2022-11-28',
			},
			signal: AbortSignal.timeout(15_000),
		})
		if (!response.ok) {
			throw new Error(`GitHub ${path} responded ${response.status}`)
		}
		return (await response.json()) as T
	}
}

function writeOutputs(values: Record<string, string>) {
	const outputPath = process.env.GITHUB_OUTPUT
	if (!outputPath) return
	appendFileSync(
		outputPath,
		Object.entries(values)
			.map(([key, value]) => `${key}=${value}\n`)
			.join(''),
	)
}

function writeSummary(markdown: string) {
	const summaryPath = process.env.GITHUB_STEP_SUMMARY
	if (summaryPath) appendFileSync(summaryPath, `${markdown}\n`)
}

async function lookup() {
	const repository = requireEnv('GITHUB_REPOSITORY')
	const sha = git('rev-parse', 'HEAD')
	let result: LookupResult
	try {
		result = await findTestedTreeStamp({
			repository,
			serverUrl: requireEnv('GITHUB_SERVER_URL'),
			sha,
			parents: git('rev-list', '--parents', '-n1', 'HEAD').split(' ').slice(1),
			before: requireEnv('EVENT_BEFORE'),
			description: treeStampDescription(readTreeKey()),
			api: githubApi(requireEnv('GH_TOKEN')),
		})
	} catch (error) {
		result = {
			skip: false,
			reason: `stamp lookup failed: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
	if (result.skip) {
		console.log(
			`Tree of ${sha} already passed Validate on ${result.prUrl}: ${result.runUrl}`,
		)
		writeOutputs({
			skip: 'true',
			pr_url: result.prUrl,
			stamp_run_url: result.runUrl,
		})
		writeSummary(
			`### 🌳 Reusing PR verification\n\nTree of \`${sha}\` matches the tree that passed [this Validate run](${result.runUrl}) on ${result.prUrl}. Verification jobs are skipped; Deploy still runs.`,
		)
		return
	}
	console.log(`Running full Validate: ${result.reason}`)
	writeOutputs({ skip: 'false' })
	writeSummary(`### 🌳 Running full Validate\n\n${result.reason}`)
}

async function stamp() {
	const repository = requireEnv('GITHUB_REPOSITORY')
	const headSha = requireEnv('PR_HEAD_SHA')
	const testedHead = git('rev-parse', 'HEAD^2')
	if (testedHead !== headSha) {
		throw new Error(`Checkout HEAD^2 ${testedHead} is not PR head ${headSha}.`)
	}
	const description = treeStampDescription(readTreeKey())
	await githubApi(requireEnv('GH_TOKEN'))(
		`/repos/${repository}/statuses/${headSha}`,
		{
			method: 'POST',
			body: JSON.stringify({
				state: 'success',
				context: stampContext,
				description,
				target_url: requireEnv('RUN_URL'),
			}),
		},
	)
	console.log(`Stamped ${headSha}: ${description}`)
}

if (isExecutedDirectly(import.meta.url)) {
	const command = process.argv[2]
	if (command === 'lookup') await lookup()
	else if (command === 'stamp') await stamp()
	else throw new Error('Usage: node tools/ci/tested-tree.ts lookup|stamp')
}
