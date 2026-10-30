import { expect, test } from 'vitest'
import {
	branchFromCommitRuns,
	decidePreviewCleanup,
	listPreviewWorkerNames,
	runPreviewPrCleanup,
	type PreviewPrCleanupDeps,
} from './preview-pr-cleanup.ts'

test('decidePreviewCleanup deletes only when every resolved PR is closed', () => {
	expect(
		decidePreviewCleanup('kody-pr-7', {
			kind: 'pr',
			pullRequests: [
				{ number: 7, state: 'closed', merged: true, closedAt: null },
			],
		}),
	).toMatchObject({ action: 'delete', reason: '#7 merged' })
	expect(
		decidePreviewCleanup('kody-branch-x', {
			kind: 'pr',
			branch: 'x',
			pullRequests: [
				{ number: 1, state: 'closed', merged: false, closedAt: null },
				{ number: 2, state: 'open', merged: false, closedAt: null },
			],
		}),
	).toMatchObject({ action: 'keep-open', reason: 'PR #2 still open' })
	expect(
		decidePreviewCleanup('kody-branch-x', {
			kind: 'pr',
			branch: 'x',
			pullRequests: [],
		}),
	).toMatchObject({
		action: 'delete',
		match: 'no-pr',
		reason: 'branch x has no PR',
	})
	expect(
		decidePreviewCleanup('kody-branch-x', {
			kind: 'none',
			branch: 'main',
			reason: 'deployed from main, which has no PR',
		}),
	).toMatchObject({ action: 'delete', match: 'no-pr', branch: 'main' })
	expect(
		decidePreviewCleanup('kody-branch-x', {
			kind: 'unresolved',
			reason: 'no recorded deploy commit',
		}),
	).toMatchObject({ action: 'keep-unresolved' })
})

test('branchFromCommitRuns needs exactly one successful deploy branch', () => {
	expect(
		branchFromCommitRuns([
			{ head_branch: 'feat', conclusion: 'success' },
			{ head_branch: 'feat', conclusion: 'success' },
			{ head_branch: 'other', conclusion: 'failure' },
		]),
	).toEqual({ branch: 'feat' })
	expect(
		branchFromCommitRuns([
			{ head_branch: 'feat', conclusion: 'success' },
			{ head_branch: 'main', conclusion: 'success' },
		]),
	).toBeNull()
	expect(branchFromCommitRuns([])).toBeNull()
})

test('listPreviewWorkerNames lists PR previews and live bare branch Workers only', () => {
	expect(
		listPreviewWorkerNames([
			'kody',
			'kody-production',
			'kody-platform',
			'kody-pr-12-platform',
			'kody-pr-3',
			'kody-branch-live',
			'kody-branch-live-runtime',
			'kody-branch-orphan-runtime',
			'kody-branch-live-mock-cloudflare',
			'kody-branch-live-two',
			'kody-api',
			'kody-runtime',
			'kody-nx-cache',
			'kody-backup-control-plane',
			'kody-branch',
			'kody-branch-',
			'kody-pr-',
			'kody-pr-0',
			'kody-pr-12x',
			'kody-preview',
			'kody-branch-Live',
			'kody-production-branch-x',
			'other-pr-1',
		]),
	).toEqual([
		'kody-pr-3',
		'kody-pr-12',
		'kody-branch-live',
		'kody-branch-live-two',
	])
})

test('production and other non-preview Workers never reach cleanup', async () => {
	const { deps, cleaned } = createDeps({
		scripts: [
			'kody',
			'kody-production',
			'kody-api',
			'kody-api-docs',
			'kody-platform',
			'kody-runtime',
			'kody-jobs',
			'kody-highlight',
			'kody-push-queue',
			'kody-nx-cache',
			'kody-status',
			'kody-backup-control-plane',
		],
		pulls: {},
		branchPulls: {},
	})
	const result = await runPreviewPrCleanup(deps)
	expect(result.decisions).toEqual([])
	expect(cleaned).toEqual([])
})

type Fixture = {
	scripts: Array<string>
	pulls: Record<number, { state: string; merged_at: string | null } | null>
	branchPulls: Record<
		string,
		Array<{ number: number; state: string; merged_at: string | null }>
	>
	titledRuns?: Array<Record<string, unknown>>
	commitShas?: Record<string, string>
	commitRuns?: Record<string, Array<Record<string, unknown>>>
	deployInProgress?: boolean
}

function createDeps(
	fixture: Fixture,
	overrides: Partial<PreviewPrCleanupDeps> = {},
) {
	const cleaned: Array<string> = []
	const logs: Array<string> = []
	const deps: PreviewPrCleanupDeps = {
		repository: 'kody-hq/kody',
		defaultBranch: 'main',
		dryRun: false,
		maxPerRun: 10,
		github: {
			async get(path) {
				const url = new URL(`https://api.github.com${path}`)
				const pr = /^\/repos\/kody-hq\/kody\/pulls\/(\d+)$/.exec(url.pathname)
				if (pr?.[1]) {
					const pull = fixture.pulls[Number(pr[1])]
					return pull
						? { status: 200, json: pull }
						: { status: 404, json: null }
				}
				if (url.pathname === '/repos/kody-hq/kody/pulls') {
					const branch = (url.searchParams.get('head') ?? '').replace(
						'kody-hq:',
						'',
					)
					return { status: 200, json: fixture.branchPulls[branch] ?? [] }
				}
				if (url.pathname.endsWith('/actions/workflows/preview.yml/runs')) {
					const sha = url.searchParams.get('head_sha')
					return {
						status: 200,
						json: {
							workflow_runs: sha
								? (fixture.commitRuns?.[sha] ?? [])
								: (fixture.titledRuns ?? []),
						},
					}
				}
				throw new Error(`unexpected GitHub GET ${path}`)
			},
		},
		listScripts: async () =>
			fixture.scripts.map((name) => ({
				name,
				modifiedOn: '2026-10-09T00:00:00Z',
			})),
		readWorkerCommitSha: async (name) => fixture.commitShas?.[name] ?? null,
		isDeployInProgress: async () => fixture.deployInProgress ?? false,
		cleanup: async (name) => {
			cleaned.push(name)
		},
		hasBudget: () => true,
		log: (line) => logs.push(line),
		...overrides,
	}
	return { deps, cleaned, logs }
}

const sha = (char: string) => char.repeat(40)

test('runPreviewPrCleanup deletes closed, merged, and no-PR previews and keeps open or unknown ones', async () => {
	const { deps, cleaned } = createDeps({
		scripts: [
			'kody-pr-1',
			'kody-pr-1-runtime',
			'kody-pr-2',
			'kody-pr-3',
			'kody-branch-merged',
			'kody-branch-titled',
			'kody-branch-from-main',
			'kody-branch-no-pr',
			'kody-branch-no-commit',
			'kody-production',
		],
		pulls: {
			1: { state: 'closed', merged_at: '2026-10-01T00:00:00Z' },
			2: { state: 'open', merged_at: null },
			3: null,
		},
		branchPulls: {
			'feat/merged': [
				{ number: 10, state: 'closed', merged_at: '2026-10-02T00:00:00Z' },
				{ number: 11, state: 'closed', merged_at: null },
			],
			'feat/titled': [{ number: 12, state: 'open', merged_at: null }],
		},
		titledRuns: [
			{
				display_title: 'Preview deploy (branch: titled)',
				head_branch: 'feat/titled',
				status: 'completed',
				conclusion: 'success',
				updated_at: '2026-10-20T00:00:00Z',
			},
		],
		commitShas: {
			'kody-branch-merged': sha('a'),
			'kody-branch-from-main': sha('b'),
			'kody-branch-no-pr': sha('c'),
		},
		commitRuns: {
			[sha('a')]: [{ head_branch: 'feat/merged', conclusion: 'success' }],
			[sha('b')]: [{ head_branch: 'main', conclusion: 'success' }],
			[sha('c')]: [{ head_branch: 'feat/lonely', conclusion: 'success' }],
		},
	})
	const result = await runPreviewPrCleanup(deps)
	expect(cleaned).toEqual([
		'kody-pr-1',
		'kody-pr-3',
		'kody-branch-from-main',
		'kody-branch-merged',
		'kody-branch-no-pr',
	])
	expect(
		Object.fromEntries(
			result.decisions.map((decision) => [
				decision.workerName,
				decision.reason,
			]),
		),
	).toEqual({
		'kody-pr-1': '#1 merged',
		'kody-pr-2': 'PR #2 still open',
		'kody-pr-3': 'PR #3 not found',
		'kody-branch-from-main': 'deployed from main, which has no PR',
		'kody-branch-merged': '#10 merged, #11 closed',
		'kody-branch-no-commit': 'no recorded deploy commit',
		'kody-branch-no-pr': 'branch feat/lonely has no PR',
		'kody-branch-titled': 'PR #12 still open',
	})
	expect(result.report).toContain(
		'| `kody-pr-1` | 2026-10-09 |  | #1 merged | deleted |',
	)
	expect(result.report).toContain(
		'| `kody-branch-no-commit` | 2026-10-09 |  | no recorded deploy commit | kept (owner unknown) |',
	)
	expect(cleaned).not.toContain('kody-production')
})

test('dry run reports what it would delete through the dry-run cleanup', async () => {
	const { deps, cleaned } = createDeps(
		{
			scripts: ['kody-pr-1'],
			pulls: { 1: { state: 'closed', merged_at: null } },
			branchPulls: {},
		},
		{ dryRun: true },
	)
	const result = await runPreviewPrCleanup(deps)
	expect(cleaned).toEqual(['kody-pr-1'])
	expect(result.report).toContain('## Preview PR cleanup (dry run)')
	expect(result.report).toContain('would delete (dry run)')
})

test('re-checks ownership before each delete and honors the cap and deploys', async () => {
	let reads = 0
	const fixture: Fixture = {
		scripts: ['kody-pr-1', 'kody-pr-2', 'kody-pr-3', 'kody-branch-merged'],
		pulls: {
			1: { state: 'closed', merged_at: null },
			2: { state: 'closed', merged_at: null },
			3: { state: 'closed', merged_at: null },
		},
		branchPulls: {
			'feat/merged': [{ number: 10, state: 'closed', merged_at: null }],
		},
		commitShas: { 'kody-branch-merged': sha('a') },
		commitRuns: {
			[sha('a')]: [{ head_branch: 'feat/merged', conclusion: 'success' }],
		},
		deployInProgress: true,
	}
	const { deps, cleaned } = createDeps(fixture, { maxPerRun: 3 })
	const get = deps.github.get
	deps.github.get = async (path) => {
		// PR 2 reopens between planning and its delete.
		if (path.endsWith('/pulls/2') && ++reads > 1) {
			return { status: 200, json: { state: 'open', merged_at: null } }
		}
		return get(path)
	}
	const result = await runPreviewPrCleanup(deps)
	expect(cleaned).toEqual(['kody-pr-1', 'kody-pr-3'])
	expect(result.skipped.get('kody-pr-2')).toBe('PR #2 still open')
	expect(result.deferred).toEqual(['kody-branch-merged'])
})

test('a deploy in progress skips branch previews but not PR previews', async () => {
	const { deps, cleaned } = createDeps({
		scripts: ['kody-pr-1', 'kody-branch-merged'],
		pulls: { 1: { state: 'closed', merged_at: null } },
		branchPulls: {
			'feat/merged': [{ number: 10, state: 'closed', merged_at: null }],
		},
		commitShas: { 'kody-branch-merged': sha('a') },
		commitRuns: {
			[sha('a')]: [{ head_branch: 'feat/merged', conclusion: 'success' }],
		},
		deployInProgress: true,
	})
	const result = await runPreviewPrCleanup(deps)
	expect(cleaned).toEqual(['kody-pr-1'])
	expect(result.skipped.get('kody-branch-merged')).toBe(
		'a branch deploy is running',
	)
})

test('a failed cleanup is reported and does not stop later deletes', async () => {
	const { deps, cleaned } = createDeps(
		{
			scripts: ['kody-pr-1', 'kody-pr-2'],
			pulls: {
				1: { state: 'closed', merged_at: null },
				2: { state: 'closed', merged_at: null },
			},
			branchPulls: {},
		},
		{},
	)
	const cleanup = deps.cleanup
	deps.cleanup = async (name) => {
		if (name === 'kody-pr-1') throw new Error('boom')
		await cleanup(name)
	}
	const result = await runPreviewPrCleanup(deps)
	expect(result.failed).toEqual(['kody-pr-1'])
	expect(cleaned).toEqual(['kody-pr-2'])
	expect(result.report).toContain('delete failed')
})

test('a branch preview redeployed from an open-PR branch after planning is kept', async () => {
	let titledReads = 0
	const { deps, cleaned } = createDeps({
		scripts: ['kody-branch-reused'],
		pulls: {},
		branchPulls: {
			'feat/open': [{ number: 20, state: 'open', merged_at: null }],
		},
		commitShas: { 'kody-branch-reused': sha('d') },
		commitRuns: {
			[sha('d')]: [{ head_branch: 'main', conclusion: 'success' }],
		},
	})
	const get = deps.github.get
	deps.github.get = async (path) => {
		const url = new URL(`https://api.github.com${path}`)
		if (
			url.pathname.endsWith('/actions/workflows/preview.yml/runs') &&
			!url.searchParams.has('head_sha') &&
			++titledReads > 1
		) {
			return {
				status: 200,
				json: {
					workflow_runs: [
						{
							display_title: 'Preview deploy (branch: reused)',
							head_branch: 'feat/open',
							status: 'completed',
							conclusion: 'success',
							updated_at: '2026-10-30T00:00:00Z',
						},
					],
				},
			}
		}
		return get(path)
	}
	const result = await runPreviewPrCleanup(deps)
	expect(result.decisions[0]).toMatchObject({
		action: 'delete',
		match: 'no-pr',
	})
	expect(cleaned).toEqual([])
	expect(result.skipped.get('kody-branch-reused')).toBe('PR #20 still open')
})

test('Last deployed dates each preview from its own Workers only', async () => {
	const { deps } = createDeps(
		{
			scripts: [],
			pulls: { 1: { state: 'open', merged_at: null } },
			branchPulls: {},
		},
		{
			listScripts: async () => [
				{ name: 'kody-pr-1', modifiedOn: '2026-10-01T00:00:00Z' },
				{ name: 'kody-pr-1-runtime', modifiedOn: '2026-10-02T00:00:00Z' },
				{ name: 'kody-branch-live', modifiedOn: '2026-10-03T00:00:00Z' },
				{ name: 'kody-branch-live-two', modifiedOn: '2026-10-20T00:00:00Z' },
				{
					name: 'kody-branch-live-two-runtime',
					modifiedOn: '2026-10-21T00:00:00Z',
				},
			],
		},
	)
	const { report } = await runPreviewPrCleanup({ ...deps, dryRun: true })
	expect(report).toContain('| `kody-pr-1` | 2026-10-02 |')
	expect(report).toContain('| `kody-branch-live` | 2026-10-03 |')
	expect(report).toContain('| `kody-branch-live-two` | 2026-10-21 |')
})
