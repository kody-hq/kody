import {
	type KodyPackageDependencies,
	kodyPackageDependencySchema,
	kodyPackageDependencyWildcard,
	listKodyPackageDependencyNames,
} from '#worker/package-registry/types.ts'
import type {
	PackageCodemod,
	PackageCodemodFinding,
	PackageCodemodTransformResult,
} from '../types.ts'

export const kodyDependenciesToWildcardMapCodemodId =
	'0005-kody-dependencies-to-wildcard-map'

const packageManifestPath = 'package.json'
const latestAlias = 'latest'

const arrayRewriteMessage =
	'Declares array-shaped package.json#kody.dependencies; rewrite to a name-to-"*" map.'

const aliasRewriteMessage =
	'Declares a kody.dependencies version that normalizes to "*"; rewrite that value to "*".'

const invalidJsonMessage =
	'package.json is missing or not valid JSON; review kody.dependencies manually.'

const invalidShapeMessage =
	'package.json#kody.dependencies is not an array or object map; review and update manually.'

const invalidNamesMessage =
	'package.json#kody.dependencies has entries that are not scoped package names; review and update manually.'

const unsupportedVersionMessage =
	'Declares a kody.dependencies version that is not "*"; review and update manually. Only "*" is supported (latest published commit, captured when this package publishes).'

type ManifestRecord = Record<string, unknown>

type DependenciesRewrite =
	| { kind: 'clean' }
	| { kind: 'rewrite-array'; next: KodyPackageDependencies }
	| { kind: 'rewrite-alias'; next: KodyPackageDependencies }
	| { kind: 'manual'; message: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function parseManifest(source: string): ManifestRecord | null {
	try {
		const parsed: unknown = JSON.parse(source)
		if (!isPlainObject(parsed)) return null
		return parsed
	} catch {
		return null
	}
}

function toWildcardMap(names: ReadonlyArray<string>): KodyPackageDependencies {
	return Object.fromEntries(
		names.map((name) => [name, kodyPackageDependencyWildcard]),
	)
}

function allEntriesAreScopedNames(entries: ReadonlyArray<string>) {
	return entries.every(
		(entry) => kodyPackageDependencySchema.safeParse(entry.trim()).success,
	)
}

function classifyDependencies(value: unknown): DependenciesRewrite {
	if (value === undefined) return { kind: 'clean' }
	if (Array.isArray(value)) {
		if (!value.every((entry) => typeof entry === 'string')) {
			return { kind: 'manual', message: invalidNamesMessage }
		}
		if (value.length > 0 && !allEntriesAreScopedNames(value)) {
			return { kind: 'manual', message: invalidNamesMessage }
		}
		return {
			kind: 'rewrite-array',
			next: toWildcardMap(listKodyPackageDependencyNames(value)),
		}
	}
	if (!isPlainObject(value)) {
		return { kind: 'manual', message: invalidShapeMessage }
	}
	const names = Object.keys(value)
	if (!allEntriesAreScopedNames(names)) {
		return { kind: 'manual', message: invalidNamesMessage }
	}
	const versions = Object.values(value)
	if (
		!versions.every(
			(version) =>
				version === kodyPackageDependencyWildcard || version === latestAlias,
		)
	) {
		return { kind: 'manual', message: unsupportedVersionMessage }
	}
	if (versions.every((version) => version === kodyPackageDependencyWildcard)) {
		return { kind: 'clean' }
	}
	return {
		kind: 'rewrite-alias',
		next: toWildcardMap(
			listKodyPackageDependencyNames(value as Record<string, string>),
		),
	}
}

function detectJsonIndent(source: string) {
	const match = source.match(/\n([ \t]+)"/)
	return match?.[1] ?? '\t'
}

function formatPackageJson(value: unknown, source: string) {
	return `${JSON.stringify(value, null, detectJsonIndent(source))}\n`
}

function classifyPackageJson(files: Record<string, string>): {
	path: string
	rewrite: DependenciesRewrite
	source: string | null
	parsed: ManifestRecord | null
} {
	const source = files[packageManifestPath]
	if (typeof source !== 'string') {
		return {
			path: packageManifestPath,
			rewrite: { kind: 'manual', message: invalidJsonMessage },
			source: null,
			parsed: null,
		}
	}
	const parsed = parseManifest(source)
	if (!parsed) {
		return {
			path: packageManifestPath,
			rewrite: { kind: 'manual', message: invalidJsonMessage },
			source,
			parsed: null,
		}
	}
	const kody = parsed['kody']
	if (kody === undefined) {
		return {
			path: packageManifestPath,
			rewrite: { kind: 'clean' },
			source,
			parsed,
		}
	}
	if (!isPlainObject(kody)) {
		return {
			path: packageManifestPath,
			rewrite: { kind: 'manual', message: invalidShapeMessage },
			source,
			parsed,
		}
	}
	return {
		path: packageManifestPath,
		rewrite: classifyDependencies(kody['dependencies']),
		source,
		parsed,
	}
}

function detectKodyDependenciesToWildcardMap(
	files: Record<string, string>,
): Array<PackageCodemodFinding> {
	const { path, rewrite } = classifyPackageJson(files)
	switch (rewrite.kind) {
		case 'clean':
			return []
		case 'rewrite-array':
			return [{ path, message: arrayRewriteMessage }]
		case 'rewrite-alias':
			return [{ path, message: aliasRewriteMessage }]
		case 'manual':
			return [{ path, message: rewrite.message }]
		default: {
			const exhaustive: never = rewrite
			return exhaustive
		}
	}
}

function transformKodyDependenciesToWildcardMap(
	files: Record<string, string>,
): PackageCodemodTransformResult {
	const { path, rewrite, source, parsed } = classifyPackageJson(files)
	if (rewrite.kind === 'clean') {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual: [],
		}
	}
	if (rewrite.kind === 'manual' || source == null || parsed == null) {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual: [
				{
					path,
					message:
						rewrite.kind === 'manual' ? rewrite.message : invalidJsonMessage,
				},
			],
		}
	}
	if (!isPlainObject(parsed['kody'])) {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual: [{ path, message: invalidJsonMessage }],
		}
	}
	const nextSource = formatPackageJson(
		{
			...parsed,
			kody: {
				...parsed['kody'],
				dependencies: rewrite.next,
			},
		},
		source,
	)
	if (nextSource === source) {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual: [],
		}
	}
	return {
		files: {
			...files,
			[packageManifestPath]: nextSource,
		},
		changed: true,
		changedPaths: [packageManifestPath],
		needsManual: [],
	}
}

/**
 * Manifest-format migration: rewrite published `kody.dependencies` from an
 * array of package names (or a map that uses the `latest` alias) to a
 * name-to-"*" object. Resolution stays snapshot-at-publish; "*" is not a
 * live pin. Kept registered while any published package still uses the
 * array form.
 */
export const kodyDependenciesToWildcardMapCodemod = {
	id: kodyDependenciesToWildcardMapCodemodId,
	description:
		'Rewrite package.json#kody.dependencies from an array of names to a name-to-"*" map; flag unsupported versions for manual review.',
	detect: detectKodyDependenciesToWildcardMap,
	transform: transformKodyDependenciesToWildcardMap,
} satisfies PackageCodemod
