/**
 * soft-delete-read-filter: opt-out
 *
 * Account deletion and soft-delete purge both read and remove user-owned rows
 * including tombstones. Live product paths keep deleted_at filters elsewhere.
 */
import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	type OAuthGrantHelpers,
	revokeAllOAuthGrantsBestEffort,
} from '#worker/oauth-grants.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import {
	accountDeletionCreditNoteSubscriptionMetadataKey,
	cancelSubscription,
	createProratedRefundCreditNote,
	deleteCustomer,
	isAccountDeletionCreditNote,
	isStripeNothingToRefundError,
	listCreditNotesForCustomer,
	listCreditNotesForInvoice,
	listPaidInvoicesForSubscription,
	listSubscriptions,
	StripeCreditNoteListIncompleteError,
	type StripeCreditNote,
	type StripeInvoiceLineItem,
	type StripePaidInvoice,
	type StripeSubscription,
} from '#worker/billing/stripe-client.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { isKodySubscription } from '#worker/billing/billing-config.ts'
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
import {
	AccountDeletionWritersActiveError,
	abortAccountDeleting,
	clearUserMeterDeletionTombstone,
	markAccountDeleting,
} from '#worker/account/deletion-state.ts'
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

// The subset of the provider's OAuthHelpers that deletion consumes, kept
// structural so node tests can pass small stubs as `OAUTH_PROVIDER`.
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
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
export type AccountDeletionStripeRefund = {
	/** Null for a credit note from an earlier attempt that predates the marker. */
	subscriptionId: string | null
	amountMinor: number
	currency: string
	invoiceId: string
	creditNoteId: string
}

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

export function getAccountDeletionD1UserColumnCoverage() {
	return getAccountD1UserColumnCoverage()
}

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

type UserRepoSessionSnapshot = {
	id: string
}

type UserMcpServerSnapshot = {
	id: string
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
	repoSessions: Array<UserRepoSessionSnapshot>
	mcpServers: Array<UserMcpServerSnapshot>
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

export class AccountDeletionInventoryError extends Error {
	readonly inventoryErrors: ReadonlyArray<string>

	constructor(inventoryErrors: ReadonlyArray<string>) {
		super('Account deletion inventory could not be collected safely.')
		this.name = 'AccountDeletionInventoryError'
		this.inventoryErrors = [...inventoryErrors]
	}
}

/**
 * Active Stripe subscriptions could not be canceled. Raised before any
 * destructive cleanup, like {@link AccountDeletionInventoryError}: the
 * deletion fence is released and the account is retained so the user keeps
 * billing-portal access and can retry.
 */
export class AccountDeletionBillingError extends Error {
	readonly billingErrors: ReadonlyArray<string>

	constructor(billingErrors: ReadonlyArray<string>) {
		super(
			'Account deletion could not refund or cancel the active Stripe subscription.',
		)
		this.name = 'AccountDeletionBillingError'
		this.billingErrors = [...billingErrors]
	}
}

export class AccountDeletionCleanupError extends Error {
	readonly cleanupErrors: ReadonlyArray<string>
	readonly partialResult: AccountDeletionResult

	constructor(
		cleanupErrors: ReadonlyArray<string>,
		partialResult: AccountDeletionResult,
	) {
		super('Account deletion cleanup could not complete safely.')
		this.name = 'AccountDeletionCleanupError'
		this.cleanupErrors = [...cleanupErrors]
		this.partialResult = partialResult
	}
}

function uniqueStrings(values: Iterable<string | null | undefined>) {
	return Array.from(
		new Set(
			Array.from(values)
				.map((value) => value?.trim() ?? '')
				.filter((value) => value.length > 0),
		),
	)
}

const vectorIdBuildersBySurfaceId = {
	memory: memoryVectorId,
	job: jobVectorId,
	saved_package: savedPackageVectorId,
} as const

async function listUserVectorSourceRowIds(
	env: Env,
	userId: OwnerId,
	source: UserOwnedVectorizeSource,
): Promise<Array<string>> {
	switch (source.kind) {
		case 'app_db': {
			const rows = await env.APP_DB.prepare(
				`SELECT id FROM ${source.table} WHERE user_id = ?`,
			)
				.bind(userId)
				.all<{ id: string }>()
			return (rows.results ?? []).map((row) => row.id)
		}
		case 'jobs_rpc': {
			const jobs = jobsService(env)
			if (!jobs) {
				throw new Error(
					'JOBS service binding is required to enumerate job vector ids (jobs live in the jobs worker D1, not APP_DB).',
				)
			}
			return jobs.listJobIdsForUser({ userId })
		}
		default: {
			const unknownSource: never = source
			throw new Error(
				`Unknown vectorize surface source: ${JSON.stringify(unknownSource)}`,
			)
		}
	}
}

async function listUserVectorIds(env: Env, userId: OwnerId) {
	const ids: Array<string> = []
	for (const surface of accountUserOwnedVectorizeSurfaces) {
		const buildId = vectorIdBuildersBySurfaceId[surface.id]
		const rowIds = await listUserVectorSourceRowIds(env, userId, surface.source)
		for (const rowId of rowIds) {
			ids.push(buildId(rowId))
		}
	}
	return ids
}

async function getUserBillingIdentity(env: Env, dbUserId: number) {
	// Look up by primary key during deletion/purge; do not require a live row.
	const row = await env.APP_DB.prepare(
		`SELECT o.stripe_customer_id, u.email
		 FROM users u
		 LEFT JOIN orgs o ON o.id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)
		 WHERE u.id = ?`,
	)
		.bind(dbUserId)
		.first<{ stripe_customer_id: string | null; email: string | null }>()
	return {
		stripeCustomerId: row?.stripe_customer_id?.trim() || null,
		email: row?.email?.trim() || null,
	}
}

async function listUserStorageIds(env: Env, userId: OwnerId) {
	return await listAccountUserStorageIds({
		env,
		userId,
	})
}

async function listUserSourceSnapshots(env: Env, userId: OwnerId) {
	const sourceRows = await env.APP_DB.prepare(
		`SELECT id, published_commit, repo_id
		FROM entity_sources
		WHERE user_id = ?`,
	)
		.bind(userId)
		.all<{ id: string; published_commit: string | null; repo_id: string }>()
	return (sourceRows.results ?? []).map((row) => ({
		sourceId: row.id,
		publishedCommit: row.published_commit,
		repoId: row.repo_id,
	}))
}

async function listUserSavedPackages(env: Env, userId: OwnerId) {
	const rows = await env.APP_DB.prepare(
		`SELECT id, kody_id, source_id, has_app
		FROM saved_packages
		WHERE user_id = ?`,
	)
		.bind(userId)
		.all<{
			id: string
			kody_id: string
			source_id: string
			has_app: number | string | boolean
		}>()
	return (rows.results ?? []).map((row) => ({
		id: row.id,
		kodyId: row.kody_id,
		sourceId: row.source_id,
		hasApp: row.has_app === 1 || row.has_app === '1' || row.has_app === true,
	}))
}

async function listUserRepoSessions(env: Env, userId: OwnerId) {
	if (!env.REPO_SESSION_INDEX) {
		throw new Error(
			'REPO_SESSION_INDEX binding is required for account deletion.',
		)
	}
	return (await listRepoSessionsByUser(env, userId)).map((row) => ({
		id: row.id,
	}))
}

async function listUserMcpServers(env: Env, userId: OwnerId) {
	const rows = await env.APP_DB.prepare(
		`SELECT id
		FROM mcp_server_settings
		WHERE user_id = ?`,
	)
		.bind(userId)
		.all<{ id: string }>()
	return (rows.results ?? []).map((row) => ({ id: row.id }))
}

async function listUserBundleKvKeys(input: {
	env: Env
	userId: OwnerId
	sourceSnapshots: ReadonlyArray<UserSourceSnapshot>
	communityListings: ReadonlyArray<AccountCommunityListingSnapshot>
}) {
	const published = await input.env.APP_DB.prepare(
		`SELECT kv_key FROM published_bundle_artifacts WHERE user_id = ?`,
	)
		.bind(input.userId)
		.all<{ kv_key: string }>()
	return uniqueStrings([
		...(published.results ?? []).map((row) => row.kv_key),
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
}

async function collectUserDeletionInventory(input: {
	env: Env
	userId: OwnerId
	dbUserId: number
	warnings: Array<string>
}): Promise<UserDeletionInventory> {
	const inventoryErrors: Array<string> = []
	const recordInventoryError = (label: string, error: unknown) => {
		const warning = `Failed to enumerate ${label}: ${getErrorMessage(error)}`
		input.warnings.push(warning)
		inventoryErrors.push(warning)
	}
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
	] = await Promise.all([
		getUserBillingIdentity(input.env, input.dbUserId).catch((error) => {
			recordInventoryError('Stripe customer id', error)
			return { stripeCustomerId: null, email: null }
		}),
		listUserVectorIds(input.env, input.userId).catch((error) => {
			recordInventoryError('vector ids', error)
			return [] as Array<string>
		}),
		listUserStorageIds(input.env, input.userId).catch((error) => {
			recordInventoryError('storage ids', error)
			return [] as Array<string>
		}),
		collectAccountR2Inventory({
			env: input.env,
			userId: input.userId,
			dbUserId: input.dbUserId,
		}).catch((error) => {
			recordInventoryError('R2 objects', error)
			return {
				objects: [] as Array<AccountR2ObjectRef>,
				communityListings: [] as Array<AccountCommunityListingSnapshot>,
			}
		}),
		listUserSourceSnapshots(input.env, input.userId).catch((error) => {
			recordInventoryError('source snapshots', error)
			return [] as Array<UserSourceSnapshot>
		}),
		listUserSavedPackages(input.env, input.userId).catch((error) => {
			recordInventoryError('saved packages', error)
			return [] as Array<UserSavedPackageSnapshot>
		}),
		listUserRepoSessions(input.env, input.userId).catch((error) => {
			recordInventoryError('repo sessions', error)
			return [] as Array<UserRepoSessionSnapshot>
		}),
		listUserMcpServers(input.env, input.userId).catch((error) => {
			recordInventoryError('MCP servers', error)
			return [] as Array<UserMcpServerSnapshot>
		}),
		listMcpAgentSessionsForUser(input.env.APP_DB, input.userId).catch(
			(error) => {
				recordInventoryError('MCP agent sessions', error)
				return [] as Array<McpAgentSession>
			},
		),
	])
	const bundleKvKeys = await listUserBundleKvKeys({
		env: input.env,
		userId: input.userId,
		sourceSnapshots,
		communityListings: r2Inventory.communityListings,
	}).catch((error) => {
		recordInventoryError('bundle KV keys', error)
		return [] as Array<string>
	})
	if (inventoryErrors.length > 0) {
		throw new AccountDeletionInventoryError(inventoryErrors)
	}
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
	}
}

function isStripeSubscriptionBillable(subscription: StripeSubscription) {
	return stripeSubscriptionStatusesCanceledOnAccountDeletion.has(
		subscription.status,
	)
}

function isStripeSubscriptionRefundable(subscription: StripeSubscription) {
	return stripeSubscriptionStatusesRefundedOnAccountDeletion.has(
		subscription.status,
	)
}

/**
 * Unused-time refund for one invoice line, in the smallest currency unit:
 * `floor(lineAmount * (periodEnd - now) / (periodEnd - periodStart))`. Zero
 * when the period has already ended, has no length, or the line was free.
 *
 * `lineAmount` is the line's gross amount (before discounts and exclusive
 * tax), so this is the gross amount to credit, not what the customer gets
 * back: Stripe prorates the line's discounts and tax into the credit note and
 * the previewed total is what is refunded.
 */
function computeProratedRefundMinor(input: {
	lineAmount: number
	periodStart: number
	periodEnd: number
	nowSeconds: number
}) {
	const periodLength = input.periodEnd - input.periodStart
	const remaining = input.periodEnd - input.nowSeconds
	if (input.lineAmount <= 0 || periodLength <= 0 || remaining <= 0) return 0
	const unusedFraction = Math.min(1, remaining / periodLength)
	return Math.floor(input.lineAmount * unusedFraction)
}

/**
 * Every positive invoice line whose service period covers `now`. A mid-cycle
 * upgrade invoice also carries a negative proration credit for the old price,
 * which cannot be credited again; lines for periods that already ended (or
 * have not started) have no unused time.
 */
function selectRefundableInvoiceLines(
	invoice: StripePaidInvoice,
	nowSeconds: number,
): Array<StripeInvoiceLineItem> {
	return invoice.lines.data.filter(
		(line) =>
			line.amount > 0 &&
			line.period.start <= nowSeconds &&
			line.period.end > nowSeconds,
	)
}

/**
 * Walks the subscription's recent paid invoices, newest first, to the first
 * one that both took money and still has a line covering `now`. The newest
 * paid invoice is often a $0 proration invoice (a downgrade) with nothing to
 * give back; the real payment for the running period sits behind it.
 */
function selectRefundableInvoice(
	invoices: ReadonlyArray<StripePaidInvoice>,
	nowSeconds: number,
) {
	for (const invoice of invoices) {
		if (invoice.amount_paid <= 0) continue
		const lines = selectRefundableInvoiceLines(invoice, nowSeconds)
		if (lines.length > 0) return { invoice, lines }
	}
	return null
}

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
 * The most an invoice can still give back: what was actually paid minus every
 * credit note already issued against it, by anyone. A mid-cycle upgrade
 * invoice (portal upgrades use `always_invoice`) carries a positive new-plan
 * line plus a negative unused-time credit for the old plan, so `amount_paid`
 * is the net and the unused fraction of the positive line alone can exceed
 * it; Stripe would reject that credit note.
 */
function computeMaxRefundMinor(
	invoice: StripePaidInvoice,
	creditNotes: ReadonlyArray<StripeCreditNote>,
) {
	const credited = creditNotes
		.filter((creditNote) => creditNote.status === 'issued')
		.reduce((sum, creditNote) => sum + creditNote.total, 0)
	return invoice.amount_paid - credited
}

/**
 * Records that an invoice's unused time was deliberately not refunded because
 * the refund could not be bounded safely. The cancel still proceeds: a missing
 * refund on an edge case is a support ticket, a blocked deletion is a broken
 * promise. `reason` carries only ids and amounts, never PII.
 */
async function auditSkippedRefund(input: {
	env: Env
	email: string | null
	reason: string
}) {
	await logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'account',
		action: 'account_deletion_refund_skipped',
		result: 'failure',
		email: input.email ?? undefined,
		reason: input.reason,
	})
}

/**
 * Refunds the unused remainder of the current billing period for one
 * subscription that is about to be canceled. Returns null when there is
 * nothing to refund (no paid invoice covering the period, only free or
 * finished lines, every amount floors to zero, earlier credit notes already
 * consumed what was paid, a credit note that previews to zero, or Stripe
 * reporting the invoice's charge already refunded in full), and also — with
 * an `account_deletion_refund_skipped` audit row — when the refund cannot be
 * bounded (the credit note listing is too long to trust, or the scaled
 * preview never fits under the cap). Returns the earlier Kody credit note
 * instead of issuing another when a previous deletion attempt already
 * refunded this invoice.
 */
async function refundUnusedSubscriptionTime(input: {
	env: Env
	subscriptionId: string
	email: string | null
	nowSeconds: number
}): Promise<{ refund: AccountDeletionStripeRefund; created: boolean } | null> {
	const invoices = await listPaidInvoicesForSubscription(
		input.env,
		input.subscriptionId,
	)
	const selected = selectRefundableInvoice(invoices, input.nowSeconds)
	if (!selected) return null
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
	if (lines.length === 0) return null

	let creditNotes: Array<StripeCreditNote>
	try {
		creditNotes = await listCreditNotesForInvoice(
			input.env,
			selected.invoice.id,
		)
	} catch (error) {
		if (!(error instanceof StripeCreditNoteListIncompleteError)) throw error
		// The cap is amount_paid minus what was already credited; with an
		// unknown remainder the only safe cap is zero.
		console.warn('account_deletion_refund_credit_notes_incomplete', {
			subscriptionId: input.subscriptionId,
			invoiceId: selected.invoice.id,
			amountPaid: selected.invoice.amount_paid,
			pages: error.pages,
		})
		await auditSkippedRefund({
			env: input.env,
			email: input.email,
			reason: `credit_notes_incomplete:${selected.invoice.id}`,
		})
		return null
	}
	const existing = creditNotes.find(isAccountDeletionCreditNote)
	if (existing) {
		return {
			created: false,
			refund: creditNoteToRefund(existing, input.subscriptionId),
		}
	}
	const maxRefundMinor = computeMaxRefundMinor(selected.invoice, creditNotes)
	if (maxRefundMinor <= 0) {
		console.info('account_deletion_refund_nothing_creditable', {
			subscriptionId: input.subscriptionId,
			invoiceId: selected.invoice.id,
			amountPaid: selected.invoice.amount_paid,
		})
		return null
	}

	try {
		const creditNote = await createProratedRefundCreditNote(input.env, {
			invoiceId: selected.invoice.id,
			subscriptionId: input.subscriptionId,
			lines,
			maxRefundMinor,
			reason: 'order_change',
		})
		switch (creditNote.outcome) {
			case 'issued':
				return {
					created: true,
					refund: {
						subscriptionId: input.subscriptionId,
						amountMinor: creditNote.total,
						currency: creditNote.currency,
						invoiceId: selected.invoice.id,
						creditNoteId: creditNote.id,
					},
				}
			case 'nothing_to_refund':
				console.info('account_deletion_refund_previewed_zero', {
					subscriptionId: input.subscriptionId,
				})
				return null
			case 'unfittable':
				console.warn('account_deletion_refund_unfittable', {
					invoiceId: selected.invoice.id,
					amountPaid: selected.invoice.amount_paid,
					maxRefundMinor,
					lastPreviewMinor: creditNote.lastPreviewMinor,
				})
				await auditSkippedRefund({
					env: input.env,
					email: input.email,
					reason: `unfittable:${selected.invoice.currency}:${maxRefundMinor}`,
				})
				return null
			default: {
				const unknownOutcome: never = creditNote
				throw new Error(
					`Unknown credit note outcome: ${JSON.stringify(unknownOutcome)}`,
				)
			}
		}
	} catch (error) {
		if (isStripeNothingToRefundError(error)) {
			console.info('account_deletion_refund_already_refunded', {
				subscriptionId: input.subscriptionId,
			})
			return null
		}
		// Ids and amounts only (no PII): enough to reconcile against the Stripe
		// dashboard when a rejection repeats.
		console.warn('account_deletion_refund_rejected', {
			subscriptionId: input.subscriptionId,
			invoiceId: selected.invoice.id,
			amountPaid: selected.invoice.amount_paid,
			maxRefundMinor,
			requestedMinor: lines.reduce((sum, line) => sum + line.amount, 0),
			error: getErrorMessage(error),
		})
		throw error
	}
}

/**
 * Adds every issued Kody deletion credit note for the customer that this run
 * did not already record, so a retry after a partial earlier attempt still
 * reports refunds for subscriptions that are no longer billable. Reporting
 * only: a listing failure never blocks the deletion.
 */
async function appendEarlierAccountDeletionRefunds(input: {
	env: Env
	customerId: string
	refunds: Array<AccountDeletionStripeRefund>
}) {
	let creditNotes: Array<StripeCreditNote>
	try {
		creditNotes = await listCreditNotesForCustomer(input.env, input.customerId)
	} catch (error) {
		console.warn('account_deletion_refund_report_incomplete', {
			error: getErrorMessage(error),
		})
		return
	}
	const known = new Set(input.refunds.map((refund) => refund.creditNoteId))
	for (const creditNote of creditNotes) {
		if (!isAccountDeletionCreditNote(creditNote)) continue
		if (known.has(creditNote.id)) continue
		known.add(creditNote.id)
		input.refunds.push(creditNoteToRefund(creditNote, null))
	}
}

/**
 * Refunds unused time on, then cancels, every **Kody** subscription that can
 * still bill (see `stripeSubscriptionStatusesCanceledOnAccountDeletion` and
 * {@link isKodySubscription}) and throws {@link AccountDeletionBillingError}
 * when any refund fails or any Kody subscription is still billable afterwards.
 * Non-Kody subscriptions on the shared Stripe account are left untouched.
 * Runs before any destructive cleanup so a Stripe outage retains the account
 * instead of leaving a paying customer with no account, no portal access, and
 * no refund.
 *
 * Only `active` and `trialing` subscriptions are refunded, and the refund is
 * issued before the cancel so the invoice line's service period is still
 * intact when Stripe prorates discounts and tax. A refund failure aborts
 * before the cancel, so the retry sees the same subscription and can try
 * again. A refund that cannot be bounded safely (see
 * {@link refundUnusedSubscriptionTime}) is skipped with an audit row instead,
 * and the cancel proceeds.
 *
 * Idempotent across retries: subscriptions Stripe already reports as
 * `canceled` are skipped, an invoice that already carries a Kody credit note
 * is not refunded twice, `cancelSubscription` treats `resource_missing` as
 * canceled, and a cancel that errors is re-verified against a fresh listing
 * (a subscription that flipped to canceled in between counts as success).
 * The returned refunds also include Kody credit notes from earlier attempts
 * so the report covers everything refunded for this deletion.
 */
async function cancelActiveStripeSubscriptions(input: {
	env: Env
	customerId: string
	email: string | null
}): Promise<{ canceled: number; refunds: Array<AccountDeletionStripeRefund> }> {
	let subscriptions: Array<StripeSubscription>
	try {
		subscriptions = await listSubscriptions(input.env, input.customerId)
	} catch (error) {
		throw new AccountDeletionBillingError([
			`Stripe subscriptions could not be listed: ${getErrorMessage(error)}`,
		])
	}
	// Shared Stripe account: only cancel Kody subscriptions. Never touch
	// other products on the same customer (for example GratiText Premium).
	const billable = subscriptions.filter(
		(subscription) =>
			isStripeSubscriptionBillable(subscription) &&
			isKodySubscription(input.env, subscription),
	)
	const refunds: Array<AccountDeletionStripeRefund> = []

	const nowSeconds = Math.floor(Date.now() / 1000)
	const failures: Array<string> = []
	let canceled = 0
	for (const subscription of billable) {
		if (isStripeSubscriptionRefundable(subscription)) {
			let refunded: Awaited<ReturnType<typeof refundUnusedSubscriptionTime>>
			try {
				refunded = await refundUnusedSubscriptionTime({
					env: input.env,
					subscriptionId: subscription.id,
					email: input.email,
					nowSeconds,
				})
			} catch (error) {
				throw new AccountDeletionBillingError([
					...failures,
					`Stripe subscription ${subscription.id} unused time could not be refunded: ${getErrorMessage(error)}`,
				])
			}
			if (refunded) {
				refunds.push(refunded.refund)
				if (refunded.created) {
					await logAuditEvent({
						db: auditDatabaseFromEnv(input.env),
						category: 'account',
						action: 'account_deletion_refund',
						result: 'success',
						email: input.email ?? undefined,
						reason: `${refunded.refund.currency}:${refunded.refund.amountMinor}`,
					})
				}
			}
		}
		try {
			await cancelSubscription(input.env, subscription.id)
			canceled += 1
		} catch (error) {
			failures.push(
				`Stripe subscription ${subscription.id} could not be canceled: ${getErrorMessage(error)}`,
			)
		}
	}

	if (failures.length > 0) {
		let stillBillable: Array<StripeSubscription>
		try {
			stillBillable = (
				await listSubscriptions(input.env, input.customerId)
			).filter(
				(subscription) =>
					isStripeSubscriptionBillable(subscription) &&
					isKodySubscription(input.env, subscription),
			)
		} catch (error) {
			throw new AccountDeletionBillingError([
				...failures,
				`Stripe subscriptions could not be re-verified: ${getErrorMessage(error)}`,
			])
		}
		if (stillBillable.length > 0) {
			throw new AccountDeletionBillingError(failures)
		}
		canceled = billable.length
	}

	await appendEarlierAccountDeletionRefunds({
		env: input.env,
		customerId: input.customerId,
		refunds,
	})
	return { canceled, refunds }
}

/**
 * Best-effort Stripe customer deletion after every subscription is already
 * canceled (see {@link cancelActiveStripeSubscriptions}). Failure here is a
 * warning only: nothing bills a customer with no billable subscription, and a
 * deleted Kody account has no path back to this customer id.
 */
async function deleteStripeCustomer(input: {
	env: Env
	customerId: string
	userId: OwnerId
	warnings: Array<string>
}) {
	try {
		await deleteCustomer(input.env, input.customerId)
	} catch (error) {
		const warning = `Stripe customer cleanup failed during account deletion: ${getErrorMessage(error)}`
		input.warnings.push(warning)
		console.error('account_deletion_stripe_cleanup_failed', {
			userId: input.userId,
			error,
		})
	}
}

async function clearStorageRunners(input: {
	env: Env
	userId: OwnerId
	storageIds: ReadonlyArray<string>
	warnings: Array<string>
}): Promise<number> {
	let cleared = 0
	for (const storageId of input.storageIds) {
		try {
			const stub = storageRunnerRpc({
				env: input.env,
				userId: input.userId,
				storageId,
			})
			await stub.clearStorage()
			cleared += 1
		} catch (error) {
			const message = getErrorMessage(error)
			input.warnings.push(
				`Storage runner clear failed for ${storageId}: ${message}`,
			)
		}
	}
	return cleared
}

async function cancelActiveWorkflowRuns(input: {
	env: Env
	userId: OwnerId
	warnings: Array<string>
}): Promise<boolean> {
	try {
		await cancelActiveWorkflowRunsForUser({
			env: input.env,
			userId: input.userId,
		})
		return true
	} catch (error) {
		input.warnings.push(
			`Workflow run cancellation failed: ${getErrorMessage(error)}`,
		)
		return false
	}
}

async function clearRunLog(input: {
	env: Env
	userId: OwnerId
	warnings: Array<string>
}): Promise<number> {
	try {
		if (!(input.env as Partial<Env>).RUN_LOG) {
			input.warnings.push(
				'RUN_LOG binding was unavailable; the user run log Durable Object was not purged.',
			)
			return 0
		}
		await clearRunRecords({ env: input.env, userId: input.userId })
		return 1
	} catch (error) {
		const message = getErrorMessage(error)
		input.warnings.push(`Run log clear failed: ${message}`)
		return 0
	}
}

async function purgeUserMeter(input: {
	env: Env
	userId: OwnerId
	warnings: Array<string>
}): Promise<number> {
	try {
		if (!userMeterNamespace(input.env)) {
			input.warnings.push(
				'USER_METER binding was unavailable; the user meter Durable Object was not purged.',
			)
			return 0
		}
		await userMeterRpc({ env: input.env, userId: input.userId }).purge()
		return 1
	} catch (error) {
		const message = getErrorMessage(error)
		input.warnings.push(`User meter purge failed: ${message}`)
		return 0
	}
}

async function purgeStripePlanRefresh(input: {
	env: Env
	userId: OwnerId
	warnings: Array<string>
}): Promise<number> {
	try {
		const result = await purgeStripePlanRefreshForUser({
			env: input.env,
			userId: input.userId,
		})
		if (!result.purged) {
			input.warnings.push(
				'STRIPE_PLAN_REFRESH binding was unavailable; the user Stripe refresh alarm was not purged.',
			)
		}
		return result.purged ? 1 : 0
	} catch (error) {
		const message = getErrorMessage(error)
		input.warnings.push(`Stripe plan refresh purge failed: ${message}`)
		return 0
	}
}

async function purgeMailbox(input: {
	env: Env
	userId: OwnerId
	warnings: Array<string>
}): Promise<number> {
	try {
		await mailboxRpc({ env: input.env, userId: input.userId }).purge({
			ownerId: input.userId,
		})
		return 1
	} catch (error) {
		const message = getErrorMessage(error)
		input.warnings.push(`Mailbox purge failed: ${message}`)
		return 0
	}
}

async function purgeJobManager(input: {
	env: Env
	userId: OwnerId
	warnings: Array<string>
}): Promise<number> {
	try {
		const result = await purgeJobManagerForUser({
			env: input.env,
			userId: input.userId,
		})
		if (!result.purged) {
			input.warnings.push(
				'JOBS service binding was unavailable; the user scheduler Durable Object was not purged.',
			)
		}
		return result.purged ? 1 : 0
	} catch (error) {
		const message = getErrorMessage(error)
		input.warnings.push(`Job manager purge failed: ${message}`)
		return 0
	}
}

async function purgeRepoSessions(input: {
	env: Env
	userId: OwnerId
	sessions: ReadonlyArray<UserRepoSessionSnapshot>
	warnings: Array<string>
}): Promise<number> {
	let purged = 0
	for (const session of input.sessions) {
		try {
			await repoSessionRpc(input.env, session.id).purgeSession({
				sessionId: session.id,
				userId: input.userId,
			})
			purged += 1
		} catch (error) {
			const message = getErrorMessage(error)
			input.warnings.push(
				`Repo session purge failed for ${session.id}: ${message}`,
			)
		}
	}
	return purged
}

async function purgeRepoSessionIndex(input: {
	env: Env
	userId: OwnerId
	warnings: Array<string>
}): Promise<number> {
	try {
		await repoSessionIndexRpc({
			env: input.env,
			userId: input.userId,
		}).purge({ ownerId: input.userId })
		return 1
	} catch (error) {
		const message = getErrorMessage(error)
		input.warnings.push(`Repo session index purge failed: ${message}`)
		return 0
	}
}

async function purgeMcpClientHub(input: {
	env: Env
	userId: OwnerId
	warnings: Array<string>
}): Promise<number> {
	// Always purge, even when no mcp_server_settings rows remain: the hub DO
	// can still hold OAuth tokens and SDK registrations (for example after a
	// failed add), and those must not survive account deletion.
	const namespace = input.env.MCP_CLIENT_HUB
	if (!namespace) {
		input.warnings.push(
			'MCP_CLIENT_HUB binding was unavailable; the MCP client hub was not purged.',
		)
		return 0
	}
	try {
		const stub = namespace.get(
			namespace.idFromName(mcpClientHubDurableObjectName(input.userId)),
		) as unknown as {
			purgeForAccountDeletion: () => Promise<void>
		}
		await stub.purgeForAccountDeletion()
		return 1
	} catch (error) {
		const message = getErrorMessage(error)
		input.warnings.push(`MCP client hub purge failed: ${message}`)
		return 0
	}
}

async function purgeMcpAgentSessions(input: {
	env: Env
	userId: OwnerId
	sessions: ReadonlyArray<McpAgentSession>
	warnings: Array<string>
}) {
	const namespace = input.env.MCP_OBJECT
	if (!namespace) {
		if (input.sessions.length > 0) {
			input.warnings.push(
				`MCP_OBJECT binding was unavailable; ${input.sessions.length} MCP agent session(s) were not purged.`,
			)
		}
		return 0
	}
	let purged = 0
	for (const session of input.sessions) {
		try {
			const stub = namespace.get(
				namespace.idFromString(session.doId),
			) as unknown as {
				purgeForAccountDeletion: (payload: { userId: OwnerId }) => Promise<void>
			}
			await stub.purgeForAccountDeletion({ userId: input.userId })
			purged += 1
		} catch (error) {
			input.warnings.push(
				`MCP agent session purge failed for ${session.doId}: ${getErrorMessage(error)}`,
			)
		}
	}
	return purged
}

async function purgePackageRealtimeSessions(input: {
	env: Env
	userId: OwnerId
	packages: ReadonlyArray<UserSavedPackageSnapshot>
	warnings: Array<string>
}): Promise<number> {
	let purged = 0
	for (const savedPackage of input.packages.filter((pkg) => pkg.hasApp)) {
		try {
			await packageRealtimeSessionRpc({
				env: input.env,
				userId: input.userId,
				packageId: savedPackage.id,
				kodyId: savedPackage.kodyId,
				sourceId: savedPackage.sourceId,
				baseUrl: 'https://account-deletion.invalid',
			}).purge()
			purged += 1
		} catch (error) {
			const message = getErrorMessage(error)
			input.warnings.push(
				`Package realtime session purge failed for ${savedPackage.id}: ${message}`,
			)
		}
	}
	return purged
}

async function deleteVectorsByIds(input: {
	env: Env
	ids: ReadonlyArray<string>
	warnings: Array<string>
}): Promise<number> {
	if (input.ids.length === 0) return 0
	const index = getCapabilityVectorIndex(input.env)
	if (!index) {
		input.warnings.push(
			`CAPABILITY_VECTOR_INDEX binding was unavailable; ${input.ids.length} user vector(s) were not removed.`,
		)
		return 0
	}
	let deleted = 0
	const batchSize = 100
	for (let offset = 0; offset < input.ids.length; offset += batchSize) {
		const batch = input.ids.slice(offset, offset + batchSize)
		try {
			await index.deleteByIds(batch)
			deleted += batch.length
		} catch (error) {
			const message = getErrorMessage(error)
			input.warnings.push(`Vectorize deleteByIds batch failed: ${message}`)
		}
	}
	return deleted
}

async function deleteKvKeys(input: {
	kv: KVNamespace
	keys: ReadonlyArray<string>
	warnings: Array<string>
}): Promise<number> {
	let deleted = 0
	for (const key of input.keys) {
		try {
			await input.kv.delete(key)
			deleted += 1
		} catch (error) {
			const message = getErrorMessage(error)
			input.warnings.push(`KV delete failed for ${key}: ${message}`)
		}
	}
	return deleted
}

async function deleteR2Objects(input: {
	blobs: R2Bucket
	keys: ReadonlyArray<string>
	label: string
	warnings: Array<string>
}): Promise<{ deleted: number; complete: boolean }> {
	let deleted = 0
	let complete = true
	for (const key of input.keys) {
		try {
			await input.blobs.delete(key)
			deleted += 1
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			input.warnings.push(`${input.label} delete failed for ${key}: ${message}`)
			complete = false
		}
	}
	return { deleted, complete }
}

type AccountEmailCleanupOutcome = {
	deletedEmailBlobs: number
	emailCleanupComplete: boolean
}

async function cleanupAccountEmailBlobs(input: {
	env: Env
	userId: OwnerId
	r2Objects: ReadonlyArray<AccountR2ObjectRef>
	warnings: Array<string>
}): Promise<AccountEmailCleanupOutcome> {
	const emailBlobs = input.env.EMAIL_BLOBS
	if (!emailBlobs) {
		input.warnings.push(
			'EMAIL_BLOBS binding was unavailable; email objects were not removed.',
		)
		return { deletedEmailBlobs: 0, emailCleanupComplete: false }
	}

	let deletedEmailBlobs = 0
	let emailCleanupComplete = true
	try {
		deletedEmailBlobs = await deleteAccountEmailBlobPrefixes({
			bucket: emailBlobs,
			stableUserId: input.userId,
		})
	} catch (error) {
		input.warnings.push(getErrorMessage(error))
		emailCleanupComplete = false
	}
	const exactDeletes = await deleteR2Objects({
		blobs: emailBlobs,
		keys: input.r2Objects
			.filter((object) => object.binding === 'EMAIL_BLOBS')
			.filter(
				(object) =>
					!object.key.startsWith(`email-raw:v1:${input.userId}/`) &&
					!object.key.startsWith(`email-attachment:v1:${input.userId}/`),
			)
			.map((object) => object.key),
		label: 'Email blob',
		warnings: input.warnings,
	})
	deletedEmailBlobs += exactDeletes.deleted
	return {
		deletedEmailBlobs,
		emailCleanupComplete: emailCleanupComplete && exactDeletes.complete,
	}
}

async function listKvKeysByPrefix(input: {
	kv: KVNamespace
	prefixes: ReadonlyArray<string>
	warnings: Array<string>
}) {
	const keys = new Set<string>()
	if (typeof input.kv.list !== 'function') return keys
	for (const prefix of input.prefixes) {
		let cursor: string | undefined
		do {
			try {
				const result = await input.kv.list({
					prefix,
					cursor,
				})
				for (const key of result.keys) {
					keys.add(key.name)
				}
				cursor = result.list_complete ? undefined : result.cursor
			} catch (error) {
				const message = getErrorMessage(error)
				input.warnings.push(
					`KV prefix listing failed for ${prefix}: ${message}`,
				)
				cursor = undefined
			}
		} while (cursor)
	}
	return keys
}

async function deletePackageSkillsIndexCache(input: {
	env: Env
	userId: OwnerId
	warnings: Array<string>
}) {
	let deleted = 0
	try {
		deleted = await deleteAllPackageSkillsIndexEntriesForUser({
			env: input.env,
			userId: input.userId,
		})
	} catch (error) {
		const message = getErrorMessage(error)
		input.warnings.push(`Package skills index KV cleanup failed: ${message}`)
	}
	try {
		await deletePackageSubscriptionTopicCacheForUser({
			env: input.env,
			userId: input.userId,
		})
	} catch (error) {
		const message = getErrorMessage(error)
		input.warnings.push(
			`Package subscription topic map KV cleanup failed: ${message}`,
		)
	}
	return deleted
}

async function deleteUserScopedRowsAndUser(input: {
	env: Env
	mcpUserId: OwnerId
	dbUserId: number
	/** Person id when it may differ from the personal org / storage owner. */
	personUserId?: string
	/** When true, delete a soft-deleted users row (purge lane). */
	allowSoftDeletedUser?: boolean
}): Promise<{
	deletedRowCounts: Record<string, number>
	updatedRowCounts: Record<string, number>
}> {
	const deletedRowCounts: Record<string, number> = {}
	const updatedRowCounts: Record<string, number> = {}
	function recordDeleted(tableName: string, changes: number | undefined) {
		deletedRowCounts[tableName] =
			(deletedRowCounts[tableName] ?? 0) + (changes ?? 0)
	}
	function recordUpdated(tableName: string, changes: number | undefined) {
		updatedRowCounts[tableName] =
			(updatedRowCounts[tableName] ?? 0) + (changes ?? 0)
	}
	const operations = hardPurgeDataTargets('person').map((target) => {
		const match = buildUserScopedTargetMatch({
			target,
			mcpUserId: input.mcpUserId,
			dbUserId: input.dbUserId,
			personUserId: input.personUserId,
		})
		const { sql, params } = buildUserScopedDeleteOrUpdateSql(match)
		return {
			match,
			statement: input.env.APP_DB.prepare(sql).bind(...params),
		}
	})
	const userStatement = input.env.APP_DB.prepare(
		input.allowSoftDeletedUser
			? `DELETE FROM users WHERE id = ? AND deleted_at IS NOT NULL`
			: `DELETE FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
	).bind(input.dbUserId)
	const results = await input.env.APP_DB.batch([
		...operations.map((operation) => operation.statement),
		userStatement,
	])
	for (const [index, operation] of operations.entries()) {
		const changes = results[index]?.meta.changes
		if (operation.match.mutation.kind === 'delete') {
			recordDeleted(operation.match.table, changes)
		} else {
			recordUpdated(operation.match.table, changes)
		}
	}
	deletedRowCounts.users = results.at(-1)?.meta.changes ?? 0
	invalidatePackageAppOwnerCache({ stableUserId: input.mcpUserId })
	return { deletedRowCounts, updatedRowCounts }
}

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
 * Collect the same out-of-band identifiers account deletion collects for an
 * owner id, delete those objects, then return. Does not delete D1 projection
 * rows, cancel Stripe, or revoke person OAuth clients — callers that need
 * those (account deletion) run them around this step. Team org hard purge
 * calls this before deleting owner-scoped D1 rows (#3121).
 *
 * Omit `dbUserId` for team orgs (no person row). Inventory still enumerates
 * owner-scoped KV/R2/Vectorize/Artifacts/DO surfaces keyed by `ownerId`.
 */
export async function purgeOwnerOutOfBandSurfaces(input: {
	env: AccountDeletionEnv
	ownerId: OwnerId
	dbUserId?: number
}): Promise<AccountDeletionResult> {
	const warnings: Array<string> = []
	const result = emptyAccountDeletionResult(warnings)
	const dbUserId = input.dbUserId ?? -1

	const inventory = await collectUserDeletionInventory({
		env: input.env,
		userId: input.ownerId,
		dbUserId,
		warnings,
	})

	const workflowRunsCancelled = await cancelActiveWorkflowRuns({
		env: input.env,
		userId: input.ownerId,
		warnings,
	})
	if (!workflowRunsCancelled) {
		throw new AccountDeletionCleanupError(warnings, result)
	}

	result.deletedVectors = await deleteVectorsByIds({
		env: input.env,
		ids: inventory.vectorIds,
		warnings,
	})

	result.deletedArtifactRepos = await cleanupAllUserArtifactRepos({
		env: input.env,
		userId: input.ownerId,
		warnings,
	}).catch((error) => {
		const message = getErrorMessage(error)
		warnings.push(`Artifact repo cleanup failed unexpectedly: ${message}`)
		return 0
	})

	result.clearedDurableObjects.repoSessions = await purgeRepoSessions({
		env: input.env,
		userId: input.ownerId,
		sessions: inventory.repoSessions,
		warnings,
	})
	result.clearedDurableObjects.repoSessionIndexes = await purgeRepoSessionIndex(
		{
			env: input.env,
			userId: input.ownerId,
			warnings,
		},
	)
	result.clearedDurableObjects.mcpClientHubs = await purgeMcpClientHub({
		env: input.env,
		userId: input.ownerId,
		warnings,
	})
	result.clearedDurableObjects.mcpAgentSessions = await purgeMcpAgentSessions({
		env: input.env,
		userId: input.ownerId,
		sessions: inventory.mcpAgentSessions,
		warnings,
	})
	result.clearedDurableObjects.packageRealtimeSessions =
		await purgePackageRealtimeSessions({
			env: input.env,
			userId: input.ownerId,
			packages: inventory.savedPackages,
			warnings,
		})
	result.clearedDurableObjects.storageRunners = await clearStorageRunners({
		env: input.env,
		userId: input.ownerId,
		storageIds: inventory.storageIds,
		warnings,
	})
	result.clearedDurableObjects.runLogs = await clearRunLog({
		env: input.env,
		userId: input.ownerId,
		warnings,
	})
	result.clearedDurableObjects.userMeters = await purgeUserMeter({
		env: input.env,
		userId: input.ownerId,
		warnings,
	})
	result.clearedDurableObjects.stripePlanRefreshes =
		await purgeStripePlanRefresh({
			env: input.env,
			userId: input.ownerId,
			warnings,
		})

	if (input.env.BUNDLE_ARTIFACTS_KV) {
		const sourceSnapshotKeys = await listKvKeysByPrefix({
			kv: input.env.BUNDLE_ARTIFACTS_KV,
			prefixes: [
				...inventory.sourceSnapshots.flatMap((source) => [
					`source-snapshot:v1:${source.sourceId}:`,
					`source-manifest-snapshot:v1:${source.sourceId}:`,
					`credential-needs:v1:${source.sourceId}:`,
					`credential-stamp:v1:${source.sourceId}:`,
				]),
				...inventory.communityListings.flatMap((listing) =>
					communityIconKvListingPrefixes(listing.id),
				),
				...inventory.sourceSnapshots.flatMap((source) =>
					identityIconKvRepoPrefixes(source.repoId),
				),
				`package-codemod-revert:${input.ownerId}:`,
				...mcpOAuthRefreshFamilyUserKvPrefixes(input.ownerId),
			],
			warnings,
		})
		result.deletedKvKeys =
			(await deleteKvKeys({
				kv: input.env.BUNDLE_ARTIFACTS_KV,
				keys: Array.from(
					new Set([...inventory.bundleKvKeys, ...sourceSnapshotKeys]),
				),
				warnings,
			})) +
			(await deletePackageSkillsIndexCache({
				env: input.env,
				userId: input.ownerId,
				warnings,
			}))
	} else if (
		inventory.bundleKvKeys.length > 0 ||
		inventory.savedPackages.length > 0
	) {
		warnings.push(
			`BUNDLE_ARTIFACTS_KV binding was unavailable; ${inventory.bundleKvKeys.length} bundle/source/community key(s) for ${inventory.savedPackages.length} package(s) referenced by the deleted user were not removed and must be cleaned up manually.`,
		)
	}

	try {
		result.deletedCommunityAssets = await deleteAccountCommunityAssetPrefixes({
			bucket: input.env.COMMUNITY_ASSETS,
			stableUserId: input.ownerId,
			listingIds: inventory.communityListings.map((listing) => listing.id),
			repoIds: inventory.sourceSnapshots.map((source) => source.repoId),
		})
	} catch (error) {
		warnings.push(getErrorMessage(error))
	}
	const emailCleanup = await cleanupAccountEmailBlobs({
		env: input.env,
		userId: input.ownerId,
		r2Objects: inventory.r2Objects,
		warnings,
	})
	result.deletedEmailBlobs = emailCleanup.deletedEmailBlobs
	if (input.env.OPERATOR_BACKUPS) {
		try {
			await deleteOrgTransferBackupsForOwner({
				bucket: input.env.OPERATOR_BACKUPS,
				ownerId: input.ownerId,
			})
		} catch (error) {
			warnings.push(
				`Org transfer backup cleanup failed: ${getErrorMessage(error)}`,
			)
		}
	}

	if (emailCleanup.emailCleanupComplete && warnings.length === 0) {
		result.clearedDurableObjects.mailboxes = await purgeMailbox({
			env: input.env,
			userId: input.ownerId,
			warnings,
		})
	}

	if (warnings.length > 0) {
		throw new AccountDeletionCleanupError(warnings, result)
	}

	result.clearedDurableObjects.jobManagers = await purgeJobManager({
		env: input.env,
		userId: input.ownerId,
		warnings,
	})
	if (warnings.length > 0) {
		throw new AccountDeletionCleanupError(warnings, result)
	}

	return result
}

/**
 * Orchestrate a full per-user data cleanup. The caller is responsible for
 * verifying the user's identity before invoking this; the orchestrator does
 * not re-authenticate.
 *
 * The cleanup ordering is:
 *   1. Pre-collect identifiers we need (vector ids, storage ids, KV keys,
 *      repo/session/package ids) while their owning rows still exist.
 *   2. Cancel active Stripe subscriptions. Like inventory, a failure here
 *      releases the deletion fence and retains the account untouched.
 *   3. Idempotent cleanup of out-of-band stores and OAuth grants.
 *   4. Abort while preserving D1 inventory and the user row if any critical
 *      cleanup failed. The five-minute usage-rollup derived cache is the sole
 *      TTL-owned omission and does not participate in this gate.
 *   5. Atomically delete user-scoped D1 rows and the user row in one batch.
 */
export async function deleteUserAccount(input: {
	env: AccountDeletionEnv
	dbUserId: number
	/**
	 * Storage / personal org OwnerId. Out-of-band surfaces (KV, DO, R2,
	 * Vectorize, packages) and org-keyed D1 rows use this id.
	 */
	mcpUserId: OwnerId
	/**
	 * Person id when it may differ from {@link mcpUserId}. Person-keyed D1
	 * rows (tokens, referrals, …) match either id so distinct personal orgs
	 * do not leave person records behind. Defaults to mcpUserId.
	 */
	personUserId?: string
	/**
	 * Purge lane: the account is already soft-deleted and claimed via
	 * `deleting_at`. Skip the live deletion fence and remove the tombstoned
	 * users row.
	 */
	purgeSoftDeleted?: boolean
}): Promise<AccountDeletionResult> {
	const personUserId = input.personUserId ?? input.mcpUserId
	const purgeSoftDeleted = input.purgeSoftDeleted === true
	let marked: {
		leaseCount: number
		created: boolean
		deletingAt: string
	}
	if (purgeSoftDeleted) {
		const tombstone = await input.env.APP_DB.prepare(
			`SELECT deleting_at
			 FROM users
			 WHERE id = ? AND deleted_at IS NOT NULL`,
		)
			.bind(input.dbUserId)
			.first<{ deleting_at: string | null }>()
		if (!tombstone) {
			throw new Error(
				`Account ${input.mcpUserId} is not soft-deleted for purge.`,
			)
		}
		marked = {
			leaseCount: 0,
			created: false,
			deletingAt: tombstone.deleting_at ?? new Date().toISOString(),
		}
	} else {
		marked = await markAccountDeleting({
			db: input.env.APP_DB,
			dbUserId: input.dbUserId,
			env: input.env,
		})
		if (marked.leaseCount > 0) {
			if (marked.created) {
				await abortAccountDeleting({
					db: input.env.APP_DB,
					dbUserId: input.dbUserId,
					env: input.env,
					expectedDeletingAt: marked.deletingAt,
				})
			}
			throw new AccountDeletionWritersActiveError(marked.leaseCount)
		}
	}
	const warnings: Array<string> = []
	const clearedDurableObjects: Record<string, number> = {}
	for (const key of getAccountDeletionDurableObjectResultKeys()) {
		clearedDurableObjects[key] = 0
	}
	const result: AccountDeletionResult = {
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

	let inventory: UserDeletionInventory
	try {
		inventory = await collectUserDeletionInventory({
			env: input.env,
			userId: input.mcpUserId,
			dbUserId: input.dbUserId,
			warnings,
		})
	} catch (error) {
		if (error instanceof AccountDeletionInventoryError && marked.created) {
			await abortAccountDeleting({
				db: input.env.APP_DB,
				dbUserId: input.dbUserId,
				env: input.env,
				expectedDeletingAt: marked.deletingAt,
			})
		}
		throw error
	}

	// Billing is a precondition of deletion, checked before anything
	// destructive: if Stripe cannot refund unused time or confirm every
	// subscription is canceled the account (and its portal access) must survive
	// so the customer is not billed for an account that no longer exists.
	if (inventory.stripeCustomerId) {
		try {
			const billing = await cancelActiveStripeSubscriptions({
				env: input.env,
				customerId: inventory.stripeCustomerId,
				email: inventory.email,
			})
			result.stripeRefunds = billing.refunds
		} catch (error) {
			if (error instanceof AccountDeletionBillingError) {
				console.error('account_deletion_billing_cancel_failed', {
					userId: input.mcpUserId,
					billingErrors: error.billingErrors,
				})
				if (marked.created) {
					await abortAccountDeleting({
						db: input.env.APP_DB,
						dbUserId: input.dbUserId,
						env: input.env,
						expectedDeletingAt: marked.deletingAt,
					})
				}
			}
			throw error
		}
	}

	// Stop running package workflows before purging the storage their steps
	// write to. On failure, stop with the deletion fence held and nothing
	// purged: RunLog is the only index of the user's workflow instances, so a
	// retry needs it to find and terminate them.
	const workflowRunsCancelled = await cancelActiveWorkflowRuns({
		env: input.env,
		userId: input.mcpUserId,
		warnings,
	})
	if (!workflowRunsCancelled) {
		throw new AccountDeletionCleanupError(warnings, result)
	}

	result.deletedVectors = await deleteVectorsByIds({
		env: input.env,
		ids: inventory.vectorIds,
		warnings,
	})

	result.deletedArtifactRepos = await cleanupAllUserArtifactRepos({
		env: input.env,
		userId: input.mcpUserId,
		warnings,
	}).catch((error) => {
		const message = getErrorMessage(error)
		warnings.push(`Artifact repo cleanup failed unexpectedly: ${message}`)
		return 0
	})

	result.clearedDurableObjects.repoSessions = await purgeRepoSessions({
		env: input.env,
		userId: input.mcpUserId,
		sessions: inventory.repoSessions,
		warnings,
	})
	result.clearedDurableObjects.repoSessionIndexes = await purgeRepoSessionIndex(
		{
			env: input.env,
			userId: input.mcpUserId,
			warnings,
		},
	)
	result.clearedDurableObjects.mcpClientHubs = await purgeMcpClientHub({
		env: input.env,
		userId: input.mcpUserId,
		warnings,
	})
	result.clearedDurableObjects.mcpAgentSessions = await purgeMcpAgentSessions({
		env: input.env,
		userId: input.mcpUserId,
		sessions: inventory.mcpAgentSessions,
		warnings,
	})
	result.clearedDurableObjects.packageRealtimeSessions =
		await purgePackageRealtimeSessions({
			env: input.env,
			userId: input.mcpUserId,
			packages: inventory.savedPackages,
			warnings,
		})
	result.clearedDurableObjects.storageRunners = await clearStorageRunners({
		env: input.env,
		userId: input.mcpUserId,
		storageIds: inventory.storageIds,
		warnings,
	})
	result.clearedDurableObjects.runLogs = await clearRunLog({
		env: input.env,
		userId: input.mcpUserId,
		warnings,
	})
	result.clearedDurableObjects.userMeters = await purgeUserMeter({
		env: input.env,
		userId: input.mcpUserId,
		warnings,
	})
	result.clearedDurableObjects.stripePlanRefreshes =
		await purgeStripePlanRefresh({
			env: input.env,
			userId: input.mcpUserId,
			warnings,
		})
	if (input.env.BUNDLE_ARTIFACTS_KV) {
		const sourceSnapshotKeys = await listKvKeysByPrefix({
			kv: input.env.BUNDLE_ARTIFACTS_KV,
			prefixes: [
				...inventory.sourceSnapshots.flatMap((source) => [
					`source-snapshot:v1:${source.sourceId}:`,
					`source-manifest-snapshot:v1:${source.sourceId}:`,
					`credential-needs:v1:${source.sourceId}:`,
					`credential-stamp:v1:${source.sourceId}:`,
				]),
				...inventory.communityListings.flatMap((listing) =>
					communityIconKvListingPrefixes(listing.id),
				),
				...inventory.sourceSnapshots.flatMap((source) =>
					identityIconKvRepoPrefixes(source.repoId),
				),
				// Package-codemod apply snapshots are user-namespaced in KV
				// (`package-codemod-revert:{userId}:{itemId}`). D1 run items are
				// deleted separately; purge the orphaned revert trees here rather
				// than waiting on the 90-day TTL.
				`package-codemod-revert:${input.mcpUserId}:`,
				// Encrypted copies of the user's MCP OAuth tokens.
				...mcpOAuthRefreshFamilyUserKvPrefixes(input.mcpUserId),
			],
			warnings,
		})
		result.deletedKvKeys =
			(await deleteKvKeys({
				kv: input.env.BUNDLE_ARTIFACTS_KV,
				keys: Array.from(
					new Set([...inventory.bundleKvKeys, ...sourceSnapshotKeys]),
				),
				warnings,
			})) +
			(await deletePackageSkillsIndexCache({
				env: input.env,
				userId: input.mcpUserId,
				warnings,
			}))
	} else if (
		inventory.bundleKvKeys.length > 0 ||
		inventory.savedPackages.length > 0
	) {
		warnings.push(
			`BUNDLE_ARTIFACTS_KV binding was unavailable; ${inventory.bundleKvKeys.length} bundle/source/community key(s) for ${inventory.savedPackages.length} package(s) referenced by the deleted user were not removed and must be cleaned up manually.`,
		)
	}

	try {
		result.deletedCommunityAssets = await deleteAccountCommunityAssetPrefixes({
			bucket: input.env.COMMUNITY_ASSETS,
			stableUserId: input.mcpUserId,
			listingIds: inventory.communityListings.map((listing) => listing.id),
			repoIds: inventory.sourceSnapshots.map((source) => source.repoId),
		})
	} catch (error) {
		warnings.push(getErrorMessage(error))
	}
	const emailCleanup = await cleanupAccountEmailBlobs({
		env: input.env,
		userId: input.mcpUserId,
		r2Objects: inventory.r2Objects,
		warnings,
	})
	result.deletedEmailBlobs = emailCleanup.deletedEmailBlobs
	if (input.env.OPERATOR_BACKUPS) {
		try {
			await deleteOrgTransferBackupsForOwner({
				bucket: input.env.OPERATOR_BACKUPS,
				ownerId: input.mcpUserId,
			})
		} catch (error) {
			warnings.push(
				`Org transfer backup cleanup failed: ${getErrorMessage(error)}`,
			)
		}
	}

	const discordConnection = await input.env.APP_DB.prepare(
		`SELECT provider_id FROM oauth_connections
		 WHERE user_id = ? AND provider_name = 'discord'`,
	)
		.bind(input.dbUserId)
		.first<{ provider_id: string }>()
		.catch((error) => {
			warnings.push(
				`Discord connection lookup failed: ${getErrorMessage(error)}`,
			)
			return null
		})
	if (discordConnection?.provider_id) {
		const discordRoleCleanup = await maybeRemoveDiscordGuildRoles({
			env: input.env,
			discordUserId: discordConnection.provider_id,
		})
		const discordRoleResult = summarizeDiscordGuildRoleSync(discordRoleCleanup)
		if (
			discordRoleResult.status === 'error' ||
			discordRoleResult.status === 'forbidden'
		) {
			warnings.push(
				discordRoleResult.status === 'error'
					? `Discord role cleanup failed: ${discordRoleResult.message}`
					: 'Discord role cleanup was forbidden.',
			)
		}
	}

	// Outside the provider's fetch wrapper (hourly unverified-account purge via
	// `JobsHost.runScheduledLane`, admin MCP capability on kody-platform) this
	// builds the same helpers through the library's `getOAuthApi`.
	const helpers: OAuthHelpersShape | undefined = await resolveOAuthHelpers(
		input.env,
	)
	if (helpers) {
		if (helpers.deleteClient) {
			// The provider's OAuthHelpersImpl methods read `this.env`; a detached
			// reference throws "Cannot read properties of undefined (reading 'env')".
			const deleteClient = helpers.deleteClient.bind(helpers)
			await deleteOwnedMcpOauthClients({
				db: input.env.APP_DB,
				helpers: {
					async deleteClient(clientId) {
						await deleteClient(clientId)
					},
				},
				userId: input.dbUserId,
				warnings,
			})
		} else {
			const ownedClientIds = await listOwnedUserMcpOauthClientIds(
				input.env.APP_DB,
				input.dbUserId,
			)
			if (ownedClientIds.length > 0) {
				warnings.push(
					'OAuth provider does not support client deletion; MCP OAuth clients were not removed.',
				)
			}
		}
		try {
			result.revokedOAuthGrants = await revokeAllOAuthGrantsBestEffort({
				helpers,
				userId: input.mcpUserId,
				warnings,
			})
		} catch (error) {
			const message = getErrorMessage(error)
			warnings.push(`OAuth grant revocation failed unexpectedly: ${message}`)
		}
	} else {
		warnings.push(
			'OAuth provider binding and OAUTH_KV were unavailable; OAuth grants were not revoked.',
		)
	}

	// Keep Mailbox metadata while the account remains deletion-fenced so a retry
	// can re-enumerate authoritative email keys. The typed email phase prevents
	// an unrelated warning-list refactor from purging after incomplete email
	// cleanup; the existing all-surfaces policy additionally requires no warning.
	if (emailCleanup.emailCleanupComplete && warnings.length === 0) {
		result.clearedDurableObjects.mailboxes = await purgeMailbox({
			env: input.env,
			userId: input.mcpUserId,
			warnings,
		})
	}

	if (warnings.length > 0) {
		throw new AccountDeletionCleanupError(warnings, result)
	}

	// Jobs data lives in the jobs worker's database (ADR 0016), so it cannot
	// join the atomic APP_DB deletion below. Purge it fail-closed here, after
	// every best-effort cleanup succeeded; a failure aborts before the user row
	// is removed so a retry can purge again (purgeUser is idempotent).
	result.clearedDurableObjects.jobManagers = await purgeJobManager({
		env: input.env,
		userId: input.mcpUserId,
		warnings,
	})
	if (warnings.length > 0) {
		throw new AccountDeletionCleanupError(warnings, result)
	}

	if (inventory.stripeCustomerId) {
		await deleteStripeCustomer({
			env: input.env,
			customerId: inventory.stripeCustomerId,
			userId: input.mcpUserId,
			warnings,
		})
	}

	try {
		const d1Cleanup = await deleteUserScopedRowsAndUser({
			env: input.env,
			mcpUserId: input.mcpUserId,
			dbUserId: input.dbUserId,
			personUserId,
			allowSoftDeletedUser: purgeSoftDeleted,
		})
		result.deletedRowCounts = {
			...result.deletedRowCounts,
			...d1Cleanup.deletedRowCounts,
		}
		result.updatedRowCounts = d1Cleanup.updatedRowCounts
		if (purgeSoftDeleted && (d1Cleanup.deletedRowCounts.users ?? 0) === 0) {
			throw new Error(
				`Soft-deleted user row was not removed for ${input.mcpUserId}.`,
			)
		}
	} catch (error) {
		const failure = `Atomic D1 account deletion failed: ${getErrorMessage(error)}`
		warnings.push(failure)
		throw new AccountDeletionCleanupError(warnings, result)
	}

	// The D1 user row is gone. Drop the UserMeter tombstone `purge()` restored
	// so the purged object keeps no state for this stable id.
	try {
		await clearUserMeterDeletionTombstone({
			env: input.env,
			stableUserId: input.mcpUserId,
		})
	} catch (error) {
		console.error('account_deletion_user_meter_tombstone_clear_failed', {
			userId: input.mcpUserId,
			error,
		})
	}

	return result
}
