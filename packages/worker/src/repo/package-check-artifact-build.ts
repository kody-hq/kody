import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import {
	collectPublishedPackageArtifactTargets,
	type PublishedPackageArtifactBuildTarget,
} from '#worker/package-runtime/published-bundle-artifacts.ts'
import type { RepoCheckRunResult } from './checks.ts'
import {
	isolatedArtifactRebuildChunkSize,
	runIsolatedArtifactRebuildWaves,
	type IsolatedArtifactRebuildRunner,
} from './isolated-artifact-rebuild.ts'

type RepoCheckResult = RepoCheckRunResult['results'][number]

function describeFailedTarget(
	target: PublishedPackageArtifactBuildTarget,
	message: string,
) {
	return `${target.entryPoint} (${target.bundleKind}): ${message}`
}

/**
 * The bundle half of a git-push publish for `packageCheck`: after the checks
 * ran with `deferBundleCheckToRebuild`, build every published artifact target
 * the way the publish rebuild does (same targets, same builders, same
 * per-isolate chunks and waves), keeping nothing. Returns the bundle check
 * result that replaces the deferred one.
 */
export async function runPackageCheckArtifactBuild(input: {
	runner: IsolatedArtifactRebuildRunner
	files: Record<string, string>
	userId: OwnerId
	baseUrl: string
	expectedPackageScope?: string
	/** The saved package's id, when the checked package was published before. */
	rootPackageId?: string
	/**
	 * Targets the publish rebuild would copy from the current artifact instead
	 * of building (unchanged inputs); publish never builds them, so neither
	 * does the check.
	 */
	listReusableTargets?: (
		targets: ReadonlyArray<PublishedPackageArtifactBuildTarget>,
	) => Promise<ReadonlySet<PublishedPackageArtifactBuildTarget>>
}): Promise<RepoCheckResult> {
	const manifest = parseAuthoredPackageJson({
		content: input.files['package.json'] ?? '',
		manifestPath: 'package.json',
		...(input.expectedPackageScope !== undefined
			? { expectedPackageScope: input.expectedPackageScope }
			: {}),
	})
	const allTargets = collectPublishedPackageArtifactTargets(manifest)
	if (allTargets.length === 0) {
		return {
			kind: 'bundle',
			ok: true,
			message:
				'No runtime artifacts to build: the package has no entry points.',
		}
	}
	const reusable = (await input.listReusableTargets?.(allTargets)) ?? new Set()
	const targets = allTargets.filter((target) => !reusable.has(target))
	const reusedNote =
		reusable.size > 0
			? ` ${reusable.size} more are unchanged since the published commit, so publish copies them instead of building them.`
			: ''
	if (targets.length === 0) {
		return {
			kind: 'bundle',
			ok: true,
			message: `All ${reusable.size} runtime artifact(s) are unchanged since the published commit, so publish copies them instead of building them; nothing was built or saved.`,
		}
	}
	const stagingKey = await input.runner.stage({
		userId: input.userId,
		sourceFiles: input.files,
	})
	const failures: Array<string> = []
	let platformError: unknown = null
	let built = 0
	try {
		await runIsolatedArtifactRebuildWaves({
			targets,
			runChunk: (chunk) =>
				input.runner.buildCheck({
					stagingKey,
					userId: input.userId,
					baseUrl: input.baseUrl,
					...(input.rootPackageId
						? { rootPackageId: input.rootPackageId }
						: {}),
					targets: chunk,
				}),
			beforeNextWave: () => input.runner.touch(stagingKey),
			recordChunk: (chunk, result) => {
				if (result.status === 'rejected') {
					platformError ??= result.reason
					return true
				}
				const before = failures.length
				for (const targetResult of result.value.results) {
					if (targetResult.ok) built += 1
					else {
						failures.push(
							describeFailedTarget(targetResult.target, targetResult.message),
						)
					}
				}
				if (result.value.results.length === 0 && !result.value.ok) {
					for (const target of chunk) {
						failures.push(describeFailedTarget(target, result.value.message))
					}
				}
				return failures.length > before
			},
		})
	} finally {
		await input.runner.discard(stagingKey)
	}
	if (platformError !== null) throw platformError
	if (failures.length > 0) {
		return {
			kind: 'bundle',
			ok: false,
			message: `The published artifact rebuild would fail, so the publish would too. ${failures.join('; ')}`,
		}
	}
	const isolates = Math.ceil(targets.length / isolatedArtifactRebuildChunkSize)
	return {
		kind: 'bundle',
		ok: true,
		message: `Built all ${built} runtime artifact(s) the way the publish rebuild does (${isolates} isolate(s), up to ${isolatedArtifactRebuildChunkSize} per isolate); nothing was saved.${reusedNote}`,
	}
}
