import { spawn, spawnSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveNpmCommand, isExecutedDirectly } from './node-runtime.ts'
import {
	createFileProvenanceStore,
	hasProvenanceCheck,
	hasUntrackedFiles,
	recordProvenanceCheck,
	treeShaForCommit,
	treeShaForWorktree,
	type ProvenanceStore,
} from './git-hook-provenance.ts'

/**
 * Husky pre-commit and pre-push gates.
 *
 * A docs-only diff skips install:check, typecheck, migrations:check, knip,
 * and test:push. lint-staged still formats the commit. Any other path,
 * including a comment in a source file, keeps the full check for that hook.
 * An unreadable diff fails closed and runs the check.
 *
 * pre-push also runs `node tools/check-skills-lock.ts` when the push changes
 * skills-lock.json or a path under .agents/skills/, and when the pushed paths
 * cannot be listed.
 * Markdown skill files are docs-only, so they do not run knip or test:push.
 * skills-lock.json alone does not either. Executable files under
 * .agents/skills/ still run knip and test:push.
 *
 * Rename detection is off so a source file renamed to markdown still lists
 * the deleted path.
 *
 * Pre-push runs `npm run knip` (same files/exports/types gate as CI) before
 * `test:push` on non-docs pushes. A knip failure tells the agent to run
 * `npm run knip` and fix. CI keeps its Knip step as the backstop.
 *
 * Pre-push skips `knip` and/or `test:push` when that check's tree SHA is
 * already recorded green from `npm run validate` or a prior successful
 * pre-push of the same check (#3653 / #3719). Knip and test:push provenance
 * are separate so a pre-knip `test:push`-only record cannot skip knip.
 * Progress logs tick every 30s so a long workers-unit run is not a silent
 * hang (#3547). Workers-unit isolation (ADR 0011) is unchanged.
 *
 * Pre-commit typecheck runs in a detached git worktree built from
 * `git write-tree` (the index) so unstaged fixes cannot greenlight a broken
 * index (#3695). The user's worktree is never mutated — no stash pop, no
 * checkout -- ., no moving untracked files aside.
 */

export type GitHookName = 'pre-commit' | 'pre-push'

type GitCommandResult = {
	status: number
	stdout: string
	stderr: string
}

export type GitRunner = (args: ReadonlyArray<string>) => GitCommandResult

export type GitHookCheckPlan = {
	runInstallCheck: boolean
	runTypecheck: boolean
	runMigrationsCheck: boolean
	runKnip: boolean
	runUnitTests: boolean
	runSkillsLockCheck: boolean
	summary: string
}

type PrePushUpdate = {
	localRef: string
	localSha: string
	remoteSha: string
}

const prePushLinePattern =
	/^(?<localRef>\S+) (?<localSha>[0-9a-f]{40}) (?<remoteRef>\S+) (?<remoteSha>[0-9a-f]{40})$/i

const markdownExtensionPattern = /\.(?:md|mdx|mdc)$/i

const licenseBasenamePattern =
	/^(?:license|licence|copying|notice)(?:\.(?:md|txt))?$/i

const newRefBaseCandidates = ['origin/HEAD', 'origin/main', 'main'] as const

/** Heartbeat while a long hook script (test:push) inherits silence from vitest. */
export const gitHookProgressIntervalMs = 30_000

function normalizeHookPath(filePath: string) {
	// Git path output uses `/` even on Windows. A literal backslash is part of
	// the filename, so do not treat it as a separator.
	return filePath.replace(/^\.\//, '')
}

export function isDocsOnlyHookPath(filePath: string) {
	const path = normalizeHookPath(filePath)
	if (path.length === 0 || path.startsWith('../') || path.includes('/../')) {
		return false
	}
	if (path.startsWith('docs/')) return true
	if (markdownExtensionPattern.test(path)) return true
	const basename = path.slice(path.lastIndexOf('/') + 1)
	return licenseBasenamePattern.test(basename)
}

export function planGitHookChecks(input: {
	hook: GitHookName
	paths: ReadonlyArray<string> | null
}): GitHookCheckPlan {
	switch (input.hook) {
		case 'pre-commit':
			return planPreCommit(input.paths)
		case 'pre-push':
			return planPrePush(input.paths)
		default: {
			const exhaustive: never = input.hook
			throw new Error(`Unhandled git hook: ${exhaustive}`)
		}
	}
}

export function hookScripts(plan: GitHookCheckPlan) {
	const scripts: Array<string> = []
	if (plan.runInstallCheck) scripts.push('install:check')
	if (plan.runTypecheck) scripts.push('typecheck')
	if (plan.runMigrationsCheck) scripts.push('migrations:check')
	if (plan.runSkillsLockCheck) scripts.push('node tools/check-skills-lock.ts')
	if (plan.runKnip) scripts.push('knip')
	if (plan.runUnitTests) scripts.push('test:push')
	return scripts
}

export function listHookPaths(input: {
	hook: GitHookName
	git: GitRunner
	stdin?: string | null
}): ReadonlyArray<string> | null {
	switch (input.hook) {
		case 'pre-commit':
			return listDiffPaths(input.git, [
				'diff',
				'--cached',
				'--name-only',
				'--no-renames',
				'-z',
			])
		case 'pre-push':
			return listPushedPaths(input.git, input.stdin ?? null)
		default: {
			const exhaustive: never = input.hook
			throw new Error(`Unhandled git hook: ${exhaustive}`)
		}
	}
}

export function pushedCommitShas(stdin: string | null): ReadonlyArray<string> {
	const updates = parsePrePushUpdates(stdin)
	if (updates === null) return []
	return updates
		.filter((update) => !isZeroSha(update.localSha))
		.map((update) => update.localSha)
}

function uniquePushedTreeSha(input: {
	git: GitRunner
	stdin?: string | null
}): string | null {
	const shas = pushedCommitShas(input.stdin ?? null)
	if (shas.length === 0) return null
	const trees: Array<string> = []
	for (const sha of shas) {
		const treeSha = treeShaForCommit(input.git, sha)
		if (!treeSha) return null
		trees.push(treeSha)
	}
	const unique = [...new Set(trees)]
	return unique.length === 1 ? unique[0]! : null
}

export function shouldSkipProvenanceCheck(input: {
	git: GitRunner
	stdin?: string | null
	store: ProvenanceStore
	check: 'knip' | 'test:push'
}): { skip: boolean; treeSha: string | null; reason: string | null } {
	const treeSha = uniquePushedTreeSha(input)
	if (!treeSha) {
		return { skip: false, treeSha: null, reason: null }
	}
	if (!hasProvenanceCheck(input.store, input.check, treeSha)) {
		return { skip: false, treeSha, reason: null }
	}
	return {
		skip: true,
		treeSha,
		reason: `pre-push: skipping ${input.check} (tree ${treeSha.slice(0, 12)} already green)`,
	}
}

export function shouldSkipTestPushForProvenance(input: {
	git: GitRunner
	stdin?: string | null
	store: ProvenanceStore
}): { skip: boolean; treeSha: string | null; reason: string | null } {
	return shouldSkipProvenanceCheck({ ...input, check: 'test:push' })
}

function worktreeHasUnstagedOrUntracked(porcelainStdout: string) {
	const porcelainLine = /^(?:\?\?|[ MADRCU!][ MADRCU!]) /
	for (const raw of porcelainStdout.split('\n')) {
		const line = raw.trimEnd()
		if (!porcelainLine.test(line)) continue
		if (line.startsWith('?? ')) return true
		// Porcelain XY: second column is worktree; space means clean.
		if (line[1] !== ' ') return true
	}
	return false
}

/**
 * Typecheck the index (staged tree) in a detached worktree so the user's
 * worktree is never mutated (#3695). Unstaged / untracked files stay put.
 */
export async function withStagedTreeForTypecheck<T>(input: {
	git: GitRunner
	/** Optional cwd is the staged-tree worktree path when isolation is active. */
	run: (cwd?: string) => T | Promise<T>
	log?: (message: string) => void
	/** Repo root for the temporary worktree (tests inject a temp root). */
	repoRoot?: string
}): Promise<T> {
	const log = input.log ?? (() => {})
	const repoRoot = input.repoRoot ?? process.cwd()
	const status = input.git(['status', '--porcelain', '-uall'])
	if (status.status !== 0) {
		log('pre-commit: could not read worktree status; typechecking as-is')
		return input.run()
	}
	if (!worktreeHasUnstagedOrUntracked(status.stdout)) {
		return input.run()
	}

	const writeTree = input.git(['write-tree'])
	if (writeTree.status !== 0) {
		log(
			`pre-commit: git write-tree failed (${writeTree.stderr.trim() || 'unknown'}); refusing to typecheck a dirty worktree as-is`,
		)
		return 1 as T
	}
	const indexTree = writeTree.stdout.trim()
	if (!/^[0-9a-f]{40}$/i.test(indexTree)) {
		log(
			'pre-commit: git write-tree returned no tree SHA; refusing to typecheck a dirty worktree as-is',
		)
		return 1 as T
	}

	// Pin identity via -c so Cloud Agent / fresh clones without user.* still
	// get a staged tree; never fall back to typechecking the dirty worktree.
	const commitTree = input.git([
		'-c',
		'user.email=kody-pre-commit@localhost',
		'-c',
		'user.name=kody-pre-commit',
		'commit-tree',
		indexTree,
		'-m',
		'kody-pre-commit-typecheck',
	])
	if (commitTree.status !== 0) {
		log(
			`pre-commit: git commit-tree failed (${commitTree.stderr.trim() || 'unknown'}); refusing to typecheck a dirty worktree as-is`,
		)
		return 1 as T
	}
	const stagedCommit = commitTree.stdout.trim()
	if (!/^[0-9a-f]{40}$/i.test(stagedCommit)) {
		log(
			'pre-commit: git commit-tree returned no commit; refusing to typecheck a dirty worktree as-is',
		)
		return 1 as T
	}

	const tmpRoot = join(repoRoot, '.tmp')
	mkdirSync(tmpRoot, { recursive: true })
	const worktreePath = join(
		tmpRoot,
		`pre-commit-typecheck-${process.pid}-${stagedCommit.slice(0, 8)}`,
	)
	if (existsSync(worktreePath)) {
		rmSync(worktreePath, { recursive: true, force: true })
	}

	log(
		`pre-commit: typechecking staged tree in ${worktreePath} (index ${indexTree.slice(0, 12)})`,
	)
	// worktree add/remove must not inherit pre-commit GIT_INDEX_FILE — that
	// alternate index can be clobbered while the worktree is initialized, so
	// the hook would typecheck one tree and commit another.
	const add = gitWithoutIndexFile(input.git, [
		'worktree',
		'add',
		'--detach',
		worktreePath,
		stagedCommit,
	])
	if (add.status !== 0) {
		log(
			`pre-commit: git worktree add failed (${add.stderr.trim() || add.stdout.trim() || 'unknown'}); refusing to typecheck a dirty worktree as-is`,
		)
		return 1 as T
	}

	// npm nests a workspace's deps under packages/<name>/node_modules when they
	// cannot hoist, so link every installed node_modules, not just the root.
	const nodeModulesDirs = listInstalledNodeModulesDirs(repoRoot)
	for (const relative of nodeModulesDirs) {
		const worktreeNodeModules = join(worktreePath, relative)
		if (existsSync(worktreeNodeModules)) continue
		try {
			mkdirSync(dirname(worktreeNodeModules), { recursive: true })
			symlinkSync(join(repoRoot, relative), worktreeNodeModules, 'junction')
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			log(
				`pre-commit: could not link ${relative} into staged worktree (${message})`,
			)
			removeStagedTypecheckWorktree(
				input.git,
				worktreePath,
				nodeModulesDirs,
				log,
			)
			return 1 as T
		}
	}

	try {
		return await input.run(worktreePath)
	} finally {
		removeStagedTypecheckWorktree(input.git, worktreePath, nodeModulesDirs, log)
	}
}

export function listInstalledNodeModulesDirs(repoRoot: string): string[] {
	const dirs: string[] = []
	if (existsSync(join(repoRoot, 'node_modules'))) dirs.push('node_modules')
	let workspaces: unknown = []
	try {
		const manifest = JSON.parse(
			readFileSync(join(repoRoot, 'package.json'), 'utf8'),
		) as { workspaces?: unknown }
		workspaces = manifest.workspaces ?? []
	} catch {
		return dirs
	}
	if (!Array.isArray(workspaces)) return dirs
	for (const pattern of workspaces) {
		if (typeof pattern !== 'string') continue
		const workspaceDirs = pattern.endsWith('/*')
			? listChildDirs(repoRoot, pattern.slice(0, -2))
			: [pattern]
		for (const workspaceDir of workspaceDirs) {
			const relative = join(workspaceDir, 'node_modules')
			if (existsSync(join(repoRoot, relative))) dirs.push(relative)
		}
	}
	return dirs
}

function listChildDirs(repoRoot: string, parent: string): string[] {
	try {
		return readdirSync(join(repoRoot, parent), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(parent, entry.name))
	} catch {
		return []
	}
}

function removeStagedTypecheckWorktree(
	git: GitRunner,
	worktreePath: string,
	nodeModulesDirs: ReadonlyArray<string>,
	log: (message: string) => void,
) {
	// Drop the junctions/symlinks first so recursive deletes (and older Git
	// for Windows worktree remove) cannot traverse into the real
	// repo node_modules.
	for (const relative of nodeModulesDirs) {
		try {
			rmSync(join(worktreePath, relative), { force: true })
		} catch {
			// Missing link is fine.
		}
	}
	const remove = gitWithoutIndexFile(git, [
		'worktree',
		'remove',
		'--force',
		worktreePath,
	])
	if (remove.status !== 0) {
		log(
			`pre-commit: warning: git worktree remove failed (${remove.stderr.trim() || remove.stdout.trim() || 'unknown'}); removing ${worktreePath} from disk`,
		)
		try {
			rmSync(worktreePath, { recursive: true, force: true })
		} catch {
			// Best-effort.
		}
		gitWithoutIndexFile(git, ['worktree', 'prune'])
	}
}

/**
 * Run git with `GIT_INDEX_FILE` cleared. Pre-commit may set an alternate
 * index; `git worktree add/remove` must not rewrite it.
 */
function gitWithoutIndexFile(
	git: GitRunner,
	args: ReadonlyArray<string>,
): GitCommandResult {
	const previous = process.env.GIT_INDEX_FILE
	delete process.env.GIT_INDEX_FILE
	try {
		return git(args)
	} finally {
		if (previous === undefined) {
			delete process.env.GIT_INDEX_FILE
		} else {
			process.env.GIT_INDEX_FILE = previous
		}
	}
}

export async function runGitHookChecks(input: {
	hook: GitHookName
	stdin?: string | null
	git?: GitRunner
	runScript?: (script: string, cwd?: string) => number | Promise<number>
	log?: (message: string) => void
	provenance?: ProvenanceStore
	now?: () => number
	progressIntervalMs?: number
}) {
	const git = input.git ?? defaultGit
	const runScript = input.runScript ?? defaultRunNpmScript
	const log = input.log ?? console.log
	const provenance = input.provenance ?? createFileProvenanceStore()
	const now = input.now ?? Date.now
	const progressIntervalMs =
		input.progressIntervalMs ?? gitHookProgressIntervalMs
	const paths = listHookPaths({
		hook: input.hook,
		git,
		stdin: input.stdin,
	})
	const plan = planGitHookChecks({ hook: input.hook, paths })
	log(plan.summary)

	let scripts = hookScripts(plan)
	if (input.hook === 'pre-push') {
		if (scripts.includes('knip')) {
			const skipKnip = shouldSkipProvenanceCheck({
				git,
				stdin: input.stdin,
				store: provenance,
				check: 'knip',
			})
			if (skipKnip.skip && skipKnip.reason) {
				log(skipKnip.reason)
				scripts = scripts.filter((script) => script !== 'knip')
			}
		}
		if (scripts.includes('test:push')) {
			const skipTests = shouldSkipProvenanceCheck({
				git,
				stdin: input.stdin,
				store: provenance,
				check: 'test:push',
			})
			if (skipTests.skip && skipTests.reason) {
				log(skipTests.reason)
				scripts = scripts.filter((script) => script !== 'test:push')
			}
		}
	}

	for (const script of scripts) {
		const started = now()
		const label = hookCommandLabel(script)
		log(`hook: starting ${label}`)
		const heartbeat = setInterval(() => {
			const elapsedSec = Math.max(1, Math.round((now() - started) / 1000))
			log(`hook: still running ${label} (${elapsedSec}s)`)
		}, progressIntervalMs)
		// Unref so a stuck interval cannot keep the process alive after exit.
		heartbeat.unref?.()
		let status: number
		// Provenance must bind to the tree that was actually tested, not
		// whatever commit tips appear on stdin (#3745 review). Skip the
		// fingerprint when stdin has no pushable SHAs (blank / delete-only).
		const recordsProvenance = script === 'test:push' || script === 'knip'
		const pushShas = recordsProvenance
			? pushedCommitShas(input.stdin ?? null)
			: []
		const testedTreeBefore =
			pushShas.length > 0 ? treeShaForWorktree(git) : null
		try {
			if (input.hook === 'pre-commit' && script === 'typecheck') {
				status = await withStagedTreeForTypecheck({
					git,
					log,
					run: (cwd) => runScript(script, cwd),
				})
			} else {
				status = await runScript(script)
			}
		} finally {
			clearInterval(heartbeat)
		}
		const elapsedSec = Math.max(0, Math.round((now() - started) / 1000))
		log(`hook: finished ${label} in ${elapsedSec}s (exit ${status})`)
		if (status !== 0) {
			if (script === 'knip') {
				log(
					'pre-push: knip failed. Run `npm run knip` and fix unused files, exports, or types before pushing.',
				)
			}
			return status
		}
		if (recordsProvenance && pushShas.length > 0) {
			if (hasUntrackedFiles(git)) {
				log(
					`pre-push: not recording ${script} provenance (untracked files present; stash create cannot fingerprint them)`,
				)
				continue
			}
			const testedTreeAfter = treeShaForWorktree(git)
			if (
				!testedTreeBefore ||
				!testedTreeAfter ||
				testedTreeBefore !== testedTreeAfter
			) {
				log(
					`pre-push: not recording ${script} provenance (worktree changed during the run or could not be fingerprinted)`,
				)
				continue
			}
			for (const sha of pushShas) {
				const commitTree = treeShaForCommit(git, sha)
				if (!commitTree || commitTree !== testedTreeAfter) continue
				recordProvenanceCheck(provenance, {
					check: script === 'knip' ? 'knip' : 'test:push',
					treeSha: commitTree,
					source: 'pre-push',
				})
			}
		}
	}
	return 0
}

function planPreCommit(paths: ReadonlyArray<string> | null): GitHookCheckPlan {
	if (paths === null) {
		return {
			runInstallCheck: true,
			runTypecheck: true,
			runMigrationsCheck: true,
			runKnip: false,
			runUnitTests: false,
			runSkillsLockCheck: false,
			summary:
				'pre-commit: running install:check, typecheck, and migrations:check (could not list staged paths)',
		}
	}
	if (paths.every(isDocsOnlyHookPath)) {
		return {
			runInstallCheck: false,
			runTypecheck: false,
			runMigrationsCheck: false,
			runKnip: false,
			runUnitTests: false,
			runSkillsLockCheck: false,
			summary: `pre-commit: skipping install:check, typecheck, and migrations:check (${docsOnlySummary(paths)})`,
		}
	}
	return {
		runInstallCheck: true,
		runTypecheck: true,
		runMigrationsCheck: true,
		runKnip: false,
		runUnitTests: false,
		runSkillsLockCheck: false,
		summary: `pre-commit: running install:check, typecheck, and migrations:check (${codePathSummary(paths)})`,
	}
}

function planPrePush(paths: ReadonlyArray<string> | null): GitHookCheckPlan {
	if (paths === null) {
		return {
			runInstallCheck: false,
			runTypecheck: false,
			runMigrationsCheck: false,
			runKnip: true,
			runUnitTests: true,
			runSkillsLockCheck: true,
			summary:
				'pre-push: running knip, test:push, and skills-lock (could not list pushed paths)',
		}
	}
	const skillsLock = paths.some(isSkillsLockHookPath)
	// skills-lock.json is not markdown. Markdown under .agents/skills/ is
	// already docs-only. Executable skill scripts (.mjs, tests) are not, so
	// they still run knip and test:push.
	if (paths.every(skipsPrePushUnitTests)) {
		if (skillsLock) {
			return {
				runInstallCheck: false,
				runTypecheck: false,
				runMigrationsCheck: false,
				runKnip: false,
				runUnitTests: false,
				runSkillsLockCheck: true,
				summary: `pre-push: running skills-lock (${skillsLockPathSummary(paths)})`,
			}
		}
		return {
			runInstallCheck: false,
			runTypecheck: false,
			runMigrationsCheck: false,
			runKnip: false,
			runUnitTests: false,
			runSkillsLockCheck: false,
			summary: `pre-push: skipping knip and test:push (${docsOnlySummary(paths)})`,
		}
	}
	return {
		runInstallCheck: false,
		runTypecheck: false,
		runMigrationsCheck: false,
		runKnip: true,
		runUnitTests: true,
		runSkillsLockCheck: skillsLock,
		summary: skillsLock
			? `pre-push: running skills-lock, knip, and test:push (${codePathSummary(paths)})`
			: `pre-push: running knip and test:push (${codePathSummary(paths)})`,
	}
}

export function isSkillsLockHookPath(filePath: string) {
	const normalized = normalizeHookPath(filePath)
	return (
		normalized === 'skills-lock.json' ||
		normalized.startsWith('.agents/skills/')
	)
}

function skipsPrePushUnitTests(filePath: string) {
	return (
		isDocsOnlyHookPath(filePath) ||
		normalizeHookPath(filePath) === 'skills-lock.json'
	)
}

function skillsLockPathSummary(paths: ReadonlyArray<string>) {
	const skillPaths = paths.filter(isSkillsLockHookPath).sort()
	return skillPaths[0] ?? 'skills-lock.json'
}

function docsOnlySummary(paths: ReadonlyArray<string>) {
	if (paths.length === 0) return 'no file changes'
	const count = String(paths.length)
	return `${count} docs-only path${paths.length === 1 ? '' : 's'}`
}

function codePathSummary(paths: ReadonlyArray<string>) {
	const codePaths = paths.filter((path) => !isDocsOnlyHookPath(path)).sort()
	return codePaths[0] ?? 'a non-docs path'
}

function listPushedPaths(
	git: GitRunner,
	stdin: string | null,
): ReadonlyArray<string> | null {
	const updates = parsePrePushUpdates(stdin)
	if (updates === null) return null

	const paths = new Set<string>()
	for (const update of updates) {
		if (isZeroSha(update.localSha)) continue
		const from = isZeroSha(update.remoteSha)
			? resolveNewRefBase(git, update.localRef, update.localSha)
			: update.remoteSha
		if (from === null) return null
		const diff = listDiffPaths(git, [
			'diff',
			'--name-only',
			'--no-renames',
			'-z',
			from,
			update.localSha,
		])
		if (diff === null) return null
		for (const path of diff) paths.add(path)
	}
	return [...paths].sort()
}

export function parsePrePushUpdates(
	stdin: string | null,
): ReadonlyArray<PrePushUpdate> | null {
	if (stdin === null) return null
	const updates: Array<PrePushUpdate> = []
	for (const rawLine of stdin.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (line.length === 0) continue
		const match = prePushLinePattern.exec(line)
		const localRef = match?.groups?.localRef
		const localSha = match?.groups?.localSha
		const remoteSha = match?.groups?.remoteSha
		if (!localRef || !localSha || !remoteSha) return null
		updates.push({ localRef, localSha, remoteSha })
	}
	if (updates.length === 0) return null
	return updates
}

function resolveNewRefBase(
	git: GitRunner,
	localRef: string,
	localSha: string,
): string | null {
	const localBranch = localRef.startsWith('refs/heads/')
		? localRef.slice('refs/heads/'.length)
		: null
	for (const candidate of newRefBaseCandidates) {
		if (candidate === localBranch) continue
		const resolved = git([
			'rev-parse',
			'--verify',
			'--quiet',
			`${candidate}^{commit}`,
		])
		if (resolved.status !== 0) continue
		const base = git(['merge-base', candidate, localSha])
		if (base.status !== 0) continue
		const sha = base.stdout.trim()
		if (/^[0-9a-f]{40}$/i.test(sha)) return sha
	}
	return null
}

function listDiffPaths(
	git: GitRunner,
	args: ReadonlyArray<string>,
): ReadonlyArray<string> | null {
	const result = git(args)
	if (result.status !== 0) return null
	const paths = result.stdout
		.split('\0')
		.map((path) => normalizeHookPath(path))
		.filter((path) => path.length > 0)
	return [...new Set(paths)].sort()
}

function isZeroSha(sha: string) {
	return /^0{40}$/i.test(sha)
}

function defaultGit(args: ReadonlyArray<string>): GitCommandResult {
	const env =
		args[0] === 'worktree'
			? (() => {
					const next = { ...process.env }
					delete next.GIT_INDEX_FILE
					return next
				})()
			: undefined
	const result = spawnSync('git', args, {
		encoding: 'utf8',
		...(env ? { env } : {}),
	})
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	}
}

export function gitHookScriptEnv(source: NodeJS.ProcessEnv = process.env) {
	const result = defaultGit(['rev-parse', '--local-env-vars'])
	if (result.status !== 0) {
		throw new Error(
			'Could not isolate Git hook checks from repository environment',
		)
	}
	const env = { ...source }
	// Tests create foreign repositories. Inherited worktree variables would
	// redirect their Git commands back into the repository being pushed.
	for (const name of result.stdout.trim().split(/\s+/)) delete env[name]
	return env
}

/** Label for progress logs (`npm run X` or a bare `node …` command). */
export function hookCommandLabel(script: string) {
	return script.startsWith('node ') ? script : `npm run ${script}`
}

function defaultRunNpmScript(script: string, cwd?: string): Promise<number> {
	return new Promise((resolve) => {
		const child = script.startsWith('node ')
			? spawn(process.execPath, script.slice('node '.length).split(' '), {
					stdio: 'inherit',
					env: gitHookScriptEnv(),
					cwd,
				})
			: spawn(resolveNpmCommand(), ['run', script], {
					stdio: 'inherit',
					env: gitHookScriptEnv(),
					cwd,
				})
		child.once('error', (error) => {
			console.error(error.message)
			resolve(1)
		})
		child.once('close', (code) => {
			resolve(code ?? 1)
		})
	})
}

async function readHookStdin() {
	if (process.stdin.isTTY) return null
	const chunks: Array<Buffer> = []
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return Buffer.concat(chunks).toString('utf8')
}

async function main() {
	const hook = process.argv[2]
	if (hook !== 'pre-commit' && hook !== 'pre-push') {
		console.error('git-hook-checks: expected pre-commit or pre-push')
		process.exitCode = 1
		return
	}
	process.exitCode = await runGitHookChecks({
		hook,
		stdin: hook === 'pre-push' ? await readHookStdin() : undefined,
	})
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
