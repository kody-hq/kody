import {
	optionalOrgAuditWriter,
	orgAuditCauseFromCaller,
} from '#worker/orgs/org-audit.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { z } from 'zod'
import { authorizePackageCreate } from '#worker/authorization/authorize.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
import { buildSavedPackageEmbedText } from '#worker/package-registry/embed.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { stampFirstSavedPackage } from '#worker/identity/activation-stamps.ts'
import { scheduleKitSubscriberSync } from '#worker/kit/subscriber-sync.ts'
import {
	getSavedPackageById,
	resolveSavedPackageRef,
	insertSavedPackage,
} from '#worker/package-registry/repo.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import { assertKodyDescriptionLength } from '#worker/package-registry/types.ts'
import { upsertSavedPackageVector } from '#worker/package-registry/vectorize.ts'
import {
	packageOwnerEntitlementEmail,
	resolvePackageOwnerContext,
} from '#worker/package-registry/package-owner.ts'
import { readPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { readArtifactFileAtCommit } from '#worker/repo/artifact-file.ts'
import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'
import {
	getEntitySourceById,
	updateEntitySource,
} from '#worker/repo/entity-sources.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { deleteUserRepo } from '#worker/repo/user-repos.ts'
import { publishCommunityListing } from '#worker/community/service.ts'
import { resolveOwnedUserRepo } from './resolve-user-repo.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

const repoIdentitySchema = z
	.object({
		repo_id: z.string().min(1).optional(),
		name: z.string().min(1).optional(),
	})
	.superRefine((value, ctx) => {
		const count =
			(value.repo_id !== undefined ? 1 : 0) + (value.name !== undefined ? 1 : 0)
		if (count !== 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['repo_id'],
				message: 'Provide exactly one of `repo_id` or `name`.',
			})
		}
	})

export const repoPromoteToPackageCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoPromoteToPackage',
		orgPermission: 'package:create',
		description:
			'Promote a package-shaped plain repo (root package.json at HEAD) into a saved package. Runs the full external-push publish checks; on success creates the saved-package projection and removes the plain-repo row.',
		keywords: ['repo', 'promote', 'package', 'activate'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: repoIdentitySchema,
		outputSchema: z.object({
			status: z.literal('promoted'),
			package_id: z.string(),
			kody_id: z.string(),
			name: z.string(),
			published_commit: z.string(),
			message: z.string().optional(),
		}),
		async handler(args, ctx) {
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user: requireMcpUser(ctx.callerContext),
				request: requireMcpRequest(ctx.callerContext),
			})
			await authorizePackageCreate({
				env: ctx.env,
				request: ctx.callerContext.request,
			})
			const { userRepo, source } = await resolveOwnedUserRepo({
				db: ctx.env.APP_DB,
				userId: owner.ownerUserId,
				args,
			})
			if (source.entity_kind !== 'repo') {
				const existingPackage = await getSavedPackageById(ctx.env.APP_DB, {
					userId: owner.ownerUserId,
					packageId: source.entity_id,
				})
				if (existingPackage) {
					throw new McpCallerError(
						`Plain repo "${userRepo.name}" was already promoted to saved package "${existingPackage.kodyId}".`,
					)
				}
				throw new McpCallerError(
					'This source is no longer a plain repo and cannot be promoted.',
				)
			}
			const head = await resolveArtifactSourceHead(ctx.env, source.repo_id)
			if (!head.commit) {
				throw new McpCallerError(
					`Plain repo "${userRepo.name}" has no commits yet. Add a root package.json and push before promoting.`,
				)
			}
			const packageJsonBytes = await readArtifactFileAtCommit({
				env: ctx.env,
				repoId: source.repo_id,
				commit: head.commit,
				filePath: 'package.json',
			})
			if (!packageJsonBytes) {
				throw new McpCallerError(
					`Plain repo "${userRepo.name}" is not package-shaped: root package.json was not found at HEAD.`,
				)
			}
			const packageScope = owner.ownerScope
			let manifest: ReturnType<typeof parseAuthoredPackageJson>
			try {
				manifest = parseAuthoredPackageJson({
					content: new TextDecoder().decode(packageJsonBytes),
					manifestPath: 'package.json',
					expectedPackageScope: packageScope,
				})
				assertKodyDescriptionLength(manifest.kody.description)
			} catch (error) {
				throw new McpCallerError(getErrorMessage(error), { cause: error })
			}
			const kodyIdCollision = await resolveSavedPackageRef(ctx.env.APP_DB, {
				userId: owner.ownerUserId,
				ref: manifest.kody.id,
				match: 'slug',
			})
			if (kodyIdCollision) {
				throw new McpCallerError(
					`A saved package with name leaf "${manifest.kody.id}" already exists. Change package.json#name in the repo before promoting.`,
				)
			}
			await assertWithinEntitlement({
				db: ctx.env.APP_DB,
				userId: owner.ownerUserId,
				email: packageOwnerEntitlementEmail(owner),
				resource: 'saved_packages',
			})
			const sessionId = `repo-promote-${source.id}-${crypto.randomUUID()}`
			const session = repoSessionRpc(ctx.env, sessionId)
			const opened = await session.openSession({
				sessionId,
				sourceId: source.id,
				userId: owner.ownerUserId,
				baseUrl: ctx.callerContext.baseUrl,
			})
			const checkRun = await session.runChecks({
				sessionId,
				userId: owner.ownerUserId,
				expectedPackageScope: packageScope,
			})
			if (!checkRun.ok) {
				await session
					.discardSession({ sessionId, userId: owner.ownerUserId })
					.catch(() => undefined)
				const failed = checkRun.results
					.filter((entry) => !entry.ok)
					.map((entry) => entry.message)
					.join('\n')
				throw new McpCallerError(
					failed || 'Publish checks failed for the package-shaped plain repo.',
				)
			}
			const packageId = crypto.randomUUID()
			const now = new Date().toISOString()
			await insertSavedPackage(
				ctx.env.APP_DB,
				{
					id: packageId,
					user_id: owner.ownerUserId,
					name: manifest.name,
					description: manifest.kody.description,
					tags_json: JSON.stringify(manifest.kody.tags ?? []),
					search_text: manifest.kody.searchText ?? null,
					source_id: source.id,
					has_app: manifest.kody.app !== undefined ? 1 : 0,
					has_skills: 0,
					hidden: 0,
					is_private: userRepo.isPrivate ? 1 : 0,
					created_at: now,
					updated_at: now,
				},
				null,
				{ stamp: false },
			)
			// Seed published_commit from the opened session base, not the
			// earlier HEAD snapshot. A git-lane push between those two reads
			// would otherwise seed the old commit and fail publish as
			// base_moved. A null pointer looks like "source has moved" even
			// though this is the first package publish.
			await updateEntitySource(ctx.env.APP_DB, {
				id: source.id,
				userId: owner.ownerUserId,
				entityKind: 'package',
				entityId: packageId,
				manifestPath: 'package.json',
				sourceRoot: source.source_root,
				publishedCommit: opened.base_commit || head.commit,
			})
			const revertFailedPromote = async () => {
				await ctx.env.APP_DB.prepare(
					`DELETE FROM saved_packages WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
				)
					.bind(owner.ownerUserId, packageId)
					.run()
				await updateEntitySource(ctx.env.APP_DB, {
					id: source.id,
					userId: owner.ownerUserId,
					entityKind: 'repo',
					entityId: userRepo.id,
					// Restore the exact pre-promotion columns so a failed promote
					// leaves the entity source byte-identical to its prior state.
					manifestPath: source.manifest_path,
					sourceRoot: source.source_root,
					publishedCommit: source.published_commit,
				})
				await session
					.discardSession({ sessionId, userId: owner.ownerUserId })
					.catch(() => undefined)
			}
			let publishResult: Awaited<ReturnType<typeof session.publishSession>>
			try {
				publishResult = await session.publishSession({
					sessionId,
					userId: owner.ownerUserId,
					expectedPackageScope: packageScope,
					// The package's first publish: there are no prior needs to change.
					credentialNeedsApproved: true,
					requestedByUserId: ctx.callerContext.user?.userId ?? null,
				})
			} catch (error) {
				// publishSession can throw before finalize (no KV snapshot yet)
				// or after finalize during session bookkeeping. Revert only when
				// the tip was never finalized. If finalize already wrote KV,
				// finish the promote happy path so we do not leave a package
				// that packageGet can load but promote cannot retry (#3497).
				const seededCommit = opened.base_commit || head.commit
				const liveSource = await getEntitySourceById(
					ctx.env.APP_DB,
					source.id,
				).catch(() => null)
				const finalizedCommit =
					liveSource?.published_commit?.trim() || seededCommit
				const finalizedSnapshot = await readPublishedSourceSnapshot({
					env: ctx.env,
					sourceId: source.id,
					publishedCommit: finalizedCommit,
				}).catch(() => null)
				if (!finalizedSnapshot) {
					await revertFailedPromote()
					throw error
				}
				console.error(
					'repo-promote-to-package-post-finalize-bookkeeping-failed',
					packageId,
					error,
				)
				publishResult = {
					status: 'ok',
					sessionId,
					publishedCommit: finalizedCommit,
					message:
						'Published session recovered after post-finalize bookkeeping failure.',
				}
			}
			if (publishResult.status !== 'ok') {
				await revertFailedPromote()
				throw new McpCallerError(
					publishResult.message || 'Failed to publish promoted package source.',
				)
			}
			const stamped = await stampFirstSavedPackage(
				ctx.env.APP_DB,
				{ stableUserId: owner.actorUserId, at: now },
				ctx.env,
			)
			if (stamped) {
				scheduleKitSubscriberSync({
					env: ctx.env,
					stableUserId: owner.actorUserId,
				})
			}
			// Best-effort projections after the publish committed: a vector or
			// search-projection failure must not strand a half-promoted repo.
			// Reindex lanes converge both later.
			await upsertSavedPackageVector(ctx.env, {
				packageId,
				userId: owner.ownerUserId,
				embedText: buildSavedPackageEmbedText(manifest),
			}).catch(() => undefined)
			await refreshSavedPackageProjection({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: owner.ownerUserId,
				actorUserId: owner.actorUserId,
				packageId,
				sourceId: source.id,
				firstPublish: true,
				audit: optionalOrgAuditWriter(
					ctx.env,
					ctx.callerContext.request ?? null,
					orgAuditCauseFromCaller(ctx.callerContext),
				),
			}).catch(() => undefined)
			// Listing is best-effort after publish committed: throwing here
			// would fail a successful promote, leave the plain-repo row, and
			// make retry report "already promoted". communityPublish retries
			// the catalog row for an already-public package.
			let listingMessage: string | undefined
			if (!userRepo.isPrivate) {
				try {
					await publishCommunityListing({
						env: ctx.env,
						baseUrl: ctx.callerContext.baseUrl,
						userId: owner.ownerUserId,
						actorUserId: owner.actorUserId,
						packageId,
					})
				} catch (error) {
					listingMessage = `Promoted to a public package, but listing on /community failed: ${getErrorMessage(error)}. Retry communityPublish for package_id ${packageId}.`
				}
			}
			await deleteUserRepo(ctx.env.APP_DB, {
				userId: owner.ownerUserId,
				repoId: userRepo.id,
			})
			return {
				status: 'promoted' as const,
				package_id: packageId,
				kody_id: manifest.kody.id,
				name: manifest.name,
				published_commit: publishResult.publishedCommit,
				...(listingMessage ? { message: listingMessage } : {}),
			}
		},
	},
)
