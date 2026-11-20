/**
 * soft-delete-read-filter: opt-out
 *
 * Account deletion and soft-delete purge both read and remove user-owned rows
 * including tombstones. Live product paths keep deleted_at filters elsewhere.
 */
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	Clock,
	Effect,
	Exit,
	Option,
	Predicate,
	Schema,
	type Scope,
} from 'effect'
import { fileStoreRpc } from '#worker/files/client.ts'
import { linkedArtifactSourceKvPrefix } from '#worker/package-runtime/linked-artifact-store.ts'
import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import {
	type OAuthGrantHelpers,
	revokeAllOAuthGrantsBestEffort,
} from '#worker/oauth-grants.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import { accountDeletionCreditNoteSubscriptionMetadataKey } from '#worker/billing/stripe-client.ts'
import { isKodySubscription } from '#worker/billing/billing-config.ts'
import {
	computeMaxRefundMinor,
	computeProratedRefundMinor,
	selectRefundableInvoice,
} from '#worker/billing/unused-subscription-value.ts'
import { purgeStripePlanRefreshForUser } from '#worker/billing/stripe-plan-refresh-client.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import { purgeJobManagerForUser } from '#worker/jobs/manager-client.ts'
import { jobsService } from '#worker/jobs/jobs-data.ts'
import { jobVectorId } from '#mcp/jobs-vectorize.ts'
import { memoryVectorId } from '#mcp/memory/memory-vectorize.ts'
import { savedPackageVectorId } from '#worker/package-registry/repo.ts'
import { getCapabilityVectorIndex } from '#worker/vectorize/embedding.ts'
import { cleanupAllUserArtifactRepos } from '#worker/repo/artifact-repo-cleanup.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { mcpClientHubDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { packageRealtimeSessionRpc } from '#worker/package-runtime/realtime-session.ts'
import { clearRunRecords } from '#worker/run-records/service.ts'
import { cancelActiveWorkflowRunsForUser } from '#worker/package-runtime/package-workflows.ts'
import { mcpOAuthRefreshFamilyUserKvPrefixes } from '#worker/oauth-refresh-family.ts'
import {
	userMeterNamespace,
	userMeterRpc,
} from '#worker/entitlements/user-meter-client.ts'
import { mailboxRpc } from '#worker/email/mailbox-client.ts'
import { repoSessionIndexRpc } from '#worker/repo/repo-session-index-client.ts'
import { listRepoSessionsByUser } from '#worker/repo/repo-sessions.ts'
import { listAccountUserStorageIds } from '#worker/account/user-inventory.ts'
import {
	deleteOwnedMcpOauthClients,
	listOwnedUserMcpOauthClientIds,
} from '#app/account-mcp-oauth-clients.ts'
import {
	buildUserScopedDeleteOrUpdateSql,
	buildUserScopedTargetMatch,
	getAccountD1UserColumnCoverage,
} from '#worker/account/data-targets.ts'
import { hardPurgeDataTargets } from '#worker/orgs/data-targets.ts'
import {
	accountUserOwnedVectorizeSurfaces,
	getAccountDeletionDurableObjectResultKeys,
	type UserOwnedVectorizeSource,
} from '#worker/account/user-owned-surfaces.ts'
import {
	collectAccountR2Inventory,
	type AccountCommunityListingSnapshot,
	type AccountR2ObjectRef,
} from '#worker/account/r2-inventory.ts'
import {
	deleteAccountCommunityAssetPrefixes,
	deleteAccountEmailBlobPrefixes,
} from '#app/account-r2-prefix-cleanup.ts'
import { deleteOrgTransferBackupsForOwner } from '#worker/org-transfer/backup.ts'
import {
	listMcpAgentSessionsForUser,
	type McpAgentSession,
} from '#mcp/session-registry.ts'
import { accountDeletionWritersActive } from '#worker/account/deletion-state.ts'
import {
	abortAccountDeleting,
	clearUserMeterDeletionTombstone,
	type DeletionFence,
	type DeletionFenceError,
	markAccountDeleting,
} from '#worker/account/deletion-fence.ts'
import {
	buildPublishedSourceManifestSnapshotKvKey,
	buildPublishedCredentialNeedsKvKey,
	buildPublishedSourceSnapshotKvKey,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { deleteAllPackageSkillsIndexEntriesForUser } from '#worker/package-registry/skills-index-cache.ts'
import { deletePackageSubscriptionTopicCacheForUser } from '#worker/package-invocations/subscription-topic-cache.ts'
import { buildCommunitySnapshotKvKey } from '#worker/community/snapshot.ts'
import {
	communityIconKvListingPrefixes,
	buildCommunityIconCacheKey,
} from '#worker/community/community-icon.ts'
import { identityIconKvRepoPrefixes } from '#worker/repo/identity-icon.ts'
import { derivedCacheKeyPrefix } from '#worker/kv-cachified.ts'
import {
	maybeRemoveDiscordGuildRoles,
	summarizeDiscordGuildRoleSync,
} from '#worker/discord/guild-role.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { AuditLog } from '#worker/effect/audit.ts'
import { type Bound, D1, type DatabaseError, sql } from '#worker/effect/d1.ts'
import { outbound, type OutboundCallError } from '#worker/effect/outbound.ts'
import { runSlicePromise, type SliceServices } from '#worker/effect/slice.ts'
import {
	isAccountDeletionCreditNote,
	isStripeNothingToRefund,
	Stripe,
	type StripeCreditNote,
	type StripeSubscription,
} from '#worker/effect/stripe.ts'
import type { UserMeterFailure } from '#worker/effect/user-meter.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'

// The subset of the provider's OAuthHelpers that deletion consumes, kept
// structural so node tests can pass small stubs as `OAUTH_PROVIDER`.
type OAuthHelpersShape = OAuthGrantHelpers & {
	deleteClient?(clientId: string): Promise<unknown>
}

type AccountDeletionEnv = Env & {
	OAUTH_PROVIDER?: OAuthHelpersShape
}

/**
 * One prorated refund issued (or, on a retry, found already issued) for a
 * subscription that was canceled by account deletion. `amountMinor` is the
 * credit note total in the smallest unit of `currency`, tax included.
 */
const AccountDeletionStripeRefund = Schema.Struct({
	/** Null for a credit note from an earlier attempt that predates the marker. */
	subscriptionId: Schema.NullOr(Schema.String),
	amountMinor: Schema.Number,
	currency: Schema.String,
	invoiceId: Schema.String,
	creditNoteId: Schema.String,
})
export type AccountDeletionStripeRefund =
	typeof AccountDeletionStripeRefund.Type

export type AccountDeletionResult = {
	deletedRowCounts: Record<string, number>
	updatedRowCounts: Record<string, number>
	deletedKvKeys: number
	deletedCommunityAssets: number
	deletedEmailBlobs: number
	deletedArtifactRepos: number
	revokedOAuthGrants: number
	clearedDurableObjects: Record<string, number>
	deletedVectors: number
	stripeRefunds: Array<AccountDeletionStripeRefund>
	warnings: Array<string>
}

/** The partial result a cleanup failure carries; built in-process, never decoded. */
const AccountDeletionResultValue = Schema.declare(
	(input: unknown): input is AccountDeletionResult => Predicate.isObject(input),
)

export function getAccountDeletionD1UserColumnCoverage() {
	return getAccountD1UserColumnCoverage()
}

export class AccountDeletionInventoryError extends Schema.TaggedError<AccountDeletionInventoryError>()(
	'AccountDeletionInventoryError',
	{
		message: Schema.String,
		inventoryErrors: Schema.Array(Schema.String),
	},
) {
	constructor(inventoryErrors: ReadonlyArray<string>) {
		super({
			message: 'Account deletion inventory could not be collected safely.',
			inventoryErrors: [...inventoryErrors],
		})
	}
}

/**
 * Active Stripe subscriptions could not be canceled. Raised before any
 * destructive cleanup, like {@link AccountDeletionInventoryError}: the
 * deletion fence is released and the account is retained so the user keeps
 * billing-portal access and can retry.
 */
export class AccountDeletionBillingError extends Schema.TaggedError<AccountDeletionBillingError>()(
	'AccountDeletionBillingError',
	{
		message: Schema.String,
		billingErrors: Schema.Array(Schema.String),
	},
) {
	constructor(billingErrors: ReadonlyArray<string>) {
		super({
			message:
				'Account deletion could not refund or cancel the active Stripe subscription.',
			billingErrors: [...billingErrors],
		})
	}
}

export class AccountDeletionCleanupError extends Schema.TaggedError<AccountDeletionCleanupError>()(
	'AccountDeletionCleanupError',
	{
		message: Schema.String,
		cleanupErrors: Schema.Array(Schema.String),
		partialResult: AccountDeletionResultValue,
	},
) {
	constructor(
		cleanupErrors: ReadonlyArray<string>,
		partialResult: AccountDeletionResult,
	) {
		super({
			message: 'Account deletion cleanup could not complete safely.',
			cleanupErrors: [...cleanupErrors],
			partialResult,
		})
	}

	static fromResult(result: AccountDeletionResult) {
		return new AccountDeletionCleanupError(result.warnings, result)
	}
}

/** Deletion refused because writes still hold leases on the account. */
export class AccountDeletionWritersActive extends Schema.TaggedError<AccountDeletionWritersActive>()(
	'AccountDeletionWritersActive',
	{
		leaseCount: Schema.Number,
		blockingLeases: Schema.Array(
			Schema.Struct({ holder: Schema.String, acquiredAt: Schema.String }),
		),
	},
) {}

export class AccountNotSoftDeletedError extends Schema.TaggedError<AccountNotSoftDeletedError>()(
	'AccountNotSoftDeletedError',
	{ message: Schema.String },
) {}

/** A binding the inventory needs to enumerate a surface is missing. */
export class MissingBindingError extends Schema.TaggedError<MissingBindingError>()(
	'MissingBindingError',
	{ message: Schema.String },
) {}

export type DeleteUserAccountError =
	| AccountDeletionInventoryError
	| AccountDeletionBillingError
	| AccountDeletionCleanupError
	| AccountDeletionWritersActive
	| AccountNotSoftDeletedError
	| DeletionFenceError
	| UserMeterFailure
	| DatabaseError
	| OutboundCallError

type UserSourceSnapshot = {
	sourceId: string
	publishedCommit: string | null
	repoId: string
}

type UserSavedPackageSnapshot = {
	id: string
	kodyId: string
	sourceId: string
	hasApp: boolean
}

type UserDeletionInventory = {
	stripeCustomerId: string | null
	/** Account email, used only to hash into refund audit rows. */
	email: string | null
	vectorIds: Array<string>
	storageIds: Array<string>
	bundleKvKeys: Array<string>
	r2Objects: Array<AccountR2ObjectRef>
	sourceSnapshots: Array<UserSourceSnapshot>
	savedPackages: Array<UserSavedPackageSnapshot>
	repoSessions: Array<{ id: string }>
	mcpServers: Array<{ id: string }>
	mcpAgentSessions: Array<McpAgentSession>
	communityListings: Array<AccountCommunityListingSnapshot>
}

/**
 * Every Stripe status that can still produce an invoice or resume billing.
 * Only `canceled` and `incomplete_expired` are terminal; `past_due`, `unpaid`,
 * and `paused` keep dunning or can be resumed, and `incomplete` can still
 * activate when the first payment succeeds.
 */
const stripeSubscriptionStatusesCanceledOnAccountDeletion = new Set([
	'active',
	'trialing',
	'past_due',
	'unpaid',
	'paused',
	'incomplete',
])

/**
 * Only subscriptions in good standing get the unused remainder of their
 * current period refunded. Dunning (`past_due`, `unpaid`), `paused`, and
 * `incomplete` subscriptions have no paid-for service to give back.
 */
const stripeSubscriptionStatusesRefundedOnAccountDeletion = new Set([
	'active',
	'trialing',
])

const IdRow = Schema.Struct({ id: Schema.String })
const BillingIdentityRow = Schema.Struct({
	stripe_customer_id: Schema.NullOr(Schema.String),
	email: Schema.NullOr(Schema.String),
})
const SourceRow = Schema.Struct({
	id: Schema.String,
	published_commit: Schema.NullOr(Schema.String),
	repo_id: Schema.String,
})
const SavedPackageRow = Schema.Struct({
	id: Schema.String,
	kody_id: Schema.String,
	source_id: Schema.String,
	has_app: Schema.Union([Schema.Number, Schema.String, Schema.Boolean]),
})
const KvKeyRow = Schema.Struct({ kv_key: Schema.String })
const TombstoneRow = Schema.Struct({
	deleting_at: Schema.NullOr(Schema.String),
})
const DiscordConnectionRow = Schema.Struct({ provider_id: Schema.String })

function uniqueStrings(values: Iterable<string | null | undefined>) {
	return Array.from(
		new Set(
			Array.from(values)
				.map((value) => value?.trim() ?? '')
				.filter((value) => value.length > 0),
		),
	)
}

/**
 * The warnings a deletion run collects. Every best-effort cleanup step adds
 * its failure here; any warning blocks the D1 delete.
 */
class Warnings {
	readonly list: Array<string> = []
	add(message: string) {
		return Effect.sync(() => {
			this.list.push(message)
		})
	}
	get empty() {
		return this.list.length === 0
	}
}

/** Runs a best-effort step, turning its failure into a warning and a fallback value. */
const bestEffort = <A, E extends { readonly message: string }, R>(
	warnings: Warnings,
	effect: Effect.Effect<A, E, R>,
	fallback: A,
	describe: (message: string) => string,
) =>
	effect.pipe(
		Effect.catch((error: E) =>
			warnings.add(describe(error.message)).pipe(Effect.as(fallback)),
		),
	)

const vectorIdBuildersBySurfaceId = {
	memory: memoryVectorId,
	job: jobVectorId,
	saved_package: savedPackageVectorId,
} as const

const listUserVectorSourceRowIds = Effect.fn(
	'AccountDeletion.listUserVectorSourceRowIds',
)(function* (userId: OwnerId, source: UserOwnedVectorizeSource) {
	const env = yield* WorkerEnv
	const db = yield* D1
	switch (source.kind) {
		case 'app_db': {
			const rows = yield* db.all(
				`account_deletion.vector_rows.${source.table}`,
				IdRow,
				sql(`SELECT id FROM ${source.table} WHERE user_id = ?`, userId),
			)
			return rows.map((row) => row.id)
		}
		case 'jobs_rpc': {
			const jobs = jobsService(env)
			if (!jobs) {
				return yield* new MissingBindingError({
					message:
						'JOBS service binding is required to enumerate job vector ids (jobs live in the jobs worker D1, not APP_DB).',
				})
			}
			return yield* outbound('jobs.listJobIdsForUser', () =>
				jobs.listJobIdsForUser({ userId }),
			)
		}
	}
})

const listUserVectorIds = Effect.fn('AccountDeletion.listUserVectorIds')(
	function* (userId: OwnerId) {
		const ids: Array<string> = []
		for (const surface of accountUserOwnedVectorizeSurfaces) {
			const buildId = vectorIdBuildersBySurfaceId[surface.id]
			const rowIds = yield* listUserVectorSourceRowIds(userId, surface.source)
			for (const rowId of rowIds) ids.push(buildId(rowId))
		}
		return ids
	},
)

const getUserBillingIdentity = Effect.fn(
	'AccountDeletion.getUserBillingIdentity',
)(function* (dbUserId: number) {
	const db = yield* D1
	// Look up by primary key during deletion/purge; do not require a live row.
	const row = yield* db.first(
		'account_deletion.billing_identity',
		BillingIdentityRow,
		sql(
			`SELECT o.stripe_customer_id, u.email
				 FROM users u
				 LEFT JOIN orgs o ON o.id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)
				 WHERE u.id = ?`,
			dbUserId,
		),
	)
	return {
		stripeCustomerId:
			Option.getOrUndefined(row)?.stripe_customer_id?.trim() || null,
		email: Option.getOrUndefined(row)?.email?.trim() || null,
	}
})

const listUserSourceSnapshots = Effect.fn(
	'AccountDeletion.listUserSourceSnapshots',
)(function* (userId: OwnerId) {
	const db = yield* D1
	const rows = yield* db.all(
		'account_deletion.source_snapshots',
		SourceRow,
		sql(
			`SELECT id, published_commit, repo_id
			FROM entity_sources
			WHERE user_id = ?`,
			userId,
		),
	)
	return rows.map((row): UserSourceSnapshot => ({
		sourceId: row.id,
		publishedCommit: row.published_commit,
		repoId: row.repo_id,
	}))
})

const listUserSavedPackages = Effect.fn(
	'AccountDeletion.listUserSavedPackages',
)(function* (userId: OwnerId) {
	const db = yield* D1
	const rows = yield* db.all(
		'account_deletion.saved_packages',
		SavedPackageRow,
		sql(
			`SELECT id, kody_id, source_id, has_app
				FROM saved_packages
				WHERE user_id = ?`,
			userId,
		),
	)
	return rows.map((row): UserSavedPackageSnapshot => ({
		id: row.id,
		kodyId: row.kody_id,
		sourceId: row.source_id,
		hasApp: row.has_app === 1 || row.has_app === '1' || row.has_app === true,
	}))
})

const listUserRepoSessions = Effect.fn('AccountDeletion.listUserRepoSessions')(
	function* (userId: OwnerId) {
		const env = yield* WorkerEnv
		if (!env.REPO_SESSION_INDEX) {
			return yield* new MissingBindingError({
				message: 'REPO_SESSION_INDEX binding is required for account deletion.',
			})
		}
		const sessions = yield* outbound('repo_sessions.listByUser', () =>
			listRepoSessionsByUser(env, userId),
		)
		return sessions.map((row) => ({ id: row.id }))
	},
)

const listUserMcpServers = Effect.fn('AccountDeletion.listUserMcpServers')(
	function* (userId: OwnerId) {
		const db = yield* D1
		const rows = yield* db.all(
			'account_deletion.mcp_servers',
			IdRow,
			sql(
				`SELECT id
				FROM mcp_server_settings
				WHERE user_id = ?`,
				userId,
			),
		)
		return rows.map((row) => ({ id: row.id }))
	},
)

const listUserBundleKvKeys = Effect.fn('AccountDeletion.listUserBundleKvKeys')(
	function* (input: {
		readonly userId: OwnerId
		readonly sourceSnapshots: ReadonlyArray<UserSourceSnapshot>
		readonly communityListings: ReadonlyArray<AccountCommunityListingSnapshot>
	}) {
		const db = yield* D1
		const published = yield* db.all(
			'account_deletion.published_bundle_kv_keys',
			KvKeyRow,
			sql(
				`SELECT kv_key FROM published_bundle_artifacts WHERE user_id = ?`,
				input.userId,
			),
		)
		return uniqueStrings([
			...published.map((row) => row.kv_key),
			...input.sourceSnapshots.flatMap((source) =>
				source.publishedCommit
					? [
							buildPublishedSourceSnapshotKvKey({
								sourceId: source.sourceId,
								publishedCommit: source.publishedCommit,
							}),
							buildPublishedSourceManifestSnapshotKvKey({
								sourceId: source.sourceId,
								publishedCommit: source.publishedCommit,
							}),
							buildPublishedCredentialNeedsKvKey({
								sourceId: source.sourceId,
								publishedCommit: source.publishedCommit,
							}),
						]
					: [],
			),
			...input.communityListings.flatMap((listing) => [
				buildCommunitySnapshotKvKey(listing.id),
				derivedCacheKeyPrefix +
					buildCommunityIconCacheKey({
						listingId: listing.id,
						commit: listing.pinnedCommit,
					}),
				derivedCacheKeyPrefix +
					buildCommunityIconCacheKey({
						listingId: listing.id,
						commit: listing.iconCommit,
					}),
			]),
		])
	},
)

/**
 * Pre-collects every identifier cleanup needs while the owning rows still
 * exist. Listings run concurrently; any failure is a warning and, once all
 * have settled, an {@link AccountDeletionInventoryError}.
 */
const collectUserDeletionInventory = Effect.fn(
	'AccountDeletion.collectUserDeletionInventory',
)(function* (input: {
	readonly userId: OwnerId
	readonly dbUserId: number
	readonly warnings: Warnings
}) {
	const env = yield* WorkerEnv
	const inventoryErrors: Array<string> = []
	const listing = <A, E extends { readonly message: string }, R>(
		label: string,
		effect: Effect.Effect<A, E, R>,
		fallback: A,
	) =>
		effect.pipe(
			Effect.catch((error: E) => {
				const warning = `Failed to enumerate ${label}: ${error.message}`
				inventoryErrors.push(warning)
				return input.warnings.add(warning).pipe(Effect.as(fallback))
			}),
		)
	const [
		billingIdentity,
		vectorIds,
		storageIds,
		r2Inventory,
		sourceSnapshots,
		savedPackages,
		repoSessions,
		mcpServers,
		mcpAgentSessions,
	] = yield* Effect.all(
		[
			listing('Stripe customer id', getUserBillingIdentity(input.dbUserId), {
				stripeCustomerId: null,
				email: null,
			}),
			listing('vector ids', listUserVectorIds(input.userId), []),
			listing(
				'storage ids',
				outbound('account_inventory.storage_ids', () =>
					listAccountUserStorageIds({ env, userId: input.userId }),
				),
				[],
			),
			listing(
				'R2 objects',
				outbound('account_inventory.r2_objects', () =>
					collectAccountR2Inventory({
						env,
						userId: input.userId,
						dbUserId: input.dbUserId,
					}),
				),
				{ objects: [], communityListings: [] },
			),
			listing('source snapshots', listUserSourceSnapshots(input.userId), []),
			listing('saved packages', listUserSavedPackages(input.userId), []),
			listing('repo sessions', listUserRepoSessions(input.userId), []),
			listing('MCP servers', listUserMcpServers(input.userId), []),
			listing(
				'MCP agent sessions',
				outbound('account_inventory.mcp_agent_sessions', () =>
					listMcpAgentSessionsForUser(env.APP_DB, input.userId),
				),
				[],
			),
		],
		{ concurrency: 'unbounded' },
	)
	const bundleKvKeys = yield* listing(
		'bundle KV keys',
		listUserBundleKvKeys({
			userId: input.userId,
			sourceSnapshots,
			communityListings: r2Inventory.communityListings,
		}),
		[],
	)
	if (inventoryErrors.length > 0) {
		return yield* new AccountDeletionInventoryError(inventoryErrors)
	}
	yield* Effect.logInfo('account deletion inventory collected', {
		vectorIds: vectorIds.length,
		storageIds: storageIds.length,
		bundleKvKeys: bundleKvKeys.length,
		r2Objects: r2Inventory.objects.length,
		repoSessions: repoSessions.length,
		mcpAgentSessions: mcpAgentSessions.length,
	})
	return {
		stripeCustomerId: billingIdentity.stripeCustomerId,
		email: billingIdentity.email,
		vectorIds,
		storageIds,
		bundleKvKeys,
		r2Objects: r2Inventory.objects,
		sourceSnapshots,
		savedPackages,
		repoSessions,
		mcpServers,
		mcpAgentSessions,
		communityListings: r2Inventory.communityListings,
	} satisfies UserDeletionInventory
})

function creditNoteToRefund(
	creditNote: StripeCreditNote,
	fallbackSubscriptionId: string | null,
): AccountDeletionStripeRefund {
	return {
		subscriptionId:
			creditNote.metadata?.[accountDeletionCreditNoteSubscriptionMetadataKey] ??
			fallbackSubscriptionId,
		amountMinor: creditNote.total,
		currency: creditNote.currency,
		invoiceId: creditNote.invoice,
		creditNoteId: creditNote.id,
	}
}

/**
 * Records that an invoice's unused time was deliberately not refunded because
 * the refund could not be bounded safely. The cancel still proceeds. `reason`
 * carries only ids and amounts, never PII.
 */
const auditSkippedRefund = Effect.fn('AccountDeletion.auditSkippedRefund')(
	function* (email: string | null, reason: string) {
		const audit = yield* AuditLog
		yield* Effect.logWarning('account deletion refund skipped', { reason })
		yield* audit.record({
			category: 'account',
			action: 'account_deletion_refund_skipped',
			result: 'failure',
			email: email ?? undefined,
			reason,
		})
	},
)

/**
 * Refunds the unused remainder of the current billing period for one
 * subscription that is about to be canceled. Returns `None` when there is
 * nothing to refund, and also (with an `account_deletion_refund_skipped`
 * audit row) when the refund cannot be bounded. Returns the earlier Kody
 * credit note instead of issuing another when a previous deletion attempt
 * already refunded this invoice.
 */
const refundUnusedSubscriptionTime = Effect.fn(
	'AccountDeletion.refundUnusedSubscriptionTime',
)(function* (input: {
	readonly subscriptionId: string
	readonly email: string | null
	readonly nowSeconds: number
}) {
	const stripe = yield* Stripe
	const invoices = yield* stripe.listPaidInvoicesForSubscription(
		input.subscriptionId,
	)
	const selected = selectRefundableInvoice(invoices, input.nowSeconds)
	if (!selected) return Option.none()
	const lines = selected.lines
		.map((line) => ({
			invoiceLineItemId: line.id,
			amount: computeProratedRefundMinor({
				lineAmount: line.amount,
				periodStart: line.period.start,
				periodEnd: line.period.end,
				nowSeconds: input.nowSeconds,
			}),
		}))
		.filter((line) => line.amount > 0)
	if (lines.length === 0) return Option.none()

	const creditNotes = yield* stripe
		.listCreditNotesForInvoice(selected.invoice.id)
		.pipe(
			Effect.map(Option.some),
			Effect.catchTag('StripeCreditNoteListIncompleteError', (error) =>
				// The cap is amount_paid minus what was already credited; with an
				// unknown remainder the only safe cap is zero.
				Effect.logWarning('account_deletion_refund_credit_notes_incomplete', {
					subscriptionId: input.subscriptionId,
					invoiceId: selected.invoice.id,
					amountPaid: selected.invoice.amount_paid,
					pages: error.pages,
				}).pipe(
					Effect.andThen(
						auditSkippedRefund(
							input.email,
							`credit_notes_incomplete:${selected.invoice.id}`,
						),
					),
					Effect.as(Option.none<Array<StripeCreditNote>>()),
				),
			),
		)
	if (Option.isNone(creditNotes)) return Option.none()
	const existing = creditNotes.value.find(isAccountDeletionCreditNote)
	if (existing) {
		return Option.some({
			created: false,
			refund: creditNoteToRefund(existing, input.subscriptionId),
		})
	}
	const maxRefundMinor = computeMaxRefundMinor(
		selected.invoice,
		creditNotes.value,
	)
	if (maxRefundMinor <= 0) {
		yield* Effect.logInfo('account_deletion_refund_nothing_creditable', {
			subscriptionId: input.subscriptionId,
			invoiceId: selected.invoice.id,
			amountPaid: selected.invoice.amount_paid,
		})
		return Option.none()
	}

	const creditNote = yield* stripe
		.createProratedRefundCreditNote({
			invoiceId: selected.invoice.id,
			subscriptionId: input.subscriptionId,
			lines,
			maxRefundMinor,
			reason: 'order_change',
		})
		.pipe(
			Effect.catchIf(isStripeNothingToRefund, () =>
				Effect.logInfo('account_deletion_refund_already_refunded', {
					subscriptionId: input.subscriptionId,
				}).pipe(Effect.as({ outcome: 'nothing_to_refund' } as const)),
			),
			// Ids and amounts only (no PII): enough to reconcile against the
			// Stripe dashboard when a rejection repeats.
			Effect.tapError((error) =>
				Effect.logWarning('account_deletion_refund_rejected', {
					subscriptionId: input.subscriptionId,
					invoiceId: selected.invoice.id,
					amountPaid: selected.invoice.amount_paid,
					maxRefundMinor,
					requestedMinor: lines.reduce((sum, line) => sum + line.amount, 0),
					error: error.message,
				}),
			),
		)
	switch (creditNote.outcome) {
		case 'issued':
			return Option.some({
				created: true,
				refund: {
					subscriptionId: input.subscriptionId,
					amountMinor: creditNote.total,
					currency: creditNote.currency,
					invoiceId: selected.invoice.id,
					creditNoteId: creditNote.id,
				},
			})
		case 'nothing_to_refund':
			yield* Effect.logInfo('account_deletion_refund_previewed_zero', {
				subscriptionId: input.subscriptionId,
			})
			return Option.none()
		case 'unfittable':
			yield* Effect.logWarning('account_deletion_refund_unfittable', {
				invoiceId: selected.invoice.id,
				amountPaid: selected.invoice.amount_paid,
				maxRefundMinor,
				lastPreviewMinor: creditNote.lastPreviewMinor,
			})
			yield* auditSkippedRefund(
				input.email,
				`unfittable:${selected.invoice.currency}:${maxRefundMinor}`,
			)
			return Option.none()
	}
})

/**
 * Adds every issued Kody deletion credit note for the customer that this run
 * did not already record. Reporting only: a listing failure never blocks the
 * deletion.
 */
const earlierAccountDeletionRefunds = Effect.fn(
	'AccountDeletion.earlierAccountDeletionRefunds',
)(function* (
	customerId: string,
	refunds: ReadonlyArray<AccountDeletionStripeRefund>,
) {
	const stripe = yield* Stripe
	const creditNotes = yield* stripe.listCreditNotesForCustomer(customerId).pipe(
		Effect.catch((error) =>
			Effect.logWarning('account_deletion_refund_report_incomplete', {
				error: error.message,
			}).pipe(Effect.as([] as Array<StripeCreditNote>)),
		),
	)
	const known = new Set(refunds.map((refund) => refund.creditNoteId))
	const earlier: Array<AccountDeletionStripeRefund> = []
	for (const creditNote of creditNotes) {
		if (!isAccountDeletionCreditNote(creditNote)) continue
		if (known.has(creditNote.id)) continue
		known.add(creditNote.id)
		earlier.push(creditNoteToRefund(creditNote, null))
	}
	return earlier
})

/**
 * Refunds unused time on, then cancels, every **Kody** subscription that can
 * still bill, and fails with {@link AccountDeletionBillingError} when any
 * refund fails or any Kody subscription is still billable afterwards.
 * Non-Kody subscriptions on the shared Stripe account are left untouched.
 * Runs before any destructive cleanup so a Stripe outage retains the account.
 *
 * Idempotent across retries: canceled subscriptions are skipped, an invoice
 * that already carries a Kody credit note is not refunded twice,
 * `cancelSubscription` treats `resource_missing` as canceled, and a cancel
 * that errors is re-verified against a fresh listing.
 */
const cancelActiveStripeSubscriptions = Effect.fn(
	'AccountDeletion.cancelActiveStripeSubscriptions',
)(function* (input: {
	readonly customerId: string
	readonly email: string | null
}) {
	const env = yield* WorkerEnv
	const stripe = yield* Stripe
	const audit = yield* AuditLog
	const billableKody = (subscription: StripeSubscription) =>
		stripeSubscriptionStatusesCanceledOnAccountDeletion.has(
			subscription.status,
		) && isKodySubscription(env, subscription)

	const subscriptions = yield* stripe
		.listSubscriptions(input.customerId)
		.pipe(
			Effect.mapError(
				(error) =>
					new AccountDeletionBillingError([
						`Stripe subscriptions could not be listed: ${error.message}`,
					]),
			),
		)
	// Shared Stripe account: only cancel Kody subscriptions. Never touch
	// other products on the same customer (for example GratiText Premium).
	const billable = subscriptions.filter(billableKody)
	const refunds: Array<AccountDeletionStripeRefund> = []
	const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000)
	const failures: Array<string> = []
	let canceled = 0
	for (const subscription of billable) {
		if (
			stripeSubscriptionStatusesRefundedOnAccountDeletion.has(
				subscription.status,
			)
		) {
			const refunded = yield* refundUnusedSubscriptionTime({
				subscriptionId: subscription.id,
				email: input.email,
				nowSeconds,
			}).pipe(
				Effect.mapError(
					(error) =>
						new AccountDeletionBillingError([
							...failures,
							`Stripe subscription ${subscription.id} unused time could not be refunded: ${error.message}`,
						]),
				),
			)
			if (Option.isSome(refunded)) {
				refunds.push(refunded.value.refund)
				if (refunded.value.created) {
					yield* audit.record({
						category: 'account',
						action: 'account_deletion_refund',
						result: 'success',
						email: input.email ?? undefined,
						reason: `${refunded.value.refund.currency}:${refunded.value.refund.amountMinor}`,
					})
				}
			}
		}
		yield* stripe.cancelSubscription(subscription.id).pipe(
			Effect.matchEffect({
				onSuccess: () => Effect.sync(() => (canceled += 1)),
				onFailure: (error) =>
					Effect.sync(() =>
						failures.push(
							`Stripe subscription ${subscription.id} could not be canceled: ${error.message}`,
						),
					),
			}),
		)
	}

	if (failures.length > 0) {
		const stillBillable = yield* stripe
			.listSubscriptions(input.customerId)
			.pipe(
				Effect.map((listed) => listed.filter(billableKody)),
				Effect.mapError(
					(error) =>
						new AccountDeletionBillingError([
							...failures,
							`Stripe subscriptions could not be re-verified: ${error.message}`,
						]),
				),
			)
		if (stillBillable.length > 0) {
			return yield* new AccountDeletionBillingError(failures)
		}
		canceled = billable.length
	}

	refunds.push(
		...(yield* earlierAccountDeletionRefunds(input.customerId, refunds)),
	)
	yield* Effect.logInfo('account deletion billing settled', {
		canceled,
		refunds: refunds.length,
	})
	return { canceled, refunds }
})

/**
 * Best-effort Stripe customer deletion after every subscription is already
 * canceled. Failure is a warning only: nothing bills a customer with no
 * billable subscription.
 */
const deleteStripeCustomer = Effect.fn('AccountDeletion.deleteStripeCustomer')(
	function* (customerId: string, userId: OwnerId, warnings: Warnings) {
		const stripe = yield* Stripe
		yield* stripe.deleteCustomer(customerId).pipe(
			Effect.catch((error) =>
				warnings
					.add(
						`Stripe customer cleanup failed during account deletion: ${error.message}`,
					)
					.pipe(
						Effect.andThen(
							Effect.logError('account_deletion_stripe_cleanup_failed', {
								userId,
								error,
							}),
						),
					),
			),
		)
	},
)

/** Counts how many of `items` the per-item cleanup cleared; each failure is a warning. */
const clearEach = <T, E extends { readonly message: string }>(
	warnings: Warnings,
	items: ReadonlyArray<T>,
	clear: (item: T) => Effect.Effect<unknown, E>,
	describe: (item: T, message: string) => string,
) =>
	Effect.reduce(
		items,
		() => 0,
		(cleared, item) =>
			clear(item).pipe(
				Effect.as(cleared + 1),
				Effect.catch((error: E) =>
					warnings.add(describe(item, error.message)).pipe(Effect.as(cleared)),
				),
			),
	)

const deleteVectorsByIds = Effect.fn('AccountDeletion.deleteVectorsByIds')(
	function* (ids: ReadonlyArray<string>, warnings: Warnings) {
		if (ids.length === 0) return 0
		const env = yield* WorkerEnv
		const index = getCapabilityVectorIndex(env)
		if (!index) {
			yield* warnings.add(
				`CAPABILITY_VECTOR_INDEX binding was unavailable; ${ids.length} user vector(s) were not removed.`,
			)
			return 0
		}
		const batchSize = 100
		const batches: Array<ReadonlyArray<string>> = []
		for (let offset = 0; offset < ids.length; offset += batchSize) {
			batches.push(ids.slice(offset, offset + batchSize))
		}
		return yield* Effect.reduce(
			batches,
			() => 0,
			(deleted, batch) =>
				outbound('vectorize.deleteByIds', () =>
					index.deleteByIds([...batch]),
				).pipe(
					Effect.as(deleted + batch.length),
					Effect.catch((error) =>
						warnings
							.add(`Vectorize deleteByIds batch failed: ${error.message}`)
							.pipe(Effect.as(deleted)),
					),
				),
		)
	},
)

const listKvKeysByPrefix = Effect.fn('AccountDeletion.listKvKeysByPrefix')(
	function* (
		kv: KVNamespace,
		prefixes: ReadonlyArray<string>,
		warnings: Warnings,
	) {
		const keys = new Set<string>()
		if (typeof kv.list !== 'function') return keys
		for (const prefix of prefixes) {
			let cursor: string | undefined
			do {
				const page = yield* outbound('kv.list', () =>
					kv.list({ prefix, cursor }),
				).pipe(
					Effect.map(Option.some),
					Effect.catch((error) =>
						warnings
							.add(`KV prefix listing failed for ${prefix}: ${error.message}`)
							.pipe(Effect.as(Option.none())),
					),
				)
				if (Option.isNone(page)) break
				for (const key of page.value.keys) keys.add(key.name)
				cursor = page.value.list_complete ? undefined : page.value.cursor
			} while (cursor)
		}
		return keys
	},
)

const deletePackageSkillsIndexCache = Effect.fn(
	'AccountDeletion.deletePackageSkillsIndexCache',
)(function* (userId: OwnerId, warnings: Warnings) {
	const env = yield* WorkerEnv
	const deleted = yield* bestEffort(
		warnings,
		outbound('kv.deletePackageSkillsIndex', () =>
			deleteAllPackageSkillsIndexEntriesForUser({ env, userId }),
		),
		0,
		(message) => `Package skills index KV cleanup failed: ${message}`,
	)
	yield* bestEffort(
		warnings,
		outbound('kv.deletePackageSubscriptionTopicCache', () =>
			deletePackageSubscriptionTopicCacheForUser({ env, userId }),
		),
		undefined,
		(message) => `Package subscription topic map KV cleanup failed: ${message}`,
	)
	return deleted
})

const cleanupAccountEmailBlobs = Effect.fn(
	'AccountDeletion.cleanupAccountEmailBlobs',
)(function* (
	userId: OwnerId,
	r2Objects: ReadonlyArray<AccountR2ObjectRef>,
	warnings: Warnings,
) {
	const env = yield* WorkerEnv
	const emailBlobs = env.EMAIL_BLOBS
	if (!emailBlobs) {
		yield* warnings.add(
			'EMAIL_BLOBS binding was unavailable; email objects were not removed.',
		)
		return { deletedEmailBlobs: 0, emailCleanupComplete: false }
	}
	const prefixes = yield* outbound('r2.deleteAccountEmailBlobPrefixes', () =>
		deleteAccountEmailBlobPrefixes({
			bucket: emailBlobs,
			stableUserId: userId,
		}),
	).pipe(
		Effect.map((deleted) => ({ deleted, complete: true })),
		Effect.catch((error) =>
			warnings
				.add(error.message)
				.pipe(Effect.as({ deleted: 0, complete: false })),
		),
	)
	const exactKeys = r2Objects
		.filter((object) => object.binding === 'EMAIL_BLOBS')
		.filter(
			(object) =>
				!object.key.startsWith(`email-raw:v1:${userId}/`) &&
				!object.key.startsWith(`email-attachment:v1:${userId}/`),
		)
		.map((object) => object.key)
	const exactDeleted = yield* clearEach(
		warnings,
		exactKeys,
		(key) => outbound('r2.delete', () => emailBlobs.delete(key)),
		(key, message) => `Email blob delete failed for ${key}: ${message}`,
	)
	return {
		deletedEmailBlobs: prefixes.deleted + exactDeleted,
		emailCleanupComplete:
			prefixes.complete && exactDeleted === exactKeys.length,
	}
})

/** `clearedDurableObjects` keys, each starting at zero. */
function emptyAccountDeletionResult(
	warnings: Array<string>,
): AccountDeletionResult {
	const clearedDurableObjects: Record<string, number> = {}
	for (const key of getAccountDeletionDurableObjectResultKeys()) {
		clearedDurableObjects[key] = 0
	}
	return {
		deletedRowCounts: {},
		updatedRowCounts: {},
		deletedKvKeys: 0,
		deletedCommunityAssets: 0,
		deletedEmailBlobs: 0,
		deletedArtifactRepos: 0,
		revokedOAuthGrants: 0,
		clearedDurableObjects,
		deletedVectors: 0,
		stripeRefunds: [],
		warnings,
	}
}

/**
 * The out-of-band stores both account deletion and team-org hard purge clear
 * for an owner id, in order: workflow runs (fail-closed, keeps the fence so a
 * retry can find them through RunLog), vectors, artifact repos, file store
 * (fail-closed), Durable Objects, KV, community assets, email blobs, and
 * operator backups.
 */
const purgeOutOfBandStores = Effect.fn('AccountDeletion.purgeOutOfBandStores')(
	function* (input: {
		readonly ownerId: OwnerId
		readonly inventory: UserDeletionInventory
		readonly result: AccountDeletionResult
		readonly warnings: Warnings
	}) {
		const env = yield* WorkerEnv
		const { ownerId, inventory, result, warnings } = input
		const durableObjects = result.clearedDurableObjects

		// Stop running package workflows before purging the storage their
		// steps write to.
		const workflowRunsCancelled = yield* bestEffort(
			warnings,
			outbound('workflows.cancelActiveRuns', () =>
				cancelActiveWorkflowRunsForUser({ env, userId: ownerId }),
			).pipe(Effect.as(true)),
			false,
			(message) => `Workflow run cancellation failed: ${message}`,
		)
		if (!workflowRunsCancelled) {
			return yield* AccountDeletionCleanupError.fromResult(result)
		}

		result.deletedVectors = yield* deleteVectorsByIds(
			inventory.vectorIds,
			warnings,
		)
		result.deletedArtifactRepos = yield* bestEffort(
			warnings,
			outbound('artifacts.cleanupAllUserArtifactRepos', () =>
				cleanupAllUserArtifactRepos({
					env,
					userId: ownerId,
					warnings: warnings.list,
				}),
			),
			0,
			(message) => `Artifact repo cleanup failed unexpectedly: ${message}`,
		)

		if (env.FILE_STORE) {
			const purged = yield* bestEffort(
				warnings,
				outbound('file_store.purge', () =>
					fileStoreRpc(env, ownerId).purge(ownerId),
				).pipe(Effect.as(true)),
				false,
				(message) => `File store purge failed: ${message}`,
			)
			if (!purged) return yield* AccountDeletionCleanupError.fromResult(result)
			durableObjects.fileStores = 1
		}

		durableObjects.repoSessions = yield* clearEach(
			warnings,
			inventory.repoSessions,
			(session) =>
				outbound('repo_session.purge', () =>
					repoSessionRpc(env, session.id).purgeSession({
						sessionId: session.id,
						userId: ownerId,
					}),
				),
			(session, message) =>
				`Repo session purge failed for ${session.id}: ${message}`,
		)
		durableObjects.repoSessionIndexes = yield* bestEffort(
			warnings,
			outbound('repo_session_index.purge', () =>
				repoSessionIndexRpc({ env, userId: ownerId }).purge({ ownerId }),
			).pipe(Effect.as(1)),
			0,
			(message) => `Repo session index purge failed: ${message}`,
		)
		// Always purge, even when no mcp_server_settings rows remain: the hub DO
		// can still hold OAuth tokens and SDK registrations.
		const hub = env.MCP_CLIENT_HUB
		if (hub) {
			durableObjects.mcpClientHubs = yield* bestEffort(
				warnings,
				outbound('mcp_client_hub.purge', () =>
					(
						hub.get(
							hub.idFromName(mcpClientHubDurableObjectName(ownerId)),
						) as unknown as { purgeForAccountDeletion(): Promise<void> }
					).purgeForAccountDeletion(),
				).pipe(Effect.as(1)),
				0,
				(message) => `MCP client hub purge failed: ${message}`,
			)
		} else {
			yield* warnings.add(
				'MCP_CLIENT_HUB binding was unavailable; the MCP client hub was not purged.',
			)
			durableObjects.mcpClientHubs = 0
		}
		const agents = env.MCP_OBJECT
		if (agents) {
			durableObjects.mcpAgentSessions = yield* clearEach(
				warnings,
				inventory.mcpAgentSessions,
				(session) =>
					outbound('mcp_agent_session.purge', () =>
						(
							agents.get(agents.idFromString(session.doId)) as unknown as {
								purgeForAccountDeletion(payload: {
									userId: OwnerId
								}): Promise<void>
							}
						).purgeForAccountDeletion({ userId: ownerId }),
					),
				(session, message) =>
					`MCP agent session purge failed for ${session.doId}: ${message}`,
			)
		} else {
			if (inventory.mcpAgentSessions.length > 0) {
				yield* warnings.add(
					`MCP_OBJECT binding was unavailable; ${inventory.mcpAgentSessions.length} MCP agent session(s) were not purged.`,
				)
			}
			durableObjects.mcpAgentSessions = 0
		}
		durableObjects.packageRealtimeSessions = yield* clearEach(
			warnings,
			inventory.savedPackages.filter((pkg) => pkg.hasApp),
			(savedPackage) =>
				outbound('package_realtime_session.purge', () =>
					packageRealtimeSessionRpc({
						env,
						userId: ownerId,
						packageId: savedPackage.id,
						kodyId: savedPackage.kodyId,
						sourceId: savedPackage.sourceId,
						baseUrl: 'https://account-deletion.invalid',
					}).purge(),
				),
			(savedPackage, message) =>
				`Package realtime session purge failed for ${savedPackage.id}: ${message}`,
		)
		durableObjects.storageRunners = yield* clearEach(
			warnings,
			inventory.storageIds,
			(storageId) =>
				outbound('storage_runner.clear', () =>
					storageRunnerRpc({ env, userId: ownerId, storageId }).clearStorage(),
				),
			(storageId, message) =>
				`Storage runner clear failed for ${storageId}: ${message}`,
		)
		if ((env as Partial<Env>).RUN_LOG) {
			durableObjects.runLogs = yield* bestEffort(
				warnings,
				outbound('run_log.clear', () =>
					clearRunRecords({ env, userId: ownerId }),
				).pipe(Effect.as(1)),
				0,
				(message) => `Run log clear failed: ${message}`,
			)
		} else {
			yield* warnings.add(
				'RUN_LOG binding was unavailable; the user run log Durable Object was not purged.',
			)
			durableObjects.runLogs = 0
		}
		if (userMeterNamespace(env)) {
			durableObjects.userMeters = yield* bestEffort(
				warnings,
				outbound('user_meter.purge', () =>
					userMeterRpc({ env, userId: ownerId }).purge(),
				).pipe(Effect.as(1)),
				0,
				(message) => `User meter purge failed: ${message}`,
			)
		} else {
			yield* warnings.add(
				'USER_METER binding was unavailable; the user meter Durable Object was not purged.',
			)
			durableObjects.userMeters = 0
		}
		durableObjects.stripePlanRefreshes = yield* bestEffort(
			warnings,
			outbound('stripe_plan_refresh.purge', () =>
				purgeStripePlanRefreshForUser({ env, userId: ownerId }),
			).pipe(
				Effect.flatMap((purged) =>
					purged.purged
						? Effect.succeed(1)
						: warnings
								.add(
									'STRIPE_PLAN_REFRESH binding was unavailable; the user Stripe refresh alarm was not purged.',
								)
								.pipe(Effect.as(0)),
				),
			),
			0,
			(message) => `Stripe plan refresh purge failed: ${message}`,
		)

		const kv = env.BUNDLE_ARTIFACTS_KV
		if (kv) {
			const sourceSnapshotKeys = yield* listKvKeysByPrefix(
				kv,
				[
					...inventory.sourceSnapshots.flatMap((source) => [
						`source-snapshot:v1:${source.sourceId}:`,
						`source-manifest-snapshot:v1:${source.sourceId}:`,
						linkedArtifactSourceKvPrefix(source.sourceId),
						`credential-needs:v1:${source.sourceId}:`,
						`credential-stamp:v1:${source.sourceId}:`,
					]),
					...inventory.communityListings.flatMap((listing) =>
						communityIconKvListingPrefixes(listing.id),
					),
					...inventory.sourceSnapshots.flatMap((source) =>
						identityIconKvRepoPrefixes(source.repoId),
					),
					// Package-codemod apply snapshots are user-namespaced in KV;
					// purge the orphaned revert trees rather than waiting on the TTL.
					`package-codemod-revert:${ownerId}:`,
					// Encrypted copies of the user's MCP OAuth tokens.
					...mcpOAuthRefreshFamilyUserKvPrefixes(ownerId),
				],
				warnings,
			)
			const deletedKeys = yield* clearEach(
				warnings,
				Array.from(new Set([...inventory.bundleKvKeys, ...sourceSnapshotKeys])),
				(key) => outbound('kv.delete', () => kv.delete(key)),
				(key, message) => `KV delete failed for ${key}: ${message}`,
			)
			result.deletedKvKeys =
				deletedKeys + (yield* deletePackageSkillsIndexCache(ownerId, warnings))
		} else if (
			inventory.bundleKvKeys.length > 0 ||
			inventory.savedPackages.length > 0
		) {
			yield* warnings.add(
				`BUNDLE_ARTIFACTS_KV binding was unavailable; ${inventory.bundleKvKeys.length} bundle/source/community key(s) for ${inventory.savedPackages.length} package(s) referenced by the deleted user were not removed and must be cleaned up manually.`,
			)
		}

		result.deletedCommunityAssets = yield* bestEffort(
			warnings,
			outbound('r2.deleteAccountCommunityAssetPrefixes', () =>
				deleteAccountCommunityAssetPrefixes({
					bucket: env.COMMUNITY_ASSETS,
					stableUserId: ownerId,
					listingIds: inventory.communityListings.map((listing) => listing.id),
					repoIds: inventory.sourceSnapshots.map((source) => source.repoId),
				}),
			),
			result.deletedCommunityAssets,
			(message) => message,
		)
		const emailCleanup = yield* cleanupAccountEmailBlobs(
			ownerId,
			inventory.r2Objects,
			warnings,
		)
		result.deletedEmailBlobs = emailCleanup.deletedEmailBlobs
		const backups = env.OPERATOR_BACKUPS
		if (backups) {
			yield* bestEffort(
				warnings,
				outbound('r2.deleteOrgTransferBackups', () =>
					deleteOrgTransferBackupsForOwner({ bucket: backups, ownerId }),
				),
				undefined,
				(message) => `Org transfer backup cleanup failed: ${message}`,
			)
		}
		return emailCleanup
	},
)

/**
 * Keep Mailbox metadata while the account remains deletion-fenced so a retry
 * can re-enumerate authoritative email keys; purge only after complete email
 * cleanup and no warnings. Then purge the jobs worker's data fail-closed (it
 * cannot join the atomic APP_DB delete).
 */
const purgeMailboxAndJobs = Effect.fn('AccountDeletion.purgeMailboxAndJobs')(
	function* (input: {
		readonly ownerId: OwnerId
		readonly emailCleanupComplete: boolean
		readonly result: AccountDeletionResult
		readonly warnings: Warnings
	}) {
		const env = yield* WorkerEnv
		const { ownerId, result, warnings } = input
		if (input.emailCleanupComplete && warnings.empty) {
			result.clearedDurableObjects.mailboxes = yield* bestEffort(
				warnings,
				outbound('mailbox.purge', () =>
					mailboxRpc({ env, userId: ownerId }).purge({ ownerId }),
				).pipe(Effect.as(1)),
				0,
				(message) => `Mailbox purge failed: ${message}`,
			)
		}
		if (!warnings.empty) {
			return yield* AccountDeletionCleanupError.fromResult(result)
		}
		result.clearedDurableObjects.jobManagers = yield* bestEffort(
			warnings,
			outbound('job_manager.purge', () =>
				purgeJobManagerForUser({ env, userId: ownerId }),
			).pipe(
				Effect.flatMap((purged) =>
					purged.purged
						? Effect.succeed(1)
						: warnings
								.add(
									'JOBS service binding was unavailable; the user scheduler Durable Object was not purged.',
								)
								.pipe(Effect.as(0)),
				),
			),
			0,
			(message) => `Job manager purge failed: ${message}`,
		)
		if (!warnings.empty) {
			return yield* AccountDeletionCleanupError.fromResult(result)
		}
	},
)

/**
 * Collect the same out-of-band identifiers account deletion collects for an
 * owner id, delete those objects, then return. Does not delete D1 projection
 * rows, cancel Stripe, or revoke person OAuth clients. Team org hard purge
 * calls this before deleting owner-scoped D1 rows (#3121).
 *
 * Omit `dbUserId` for team orgs (no person row).
 */
export const purgeOwnerOutOfBandSurfacesEffect = Effect.fn(
	'AccountDeletion.purgeOwnerOutOfBandSurfaces',
)(function* (input: { readonly ownerId: OwnerId; readonly dbUserId?: number }) {
	yield* Effect.annotateCurrentSpan('kody.owner_id', input.ownerId)
	const warnings = new Warnings()
	const result = emptyAccountDeletionResult(warnings.list)
	const inventory = yield* collectUserDeletionInventory({
		userId: input.ownerId,
		dbUserId: input.dbUserId ?? -1,
		warnings,
	})
	const email = yield* purgeOutOfBandStores({
		ownerId: input.ownerId,
		inventory,
		result,
		warnings,
	})
	yield* purgeMailboxAndJobs({
		ownerId: input.ownerId,
		emailCleanupComplete: email.emailCleanupComplete,
		result,
		warnings,
	})
	yield* Effect.logInfo('owner out-of-band surfaces purged')
	return result
})

/** Removes the person's Discord guild roles when the account had a Discord connection. */
const removeDiscordGuildRoles = Effect.fn(
	'AccountDeletion.removeDiscordGuildRoles',
)(function* (dbUserId: number, warnings: Warnings) {
	const env = yield* WorkerEnv
	const db = yield* D1
	const connection = yield* db
		.first(
			'account_deletion.discord_connection',
			DiscordConnectionRow,
			sql(
				`SELECT provider_id FROM oauth_connections
					 WHERE user_id = ? AND provider_name = 'discord'`,
				dbUserId,
			),
		)
		.pipe(
			Effect.catch((error) =>
				warnings
					.add(`Discord connection lookup failed: ${error.message}`)
					.pipe(Effect.as(Option.none())),
			),
		)
	const discordUserId = Option.getOrUndefined(connection)?.provider_id
	if (!discordUserId) return
	const cleanup = yield* outbound('discord.removeGuildRoles', () =>
		maybeRemoveDiscordGuildRoles({ env, discordUserId }),
	)
	const summary = summarizeDiscordGuildRoleSync(cleanup)
	if (summary.status === 'error') {
		yield* warnings.add(`Discord role cleanup failed: ${summary.message}`)
	} else if (summary.status === 'forbidden') {
		yield* warnings.add('Discord role cleanup was forbidden.')
	}
})

/**
 * Removes the person's MCP OAuth clients and, unless the guest merge keeps
 * them, revokes their OAuth grants. Outside the provider's fetch wrapper the
 * helpers come from the library's `getOAuthApi`.
 */
const revokeOAuthAccess = Effect.fn('AccountDeletion.revokeOAuthAccess')(
	function* (input: {
		readonly dbUserId: number
		readonly ownerId: OwnerId
		readonly keepOAuthGrants: boolean
		readonly result: AccountDeletionResult
		readonly warnings: Warnings
	}) {
		const env = (yield* WorkerEnv) as AccountDeletionEnv
		const { warnings } = input
		const helpers: OAuthHelpersShape | undefined = yield* outbound(
			'oauth.resolveHelpers',
			() => resolveOAuthHelpers(env),
		)
		if (!helpers) {
			yield* warnings.add(
				'OAuth provider binding and OAUTH_KV were unavailable; OAuth grants were not revoked.',
			)
			return
		}
		if (helpers.deleteClient) {
			// The provider's OAuthHelpersImpl methods read `this.env`.
			const deleteClient = helpers.deleteClient.bind(helpers)
			yield* outbound('oauth.deleteOwnedMcpClients', () =>
				deleteOwnedMcpOauthClients({
					db: env.APP_DB,
					helpers: {
						async deleteClient(clientId) {
							await deleteClient(clientId)
						},
					},
					userId: input.dbUserId,
					warnings: warnings.list,
				}),
			)
		} else {
			const owned = yield* outbound('oauth.listOwnedMcpClients', () =>
				listOwnedUserMcpOauthClientIds(env.APP_DB, input.dbUserId),
			)
			if (owned.length > 0) {
				yield* warnings.add(
					'OAuth provider does not support client deletion; MCP OAuth clients were not removed.',
				)
			}
		}
		if (input.keepOAuthGrants) return
		input.result.revokedOAuthGrants = yield* bestEffort(
			warnings,
			outbound('oauth.revokeAllGrants', () =>
				revokeAllOAuthGrantsBestEffort({
					helpers,
					userId: input.ownerId,
					warnings: warnings.list,
				}),
			),
			input.result.revokedOAuthGrants,
			(message) => `OAuth grant revocation failed unexpectedly: ${message}`,
		)
	},
)

/** Atomically deletes the person's D1 rows and their `users` row in one batch. */
const deleteUserScopedRowsAndUser = Effect.fn(
	'AccountDeletion.deleteUserScopedRowsAndUser',
)(function* (input: {
	readonly mcpUserId: OwnerId
	readonly dbUserId: number
	readonly personUserId: string
	readonly allowSoftDeletedUser: boolean
}) {
	const db = yield* D1
	const operations = hardPurgeDataTargets('person').map((target) => {
		const match = buildUserScopedTargetMatch({
			target,
			mcpUserId: input.mcpUserId,
			dbUserId: input.dbUserId,
			personUserId: input.personUserId,
		})
		const statement = buildUserScopedDeleteOrUpdateSql(match)
		return {
			match,
			statement: sql(statement.sql, ...(statement.params as Array<Bound>)),
		}
	})
	const results = yield* db.batch('account_deletion.delete_user_rows', [
		...operations.map((operation) => operation.statement),
		sql(
			input.allowSoftDeletedUser
				? `DELETE FROM users WHERE id = ? AND deleted_at IS NOT NULL`
				: `DELETE FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
			input.dbUserId,
		),
	])
	const deletedRowCounts: Record<string, number> = {}
	const updatedRowCounts: Record<string, number> = {}
	for (const [index, operation] of operations.entries()) {
		const counts =
			operation.match.mutation.kind === 'delete'
				? deletedRowCounts
				: updatedRowCounts
		counts[operation.match.table] =
			(counts[operation.match.table] ?? 0) + (results[index]?.changes ?? 0)
	}
	deletedRowCounts.users = results.at(-1)?.changes ?? 0
	yield* Effect.sync(() =>
		invalidatePackageAppOwnerCache({ stableUserId: input.mcpUserId }),
	)
	return { deletedRowCounts, updatedRowCounts }
})

const preCleanupFailures = new Set([
	'AccountDeletionWritersActive',
	'AccountDeletionInventoryError',
	'AccountDeletionBillingError',
])

/**
 * The live deletion fence as a scoped resource. The fence is released only
 * when this attempt created it and the deletion stopped before anything
 * destructive ran (writers still active, inventory or billing failure). Every
 * other exit keeps it: a finished deletion has no row left to fence, and a
 * cleanup failure must stay fenced so the retry can finish.
 */
const liveDeletionFence = (dbUserId: number) =>
	Effect.acquireRelease(markAccountDeleting({ dbUserId }), (fence, exit) => {
		const error = Option.getOrUndefined(Exit.findErrorOption(exit))
		const tag = Predicate.hasProperty(error, '_tag') ? String(error._tag) : null
		const release = fence.created && tag !== null && preCleanupFailures.has(tag)
		return release
			? abortAccountDeleting({
					dbUserId,
					expectedDeletingAt: fence.deletingAt,
				}).pipe(
					Effect.tap(() =>
						Effect.logInfo('account deletion fence released', {
							reason: tag,
						}),
					),
					Effect.catch((abortError) =>
						Effect.logError('account deletion fence release failed', {
							error: abortError.message,
						}),
					),
				)
			: Effect.logDebug('account deletion fence kept')
	})

/** The soft-delete purge lane's fence: the tombstoned row and its claim must already exist. */
const purgeClaimFence = Effect.fn('AccountDeletion.purgeClaimFence')(function* (
	dbUserId: number,
	mcpUserId: OwnerId,
) {
	const db = yield* D1
	const tombstone = yield* db.first(
		'account_deletion.soft_deleted_tombstone',
		TombstoneRow,
		sql(
			`SELECT deleting_at
			 FROM users
			 WHERE id = ? AND deleted_at IS NOT NULL`,
			dbUserId,
		),
	)
	if (Option.isNone(tombstone)) {
		return yield* new AccountNotSoftDeletedError({
			message: `Account ${mcpUserId} is not soft-deleted for purge.`,
		})
	}
	return { leaseCount: 0, blockingLeases: [], created: false, deletingAt: '' }
})

/**
 * Orchestrate a full per-user data cleanup. The caller is responsible for
 * verifying the user's identity before invoking this.
 *
 * The cleanup ordering is:
 *   1. Fence the account (or, on the purge lane, confirm the tombstone).
 *   2. Pre-collect identifiers we need while their owning rows still exist.
 *   3. Cancel active Stripe subscriptions. Like inventory, a failure here
 *      releases the deletion fence and retains the account untouched.
 *   4. Idempotent cleanup of out-of-band stores and OAuth grants.
 *   5. Abort while preserving D1 inventory and the user row if any critical
 *      cleanup failed.
 *   6. Atomically delete user-scoped D1 rows and the user row in one batch.
 */
export const deleteUserAccountEffect = Effect.fn(
	'AccountDeletion.deleteUserAccount',
)(function* (input: {
	readonly dbUserId: number
	/**
	 * Storage / personal org OwnerId. Out-of-band surfaces and org-keyed
	 * D1 rows use this id.
	 */
	readonly mcpUserId: OwnerId
	/** Person id when it may differ from {@link mcpUserId}. */
	readonly personUserId?: string
	/**
	 * Purge lane: the account is already soft-deleted and claimed via
	 * `deleting_at`. Skip the live deletion fence and remove the
	 * tombstoned users row.
	 */
	readonly purgeSoftDeleted?: boolean
	/** Guest merge: the claiming person inherits this account's OAuth grants. */
	readonly keepOAuthGrants?: boolean
}): Effect.fn.Return<
	AccountDeletionResult,
	DeleteUserAccountError,
	SliceServices | Scope.Scope
> {
	yield* Effect.annotateCurrentSpan({
		'kody.owner_id': input.mcpUserId,
		'kody.purge_soft_deleted': input.purgeSoftDeleted === true,
	})
	const purgeSoftDeleted = input.purgeSoftDeleted === true
	const fence: DeletionFence = purgeSoftDeleted
		? yield* purgeClaimFence(input.dbUserId, input.mcpUserId)
		: yield* liveDeletionFence(input.dbUserId)
	if (fence.leaseCount > 0) {
		return yield* new AccountDeletionWritersActive({
			leaseCount: fence.leaseCount,
			blockingLeases: fence.blockingLeases,
		})
	}
	const warnings = new Warnings()
	const result = emptyAccountDeletionResult(warnings.list)
	const inventory = yield* collectUserDeletionInventory({
		userId: input.mcpUserId,
		dbUserId: input.dbUserId,
		warnings,
	})

	// Billing is a precondition of deletion, checked before anything
	// destructive.
	if (inventory.stripeCustomerId) {
		const billing = yield* cancelActiveStripeSubscriptions({
			customerId: inventory.stripeCustomerId,
			email: inventory.email,
		}).pipe(
			Effect.tapErrorTag('AccountDeletionBillingError', (error) =>
				Effect.logError('account_deletion_billing_cancel_failed', {
					userId: input.mcpUserId,
					billingErrors: error.billingErrors,
				}),
			),
		)
		result.stripeRefunds = billing.refunds
	}

	const email = yield* purgeOutOfBandStores({
		ownerId: input.mcpUserId,
		inventory,
		result,
		warnings,
	})
	yield* removeDiscordGuildRoles(input.dbUserId, warnings)
	yield* revokeOAuthAccess({
		dbUserId: input.dbUserId,
		ownerId: input.mcpUserId,
		keepOAuthGrants: input.keepOAuthGrants === true,
		result,
		warnings,
	})
	yield* purgeMailboxAndJobs({
		ownerId: input.mcpUserId,
		emailCleanupComplete: email.emailCleanupComplete,
		result,
		warnings,
	})

	if (inventory.stripeCustomerId) {
		yield* deleteStripeCustomer(
			inventory.stripeCustomerId,
			input.mcpUserId,
			warnings,
		)
	}

	const d1Cleanup = yield* deleteUserScopedRowsAndUser({
		mcpUserId: input.mcpUserId,
		dbUserId: input.dbUserId,
		personUserId: input.personUserId ?? input.mcpUserId,
		allowSoftDeletedUser: purgeSoftDeleted,
	}).pipe(
		Effect.flatMap((cleanup) =>
			purgeSoftDeleted && (cleanup.deletedRowCounts.users ?? 0) === 0
				? Effect.fail({
						message: `Soft-deleted user row was not removed for ${input.mcpUserId}.`,
					})
				: Effect.succeed(cleanup),
		),
		Effect.catch((error: { readonly message: string }) =>
			warnings
				.add(`Atomic D1 account deletion failed: ${error.message}`)
				.pipe(
					Effect.andThen(() =>
						Effect.fail(AccountDeletionCleanupError.fromResult(result)),
					),
				),
		),
	)
	result.deletedRowCounts = {
		...result.deletedRowCounts,
		...d1Cleanup.deletedRowCounts,
	}
	result.updatedRowCounts = d1Cleanup.updatedRowCounts

	// The D1 user row is gone. Drop the UserMeter tombstone `purge()`
	// restored so the purged object keeps no state for this stable id.
	yield* clearUserMeterDeletionTombstone({
		stableUserId: input.mcpUserId,
	}).pipe(
		Effect.catch((error) =>
			Effect.logError('account_deletion_user_meter_tombstone_clear_failed', {
				userId: input.mcpUserId,
				error: error.message,
			}),
		),
	)
	yield* Effect.logInfo('account deleted', {
		deletedRows: Object.values(result.deletedRowCounts).reduce(
			(sum, count) => sum + count,
			0,
		),
		deletedKvKeys: result.deletedKvKeys,
		stripeRefunds: result.stripeRefunds.length,
	})
	return result
}, Effect.scoped)

/**
 * Promise callers outside the retention lanes (account settings, admin
 * capabilities, guest merge) see the error classes they always caught.
 */
export function toPromiseError(error: DeleteUserAccountError) {
	return error._tag === 'AccountDeletionWritersActive'
		? accountDeletionWritersActive(error)
		: error
}

export function deleteUserAccount(input: {
	env: AccountDeletionEnv
	dbUserId: number
	mcpUserId: OwnerId
	personUserId?: string
	purgeSoftDeleted?: boolean
	keepOAuthGrants?: boolean
}): Promise<AccountDeletionResult> {
	const { env, ...rest } = input
	return runSlicePromise(
		env,
		deleteUserAccountEffect(rest).pipe(Effect.mapError(toPromiseError)),
	)
}

export function purgeOwnerOutOfBandSurfaces(input: {
	env: AccountDeletionEnv
	ownerId: OwnerId
	dbUserId?: number
}): Promise<AccountDeletionResult> {
	const { env, ...rest } = input
	return runSlicePromise(env, purgeOwnerOutOfBandSurfacesEffect(rest))
}
