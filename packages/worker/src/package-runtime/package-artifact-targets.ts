import {
	getPackageAppClientEntryPath,
	getPackageAppEntryPath,
	listPackageSubscriptions,
	normalizePackageExportKey,
	normalizePackageWorkspacePath,
} from '#worker/package-registry/manifest.ts'
import type {
	AuthoredPackageJson,
	PackageExportTarget,
} from '#worker/package-registry/types.ts'
import type { BundleArtifactKind } from './published-runtime-artifacts.ts'
import { buildPackageSubscriptionArtifactName } from './subscription-artifacts.ts'

export type PublishedPackageArtifactBuildTarget = {
	kind: BundleArtifactKind
	artifactName?: string | null
	entryPoint: string
	bundleKind: 'app' | 'app-client' | 'module' | 'importable-module'
}

/**
 * Targets with the same key build the same bundle: an export's `module`
 * target and every job or subscription handler on that file.
 */
export function publishedPackageArtifactBuildKey(
	target: Pick<
		PublishedPackageArtifactBuildTarget,
		'bundleKind' | 'entryPoint'
	>,
) {
	return `${target.bundleKind}\0${target.entryPoint}`
}

function resolvePackageExportRuntimeEntryPoint(target: PackageExportTarget) {
	return typeof target === 'string'
		? target
		: (target.import ?? target.default ?? null)
}

export function collectPublishedPackageArtifactTargets(
	manifest: AuthoredPackageJson,
) {
	const targets: Array<PublishedPackageArtifactBuildTarget> = []
	if (manifest.kody.app) {
		const entryPoint = getPackageAppEntryPath(manifest)
		if (entryPoint) {
			targets.push({
				kind: 'app',
				entryPoint,
				bundleKind: 'app',
			})
		}
		const clientEntryPoint = getPackageAppClientEntryPath(manifest)
		if (clientEntryPoint) {
			targets.push({
				kind: 'app-client',
				entryPoint: clientEntryPoint,
				bundleKind: 'app-client',
			})
		}
	}
	for (const [exportName, exportTarget] of Object.entries(manifest.exports)) {
		const entryPoint = resolvePackageExportRuntimeEntryPoint(exportTarget)
		if (!entryPoint) continue
		const normalizedEntryPoint = normalizePackageWorkspacePath(entryPoint)
		const artifactName = normalizePackageExportKey(exportName)
		targets.push({
			kind: 'module',
			artifactName,
			entryPoint: normalizedEntryPoint,
			bundleKind: 'module',
		})
		targets.push({
			kind: 'importable-module',
			artifactName,
			entryPoint: normalizedEntryPoint,
			bundleKind: 'importable-module',
		})
	}
	for (const subscription of listPackageSubscriptions(manifest)) {
		targets.push({
			kind: 'module',
			artifactName: buildPackageSubscriptionArtifactName(subscription.topic),
			entryPoint: subscription.handler,
			bundleKind: 'module',
		})
	}
	for (const [jobName, jobDefinition] of Object.entries(
		manifest.kody.jobs ?? {},
	)) {
		targets.push({
			kind: 'job',
			artifactName: jobName,
			entryPoint: normalizePackageWorkspacePath(jobDefinition.entry),
			bundleKind: 'module',
		})
	}
	return targets
}
