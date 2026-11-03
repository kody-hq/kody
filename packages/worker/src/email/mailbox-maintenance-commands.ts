import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	computeMailboxRetentionReschedule,
	deleteMailboxRetentionCandidate,
	enforceMailboxRetention,
	mailboxRetentionAlarmAtMs,
	nextMailboxRetentionDueAtMs,
	selectMailboxRetentionCandidate,
	selectMailboxRetentionWriteAlarm,
	type MailboxRetentionMessageDeleteResult,
} from './mailbox-retention.ts'
import {
	getMailboxProviderIndexRepairStatus,
	nextMailboxProviderIndexRepairDueAtMs,
	repairPendingMailboxProviderIndexes,
} from './mailbox-provider-index-repair.ts'
import {
	getMailboxInboundDueAt,
	replaceInboundDueOwnerHint,
} from './inbound-due-owners.ts'
import { syncProviderIndexRepairOwnerHealth } from './provider-index-repair-health.ts'
import type { MailboxStore } from './mailbox-store.ts'
import type { MailboxRunRetentionNowResult } from './mailbox-types.ts'

export class MailboxMaintenanceCommands {
	private alarmArmed = false
	private idleConfirmed = false
	private readonly ctx: DurableObjectState
	private readonly env: Env
	private readonly store: MailboxStore

	constructor(ctx: DurableObjectState, env: Env, store: MailboxStore) {
		this.ctx = ctx
		this.env = env
		this.store = store
	}

	async initializeAlarmState() {
		this.alarmArmed = (await this.ctx.storage.getAlarm()) != null
	}

	/**
	 * Schedule at most one alarm for the earliest retention, provider repair, or
	 * inbound coordination due-time. A write never postpones an earlier alarm.
	 */
	private async ensureAlarm() {
		if (this.alarmArmed || this.idleConfirmed) return
		const proposedAtMs = mailboxRetentionAlarmAtMs({
			dueAtMs: this.nextAlarmDueAtMs(),
		})
		const existingAtMs = await this.ctx.storage.getAlarm()
		const selection = selectMailboxRetentionWriteAlarm({
			proposedAtMs,
			existingAtMs,
		})
		switch (selection.action) {
			case 'idle':
				this.idleConfirmed = true
				this.alarmArmed = false
				return
			case 'keep-existing':
				this.idleConfirmed = false
				this.alarmArmed = true
				return
			case 'set':
				this.idleConfirmed = false
				await this.ctx.storage.setAlarm(selection.atMs)
				this.alarmArmed = true
				return
			default: {
				const exhaustive: never = selection
				throw new Error(
					`Unhandled Mailbox write-alarm selection: ${String(exhaustive)}`,
				)
			}
		}
	}

	async markDirtyAndEnsure() {
		this.idleConfirmed = false
		this.alarmArmed = false
		await this.ensureAlarm()
	}

	private nextAlarmDueAtMs(nowMs: number = Date.now()) {
		const inboundDueAt = getMailboxInboundDueAt(
			this.ctx.storage.sql,
			new Date(nowMs),
		)
		const inboundDueAtMs =
			inboundDueAt == null ? null : Date.parse(inboundDueAt)
		const dueTimes = [
			nextMailboxRetentionDueAtMs(this.store, nowMs),
			nextMailboxProviderIndexRepairDueAtMs(this.ctx.storage.sql),
			...(inboundDueAtMs != null && Number.isFinite(inboundDueAtMs)
				? [inboundDueAtMs]
				: []),
		].filter((value): value is number => value != null)
		return dueTimes.length > 0 ? Math.min(...dueTimes) : null
	}

	private async syncInboundDueOwnerHint() {
		const ownerId = this.store.getOwnerId()
		if (!ownerId) return
		try {
			await replaceInboundDueOwnerHint({
				db: this.env.APP_DB,
				userId: ownerId,
				dueAt: getMailboxInboundDueAt(this.ctx.storage.sql),
				reason: 'mailbox-due-work',
			})
		} catch (error) {
			console.warn('mailbox-inbound-due-owner-hint-repair-failed', { error })
		}
	}

	async syncProviderRepairHealth() {
		const ownerId = this.store.getOwnerId()
		if (!ownerId) return
		try {
			await syncProviderIndexRepairOwnerHealth({
				db: this.env.APP_DB,
				userId: ownerId,
				status: getMailboxProviderIndexRepairStatus(this.ctx.storage.sql),
			})
		} catch (error) {
			console.warn('mailbox-provider-index-repair-health-sync-failed', {
				error,
			})
		}
	}

	async blockConcurrencySafely<T>(operation: () => Promise<T>): Promise<T> {
		const outcome = await this.ctx.blockConcurrencyWhile(
			async (): Promise<
				{ ok: true; value: T } | { ok: false; error: unknown }
			> => {
				try {
					return { ok: true, value: await operation() }
				} catch (error) {
					return { ok: false, error }
				}
			},
		)
		if (!outcome.ok) throw outcome.error
		return outcome.value
	}

	private async deleteRetentionMessage(
		cutoff: string,
	): Promise<MailboxRetentionMessageDeleteResult | null> {
		return await this.blockConcurrencySafely(async () => {
			const candidate = selectMailboxRetentionCandidate(this.store, cutoff)
			if (candidate == null) return null
			const ownerId = this.store.getOwnerId()
			if (ownerId == null) {
				throw new Error('Mailbox retention candidate has no bound owner.')
			}
			return await deleteMailboxRetentionCandidate({
				store: this.store,
				blobs: this.env.EMAIL_BLOBS,
				ownerId,
				candidate,
				cutoff,
			})
		})
	}

	private async runRetentionPass(): Promise<MailboxRunRetentionNowResult> {
		const before = this.store.countMailbox()
		const result = await enforceMailboxRetention({
			store: this.store,
			deleteMessage: (cutoff) => this.deleteRetentionMessage(cutoff),
		})
		const after = this.store.countMailbox()
		const nowMs = Date.now()
		const nextDueAtMs = this.nextAlarmDueAtMs(nowMs)
		const reschedule = computeMailboxRetentionReschedule({
			nowMs,
			eligibleExpiredWorkRemaining: result.eligibleExpiredWorkRemaining,
			earliestRetryAtMs: result.earliestRetryAtMs,
			nextDueAtMs,
		})
		if (reschedule.atMs == null) {
			// runRetentionNow can finish work an earlier turn armed a continuation
			// for; clear it so idle really means no pending alarm. Overdue work
			// (nextDueAtMs <= now) keeps the alarm that is about to serve it.
			if (nextDueAtMs == null) await this.ctx.storage.deleteAlarm()
			this.alarmArmed = false
			this.idleConfirmed = true
		} else {
			await this.ctx.storage.setAlarm(reschedule.atMs)
			this.alarmArmed = true
			this.idleConfirmed = false
		}
		return {
			before,
			after,
			blobDeleteFailures: result.hadBlobDeleteFailures,
			expiredRemaining: result.expiredWorkRemaining,
		}
	}

	async alarm() {
		await this.syncInboundDueOwnerHint()
		const ownerId = this.store.getOwnerId()
		if (ownerId) {
			await repairPendingMailboxProviderIndexes({
				sql: this.ctx.storage.sql,
				db: this.env.APP_DB,
				ownerId,
			})
			await this.syncProviderRepairHealth()
		}
		await this.runRetentionPass()
	}

	async runRetentionNow(
		ownerId: OwnerId,
	): Promise<MailboxRunRetentionNowResult> {
		this.store.assertOwner(ownerId)
		return await this.runRetentionPass()
	}

	resetAfterPurge() {
		this.alarmArmed = false
		this.idleConfirmed = true
	}
}
