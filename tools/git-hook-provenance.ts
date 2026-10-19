import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

type GitCommandResult = {
	status: number
	stdout: string
	stderr: string
}

type GitRunner = (args: ReadonlyArray<string>) => GitCommandResult

/**
 * Local gate provenance: tree SHAs that already passed `knip` and/or
 * `test:push` (via validate or a prior pre-push). Keyed on `git` tree objects
 * so a clean validate of the same contents skips the silent pre-push re-run
 * (#3653 / #3719). Each check is recorded separately so a pre-knip
 * `test:push`-only record cannot skip knip. Stored under `.tmp/` (gitignored).
 */

const gitHookProvenanceRelativePath = '.tmp/git-hook-provenance.json'

export type GitHookProvenanceCheck = 'knip' | 'test:push'

export type GitHookProvenanceEntry = {
	at: string
	source: 'validate' | 'pre-push' | 'test:push'
}

type GitHookProvenanceDocument = {
	version: 1
	checks: Partial<
		Record<GitHookProvenanceCheck, Record<string, GitHookProvenanceEntry>>
	>
}

export type ProvenanceStore = {
	read: () => GitHookProvenanceDocument
	write: (doc: GitHookProvenanceDocument) => void
}

const emptyDocument = (): GitHookProvenanceDocument => ({
	version: 1,
	checks: {},
})

export function provenanceFilePath(repoRoot = process.cwd()) {
	return join(repoRoot, gitHookProvenanceRelativePath)
}

export function createFileProvenanceStore(
	filePath = provenanceFilePath(),
): ProvenanceStore {
	return {
		read() {
			try {
				const raw = readFileSync(filePath, 'utf8')
				const parsed = JSON.parse(raw) as GitHookProvenanceDocument
				if (parsed?.version !== 1 || typeof parsed.checks !== 'object') {
					return emptyDocument()
				}
				return parsed
			} catch {
				return emptyDocument()
			}
		},
		write(doc) {
			mkdirSync(dirname(filePath), { recursive: true })
			writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
		},
	}
}

/**
 * Tree SHA for the commit about to be pushed (`localSha^{tree}`).
 */
export function treeShaForCommit(git: GitRunner, commitSha: string) {
	const result = git([
		'rev-parse',
		'--verify',
		'--quiet',
		`${commitSha}^{tree}`,
	])
	if (result.status !== 0) return null
	const sha = result.stdout.trim()
	return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null
}

/**
 * True when `git status` lists untracked paths. `stash create` cannot include
 * them, so provenance must decline rather than certify an incomplete tree.
 */
export function hasUntrackedFiles(git: GitRunner) {
	const status = git(['status', '--porcelain', '-uall'])
	if (status.status !== 0) return true
	return status.stdout.split('\n').some((line) => line.startsWith('?? '))
}

/**
 * Tree SHA covering the current index + tracked worktree (via `stash create`).
 * Falls back to `HEAD^{tree}` when the worktree is clean enough that
 * `stash create` is empty. Does not include untracked files — callers should
 * check `hasUntrackedFiles` before recording provenance.
 */
export function treeShaForWorktree(git: GitRunner) {
	const stash = git(['stash', 'create'])
	if (stash.status === 0) {
		const stashCommit = stash.stdout.trim()
		if (/^[0-9a-f]{40}$/i.test(stashCommit)) {
			return treeShaForCommit(git, stashCommit)
		}
	}
	const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'])
	if (head.status !== 0) return null
	const sha = head.stdout.trim()
	return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null
}

export function hasProvenanceCheck(
	store: ProvenanceStore,
	check: GitHookProvenanceCheck,
	treeSha: string,
) {
	const entry = store.read().checks[check]?.[treeSha.toLowerCase()]
	return entry != null
}

export function recordProvenanceCheck(
	store: ProvenanceStore,
	input: {
		check: GitHookProvenanceCheck
		treeSha: string
		source: GitHookProvenanceEntry['source']
		at?: string
	},
) {
	const treeSha = input.treeSha.toLowerCase()
	if (!/^[0-9a-f]{40}$/i.test(treeSha)) return
	const doc = store.read()
	const byCheck = { ...doc.checks[input.check] }
	byCheck[treeSha] = {
		at: input.at ?? new Date().toISOString(),
		source: input.source,
	}
	store.write({
		version: 1,
		checks: { ...doc.checks, [input.check]: byCheck },
	})
}

/**
 * After a green `npm run validate`, mark the current worktree tree as having
 * already proven `knip` and `test:push` so the next pre-push can skip both.
 * Only records when `treeShaBefore` matches the post-run tree (caller
 * captures before suites start) and there are no untracked files.
 */
export function recordValidateTreeProvenance(
	git: GitRunner,
	store: ProvenanceStore = createFileProvenanceStore(),
	treeShaBefore?: string | null,
) {
	if (hasUntrackedFiles(git)) return null
	const treeSha = treeShaForWorktree(git)
	if (!treeSha) return null
	if (treeShaBefore != null && treeShaBefore !== treeSha) return null
	recordProvenanceCheck(store, {
		check: 'knip',
		treeSha,
		source: 'validate',
	})
	recordProvenanceCheck(store, {
		check: 'test:push',
		treeSha,
		source: 'validate',
	})
	return treeSha
}
