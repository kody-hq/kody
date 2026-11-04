import { expect, test } from 'vitest'
import {
	findTestedTreeStamp,
	stampContext,
	treeStampDescription,
} from './tested-tree.ts'

const repository = 'kody-hq/kody'
const serverUrl = 'https://github.com'
const sha = 's'.repeat(40)
const before = 'b'.repeat(40)
const head = 'h'.repeat(40)
const key = {
	tree: 't'.repeat(40),
	baseTree: 'u'.repeat(40),
	githubTree: 'g'.repeat(40),
	ciRunner: 'ubuntu-latest',
	nodeVersion: 'v26.0.0',
}
const description = treeStampDescription(key)
const runUrl = `${serverUrl}/${repository}/actions/runs/42`

function lookup(overrides: {
	headRepo?: string
	creator?: string
	description?: string
	run?: Record<string, unknown>
	gate?: string | null
	parents?: Array<string>
}) {
	const responses: Record<string, unknown> = {
		[`/repos/${repository}/commits/${sha}/pulls`]: [
			{
				number: 7,
				html_url: `${serverUrl}/${repository}/pull/7`,
				merged_at: '2026-11-04T00:00:00Z',
				merge_commit_sha: sha,
				base: { ref: 'main' },
				head: {
					sha: head,
					repo: { full_name: overrides.headRepo ?? repository },
				},
			},
		],
		[`/repos/${repository}/commits/${head}/statuses?per_page=100`]: [
			{
				context: stampContext,
				state: 'success',
				description: overrides.description ?? description,
				target_url: `${runUrl}/attempts/1`,
				creator: { login: overrides.creator ?? 'github-actions[bot]' },
			},
		],
		[`/repos/${repository}/actions/runs/42`]: {
			path: '.github/workflows/validate.yml',
			event: 'pull_request',
			status: 'completed',
			head_sha: head,
			head_repository: { full_name: repository },
			...overrides.run,
		},
		[`/repos/${repository}/actions/runs/42/jobs?filter=latest&per_page=100`]: {
			jobs: [
				{ name: '🖥️ Host commands (macos-15)', conclusion: null },
				{
					name: '✅ Validate',
					conclusion: overrides.gate === undefined ? 'success' : overrides.gate,
				},
			],
		},
	}
	return findTestedTreeStamp({
		repository,
		serverUrl,
		sha,
		parents: overrides.parents ?? [before],
		before,
		description,
		api: async <T>(path: string) => responses[path] as T,
	})
}

test('stamp description keys on trees and CI inputs and fits a commit status', () => {
	expect(description.length).toBeLessThanOrEqual(140)
	expect(treeStampDescription({ ...key, baseTree: 'v'.repeat(40) })).not.toBe(
		description,
	)
	expect(treeStampDescription({ ...key, nodeVersion: 'v26.0.1' })).not.toBe(
		description,
	)
})

test('skips only for a trusted stamp on a successful same-repo Validate run', async () => {
	expect(await lookup({})).toEqual({
		skip: true,
		prUrl: `${serverUrl}/${repository}/pull/7`,
		runUrl,
	})
	// An abandoned macOS job marks the run failed even when the gate passed.
	expect(await lookup({ run: { conclusion: 'failure' } })).toMatchObject({
		skip: true,
	})
	for (const overrides of [
		{ headRepo: 'someone/fork' },
		{ creator: 'kentcdodds' },
		{ description: treeStampDescription({ ...key, tree: 'x'.repeat(40) }) },
		{ gate: 'failure' },
		{ gate: null },
		{ run: { path: '.github/workflows/preview.yml' } },
		{ run: { head_sha: 'z'.repeat(40) } },
		{ parents: ['c'.repeat(40)] },
	]) {
		expect(await lookup(overrides)).toMatchObject({ skip: false })
	}
})
