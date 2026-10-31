import { expect, test } from 'vitest'
import { type ClosurePackage } from '#worker/package-codemods/package-app-capability-closure.ts'
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'
import {
	buildCapabilityDeclarationCheck,
	computeCapabilityClosure,
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

test('an undeclared literal call in a library package warns without failing', async () => {
	const manifest = kodyManifest()
	const sourceFiles = {
		'package.json': manifestFiles({}),
		'src/index.ts':
			"import { kody } from 'kody:runtime'\nexport default async () => { await kody.secretList({}); await kody.visitorNeed({}) }\n",
	}
	expect(findCapabilityDeclarationGaps({ manifest, sourceFiles })).toEqual([
		{ kind: 'undeclared', path: 'src/index.ts', names: ['secretList'] },
	])
	const check = await buildCapabilityDeclarationCheck({ manifest, sourceFiles })
	expect(check).toMatchObject({ kind: 'capabilities', ok: true })
	expect(check?.message).toContain('`src/index.ts` calls `secretList`')
	expect(check?.message).toContain('`kody.capabilities`')
})

test('a library declares in kody.capabilities, an app in kody.app.capabilities', async () => {
	const sourceFiles = {
		'src/index.ts':
			"import { kody } from 'kody:runtime'\nexport default async () => { await kody.secretList({}) }\n",
	}
	expect(
		await buildCapabilityDeclarationCheck({
			manifest: kodyManifest({ capabilities: ['secretList'] }),
			sourceFiles,
		}),
	).toBeNull()
	expect(
		await buildCapabilityDeclarationCheck({
			manifest: kodyManifest({
				app: { entry: 'src/index.ts', capabilities: ['secretList'] },
			}),
			sourceFiles,
		}),
	).toBeNull()
	expect(
		(
			await buildCapabilityDeclarationCheck({
				manifest: kodyManifest({
					capabilities: ['secretList'],
					app: { entry: 'src/index.ts' },
				}),
				sourceFiles,
			})
		)?.message,
	).toContain('secretList')
})

test('apps are pointed at kody.app.capabilities', async () => {
	const check = await buildCapabilityDeclarationCheck({
		manifest: kodyManifest({ app: { entry: 'src/index.ts' } }),
		sourceFiles: {
			'src/index.ts':
				"import { kody } from 'kody:runtime'\nexport default async () => kody.secretList({})\n",
		},
	})
	expect(check?.message).toContain('`kody.app.capabilities`')
})

test('computed names warn only while nothing is declared', async () => {
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

test('a package with no kody calls has no check result', async () => {
	expect(
		await buildCapabilityDeclarationCheck({
			manifest: kodyManifest(),
			sourceFiles: { 'src/index.ts': 'export const answer = 42\n' },
		}),
	).toBeNull()
})

test('a module-level kody that is not the runtime bridge is ignored', async () => {
	expect(
		await buildCapabilityDeclarationCheck({
			manifest: kodyManifest(),
			sourceFiles: {
				'src/index.ts':
					'const kody = { send() {} }\nexport default () => kody.send()\n',
			},
		}),
	).toBeNull()
})

test('a kody binding read from a kody:runtime namespace import is still the bridge', async () => {
	expect(
		(
			await buildCapabilityDeclarationCheck({
				manifest: kodyManifest(),
				sourceFiles: {
					'src/index.ts':
						"import * as runtime from 'kody:runtime'\nconst kody = runtime.kody\nexport default () => kody.secretList({})\n",
				},
			})
		)?.message,
	).toContain('secretList')
})

function helperPackage(kody: Record<string, unknown>): ClosurePackage {
	return {
		id: 'pkg-example-helper',
		manifest: {
			name: '@example/helper',
			exports: { '.': './index.ts' },
			kody: { description: 'Example helper.', ...kody },
		} as unknown as ClosurePackage['manifest'],
		files: {
			'package.json': '{}',
			'index.ts':
				"import { kody } from 'kody:runtime'\nexport const listSecrets = () => kody.secretList({})\n",
		},
	}
}

function appManifest(capabilities: Array<string> = []) {
	return {
		name: '@example/app',
		kody: {
			description: 'Example app.',
			app: { entry: './index.ts', capabilities },
		},
	} as unknown as AuthoredPackageJson
}

const importsHelper = {
	'index.ts':
		"import { listSecrets } from 'kody:@example/helper'\nexport default async () => listSecrets()\n",
}

function loaderFor(packages: Record<string, ClosurePackage>) {
	return async (name: string) => packages[name] ?? null
}

test('the effective set adds what imported packages declare', async () => {
	const closure = await computeCapabilityClosure({
		manifest: appManifest(['jobList']),
		sourceFiles: importsHelper,
		loadPackage: loaderFor({
			'@example/helper': helperPackage({ capabilities: ['secretList'] }),
		}),
	})
	expect(closure.effective).toEqual(['jobList', 'secretList'])
	// The runtime still checks only kody.app.capabilities.
	expect(closure.uncovered).toEqual(['secretList'])
})

test('an app warns about capabilities its imports call until it lists them', async () => {
	const loadPackage = loaderFor({ '@example/helper': helperPackage({}) })
	const check = await buildCapabilityDeclarationCheck({
		manifest: appManifest(),
		sourceFiles: importsHelper,
		loadPackage,
	})
	expect(check).toMatchObject({ kind: 'capabilities', ok: true })
	expect(check?.message).toContain('Imported packages call `secretList`')
	expect(check?.message).toContain('`kody.app.capabilities`')
	expect(
		await buildCapabilityDeclarationCheck({
			manifest: appManifest(['secretList']),
			sourceFiles: importsHelper,
			loadPackage,
		}),
	).toBeNull()
})

test('a library is covered by what its imports declare', async () => {
	const manifest = {
		name: '@example/wrapper',
		kody: { description: 'Example.' },
	} as unknown as AuthoredPackageJson
	expect(
		await buildCapabilityDeclarationCheck({
			manifest,
			sourceFiles: importsHelper,
			loadPackage: loaderFor({
				'@example/helper': helperPackage({ capabilities: ['secretList'] }),
			}),
		}),
	).toBeNull()
	expect(
		(
			await buildCapabilityDeclarationCheck({
				manifest,
				sourceFiles: importsHelper,
				loadPackage: loaderFor({ '@example/helper': helperPackage({}) }),
			})
		)?.message,
	).toContain('Imported packages call `secretList`')
})

test('imports that do not resolve are reported as unchecked', async () => {
	const check = await buildCapabilityDeclarationCheck({
		manifest: appManifest(['secretList']),
		sourceFiles: importsHelper,
		loadPackage: loaderFor({}),
	})
	expect(check?.message).toContain(
		'1 import(s) of other packages could not be resolved statically',
	)
})

test('a loader failure is reported instead of failing the check', async () => {
	const check = await buildCapabilityDeclarationCheck({
		manifest: appManifest(['secretList']),
		sourceFiles: importsHelper,
		loadPackage: async () => {
			throw new Error('boom')
		},
	})
	expect(check).toMatchObject({ kind: 'capabilities', ok: true })
	expect(check?.message).not.toContain('boom')
})

test('a closure walk past its budget is reported instead of holding publish', async () => {
	const check = await buildCapabilityDeclarationCheck({
		manifest: appManifest(['secretList']),
		sourceFiles: importsHelper,
		loadPackage: () => new Promise(() => {}),
		closureBudgetMs: 10,
	})
	expect(check?.message).toContain('walking the import closure took too long')
})

test('a failing import keeps the gaps already found in other imports', async () => {
	const check = await buildCapabilityDeclarationCheck({
		manifest: appManifest(),
		sourceFiles: {
			'index.ts':
				"import { listSecrets } from 'kody:@example/helper'\nimport { other } from 'kody:@example/other'\nexport default async () => [listSecrets(), other()]\n",
		},
		loadPackage: async (name) => {
			if (name === '@example/helper')
				return helperPackage({ capabilities: ['secretList'] })
			throw new Error('boom')
		},
	})
	expect(check?.message).toContain('secretList')
	expect(check?.message).toContain('could not be resolved statically')
	expect(check?.message).not.toContain('boom')
})
