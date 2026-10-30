import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	countUnbuiltPublishedPackageArtifactTargets,
	rebuildPublishedPackageArtifactsViaRepoSession,
} from '#mcp/capabilities/repo/package-artifact-rebuild.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { publishedPublishChecksAreCurrent } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'
import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { readPublishGitNoteFromArtifactsRepo } from '#worker/repo/publish-git-notes.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const outcomeSchema = z.object({
	packageId: z.string(),
	ownerUserId: z.string().nullable(),
	sourceId: z.string().nullable(),
	publishedCommit: z.string().nullable(),
	outcome: z.enum([
		'complete',
		'incomplete',
		'resumed',
		'skipped_not_found',
		'skipped_unpublished',
		'skipped_head_differs',
		'failed',
	]),
	sealed: z.boolean().optional(),
	staleJobCount: z.number().int().nonnegative().optional(),
	publishNoteFound: z.boolean().optional(),
	unbuiltArtifactTargetCount: z.number().int().nonnegative().optional(),
	rebuiltTargetCount: z.number().int().nonnegative().optional(),
	error: z.string().optional(),
})

const inputSchema = z.object({
	packageIds: z
		.array(z.string().min(1))
		.min(1)
		.max(10)
		.describe(
			'Saved package ids to inspect (and resume when dryRun is false).',
		),
	dryRun: z
		.boolean()
		.optional()
		.describe(
			'When true (default), report whether each live published commit finished its publish. Set false to finish incomplete ones.',
		),
})

const outputSchema = z.object({
	dryRun: z.boolean(),
	outcomes: z.array(outcomeSchema),
})

type Outcome = z.infer<typeof outcomeSchema>

async function resumePackage(input: {
	env: Env
	baseUrl: string
	packageId: string
	dryRun: boolean
}): Promise<Outcome> {
	const savedPackage = await getSavedPackageByIdInAnyOrg(
		input.env.APP_DB,
		input.packageId,
	)
	const base = {
		packageId: input.packageId,
		ownerUserId: savedPackage?.userId ?? null,
		sourceId: savedPackage?.sourceId ?? null,
		publishedCommit: null,
	}
	const source = savedPackage
		? await getEntitySourceById(input.env.APP_DB, savedPackage.sourceId)
		: null
	if (!savedPackage || !source || source.entity_kind !== 'package') {
		return { ...base, outcome: 'skipped_not_found' }
	}
	const publishedCommit = source.published_commit
	if (!publishedCommit) return { ...base, outcome: 'skipped_unpublished' }
	const withCommit = { ...base, publishedCommit }
	try {
		// Only the live tip is finished; the source itself is never moved.
		const head = await resolveArtifactSourceHead(input.env, source.repo_id)
		if (head.commit !== publishedCommit) {
			return { ...withCommit, outcome: 'skipped_head_differs' }
		}
		const ownerUserId = source.user_id
		const sealed = await publishedPublishChecksAreCurrent({
			env: input.env,
			sourceId: source.id,
			publishedCommit,
		})
		const jobs = await jobsData(input.env).listJobsForUser({
			userId: ownerUserId,
		})
		const staleJobCount = jobs.filter(
			(row) =>
				row.source_id === source.id &&
				row.record.publishedCommit !== publishedCommit,
		).length
		const publishNoteFound = (
			await readPublishGitNoteFromArtifactsRepo({
				env: input.env,
				repoId: source.repo_id,
				commitOid: publishedCommit,
			})
		).found
		const sessionId = `admin-publish-resume-${source.id}`
		const state = { ...withCommit, sealed, staleJobCount, publishNoteFound }
		if (input.dryRun) {
			const { unbuiltCount } =
				await countUnbuiltPublishedPackageArtifactTargets({
					env: input.env,
					rpcSessionId: sessionId,
					sourceId: source.id,
					userId: ownerUserId,
					publishedCommit,
				})
			return {
				...state,
				unbuiltArtifactTargetCount: unbuiltCount,
				outcome:
					sealed &&
					staleJobCount === 0 &&
					publishNoteFound &&
					unbuiltCount === 0
						? 'complete'
						: 'incomplete',
			}
		}
		const result = await repoSessionRpc(
			input.env,
			sessionId,
		).publishFromExternalRef({
			sessionId,
			sourceId: source.id,
			userId: ownerUserId,
			newCommit: publishedCommit,
			expectedHead: publishedCommit,
			allowForce: false,
			baseUrl: input.baseUrl,
			rebuildPackageArtifacts: false,
			requestedByUserId: null,
			deferBundleCheckToRebuild: true,
			resumeFinalize: true,
		})
		if (result.status !== 'already_published') {
			return {
				...state,
				outcome: 'failed',
				error: `Resume returned ${result.status}${'message' in result && result.message ? `: ${result.message}` : ''}`,
			}
		}
		const rebuild = await rebuildPublishedPackageArtifactsViaRepoSession({
			env: input.env,
			rpcSessionId: sessionId,
			sourceId: source.id,
			userId: ownerUserId,
			publishedCommit,
			baseUrl: input.baseUrl,
			...(result.force_artifact_rebuild ? { force: true } : {}),
		})
		return {
			...state,
			outcome: 'resumed',
			rebuiltTargetCount: rebuild.rebuiltTargetCount,
		}
	} catch (error) {
		return { ...withCommit, outcome: 'failed', error: getErrorMessage(error) }
	}
}

export const adminPublishFinalizeResumeCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		destructive: true,
		name: 'adminPublishFinalizeResume',
		contextRuns: 'deny',
		description:
			'Finish an interrupted publish of the live published commit for specific saved packages: a publish that moved published_commit but died (Durable Object reset or CPU limit) before the credential stamp, package projection and job attribution, publish note, and bundle artifacts landed. Re-runs checks and those steps at the current published commit only; never moves the source or published_commit, and skips packages whose Artifacts HEAD differs. dryRun default is true (reports sealed, stale job count, whether the publish note exists, and unbuilt bundle artifact targets).',
		keywords: [
			'admin',
			'package',
			'publish',
			'resume',
			'finalize',
			'interrupted',
			'jobs',
			'publish note',
			'artifact',
			'rebuild',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const dryRun = args.dryRun !== false
			return auditAdminCapabilityInvocation(
				ctx,
				'adminPublishFinalizeResume',
				async () => {
					const outcomes: Array<Outcome> = []
					for (const packageId of args.packageIds) {
						outcomes.push(
							await resumePackage({
								env: ctx.env,
								baseUrl: ctx.callerContext.baseUrl,
								packageId,
								dryRun,
							}),
						)
					}
					return { dryRun, outcomes }
				},
				{
					successReason: (result) =>
						`dry_run=${result.dryRun};${result.outcomes.map((entry) => `${entry.packageId}=${entry.outcome}`).join(',')}`,
				},
			)
		},
	},
)
