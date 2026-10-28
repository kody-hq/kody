import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { getRecoveryBookmark, restoreToBookmark } from '#worker/dr/do-pitr.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import {
	type EmailDeliveryEventType,
	type EmailDeliveryStatus,
} from './types.ts'
import {
	canonicalMailboxMessageBlobReferences,
	deleteMailboxBlobKeys,
} from './mailbox-retention.ts'
import { MailboxMaintenanceCommands } from './mailbox-maintenance-commands.ts'
import { MailboxGraphCommitCommands } from './mailbox-graph-commit-commands.ts'
import { MailboxInboundCommands } from './mailbox-inbound-commands.ts'
import { MailboxStore } from './mailbox-store.ts'
import {
	deleteMailboxDeliveryEvent,
	deleteMailboxThreadIfEmpty,
	setMailboxMessageClassification,
	touchMailboxThread,
	updateMailboxMessageDelivery,
} from './mailbox-mutations.ts'
import { findDeliveryEventByProviderEventId } from './mailbox-delivery-events.ts'
import {
	deleteMailboxMessageMetadataWithTombstone,
	tombstoneMissingMailboxMessage,
} from './mailbox-message-deletion-tombstones.ts'
import { upsertMailboxDeliveryEvents } from './mailbox-delivery-event-upsert.ts'
import { shouldSkipMailboxDeliveryEventWrite } from './mailbox-inbound-bootstrap.ts'
import {
	type MailboxInboundDeliveryInsertInput,
	type MailboxInboundDeliverySnapshot,
} from './mailbox-inbound-ledger.ts'
import {
	assertMailboxNonEmptyString,
	type MailboxAttachmentInput,
	type MailboxAttachmentRecord,
	type MailboxBlobReferencePage,
	type MailboxCountMessagesInput,
	type MailboxCountResult,
	type MailboxCommitInboundMessageGraphResult,
	type MailboxCommitOutboundTerminalInput,
	type MailboxDeleteDeliveryEventInput,
	type MailboxDeleteMessageWithBlobsResult,
	type MailboxDeleteMessageMetadataInput,
	type MailboxDeleteResult,
	type MailboxDeleteThreadIfEmptyInput,
	type MailboxDeliveryEventInput,
	type MailboxDeliveryEventRecord,
	type MailboxExportResult,
	type MailboxInboundDeliveryState,
	type MailboxListMessagesInput,
	type MailboxMessageInput,
	type MailboxMessageRecord,
	type MailboxPartialMutationResult,
	type MailboxRpc,
	type MailboxRunRetentionNowResult,
	type MailboxSearchMessagesInput,
	type MailboxSetMessageClassificationInput,
	type MailboxThreadInput,
	type MailboxThreadRecord,
	type MailboxTombstoneMissingMessageResult,
	type MailboxTouchThreadInput,
	type MailboxUpdateMessageDeliveryInput,
	type MailboxUpsertDeliveryEventsResult,
	type MailboxUpsertMessageGraphInput,
} from './mailbox-types.ts'

/**
 * Per-owner Mailbox Durable Object: SQLite metadata for threads, messages,
 * attachments, and delivery events. Object identity is ownership — no
 * `user_id` columns on data rows. Owner binding for blob-key validation is
 * a singleton identity row (DO name is not introspectable). Raw MIME /
 * external attachment bytes stay in `EMAIL_BLOBS`; rows retain keys.
 * `system:email` stays in D1 by design.
 *
 * USER graph reads/writes and inbound ledger/effect transitions are
 * authoritative here; `system:email` remains on its dedicated D1 graph.
 */

class MailboxBase extends DurableObject<Env> implements MailboxRpc {
	private readonly store: MailboxStore
	private readonly maintenance: MailboxMaintenanceCommands
	private readonly graphCommits: MailboxGraphCommitCommands
	private readonly inbound: MailboxInboundCommands

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.store = new MailboxStore(ctx.storage)
		this.maintenance = new MailboxMaintenanceCommands(ctx, env, this.store)
		this.graphCommits = new MailboxGraphCommitCommands(
			ctx,
			this.store,
			this.maintenance,
		)
		this.inbound = new MailboxInboundCommands(ctx, this.store, this.maintenance)
		this.ctx.blockConcurrencyWhile(async () => {
			this.store.initializeSchema()
			await this.maintenance.initializeAlarmState()
		})
	}

	private assertReadable(): void {
		this.store.assertReadable()
	}

	async alarm(): Promise<void> {
		await this.maintenance.blockConcurrencySafely(async () => {
			if (this.store.isRestorePending()) return
			await this.maintenance.alarm()
		})
	}

	async getRecoveryBookmark(input: {
		timestampMs: number
	}): Promise<{ bookmark: string }> {
		return await getRecoveryBookmark(this.ctx, input, {
			environment: this.env,
		})
	}

	async restoreToBookmark(input: {
		bookmark: string
	}): Promise<{ undoBookmark: string }> {
		return await restoreToBookmark(this.ctx, input, {
			objectKind: 'mailbox',
			environment: this.env,
		})
	}

	/**
	 * Owner-bound retention pass (natural cutoffs only). Same scheduling as
	 * `alarm`; returns before/after counts with no row ids or content.
	 */
	async runRetentionNow(input: {
		ownerId: OwnerId
	}): Promise<MailboxRunRetentionNowResult> {
		this.assertReadable()
		return await this.maintenance.runRetentionNow(input.ownerId)
	}

	async upsertMessageGraph(
		input: MailboxUpsertMessageGraphInput,
	): Promise<{ ok: true; accepted: boolean }> {
		return await this.graphCommits.upsertMessageGraph(input)
	}

	async commitInboundMessageGraph(input: {
		ownerId: OwnerId
		deliveryId: string
		storageLease: string
		thread: MailboxThreadInput
		message: MailboxMessageInput
		attachments: Array<MailboxAttachmentInput>
	}): Promise<MailboxCommitInboundMessageGraphResult> {
		this.assertReadable()
		return await this.graphCommits.commitInboundMessageGraph(input)
	}

	async commitOutboundTerminal(
		input: MailboxCommitOutboundTerminalInput,
	): Promise<{ message: MailboxMessageRecord; eventInserted: boolean }> {
		this.assertReadable()
		return await this.graphCommits.commitOutboundTerminal(input)
	}

	async completeOutboundProviderIndexRepair(input: {
		ownerId: OwnerId
		provider: string
		providerMessageId: string
	}): Promise<{ cleared: boolean }> {
		this.assertReadable()
		return await this.graphCommits.completeOutboundProviderIndexRepair(input)
	}

	async getOutboundProviderIndexRepairStatus(input: { ownerId: OwnerId }) {
		this.assertReadable()
		return this.graphCommits.getOutboundProviderIndexRepairStatus(input.ownerId)
	}

	async recordBoundedRejection(input: {
		ownerId: OwnerId
		inboxId: string
		recipient: string
		reason: string
		phase: string
		day: string
		now: string
		detailLimit: number
		detailEventId: string
	}): Promise<{ count: number; detailed: boolean }> {
		this.assertReadable()
		let count = 0
		let detailed = false
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			const aggregateId = `email-rejections:${input.inboxId}:${input.day}`
			const existing = this.ctx.storage.sql
				.exec<{ detail_json: string }>(
					`SELECT detail_json FROM email_delivery_events
					WHERE id = ?
					LIMIT 1`,
					aggregateId,
				)
				.toArray()[0]
			let priorCount = 0
			if (existing) {
				try {
					const detail = JSON.parse(existing.detail_json) as {
						count?: unknown
					}
					if (typeof detail.count === 'number') priorCount = detail.count
				} catch {
					priorCount = 0
				}
			}
			count = priorCount + 1
			const event = (
				id: string,
				detailJson: string,
			): MailboxDeliveryEventInput => ({
				id,
				messageId: null,
				inboxId: input.inboxId,
				eventType: 'rejected',
				provider: 'cloudflare-email-routing',
				providerMessageId: null,
				providerEventId: null,
				detailJson,
				needsEffectReconcile: false,
				state: null,
				fingerprint: null,
				storageLease: null,
				storageLeaseAt: null,
				cleanupLease: null,
				cleanupLeaseAt: null,
				cleanupRetryAt: null,
				expectedAttachmentCount: null,
				finalizationToken: null,
				reconcileAfter: null,
				dedupeExpiresAt: null,
				usageEffectRecordedAt: null,
				usageEffectSuppressedAt: null,
				usageStartedAt: null,
				usageMonth: null,
				usageBytes: null,
				usageDurationMs: null,
				usageEffectRetryAt: null,
				usageEffectLease: null,
				usageEffectLeaseAt: null,
				subscriptionEffectState: null,
				subscriptionEffectLease: null,
				subscriptionEffectLeaseAt: null,
				subscriptionEffectRetryAt: null,
				subscriptionEffectAttemptCount: null,
				subscriptionEffectDeadLetterAt: null,
				subscriptionEffectLastError: null,
				createdAt: input.now,
				updatedAt: input.now,
			})
			this.store.writeDeliveryEventRow(
				event(
					aggregateId,
					JSON.stringify({
						aggregate: true,
						day: input.day,
						count,
						last_reason: input.reason,
						last_phase: input.phase,
						last_at: input.now,
					}),
				),
			)
			if (count <= Math.max(0, Math.trunc(input.detailLimit))) {
				detailed = this.store.writeDeliveryEventRow(
					event(
						input.detailEventId,
						JSON.stringify({
							recipient: input.recipient,
							reason: input.reason,
							phase: input.phase,
						}),
					),
				).inserted
			}
		})
		await this.maintenance.markDirtyAndEnsure()
		return { count, detailed }
	}

	async upsertDeliveryEvent(input: {
		ownerId: OwnerId
		event: MailboxDeliveryEventInput
		latestDeliveryStatus?: {
			messageId: string
			deliveryStatus: EmailDeliveryStatus
			deliveryStatusAt: string
		} | null
	}): Promise<{
		inserted: boolean
		accepted: boolean
		updatedLatestStatus: boolean
	}> {
		this.assertReadable()
		let inserted = false
		let accepted = false
		let updatedLatestStatus = false
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			if (
				shouldSkipMailboxDeliveryEventWrite(this.ctx.storage.sql, {
					event: input.event,
				})
			) {
				return
			}
			const write = this.store.writeDeliveryEventRow(input.event)
			inserted = write.inserted
			accepted = write.accepted
			if (accepted && input.latestDeliveryStatus) {
				const eventId = assertMailboxNonEmptyString(input.event.id, 'event.id')
				const messageId = assertMailboxNonEmptyString(
					input.latestDeliveryStatus.messageId,
					'latestDeliveryStatus.messageId',
				)
				if (this.store.deliveryEventOwnsMessage(eventId, messageId)) {
					updatedLatestStatus = this.store.updateLatestDeliveryStatus(
						input.latestDeliveryStatus,
					)
				}
			}
		})
		await this.maintenance.markDirtyAndEnsure()
		return { inserted, accepted, updatedLatestStatus }
	}

	async upsertDeliveryEvents(input: {
		ownerId: OwnerId
		events: Array<MailboxDeliveryEventInput>
		restore?: true
	}): Promise<MailboxUpsertDeliveryEventsResult> {
		if (!input.restore) this.assertReadable()
		let result: MailboxUpsertDeliveryEventsResult | undefined
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = upsertMailboxDeliveryEvents(this.ctx.storage.sql, input.events, {
				restore: input.restore,
			})
		})
		if (!result) throw new Error('Mailbox upsert transaction did not run.')
		if (!input.restore) await this.maintenance.markDirtyAndEnsure()
		return result
	}

	/**
	 * Advance thread activity without a full snapshot. Equal/newer `updatedAt`
	 * only; `last_message_at` never moves backward.
	 */
	async touchThread(
		input: MailboxTouchThreadInput,
	): Promise<MailboxPartialMutationResult> {
		this.assertReadable()
		let result: MailboxPartialMutationResult = { status: 'missing' }
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = touchMailboxThread(this.ctx.storage.sql, mutationInput)
		})
		return result
	}

	/**
	 * Partial authoritative delivery/processing update. Equal/newer `updatedAt`
	 * only.
	 */
	async updateMessageDelivery(
		input: MailboxUpdateMessageDeliveryInput,
	): Promise<MailboxPartialMutationResult> {
		this.assertReadable()
		let result: MailboxPartialMutationResult = { status: 'missing' }
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = updateMailboxMessageDelivery(this.ctx.storage.sql, mutationInput)
		})
		return result
	}

	/**
	 * Partial authoritative classification and/or archive update. Equal/newer
	 * `updatedAt` only.
	 */
	async setMessageClassification(
		input: MailboxSetMessageClassificationInput,
	): Promise<MailboxPartialMutationResult> {
		this.assertReadable()
		let result: MailboxPartialMutationResult = { status: 'missing' }
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = setMailboxMessageClassification(
				this.ctx.storage.sql,
				mutationInput,
			)
		})
		return result
	}

	/**
	 * Metadata-only delete (null delivery-event message_id + attachments +
	 * message). Never deletes R2 or empty threads.
	 */
	async deleteMessageMetadata(
		input: MailboxDeleteMessageMetadataInput,
	): Promise<MailboxDeleteResult> {
		this.assertReadable()
		let result: MailboxDeleteResult = { status: 'missing' }
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = deleteMailboxMessageMetadataWithTombstone(
				this.ctx.storage.sql,
				mutationInput,
			)
		})
		return result
	}

	/**
	 * Delete canonical owner-safe R2 objects before atomically deleting one
	 * message graph. Blocking input concurrency prevents an update from
	 * interleaving across the asynchronous R2 delete boundary.
	 */
	async deleteMessageWithBlobs(input: {
		ownerId: OwnerId
		messageId: string
	}): Promise<MailboxDeleteMessageWithBlobsResult> {
		this.assertReadable()
		return await this.maintenance.blockConcurrencySafely(async () => {
			const ownerId = this.store.assertOwner(input.ownerId)
			const messageId = assertMailboxNonEmptyString(
				input.messageId,
				'messageId',
			)
			const message = this.store.getMessage(messageId)
			if (!message) {
				return {
					status: 'missing',
					tombstoned: this.store.isMessageTombstoned(messageId),
				}
			}

			const attachments = this.store.listAttachmentsForMessage(messageId)
			const blobReferences = canonicalMailboxMessageBlobReferences({
				ownerId,
				messageId,
				direction: message.direction,
				attachments: attachments.map((attachment) => ({
					id: attachment.id,
					storage_key: attachment.storageKey,
				})),
			})
			await deleteMailboxBlobKeys(
				this.env.EMAIL_BLOBS,
				blobReferences.map((reference) => reference.key),
			)

			this.store.tombstoneAndDeleteMessage({
				messageId,
				deletedAt: new Date().toISOString(),
			})
			return {
				status: 'deleted',
				providerMessageId: message.providerMessageId,
				attachmentsSeen: attachments.length,
				externalAttachmentsSeen: attachments.filter(
					(attachment) => attachment.storageKind === 'external',
				).length,
				blobReferences,
			}
		})
	}

	async tombstoneMissingMessage(input: {
		ownerId: OwnerId
		messageId: string
		deletedAt: string
	}): Promise<MailboxTombstoneMissingMessageResult> {
		this.assertReadable()
		let result: MailboxTombstoneMissingMessageResult = {
			status: 'message-present',
		}
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = tombstoneMissingMailboxMessage(this.ctx.storage.sql, input)
		})
		return result
	}

	/**
	 * Metadata-only delivery-event delete. Distinguishes missing (idempotent)
	 * from stale (newer `updated_at` retained).
	 */
	async deleteDeliveryEvent(
		input: MailboxDeleteDeliveryEventInput,
	): Promise<MailboxDeleteResult> {
		this.assertReadable()
		let result: MailboxDeleteResult = { status: 'missing' }
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = deleteMailboxDeliveryEvent(this.ctx.storage.sql, mutationInput)
		})
		return result
	}

	/**
	 * Deferred empty-thread cleanup. Stale-safe by `thread.updated_at`.
	 */
	async deleteThreadIfEmpty(
		input: MailboxDeleteThreadIfEmptyInput,
	): Promise<MailboxDeleteResult> {
		this.assertReadable()
		let result: MailboxDeleteResult = { status: 'missing' }
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = deleteMailboxThreadIfEmpty(this.ctx.storage.sql, mutationInput)
		})
		return result
	}

	async getThread(input: {
		threadId: string
	}): Promise<MailboxThreadRecord | null> {
		this.assertReadable()
		return this.store.getThread(input.threadId)
	}

	async findThreadForInboundMessage(input: {
		inboxId?: string | null
		references: Array<string>
		inReplyToHeader?: string | null
	}): Promise<MailboxThreadRecord | null> {
		this.assertReadable()
		return this.store.findThreadForInboundMessage(input)
	}

	async getMessage(input: {
		messageId: string
	}): Promise<MailboxMessageRecord | null> {
		this.assertReadable()
		return this.store.getMessage(input.messageId)
	}

	async getMessageByMessageIdHeader(input: {
		messageIdHeader: string
	}): Promise<MailboxMessageRecord | null> {
		this.assertReadable()
		return this.store.getMessageByMessageIdHeader(input.messageIdHeader)
	}

	async getOutboundMessageByProviderMessageId(input: {
		providerMessageId: string
	}): Promise<MailboxMessageRecord | null> {
		this.assertReadable()
		return this.store.getOutboundMessageByProviderMessageId(
			input.providerMessageId,
		)
	}

	async listMessages(input: MailboxListMessagesInput): Promise<{
		messages: Array<MailboxMessageRecord>
		nextCursor: string | null
	}> {
		this.assertReadable()
		return this.store.listMessages(input)
	}

	async searchMessages(input: MailboxSearchMessagesInput): Promise<{
		messages: Array<MailboxMessageRecord>
	}> {
		this.assertReadable()
		return this.store.searchMessages(input)
	}

	async countMessages(
		input: MailboxCountMessagesInput,
	): Promise<{ total: number }> {
		this.assertReadable()
		return this.store.countMessages(input)
	}

	async getAttachment(input: {
		attachmentId: string
	}): Promise<MailboxAttachmentRecord | null> {
		this.assertReadable()
		return this.store.getAttachment(input.attachmentId)
	}

	async listAttachmentsForMessage(input: {
		messageId: string
	}): Promise<Array<MailboxAttachmentRecord>> {
		this.assertReadable()
		return this.store.listAttachmentsForMessage(input.messageId)
	}

	async listDeliveryEvents(input: {
		messageId?: string | null
		eventType?: EmailDeliveryEventType | null
		limit?: number
	}): Promise<Array<MailboxDeliveryEventRecord>> {
		this.assertReadable()
		return this.store.listDeliveryEvents(input)
	}

	async countDeliveryEvents(input: {
		ownerId: OwnerId
		eventType: EmailDeliveryEventType
		provider: string
		createdAtGte: string
	}): Promise<{ count: number }> {
		this.store.assertOwner(input.ownerId)
		this.assertReadable()
		const row = this.ctx.storage.sql
			.exec<{ count: number }>(
				`SELECT COUNT(*) AS count
				FROM email_delivery_events
				WHERE event_type = ?
					AND provider = ?
					AND created_at >= ?`,
				input.eventType,
				input.provider,
				input.createdAtGte,
			)
			.one()
		return { count: Number(row.count) }
	}

	async getDeliveryEventByProviderEventId(input: {
		providerEventId: string
	}): Promise<MailboxDeliveryEventRecord | null> {
		this.assertReadable()
		return findDeliveryEventByProviderEventId(
			this.ctx.storage.sql,
			input.providerEventId,
		)
	}

	async countMailbox(input?: { restore?: true }): Promise<MailboxCountResult> {
		if (!input?.restore) this.assertReadable()
		return this.store.countMailbox()
	}

	async inspectRestoreState(input: { ownerId: OwnerId }) {
		this.store.assertOwner(input.ownerId)
		return this.store.inspectRestoreState()
	}

	async beginRestore(input: { ownerId: OwnerId }): Promise<{ ok: true }> {
		this.store.beginRestore(input.ownerId)
		return { ok: true }
	}

	async finalizeRestore(input: { ownerId: OwnerId }): Promise<{ ok: true }> {
		this.store.finalizeRestore(input.ownerId)
		await this.maintenance.markDirtyAndEnsure()
		return { ok: true }
	}

	async readDrillResult(input: {
		ownerId: OwnerId
	}): Promise<MailboxCountResult | null> {
		this.store.assertOwner(input.ownerId)
		return this.store.readDrillResult()
	}

	async completeDrill(input: {
		ownerId: OwnerId
		result: MailboxCountResult
	}): Promise<{ ok: true }> {
		await this.maintenance.blockConcurrencySafely(async () => {
			await this.ctx.storage.deleteAlarm().catch(() => undefined)
			this.store.completeDrill(input.ownerId, input.result)
		})
		return { ok: true }
	}

	async exportMailbox(input: {
		pageSize?: number
		startAfter?: string | null
	}): Promise<MailboxExportResult> {
		this.assertReadable()
		return this.store.exportMailbox(input)
	}

	async listBlobReferences(input: {
		pageSize?: number
		startAfter?: string | null
	}): Promise<MailboxBlobReferencePage> {
		this.assertReadable()
		return this.store.listBlobReferences(input)
	}

	async getInboundDelivery(input: {
		ownerId: OwnerId
		deliveryId: string
	}): Promise<MailboxInboundDeliverySnapshot | null> {
		this.assertReadable()
		return this.inbound.getInboundDelivery(input)
	}

	async getInboundDeliveryWindow(input: {
		ownerId: OwnerId
		fingerprint: string
		now?: string
	}): Promise<MailboxInboundDeliverySnapshot | null> {
		this.assertReadable()
		return this.inbound.getInboundDeliveryWindow(input)
	}

	async claimInboundDeliveryWindow(input: {
		ownerId: OwnerId
		delivery: MailboxInboundDeliveryInsertInput
		now?: string
	}): Promise<MailboxInboundDeliverySnapshot> {
		this.assertReadable()
		return await this.inbound.claimInboundDeliveryWindow(input)
	}

	async insertChargedPendingInboundDelivery(input: {
		ownerId: OwnerId
		delivery: MailboxInboundDeliveryInsertInput
		now?: string
	}) {
		this.assertReadable()
		return await this.inbound.insertChargedPendingInboundDelivery(input)
	}

	async claimInboundDeliveryStorage(input: {
		ownerId: OwnerId
		deliveryId: string
		expectedAttachmentCount: number
		usageStartedAt?: string | null
		now?: string
	}) {
		this.assertReadable()
		return await this.inbound.claimInboundDeliveryStorage(input)
	}

	async releaseInboundDeliveryStorage(input: {
		ownerId: OwnerId
		deliveryId: string
		storageLease: string
		now?: string
	}) {
		this.assertReadable()
		return await this.inbound.releaseInboundDeliveryStorage(input)
	}

	async markInboundDeliveryRejected(input: {
		ownerId: OwnerId
		deliveryId: string
		reason: string
		expectedStorageLease?: string | null
		expectedState?: MailboxInboundDeliveryState
		now?: string
	}) {
		this.assertReadable()
		return await this.inbound.markInboundDeliveryRejected(input)
	}

	async markInboundDeliveryReceived(input: {
		ownerId: OwnerId
		deliveryId: string
		storageLease: string
		usageDurationMs: number
		usageMonth: string
		usageBytes: number
		now?: string
	}) {
		this.assertReadable()
		return await this.inbound.markInboundDeliveryReceived(input)
	}

	async pruneExpiredInboundDedupePointers(input: {
		ownerId: OwnerId
		now?: string
		limit?: number
	}) {
		this.assertReadable()
		return await this.inbound.pruneExpiredInboundDedupePointers(input)
	}

	async deferInboundDeliveryReconciliation(input: {
		ownerId: OwnerId
		deliveryId: string
		now?: string
	}) {
		this.assertReadable()
		return await this.inbound.deferInboundDeliveryReconciliation(input)
	}

	async claimInboundDeliveryCleanup(input: {
		ownerId: OwnerId
		deliveryId: string
		expectedState: MailboxInboundDeliveryState
		expectedUpdatedAt: string
		staleBefore: string
		now?: string
	}) {
		this.assertReadable()
		return this.inbound.claimInboundDeliveryCleanup(input)
	}

	async releaseInboundDeliveryCleanup(input: {
		ownerId: OwnerId
		deliveryId: string
		cleanupLease: string
		now?: string
	}) {
		this.assertReadable()
		return this.inbound.releaseInboundDeliveryCleanup(input)
	}

	async markInboundDeliveryOrphanCleaned(input: {
		ownerId: OwnerId
		deliveryId: string
		cleanupLease: string
		outcome: 'deleted' | 'delete-failed'
		now?: string
	}) {
		this.assertReadable()
		return this.inbound.markInboundDeliveryOrphanCleaned(input)
	}

	async claimInboundUsageEffect(input: {
		ownerId: OwnerId
		deliveryId: string
		expectedFinalizationToken?: string | null
		now?: string
	}) {
		this.assertReadable()
		return this.inbound.claimInboundUsageEffect(input)
	}

	async completeInboundUsageEffect(input: {
		ownerId: OwnerId
		deliveryId: string
		usageEffectLease: string
		expectedFinalizationToken: string
		mode: 'recorded' | 'suppressed'
		usageMonth: string
		usageBytes: number
		usageDurationMs: number
		now?: string
	}) {
		this.assertReadable()
		return this.inbound.completeInboundUsageEffect(input)
	}

	async claimInboundSubscriptionEffect(input: {
		ownerId: OwnerId
		deliveryId: string
		expectedFinalizationToken?: string | null
		now?: string
	}) {
		this.assertReadable()
		return this.inbound.claimInboundSubscriptionEffect(input)
	}

	async completeInboundSubscriptionEffect(input: {
		ownerId: OwnerId
		deliveryId: string
		subscriptionEffectLease: string
		expectedFinalizationToken: string
		mode: 'complete' | 'suppressed'
		suppressionReason?: string | null
		now?: string
	}) {
		this.assertReadable()
		return this.inbound.completeInboundSubscriptionEffect(input)
	}

	async failInboundSubscriptionEffect(input: {
		ownerId: OwnerId
		deliveryId: string
		subscriptionEffectLease: string
		expectedFinalizationToken: string
		error: string
		now?: string
	}) {
		this.assertReadable()
		return this.inbound.failInboundSubscriptionEffect(input)
	}

	async listDueStaleInboundDeliveries(input: {
		ownerId: OwnerId
		now?: string
		limit?: number
	}) {
		this.assertReadable()
		return this.inbound.listDueStaleInboundDeliveries(input)
	}

	async listDueInboundEffectWork(input: {
		ownerId: OwnerId
		now?: string
		limit?: number
	}) {
		this.assertReadable()
		return this.inbound.listDueInboundEffectWork(input)
	}

	async getInboundDueWorkHint(input: {
		ownerId: OwnerId
		now?: string
	}): Promise<{ dueAt: string | null }> {
		this.assertReadable()
		return this.inbound.getInboundDueWorkHint(input)
	}

	async purge(input: { ownerId: OwnerId }): Promise<{ ok: true }> {
		await this.ctx.blockConcurrencyWhile(async () => {
			this.store.assertOwner(input.ownerId)
			await this.ctx.storage.deleteAlarm().catch(() => undefined)
			await this.ctx.storage.deleteAll()
			this.maintenance.resetAfterPurge()
			this.store.initializeSchema()
		})
		return { ok: true }
	}
}

export const Mailbox = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	MailboxBase,
)
export type Mailbox = InstanceType<typeof Mailbox>

export type { MailboxRpc } from './mailbox-types.ts'
export {
	mailboxDeliveryEventRetentionDays,
	mailboxMessageRetentionDays,
	mailboxRetentionContinuationDelayMs,
	mailboxRetentionRetryDelayMs,
	type MailboxAttachmentInput,
	type MailboxAttachmentRecord,
	type MailboxBlobReference,
	type MailboxBlobReferencePage,
	type MailboxCountResult,
	type MailboxDeleteDeliveryEventInput,
	type MailboxDeleteMessageMetadataInput,
	type MailboxDeleteResult,
	type MailboxDeleteThreadIfEmptyInput,
	type MailboxDeliveryEventInput,
	type MailboxDeliveryEventRecord,
	type MailboxExportResult,
	type MailboxExportRow,
	type MailboxMessageInput,
	type MailboxMessageRecord,
	type MailboxPartialMutationResult,
	type MailboxRunRetentionNowResult,
	type MailboxRestoreStatus,
	type MailboxSetMessageClassificationInput,
	type MailboxThreadInput,
	type MailboxThreadRecord,
	type MailboxTouchThreadInput,
	type MailboxUpdateMessageDeliveryInput,
	type MailboxUpsertMessageGraphInput,
} from './mailbox-types.ts'
export {
	computeMailboxRetentionReschedule,
	selectMailboxRetentionWriteAlarm,
} from './mailbox-retention.ts'
