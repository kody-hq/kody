import {
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	createdPackageResources,
	grantCreatorAccess,
} from '#worker/orgs/creator-access.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { parseTagsJson } from '@kody-internal/shared/tags-json.ts'
import * as Sentry from '@sentry/cloudflare'
import { invalidateCommunityPublicCache } from '#app/data-cache.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	deletePackageSlugRedirects,
	listPackageSlugRedirects,
	releasePackageSlugRedirect,
	retirePackageSlug,
} from '#worker/community/package-url.ts'
import {
	deleteCommunityForksForPackage,
	getCommunityListingByOwnerAndPackage,
} from '#worker/community/repo.ts'
import { unpublishCommunityListing } from '#worker/community/service.ts'
import { buildSavedPackageEmbedText } from './embed.ts'
import { buildPackageSearchProjection } from './manifest.ts'
import { getPackageNameLeaf } from './package-name.ts'
import {
	deleteSavedPackage,
	getSavedPackageById,
	insertSavedPackage,
	updateSavedPackage,
} from './repo.ts'
import {
	loadPackageManifestBySourceId,
	loadPackageSourceBySourceId,
	loadPackageSourceFromFiles,
} from './source.ts'
import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
	type SavedPackageRow,
} from './types.ts'
import { deleteSavedPackageVector } from './vectorize.ts'
import { scheduleSavedPackageSearchIndexUpsert } from './search-index-debt.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { jobAuditActions, recordJobAudit } from '#worker/jobs/job-audit.ts'
import { type OrgAuditWriter } from '#worker/orgs/org-audit.ts'
import { packageAuditActions, recordPackageAudit } from './package-audit.ts'
import { stampFirstSavedPackage } from '#worker/identity/activation-stamps.ts'
import { scheduleKitSubscriberSync } from '#worker/kit/subscriber-sync.ts'
import { syncJobManagerAlarm } from '#worker/jobs/manager-client.ts'
import { rebuildPublishedPackageArtifacts } from '#worker/package-runtime/published-bundle-artifacts.ts'
import { type PreparedKodyGraphCache } from '#worker/package-runtime/module-graph.ts'
import {
	buildPackageSkillsIndex,
	collectPackageSkills,
} from '#worker/package-registry/package-skills.ts'
import {
	removePackageSkillsIndexEntries,
	writePackageSkillsIndex,
} from '#worker/package-registry/skills-index-cache.ts'
import { invalidateInvokeContractFreshness } from '#worker/package-invocations/invoke-contract-cache.ts'
import { refreshPackageSubscriptionTopicMap } from '#worker/package-invocations/subscription-topic-cache.ts'
import { cleanupArtifactReposForPackage } from '#worker/repo/artifact-repo-cleanup.ts'
import { deleteEntitySource } from '#worker/repo/entity-sources.ts'
import {
	assertWithinEntitlement,
	assertWithinStorageBytesEntitlement,
	estimateEntitlementStorageEntryByteDelta,
} from '#worker/entitlements/service.ts'
import {
	deleteAllPackageScopedSecrets,
	removeAllSecretApprovalsForPackage,
} from '#worker/package-config-cleanup.ts'
import { listUserStorageBucketIds } from '#worker/storage-buckets/service.ts'
import {
	buildPackageStorageId,
	isPackageOwnedStorageId,
} from '#worker/storage-ids.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { deleteCredentialMappingsForPackage } from '#worker/credentials/credential-mappings.ts'

const packageStorageClearAttempts = 3

export class PackageStorageCleanupError extends Error {
	readonly failedStorageIds: ReadonlyArray<string>

	constructor(failedStorageIds: ReadonlyArray<string>) {
		super(
			`Package storage cleanup failed for ${failedStorageIds.length} bucket(s); the package was not deleted. Retry after storage is reachable.`,
		)
		this.name = 'PackageStorageCleanupError'
		this.failedStorageIds = failedStorageIds
	}
}

function logPackageSkillsProjectionError(input: {
	action: 'refresh' | 'delete'
	packageId: string
	error: unknown
}) {
	console.error(
		JSON.stringify({
			message: 'package skills projection update failed',
			action: input.action,
			packageId: input.packageId,
		}),
	)
	Sentry.captureException(input.error, {
		tags: {
			scope: 'package-skills-projection',
			action: input.action,
		},
		extra: {
			packageId: input.packageId,
		},
	})
}

function serializeTags(tags: Array<string>) {
	return JSON.stringify(tags)
}

/**
 * Inventory prefix matching is UUID-gated on purpose. `packageSave` accepts
 * arbitrary non-empty package ids, so a raw prefix like `{packageId}:` can
 * collide with reserved storage namespaces (`job:`, `exec:`, …) or carry LIKE
 * metacharacters (`%`, `_`; `encodeURIComponent` can also introduce `%`). A
 * UUID cannot contain `:` or those metacharacters and cannot equal the reserved
 * namespace literals, which makes `{uuid}:…` and
 * `job:package-job:{uuid}:…` unambiguous. Non-UUID packages still clear the
 * deterministic package bucket and raw id; an orphaned facet bucket for a
 * non-UUID id stays inventoriable for account deletion.
 */
export function filterPackageOwnedStorageIdsFromInventory(input: {
	packageId: string
	storageIds: ReadonlyArray<string>
}): Array<string> {
	const matched = new Set<string>()
	for (const storageId of input.storageIds) {
		if (isPackageOwnedStorageId({ packageId: input.packageId, storageId })) {
			matched.add(storageId)
		}
	}
	return [...matched]
}

async function listPackageOwnedStorageIdsFromInventory(input: {
	env: Env
	userId: OwnerId
	packageId: string
}): Promise<Array<string>> {
	const storageIds = await listUserStorageBucketIds({
		env: input.env,
		userId: input.userId,
	})
	return filterPackageOwnedStorageIdsFromInventory({
		packageId: input.packageId,
		storageIds,
	})
}

export async function clearPackageOwnedStorageBucket(input: {
	env: Env
	userId: OwnerId
	packageId: string
	storageId: string
}): Promise<boolean> {
	let storageCleared = false
	let lastClearError: unknown
	for (let attempt = 1; attempt <= packageStorageClearAttempts; attempt++) {
		try {
			await storageRunnerRpc({
				env: input.env,
				userId: input.userId,
				storageId: input.storageId,
			}).clearStorage()
			storageCleared = true
			break
		} catch (error) {
			lastClearError = error
		}
	}
	if (!storageCleared) {
		console.warn(
			JSON.stringify({
				message: 'package storage clear failed',
				userId: input.userId,
				packageId: input.packageId,
				storageId: input.storageId,
				attempts: packageStorageClearAttempts,
				error: getErrorMessage(lastClearError),
			}),
		)
		return false
	}
	try {
		await input.env.APP_DB.prepare(
			`DELETE FROM user_storage_buckets WHERE user_id = ? AND storage_id = ?${andLiveDeletedAtSql()}`,
		)
			.bind(input.userId, input.storageId)
			.run()
		return true
	} catch (error) {
		console.warn(
			JSON.stringify({
				message: 'package storage bucket unregister failed',
				userId: input.userId,
				packageId: input.packageId,
				storageId: input.storageId,
				error: getErrorMessage(error),
			}),
		)
		return false
	}
}

function toSavedPackageInsertRow(input: {
	packageId: string
	userId: OwnerId
	sourceId: string
	manifest: AuthoredPackageJson
	hasSkills?: boolean
}): Omit<
	SavedPackageRow,
	'created_at' | 'updated_at' | 'locked_at' | 'is_internet_visible'
> {
	const projection = buildPackageSearchProjection(input.manifest)
	return {
		id: input.packageId,
		user_id: input.userId,
		name: projection.name,
		// Leftover column; insert/update derive the same leaf from `name`.
		kody_id: getPackageNameLeaf(projection.name),
		description: projection.description,
		tags_json: serializeTags(projection.tags),
		search_text: projection.searchText,
		source_id: input.sourceId,
		has_app: projection.hasApp ? 1 : 0,
		has_skills: input.hasSkills ? 1 : 0,
		hidden: 0,
		is_private: 1,
	}
}

export async function refreshSavedPackageProjection(input: {
	env: Env
	baseUrl: string
	userId: OwnerId
	actorUserId?: PersonId
	userEmail?: string | null
	packageId: string
	sourceId: string
	rebuildArtifacts?: boolean
	/**
	 * When the caller already holds the published file set (one-click install
	 * just forked these into the source), skip the KV/Artifacts reload.
	 */
	sourceFiles?: Record<string, string>
	waitUntil?: (promise: Promise<unknown>) => void
	/** Records `package.published`. Codemod refreshes pass null. */
	audit: OrgAuditWriter | null
	/**
	 * Whether this publish creates the package. Callers that insert the saved
	 * package row before refreshing must pass it, since the row then exists.
	 */
	firstPublish?: boolean
	/**
	 * Who created the package. A first publish grants them access to it
	 * (members with only `package:create` hold nothing on it otherwise).
	 */
	creatorUserId?: string | null
}) {
	// Filled inside the write lease, audited after it commits.
	const pending: {
		published: { name: string; first: boolean; fields: Array<string> } | null
	} = { published: null }
	// Audit in finally: a later step in the lease can throw after the row
	// committed, and a retry would then not see this publish as new.
	try {
		return await withAccountWriteLease({
			db: input.env.APP_DB,
			stableUserId: input.userId,
			env: input.env,
			async write() {
				const shouldRebuildArtifacts = input.rebuildArtifacts ?? true
				const loaded = input.sourceFiles
					? await loadPackageSourceFromFiles({
							env: input.env,
							userId: input.userId,
							sourceId: input.sourceId,
							files: input.sourceFiles,
						})
					: shouldRebuildArtifacts
						? await loadPackageSourceBySourceId({
								env: input.env,
								baseUrl: input.baseUrl,
								userId: input.userId,
								sourceId: input.sourceId,
							})
						: await loadPackageManifestBySourceId({
								env: input.env,
								baseUrl: input.baseUrl,
								userId: input.userId,
								sourceId: input.sourceId,
							})
				const existing = await getSavedPackageById(input.env.APP_DB, {
					userId: input.userId,
					packageId: input.packageId,
				})
				const loadedFilesForSkills: Record<string, string> | null =
					input.sourceFiles ??
					('files' in loaded ? (loaded.files as Record<string, string>) : null)
				const collectedSkills = loadedFilesForSkills
					? await collectPackageSkills({
							files: loadedFilesForSkills,
							// Scoped package.json name (`@owner/slug`), not the leaf kody.id.
							kodyId: loaded.manifest.name,
						})
					: null
				const hasSkills =
					collectedSkills !== null
						? collectedSkills.length > 0
						: (existing?.hasSkills ?? false)
				const row = toSavedPackageInsertRow({
					packageId: input.packageId,
					userId: input.userId,
					sourceId: input.sourceId,
					manifest: loaded.manifest,
					hasSkills,
				})
				await assertWithinStorageBytesEntitlement({
					db: input.env.APP_DB,
					env: input.env,
					userId: input.userId,
					email: input.userEmail,
					requested: estimateEntitlementStorageEntryByteDelta({
						next: {
							key: row.id,
							value: {
								name: row.name,
								kodyId: row.kody_id,
								description: row.description,
								tagsJson: row.tags_json,
								searchText: row.search_text,
								sourceId: row.source_id,
							},
						},
						existing: existing
							? {
									key: existing.id,
									value: {
										name: existing.name,
										kodyId: existing.kodyId,
										description: existing.description,
										tagsJson: JSON.stringify(existing.tags),
										searchText: existing.searchText,
										sourceId: existing.sourceId,
									},
								}
							: null,
					}),
				})
				// Team packages are owned by the org (`userId`); the acting person
				// gets the first-package stamp and Kit "activated" tag. Actor-free
				// projection refreshes (publish, codemod) must not stamp anyone.
				const activationUserId = input.actorUserId ?? input.userId
				if (existing) {
					await updateSavedPackage(input.env.APP_DB, {
						userId: input.userId,
						packageId: input.packageId,
						name: row.name,
						description: row.description,
						tagsJson: row.tags_json,
						searchText: row.search_text,
						sourceId: row.source_id,
						hasApp: row.has_app === 1,
						hasSkills: row.has_skills === 1,
						audit: null,
					})
					// The name leaf is the second half of the package's canonical URL,
					// so renaming the package moves that URL. Retire the old slug here
					// rather than in the community layer: the slug belongs to the
					// package whether or not it is published.
					await retirePackageSlug({
						db: input.env.APP_DB,
						userId: input.userId,
						packageId: input.packageId,
						oldSlug: getPackageNameLeaf(existing.name),
						newSlug: getPackageNameLeaf(row.name),
					})
					// A member's first save can be an update to an existing team
					// package. Personal saves already stamped on insert; this only
					// claims when an actor is present and still unstamped.
					if (input.actorUserId) {
						const stamped = await stampFirstSavedPackage(
							input.env.APP_DB,
							{ stableUserId: input.actorUserId },
							input.env,
						)
						if (stamped) {
							scheduleKitSubscriberSync({
								env: input.env,
								stableUserId: input.actorUserId,
							})
						}
					}
				} else {
					await assertWithinEntitlement({
						db: input.env.APP_DB,
						userId: input.userId,
						email: input.userEmail,
						resource: 'saved_packages',
					})
					const stamped = await insertSavedPackage(
						input.env.APP_DB,
						row,
						input.env,
						{ actorUserId: input.actorUserId },
					)
					if (stamped) {
						scheduleKitSubscriberSync({
							env: input.env,
							stableUserId: activationUserId,
							...(activationUserId === input.userId
								? { email: input.userEmail }
								: {}),
						})
					}
					// A brand new package claims its slug outright, so an earlier
					// package's retirement row must not keep forwarding it elsewhere.
					await releasePackageSlugRedirect({
						db: input.env.APP_DB,
						userId: input.userId,
						slug: getPackageNameLeaf(row.name),
					})
				}
				const refreshedAt = new Date().toISOString()
				pending.published = {
					name: row.name,
					first: input.firstPublish ?? existing == null,
					fields: existing
						? [
								...(existing.name === row.name ? [] : ['name']),
								...(existing.description === row.description
									? []
									: ['description']),
							]
						: [],
				}
				const savedPackage = {
					id: input.packageId,
					userId: input.userId,
					name: row.name,
					kodyId: row.kody_id,
					description: row.description,
					tags: parseTagsJson(row.tags_json),
					searchText: row.search_text ?? null,
					sourceId: row.source_id,
					hasApp: row.has_app === 1,
					hasSkills: row.has_skills === 1,
					// Preserve visibility across projection refresh / re-save.
					hidden: existing?.hidden ?? false,
					// Visibility is a repo setting, not a manifest field.
					isPrivate: existing?.isPrivate ?? true,
					isInternetVisible: existing?.isInternetVisible ?? false,
					// Website lock is not a projection field; keep the stored timestamp.
					lockedAt: existing?.lockedAt ?? null,
					createdAt: existing?.createdAt ?? refreshedAt,
					updatedAt: refreshedAt,
				} satisfies SavedPackageRecord
				const loadedFiles: Record<string, string> | null =
					shouldRebuildArtifacts
						? (input.sourceFiles ??
							('files' in loaded
								? (loaded.files as Record<string, string>)
								: null))
						: null
				if (loadedFiles) {
					// Artifacts stay on the hot path: invoke needs them immediately
					// and there is no safe cold-build substitute for a fresh publish.
					const prepareCache: PreparedKodyGraphCache = new Map()
					await rebuildPublishedPackageArtifacts({
						env: input.env,
						userId: input.userId,
						source: loaded.source,
						savedPackage,
						manifest: loaded.manifest,
						buildAppBundle: async ({ entryPoint }) => {
							const { buildKodyAppBundle } =
								await import('#worker/package-runtime/module-graph.ts')
							return await buildKodyAppBundle({
								env: input.env,
								baseUrl: input.baseUrl,
								userId: input.userId,
								sourceFiles: loadedFiles,
								entryPoint,
								rootPackageId: savedPackage.id,
								cacheKey: null,
								prepareCache,
							})
						},
						buildAppClientBundle: async ({ entryPoint }) => {
							const { buildKodyAppClientBundle } =
								await import('#worker/package-runtime/module-graph.ts')
							return await buildKodyAppClientBundle({
								sourceFiles: loadedFiles,
								entryPoint,
							})
						},
						buildModuleBundle: async ({ entryPoint }) => {
							const { buildKodyModuleBundle } =
								await import('#worker/package-runtime/module-graph.ts')
							return await buildKodyModuleBundle({
								env: input.env,
								baseUrl: input.baseUrl,
								userId: input.userId,
								sourceFiles: loadedFiles,
								entryPoint,
								rootPackageId: savedPackage.id,
								prepareCache,
							})
						},
						buildImportableModuleBundle: async ({ entryPoint }) => {
							const { buildKodyImportableModuleBundle } =
								await import('#worker/package-runtime/module-graph.ts')
							return await buildKodyImportableModuleBundle({
								env: input.env,
								baseUrl: input.baseUrl,
								userId: input.userId,
								sourceFiles: loadedFiles,
								entryPoint,
								rootPackageId: savedPackage.id,
								prepareCache,
							})
						},
					})
				}
				// Vector upsert is searchable but not needed for the publish
				// response. Defer via waitUntil with durable debt + Sentry so a
				// failure cannot leave search silently stale.
				await scheduleSavedPackageSearchIndexUpsert({
					env: input.env,
					packageId: input.packageId,
					userId: input.userId,
					embedText: buildSavedPackageEmbedText(loaded.manifest),
					waitUntil: input.waitUntil,
				})
				const skillsIndexTask = (async () => {
					if (collectedSkills === null) return
					const publishedCommit = loaded.source?.published_commit
					if (!publishedCommit) return
					await writePackageSkillsIndex({
						env: input.env,
						userId: input.userId,
						index: {
							...buildPackageSkillsIndex({
								packageId: input.packageId,
								// Scoped package.json name (`@owner/slug`) for skill:// URIs.
								kodyId: savedPackage.name,
								publishedCommit,
								skills: collectedSkills,
							}),
							...(input.audit?.actorUsername
								? { publishedBy: input.audit.actorUsername }
								: {}),
							publishedAt: refreshedAt,
						},
					})
				})().catch((error: unknown) => {
					logPackageSkillsProjectionError({
						action: 'refresh',
						packageId: input.packageId,
						error,
					})
				})
				if (input.waitUntil) {
					input.waitUntil(skillsIndexTask)
				} else {
					await skillsIndexTask
				}
				const { syncPackageJobsForPackage } =
					await import('#worker/jobs/service.ts')
				const schedulerStateChanged = await syncPackageJobsForPackage({
					env: input.env,
					userId: input.userId,
					baseUrl: input.baseUrl,
					packageId: input.packageId,
					sourceId: input.sourceId,
					manifest: loaded.manifest,
					actorUserId: input.actorUserId,
				})
				if (schedulerStateChanged) {
					await syncJobManagerAlarm({
						env: input.env,
						userId: input.userId,
					})
				}
				// Same-isolate invoke paths must observe this refresh immediately;
				// other isolates converge within the freshness-cache TTL.
				const retiredPackageAppSlugs = await listPackageSlugRedirects({
					db: input.env.APP_DB,
					userId: input.userId,
					packageId: input.packageId,
				})
				invalidateInvokeContractFreshness({
					userId: input.userId,
					packageIdOrKodyIds: [
						input.packageId,
						row.kody_id,
						`kody:${savedPackage.name}`,
						...(existing && existing.kodyId !== row.kody_id
							? [existing.kodyId]
							: []),
						...(existing && existing.name !== savedPackage.name
							? [`kody:${existing.name}`]
							: []),
					],
					// Package-app slug cache is keyed by name leaf, not package id /
					// kody:@ refs. Include every retired redirect leaf (multi-hop
					// renames) so a warm isolate cannot keep serving an older path
					// after an intermediate slug is reclaimed.
					packageAppSlugs: [
						getPackageNameLeaf(savedPackage.name),
						...(existing ? [getPackageNameLeaf(existing.name)] : []),
						...retiredPackageAppSlugs,
					],
					sourceId: input.sourceId,
				})
				// Prefer a normalized source of truth (manifests) plus this KV cache of
				// computed topic→package ids. Delete-then-recompute so a failed rewrite
				// cannot leave wakes matching a pre-publish map (no TTL).
				try {
					await refreshPackageSubscriptionTopicMap({
						env: input.env,
						baseUrl: input.baseUrl,
						userId: input.userId,
					})
				} catch (error) {
					console.warn('package-subscription-topic-map-refresh-failed', {
						userId: input.userId,
						packageId: input.packageId,
						action: 'publish',
						error,
					})
				}
				return {
					record: savedPackage,
					manifest: loaded.manifest,
					...(loadedFiles ? { files: loadedFiles } : {}),
				}
			},
		})
	} finally {
		const { published } = pending
		if (published) {
			await recordPackageAudit(input.audit, {
				orgId: input.userId,
				packageId: input.packageId,
				name: published.name,
				action: packageAuditActions.published,
				details: { firstPublish: published.first, fields: published.fields },
			})
			if (published.first) {
				// The publish is stored; a missed grant is repaired by
				// adminCreatorAccessBackfill, so it must not fail the publish.
				await grantCreatorAccess({
					env: input.env,
					orgId: input.userId,
					creatorUserId: input.creatorUserId,
					audit: input.audit,
					resources: createdPackageResources(input.packageId),
				}).catch((error: unknown) => {
					Sentry.captureException(error, {
						tags: { context: 'package-creator-grant' },
					})
				})
			}
		}
	}
}

export async function deleteSavedPackageProjection(input: {
	env: Env
	userId: OwnerId
	packageId: string
	actorUserId?: string
	/** Records `package.deleted` and `job.deleted` for its jobs. */
	audit: OrgAuditWriter | null
}) {
	// Filled inside the write lease, audited after it commits.
	const removed: {
		package: { name: string } | null
		jobs: Array<{ id: string; name: string }>
	} = { package: null, jobs: [] }
	// Audit in finally: cleanup after the delete commits can throw, and a
	// retry would then find no package to audit.
	try {
		return await withAccountWriteLease({
			db: input.env.APP_DB,
			stableUserId: input.userId,
			env: input.env,
			async write() {
				const savedPackage = await getSavedPackageById(input.env.APP_DB, {
					userId: input.userId,
					packageId: input.packageId,
				})
				const packageOwnedStorageIds = new Set<string>([
					buildPackageStorageId(input.packageId),
					input.packageId,
				])
				let packageJobRows: Array<{
					id: string
					name: string
					storage_id?: string | null
				}> = []
				if (savedPackage) {
					const jobs = jobsData(input.env)
					const existingRows = await jobs.listJobsForUser({
						userId: input.userId,
					})
					packageJobRows = existingRows.filter(
						(row) => row.source_id === savedPackage.sourceId,
					)
					for (const row of packageJobRows) {
						if (row.storage_id) {
							packageOwnedStorageIds.add(row.storage_id)
						}
					}
				}
				try {
					const inventoryIds = await listPackageOwnedStorageIdsFromInventory({
						env: input.env,
						userId: input.userId,
						packageId: input.packageId,
					})
					for (const storageId of inventoryIds) {
						packageOwnedStorageIds.add(storageId)
					}
				} catch (error) {
					console.warn(
						JSON.stringify({
							message: 'package storage inventory lookup failed',
							userId: input.userId,
							packageId: input.packageId,
							error: getErrorMessage(error),
						}),
					)
					// Fail closed: an incomplete inventory must not let delete proceed
					// while inventory-only buckets stay uncleared.
					throw new PackageStorageCleanupError([
						`storage-inventory:${input.packageId}`,
					])
				}
				// Clear owned buckets before irreversible source/job/listing work so a
				// failed clear leaves a still-usable package (and package:<id> ACL).
				const failedStorageIds: Array<string> = []
				for (const storageId of packageOwnedStorageIds) {
					const cleared = await clearPackageOwnedStorageBucket({
						env: input.env,
						userId: input.userId,
						packageId: input.packageId,
						storageId,
					})
					if (!cleared) failedStorageIds.push(storageId)
				}
				if (failedStorageIds.length > 0) {
					throw new PackageStorageCleanupError(failedStorageIds)
				}
				if (savedPackage) {
					const listing = await getCommunityListingByOwnerAndPackage(
						input.env.APP_DB,
						{
							ownerUserId: input.userId,
							packageId: input.packageId,
						},
					)
					if (listing?.status === 'active') {
						await unpublishCommunityListing({
							env: input.env,
							userId: input.userId,
							actorUserId: input.actorUserId ?? input.userId,
							listingId: listing.id,
						})
					}
				}
				// Drop fork metadata before later cleanup so a later failure cannot
				// leave "Fork outdated" on community listings after the package is
				// gone. D1 triggers on saved_packages / entity_sources are the
				// cascade backstop if a future path skips this call.
				const deletedForks = await deleteCommunityForksForPackage(
					input.env.APP_DB,
					{
						userId: input.userId,
						packageId: input.packageId,
						sourceId: savedPackage?.sourceId,
					},
				)
				if (deletedForks > 0) {
					invalidateCommunityPublicCache()
				}
				if (savedPackage) {
					await cleanupArtifactReposForPackage({
						env: input.env,
						userId: input.userId,
						sourceId: savedPackage.sourceId,
					}).catch((error) => {
						console.warn(
							JSON.stringify({
								message: 'package artifact repo cleanup failed',
								userId: input.userId,
								packageId: input.packageId,
								sourceId: savedPackage.sourceId,
								error: getErrorMessage(error),
							}),
						)
					})
					await deleteEntitySource(input.env, {
						id: savedPackage.sourceId,
						userId: input.userId,
					}).catch((error) => {
						console.warn(
							JSON.stringify({
								message: 'package entity source cleanup failed',
								userId: input.userId,
								packageId: input.packageId,
								sourceId: savedPackage.sourceId,
								error: getErrorMessage(error),
							}),
						)
					})
					const jobs = jobsData(input.env)
					for (const row of packageJobRows) {
						await jobs.deleteJob({ userId: input.userId, jobId: row.id })
						// Captured per job: a later failure must not lose these.
						removed.jobs.push({ id: row.id, name: row.name })
					}
				}
				const packageJobsRemoved = packageJobRows.length > 0
				await deleteAllPackageScopedSecrets({
					env: input.env,
					userId: input.userId,
					packageId: input.packageId,
				})
				await removeAllSecretApprovalsForPackage({
					env: input.env,
					userId: input.userId,
					packageId: input.packageId,
				})
				const deleted = await deleteSavedPackage(input.env.APP_DB, {
					userId: input.userId,
					packageId: input.packageId,
				})
				if (deleted && savedPackage) {
					const prefix = `${input.packageId}:`
					await input.env.APP_DB.prepare(
						`DELETE FROM package_app_rate_limits
						 WHERE bucket_key >= ? AND bucket_key < ?`,
					)
						.bind(prefix, `${input.packageId};`)
						.run()
					removed.package = { name: savedPackage.name }
				}
				await deleteCredentialMappingsForPackage({
					db: input.env.APP_DB,
					orgId: input.userId,
					packageId: input.packageId,
				})
				// Capture retired leaves before deleting redirect rows so the
				// package-app slug cache can be cleared for every path that still
				// pointed here (not only the current name leaf).
				const retiredPackageAppSlugs = savedPackage
					? await listPackageSlugRedirects({
							db: input.env.APP_DB,
							userId: input.userId,
							packageId: input.packageId,
						})
					: []
				// Retired slugs only mean something while the package they point at
				// exists; leaving them behind would hand a later package another
				// package's redirect history.
				await deletePackageSlugRedirects({
					db: input.env.APP_DB,
					userId: input.userId,
					packageId: input.packageId,
				})
				try {
					await removePackageSkillsIndexEntries({
						env: input.env,
						userId: input.userId,
						packageId: input.packageId,
					})
				} catch (error) {
					logPackageSkillsProjectionError({
						action: 'delete',
						packageId: input.packageId,
						error,
					})
				}
				await deleteSavedPackageVector(input.env, input.packageId)
				invalidateInvokeContractFreshness({
					userId: input.userId,
					packageIdOrKodyIds: [
						input.packageId,
						...(savedPackage
							? [savedPackage.kodyId, `kody:${savedPackage.name}`]
							: []),
					],
					packageAppSlugs: [
						...(savedPackage ? [getPackageNameLeaf(savedPackage.name)] : []),
						...retiredPackageAppSlugs,
					],
					sourceId: savedPackage?.sourceId ?? null,
				})
				try {
					await refreshPackageSubscriptionTopicMap({
						env: input.env,
						baseUrl: getAppBaseUrl({ env: input.env }),
						userId: input.userId,
					})
				} catch (error) {
					console.warn('package-subscription-topic-map-refresh-failed', {
						userId: input.userId,
						packageId: input.packageId,
						action: 'unpublish',
						error,
					})
				}
				if (packageJobsRemoved) {
					await syncJobManagerAlarm({
						env: input.env,
						userId: input.userId,
					})
				}
			},
		})
	} finally {
		if (removed.package) {
			await recordPackageAudit(input.audit, {
				orgId: input.userId,
				packageId: input.packageId,
				name: removed.package.name,
				action: packageAuditActions.deleted,
			})
		}
		for (const job of removed.jobs) {
			await recordJobAudit(input.audit, {
				orgId: input.userId,
				jobId: job.id,
				name: job.name,
				action: jobAuditActions.deleted,
			})
		}
	}
}
