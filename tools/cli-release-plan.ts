export const cliPackageName = '@kodycodes/cli'
export const cliBaselineVersion = '1.26.3'
export const cliBaselineTag = `cli-v${cliBaselineVersion}`

const releasableTypes = new Set(['feat', 'fix', 'perf', 'revert'])

type ReleaseBump = 'major' | 'minor' | 'patch' | 'none'

export type ReleaseCommit = {
	subject: string
	body: string
	touchesCli: boolean
	touchesClientInputs: boolean
}

const conventional =
	/^(?<type>feat|fix|perf|revert|chore|docs|ci|test|build|style|refactor)(?:\([^)]+\))?(?<breaking>!)?:/

function bumpForCommit(commit: ReleaseCommit): ReleaseBump {
	const match = conventional.exec(commit.subject.trim())
	if (!match?.groups?.type) {
		// Squash-merge subjects often copy the PR title and omit feat/fix
		// (#4363). Conventional types still choose the bump; a prose subject
		// that touches packages/cli still publishes a patch.
		return commit.touchesCli ? 'patch' : 'none'
	}
	const breaking =
		match.groups.breaking === '!' ||
		/^BREAKING CHANGE:/m.test(commit.body) ||
		/\nBREAKING CHANGE:/m.test(`\n${commit.body}`)
	if (breaking && releasableTypes.has(match.groups.type)) return 'major'
	if (
		breaking &&
		(match.groups.type === 'feat' || match.groups.type === 'fix')
	) {
		return 'major'
	}
	if (breaking) return 'major'
	// docs / chore / ci / test / build / style / refactor: patch when they
	// touch packages/cli so help and other CLI-facing source still publishes
	// (#3975). feat stays minor; fix / perf / revert stay patch via releasableTypes.
	if (!releasableTypes.has(match.groups.type)) {
		return commit.touchesCli ? 'patch' : 'none'
	}
	if (match.groups.type === 'feat') return 'minor'
	return 'patch'
}

function rank(bump: ReleaseBump): number {
	switch (bump) {
		case 'none':
			return 0
		case 'patch':
			return 1
		case 'minor':
			return 2
		case 'major':
			return 3
		default: {
			const never: never = bump
			return never
		}
	}
}

function highestBump(bumps: Array<ReleaseBump>): ReleaseBump {
	return bumps.reduce<ReleaseBump>(
		(current, next) => (rank(next) > rank(current) ? next : current),
		'none',
	)
}

function nextVersion(current: string, bump: ReleaseBump): string | null {
	if (bump === 'none') return null
	const parts = current.split('.').map((part) => Number(part))
	if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
		throw new Error(`Invalid CLI version "${current}".`)
	}
	const [major, minor, patch] = parts as [number, number, number]
	switch (bump) {
		case 'major':
			return `${major + 1}.0.0`
		case 'minor':
			return `${major}.${minor + 1}.0`
		case 'patch':
			return `${major}.${minor}.${patch + 1}`
		default: {
			const never: never = bump
			return never
		}
	}
}

/**
 * Publish when a commit touches the CLI (`feat` → minor; `fix` / `perf` /
 * `revert` → patch; `docs` / `chore` / `ci` / `test` / `build` / `style` /
 * `refactor` → patch per #3975; a subject without a conventional prefix →
 * patch per #4363), or when the generated route table changed (spec/shared
 * input) even if those commits are not `feat`/`fix`. Commits that do not
 * touch the CLI (and do not change the generated client) do not publish.
 */
export function planCliRelease(input: {
	currentVersion: string
	generatedClientChanged: boolean
	commits: Array<ReleaseCommit>
}): { version: string } | null {
	const bumps: Array<ReleaseBump> = []
	for (const commit of input.commits) {
		const bump = bumpForCommit(commit)
		if (bump === 'none') continue
		if (commit.touchesCli) bumps.push(bump)
		else if (input.generatedClientChanged && commit.touchesClientInputs) {
			bumps.push(bump)
		}
	}
	let bump = highestBump(bumps)
	if (
		bump === 'none' &&
		input.generatedClientChanged &&
		input.commits.some(
			(commit) => commit.touchesClientInputs || commit.touchesCli,
		)
	) {
		bump = 'patch'
	}
	const version = nextVersion(input.currentVersion, bump)
	return version ? { version } : null
}
