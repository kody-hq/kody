import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { toSecretCapabilityOutput } from '#mcp/capabilities/secrets/shared.ts'
import { listPackageSecretsByPackageIds } from '#mcp/secrets/service.ts'
import { applySavedPackageForkListingAncestry } from '#worker/community/fork-listing-relation.ts'
import {
	buildPendingCommunityForkLookupMessage,
	findPendingCommunityForkForLookup,
} from '#worker/community/pending-fork-lookup.ts'
import { describePackageCredentialNeeds } from '#worker/credentials/package-credential-needs.ts'
import { buildPackageSearchProjection } from '#worker/package-registry/manifest.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import { getSavedPackageWithCommunityProvenanceById } from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import {
	buildPlainRepoPromotionErrorMessage,
	findPlainRepoPromotionHint,
} from '#worker/repo/user-repos.ts'
import { authorize, packageResource } from '#worker/authorization/authorize.ts'
import { packageDetailSchema } from './shared.ts'

export const getPackageCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageGet',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description:
			'Load one saved package metadata record for the signed-in user, including community-fork source listing provenance, the full export array, callable export contracts, and FYI metadata for associated package-scoped secrets (names and package_id, never values), and its credential needs with how each resolves for you (`credentials.needs`). For a single export contract, prefer search({ entity: "package:{kodyId}#{subpath}" }). Does not return README, AGENTS.md, or source files; use repoOpenSession + repoReadFile (or packageGetGitRemote) for those.',
		keywords: ['package', 'get', 'read', 'metadata', 'exports', 'imports'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			package_id: z.string().min(1),
		}),
		outputSchema: packageDetailSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const request = requireMcpRequest(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request,
			})
			const loadedRecord = await getSavedPackageWithCommunityProvenanceById(
				ctx.env.APP_DB,
				{
					userId: owner.ownerUserId,
					packageId: args.package_id,
				},
			)
			const [saved] = loadedRecord
				? await applySavedPackageForkListingAncestry({
						env: ctx.env,
						records: [loadedRecord],
					})
				: [null]
			if (!saved) {
				const plainRepo = await findPlainRepoPromotionHint(ctx.env.APP_DB, {
					userId: owner.ownerUserId,
					packageIdOrKodyId: args.package_id,
				})
				if (plainRepo) {
					throw new McpCallerError(
						buildPlainRepoPromotionErrorMessage(args.package_id),
					)
				}
				const pendingFork = await findPendingCommunityForkForLookup(
					ctx.env.APP_DB,
					{
						forkerUserId: owner.ownerUserId,
						packageIdOrKodyId: args.package_id,
					},
				)
				if (pendingFork) {
					throw new McpCallerError(
						buildPendingCommunityForkLookupMessage({
							fork: pendingFork,
							ownerScope: owner.ownerScope,
						}),
					)
				}
				throw new McpCallerError('Saved package not found for this user.')
			}
			await authorize(
				{ env: ctx.env, request },
				'package:read',
				packageResource(saved),
			)
			const loaded = await loadPackageSourceBySourceId({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: owner.ownerUserId,
				sourceId: saved.sourceId,
			})
			const projection = buildPackageSearchProjection(
				loaded.manifest,
				loaded.files,
			)
			const packageSecretsById = await listPackageSecretsByPackageIds({
				env: ctx.env,
				userId: owner.ownerUserId,
				packageIds: [saved.id],
			})
			const packageSecrets = (packageSecretsById.get(saved.id) ?? []).map(
				(secret) => toSecretCapabilityOutput(secret),
			)
			const credentialNeeds = await describePackageCredentialNeeds({
				env: ctx.env,
				request,
				ownerUserId: owner.ownerUserId,
				sourceId: saved.sourceId,
				packageId: saved.id,
			})
			return {
				package_id: saved.id,
				kody_id: saved.kodyId,
				slug: saved.kodyId,
				name: saved.name,
				description: saved.description,
				tags: saved.tags,
				has_app: saved.hasApp,
				hidden: saved.hidden,
				visibility: saved.isPrivate
					? ('private' as const)
					: ('public' as const),
				internet_visible: saved.isInternetVisible,
				locked_at: saved.lockedAt ?? null,
				source_id: saved.sourceId,
				published_commit: loaded.source.published_commit ?? null,
				source_listing_id: saved.sourceListingId,
				listing_current: saved.listingCurrent,
				listing_kody_id: saved.listingKodyId,
				listing_name: saved.listingName,
				origin_commit: saved.originCommit,
				listing_pinned_commit: saved.listingPinnedCommit,
				listing_published_at: saved.listingPublishedAt,
				listing_ahead: saved.listingAhead,
				created_at: saved.createdAt,
				updated_at: saved.updatedAt,
				package_secrets: packageSecrets,
				credentials: { needs: credentialNeeds },
				exports: (projection.exports ?? []).map((exportDetail) => ({
					subpath: exportDetail.subpath,
					import_specifier: buildPackageImportSpecifier(
						saved.name,
						exportDetail.subpath,
					),
					runtime_target: exportDetail.runtimeTarget,
					types_path: exportDetail.typesPath,
					description: exportDetail.description,
					type_definition: exportDetail.typeDefinition,
					functions: (exportDetail.functions ?? []).map((exportedFunction) => ({
						name: exportedFunction.name,
						description: exportedFunction.description,
						type_definition: exportedFunction.typeDefinition,
					})),
					referenced_types: (exportDetail.referencedTypes ?? []).map(
						(referencedType) => ({
							name: referencedType.name,
							kind: referencedType.kind,
							definition: referencedType.definition,
						}),
					),
				})),
			}
		},
	},
)
