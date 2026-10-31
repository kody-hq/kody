import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	loadObservedUndeclaredCalls,
	scanPackageAppImportClosure,
	type ClosurePackage,
} from '../package-app-capability-closure.ts'
import {
	type PackageAppCapabilityHostFacts,
	type PackageCodemodContext,
} from '../types.ts'
import {
	declarePackageAppCapabilitiesCodemod,
	declarePackageAppCapabilitiesMessages,
	type DeclarePackageAppCapabilitiesOwnerDetail,
} from './0018-declare-package-app-capabilities.ts'

const platformCapabilityNames = ['jobList', 'packageList', 'secretList']

function appFiles(source: string, capabilities: Array<string> = []) {
	return {
		'package.json': `${JSON.stringify(
			{
				name: '@example/app',
				exports: { '.': './index.ts' },
				kody: {
					description: 'Example app.',
					app: { entry: './index.ts', capabilities },
				},
			},
			null,
			'\t',
		)}\n`,
		'index.ts': source,
	}
}

const helper: ClosurePackage = {
	id: 'pkg-example-helper',
	manifest: {
		name: '@example/helper',
		exports: { '.': './index.ts' },
		kody: { description: 'Example helper.' },
	} as unknown as ClosurePackage['manifest'],
	files: {
		'package.json': '{}',
		'index.ts':
			"export { listSecrets } from './lib.ts'\nexport const unused = 1\n",
		'lib.ts':
			"import { kody } from 'kody:runtime'\nexport const listSecrets = () => kody.secretList({})\n",
		'unreached.ts':
			"import { kody } from 'kody:runtime'\nexport default () => kody.packageList({})\n",
	},
}

const importsHelper =
	"import { listSecrets } from 'kody:@example/helper'\nexport default async () => listSecrets()\n"

async function closureFor(
	files: Record<string, string>,
	packages: Record<string, ClosurePackage> = { '@example/helper': helper },
) {
	return await scanPackageAppImportClosure({
		appPackageId: 'pkg-example-app',
		appFiles: files,
		loadPackage: async (name) => packages[name] ?? null,
	})
}

function context(
	facts: Partial<PackageAppCapabilityHostFacts> = {},
): PackageCodemodContext {
	return {
		packageName: '@example/app',
		packageAppCapabilities: {
			closure: {
				names: [],
				computedCalls: 0,
				mcpCalls: 0,
				unresolvedImports: 0,
			},
			observed: { names: [], credentialNamedCalls: 0 },
			platformCapabilityNames,
			...facts,
		},
	}
}

function declared(files: Record<string, string>) {
	return JSON.parse(files['package.json']!).kody.app.capabilities
}

test('the closure scan follows an imported export, not the whole helper', async () => {
	expect(await closureFor(appFiles(importsHelper))).toEqual({
		names: ['secretList'],
		computedCalls: 0,
		mcpCalls: 0,
		unresolvedImports: 0,
	})
	expect(await closureFor(appFiles(importsHelper), {})).toMatchObject({
		names: [],
		unresolvedImports: 1,
	})
})

test('0018 adds capabilities called through an imported helper', async () => {
	const files = appFiles(importsHelper)
	const closure = await closureFor(files)
	const result = declarePackageAppCapabilitiesCodemod.transform(
		files,
		context({ closure }),
	)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['package.json'])
	expect(declared(result.files)).toEqual(['secretList'])
	expect(result.ownerDetail).toEqual({
		addedCapabilities: ['secretList'],
		sources: { direct: 0, importClosure: 1, observed: 0 },
		unresolved: {
			computedCalls: 0,
			mcpCalls: 0,
			unresolvedImports: 0,
			unknownCapabilityNames: 0,
			credentialNamedCalls: 0,
		},
	} satisfies DeclarePackageAppCapabilitiesOwnerDetail)
	expect(
		declarePackageAppCapabilitiesCodemod.detect(files, context({ closure })),
	).toEqual([
		{
			path: 'package.json',
			message: declarePackageAppCapabilitiesMessages.declare,
		},
	])
})

test('0018 is idempotent and keeps existing declarations first', () => {
	const files = appFiles(
		"import { kody } from 'kody:runtime'\nexport default async () => [await kody.jobList({}), await kody.secretList({})]\n",
		['secretList'],
	)
	const first = declarePackageAppCapabilitiesCodemod.transform(files, context())
	expect(declared(first.files)).toEqual(['secretList', 'jobList'])
	const second = declarePackageAppCapabilitiesCodemod.transform(
		first.files,
		context(),
	)
	expect(second.changed).toBe(false)
	expect(second.ownerDetail).toBeUndefined()
	expect(
		declarePackageAppCapabilitiesCodemod.detect(first.files, context()),
	).toEqual([])
})

test('0018 gap-fills computed names from the runtime log and still reports them', () => {
	const files = appFiles(
		"import { kody } from 'kody:runtime'\nexport default async (name: string) => kody[name]({})\n",
	)
	const unfilled = declarePackageAppCapabilitiesCodemod.transform(
		files,
		context(),
	)
	expect(unfilled.changed).toBe(false)
	expect(unfilled.needsManual).toEqual([
		{ path: null, message: declarePackageAppCapabilitiesMessages.computed },
	])
	expect(
		(unfilled.ownerDetail as DeclarePackageAppCapabilitiesOwnerDetail)
			.unresolved.computedCalls,
	).toBe(1)

	const filled = declarePackageAppCapabilitiesCodemod.transform(
		files,
		context({ observed: { names: ['jobList'], credentialNamedCalls: 0 } }),
	)
	expect(declared(filled.files)).toEqual(['jobList'])
	expect(filled.ownerDetail).toMatchObject({
		addedCapabilities: ['jobList'],
		sources: { direct: 0, importClosure: 0, observed: 1 },
		unresolved: { computedCalls: 1 },
	})
})

test('0018 never adds names that are not platform capabilities, and findings never name them', () => {
	const files = appFiles(
		"import { kody } from 'kody:runtime'\nexport default async () => kody.notAPlatformCall({})\n",
	)
	const result = declarePackageAppCapabilitiesCodemod.transform(
		files,
		context({ observed: { names: ['secretList'], credentialNamedCalls: 2 } }),
	)
	expect(declared(result.files)).toEqual(['secretList'])
	expect(result.ownerDetail).toMatchObject({
		unresolved: { unknownCapabilityNames: 1, credentialNamedCalls: 2 },
	})
	const findings = [
		...result.needsManual,
		...declarePackageAppCapabilitiesCodemod.detect(files, context()),
	]
	for (const finding of findings) {
		expect(Object.values(declarePackageAppCapabilitiesMessages)).toContain(
			finding.message,
		)
		expect(finding.message).not.toMatch(/notAPlatformCall|secretList/)
	}
})

test('0018 leaves packages that are not apps alone', () => {
	const files = {
		'package.json': JSON.stringify({
			name: '@example/helper',
			exports: { '.': './index.ts' },
			kody: { description: 'Example helper.' },
		}),
		'index.ts':
			"import { kody } from 'kody:runtime'\nexport default () => kody.secretList({})\n",
	}
	const result = declarePackageAppCapabilitiesCodemod.transform(
		files,
		context(),
	)
	expect(result).toEqual({
		files,
		changed: false,
		changedPaths: [],
		needsManual: [],
	})
})

test('observed undeclared calls come from rejections and allowances for one app', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const insert = (
		table: string,
		packageId: string,
		callName: string,
		kind: string,
	) =>
		sqlite
			.prepare(
				`INSERT INTO ${table} (day, owner_id, package_id, call_name, difference_kind, visitor_hash, first_seen_at, last_seen_at, observations)
				VALUES ('2026-10-01', 'user-a', ?, ?, ?, 'anonymous', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 1)`,
			)
			.run(packageId, callName, kind)
	const allow = (packageId: string, capabilityName: string) =>
		sqlite
			.prepare(
				`INSERT INTO package_app_capability_allowances (package_id, published_commit, capability_name, source, created_at)
				VALUES (?, 'commit-1', ?, 'authority-fallback', '2026-10-01T00:00:00Z')`,
			)
			.run(packageId, capabilityName)
	allow('pkg-example-app', 'jobList')
	insert(
		'package_app_authority_rejections',
		'pkg-example-app',
		'secretList',
		'capability_not_declared',
	)
	insert(
		'package_app_authority_rejections',
		'pkg-example-app',
		'jobList',
		'capability_not_declared',
	)
	insert(
		'package_app_authority_rejections',
		'pkg-example-app',
		'credential:example',
		'capability_not_declared',
	)
	insert(
		'package_app_authority_rejections',
		'pkg-example-app',
		'packageList',
		'permission_denied',
	)
	allow('pkg-other', 'packageList')
	expect(await loadObservedUndeclaredCalls(db, 'pkg-example-app')).toEqual({
		names: ['jobList', 'secretList'],
		credentialNamedCalls: 1,
	})
})
