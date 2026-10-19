import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
	createFileProvenanceStore,
	hasProvenanceCheck,
	hasUntrackedFiles,
	provenanceFilePath,
	recordProvenanceCheck,
	recordValidateTreeProvenance,
	treeShaForCommit,
	treeShaForWorktree,
} from './git-hook-provenance.ts'
import { type GitRunner } from './git-hook-checks.ts'

const treeA = 'a'.repeat(40)
const treeB = 'b'.repeat(40)
const commitA = 'c'.repeat(40)

function gitResult(status: number, stdout = ''): ReturnType<GitRunner> {
	return { status, stdout, stderr: '' }
}

test('provenance store records and looks up tree SHAs for test:push', async () => {
	const root = await mkdtemp(join(tmpdir(), 'hook-provenance-'))
	try {
		const store = createFileProvenanceStore(provenanceFilePath(root))
		expect(hasProvenanceCheck(store, 'test:push', treeA)).toBe(false)
		recordProvenanceCheck(store, {
			check: 'test:push',
			treeSha: treeA,
			source: 'validate',
			at: '2026-10-14T00:00:00.000Z',
		})
		expect(hasProvenanceCheck(store, 'test:push', treeA)).toBe(true)
		expect(hasProvenanceCheck(store, 'test:push', treeB)).toBe(false)
		const raw = await readFile(provenanceFilePath(root), 'utf8')
		expect(JSON.parse(raw)).toMatchObject({
			version: 1,
			checks: {
				'test:push': {
					[treeA]: { source: 'validate', at: '2026-10-14T00:00:00.000Z' },
				},
			},
		})
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('treeSha helpers parse commit and stash-create results', () => {
	const git: GitRunner = (args) => {
		if (args[0] === 'rev-parse' && args.at(-1) === `${commitA}^{tree}`) {
			return gitResult(0, `${treeA}\n`)
		}
		if (args[0] === 'stash' && args[1] === 'create') {
			return gitResult(0, '')
		}
		if (args[0] === 'rev-parse' && args.at(-1) === 'HEAD^{tree}') {
			return gitResult(0, `${treeB}\n`)
		}
		return gitResult(1)
	}
	expect(treeShaForCommit(git, commitA)).toBe(treeA)
	expect(treeShaForWorktree(git)).toBe(treeB)

	const dirty: GitRunner = (args) => {
		if (args[0] === 'stash' && args[1] === 'create') {
			return gitResult(0, `${commitA}\n`)
		}
		if (args[0] === 'rev-parse' && args.at(-1) === `${commitA}^{tree}`) {
			return gitResult(0, `${treeA}\n`)
		}
		return gitResult(1)
	}
	expect(treeShaForWorktree(dirty)).toBe(treeA)
})

test('recordValidateTreeProvenance writes the worktree tree SHA', async () => {
	const root = await mkdtemp(join(tmpdir(), 'hook-validate-provenance-'))
	try {
		const store = createFileProvenanceStore(join(root, 'provenance.json'))
		const dirty: GitRunner = (args) => {
			if (args[0] === 'status') {
				return gitResult(0, '')
			}
			if (args[0] === 'stash' && args[1] === 'create') {
				return gitResult(0, `${commitA}\n`)
			}
			if (args[0] === 'rev-parse' && args.at(-1) === `${commitA}^{tree}`) {
				return gitResult(0, `${treeA}\n`)
			}
			return gitResult(1)
		}
		expect(recordValidateTreeProvenance(dirty, store, treeA)).toBe(treeA)
		expect(hasProvenanceCheck(store, 'knip', treeA)).toBe(true)
		expect(hasProvenanceCheck(store, 'test:push', treeA)).toBe(true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('recordValidateTreeProvenance skips when the tree drifted or untracked exist', async () => {
	const root = await mkdtemp(join(tmpdir(), 'hook-validate-skip-'))
	try {
		const store = createFileProvenanceStore(join(root, 'provenance.json'))
		const drifted: GitRunner = (args) => {
			if (args[0] === 'status') return gitResult(0, '')
			if (args[0] === 'stash' && args[1] === 'create') {
				return gitResult(0, `${commitA}\n`)
			}
			if (args[0] === 'rev-parse' && args.at(-1) === `${commitA}^{tree}`) {
				return gitResult(0, `${treeA}\n`)
			}
			return gitResult(1)
		}
		expect(recordValidateTreeProvenance(drifted, store, treeB)).toBe(null)
		expect(hasProvenanceCheck(store, 'test:push', treeA)).toBe(false)

		const untracked: GitRunner = (args) => {
			if (args[0] === 'status') {
				return gitResult(0, '?? tools/new-file.ts\n')
			}
			return gitResult(1)
		}
		expect(hasUntrackedFiles(untracked)).toBe(true)
		expect(recordValidateTreeProvenance(untracked, store, treeA)).toBe(null)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
