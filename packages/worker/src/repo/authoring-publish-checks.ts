import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { runRepoChecks, type RepoCheckRunResult } from './checks.ts'
import type { RepoCheckStep } from './isolated-runner-limit-message.ts'
import type { PublishPhaseTimings } from './publish-phase-timing.ts'

/**
 * The one `runRepoChecks` call an authoring publish makes. Every path that
 * publishes or offers to publish a package's own code goes through here:
 * `kody package publish` / `packagePublishExternalPush`, git-push reconcile,
 * Promote on the approve-publish page, the approve-publish page's check
 * preview, and `packageCheck` (which `kody dev check` calls). Keeping one
 * option set means a local check can never pass a commit that publish
 * refuses: the credential stamp gate, docs, skills, dependencies, bundle,
 * typecheck, and lint all run with authoring defaults.
 *
 * Community install and platform codemods are not authoring publishes and
 * keep calling `runRepoChecks` with their own relaxed options.
 */
export async function runAuthoringPublishChecks(input: {
	workspace: Parameters<typeof runRepoChecks>[0]['workspace']
	manifestPath: string
	sourceRoot: string
	env: Env
	baseUrl: string
	userId: OwnerId
	/** The entity source being published, when there is one. */
	sourceId?: string
	expectedPackageScope?: string
	phaseTimings?: PublishPhaseTimings
	/**
	 * Only for a run that rebuilds the same artifact targets right after (a
	 * rebuild failure is reported as a bundle check): git-push publish, and
	 * `packageCheck`, which then builds them the way the rebuild does.
	 */
	deferBundleCheckToRebuild?: boolean
	typecheckRanOffWorker?: boolean
	onStep?: (step: RepoCheckStep) => Promise<void>
	kodyIgnoredDeclarationFiles?: Array<string>
}): Promise<RepoCheckRunResult> {
	return await runRepoChecks({
		workspace: input.workspace,
		manifestPath: input.manifestPath,
		sourceRoot: input.sourceRoot,
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		...(input.sourceId ? { sourceId: input.sourceId } : {}),
		...(input.expectedPackageScope !== undefined
			? { expectedPackageScope: input.expectedPackageScope }
			: {}),
		...(input.phaseTimings ? { phaseTimings: input.phaseTimings } : {}),
		...(input.onStep ? { onStep: input.onStep } : {}),
		...(input.kodyIgnoredDeclarationFiles?.length
			? { kodyIgnoredDeclarationFiles: input.kodyIgnoredDeclarationFiles }
			: {}),
		...(input.deferBundleCheckToRebuild === true
			? { deferBundleCheckToRebuild: true }
			: {}),
		...(input.typecheckRanOffWorker === true
			? { typecheckRanOffWorker: true }
			: {}),
	})
}
