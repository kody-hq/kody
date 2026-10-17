import { createElement } from 'react'
import { expect, test } from 'vitest'
import { AdminSystemEmailPage } from './pages/admin-system-email.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'
import { type AdminSystemEmailLoaderData } from '#universal/loader-data.ts'

const message = {
	id: 'message-1',
	inbox_local_part: 'support',
	from_address: 'sender@example.com',
	envelope_from: null,
	subject: 'Help requested',
	processing_status: 'processed',
	raw_size: 123,
	received_at: null,
	created_at: '2026-01-01T00:00:00Z',
	to_addresses: ['support@example.com'],
	cc_addresses: [],
	reply_to_addresses: [],
	headers: {},
	text_body: 'Please help',
	html_body: null,
	raw_mime: null,
	attachments: [],
}
const payload: AdminSystemEmailLoaderData = {
	ok: true,
	ownerId: 'operator',
	systemLocals: ['support'],
	limits: {
		maxMessageBytes: 1000,
		maxReceivesPerDay: 100,
		maxStoredMessages: 100,
		retentionDays: 30,
		pruneBatchSize: 10,
	},
	messages: [message],
	selectedMessage: message,
	page: 1,
	pageSize: 20,
	total: 1,
}
test('selected system mail exposes the destructive action with message identity', async () => {
	const html = await renderStartPage(
		createElement(AdminSystemEmailPage, {
			payload,
			currentHref: '/admin/system-email?messageId=message-1',
		}),
		'/admin/system-email?messageId=message-1',
	)
	expect(html).toContain('Delete message &quot;Help requested&quot;')
	expect(html).toContain('Delete this system email message and its attachments')
	expect(html).toContain(
		'Admin reads and deletes of message content are audit logged.',
	)
})
test('empty system inbox has no destructive message action', async () => {
	const html = await renderStartPage(
		createElement(AdminSystemEmailPage, {
			payload: { ...payload, selectedMessage: null, messages: [], total: 0 },
			currentHref: '/admin/system-email',
		}),
		'/admin/system-email',
	)
	expect(html).toContain('No system mail has been stored.')
	expect(html).not.toContain('Delete this system email message')
})
