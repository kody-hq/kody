import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { authorizeRepoSessionPackageWrite } from './authorize-repo-session-package.ts'
import {
	buildPlainRepoPackageShapedFields,
	isPlainRepoPackageShapedAtCommit,
} from './plain-repo-package-shaped.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { getEntitySourceByIdForUser } from '#worker/repo/entity-sources.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	repoPublishSessionInputSchema,
	repoPublishSessionOutputSchema,
} from './repo-shared.ts'
import { rebuildPublishedPackageArtifactsViaRepoSession } from './package-artifact-rebuild.ts'
import { reportCapabilityProgress } from '#mcp/progress.ts'
import {
	buildPackagePublishApprovalUrl,
	createPackagePublishLockedMessage,
} from '#worker/package-registry/package-publish-lock.ts'
import { absorbCommunityForkUpstream } from '#worker/community/service.ts'
import { buildPackageCapabilityApprovalUrl } from '#worker/package-capabilities/capability-approval-url.ts'
import { createCredentialNeedsApprovalMessage } from '#worker/credentials/credential-needs-approval.ts'
import {
	bundlePausedPublishes,
	pausedPublishBundleMessage,
} from '#worker/approval-bundles/paused-publishes.ts'
import { optionalApprovalViewerForCaller } from '#mcp/capabilities/packages/approval-bundle-shared.ts'
import { CommunityActionError } from '#worker/community/errors.ts'

export const repoPublishSessionCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoPublishSession',
		contextRuns: 'deny',
		orgPermission: 'package:write',
		description:
			'Publish an active repo session back to the source repo after checks pass on the current tree and the base commit is still current. Visibility is a repo setting (`packageUpdate` / `repoUpdate`), not package.json#private. When publishing a community fork after absorbing origin updates, pass absorbed_upstream_commit.',
		keywords: ['repo', 'publish', 'session', 'checks', 'artifact'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: repoPublishSessionInputSchema,
		outputSchema: repoPublishSessionOutputSchema,
		async handler(args, ctx) {
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user: requireMcpUser(ctx.callerContext),
				request: requireMcpRequest(ctx.callerContext),
			})
			await authorizeRepoSessionPackageWrite({
				env: ctx.env,
				request: ctx.callerContext.request,
				userId: owner.ownerUserId,
				sessionId: args.session_id,
			})
			const session = repoSessionRpc(ctx.env, args.session_id)
			const sessionInfo = await session.getSessionInfo({
				sessionId: args.session_id,
				userId: owner.ownerUserId,
			})
			const isPackageSession = sessionInfo.entity_type === 'package'
			const progressTotal = isPackageSession ? 3 : 2
			await reportCapabilityProgress(ctx.reportProgress, {
				progress: 1,
				total: progressTotal,
				message:
					'Running publish checks on the session tree — lint, typecheck, the works…',
			})
			const result = await session.publishSession({
				sessionId: args.session_id,
				userId: owner.ownerUserId,
				requestedByUserId: ctx.callerContext.user?.userId ?? null,
				rebuildPackageArtifacts: false,
				expectedPackageScope: isPackageSession ? owner.ownerScope : undefined,
				privateVisibilityChangeConfirmed:
					args.confirm_private_visibility_change,
			})
			if (result.status === 'ok') {
				if (isPackageSession) {
					await reportCapabilityProgress(ctx.reportProgress, {
						progress: 2,
						total: progressTotal,
						message:
							'Rebuilding published package artifacts — bundling for the big leagues…',
					})
					await rebuildPublishedPackageArtifactsViaRepoSession({
						env: ctx.env,
						rpcSessionId: args.session_id,
						repoSessionId: args.session_id,
						sourceId: sessionInfo.source_id,
						userId: owner.ownerUserId,
						publishedCommit: result.publishedCommit,
						baseUrl: ctx.callerContext.baseUrl,
					})
					const absorbNotice = args.absorbed_upstream_commit
						? await absorbForkUpstreamAfterPublish({
								env: ctx.env,
								userId: owner.ownerUserId,
								sourceId: sessionInfo.source_id,
								originCommit: args.absorbed_upstream_commit,
							})
						: null
					await reportCapabilityProgress(ctx.reportProgress, {
						progress: 3,
						total: progressTotal,
						message: 'Repo session published. Ship it.',
					})
					return {
						status: 'ok' as const,
						session_id: result.sessionId,
						published_commit: result.publishedCommit,
						message: result.message,
						...(absorbNotice ? { notice: absorbNotice } : {}),
					}
				}
				const source = await getEntitySourceByIdForUser(ctx.env.APP_DB, {
					id: sessionInfo.source_id,
					userId: owner.ownerUserId,
				})
				const packageShaped = source
					? await isPlainRepoPackageShapedAtCommit({
							env: ctx.env,
							repoId: source.repo_id,
							commit: result.publishedCommit,
						})
					: false
				const shapedFields = buildPlainRepoPackageShapedFields({
					packageShaped,
				})
				await reportCapabilityProgress(ctx.reportProgress, {
					progress: progressTotal,
					total: progressTotal,
					message: 'Repo session published. Ship it.',
				})
				return {
					status: 'ok' as const,
					session_id: result.sessionId,
					published_commit: result.publishedCommit,
					message: result.message,
					...shapedFields,
				}
			}
			if (result.status === 'locked') {
				const savedPackage = await getSavedPackageById(ctx.env.APP_DB, {
					userId: owner.ownerUserId,
					packageId: result.packageId,
				})
				if (!savedPackage) {
					throw new Error('Locked package was not found.')
				}
				const approvalUrl = buildPackagePublishApprovalUrl({
					baseUrl: ctx.callerContext.baseUrl,
					username: owner.ownerScope,
					kodyId: savedPackage.kodyId,
					commit: result.pendingCommit,
				})
				const lockedMessage = createPackagePublishLockedMessage({
					packageName: result.packageName,
					approvalUrl,
				})
				await reportCapabilityProgress(ctx.reportProgress, {
					progress: progressTotal,
					total: progressTotal,
					message: 'This package is locked — approve the publish in the app.',
				})
				return {
					status: 'locked' as const,
					session_id: result.sessionId,
					published_commit: null,
					pending_commit: result.pendingCommit,
					current_published_commit: result.currentPublishedCommit,
					approval_url: approvalUrl,
					message: result.credentialNotice
						? `${lockedMessage}\n\n${result.credentialNotice}`
						: lockedMessage,
				}
			}
			if (result.status === 'approval_required') {
				const approvalUrl = buildPackageCapabilityApprovalUrl({
					baseUrl: ctx.callerContext.baseUrl,
					username: owner.ownerScope,
					kodyId: result.approval.kodyId,
				})
				const bundle = await bundlePausedPublishes({
					viewer: optionalApprovalViewerForCaller(ctx),
					ownerUserId: owner.ownerUserId,
				})
				const needsMessage = createCredentialNeedsApprovalMessage({
					packageName: result.approval.packageName,
					changes: result.approval.changes,
					approvalUrl,
				})
				const approvalMessage = bundle
					? `${needsMessage} ${pausedPublishBundleMessage(bundle)}`
					: needsMessage
				await reportCapabilityProgress(ctx.reportProgress, {
					progress: progressTotal,
					total: progressTotal,
					message:
						'Credential needs changed — the owner approves this publish in the app.',
				})
				return {
					status: 'approval_required' as const,
					session_id: result.sessionId,
					published_commit: null,
					pending_commit: result.approval.pendingCommit,
					current_published_commit: result.currentPublishedCommit,
					approval_url: approvalUrl,
					...(bundle ? { approval_bundle_url: bundle.url } : {}),
					credential_need_changes: result.approval.changes,
					message: result.credentialNotice
						? `${approvalMessage}\n\n${result.credentialNotice}`
						: approvalMessage,
				}
			}
			if (result.status === 'checks_outdated') {
				await reportCapabilityProgress(ctx.reportProgress, {
					progress: progressTotal,
					total: progressTotal,
					message:
						'Publish checks are stale — refresh the session tree and try again.',
				})
				return {
					status: 'checks_outdated' as const,
					session_id: result.sessionId,
					published_commit: null,
					message: result.message,
				}
			}
			await reportCapabilityProgress(ctx.reportProgress, {
				progress: progressTotal,
				total: progressTotal,
				message:
					'The published base moved out from under this session — rebase, then retry.',
			})
			return {
				status: 'base_moved' as const,
				session_id: result.sessionId,
				published_commit: null,
				message: result.message,
				repair_hint: result.repairHint,
				session_base_commit: result.sessionBaseCommit,
				current_published_commit: result.currentPublishedCommit,
			}
		},
	},
)

async function absorbForkUpstreamAfterPublish(input: {
	env: Env
	userId: OwnerId
	sourceId: string
	originCommit: string
}) {
	const source = await getEntitySourceByIdForUser(input.env.APP_DB, {
		id: input.sourceId,
		userId: input.userId,
	})
	if (!source) {
		return 'Published, but absorb could not find the package source for this session. Retry repoPublishSession with absorbed_upstream_commit.'
	}
	try {
		await absorbCommunityForkUpstream({
			env: input.env,
			userId: input.userId,
			packageId: source.entity_id,
			originCommit: input.originCommit,
		})
		return null
	} catch (error) {
		if (
			error instanceof CommunityActionError &&
			error.message.includes('self-authored')
		) {
			return null
		}
		return `Published, but the behind-upstream banner did not clear: ${getErrorMessage(error)}. Retry repoPublishSession with absorbed_upstream_commit.`
	}
}
