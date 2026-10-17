/**
 * Conservative, behavior-preserving transforms for the #3836 platform
 * credential-stamp migration. Apply only when the converted tree is
 * stamp-sealable without changing how credentials resolve at runtime.
 *
 * Safe today:
 * - Declare missing bare npm dependencies that block republish (allowlisted).
 * - Seal missing `kody.credentials` descriptions via the existing seal plan.
 *
 * Unconvertible patterns (computed names, `|scope=` including package/user/
 * session, packageSecrets.get, server_eval, vault placeholders,
 * credential.named) stay skipped. Manifest-only `kody.secretMounts` may stay
 * for stale static dependents and does not block sealing. Do not strip
 * `|scope=package`: unsuffixed lookup prefers
 * session before package, which would widen resolution. Package-bound Keys
 * can fill that same package's declared needs (name match or sole candidate),
 * so owners can move off `|scope=package` placeholders onto declared needs
 * without creating new secrets; this codemod still will not rewrite those
 * placeholders automatically.
 */
import {
	applyCredentialStampSealPlan,
	planCredentialStampSeal,
	type CredentialStampGateFailure,
} from '#worker/credentials/credential-stamp.ts'
import { isCredentialStampMigrateHoldout } from '#worker/credentials/credential-stamp-migrate-holdouts.ts'
import { listScannableModulePaths } from '#worker/credentials/module-placeholder-scan.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import {
	collectBundlerResolvedSpecifiers,
	getBarePackageNameFromSpecifier,
	isBarePackageImportSpecifier,
} from '#worker/package-runtime/import-specifiers.ts'

export const credentialStampConvertCodemodId = '0015-convert-credential-stamps'

const packageManifestPath = 'package.json'

/**
 * Fixed messages only: fleet findings must never embed source contents.
 */
export const credentialStampConvertMessages = {
	holdout:
		'Kent holdout: left untouched for the long-term publish-gate migration (issue #3836).',
	unconvertible:
		'Still has credential patterns the stamp gate cannot seal without an API or behavior change (computed names, |scope= including package/user/session, packageSecrets.get, credential.named, server eval, vault placeholders, or dynamic kody.mcp). Manifest-only kody.secretMounts may stay for stale static dependents. Skip and leave on the publish gate.',
	uninferable:
		'Has stamped credential keys whose purpose cannot be inferred from source. Write a real description in kody.credentials, then republish.',
	invalidManifest:
		'package.json is missing or not valid for publish; skipped without changing files.',
} as const

/**
 * Bare package names the migration may auto-declare. Versions match the
 * platform packages workers already install for package apps.
 */
export const credentialStampConvertAllowedBareDeps: Readonly<
	Record<string, string>
> = {
	remix: '3.0.0',
}

export type CredentialStampConvertFinding = {
	path: string | null
	message: string
}

export type CredentialStampConvertResult = {
	files: Record<string, string>
	changed: boolean
	changedPaths: Array<string>
	needsManual: Array<CredentialStampConvertFinding>
	/** True when the converted tree has no stamp-gate blocking failures. */
	sealReady: boolean
	blockingFailures: Array<CredentialStampGateFailure>
	skippedHoldout: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function readDeclaredDependencyNames(
	manifestSource: string | undefined,
): Set<string> {
	if (manifestSource == null) return new Set()
	let parsed: unknown
	try {
		parsed = JSON.parse(manifestSource)
	} catch {
		return new Set()
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.dependencies)) {
		return new Set()
	}
	return new Set(Object.keys(parsed.dependencies))
}

/**
 * Bare package names referenced by import/export/require in scannable modules,
 * including side-effect imports (`import 'remix/setup'`). Only allowlisted
 * names are considered for auto-declaration.
 */
export function collectAllowlistedUndeclaredBareDeps(
	files: Record<string, string>,
): Array<string> {
	const declared = readDeclaredDependencyNames(files[packageManifestPath])
	const found = new Set<string>()
	for (const path of listScannableModulePaths(files)) {
		const source = files[path]
		if (source == null) continue
		const specifiers = collectBundlerResolvedSpecifiers(source)
		if (specifiers == null) continue
		for (const specifier of specifiers) {
			if (!isBarePackageImportSpecifier(specifier)) continue
			const name = getBarePackageNameFromSpecifier(specifier)
			if (name == null) continue
			if (!(name in credentialStampConvertAllowedBareDeps)) continue
			if (declared.has(name)) continue
			found.add(name)
		}
	}
	return [...found].sort((left, right) => left.localeCompare(right))
}

function addAllowlistedDependencies(
	files: Record<string, string>,
	missing: ReadonlyArray<string>,
): { files: Record<string, string>; changed: boolean } {
	if (missing.length === 0) return { files, changed: false }
	const source = files[packageManifestPath]
	if (source == null) return { files, changed: false }
	let parsed: unknown
	try {
		parsed = JSON.parse(source)
	} catch {
		return { files, changed: false }
	}
	if (!isPlainObject(parsed)) return { files, changed: false }
	const dependencies = isPlainObject(parsed.dependencies)
		? { ...parsed.dependencies }
		: {}
	let changed = false
	for (const name of missing) {
		const version = credentialStampConvertAllowedBareDeps[name]
		if (version == null || typeof dependencies[name] === 'string') continue
		dependencies[name] = version
		changed = true
	}
	if (!changed) return { files, changed: false }
	const nextManifest = {
		...parsed,
		dependencies,
	}
	const trailingNewline = source.endsWith('\n') ? '\n' : ''
	const indent = source.includes('\t') ? '\t' : 2
	return {
		files: {
			...files,
			[packageManifestPath]: `${JSON.stringify(nextManifest, null, indent)}${trailingNewline}`,
		},
		changed: true,
	}
}

/**
 * Pure conversion: holdout skip, allowlisted deps, then credential-stamp seal
 * plan. Never creates or changes credential values. Never strips `|scope=`
 * (that would widen secret resolution). Writes only when stamp-sealable.
 */
export function convertCredentialStampFiles(input: {
	files: Record<string, string>
	packageName: string
}): CredentialStampConvertResult {
	if (isCredentialStampMigrateHoldout(input.packageName)) {
		return {
			files: { ...input.files },
			changed: false,
			changedPaths: [],
			needsManual: [
				{ path: null, message: credentialStampConvertMessages.holdout },
			],
			sealReady: false,
			blockingFailures: [],
			skippedHoldout: true,
		}
	}

	let files = { ...input.files }
	const changedPaths = new Set<string>()

	const missingDeps = collectAllowlistedUndeclaredBareDeps(files)
	if (missingDeps.length > 0) {
		const withDeps = addAllowlistedDependencies(files, missingDeps)
		if (withDeps.changed) {
			files = withDeps.files
			changedPaths.add(packageManifestPath)
		}
	}

	try {
		if (files[packageManifestPath] != null) {
			parseAuthoredPackageJson({
				content: files[packageManifestPath]!,
				mode: 'published',
			})
		}
	} catch {
		return {
			files: { ...input.files },
			changed: false,
			changedPaths: [],
			needsManual: [
				{
					path: packageManifestPath,
					message: credentialStampConvertMessages.invalidManifest,
				},
			],
			sealReady: false,
			blockingFailures: [],
			skippedHoldout: false,
		}
	}

	const plan = planCredentialStampSeal(files)
	const sealReady =
		plan.blockingFailures.length === 0 && plan.uninferableKeys.length === 0

	if (!sealReady) {
		const skipMessage =
			plan.blockingFailures.length > 0
				? credentialStampConvertMessages.unconvertible
				: credentialStampConvertMessages.uninferable
		return {
			files: { ...input.files },
			changed: false,
			changedPaths: [],
			needsManual: [
				{
					path: plan.blockingFailures[0]?.path ?? packageManifestPath,
					message: skipMessage,
				},
			],
			sealReady: false,
			blockingFailures: plan.blockingFailures,
			skippedHoldout: false,
		}
	}

	let sealChanged = false
	if (plan.updates.length > 0) {
		const applied = applyCredentialStampSealPlan(files, plan)
		if (applied.changed) {
			files = applied.files
			changedPaths.add(packageManifestPath)
			sealChanged = true
		}
	}

	const changed = changedPaths.size > 0 || sealChanged
	return {
		files,
		changed,
		changedPaths: [...changedPaths].sort((left, right) =>
			left.localeCompare(right),
		),
		needsManual: [],
		sealReady: true,
		blockingFailures: [],
		skippedHoldout: false,
	}
}
