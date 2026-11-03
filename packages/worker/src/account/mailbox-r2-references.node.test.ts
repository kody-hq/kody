import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type { MailboxBlobReference } from '#worker/email/mailbox-types.ts'
import type * as MailboxInternalReadModule from '#worker/email/mailbox-internal-read.ts'

const mocks = vi.hoisted(() => ({
	listInternalUserEmailBlobReferences: vi.fn(),
}))

vi.mock('#worker/email/mailbox-internal-read.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MailboxInternalReadModule>()
	return {
		...actual,
		listInternalUserEmailBlobReferences:
			mocks.listInternalUserEmailBlobReferences,
	}
})

const {
	countMailboxEmailObjectRefs,
	listAllMailboxEmailObjectRefs,
	listMailboxEmailObjectRefPage,
	resolveMailboxEmailObjectRef,
} = await import('./mailbox-r2-references.ts')

test('Mailbox R2 helpers share pagination, mapping, and revalidation semantics', async () => {
	const raw: MailboxBlobReference = {
		kind: 'raw_mime',
		key: 'email-raw:v1:user-a/message-a',
		messageId: 'message-a',
		attachmentId: null,
	}
	const attachment: MailboxBlobReference = {
		kind: 'attachment',
		key: 'email-attachment:v1:user-a/message-a/attachment-a',
		messageId: 'message-a',
		attachmentId: 'attachment-a',
	}
	mocks.listInternalUserEmailBlobReferences.mockImplementation(
		async ({ startAfter }: { startAfter?: string | null }) =>
			startAfter == null
				? {
						references: [raw],
						nextStartAfter: 'raw_mime:message-a',
						truncated: true,
					}
				: {
						references: [attachment],
						nextStartAfter: null,
						truncated: false,
					},
	)
	const env = {} as Env

	expect(
		await listAllMailboxEmailObjectRefs({
			env,
			ownerId: ownerIdFromStored('user-a'),
		}),
	).toEqual([
		{
			surfaceId: 'email_raw_mime',
			binding: 'EMAIL_BLOBS',
			key: raw.key,
		},
		{
			surfaceId: 'email_attachment_storage_key',
			binding: 'EMAIL_BLOBS',
			key: attachment.key,
		},
	])
	expect(
		await countMailboxEmailObjectRefs({
			env,
			ownerId: ownerIdFromStored('user-a'),
		}),
	).toBe(2)

	const page = await listMailboxEmailObjectRefPage({
		env,
		ownerId: ownerIdFromStored('user-a'),
		pageSize: 1,
		startAfter: null,
	})
	const stableRef = page.references[0]!
	expect(stableRef).toMatchObject({
		surfaceId: 'email_raw_mime',
		key: raw.key,
		source: { startAfter: null, reference: raw },
	})
	expect(
		await resolveMailboxEmailObjectRef({
			env,
			ownerId: ownerIdFromStored('user-a'),
			source: stableRef.source,
			expectedKey: stableRef.key,
		}),
	).toMatchObject({ key: raw.key })
	expect(
		await resolveMailboxEmailObjectRef({
			env,
			ownerId: ownerIdFromStored('user-a'),
			source: stableRef.source,
			expectedKey: 'changed-key',
		}),
	).toBeNull()
})

test('stable Mailbox R2 refs revalidate later items from their preceding cursor', async () => {
	const references: Array<MailboxBlobReference> = [
		{
			kind: 'raw_mime',
			key: 'email-raw:v1:user-a/message-a',
			messageId: 'message-a',
			attachmentId: null,
		},
		{
			kind: 'raw_mime',
			key: 'email-raw:v1:user-a/message-b',
			messageId: 'message-b',
			attachmentId: null,
		},
		{
			kind: 'attachment',
			key: 'email-attachment:v1:user-a/message-b/attachment-b',
			messageId: 'message-b',
			attachmentId: 'attachment-b',
		},
	]
	mocks.listInternalUserEmailBlobReferences.mockImplementation(
		async ({
			pageSize,
			startAfter,
		}: {
			pageSize?: number
			startAfter?: string | null
		}) => {
			if (pageSize === 3) {
				return {
					references,
					nextStartAfter: null,
					truncated: false,
				}
			}
			const index =
				startAfter == null ? 0 : startAfter === 'raw_mime:message-a' ? 1 : 2
			return {
				references: [references[index]!],
				nextStartAfter:
					index < 2 ? `raw_mime:message-${index ? 'b' : 'a'}` : null,
				truncated: index < 2,
			}
		},
	)
	const env = {} as Env
	const page = await listMailboxEmailObjectRefPage({
		env,
		ownerId: ownerIdFromStored('user-a'),
		pageSize: 3,
		startAfter: null,
	})
	expect(
		page.references.map((reference) => reference.source.startAfter),
	).toEqual([null, 'raw_mime:message-a', 'raw_mime:message-b'])
	for (const stableReference of page.references.slice(1)) {
		await expect(
			resolveMailboxEmailObjectRef({
				env,
				ownerId: ownerIdFromStored('user-a'),
				source: stableReference.source,
				expectedKey: stableReference.key,
			}),
		).resolves.toMatchObject({ key: stableReference.key })
	}
})

test.each([
	['null', [null]],
	['unchanged', ['raw_mime:message-a', 'raw_mime:message-a']],
	[
		'repeated',
		['raw_mime:message-a', 'raw_mime:message-b', 'raw_mime:message-a'],
	],
] as const)(
	'Mailbox R2 pagination fails closed on a malformed %s cursor',
	async (_label, cursors) => {
		let call = 0
		mocks.listInternalUserEmailBlobReferences.mockImplementation(async () => ({
			references: [],
			nextStartAfter: cursors[Math.min(call++, cursors.length - 1)]!,
			truncated: true,
		}))
		await expect(
			countMailboxEmailObjectRefs({
				env: {} as Env,
				ownerId: ownerIdFromStored('user-a'),
			}),
		).rejects.toThrow(/pagination did not advance/)
	},
)
