import { expect, test } from 'vitest'
import {
	collectChangedForkFiles,
	rewriteForkedPackageSelfReferences,
	rewritePackageManifestForFork,
	scanCrossScopeReferences,
	scanLeftoverOriginReferences,
} from './fork-scan.ts'

const sampleManifest = `{
	"name": "@owner/discord-gateway",
	"license": "MIT",
	"exports": {
		".": "./src/index.ts"
	},
	"kody": {
		"id": "discord-gateway",
		"description": "Discord helpers",
		"tags": ["discord"],
		"dependencies": [
			"@owner/shared-utils",
			"@forker/local-lib"
		]
	}
}
`

function janeManifest(dependencies: unknown) {
	return JSON.stringify({
		name: '@jane/pkg',
		kody: { id: 'pkg', description: 'Pkg', dependencies },
		exports: { '.': './src/index.ts' },
	})
}

function scanAsJane(files: Record<string, string>) {
	return scanCrossScopeReferences({
		files,
		expectedPackageScope: 'jane',
	})
}

test('rewritePackageManifestForFork rewrites scope and drops authored kody.id', () => {
	const { content, targetName } = rewritePackageManifestForFork({
		manifestContent: sampleManifest,
		expectedPackageScope: 'jane',
		targetKodyId: 'my-discord-gateway',
	})
	expect(targetName).toBe('@jane/my-discord-gateway')
	const rewritten = JSON.parse(content) as {
		name: string
		license: string
		private: boolean
		exports: Record<string, string>
		kody: Record<string, unknown>
	}
	expect(rewritten).toMatchObject({
		name: '@jane/my-discord-gateway',
		license: 'MIT',
		private: true,
		exports: { '.': './src/index.ts' },
		kody: {
			tags: ['discord'],
			dependencies: ['@owner/shared-utils', '@forker/local-lib'],
		},
	})
	expect(rewritten.kody).not.toHaveProperty('id')

	const override = rewritePackageManifestForFork({
		manifestContent: sampleManifest,
		expectedPackageScope: '@jane',
		targetKodyId: 'custom-id',
	})
	const overridden = JSON.parse(override.content) as {
		name: string
		kody: Record<string, unknown>
	}
	expect(overridden.name).toBe('@jane/custom-id')
	expect(overridden.kody).not.toHaveProperty('id')
})

test('scanCrossScopeReferences finds foreign scopes and ignores same-scope references', () => {
	expect(
		scanAsJane({
			'package.json': sampleManifest,
			'src/index.ts': `import { helper } from 'kody:@owner/shared-utils/helper'
import { local } from 'kody:@jane/local-lib/local'
const sameScope = 'kody:@jane/pkg'
`,
			'src/util.ts': `export const value = "kody:@other-scope/dep/file.ts"
import 'kody:@owner/a/x'
import 'kody:@owner/a/y'`,
		}),
	).toEqual([
		{ file: 'package.json', specifier: '@forker/local-lib' },
		{ file: 'package.json', specifier: '@owner/shared-utils' },
		{ file: 'src/index.ts', specifier: 'kody:@owner/' },
		{ file: 'src/util.ts', specifier: 'kody:@other-scope/' },
		{ file: 'src/util.ts', specifier: 'kody:@owner/' },
	])

	expect(
		scanAsJane({
			'package.json': janeManifest(['@jane/local-lib']),
			'src/index.ts': `import { x } from 'kody:@jane/local-lib/x'`,
		}),
	).toEqual([])

	expect(
		scanAsJane({
			'package.json': janeManifest({
				'@owner/shared-utils': '*',
				'@jane/local-lib': '*',
			}),
		}),
	).toEqual([{ file: 'package.json', specifier: '@owner/shared-utils' }])
})

test('scanCrossScopeReferences treats every other org scope as foreign', () => {
	const files = {
		'package.json': janeManifest(['@kody/github', '@owner/shared-utils']),
		'src/index.ts': `import gh from 'kody:@kody/github/issues'
import util from 'kody:@owner/util/helper'`,
	}
	expect(scanAsJane(files)).toEqual([
		{ file: 'package.json', specifier: '@kody/github' },
		{ file: 'package.json', specifier: '@owner/shared-utils' },
		{ file: 'src/index.ts', specifier: 'kody:@kody/' },
		{ file: 'src/index.ts', specifier: 'kody:@owner/' },
	])
})

test('rewriteForkedPackageSelfReferences rewrites only the forked package name', () => {
	const files = rewriteForkedPackageSelfReferences({
		files: {
			'package.json':
				'{"dependencies":{"@kody/github":"*","@kody/shared":"*"}}',
			'index.ts': `import gh from 'kody:@kody/github/issues'
import shared from 'kody:@kody/shared/util'
`,
		},
		originPackageName: '@kody/github',
		nextPackageName: '@alice/github',
	})
	expect(files['index.ts']).toContain('kody:@alice/github/issues')
	expect(files['index.ts']).toContain('kody:@kody/shared/util')
	expect(files['package.json']).toContain('"@alice/github"')
	expect(files['package.json']).toContain('"@kody/shared"')

	const templateLiteral = rewriteForkedPackageSelfReferences({
		files: {
			'job.ts': 'await packages.invoke(`kody:@kody/github/issues`)\n',
		},
		originPackageName: '@kody/github',
		nextPackageName: '@alice/github',
	})
	expect(templateLiteral['job.ts']).toContain('kody:@alice/github/issues')
})

test('collectChangedForkFiles returns only rewritten paths', () => {
	expect(
		collectChangedForkFiles({
			originFiles: {
				'package.json': '{"name":"@owner/demo"}',
				'src/index.ts': 'export const n = "@owner/demo"\n',
				'poster.png': 'binary-bytes',
			},
			rewrittenFiles: {
				'package.json': '{"name":"@jane/demo"}',
				'src/index.ts': 'export const n = "@jane/demo"\n',
				'poster.png': 'binary-bytes',
			},
		}),
	).toEqual({
		'package.json': '{"name":"@jane/demo"}',
		'src/index.ts': 'export const n = "@jane/demo"\n',
	})
})

const githubManifest = `${JSON.stringify(
	{
		name: '@kody/github',
		exports: { '.': './src/index.ts' },
		kody: {
			id: 'github',
			description: 'GitHub events',
			emits: {
				'@kody/github.issue.opened': { description: 'Issue opened' },
				'@kody/github.pr.merged': { description: 'PR merged' },
				'@kody/ci.completed': { description: 'Not named after the package' },
			},
			subscriptions: {
				'@kody/github.issue.opened': { handler: './src/on-issue.ts' },
				'@kody/discord.message.created': { handler: './src/on-discord.ts' },
			},
		},
	},
	null,
	'\t',
)}\n`

test('rewritePackageManifestForFork renames the package own kody.emits topics to the fork scope and leaf', () => {
	const rewritten = rewritePackageManifestForFork({
		manifestContent: githubManifest,
		expectedPackageScope: 'tino-espinoza',
		targetKodyId: 'my-github',
	})
	expect(rewritten.topicRenames).toEqual({
		'@kody/github.issue.opened': '@tino-espinoza/my-github.issue.opened',
		'@kody/github.pr.merged': '@tino-espinoza/my-github.pr.merged',
		'@kody/ci.completed': '@tino-espinoza/ci.completed',
		'@kody/github.*': '@tino-espinoza/my-github.*',
	})
	const kody = (
		JSON.parse(rewritten.content) as { kody: Record<string, object> }
	).kody
	expect(Object.keys(kody['emits']!)).toEqual([
		'@tino-espinoza/my-github.issue.opened',
		'@tino-espinoza/my-github.pr.merged',
		'@tino-espinoza/ci.completed',
	])
	// Own-topic subscriptions follow; other packages' topics stay put.
	expect(Object.keys(kody['subscriptions']!)).toEqual([
		'@tino-espinoza/my-github.issue.opened',
		'@kody/discord.message.created',
	])
})

test('rewritePackageManifestForFork keeps topics already in the fork namespace', () => {
	const rewritten = rewritePackageManifestForFork({
		manifestContent: githubManifest.replaceAll('@kody/', '@jane/'),
		expectedPackageScope: 'jane',
		targetKodyId: 'github',
	})
	expect(rewritten.topicRenames).toEqual({})
	expect(rewritten.content).toContain('"@jane/github.issue.opened"')
})

test('rewriteForkedPackageSelfReferences rewrites own topic references in emit calls, constants, and docs', () => {
	const { content, originName, targetName, topicRenames } =
		rewritePackageManifestForFork({
			manifestContent: githubManifest,
			expectedPackageScope: 'jane',
			targetKodyId: 'github',
		})
	const files = rewriteForkedPackageSelfReferences({
		files: {
			'package.json': content,
			'src/events/topics.ts': [
				"export const opened = '@kody/github.issue.opened'",
				'export const merged = "@kody/github.pr.merged"',
				'export const other = `@kody/github.issue.opened.v2`',
				"export const foreign = '@kody/discord.message.created'",
			].join('\n'),
			'src/emit.ts':
				"await emit({ topic: '@kody/github.pr.merged' }); import x from '@kody/github'",
			'README.md':
				'Emits `@kody/github.*` events such as @kody/github.issue.opened.',
		},
		originPackageName: originName!,
		nextPackageName: targetName,
		topicRenames,
	})
	expect(files['src/events/topics.ts']).toBe(
		[
			"export const opened = '@jane/github.issue.opened'",
			'export const merged = "@jane/github.pr.merged"',
			// Not a declared topic: only an exact topic match is renamed.
			'export const other = `@kody/github.issue.opened.v2`',
			"export const foreign = '@kody/discord.message.created'",
		].join('\n'),
	)
	expect(files['src/emit.ts']).toBe(
		"await emit({ topic: '@jane/github.pr.merged' }); import x from '@jane/github'",
	)
	expect(files['README.md']).toBe(
		'Emits `@jane/github.*` events such as @jane/github.issue.opened.',
	)
})

test('rewritePackageManifestForFork refuses a fork name that merges two emits topics', () => {
	expect(() =>
		rewritePackageManifestForFork({
			manifestContent: githubManifest,
			expectedPackageScope: 'jane',
			targetKodyId: 'ci',
		}),
	).not.toThrow()
	const manifest = githubManifest.replace(
		'"@kody/ci.completed"',
		'"@kody/github.completed": { "description": "x" },\n\t\t\t\t"@kody/ci.completed"',
	)
	expect(() =>
		rewritePackageManifestForFork({
			manifestContent: manifest,
			expectedPackageScope: 'jane',
			targetKodyId: 'ci',
		}),
	).toThrow(
		/"@kody\/github\.completed" and "@kody\/ci\.completed" to the same topic "@jane\/ci\.completed"/,
	)
})

test('rewriteForkedPackageSelfReferences leaves binary files untouched', () => {
	const binary = 'PNG\0@kody/github.pr.merged @kody/github'
	const files = rewriteForkedPackageSelfReferences({
		files: { 'logo.png': binary, 'data.bin': binary },
		originPackageName: '@kody/github',
		nextPackageName: '@jane/github',
		topicRenames: { '@kody/github.pr.merged': '@jane/github.pr.merged' },
	})
	expect(files).toEqual({ 'logo.png': binary, 'data.bin': binary })
})

test('rewriteForkedPackageSelfReferences rewrites text files that contain U+FFFD', () => {
	const files = rewriteForkedPackageSelfReferences({
		files: { 'src/a.ts': "// \uFFFD\nemit('@kody/github.pr.merged')\n" },
		originPackageName: '@kody/github',
		nextPackageName: '@jane/github',
		topicRenames: { '@kody/github.pr.merged': '@jane/github.pr.merged' },
	})
	expect(files['src/a.ts']).toBe("// \uFFFD\nemit('@jane/github.pr.merged')\n")
})

function forkGithub(files: Record<string, string>) {
	const names = {
		originPackageName: '@kody/github',
		nextPackageName: '@alice/github',
	}
	const rewritten = rewriteForkedPackageSelfReferences({
		files,
		...names,
		topicRenames: {
			'@kody/github.issue.opened': '@alice/github.issue.opened',
			'@kody/github.*': '@alice/github.*',
		},
	})
	return {
		files: rewritten,
		leftovers: scanLeftoverOriginReferences({ files: rewritten, ...names }),
	}
}

test('fork rewrite follows escaped and encoded self-references and keeps their spelling', () => {
	// The idempotency-key idiom from @kody/github `src/events/normalize.ts`.
	const fork = forkGithub({
		'src/events/normalize.ts': String.raw`export function githubEventKey(deliveryId: string, topic: string) {
	const leaf = topic.replace(/^@kody\/github\./, '')
	return 'github:' + deliveryId + ':' + leaf
}
const exact = /@kody\/github/
const escapedString = '@kody\/github'
const builtRegex = new RegExp('^@kody\\/github\\.')
const escapedTopic = /^@kody\/github\.issue\.opened$/
const docsUrl = 'https://kody.codes/packages/%40kody%2Fgithub/readme'
const lowerHexUrl = 'https://kody.codes/packages/@kody%2fgithub'
`,
		'meta.json': String.raw`{"package":"@kody\/github","topic":"@kody\/github.issue.opened"}`,
	})
	expect(fork.files['src/events/normalize.ts']).toBe(
		String.raw`export function githubEventKey(deliveryId: string, topic: string) {
	const leaf = topic.replace(/^@alice\/github\./, '')
	return 'github:' + deliveryId + ':' + leaf
}
const exact = /@alice\/github/
const escapedString = '@alice\/github'
const builtRegex = new RegExp('^@alice\\/github\\.')
const escapedTopic = /^@alice\/github\.issue\.opened$/
const docsUrl = 'https://kody.codes/packages/%40alice%2Fgithub/readme'
const lowerHexUrl = 'https://kody.codes/packages/@alice%2fgithub'
`,
	)
	expect(fork.files['meta.json']).toBe(
		String.raw`{"package":"@alice\/github","topic":"@alice\/github.issue.opened"}`,
	)
	expect(fork.leftovers).toEqual([])
	// The rewritten regex strips the fork's own topic prefix again.
	const forkedPrefix = /const leaf = topic\.replace\(\/(.+)\/, ''\)/.exec(
		fork.files['src/events/normalize.ts']!,
	)![1]!
	expect(
		'@alice/github.issue.opened'.replace(new RegExp(forkedPrefix), ''),
	).toBe('issue.opened')
})

test('fork rewrite keeps the name boundary in every spelling', () => {
	const untouched = String.raw`import shared from 'kody:@kody/shared/util'
const longer = ['@kody/github-foo', '@kody/github2', '@kody/github_bar']
const escaped = [/@kody\/github-foo/, /@kody\/github\-foo/, /@kody\/github2/, /@kody\/shared/]
const encoded = ['%40kody%2Fgithub-foo', '@kody%2Fgithub2', '%40kody%2Fshared']
const built = new RegExp('@kody\\/github-foo|@kody\\/shared')
`
	const fork = forkGithub({ 'index.ts': untouched })
	expect(fork.files['index.ts']).toBe(untouched)
	expect(fork.leftovers).toEqual([
		{
			file: 'index.ts',
			line: 3,
			snippet: String.raw`const escaped = [/@kody\/github-foo/, /@kody\/github\-foo/, /@kody\/github2/, /@kody\/shared/]`,
		},
		{
			file: 'index.ts',
			line: 4,
			snippet: `const encoded = ['%40kody%2Fgithub-foo', '@kody%2Fgithub2', '%40kody%2Fshared']`,
		},
		{
			file: 'index.ts',
			line: 5,
			snippet: String.raw`const built = new RegExp('@kody\\/github-foo|@kody\\/shared')`,
		},
	])
})

test('scanLeftoverOriginReferences reports spellings the rewrite does not follow', () => {
	const fork = forkGithub({
		'README.md': 'Import `kody:@kody/github/issues` and `@kody/shared`.\n',
		'src/a.ts': String.raw`const unicodeAt = '\u0040kody/github'
const fine = '@kody/github'
const tripleEscaped = '@kody\\\/github'
const hexSlash = '@kody\x2fgithub'
const joined = ['@kody', 'github'].join('/')
`,
		'src/b.ts': `const long = '${'a'.repeat(200)} @kody\\u002fgithub ${'b'.repeat(200)}'\n`,
		'icon.png': 'PNG @kody\\\\\\/github \u0000',
	})
	expect(fork.files['README.md']).toBe(
		'Import `kody:@alice/github/issues` and `@kody/shared`.\n',
	)
	expect(fork.leftovers).toEqual([
		{
			file: 'src/a.ts',
			line: 1,
			snippet: String.raw`const unicodeAt = '\u0040kody/github'`,
		},
		{
			file: 'src/a.ts',
			line: 3,
			snippet: String.raw`const tripleEscaped = '@kody\\\/github'`,
		},
		{
			file: 'src/a.ts',
			line: 4,
			snippet: String.raw`const hexSlash = '@kody\x2fgithub'`,
		},
		{
			file: 'src/b.ts',
			line: 1,
			snippet: `${'a'.repeat(59)} @kody\\u002fgithub ${'b'.repeat(59)}`,
		},
	])
})

test('scanLeftoverOriginReferences is empty for an unchanged name and same-scope renames keep siblings', () => {
	const files = { 'a.ts': String.raw`/@kody\/github/ '\u0040kody/shared'` }
	expect(
		scanLeftoverOriginReferences({
			files,
			originPackageName: '@kody/github',
			nextPackageName: '@kody/github',
		}),
	).toEqual([])
	expect(
		scanLeftoverOriginReferences({
			files,
			originPackageName: '@kody/github',
			nextPackageName: '@kody/gh',
		}),
	).toEqual([{ file: 'a.ts', line: 1, snippet: files['a.ts'] }])
	expect(
		scanLeftoverOriginReferences({
			files: { 'a.ts': String.raw`'\u0040kody/shared'` },
			originPackageName: '@kody/github',
			nextPackageName: '@kody/gh',
		}),
	).toEqual([])
})

test('fork rewrite leaves a dotted sibling name alone in plain and escaped spellings', () => {
	const files = {
		'src/internal.ts':
			"import '@kody/github._internal'\nconst re = /@kody\\/github\\._internal/\n",
	}
	const { files: rewritten } = forkGithub(files)
	expect(rewritten['src/internal.ts']).toBe(files['src/internal.ts'])
})

test('scanLeftoverOriginReferences finds a scope whose punctuation is escaped, and stays fast on long backslash runs', () => {
	const names = {
		originPackageName: '@my-org/github',
		nextPackageName: '@alice/github',
	}
	const files = rewriteForkedPackageSelfReferences({
		files: {
			'src/match.ts': 'const re = /@my\\-org\\/github/\n',
			'src/noise.ts': `// ${'\\'.repeat(200_000)}\n`,
		},
		...names,
		topicRenames: {},
	})
	const started = performance.now()
	const leftovers = scanLeftoverOriginReferences({ files, ...names })
	expect(performance.now() - started).toBeLessThan(2_000)
	expect(leftovers).toEqual([
		{
			file: 'src/match.ts',
			line: 1,
			snippet: 'const re = /@my\\-org\\/github/',
		},
	])
})
