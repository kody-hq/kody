import { expect, test } from 'vitest'
import { summarizeMailboxDump } from '#worker/dr/mailbox-import-snapshot.ts'
import type { MailboxExportRow } from '#worker/email/mailbox-types.ts'

const row = (kind: MailboxExportRow['kind'], fields: Record<string, unknown>) =>
	({ kind, row: fields }) as unknown as MailboxExportRow

const parts: Array<Array<MailboxExportRow>> = [
	[row('thread', { id: 't1' }), row('message', { id: 'm1', threadId: 't1' })],
	[
		row('message', { id: 'm2', threadId: 't1' }),
		row('attachment', { id: 'a1', messageId: 'm1' }),
		row('delivery_event', { id: 'e1', messageId: 'm2' }),
	],
]

test('a split Mailbox dump is validated one part at a time', async () => {
	const loaded: Array<number> = []
	let inFlight = 0
	const summary = await summarizeMailboxDump({
		partCount: parts.length,
		async loadPart(index) {
			inFlight += 1
			expect(inFlight).toBe(1)
			loaded.push(index)
			await Promise.resolve()
			inFlight -= 1
			return parts[index]!
		},
		onRow: () => {},
	})
	expect(loaded).toEqual([0, 1])
	expect(summary.counts).toEqual({
		threads: 1,
		messages: 2,
		attachments: 1,
		deliveryEvents: 1,
	})
	expect(summary.partCounts).toEqual([
		{ thread: 1, message: 1, attachment: 0, delivery_event: 0 },
		{ thread: 0, message: 1, attachment: 1, delivery_event: 1 },
	])
	expect(summary.attachmentsByMessage.get('m1')?.map((a) => a.id)).toEqual([
		'a1',
	])
})

test('a split Mailbox dump rejects duplicates and dangling references across parts', async () => {
	const summarize = (input: Array<Array<MailboxExportRow>>) =>
		summarizeMailboxDump({
			partCount: input.length,
			loadPart: async (index) => input[index]!,
			onRow: () => {},
		})
	await expect(
		summarize([[row('thread', { id: 't1' })], [row('thread', { id: 't1' })]]),
	).rejects.toThrow('duplicate thread id')
	await expect(
		summarize([[row('message', { id: 'm1', threadId: 'missing' })]]),
	).rejects.toThrow('references a missing thread')
})
