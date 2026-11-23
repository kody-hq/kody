import { expect, test } from 'vitest'
import {
	collectChangedForkFiles,
	rewriteForkedPackageSelfReferences,
	rewritePackageManifestForFork,
	scanCrossScopeReferences,
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
