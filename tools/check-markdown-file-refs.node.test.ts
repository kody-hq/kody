import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	checkMarkdownFileRefs,
	collectMarkdownFileReferences,
	evaluateMarkdownFileReferences,
	isIgnoredMarkdownFileReference,
	type MarkdownFileRefLookup,
} from './check-markdown-file-refs.ts'

const jobsRepo = 'packages/worker/src/jobs/repo.ts'
const sharedJobsRepo = 'packages/shared/src/jobs/repo.ts'
const workersRegistryTest =
	'packages/worker/src/mcp/capabilities/build-capability-registry.workers.test.ts'
const nodeRegistryTest =
	'packages/worker/src/mcp/capabilities/build-capability-registry.node.test.ts'
const generatedWrangler = 'packages/worker/wrangler-production.generated.json'

function issuesIn(input: {
	relativePath?: string
	content: string
	files?: ReadonlyArray<string>
	directories?: ReadonlyArray<string>
}) {
	const files = new Set(input.files ?? [])
	const directories = new Set(input.directories ?? [])
	const lookup: MarkdownFileRefLookup = {
		fileExists: (repoPath) => files.has(repoPath),
		directoryExists: (repoPath) => directories.has(repoPath),
	}
	return evaluateMarkdownFileReferences({
		references: collectMarkdownFileReferences({
			relativePath: input.relativePath ?? 'docs/contributing/example.md',
			content: input.content,
		}),
		lookup,
	})
}

test('stale repo paths fail when the parent directory exists', () => {
	const issues = issuesIn({
		content: [
			`Due jobs are listed in \`${jobsRepo}\`.`,
			`Registry invariants live in \`${workersRegistryTest}\`.`,
			`The jobs data module is \`${sharedJobsRepo}\`.`,
			`The node test is \`${nodeRegistryTest}\`.`,
		].join('\n'),
		files: [sharedJobsRepo, nodeRegistryTest],
		directories: [
			'packages/worker/src/jobs',
			'packages/worker/src/mcp/capabilities',
			'packages/shared/src/jobs',
		],
	})
	expect(issues.map((issue) => issue.reference)).toEqual([
		jobsRepo,
		workersRegistryTest,
	])
	expect(issues[0]?.message).toContain(jobsRepo)
})

test('generated wrangler files, local env files, placeholders, and absence claims are ignored', () => {
	expect(isIgnoredMarkdownFileReference(generatedWrangler)).toBe(true)
	expect(
		isIgnoredMarkdownFileReference('.wrangler/state/e2e/cloudflare-mock.json'),
	).toBe(true)
	expect(isIgnoredMarkdownFileReference('packages/worker/.env')).toBe(true)
	expect(isIgnoredMarkdownFileReference('packages/worker/.env.example')).toBe(
		false,
	)

	const issues = issuesIn({
		content: [
			`CI writes \`${generatedWrangler}\`.`,
			'Copy `packages/worker/.env.example` to `packages/worker/.env`.',
			'Add `packages/worker/src/package-codemods/codemods/NNNN-kebab-name.ts`.',
			'This repository does not define labels in-tree (no `.github/labels.yml`).',
			'For example `packages/mock-servers/acme/src/worker.ts`.',
			'See [checks](./checks.md).',
			'Add the plugin with [this link](grokbot://app/v1/plugin/add?id=1).',
			'README `![alt](./docs/poster.png)` images render from the package.',
		].join('\n'),
		files: ['docs/contributing/checks.md'],
		directories: [
			'packages/worker',
			'packages/worker/src/package-codemods/codemods',
			'.github',
			'docs/contributing',
		],
	})
	expect(issues.map((issue) => issue.reference)).toEqual([
		'packages/worker/.env.example',
	])
})

test('bare relative links resolve against the markdown file and fences are examples', () => {
	const bare = issuesIn({
		relativePath: 'docs/contributing/guide.md',
		content: 'See [details](missing.md) and [setup](setup/checks.md).',
		files: [],
		directories: ['docs/contributing', 'docs/contributing/setup'],
	})
	expect(bare.map((issue) => issue.reference).sort()).toEqual([
		'docs/contributing/missing.md',
		'docs/contributing/setup/checks.md',
	])

	const fenced = issuesIn({
		content: ['```sh', `echo \`${jobsRepo}\``, '```', ''].join('\n'),
		files: [],
		directories: ['packages/worker/src/jobs'],
	})
	expect(fenced).toEqual([])

	const nestedFence = issuesIn({
		content: [
			'````md',
			'```sh',
			`echo \`${jobsRepo}\``,
			'```',
			'````',
			'',
		].join('\n'),
		files: [],
		directories: ['packages/worker/src/jobs'],
	})
	expect(nestedFence).toEqual([])

	expect(
		issuesIn({
			content: 'See [home](/docs/missing.md) and [cdn](//cdn.example/a.png).',
			files: [],
			directories: ['docs'],
		}),
	).toEqual([])
})

test('a relative link to a missing file fails and an existing one passes', () => {
	const missing = issuesIn({
		relativePath: 'docs/contributing/index.md',
		content: 'See [checks](./setup/checks.md).',
		files: [],
		directories: ['docs/contributing/setup'],
	})
	expect(missing.map((issue) => issue.reference)).toEqual([
		'docs/contributing/setup/checks.md',
	])

	const present = issuesIn({
		relativePath: 'docs/contributing/index.md',
		content: 'See [checks](./setup/checks.md).',
		files: ['docs/contributing/setup/checks.md'],
		directories: ['docs/contributing/setup'],
	})
	expect(present).toEqual([])
})

test('checkMarkdownFileRefs reads the tree and fails on a missing citation', async () => {
	const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'markdown-file-refs-'))
	try {
		const jobsDir = path.join(repoRoot, 'packages', 'worker', 'src', 'jobs')
		await mkdir(jobsDir, { recursive: true })
		await mkdir(path.join(repoRoot, 'docs'), { recursive: true })
		await writeFile(
			path.join(jobsDir, 'jobs-data.ts'),
			'export const jobsData = true\n',
		)
		await writeFile(
			path.join(repoRoot, 'docs', 'note.md'),
			[
				`See \`${jobsRepo}\`.`,
				`Generated \`${generatedWrangler}\` is not committed.`,
				'',
			].join('\n'),
		)
		const failed = await checkMarkdownFileRefs(repoRoot)
		expect(failed.ok).toBe(false)
		expect(failed.issues.map((issue) => issue.reference)).toEqual([jobsRepo])

		await writeFile(path.join(jobsDir, 'repo.ts'), 'export {}\n')
		expect(await checkMarkdownFileRefs(repoRoot)).toEqual({
			ok: true,
			issues: [],
		})
	} finally {
		await rm(repoRoot, { recursive: true, force: true })
	}
})

test('committed markdown file references exist', async () => {
	expect(await checkMarkdownFileRefs(process.cwd())).toEqual({
		ok: true,
		issues: [],
	})
})
