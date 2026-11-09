import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { MailboxEnv } from '#worker/email/mailbox-client.ts'
import { listInternalUserEmailBlobReferences } from '#worker/email/mailbox-internal-read.ts'
import {
	mailboxBlobRefAttachmentCursorPrefix,
	mailboxBlobRefRawMimeCursorPrefix,
	parseMailboxBlobRefCursor,
	type MailboxBlobReference,
	type MailboxBlobReferencePage,
} from '#worker/email/mailbox-types.ts'

const mailboxBlobReferencePaginationError =
	'Mailbox blob-reference pagination did not advance.'

export type AccountMailboxEmailObjectRef = {
	surfaceId: 'email_raw_mime' | 'email_attachment_storage_key'
	binding: 'EMAIL_BLOBS'
	key: string
}

export type AccountMailboxEmailObjectSource = {
	kind: 'mailbox_email_blob'
	startAfter: string | null
	reference: MailboxBlobReference
}

export type StableAccountMailboxEmailObjectRef =
	AccountMailboxEmailObjectRef & {
		source: AccountMailboxEmailObjectSource
	}

export function mailboxBlobReferenceToAccountObjectRef(
	reference: MailboxBlobReference,
): AccountMailboxEmailObjectRef {
	return {
		surfaceId:
			reference.kind === 'raw_mime'
				? 'email_raw_mime'
				: 'email_attachment_storage_key',
		binding: 'EMAIL_BLOBS',
		key: reference.key,
	}
}

function cursorAfterMailboxBlobReference(
	reference: MailboxBlobReference,
): string {
	if (reference.kind === 'raw_mime') {
		return `${mailboxBlobRefRawMimeCursorPrefix}${reference.messageId}`
	}
	if (reference.attachmentId == null) {
		throw new Error(
			'Mailbox attachment blob reference is missing attachmentId.',
		)
	}
	return `${mailboxBlobRefAttachmentCursorPrefix}${reference.attachmentId}`
}

function assertMailboxBlobReferenceCursorAdvanced(input: {
	startAfter: string | null
	nextStartAfter: string | null
	seenCursors?: Set<string>
}) {
	const nextStartAfter = input.nextStartAfter
	if (
		nextStartAfter == null ||
		nextStartAfter === input.startAfter ||
		input.seenCursors?.has(nextStartAfter)
	) {
		throw new Error(mailboxBlobReferencePaginationError)
	}
	try {
		const current = parseMailboxBlobRefCursor(input.startAfter)
		const next = parseMailboxBlobRefCursor(nextStartAfter)
		const currentPhase = current.phase === 'raw_mime' ? 0 : 1
		const nextPhase = next.phase === 'raw_mime' ? 0 : 1
		if (
			nextPhase < currentPhase ||
			(nextPhase === currentPhase && next.startAfterId <= current.startAfterId)
		) {
			throw new Error(mailboxBlobReferencePaginationError)
		}
	} catch {
		throw new Error(mailboxBlobReferencePaginationError)
	}
}

function assertMailboxBlobReferencePageAdvanced(input: {
	startAfter: string | null
	page: MailboxBlobReferencePage
	seenCursors?: Set<string>
}) {
	if (!input.page.truncated) return
	assertMailboxBlobReferenceCursorAdvanced({
		startAfter: input.startAfter,
		nextStartAfter: input.page.nextStartAfter,
		seenCursors: input.seenCursors,
	})
}

export async function listMailboxEmailObjectRefPage(input: {
	env: MailboxEnv
	ownerId: OwnerId
	pageSize: number
	startAfter: string | null
}): Promise<{
	references: Array<StableAccountMailboxEmailObjectRef>
	nextStartAfter: string | null
	truncated: boolean
}> {
	const page = await listInternalUserEmailBlobReferences(input)
	assertMailboxBlobReferencePageAdvanced({
		startAfter: input.startAfter,
		page,
	})
	let precedingCursor = input.startAfter
	return {
		references: page.references.map((reference) => {
			const referenceCursor = cursorAfterMailboxBlobReference(reference)
			assertMailboxBlobReferenceCursorAdvanced({
				startAfter: precedingCursor,
				nextStartAfter: referenceCursor,
			})
			const stableReference: StableAccountMailboxEmailObjectRef = {
				...mailboxBlobReferenceToAccountObjectRef(reference),
				source: {
					kind: 'mailbox_email_blob',
					startAfter: precedingCursor,
					reference,
				},
			}
			precedingCursor = referenceCursor
			return stableReference
		}),
		nextStartAfter: page.nextStartAfter,
		truncated: page.truncated,
	}
}

async function visitMailboxBlobReferencePages(input: {
	env: MailboxEnv
	ownerId: OwnerId
	visit: (page: MailboxBlobReferencePage) => void
}) {
	let startAfter: string | null = null
	const seenCursors = new Set<string>()
	while (true) {
		const page = await listInternalUserEmailBlobReferences({
			env: input.env,
			ownerId: input.ownerId,
			pageSize: 500,
			startAfter,
		})
		input.visit(page)
		if (!page.truncated) return
		assertMailboxBlobReferencePageAdvanced({
			startAfter,
			page,
			seenCursors,
		})
		if (page.nextStartAfter == null) {
			throw new Error(mailboxBlobReferencePaginationError)
		}
		seenCursors.add(page.nextStartAfter)
		startAfter = page.nextStartAfter
	}
}

export async function listAllMailboxEmailObjectRefs(input: {
	env: MailboxEnv
	ownerId: OwnerId
}): Promise<Array<AccountMailboxEmailObjectRef>> {
	const references: Array<AccountMailboxEmailObjectRef> = []
	await visitMailboxBlobReferencePages({
		...input,
		visit: (page) => {
			references.push(
				...page.references.map(mailboxBlobReferenceToAccountObjectRef),
			)
		},
	})
	return references
}

export async function countMailboxEmailObjectRefs(input: {
	env: MailboxEnv
	ownerId: OwnerId
}): Promise<number> {
	let count = 0
	await visitMailboxBlobReferencePages({
		...input,
		visit: (page) => {
			count += page.references.length
		},
	})
	return count
}

export async function resolveMailboxEmailObjectRef(input: {
	env: MailboxEnv
	ownerId: OwnerId
	source: AccountMailboxEmailObjectSource
	expectedKey: string
}): Promise<AccountMailboxEmailObjectRef | null> {
	const page = await listMailboxEmailObjectRefPage({
		env: input.env,
		ownerId: input.ownerId,
		pageSize: 1,
		startAfter: input.source.startAfter,
	})
	const current = page.references[0]
	if (!current) return null
	const actual = current.source.reference
	const expected = input.source.reference
	return actual.kind === expected.kind &&
		actual.key === expected.key &&
		actual.messageId === expected.messageId &&
		actual.attachmentId === expected.attachmentId &&
		current.key === input.expectedKey
		? current
		: null
}
