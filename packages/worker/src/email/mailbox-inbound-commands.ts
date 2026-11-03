import {
	claimMailboxInboundDeliveryCleanup,
	markMailboxInboundDeliveryOrphanCleaned,
	releaseMailboxInboundDeliveryCleanup,
} from './mailbox-inbound-cleanup-ledger.ts'
import {
	claimMailboxInboundSubscriptionEffect,
	claimMailboxInboundUsageEffect,
	completeMailboxInboundSubscriptionEffect,
	completeMailboxInboundUsageEffect,
	failMailboxInboundSubscriptionEffect,
	listMailboxDueInboundEffectWork,
} from './mailbox-inbound-effect-ledger.ts'
import {
	claimMailboxInboundDeliveryStorage,
	claimMailboxInboundDeliveryWindow,
	deferMailboxInboundDeliveryReconciliation,
	getMailboxInboundDelivery,
	getMailboxInboundDeliveryWindow,
	insertMailboxChargedPendingInboundDelivery,
	listMailboxDueStaleInboundDeliveries,
	markMailboxInboundDeliveryReceived,
	markMailboxInboundDeliveryRejected,
	pruneMailboxExpiredInboundDedupePointers,
	releaseMailboxInboundDeliveryStorage,
} from './mailbox-inbound-ledger.ts'
import { getMailboxInboundDueAt } from './inbound-due-owners.ts'
import type { MailboxMaintenanceCommands } from './mailbox-maintenance-commands.ts'
import type { MailboxStore } from './mailbox-store.ts'
import type { MailboxRpc } from './mailbox-types.ts'

export class MailboxInboundCommands {
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

	getInboundDelivery(input: Parameters<MailboxRpc['getInboundDelivery']>[0]) {
		this.store.assertOwner(input.ownerId)
		return getMailboxInboundDelivery(this.ctx.storage.sql, input.deliveryId)
	}

	getInboundDeliveryWindow(
		input: Parameters<MailboxRpc['getInboundDeliveryWindow']>[0],
	) {
		this.store.assertOwner(input.ownerId)
		return getMailboxInboundDeliveryWindow(this.ctx.storage.sql, input)
	}

	async claimInboundDeliveryWindow(
		input: Parameters<MailboxRpc['claimInboundDeliveryWindow']>[0],
	) {
		let result!: Awaited<ReturnType<MailboxRpc['claimInboundDeliveryWindow']>>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = claimMailboxInboundDeliveryWindow(this.ctx.storage.sql, input)
		})
		await this.maintenance.markDirtyAndEnsure()
		return result
	}

	async insertChargedPendingInboundDelivery(
		input: Parameters<MailboxRpc['insertChargedPendingInboundDelivery']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['insertChargedPendingInboundDelivery']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = insertMailboxChargedPendingInboundDelivery(
				this.ctx.storage.sql,
				input,
			)
		})
		await this.maintenance.markDirtyAndEnsure()
		return result
	}

	async claimInboundDeliveryStorage(
		input: Parameters<MailboxRpc['claimInboundDeliveryStorage']>[0],
	) {
		let result!: Awaited<ReturnType<MailboxRpc['claimInboundDeliveryStorage']>>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = claimMailboxInboundDeliveryStorage(this.ctx.storage.sql, input)
		})
		if (result.status === 'claimed') {
			await this.maintenance.markDirtyAndEnsure()
		}
		return result
	}

	async releaseInboundDeliveryStorage(
		input: Parameters<MailboxRpc['releaseInboundDeliveryStorage']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['releaseInboundDeliveryStorage']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = releaseMailboxInboundDeliveryStorage(this.ctx.storage.sql, input)
		})
		if (result.status === 'released') {
			await this.maintenance.markDirtyAndEnsure()
		}
		return result
	}

	async markInboundDeliveryRejected(
		input: Parameters<MailboxRpc['markInboundDeliveryRejected']>[0],
	) {
		let result!: Awaited<ReturnType<MailboxRpc['markInboundDeliveryRejected']>>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = markMailboxInboundDeliveryRejected(this.ctx.storage.sql, input)
		})
		if (result.status === 'rejected') {
			await this.maintenance.markDirtyAndEnsure()
		}
		return result
	}

	async markInboundDeliveryReceived(
		input: Parameters<MailboxRpc['markInboundDeliveryReceived']>[0],
	) {
		let result!: Awaited<ReturnType<MailboxRpc['markInboundDeliveryReceived']>>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = markMailboxInboundDeliveryReceived(this.ctx.storage.sql, input)
		})
		if (result.status === 'received') {
			await this.maintenance.markDirtyAndEnsure()
		}
		return result
	}

	async pruneExpiredInboundDedupePointers(
		input: Parameters<MailboxRpc['pruneExpiredInboundDedupePointers']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['pruneExpiredInboundDedupePointers']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = pruneMailboxExpiredInboundDedupePointers(
				this.ctx.storage.sql,
				input,
			)
		})
		if (result.pruned > 0) {
			await this.maintenance.markDirtyAndEnsure()
		}
		return result
	}

	async deferInboundDeliveryReconciliation(
		input: Parameters<MailboxRpc['deferInboundDeliveryReconciliation']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['deferInboundDeliveryReconciliation']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = deferMailboxInboundDeliveryReconciliation(
				this.ctx.storage.sql,
				input,
			)
		})
		if (result.status === 'deferred') {
			await this.maintenance.markDirtyAndEnsure()
		}
		return result
	}

	claimInboundDeliveryCleanup(
		input: Parameters<MailboxRpc['claimInboundDeliveryCleanup']>[0],
	) {
		let result!: Awaited<ReturnType<MailboxRpc['claimInboundDeliveryCleanup']>>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = claimMailboxInboundDeliveryCleanup(this.ctx.storage.sql, input)
		})
		return result
	}

	releaseInboundDeliveryCleanup(
		input: Parameters<MailboxRpc['releaseInboundDeliveryCleanup']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['releaseInboundDeliveryCleanup']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = releaseMailboxInboundDeliveryCleanup(this.ctx.storage.sql, input)
		})
		return result
	}

	markInboundDeliveryOrphanCleaned(
		input: Parameters<MailboxRpc['markInboundDeliveryOrphanCleaned']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['markInboundDeliveryOrphanCleaned']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = markMailboxInboundDeliveryOrphanCleaned(
				this.ctx.storage.sql,
				input,
			)
		})
		return result
	}

	claimInboundUsageEffect(
		input: Parameters<MailboxRpc['claimInboundUsageEffect']>[0],
	) {
		let result!: Awaited<ReturnType<MailboxRpc['claimInboundUsageEffect']>>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = claimMailboxInboundUsageEffect(this.ctx.storage.sql, input)
		})
		return result
	}

	completeInboundUsageEffect(
		input: Parameters<MailboxRpc['completeInboundUsageEffect']>[0],
	) {
		let result!: Awaited<ReturnType<MailboxRpc['completeInboundUsageEffect']>>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = completeMailboxInboundUsageEffect(this.ctx.storage.sql, input)
		})
		return result
	}

	claimInboundSubscriptionEffect(
		input: Parameters<MailboxRpc['claimInboundSubscriptionEffect']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['claimInboundSubscriptionEffect']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = claimMailboxInboundSubscriptionEffect(
				this.ctx.storage.sql,
				input,
			)
		})
		return result
	}

	completeInboundSubscriptionEffect(
		input: Parameters<MailboxRpc['completeInboundSubscriptionEffect']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['completeInboundSubscriptionEffect']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = completeMailboxInboundSubscriptionEffect(
				this.ctx.storage.sql,
				input,
			)
		})
		return result
	}

	failInboundSubscriptionEffect(
		input: Parameters<MailboxRpc['failInboundSubscriptionEffect']>[0],
	) {
		let result!: Awaited<
			ReturnType<MailboxRpc['failInboundSubscriptionEffect']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = failMailboxInboundSubscriptionEffect(this.ctx.storage.sql, input)
		})
		return result
	}

	listDueStaleInboundDeliveries(
		input: Parameters<MailboxRpc['listDueStaleInboundDeliveries']>[0],
	) {
		this.store.assertOwner(input.ownerId)
		return listMailboxDueStaleInboundDeliveries(this.ctx.storage.sql, input)
	}

	listDueInboundEffectWork(
		input: Parameters<MailboxRpc['listDueInboundEffectWork']>[0],
	) {
		this.store.assertOwner(input.ownerId)
		return listMailboxDueInboundEffectWork(this.ctx.storage.sql, input)
	}

	getInboundDueWorkHint(
		input: Parameters<MailboxRpc['getInboundDueWorkHint']>[0],
	) {
		this.store.assertOwner(input.ownerId)
		let now: Date | undefined
		if (input.now != null) {
			const parsed = Date.parse(input.now)
			if (Number.isFinite(parsed)) now = new Date(parsed)
		}
		return {
			dueAt: getMailboxInboundDueAt(this.ctx.storage.sql, now),
		}
	}
}
