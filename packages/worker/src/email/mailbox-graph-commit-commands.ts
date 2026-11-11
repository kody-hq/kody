import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getMailboxInboundDelivery } from './mailbox-inbound-ledger.ts'
import type { MailboxMaintenanceCommands } from './mailbox-maintenance-commands.ts'
import { updateMailboxMessageDelivery } from './mailbox-mutations.ts'
import {
	clearMailboxProviderIndexRepair,
	getMailboxProviderIndexRepairStatus,
	upsertMailboxProviderIndexRepair,
} from './mailbox-provider-index-repair.ts'
import type { MailboxStore } from './mailbox-store.ts'
import {
	assertMailboxNonEmptyString,
	type MailboxAttachmentInput,
	type MailboxCommitInboundMessageGraphResult,
	type MailboxCommitOutboundTerminalInput,
	type MailboxMessageInput,
	type MailboxMessageRecord,
	type MailboxThreadInput,
	type MailboxUpsertMessageGraphInput,
	type MailboxUpsertMessageGraphResult,
} from './mailbox-types.ts'

export class MailboxGraphCommitCommands {
	private readonly ctx: DurableObjectState
	private readonly store: MailboxStore
	private readonly maintenance: MailboxMaintenanceCommands

	constructor(
		ctx: DurableObjectState,
		store: MailboxStore,
		maintenance: MailboxMaintenanceCommands,
	) {
		this.ctx = ctx
		this.store = store
		this.maintenance = maintenance
	}

	async upsertMessageGraph(
		input: MailboxUpsertMessageGraphInput,
	): Promise<MailboxUpsertMessageGraphResult> {
		if (!input.restore) this.store.assertReadable()
		const message = input.message
		let accepted = false
		let threadReplyAllLimited = false
		this.ctx.storage.transactionSync(() => {
			const ownerId = this.store.assertOwner(input.ownerId)
			if (message === null) {
				accepted = this.store.upsertThreadRow(input.thread).accepted
				return
			}
			assertMailboxNonEmptyString(message.id, 'message.id')
			if (this.store.isMessageTombstoned(message.id)) return
			const limit = input.threadReplyAllLimit
			if (
				limit &&
				this.store.countThreadReplyAllSendsSince({
					threadId: limit.threadId,
					since: limit.since,
				}) >= limit.max
			) {
				threadReplyAllLimited = true
				return
			}
			this.store.validateMessageBlobKeys({
				ownerId,
				message,
				attachments: input.attachments,
			})
			if (input.thread) this.store.upsertThreadRow(input.thread)
			const messageResult = this.store.upsertMessageRow(message)
			accepted = messageResult.accepted
			if (accepted && input.attachments !== undefined) {
				this.store.replaceAttachmentsForMessage(message.id, input.attachments)
			}
		})
		if (threadReplyAllLimited) {
			return { ok: true, accepted: false, threadReplyAllLimited: true }
		}
		if (!input.restore) await this.maintenance.markDirtyAndEnsure()
		return { ok: true, accepted }
	}

	async commitInboundMessageGraph(input: {
		ownerId: OwnerId
		deliveryId: string
		storageLease: string
		thread: MailboxThreadInput
		message: MailboxMessageInput
		attachments: Array<MailboxAttachmentInput>
	}): Promise<MailboxCommitInboundMessageGraphResult> {
		let result: MailboxCommitInboundMessageGraphResult = {
			status: 'lease-lost',
		}
		this.ctx.storage.transactionSync(() => {
			const ownerId = this.store.assertOwner(input.ownerId)
			const delivery = getMailboxInboundDelivery(
				this.ctx.storage.sql,
				input.deliveryId,
			)
			const existing = this.store.getMessage(input.message.id)
			if (
				delivery?.state === 'received' &&
				delivery.messageId === input.message.id &&
				delivery.finalizationToken === input.storageLease &&
				existing
			) {
				result = { status: 'already-committed', message: existing }
				return
			}
			if (
				delivery?.state !== 'storing' ||
				delivery.storageLease !== input.storageLease ||
				delivery.messageId !== input.message.id ||
				delivery.expectedAttachmentCount !== input.attachments.length
			) {
				return
			}
			if (input.message.direction !== 'inbound') {
				throw new Error('Inbound graph commit requires an inbound message.')
			}
			if (input.message.threadId !== input.thread.id) {
				throw new Error(
					'Inbound graph commit message.threadId must match thread.id.',
				)
			}
			if (
				input.message.inboxId !== delivery.inboxId ||
				input.thread.inboxId !== delivery.inboxId
			) {
				throw new Error(
					'Inbound graph commit inbox ids must match the delivery inbox.',
				)
			}
			this.store.validateMessageBlobKeys({
				ownerId,
				message: input.message,
				attachments: input.attachments,
			})
			this.store.upsertThreadRow(input.thread)
			const written = this.store.upsertMessageRow(input.message)
			if (!written.accepted) {
				throw new Error(
					'Inbound graph commit was rejected by a newer snapshot.',
				)
			}
			this.store.replaceAttachmentsForMessage(
				input.message.id,
				input.attachments,
			)
			const message = this.store.getMessage(input.message.id)
			if (!message) {
				throw new Error('Inbound graph commit did not persist its message.')
			}
			result = { status: 'committed', message }
		})
		if (result.status !== 'lease-lost') {
			await this.maintenance.markDirtyAndEnsure()
		}
		return result
	}

	async commitOutboundTerminal(
		input: MailboxCommitOutboundTerminalInput,
	): Promise<{ message: MailboxMessageRecord; eventInserted: boolean }> {
		let result:
			| { message: MailboxMessageRecord; eventInserted: boolean }
			| undefined
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			const mutation = updateMailboxMessageDelivery(this.ctx.storage.sql, {
				messageId: input.messageId,
				processingStatus: input.processingStatus,
				providerMessageId: input.providerMessageId,
				error: input.error,
				sentAt: input.sentAt,
				updatedAt: input.event.updatedAt,
			})
			if (mutation.status === 'missing') {
				throw new Error('Outbound terminal message is missing from Mailbox.')
			}
			const eventWrite = this.store.writeDeliveryEventRow(input.event)
			if (input.providerIndexRepair) {
				if (
					input.processingStatus !== 'sent' ||
					input.providerMessageId !==
						input.providerIndexRepair.providerMessageId ||
					input.messageId !== input.providerIndexRepair.messageId
				) {
					throw new Error(
						'Outbound provider-index repair must match the accepted terminal message.',
					)
				}
				upsertMailboxProviderIndexRepair(
					this.ctx.storage.sql,
					input.providerIndexRepair,
				)
			}
			const message = this.store.getMessage(input.messageId)
			if (!message) {
				throw new Error('Outbound terminal message disappeared from Mailbox.')
			}
			result = { message, eventInserted: eventWrite.inserted }
		})
		if (!result) throw new Error('Outbound terminal transaction did not run.')
		await this.maintenance.markDirtyAndEnsure()
		await this.maintenance.syncProviderRepairHealth()
		return result
	}

	async completeOutboundProviderIndexRepair(input: {
		ownerId: OwnerId
		provider: string
		providerMessageId: string
	}): Promise<{ cleared: boolean }> {
		this.store.assertOwner(input.ownerId)
		const result = {
			cleared: clearMailboxProviderIndexRepair(this.ctx.storage.sql, input),
		}
		await this.maintenance.syncProviderRepairHealth()
		return result
	}

	getOutboundProviderIndexRepairStatus(ownerId: OwnerId) {
		this.store.assertOwner(ownerId)
		return getMailboxProviderIndexRepairStatus(this.ctx.storage.sql)
	}
}
