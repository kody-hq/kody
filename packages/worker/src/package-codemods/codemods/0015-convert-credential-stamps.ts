/**
 * Platform migration for issue #3836: convert published packages to
 * stamp-sealable fixed credential slots when it can be proven safe, then let
 * adminCredentialStampBackfill / adminCredentialStampMigrate stamp them.
 *
 * Holdouts, unconvertible patterns, and uninferable descriptions are
 * needs_manual skips — never owner contact, never credential value changes.
 */
import {
	convertCredentialStampFiles,
	credentialStampConvertCodemodId,
	credentialStampConvertMessages,
} from '#worker/credentials/credential-stamp-convert.ts'
import type {
	PackageCodemod,
	PackageCodemodContext,
	PackageCodemodFinding,
	PackageCodemodTransformResult,
} from '../types.ts'

export {
	credentialStampConvertCodemodId as convertCredentialStampsCodemodId,
	credentialStampConvertMessages as convertCredentialStampsMessages,
}

const packageManifestPath = 'package.json'

function normalizeSnapshotPath(path: string) {
	return path.trim().replace(/^\/+/, '')
}

function locatePackage(
	files: Record<string, string>,
	context: PackageCodemodContext,
): {
	files: Record<string, string>
	manifestWriteKey: string
	/** Snapshot path prefix for remapping package-relative module paths back. */
	snapshotPrefix: string
} {
	const root = normalizeSnapshotPath(context.sourceRoot ?? '').replace(
		/\/+$/,
		'',
	)
	const manifestPath = normalizeSnapshotPath(
		context.manifestPath ?? packageManifestPath,
	)
	const prefix = `${root}/`
	const keyFor = (path: string) =>
		Object.keys(files).find((key) => normalizeSnapshotPath(key) === path)
	const underRoot = root !== '' && manifestPath.startsWith(prefix)
	const repoKey = keyFor(manifestPath)
	if (underRoot && repoKey !== undefined) {
		const scoped = Object.fromEntries(
			Object.entries(files).filter(([key]) =>
				normalizeSnapshotPath(key).startsWith(prefix),
			),
		)
		const remapped: Record<string, string> = {}
		for (const [key, value] of Object.entries(scoped)) {
			const relative = normalizeSnapshotPath(key).slice(prefix.length)
			remapped[relative === '' ? packageManifestPath : relative] = value
		}
		if (remapped[packageManifestPath] == null && scoped[repoKey] != null) {
			remapped[packageManifestPath] = scoped[repoKey]!
		}
		return {
			files: remapped,
			manifestWriteKey: repoKey,
			snapshotPrefix: root,
		}
	}
	const relativeManifest = underRoot
		? manifestPath.slice(prefix.length)
		: manifestPath
	const manifestKey = keyFor(relativeManifest) ?? relativeManifest
	if (manifestKey === packageManifestPath) {
		return {
			files,
			manifestWriteKey: packageManifestPath,
			snapshotPrefix: '',
		}
	}
	const remapped: Record<string, string> = { ...files }
	if (files[manifestKey] != null) {
		remapped[packageManifestPath] = files[manifestKey]!
	}
	return {
		files: remapped,
		manifestWriteKey: manifestKey,
		snapshotPrefix: '',
	}
}

/**
 * Write only convert `changedPaths` back onto the snapshot. `locatePackage` may
 * alias a nested manifest onto `package.json` while leaving the original nested
 * key in the map — mirroring every converted key would let that stale nested
 * copy overwrite the sealed manifest at `manifestWriteKey` (same trap 0014
 * avoids by writing only the locate snapshot key).
 */
function remapConvertFilesToSnapshot(
	original: Record<string, string>,
	converted: Record<string, string>,
	changedPaths: ReadonlyArray<string>,
	manifestWriteKey: string,
	snapshotPrefix: string,
): Record<string, string> {
	const next = { ...original }
	const prefix = snapshotPrefix === '' ? '' : `${snapshotPrefix}/`
	for (const path of changedPaths) {
		const content = converted[path]
		if (content == null) continue
		if (path === packageManifestPath) {
			next[manifestWriteKey] = content
			continue
		}
		next[`${prefix}${path}`] = content
	}
	return next
}

function detectConvertCredentialStamps(
	files: Record<string, string>,
	context: PackageCodemodContext,
): Array<PackageCodemodFinding> {
	const located = locatePackage(files, context)
	const result = convertCredentialStampFiles({
		files: located.files,
		packageName: context.packageName,
	})
	if (result.skippedHoldout) {
		return [{ path: null, message: credentialStampConvertMessages.holdout }]
	}
	if (!result.sealReady) {
		return result.needsManual
	}
	if (result.changed) {
		return [
			{
				path: packageManifestPath,
				message:
					'Convertible to sealed credential stamps (allowlisted missing deps and/or inferred kody.credentials descriptions).',
			},
		]
	}
	return []
}

function transformConvertCredentialStamps(
	files: Record<string, string>,
	context: PackageCodemodContext,
): PackageCodemodTransformResult {
	const located = locatePackage(files, context)
	const result = convertCredentialStampFiles({
		files: located.files,
		packageName: context.packageName,
	})
	if (!result.changed || !result.sealReady) {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual: result.needsManual,
		}
	}
	const nextFiles = remapConvertFilesToSnapshot(
		files,
		result.files,
		result.changedPaths,
		located.manifestWriteKey,
		located.snapshotPrefix,
	)
	const changedPaths = Object.keys(nextFiles)
		.filter((path) => nextFiles[path] !== files[path])
		.sort((left, right) => left.localeCompare(right))
	return {
		files: nextFiles,
		changed: changedPaths.length > 0,
		changedPaths,
		needsManual: [],
	}
}

/**
 * Conservative conversion for issue #3836: declare allowlisted missing bare
 * deps (e.g. remix), seal stamp descriptions, skip holdouts and anything still
 * unconvertible (including all `|scope=` placeholders — stripping
 * `|scope=package` would widen resolution to session secrets).
 */
export const convertCredentialStampsCodemod: PackageCodemod = {
	id: credentialStampConvertCodemodId,
	description:
		'Convert published packages to sealed credential stamps when safe: declare allowlisted missing bare deps (remix), and fill inferred kody.credentials descriptions. Does not strip |scope= placeholders. Skips Kent holdouts and packages that still need an owner/API change (issue #3836).',
	applyMode: 'published-only',
	detect: detectConvertCredentialStamps,
	transform: transformConvertCredentialStamps,
}
