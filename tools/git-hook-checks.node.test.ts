import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	gitHookScriptEnv,
	hookScripts,
	isDocsOnlyHookPath,
	listHookPaths,
	parsePrePushUpdates,
	isSkillsLockHookPath,
	listInstalledNodeModulesDirs,
	planGitHookChecks,
	runGitHookChecks,
	shouldSkipProvenanceCheck,
	shouldSkipTestPushForProvenance,
	withStagedTreeForTypecheck,
	type GitRunner,
} from './git-hook-checks.ts'
import {
	createFileProvenanceStore,
	recordProvenanceCheck,
} from './git-hook-provenance.ts'

const zeroSha = '0'.repeat(40)
const remoteSha = 'a'.repeat(40)
const localSha = 'b'.repeat(40)
const otherSha = 'd'.repeat(40)

function gitResult(
	status: number,
	stdout = '',
	stderr = '',
): ReturnType<GitRunner> {
	return { status, stdout, stderr }
}

function plannedScripts(
	hook: 'pre-commit' | 'pre-push',
	paths: ReadonlyArray<string> | null,
) {
	return hookScripts(planGitHookChecks({ hook, paths }))
}

async function runHook(
	input: Omit<Parameters<typeof runGitHookChecks>[0], 'runScript' | 'log'>,
	exitCodeFor: (script: string) => number = () => 0,
) {
	const scripts: Array<string> = []
	const code = await runGitHookChecks({
		...input,
		runScript: (script) => {
			scripts.push(script)
			return exitCodeFor(script)
		},
		log: () => {},
	})
	return { code, scripts }
}

test('docs-only hook paths skip expensive checks and any code path keeps them', async () => {
	const pathCases: Array<[string, boolean]> = [
		['docs/contributing/security.md', true],
		['docs/contributing/architecture/primitives.yaml', true],
		['./README.md', true],
		['notes.mdx', true],
		['LICENSE', true],
		['docs-site/guide.ts', false],
		['src/readme.md.ts', false],
		['packages/worker/src/app.ts', false],
		['../packages/worker/src/app.ts', false],
		['docs\\feature.ts', false],
	]
	expect(
		pathCases.filter(
			([filePath, want]) => isDocsOnlyHookPath(filePath) !== want,
		),
	).toEqual([])

	const docsPaths = ['docs/contributing/security.md', 'README.md', 'LICENSE']
	const codePaths = [
		'docs/contributing/security.md',
		'packages/worker/src/app.ts',
	]
	expect(
		planGitHookChecks({ hook: 'pre-commit', paths: docsPaths }),
	).toMatchObject({
		runTypecheck: false,
		runMigrationsCheck: false,
		runUnitTests: false,
		summary:
			'pre-commit: skipping install:check, typecheck, and migrations:check (3 docs-only paths)',
	})
	expect(
		planGitHookChecks({ hook: 'pre-push', paths: codePaths }).summary,
	).toBe('pre-push: running knip and test:push (packages/worker/src/app.ts)')
	const planCases: Array<
		['pre-commit' | 'pre-push', Array<string> | null, Array<string>]
	> = [
		['pre-push', docsPaths, []],
		[
			'pre-commit',
			codePaths,
			['install:check', 'typecheck', 'migrations:check'],
		],
		[
			'pre-push',
			['packages/worker/migrations/0067-example.sql'],
			['knip', 'test:push'],
		],
		['pre-commit', [], []],
		['pre-commit', null, ['install:check', 'typecheck', 'migrations:check']],
		[
			'pre-push',
			null,
			['node tools/check-skills-lock.ts', 'knip', 'test:push'],
		],
	]
	expect(
		planCases.map(([hook, paths]) => [
			hook,
			paths,
			plannedScripts(hook, paths),
		]),
	).toEqual(planCases)

	expect(parsePrePushUpdates(null)).toBeNull()
	expect(parsePrePushUpdates('\n')).toBeNull()
	expect(
		parsePrePushUpdates(
			`refs/heads/docs ${localSha} refs/heads/docs not-a-sha\n`,
		),
	).toBeNull()

	expect(
		await runHook({
			hook: 'pre-commit',
			git: () => gitResult(0, 'docs/contributing/security.md\0README.md\0'),
		}),
	).toEqual({ code: 0, scripts: [] })
	expect(
		await runHook(
			{
				hook: 'pre-commit',
				git: () => gitResult(0, 'packages/worker/src/app.ts\0'),
			},
			(script) => (script === 'install:check' ? 2 : 0),
		),
	).toEqual({ code: 2, scripts: ['install:check'] })
	expect(
		await runHook(
			{
				hook: 'pre-commit',
				git: () => gitResult(0, 'packages/worker/src/app.ts\0'),
			},
			(script) => (script === 'typecheck' ? 2 : 0),
		),
	).toEqual({ code: 2, scripts: ['install:check', 'typecheck'] })
	expect(
		await runHook({
			hook: 'pre-push',
			stdin: ' \n',
			git: () => {
				throw new Error('blank pre-push stdin must fail closed before git')
			},
		}),
	).toEqual({
		code: 0,
		scripts: ['node tools/check-skills-lock.ts', 'knip', 'test:push'],
	})

	expect(isSkillsLockHookPath('.agents/skills/ship-pr/SKILL.md')).toBe(true)
	expect(isSkillsLockHookPath('./skills-lock.json')).toBe(true)
	expect(isSkillsLockHookPath('README.md')).toBe(false)
	expect(
		plannedScripts('pre-push', ['.agents/skills/ship-pr/SKILL.md']),
	).toEqual(['node tools/check-skills-lock.ts'])
	expect(
		plannedScripts('pre-commit', ['.agents/skills/ship-pr/SKILL.md']),
	).toEqual([])
	expect(
		planGitHookChecks({
			hook: 'pre-push',
			paths: ['.agents/skills/ship-pr/SKILL.md', 'README.md'],
		}).summary,
	).toBe('pre-push: running skills-lock (.agents/skills/ship-pr/SKILL.md)')
	expect(
		plannedScripts('pre-push', [
			'.agents/skills/ship-pr/SKILL.md',
			'skills-lock.json',
		]),
	).toEqual(['node tools/check-skills-lock.ts'])
	expect(
		plannedScripts('pre-push', [
			'.agents/skills/visual-recap/scripts/primitives-map.mjs',
		]),
	).toEqual(['node tools/check-skills-lock.ts', 'knip', 'test:push'])
	expect(
		plannedScripts('pre-push', [
			'.agents/skills/visual-recap/scripts/primitives-map.mjs',
			'skills-lock.json',
		]),
	).toEqual(['node tools/check-skills-lock.ts', 'knip', 'test:push'])
	expect(
		plannedScripts('pre-push', [
			'.agents/skills/ship-pr/SKILL.md',
			'packages/worker/src/app.ts',
		]),
	).toEqual(['node tools/check-skills-lock.ts', 'knip', 'test:push'])
	expect(
		planGitHookChecks({
			hook: 'pre-push',
			paths: ['skills-lock.json', 'packages/worker/src/app.ts'],
		}).summary,
	).toBe(
		'pre-push: running skills-lock, knip, and test:push (packages/worker/src/app.ts)',
	)
})

test('push path listing diffs the remote tip and fails closed without a new-branch base', () => {
	const calls: Array<ReadonlyArray<string>> = []
	const git: GitRunner = (args) => {
		calls.push(args)
		if (args[0] === 'diff' && args.at(-1) === localSha) {
			return gitResult(0, 'docs/contributing/security.md\0')
		}
		if (args[0] === 'diff' && args.at(-1) === otherSha) {
			return gitResult(0, 'packages/worker/src/app.ts\0README.md\0')
		}
		return gitResult(1)
	}

	expect(
		listHookPaths({
			hook: 'pre-push',
			git,
			stdin: `refs/heads/docs ${localSha} refs/heads/docs ${remoteSha}\n`,
		}),
	).toEqual(['docs/contributing/security.md'])
	expect(calls).toEqual([
		['diff', '--name-only', '--no-renames', '-z', remoteSha, localSha],
	])

	expect(
		listHookPaths({
			hook: 'pre-push',
			git,
			stdin: [
				`refs/heads/docs ${localSha} refs/heads/docs ${remoteSha}`,
				`refs/heads/code ${otherSha} refs/heads/code ${remoteSha}`,
			].join('\n'),
		}),
	).toEqual([
		'README.md',
		'docs/contributing/security.md',
		'packages/worker/src/app.ts',
	])

	const deleteCalls: Array<string> = []
	expect(
		listHookPaths({
			hook: 'pre-push',
			git: (args) => {
				deleteCalls.push(args.join(' '))
				return gitResult(0)
			},
			stdin: `refs/heads/old ${zeroSha} refs/heads/old ${remoteSha}\n`,
		}),
	).toEqual([])
	expect(deleteCalls).toEqual([])

	const missingBaseCalls: Array<string> = []
	expect(
		listHookPaths({
			hook: 'pre-push',
			git: (args) => {
				missingBaseCalls.push(args.join(' '))
				return gitResult(1)
			},
			stdin: `refs/heads/main ${localSha} refs/heads/main ${zeroSha}\n`,
		}),
	).toBeNull()
	expect(missingBaseCalls).toEqual([
		'rev-parse --verify --quiet origin/HEAD^{commit}',
		'rev-parse --verify --quiet origin/main^{commit}',
	])

	expect(
		listHookPaths({
			hook: 'pre-commit',
			git: () => gitResult(1, ''),
		}),
	).toBeNull()
})

test('a real docs follow-up skips unit tests and a source rename still typechecks', async () => {
	const root = await mkdtemp(join(tmpdir(), 'git-hook-checks-'))
	const script = fileURLToPath(new URL('./git-hook-checks.ts', import.meta.url))
	const git = (args: ReadonlyArray<string>) => {
		const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
		if ((result.status ?? 1) !== 0) {
			throw new Error(
				`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
			)
		}
		return result.stdout.trim()
	}
	const runner: GitRunner = (args) => {
		const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
		return {
			status: result.status ?? 1,
			stdout: result.stdout ?? '',
			stderr: result.stderr ?? '',
		}
	}

	try {
		git(['init', '-b', 'main'])
		git(['config', 'user.email', 'hooks@example.com'])
		git(['config', 'user.name', 'Hook Test'])
		const isolatedHooks = join(root, 'no-hooks')
		await mkdir(isolatedHooks)
		git(['config', 'core.hooksPath', isolatedHooks])
		await mkdir(join(root, 'docs', 'contributing'), { recursive: true })
		await mkdir(join(root, 'src'), { recursive: true })
		await writeFile(join(root, 'src', 'app.ts'), 'export const value = 1\n')
		await writeFile(
			join(root, 'docs', 'contributing', 'security.md'),
			'# Security\n',
		)
		git(['add', '.'])
		git(['commit', '-m', 'base'])
		const base = git(['rev-parse', 'HEAD'])

		await writeFile(
			join(root, 'docs', 'contributing', 'security.md'),
			'# Security\n\nDocs only.\n',
		)
		git(['add', 'docs/contributing/security.md'])
		expect(
			plannedScripts(
				'pre-commit',
				listHookPaths({ hook: 'pre-commit', git: runner }),
			),
		).toEqual([])
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				scripts: {
					'install:check': 'exit 2',
					typecheck: 'exit 3',
					'migrations:check': 'exit 4',
					'test:push': 'exit 5',
				},
			}),
		)
		const preCommit = spawnSync(process.execPath, [script, 'pre-commit'], {
			cwd: root,
			encoding: 'utf8',
		})
		expect(preCommit.status).toBe(0)
		expect(preCommit.stdout).toContain(
			'pre-commit: skipping install:check, typecheck, and migrations:check (1 docs-only path)',
		)
		git(['commit', '-m', 'docs'])
		const docsCommit = git(['rev-parse', 'HEAD'])

		const pushStdin = `refs/heads/main ${docsCommit} refs/heads/main ${base}\n`
		expect(
			plannedScripts(
				'pre-push',
				listHookPaths({ hook: 'pre-push', git: runner, stdin: pushStdin }),
			),
		).toEqual([])
		const prePush = spawnSync(process.execPath, [script, 'pre-push'], {
			cwd: root,
			encoding: 'utf8',
			input: pushStdin,
		})
		expect(prePush.status).toBe(0)
		expect(prePush.stdout).toContain(
			'pre-push: skipping knip and test:push (1 docs-only path)',
		)

		git(['checkout', '-b', 'feature', base])
		await writeFile(
			join(root, 'src', 'app.ts'),
			'export const value = 2 // comment\n',
		)
		git(['add', 'src/app.ts'])
		git(['commit', '-m', 'code'])
		const feature = git(['rev-parse', 'HEAD'])
		expect(
			listHookPaths({
				hook: 'pre-push',
				git: runner,
				stdin: `refs/heads/feature ${feature} refs/heads/feature ${zeroSha}\n`,
			}),
		).toEqual(['src/app.ts'])
		expect(plannedScripts('pre-push', ['src/app.ts'])).toEqual([
			'knip',
			'test:push',
		])

		git(['checkout', 'main'])
		git(['mv', 'src/app.ts', 'src/app.md'])
		expect(listHookPaths({ hook: 'pre-commit', git: runner })).toEqual([
			'src/app.md',
			'src/app.ts',
		])
		expect(plannedScripts('pre-commit', ['src/app.md', 'src/app.ts'])).toEqual([
			'install:check',
			'typecheck',
			'migrations:check',
		])
		const renamedCommit = spawnSync(process.execPath, [script, 'pre-commit'], {
			cwd: root,
			encoding: 'utf8',
		})
		expect(renamedCommit.status).not.toBe(0)
		expect(renamedCommit.stdout).toContain(
			'pre-commit: running install:check, typecheck, and migrations:check (src/app.ts)',
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('pre-push skips knip and test:push only when each check is already green', async () => {
	const root = await mkdtemp(join(tmpdir(), 'hook-skip-'))
	try {
		const treeSha = 'e'.repeat(40)
		const store = createFileProvenanceStore(join(root, 'provenance.json'))
		recordProvenanceCheck(store, {
			check: 'test:push',
			treeSha,
			source: 'validate',
			at: '2026-10-14T00:00:00.000Z',
		})
		const git: GitRunner = (args) => {
			if (args[0] === 'diff') {
				return gitResult(0, 'packages/worker/src/app.ts\0')
			}
			if (args[0] === 'rev-parse' && args.at(-1) === `${localSha}^{tree}`) {
				return gitResult(0, `${treeSha}\n`)
			}
			if (args[0] === 'status') {
				return gitResult(0, '')
			}
			if (args[0] === 'stash' && args[1] === 'create') {
				return gitResult(0, '')
			}
			if (args[0] === 'rev-parse' && args.at(-1) === 'HEAD^{tree}') {
				return gitResult(0, `${treeSha}\n`)
			}
			return gitResult(1)
		}
		expect(
			shouldSkipTestPushForProvenance({
				git,
				stdin: `refs/heads/feature ${localSha} refs/heads/feature ${remoteSha}\n`,
				store,
			}),
		).toMatchObject({ skip: true, treeSha })
		expect(
			shouldSkipProvenanceCheck({
				git,
				stdin: `refs/heads/feature ${localSha} refs/heads/feature ${remoteSha}\n`,
				store,
				check: 'knip',
			}).skip,
		).toBe(false)

		// test:push-only provenance must still run knip.
		const logsPartial: Array<string> = []
		const scriptsPartial: Array<string> = []
		expect(
			await runGitHookChecks({
				hook: 'pre-push',
				stdin: `refs/heads/feature ${localSha} refs/heads/feature ${remoteSha}\n`,
				git,
				provenance: store,
				runScript: (script) => {
					scriptsPartial.push(script)
					return 0
				},
				log: (message) => logsPartial.push(message),
				progressIntervalMs: 60_000,
			}),
		).toBe(0)
		expect(scriptsPartial).toEqual(['knip'])
		expect(
			logsPartial.some((line) => line.includes('skipping test:push')),
		).toBe(true)
		expect(logsPartial.some((line) => line.includes('skipping knip'))).toBe(
			false,
		)
		expect(
			shouldSkipProvenanceCheck({
				git,
				stdin: `refs/heads/feature ${localSha} refs/heads/feature ${remoteSha}\n`,
				store,
				check: 'knip',
			}).skip,
		).toBe(true)

		recordProvenanceCheck(store, {
			check: 'knip',
			treeSha,
			source: 'validate',
			at: '2026-10-14T00:00:00.000Z',
		})
		const logs: Array<string> = []
		const scripts: Array<string> = []
		const code = await runGitHookChecks({
			hook: 'pre-push',
			stdin: `refs/heads/feature ${localSha} refs/heads/feature ${remoteSha}\n`,
			git,
			provenance: store,
			runScript: (script) => {
				scripts.push(script)
				return 0
			},
			log: (message) => logs.push(message),
			progressIntervalMs: 60_000,
		})
		expect(code).toBe(0)
		expect(scripts).toEqual([])
		expect(logs.some((line) => line.includes('skipping knip'))).toBe(true)
		expect(logs.some((line) => line.includes('skipping test:push'))).toBe(true)
		expect(logs.some((line) => line.includes('already green'))).toBe(true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('pre-push fails knip with a clear fix message before test:push', async () => {
	const logs: Array<string> = []
	const scripts: Array<string> = []
	const code = await runGitHookChecks({
		hook: 'pre-push',
		stdin: `refs/heads/feature ${localSha} refs/heads/feature ${remoteSha}\n`,
		git: (args) => {
			if (args[0] === 'diff') {
				return gitResult(0, 'packages/worker/src/app.ts\0')
			}
			return gitResult(1)
		},
		runScript: (script) => {
			scripts.push(script)
			return script === 'knip' ? 1 : 0
		},
		log: (message) => logs.push(message),
		progressIntervalMs: 60_000,
	})
	expect(code).toBe(1)
	expect(scripts).toEqual(['knip'])
	expect(
		logs.some((line) =>
			line.includes(
				'Run `npm run knip` and fix unused files, exports, or types',
			),
		),
	).toBe(true)
})

test('pre-push records provenance after a successful test:push and logs progress', async () => {
	const treeSha = 'f'.repeat(40)
	const root = await mkdtemp(join(tmpdir(), 'hook-progress-'))
	try {
		const store = createFileProvenanceStore(join(root, 'provenance.json'))
		const git: GitRunner = (args) => {
			if (args[0] === 'diff') {
				return gitResult(0, 'packages/worker/src/app.ts\0')
			}
			if (args[0] === 'status') {
				return gitResult(0, '')
			}
			if (args[0] === 'stash' && args[1] === 'create') {
				return gitResult(0, '')
			}
			if (args[0] === 'rev-parse' && args.at(-1) === 'HEAD^{tree}') {
				return gitResult(0, `${treeSha}\n`)
			}
			if (args[0] === 'rev-parse' && args.at(-1) === `${localSha}^{tree}`) {
				return gitResult(0, `${treeSha}\n`)
			}
			return gitResult(1)
		}
		const logs: Array<string> = []
		let clock = 0
		const code = await runGitHookChecks({
			hook: 'pre-push',
			stdin: `refs/heads/feature ${localSha} refs/heads/feature ${remoteSha}\n`,
			git,
			provenance: store,
			now: () => {
				clock += 1
				return clock * 1_000
			},
			progressIntervalMs: 60_000,
			runScript: async () => 0,
			log: (message) => logs.push(message),
		})
		expect(code).toBe(0)
		expect(logs.some((line) => line.includes('starting npm run knip'))).toBe(
			true,
		)
		expect(logs.some((line) => line.includes('finished npm run knip'))).toBe(
			true,
		)
		expect(
			logs.some((line) => line.includes('starting npm run test:push')),
		).toBe(true)
		expect(
			logs.some((line) => line.includes('finished npm run test:push')),
		).toBe(true)
		expect(
			shouldSkipTestPushForProvenance({
				git,
				stdin: `refs/heads/feature ${localSha} refs/heads/feature ${remoteSha}\n`,
				store,
			}).skip,
		).toBe(true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('withStagedTreeForTypecheck runs typecheck in a detached index worktree', async () => {
	const root = await mkdtemp(join(tmpdir(), 'hook-staged-'))
	const treeSha = '1'.repeat(40)
	const commitSha = '2'.repeat(40)
	try {
		const calls: Array<string> = []
		const git: GitRunner = (args) => {
			calls.push(args.join(' '))
			if (args[0] === 'status') {
				return gitResult(0, 'MM packages/worker/src/app.ts\n')
			}
			if (args[0] === 'write-tree') {
				return gitResult(0, `${treeSha}\n`)
			}
			if (args.includes('commit-tree')) {
				return gitResult(0, `${commitSha}\n`)
			}
			if (args[0] === 'worktree' && args[1] === 'add') {
				return gitResult(0, '')
			}
			if (args[0] === 'worktree' && args[1] === 'remove') {
				return gitResult(0, '')
			}
			return gitResult(1)
		}
		const logs: Array<string> = []
		let seenCwd: string | undefined
		const value = await withStagedTreeForTypecheck({
			git,
			repoRoot: root,
			log: (message) => logs.push(message),
			run: (cwd) => {
				seenCwd = cwd
				return 7
			},
		})
		expect(value).toBe(7)
		expect(calls[0]).toBe('status --porcelain -uall')
		expect(calls).toContain('write-tree')
		expect(
			calls.some(
				(line) => line.includes('commit-tree') && line.includes('user.email='),
			),
		).toBe(true)
		expect(calls.some((line) => line.startsWith('worktree add --detach'))).toBe(
			true,
		)
		expect(
			calls.some((line) => line.startsWith('worktree remove --force')),
		).toBe(true)
		expect(seenCwd).toContain('pre-commit-typecheck-')
		expect(logs[0]).toContain('typechecking staged tree')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('withStagedTreeForTypecheck clears GIT_INDEX_FILE for worktree ops', async () => {
	const root = await mkdtemp(join(tmpdir(), 'hook-staged-index-'))
	const treeSha = 'a'.repeat(40)
	const commitSha = 'b'.repeat(40)
	const previous = process.env.GIT_INDEX_FILE
	process.env.GIT_INDEX_FILE = join(root, 'alt-index')
	try {
		const seen: Array<string | undefined> = []
		const git: GitRunner = (args) => {
			if (args[0] === 'worktree') {
				seen.push(process.env.GIT_INDEX_FILE)
			}
			if (args[0] === 'status') {
				return gitResult(0, 'MM packages/worker/src/app.ts\n')
			}
			if (args[0] === 'write-tree') {
				expect(process.env.GIT_INDEX_FILE).toBe(join(root, 'alt-index'))
				return gitResult(0, `${treeSha}\n`)
			}
			if (args.includes('commit-tree')) {
				return gitResult(0, `${commitSha}\n`)
			}
			if (args[0] === 'worktree' && args[1] === 'add') {
				return gitResult(0, '')
			}
			if (args[0] === 'worktree' && args[1] === 'remove') {
				return gitResult(0, '')
			}
			return gitResult(1)
		}
		await withStagedTreeForTypecheck({
			git,
			repoRoot: root,
			run: () => 0,
		})
		expect(seen.length).toBeGreaterThanOrEqual(2)
		expect(seen.every((value) => value === undefined)).toBe(true)
		expect(process.env.GIT_INDEX_FILE).toBe(join(root, 'alt-index'))
	} finally {
		if (previous === undefined) {
			delete process.env.GIT_INDEX_FILE
		} else {
			process.env.GIT_INDEX_FILE = previous
		}
		await rm(root, { recursive: true, force: true })
	}
})

test('withStagedTreeForTypecheck unlinks node_modules before worktree remove', async () => {
	const root = await mkdtemp(join(tmpdir(), 'hook-staged-nm-'))
	const repoModules = join(root, 'node_modules')
	const treeSha = 'c'.repeat(40)
	const commitSha = 'd'.repeat(40)
	await mkdir(repoModules, { recursive: true })
	try {
		let worktreePath = ''
		const git: GitRunner = (args) => {
			if (args[0] === 'status') {
				return gitResult(0, 'MM packages/worker/src/app.ts\n')
			}
			if (args[0] === 'write-tree') {
				return gitResult(0, `${treeSha}\n`)
			}
			if (args.includes('commit-tree')) {
				return gitResult(0, `${commitSha}\n`)
			}
			if (args[0] === 'worktree' && args[1] === 'add') {
				worktreePath = args[3] ?? ''
				mkdirSync(worktreePath, { recursive: true })
				return gitResult(0, '')
			}
			if (args[0] === 'worktree' && args[1] === 'remove') {
				expect(existsSync(join(worktreePath, 'node_modules'))).toBe(false)
				expect(existsSync(repoModules)).toBe(true)
				return gitResult(0, '')
			}
			return gitResult(1)
		}
		await withStagedTreeForTypecheck({
			git,
			repoRoot: root,
			run: (cwd) => {
				expect(cwd).toBeTruthy()
				expect(existsSync(join(cwd!, 'node_modules'))).toBe(true)
				return 0
			},
		})
		expect(worktreePath.length).toBeGreaterThan(0)
		expect(existsSync(repoModules)).toBe(true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('withStagedTreeForTypecheck links nested workspace node_modules', async () => {
	const root = await mkdtemp(join(tmpdir(), 'hook-staged-nested-nm-'))
	const workspaceModules = join(root, 'packages', 'worker', 'node_modules')
	const treeSha = 'e'.repeat(40)
	const commitSha = 'f'.repeat(40)
	await mkdir(join(root, 'node_modules'), { recursive: true })
	await mkdir(join(workspaceModules, 'satori'), { recursive: true })
	await mkdir(join(root, 'packages', 'mock-servers', 'github'), {
		recursive: true,
	})
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({
			workspaces: ['packages/worker', 'packages/mock-servers/*'],
		}),
	)
	try {
		expect(listInstalledNodeModulesDirs(root)).toEqual([
			'node_modules',
			join('packages', 'worker', 'node_modules'),
		])
		let worktreePath = ''
		const git: GitRunner = (args) => {
			if (args[0] === 'status') {
				return gitResult(0, 'MM packages/worker/src/app.ts\n')
			}
			if (args[0] === 'write-tree') {
				return gitResult(0, `${treeSha}\n`)
			}
			if (args.includes('commit-tree')) {
				return gitResult(0, `${commitSha}\n`)
			}
			if (args[0] === 'worktree' && args[1] === 'add') {
				worktreePath = args[3] ?? ''
				mkdirSync(join(worktreePath, 'packages', 'worker'), {
					recursive: true,
				})
				return gitResult(0, '')
			}
			if (args[0] === 'worktree' && args[1] === 'remove') {
				expect(
					existsSync(join(worktreePath, 'packages', 'worker', 'node_modules')),
				).toBe(false)
				return gitResult(0, '')
			}
			return gitResult(1)
		}
		await withStagedTreeForTypecheck({
			git,
			repoRoot: root,
			run: (cwd) => {
				expect(
					existsSync(
						join(cwd!, 'packages', 'worker', 'node_modules', 'satori'),
					),
				).toBe(true)
				return 0
			},
		})
		expect(existsSync(join(workspaceModules, 'satori'))).toBe(true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('withStagedTreeForTypecheck fails closed when worktree add fails', async () => {
	const root = await mkdtemp(join(tmpdir(), 'hook-staged-fail-'))
	const treeSha = '3'.repeat(40)
	try {
		const git: GitRunner = (args) => {
			if (args[0] === 'status') {
				return gitResult(0, 'MM packages/worker/src/app.ts\n')
			}
			if (args[0] === 'write-tree') {
				return gitResult(0, `${treeSha}\n`)
			}
			if (args.includes('commit-tree')) {
				return gitResult(0, `${'4'.repeat(40)}\n`)
			}
			if (args[0] === 'worktree' && args[1] === 'add') {
				return gitResult(1, '', 'worktree add failed')
			}
			return gitResult(1)
		}
		const logs: Array<string> = []
		const value = await withStagedTreeForTypecheck({
			git,
			repoRoot: root,
			log: (message) => logs.push(message),
			run: () => 0,
		})
		expect(value).toBe(1)
		expect(
			logs.some(
				(line) =>
					line.includes('worktree add failed') ||
					line.includes('refusing to typecheck a dirty worktree'),
			),
		).toBe(true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('withStagedTreeForTypecheck fails closed when write-tree or commit-tree fails', async () => {
	const root = await mkdtemp(join(tmpdir(), 'hook-staged-write-fail-'))
	try {
		const writeFail: GitRunner = (args) => {
			if (args[0] === 'status') {
				return gitResult(0, 'MM packages/worker/src/app.ts\n')
			}
			if (args[0] === 'write-tree') {
				return gitResult(1, '', 'write-tree failed')
			}
			return gitResult(1)
		}
		const logs: Array<string> = []
		expect(
			await withStagedTreeForTypecheck({
				git: writeFail,
				repoRoot: root,
				log: (message) => logs.push(message),
				run: () => 0,
			}),
		).toBe(1)
		expect(logs.some((line) => line.includes('write-tree failed'))).toBe(true)

		const commitFail: GitRunner = (args) => {
			if (args[0] === 'status') {
				return gitResult(0, 'MM packages/worker/src/app.ts\n')
			}
			if (args[0] === 'write-tree') {
				return gitResult(0, `${'5'.repeat(40)}\n`)
			}
			if (args.includes('commit-tree')) {
				return gitResult(1, '', 'Author identity unknown')
			}
			return gitResult(1)
		}
		const commitLogs: Array<string> = []
		expect(
			await withStagedTreeForTypecheck({
				git: commitFail,
				repoRoot: root,
				log: (message) => commitLogs.push(message),
				run: () => 0,
			}),
		).toBe(1)
		expect(commitLogs.some((line) => line.includes('commit-tree failed'))).toBe(
			true,
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('hook scripts can create foreign repositories without inherited worktree state', async () => {
	const root = await mkdtemp(join(tmpdir(), 'hook-env-'))
	try {
		const env = gitHookScriptEnv({
			...process.env,
			GIT_DIR: join(root, 'wrong.git'),
			GIT_WORK_TREE: join(root, 'wrong-worktree'),
			GIT_INDEX_FILE: join(root, 'wrong-index'),
			KODY_HOOK_TEST: 'preserved',
		})
		expect(env.KODY_HOOK_TEST).toBe('preserved')
		const target = join(root, 'fixture')
		const init = spawnSync('git', ['init', target], { env, encoding: 'utf8' })
		expect({ status: init.status, error: init.error }).toEqual({
			status: 0,
			error: undefined,
		})
		const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
			cwd: target,
			env,
			encoding: 'utf8',
		})
		expect({ status: top.status, error: top.error }).toEqual({
			status: 0,
			error: undefined,
		})
		expect(top.stdout.trim()).toBe(await realpath(target))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
