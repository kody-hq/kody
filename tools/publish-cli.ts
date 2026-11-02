import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
	cliBaselineTag,
	cliBaselineVersion,
	cliPackageName,
	cliPathAffectsPublishedPackage,
	planCliRelease,
	type ReleaseCommit,
} from './cli-release-plan.ts'

const repoRoot = resolve(import.meta.dirname, '..')
const packageJsonPath = resolve(repoRoot, 'packages/cli/package.json')
const generatedClientPath = 'packages/cli/src/generated/openapi-routes.ts'
const pureImportMarker = 'packages/cli/src/oauth-browser.ts'

const releaseTagIdentity = {
	GIT_AUTHOR_NAME: 'github-actions[bot]',
	GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
	GIT_COMMITTER_NAME: 'github-actions[bot]',
	GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
}

function git(args: Array<string>, identity = false): string {
	return execFileSync('git', args, {
		cwd: repoRoot,
		encoding: 'utf8',
		env: identity ? { ...process.env, ...releaseTagIdentity } : process.env,
	}).trim()
}

function tagExists(tag: string): boolean {
	try {
		git(['rev-parse', `refs/tags/${tag}`])
		return true
	} catch {
		return false
	}
}

function commitTouches(sha: string, path: string): boolean {
	const diff = git([
		'diff-tree',
		'--no-commit-id',
		'--name-only',
		'-r',
		sha,
		'--',
		path,
	])
	return diff.length > 0
}

function commitTouchesPublishedCli(sha: string): boolean {
	const diff = git([
		'diff-tree',
		'--no-commit-id',
		'--name-only',
		'-r',
		sha,
		'--',
		'packages/cli',
	])
	return diff
		.split('\n')
		.some((path) => path.length > 0 && cliPathAffectsPublishedPackage(path))
}

function generatedClientChanged(from: string): boolean {
	try {
		const diff = git([
			'diff',
			'--name-only',
			from,
			'HEAD',
			'--',
			generatedClientPath,
		])
		return diff.length > 0
	} catch {
		return true
	}
}

function commitsSince(from: string): Array<ReleaseCommit> {
	const raw = git(['log', `${from}..HEAD`, '--format=%H%x1f%s%x1f%b%x1e'])
	if (!raw) return []
	const commits: Array<ReleaseCommit> = []
	for (const record of raw.split('\x1e')) {
		const trimmed = record.trim()
		if (!trimmed) continue
		const [sha, subject, body = ''] = trimmed.split('\x1f')
		if (!sha || subject === undefined) continue
		commits.push({
			subject,
			body,
			touchesCli: commitTouchesPublishedCli(sha),
			touchesClientInputs:
				commitTouches(sha, 'packages/worker/src/open-api') ||
				commitTouches(sha, 'packages/shared') ||
				commitTouches(sha, 'tools/generate-cli-openapi-client.ts'),
		})
	}
	return commits
}

function earliestCliCommit(): string {
	const log = git(['log', '--reverse', '--format=%H', '--', 'packages/cli'])
	const sha = log.split('\n')[0]
	if (!sha) throw new Error('packages/cli is not in this history.')
	return sha
}

function commitHasFile(sha: string, path: string): boolean {
	try {
		git(['cat-file', '-e', `${sha}:${path}`])
		return true
	} catch {
		return false
	}
}

function ensureBaselineTag(): string {
	if (tagExists(cliBaselineTag)) return cliBaselineTag
	const earliest = earliestCliCommit()
	if (commitHasFile(earliest, pureImportMarker)) {
		throw new Error(
			`Refusing to tag ${earliest} as ${cliBaselineTag}: that commit already contains the OpenAPI client. Merge the subtree commit so ${cliBaselineTag} can point at the imported 1.26.3 tree.`,
		)
	}
	git(
		[
			'tag',
			'-a',
			cliBaselineTag,
			earliest,
			'-m',
			`${cliPackageName} ${cliBaselineVersion}`,
		],
		true,
	)
	if (process.env.CI === 'true') {
		git(['push', 'origin', `refs/tags/${cliBaselineTag}`])
	}
	return cliBaselineTag
}

function readLatestPublishedVersion(tag: string): string {
	if (tag === cliBaselineTag) return cliBaselineVersion
	const match = /^cli-v(\d+\.\d+\.\d+)$/.exec(tag)
	if (!match?.[1]) throw new Error(`Unexpected CLI tag "${tag}".`)
	return match[1]
}

function latestCliTag(): string {
	const tags = git(['tag', '--list', 'cli-v*', '--sort=-v:refname'])
	const latest = tags
		.split('\n')
		.find((tag) => /^cli-v\d+\.\d+\.\d+$/.test(tag))
	return latest ?? ensureBaselineTag()
}

const previousTag = latestCliTag()
const previousVersion = readLatestPublishedVersion(previousTag)
const plan = planCliRelease({
	currentVersion: previousVersion,
	generatedClientChanged: generatedClientChanged(previousTag),
	commits: commitsSince(previousTag),
})

if (!plan) {
	console.log(`No publishable @kodycodes/cli change since ${previousTag}.`)
	process.exit(0)
}

console.log(
	`Publishing ${cliPackageName}@${plan.version} (from ${previousTag}).`,
)
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
	version: string
}
const original = JSON.stringify(packageJson, null, '\t') + '\n'
packageJson.version = plan.version
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, '\t')}\n`)

const publish = process.argv.includes('--publish') || process.env.CI === 'true'
try {
	if (publish) {
		execFileSync('npm', ['run', 'build', '-w', cliPackageName], {
			cwd: repoRoot,
			stdio: 'inherit',
		})
		execFileSync(
			'npm',
			['publish', '-w', cliPackageName, '--provenance', '--access', 'public'],
			{ cwd: repoRoot, stdio: 'inherit' },
		)
		const tag = `cli-v${plan.version}`
		git(['tag', '-a', tag, '-m', `${cliPackageName} ${plan.version}`], true)
		git(['push', 'origin', `refs/tags/${tag}`])
	} else {
		console.log('Dry run. Pass --publish or run in CI to npm publish.')
	}
} finally {
	writeFileSync(packageJsonPath, original)
}
