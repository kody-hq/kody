import { toJobView } from '@kody-internal/shared/jobs/schedule.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { invalidateCommunityPublicCache } from '#worker/app/data-cache.ts'
import { syncJobManagerAlarm } from '#worker/jobs/manager-client.ts'
import { deleteEntitySourceWithArtifacts } from '#worker/repo/entity-source-cleanup.ts'
import { mcpClientHubTransferStub } from '#worker/mcp-client/hub-transfer.ts'
import { type McpHubConnectResult } from '#worker/mcp-client/types.ts'
import { invalidateInvokeContractFreshness } from '#worker/package-invocations/invoke-contract-cache.ts'
import { refreshPackageSubscriptionTopicMap } from '#worker/package-invocations/subscription-topic-cache.ts'
import { buildSavedPackageEmbedText } from '#worker/package-registry/embed.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { scheduleSavedPackageSearchIndexUpsert } from '#worker/package-registry/search-index-debt.ts'
import { deleteAllPackageSkillsIndexEntriesForUser } from '#worker/package-registry/skills-index-cache.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { deleteSavedPackageVector } from '#worker/package-registry/vectorize.ts'
import {
	deleteAllPackageRetrieverCacheEntriesForUser,
	refreshPackageRetrieverManifestCache,
} from '#worker/package-retrievers/manifest-cache.ts'
import { deleteRepoSessionsBySourceForUser } from '#worker/repo/repo-sessions.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { deleteStorageBucketInventory } from '#worker/storage-buckets/service.ts'
import { buildJobEmbedText } from '#mcp/jobs-embed.ts'
import { deleteJobVector, upsertJobVector } from '#mcp/jobs-vectorize.ts'
import { countOrgTransferLeftovers } from './batch.ts'
import { type OrgTransferFinding } from './findings.ts'
import { type OrgTransferPlan } from './plan.ts'
import {
	describeOrgTransferMcpConnection,
	type OrgTransferMcpConnection,
	type OrgTransferPostCommitResult,
} from './post-commit-result.ts'
import { clearOwnerStorage } from './storage-copy.ts'

/**
 * Cleanup and reindex after the batch commits. The move itself is already
 * durable, so each step is best-effort: a failure becomes a warning naming
 * the step, never a rollback.
 */
export async function runOrgTransferPostCommit(input: {
	env: Env
	baseUrl: string
	plan: OrgTransferPlan
	cleanupOrphans: boolean
}): Promise<OrgTransferPostCommitResult> {
	const { env, plan } = input
	const fromId = plan.from.id
	const toId = plan.to.id
	const warnings: Array<OrgTransferFinding> = []
	const step = async (label: string, run: () => Promise<unknown>) => {
		try {
			await run()
		} catch (error) {
			warnings.push({
				code: 'post_commit_step_failed',
				message: `${label}: ${error instanceof Error ? error.message : String(error)}`,
				subject: label,
			})
		}
	}

	let leftovers: Record<string, number> = {}
	await step('leftover check', async () => {
		leftovers = await countOrgTransferLeftovers({ db: env.APP_DB, plan })
	})

	for (const copy of plan.storageCopies) {
		await step(`clear source storage ${copy.storageId}`, () =>
			clearOwnerStorage({ env, userId: fromId, storageId: copy.storageId }),
		)
	}
	const sourceHub = mcpClientHubTransferStub({ env, userId: fromId })
	const targetHub = mcpClientHubTransferStub({ env, userId: toId })
	// Close the source connection before dialing the target, so only one hub
	// can refresh (and rotate) the server's OAuth tokens.
	const mcpConnections: Array<OrgTransferMcpConnection> = []
	for (const row of plan.moves.mcp_server_settings) {
		const serverId = String(row['id'])
		const name = String(row['name'])
		let sourceRemoved = false
		await step(`remove source MCP server ${name}`, async () => {
			await sourceHub.removeServerForTransfer({ serverId })
			sourceRemoved = true
		})
		let result: McpHubConnectResult | null = null
		await step(`connect MCP server ${name}`, async () => {
			result = await targetHub.connectTransferredServer({ serverId })
		})
		mcpConnections.push(
			describeOrgTransferMcpConnection({
				serverId,
				name,
				sourceRemoved,
				result,
				appOrigin: input.baseUrl,
				toSlug: plan.to.slug,
			}),
		)
	}
	for (const copy of plan.logoCopies) {
		await step(`delete source logo ${copy.fromKey}`, () =>
			env.COMMUNITY_ASSETS.delete(copy.fromKey),
		)
	}
	if (input.cleanupOrphans) {
		for (const orphan of plan.orphans) {
			switch (orphan.cleanup) {
				case 'entity-source':
					await step(`delete orphan source ${orphan.key}`, () =>
						deleteEntitySourceWithArtifacts({
							env,
							userId: fromId,
							source: orphan.row as unknown as EntitySourceRow,
						}),
					)
					break
				case 'storage-bucket':
					await step(`delete orphan storage ${orphan.key}`, async () => {
						await clearOwnerStorage({
							env,
							userId: fromId,
							storageId: orphan.key,
						})
						await deleteStorageBucketInventory({
							db: env.APP_DB,
							userId: fromId,
							storageId: orphan.key,
						})
					})
					break
				// Already handled in the batch.
				case 'soft-delete':
				case 'delete':
					break
				default: {
					const exhaustive: never = orphan.cleanup
					throw new Error(`Unknown orphan cleanup: ${String(exhaustive)}`)
				}
			}
		}
	}
	for (const source of plan.moves.entity_sources) {
		await step(`discard repo sessions of source ${String(source['id'])}`, () =>
			deleteRepoSessionsBySourceForUser(env, {
				userId: fromId,
				sourceId: String(source['id']),
			}),
		)
	}

	for (const row of plan.moves.saved_packages) {
		const packageId = String(row['id'])
		const sourceId = String(row['source_id'])
		await step(`reindex package ${String(row['kody_id'])}`, async () => {
			await deleteSavedPackageVector(env, packageId)
			const loaded = await loadPackageManifestBySourceId({
				env,
				baseUrl: input.baseUrl,
				userId: toId,
				sourceId,
			})
			await scheduleSavedPackageSearchIndexUpsert({
				env,
				packageId,
				userId: toId,
				embedText: buildSavedPackageEmbedText(loaded.manifest),
			})
			const savedPackage = await getSavedPackageById(env.APP_DB, {
				userId: toId,
				packageId,
			})
			if (savedPackage && loaded.source.published_commit) {
				await refreshPackageRetrieverManifestCache({
					env,
					userId: toId,
					source: loaded.source,
					savedPackage,
					manifest: loaded.manifest,
				})
			}
		})
		invalidateInvokeContractFreshness({
			userId: fromId,
			packageIdOrKodyIds: [
				packageId,
				String(row['kody_id']),
				`kody:${String(row['name'])}`,
			],
			packageAppSlugs: [String(row['kody_id'])],
			sourceId,
		})
	}
	for (const job of plan.jobs) {
		await step(`reindex job ${job.record.name}`, async () => {
			const view = toJobView(job.record)
			await deleteJobVector(env, job.id)
			await upsertJobVector(env, {
				jobId: job.id,
				userId: toId,
				embedText: buildJobEmbedText({
					name: view.name,
					scheduleSummary: view.scheduleSummary,
					sourceId: view.sourceId,
					publishedCommit: view.publishedCommit,
				}),
			})
		})
	}

	await step('clear source retriever cache', () =>
		deleteAllPackageRetrieverCacheEntriesForUser({ env, userId: fromId }),
	)
	await step('clear source skills index', () =>
		deleteAllPackageSkillsIndexEntriesForUser({ env, userId: fromId }),
	)
	for (const ownerId of [fromId, toId] satisfies Array<OwnerId>) {
		await step(`refresh subscription topics for ${ownerId}`, () =>
			refreshPackageSubscriptionTopicMap({
				env,
				baseUrl: input.baseUrl,
				userId: ownerId,
			}),
		)
		await step(`sync job alarm for ${ownerId}`, () =>
			syncJobManagerAlarm({ env, userId: ownerId }),
		)
	}
	invalidateCommunityPublicCache()
	return { leftovers, warnings, mcpConnections }
}
