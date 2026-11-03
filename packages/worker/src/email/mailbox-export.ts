import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { emailAttachmentBlobKey, emailRawMimeKey } from './blob-keys.ts'
import {
	mailboxBlobRefAttachmentCursorPrefix,
	mailboxBlobRefRawMimeCursorPrefix,
	mailboxExportCursorPrefixForPhase,
	normalizeMailboxPageSize,
	parseMailboxBlobRefCursor,
	parseMailboxExportCursor,
	type MailboxBlobReference,
	type MailboxBlobReferencePage,
	type MailboxExportPhase,
	type MailboxExportResult,
	type MailboxExportRow,
} from './mailbox-types.ts'
import {
	mapMailboxAttachmentRow,
	mapMailboxDeliveryEventRow,
	mapMailboxMessageRow,
	mapMailboxThreadRow,
} from './mailbox-mappers.ts'

export function exportMailboxFromStore(
	sql: SqlStorage,
	input: {
		pageSize?: number
		startAfter?: string | null
	},
): MailboxExportResult {
	const pageSize = normalizeMailboxPageSize(input.pageSize)
	const startAfterRaw =
		typeof input.startAfter === 'string' && input.startAfter.length > 0
			? input.startAfter
			: null
	const phaseOrder: Array<MailboxExportPhase> = [
		'thread',
		'message',
		'attachment',
		'delivery_event',
	]
	const result: MailboxExportResult = {
		rows: [],
		nextStartAfter: null,
		truncated: false,
	}
	let { phase, startAfterId } = parseMailboxExportCursor(startAfterRaw)
	let remaining = pageSize
	let phaseIndex = phaseOrder.indexOf(phase)
	const maxIterations = phaseOrder.length + 1
	let iterations = 0

	while (phaseIndex < phaseOrder.length) {
		iterations += 1
		if (iterations > maxIterations) {
			throw new Error('exportMailbox exceeded phase iteration budget')
		}
		if (remaining <= 0) {
			const nextPhase = phaseOrder[phaseIndex]!
			const handoff = mailboxExportCursorPrefixForPhase(nextPhase)
			if (handoff === startAfterRaw) {
				phaseIndex += 1
				startAfterId = ''
				continue
			}
			result.nextStartAfter = handoff
			result.truncated = true
			return result
		}

		const currentPhase = phaseOrder[phaseIndex]!
		const page = exportPhasePage(sql, {
			phase: currentPhase,
			startAfterId,
			limit: remaining,
		})
		result.rows.push(...page.rows)
		remaining -= page.taken

		if (page.truncated) {
			if (page.taken <= 0) {
				phaseIndex += 1
				startAfterId = ''
				continue
			}
			const nextStartAfter = `${mailboxExportCursorPrefixForPhase(currentPhase)}${page.nextId}`
			if (nextStartAfter === startAfterRaw) {
				phaseIndex += 1
				startAfterId = ''
				continue
			}
			result.nextStartAfter = nextStartAfter
			result.truncated = true
			return result
		}

		phaseIndex += 1
		startAfterId = ''
		if (remaining <= 0 && phaseIndex < phaseOrder.length) {
			const nextPhase = phaseOrder[phaseIndex]!
			const handoff = mailboxExportCursorPrefixForPhase(nextPhase)
			if (handoff === startAfterRaw) continue
			result.nextStartAfter = handoff
			result.truncated = true
			return result
		}
	}
	return result
}

function exportPhasePage(
	sql: SqlStorage,
	input: {
		phase: MailboxExportPhase
		startAfterId: string
		limit: number
	},
): {
	rows: Array<MailboxExportRow>
	taken: number
	truncated: boolean
	nextId: string
} {
	if (input.limit <= 0) {
		return {
			rows: [],
			taken: 0,
			truncated: false,
			nextId: input.startAfterId,
		}
	}
	const limit = Math.trunc(input.limit)
	const tableForPhase = (phase: MailboxExportPhase) => {
		switch (phase) {
			case 'thread':
				return 'email_threads'
			case 'message':
				return 'email_messages'
			case 'attachment':
				return 'email_attachments'
			case 'delivery_event':
				return 'email_delivery_events'
			default: {
				const exhaustive: never = phase
				throw new Error(`Unhandled export phase: ${String(exhaustive)}`)
			}
		}
	}
	const rows = sql
		.exec<Record<string, SqlStorageValue>>(
			`SELECT * FROM ${tableForPhase(input.phase)}
			WHERE id > ?
			ORDER BY id ASC
			LIMIT ?`,
			input.startAfterId,
			limit + 1,
		)
		.toArray()
	const truncated = rows.length > limit
	const pageRows = truncated ? rows.slice(0, limit) : rows
	const last = pageRows[pageRows.length - 1]
	const mapped: Array<MailboxExportRow> = pageRows.map((row) => {
		switch (input.phase) {
			case 'thread':
				return { kind: 'thread', row: mapMailboxThreadRow(row) }
			case 'message':
				return { kind: 'message', row: mapMailboxMessageRow(row) }
			case 'attachment':
				return { kind: 'attachment', row: mapMailboxAttachmentRow(row) }
			case 'delivery_event':
				return {
					kind: 'delivery_event',
					row: mapMailboxDeliveryEventRow(row),
				}
			default: {
				const exhaustive: never = input.phase
				throw new Error(`Unhandled export phase: ${String(exhaustive)}`)
			}
		}
	})
	return {
		rows: mapped,
		taken: pageRows.length,
		truncated,
		nextId: last ? String(last['id']) : input.startAfterId,
	}
}

/**
 * List owner-safe blob references. Inbound raw MIME keys are always derived
 * from the canonical helper (even when the stored column is null). External
 * attachment keys are included only when they match the canonical helper.
 */
export function listMailboxBlobReferences(
	sql: SqlStorage,
	input: {
		ownerId: OwnerId | null
		pageSize?: number
		startAfter?: string | null
	},
): MailboxBlobReferencePage {
	if (input.ownerId == null) {
		return { references: [], nextStartAfter: null, truncated: false }
	}
	const ownerId = input.ownerId
	const pageSize = normalizeMailboxPageSize(input.pageSize)
	const startAfterRaw =
		typeof input.startAfter === 'string' && input.startAfter.length > 0
			? input.startAfter
			: null
	const { phase, startAfterId } = parseMailboxBlobRefCursor(startAfterRaw)
	const references: Array<MailboxBlobReference> = []
	let remaining = pageSize

	if (phase === 'raw_mime') {
		const rows = sql
			.exec<{ id: string }>(
				`SELECT id FROM email_messages
				WHERE direction = 'inbound' AND id > ?
				ORDER BY id ASC
				LIMIT ?`,
				startAfterId,
				remaining + 1,
			)
			.toArray()
		const truncated = rows.length > remaining
		const pageRows = truncated ? rows.slice(0, remaining) : rows
		for (const row of pageRows) {
			references.push({
				kind: 'raw_mime',
				key: emailRawMimeKey(ownerId, row.id),
				messageId: row.id,
				attachmentId: null,
			})
		}
		if (truncated) {
			const last = pageRows[pageRows.length - 1]!
			return {
				references,
				nextStartAfter: `${mailboxBlobRefRawMimeCursorPrefix}${last.id}`,
				truncated: true,
			}
		}
		remaining -= pageRows.length
		if (remaining <= 0) {
			return {
				references,
				nextStartAfter: mailboxBlobRefAttachmentCursorPrefix,
				truncated: true,
			}
		}
		const attachmentPage = listAttachmentBlobReferences(sql, {
			ownerId,
			startAfterId: '',
			limit: remaining,
		})
		references.push(...attachmentPage.references)
		return {
			references,
			nextStartAfter: attachmentPage.nextStartAfter,
			truncated: attachmentPage.truncated,
		}
	}

	return listAttachmentBlobReferences(sql, {
		ownerId,
		startAfterId,
		limit: remaining,
	})
}

function listAttachmentBlobReferences(
	sql: SqlStorage,
	input: {
		ownerId: OwnerId
		startAfterId: string
		limit: number
	},
): MailboxBlobReferencePage {
	if (input.limit <= 0) {
		return { references: [], nextStartAfter: null, truncated: false }
	}
	// Scan past non-canonical keys so callers never receive forgeable refs.
	const scanLimit = Math.max(input.limit * 4, 32)
	const rows = sql
		.exec<{ id: string; message_id: string; storage_key: string | null }>(
			`SELECT id, message_id, storage_key FROM email_attachments
			WHERE storage_kind = 'external' AND id > ?
			ORDER BY id ASC
			LIMIT ?`,
			input.startAfterId,
			scanLimit,
		)
		.toArray()
	const references: Array<MailboxBlobReference> = []
	let lastScannedId = input.startAfterId
	for (const row of rows) {
		lastScannedId = row.id
		const expected = emailAttachmentBlobKey(
			input.ownerId,
			row.message_id,
			row.id,
		)
		if (row.storage_key !== expected) continue
		references.push({
			kind: 'attachment',
			key: expected,
			messageId: row.message_id,
			attachmentId: row.id,
		})
		if (references.length >= input.limit) {
			return {
				references,
				nextStartAfter: `${mailboxBlobRefAttachmentCursorPrefix}${row.id}`,
				truncated: true,
			}
		}
	}
	const maybeMore = rows.length >= scanLimit
	return {
		references,
		nextStartAfter: maybeMore
			? `${mailboxBlobRefAttachmentCursorPrefix}${lastScannedId}`
			: null,
		truncated: maybeMore,
	}
}
