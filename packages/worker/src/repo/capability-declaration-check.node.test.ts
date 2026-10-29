import { expect, test } from 'vitest'
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'
import {
	buildCapabilityDeclarationCheck,
	findCapabilityDeclarationGaps,
} from './capability-declaration-check.ts'

function kodyManifest(kody: Record<string, unknown> = {}) {
	return {
		kody: { description: 'Example.', ...kody },
	} as unknown as AuthoredPackageJson
}

function manifestFiles(kody: Record<string, unknown>) {
	return JSON.stringify({
		name: '@example/helper',
		exports: { '.': './src/index.ts' },
		kody: { description: 'Example.', ...kody },
	})
}

test('an undeclared literal call in a library package warns without failing', () => {
	const manifest = kodyManifest()
	const sourceFiles = {
		'package.json': manifestFiles({}),
		'src/index.ts':
			"import { kody } from 'kody:runtime'\nexport default async () => { await kody.secretList({}); await kody.visitorNeed({}) }\n",
	}
	expect(findCapabilityDeclarationGaps({ manifest, sourceFiles })).toEqual([
		{ kind: 'undeclared', path: 'src/index.ts', names: ['secretList'] },
	])
	const check = buildCapabilityDeclarationCheck({ manifest, sourceFiles })
	expect(check).toMatchObject({ kind: 'capabilities', ok: true })
	expect(check?.message).toContain('`src/index.ts` calls `secretList`')
	expect(check?.message).toContain('`kody.capabilities`')
})

test('kody.capabilities and kody.app.capabilities both count as declared', () => {
	const sourceFiles = {
		'src/index.ts':
			"import { kody } from 'kody:runtime'\nexport default async () => { await kody.secretList({}); await kody.secretSet({}) }\n",
	}
	expect(
		buildCapabilityDeclarationCheck({
			manifest: kodyManifest({
				capabilities: ['secretList'],
				app: { entry: 'src/index.ts', capabilities: ['secretSet'] },
			}),
			sourceFiles,
		}),
	).toBeNull()
})

test('apps are pointed at kody.app.capabilities', () => {
	const check = buildCapabilityDeclarationCheck({
		manifest: kodyManifest({ app: { entry: 'src/index.ts' } }),
		sourceFiles: {
			'src/index.ts':
				"import { kody } from 'kody:runtime'\nexport default async () => kody.secretList({})\n",
		},
	})
	expect(check?.message).toContain('`kody.app.capabilities`')
})

test('computed names warn only while nothing is declared', () => {
	const sourceFiles = {
		'src/index.ts':
			"import { kody } from 'kody:runtime'\nexport default async (name) => { await kody[name]({}); return kody.mcp }\n",
	}
	expect(
		findCapabilityDeclarationGaps({
			manifest: kodyManifest(),
			sourceFiles,
		}),
	).toEqual([{ kind: 'unverifiable', path: 'src/index.ts', calls: 2 }])
	expect(
		findCapabilityDeclarationGaps({
			manifest: kodyManifest({ capabilities: ['secretList'] }),
			sourceFiles,
		}),
	).toEqual([])
})

test('a package with no kody calls has no check result', () => {
	expect(
		buildCapabilityDeclarationCheck({
			manifest: kodyManifest(),
			sourceFiles: { 'src/index.ts': 'export const answer = 42\n' },
		}),
	).toBeNull()
})
