import { base64ToBytes } from '@kody-internal/shared/base64.ts'
import {
	personIdFromStored,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	accountSuspendedMessage,
	getAccountRestrictionsByStableUserId,
} from '#worker/account/account-suspension.ts'
import { isAccountEmailVerified } from '#worker/identity/email-verification-state.ts'
import { sendViaCloudflareEmailProvider } from './provider-send.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	assertWithinEntitlement,
	assertWithinStorageBytesEntitlement,
	consumeDailyEntitlement,
	estimateEntitlementStorageEntryBytes,
	refundDailyEntitlement,
} from '#worker/entitlements/service.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	recordUsage,
	usageAttributionFieldsFromRequest,
} from '#worker/usage/record-usage.ts'
import { normalizeEmailAddress } from './address.ts'
import { resolveAcceptableNotificationEmails } from './destinations.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import { mailboxRpc, type MailboxEnv } from './mailbox-client.ts'
import { mailboxMessageToEmailMessageRecord } from './mailbox-record-mappers.ts'
import { QuarantinedInboundReplyError } from './quarantined-inbound-reply.ts'
import {
	type MailboxAttachmentInput,
	type MailboxDeliveryEventInput,
	type MailboxMessageInput,
	type MailboxThreadInput,
} from './mailbox-types.ts'
import { emailOutboundPausedMessage } from './outbound-abuse.ts'
import { emailOutboundDeliveryPausedMessage } from './outbound-consecutive-failures.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	emailOutboundProviderCloudflare,
	upsertOutboundProviderIndexRow,
} from './outbound-provider-index.ts'
import { resolveUserPlatformSender } from './platform-address.ts'
import { assertUserEmailGraphAuthority } from './user-email-graph-authority.ts'
import {
	recordEmailReportingEvent,
	type EmailReportingEnv,
} from './reporting-events.ts'
import { emailAttachmentBlobKey } from './blob-keys.ts'
import { ensurePlatformSenderIdentity } from './repo.ts'
import { type EmailMessageRecord, type EmailProcessingStatus } from './types.ts'

type SendEmailEnv = Pick<
	Env,
	| 'APP_DB'
	| 'EMAIL'
	| 'EMAIL_BLOBS'
	| 'USAGE_EVENTS'
	| 'APP_BASE_URL'
	| 'USER_EMAIL_DOMAIN'
	| 'CLOUDFLARE_ACCOUNT_ID'
	| 'CLOUDFLARE_API_BASE_URL'
	| 'CLOUDFLARE_API_TOKEN'
	| 'USER_METER'
	| 'MAILBOX'
	| 'EMAIL_EVENTS'
> &
	EmailReportingEnv &
	MailboxEnv

/**
 * Ceiling on the number of files per outbound message. Total size is
 * governed separately by the plan's email_message_bytes limit (and the
 * provider's own 5 MiB hard cap far above it).
 */
export const maxOutboundEmailAttachments = 10

/**
 * Hard ceiling on combined decoded attachment bytes, matching the
 * provider's 5 MiB message cap. Enforced from base64 string lengths
 * before any decoding so oversized inputs never allocate buffers;
 * plan-level email_message_bytes still applies afterwards.
 */
export const maxOutboundEmailAttachmentTotalBytes = 5 * 1024 * 1024

export type OutboundEmailAttachmentInput = {
	filename: string
	contentType: string
	/** Base64-encoded attachment bytes. */
	contentBase64: string
}

export type EmailSendInput = {
	env: SendEmailEnv
	/**
	 * Mailbox / personal-org owner: Durable Object names, sender-identity and
	 * inbox rows, UserMeter, and other org-keyed storage.
	 */
	userId: OwnerId
	/**
	 * Acting person for platform-sender resolution, email verification, and
	 * account restriction lookups (`users.stable_user_id`). Defaults to the
	 * same bytes as {@link userId} for legacy equal-id personal orgs.
	 */
	actorPersonId?: PersonId
	/** MCP / Open API caller context when the send is user-initiated. */
	request?: RequestContext | null
	/**
	 * Acting user's account email (not the message from/to) when the caller
	 * context has one. Package runtime contexts may pass an empty string;
	 * the account is then resolved from the person stable id so the
	 * verified-account gate and entitlement plan lookup still bind.
	 */
	accountEmail: string
	subject: string
	text?: string | null
	html?: string | null
	replyTo?: string | null
	inReplyToHeader?: string | null
	references?: Array<string>
	threadId?: string | null
	inboxId?: string | null
	attachments?: Array<OutboundEmailAttachmentInput>
} & (
	| {
			/**
			 * Notify-self policy (emailSend): only the acting user's
			 * verified email destinations may be addressed — never
			 * an outreach channel. Identity email always counts once the
			 * account email is verified.
			 */
			recipientPolicy: 'self'
			/** Defaults to the configured default destination. */
			to?: string | Array<string> | null
	  }
	| {
			/**
			 * Reply policy (emailReply): the recipient is derived from the
			 * stored inbound message; callers never supply it. A quarantined
			 * original is refused before quota or provider send.
			 */
			recipientPolicy: 'reply'
			replyToMessageId: string
	  }
)

export type EmailSendResult = {
	message: EmailMessageRecord
	providerMessageId: string | null
	status: EmailProcessingStatus
	error: string | null
}

/**
 * Provider accepted the send, but Mailbox terminal persistence failed after
 * bounded retries. The message must not be marked `failed` or resent.
 */
export class OutboundEmailPersistenceError extends Error {
	override name = 'OutboundEmailPersistenceError'
	readonly messageId: string
	readonly providerMessageId: string | null
	constructor(input: {
		messageId: string
		providerMessageId: string | null
		cause?: unknown
	}) {
		super(
			`Provider accepted outbound email ${input.messageId} (providerMessageId=${input.providerMessageId ?? 'null'}) but terminal persistence failed after retries. Do not resend; repair Mailbox/index state for this message.`,
			{ cause: input.cause },
		)
		this.messageId = input.messageId
		this.providerMessageId = input.providerMessageId
	}
}

async function resolveSelfRecipients(input: {
	db: D1Database
	stableUserId: string
	to: string | Array<string> | null | undefined
	accountEmail: string
}) {
	const { acceptable, defaultEmail } =
		await resolveAcceptableNotificationEmails({
			db: input.db,
			stableUserId: input.stableUserId,
			accountEmail: input.accountEmail,
		})
	const values =
		input.to == null ? [] : Array.isArray(input.to) ? input.to : [input.to]
	if (values.length === 0) {
		return [defaultEmail]
	}
	const normalized = values.map((value) => {
		const address = normalizeEmailAddress(value)
		if (!address) {
			// Caller-supplied address that does not parse — keep it off Sentry.
			throw new McpCallerError(`Invalid recipient email address: ${value}`)
		}
		return address
	})
	const unique: Array<string> = []
	for (const address of normalized) {
		if (!unique.includes(address)) unique.push(address)
	}
	const disallowed = unique.filter((value) => !acceptable.has(value))
	if (disallowed.length > 0) {
		// emailSend is notify-self only; agents often pass a third-party
		// address by mistake. That is a routine caller correction (use
		// emailReply or add a verified destination), not a platform defect
		// — keep it off Sentry.
		throw new McpCallerError(
			`emailSend only delivers to your verified email destinations. Not on the list: ${disallowed.join(', ')}. Add and verify addresses on the email inbox page, or use emailReply to answer stored inbound messages.`,
		)
	}
	return unique
}

function deriveReplyRecipient(original: EmailMessageRecord) {
	const candidates = [
		...original.replyToAddresses,
		original.fromAddress,
		original.envelopeFrom,
	]
	for (const candidate of candidates) {
		if (typeof candidate !== 'string') continue
		const address = normalizeEmailAddress(candidate)
		if (address) return address
	}
	throw new Error('Original message has no reply address.')
}

function buildStoredHeaders(input: {
	messageId: string
	inReplyTo?: string | null
	references?: Array<string>
}) {
	const headers: Record<string, string> = {
		'Message-ID': input.messageId,
		'X-Kody-Email-Message-Id': input.messageId,
	}
	if (input.inReplyTo) headers['In-Reply-To'] = input.inReplyTo
	if (input.references && input.references.length > 0) {
		headers['References'] = input.references.join(' ')
	}
	return headers
}

const cloudflareSendAllowedHeaders = new Set(['in-reply-to', 'references'])

function buildProviderHeaders(headers: Record<string, string>) {
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) =>
			cloudflareSendAllowedHeaders.has(name.toLowerCase()),
		),
	)
}

function isUnsafeOutboundAttachmentFilename(filename: string) {
	return (
		filename === '.' ||
		filename === '..' ||
		filename.includes('/') ||
		filename.includes('\\') ||
		filename.includes('\0')
	)
}

type PreparedOutboundAttachment = {
	filename: string
	contentType: string
	bytes: Uint8Array
	contentBase64: string
}

function prepareOutboundAttachments(
	attachments: Array<OutboundEmailAttachmentInput> | undefined,
): Array<PreparedOutboundAttachment> {
	if (!attachments || attachments.length === 0) return []
	if (attachments.length > maxOutboundEmailAttachments) {
		throw new Error(
			`Outbound email supports at most ${maxOutboundEmailAttachments} attachments.`,
		)
	}
	// Base64 encodes 3 bytes per 4 characters, so the string length bounds
	// the decoded size without allocating anything.
	const estimatedTotalBytes = attachments.reduce(
		(total, attachment) =>
			total + Math.floor((attachment.contentBase64.trim().length * 3) / 4),
		0,
	)
	if (estimatedTotalBytes > maxOutboundEmailAttachmentTotalBytes) {
		throw new Error(
			`Outbound email attachments exceed the ${Math.floor(maxOutboundEmailAttachmentTotalBytes / (1024 * 1024))} MiB combined limit.`,
		)
	}
	return attachments.map((attachment) => {
		const filename = attachment.filename.trim()
		if (!filename) throw new Error('Attachment filename is required.')
		if (isUnsafeOutboundAttachmentFilename(filename)) {
			throw new Error(`Attachment filename is not allowed: ${filename}`)
		}
		const contentType = attachment.contentType.trim()
		if (!contentType) {
			throw new Error(`Attachment content type is required: ${filename}`)
		}
		const contentBase64 = attachment.contentBase64.trim()
		let bytes: Uint8Array
		try {
			bytes = base64ToBytes(contentBase64)
		} catch {
			throw new Error(`Attachment content must be valid base64: ${filename}`)
		}
		if (bytes.byteLength === 0) {
			throw new Error(`Attachment content is empty: ${filename}`)
		}
		return { filename, contentType, bytes, contentBase64 }
	})
}

/**
 * Persist outbound attachment bytes to R2 and prepare Mailbox metadata.
 * A failed blob put degrades that attachment to metadata-only
 * (storage_kind 'unavailable') rather than blocking the send — the provider
 * still receives the in-memory bytes.
 */
async function storeOutboundAttachments(input: {
	blobs: R2Bucket
	userId: OwnerId
	messageId: string
	attachments: Array<PreparedOutboundAttachment>
	now: string
}): Promise<Array<MailboxAttachmentInput>> {
	const rows: Array<MailboxAttachmentInput> = []
	for (const attachment of input.attachments) {
		const attachmentId = crypto.randomUUID()
		const storageKey = emailAttachmentBlobKey(
			input.userId,
			input.messageId,
			attachmentId,
		)
		let stored = false
		try {
			await input.blobs.put(storageKey, attachment.bytes, {
				httpMetadata: { contentType: attachment.contentType },
			})
			stored = true
		} catch (error) {
			console.warn(
				'email-outbound-attachment-blob-put-failed',
				storageKey,
				error,
			)
		}
		rows.push({
			id: attachmentId,
			messageId: input.messageId,
			filename: attachment.filename,
			contentType: attachment.contentType,
			contentId: null,
			disposition: 'attachment',
			size: attachment.bytes.byteLength,
			storageKind: stored ? 'external' : 'unavailable',
			storageKey: stored ? storageKey : null,
			createdAt: input.now,
		})
	}
	return rows
}

async function requireStoredEmailMessage(input: {
	env: SendEmailEnv
	userId: OwnerId
	messageId: string
}) {
	const stored = await mailboxRpc({
		env: input.env,
		userId: input.userId,
	}).getMessage({ messageId: input.messageId })
	if (!stored) {
		throw new Error(
			`Email message disappeared after delivery update: ${input.messageId}`,
		)
	}
	return mailboxMessageToEmailMessageRecord(stored, input.userId)
}

function outboundEmailContentBytes(
	text: string | null,
	html: string | null,
	attachmentBytes = 0,
): number | undefined {
	if (!text && !html && attachmentBytes === 0) return undefined
	let bytes = attachmentBytes
	if (text) bytes += new TextEncoder().encode(text).byteLength
	if (html) bytes += new TextEncoder().encode(html).byteLength
	return bytes
}

function outboundDeliveryEvent(input: {
	id?: string
	messageId: string
	inboxId: string | null
	eventType: MailboxDeliveryEventInput['eventType']
	providerMessageId: string | null
	detail: Record<string, unknown>
	now: string
}): MailboxDeliveryEventInput {
	return {
		id: input.id ?? crypto.randomUUID(),
		messageId: input.messageId,
		inboxId: input.inboxId,
		eventType: input.eventType,
		provider: 'cloudflare-email',
		providerMessageId: input.providerMessageId,
		providerEventId: null,
		detailJson: JSON.stringify(input.detail),
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
	}
}

async function retryMailboxTerminal<T>(
	operation: () => Promise<T>,
): Promise<T> {
	let lastError: unknown
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			return await operation()
		} catch (error) {
			lastError = error
			if (attempt < 2) {
				await new Promise<void>((resolve) =>
					setTimeout(resolve, 50 * 2 ** attempt),
				)
			}
		}
	}
	throw lastError
}

export async function sendOutboundEmail(
	unsafeInput: EmailSendInput,
): Promise<EmailSendResult> {
	if (unsafeInput.userId === systemEmailOwnerId) {
		throw new Error('System outbound email is unsupported.')
	}
	const actorPersonId =
		unsafeInput.actorPersonId ??
		personIdFromStored(unsafeInput.userId as string)
	const input: EmailSendInput = {
		...unsafeInput,
		actorPersonId,
		env: {
			...unsafeInput.env,
			APP_DB: unsafeInput.env.APP_DB,
		},
	}
	const write = async (): Promise<EmailSendResult> => {
		await assertUserEmailGraphAuthority({
			db: input.env.APP_DB,
			ownerId: input.userId,
		})
		const mailbox = mailboxRpc({ env: input.env, userId: input.userId })
		// The from address is always platform-assigned: {username}@<platform
		// domain>. There is no self-service sender verification. The resolved
		// account email (recovered from the person stable id when the caller
		// context carried none, e.g. package subscription handlers) backs the
		// verified-account gate and the entitlement plan lookup so plan limits
		// can never be bypassed by an empty context email.
		const sender = await resolveUserPlatformSender({
			db: input.env.APP_DB,
			env: input.env,
			accountEmail: input.accountEmail,
			userId: actorPersonId,
		})
		const from = sender.from
		const accountEmailVerified = await isAccountEmailVerified({
			db: input.env.APP_DB,
			email: sender.accountEmail,
			stableUserId: actorPersonId,
		})
		if (!accountEmailVerified) {
			throw new Error('Account email must be verified before sending email.')
		}
		// Abuse gates: a suspended account cannot send at all, and an
		// account paused by the delivery-event abuse monitor (spam
		// complaints / repeated bounces) stays blocked until an admin
		// clears the pause. Both protect the shared platform sending
		// domain's reputation.
		const restrictions = await getAccountRestrictionsByStableUserId({
			db: input.env.APP_DB,
			stableUserId: actorPersonId,
		})
		if (restrictions?.suspendedAt) {
			throw new Error(accountSuspendedMessage)
		}
		if (restrictions?.emailOutboundPausedAt) {
			throw new Error(emailOutboundPausedMessage)
		}
		// Delivery-event pauses (abuse + consecutive-failure) are written to
		// the mailbox owner org (`message.userId`). Gate on that owner —
		// `input.userId` — so team-mailbox pauses actually stop team sends and
		// match Account → Email resume for the selected org. Personal abuse
		// pause above still blocks the actor's own sends.
		const mailboxPauses = await input.env.APP_DB.prepare(
			`SELECT email_outbound_paused_at, email_outbound_delivery_paused_at
			 FROM orgs
			 WHERE id = ?${andLiveDeletedAtSql()}`,
		)
			.bind(input.userId)
			.first<{
				email_outbound_paused_at: string | null
				email_outbound_delivery_paused_at: string | null
			}>()
		if (mailboxPauses?.email_outbound_paused_at) {
			throw new Error(emailOutboundPausedMessage)
		}
		if (mailboxPauses?.email_outbound_delivery_paused_at) {
			throw new Error(emailOutboundDeliveryPausedMessage)
		}
		// Sends reference the platform-provisioned sender identity. It is
		// normally created alongside the default inbox at signup; ensuring it
		// here also covers accounts provisioned before the identity existed.
		const senderIdentity = await ensurePlatformSenderIdentity({
			db: input.env.APP_DB,
			userId: input.userId,
			email: sender.from,
			domain: sender.domain,
		})

		let original: EmailMessageRecord | null = null
		let to: Array<string>
		if (input.recipientPolicy === 'reply') {
			// The recipient is derived from the stored inbound message — callers
			// can never turn a reply into outreach.
			const replyOriginalRecord = await mailbox.getMessage({
				messageId: input.replyToMessageId,
			})
			const replyOriginal = replyOriginalRecord
				? mailboxMessageToEmailMessageRecord(replyOriginalRecord, input.userId)
				: null
			if (!replyOriginal || replyOriginal.direction !== 'inbound') {
				throw new Error('Replying requires a stored inbound message.')
			}
			// Before recipient derivation, daily send quota, storage, or the
			// provider. Quarantined mail is often spoofed; a reply backscatters.
			switch (replyOriginal.classification) {
				case 'quarantined':
					throw new QuarantinedInboundReplyError()
				case 'accepted':
					break
				default: {
					const unexpected: never = replyOriginal.classification
					throw new Error(
						`Unexpected inbound classification: ${String(unexpected)}`,
					)
				}
			}
			original = replyOriginal
			to = [deriveReplyRecipient(replyOriginal)]
		} else {
			if (input.inReplyToHeader) {
				const originalRecord = await mailbox.getMessageByMessageIdHeader({
					messageIdHeader: input.inReplyToHeader,
				})
				original = originalRecord
					? mailboxMessageToEmailMessageRecord(originalRecord, input.userId)
					: null
				if (!original) {
					throw new Error(
						`Cannot reply because original message ${input.inReplyToHeader} was not found.`,
					)
				}
			}
			to = await resolveSelfRecipients({
				db: input.env.APP_DB,
				stableUserId: actorPersonId,
				to: input.to,
				accountEmail: sender.accountEmail,
			})
		}
		const subject = input.subject.trim()
		if (!subject) throw new Error('Email subject is required.')
		const text = input.text?.trim() || null
		const html = input.html?.trim() || null
		if (!text && !html) throw new Error('Email text or HTML body is required.')
		const attachments = prepareOutboundAttachments(input.attachments)
		const attachmentBytesTotal = attachments.reduce(
			(total, attachment) => total + attachment.bytes.byteLength,
			0,
		)
		if (attachments.length > 0) {
			// Attachments put outbound mail under the same per-message ceiling
			// as inbound mail. Body-only sends keep their pre-attachment
			// behavior (no per-message cap).
			await assertWithinEntitlement({
				db: input.env.APP_DB,
				userId: input.userId,
				email: sender.accountEmail,
				resource: 'email_message_bytes',
				requested: 0,
				getCurrent: async () =>
					(outboundEmailContentBytes(text, html) ?? 0) + attachmentBytesTotal,
			})
		}
		const messageIdHeader = `<${crypto.randomUUID()}@kody.local>`
		const storedHeaders = buildStoredHeaders({
			messageId: messageIdHeader,
			inReplyTo: input.inReplyToHeader ?? null,
			references: input.references ?? [],
		})
		await assertWithinStorageBytesEntitlement({
			db: input.env.APP_DB,
			env: input.env,
			userId: input.userId,
			email: sender.accountEmail,
			requested:
				estimateEntitlementStorageEntryBytes({
					key: messageIdHeader,
					value: {
						from,
						to,
						subject,
						replyTo: input.replyTo,
						text,
						html,
						headers: storedHeaders,
					},
				}) + attachmentBytesTotal,
		})

		// Atomic check-and-increment via UserMeter (sole daily authority).
		const entitlementNow = new Date()
		await consumeDailyEntitlement({
			db: input.env.APP_DB,
			env: input.env,
			userId: input.userId,
			email: sender.accountEmail,
			resource: 'email_sends_per_day',
			now: entitlementNow,
		})

		const now = entitlementNow.toISOString()
		const inboxId = original?.inboxId ?? input.inboxId ?? null
		const existingThreadId = original?.threadId ?? input.threadId ?? null
		let storedAttachments: Awaited<
			ReturnType<typeof storeOutboundAttachments>
		> = []
		const messageId = crypto.randomUUID()
		const providerHeaders = buildProviderHeaders(storedHeaders)
		let thread: MailboxThreadInput
		let message: MailboxMessageInput
		try {
			const existingThread = existingThreadId
				? await mailbox.getThread({ threadId: existingThreadId })
				: null
			if (existingThreadId && !existingThread) {
				throw new Error(`Email thread was not found: ${existingThreadId}`)
			}
			thread = existingThread
				? {
						...existingThread,
						subjectNormalized: existingThread.subjectNormalized ?? '',
						lastMessageAt:
							existingThread.lastMessageAt > now
								? existingThread.lastMessageAt
								: now,
						updatedAt: now,
					}
				: {
						id: crypto.randomUUID(),
						inboxId,
						subjectNormalized: subject.toLowerCase(),
						rootMessageIdHeader: input.inReplyToHeader ?? null,
						lastMessageAt: now,
						createdAt: now,
						updatedAt: now,
					}
			message = {
				id: messageId,
				direction: 'outbound',
				inboxId,
				threadId: thread.id,
				senderIdentityId: senderIdentity.id,
				fromAddress: from,
				envelopeFrom: from,
				toAddresses: to,
				ccAddresses: [],
				bccAddresses: [],
				replyToAddresses: input.replyTo
					? [normalizeEmailAddress(input.replyTo)].filter(
							(value): value is string => typeof value === 'string',
						)
					: [],
				subject,
				messageIdHeader,
				inReplyToHeader: input.inReplyToHeader ?? null,
				references: input.references ?? [],
				headers: storedHeaders,
				authResults: null,
				textBody: text,
				htmlBody: html,
				rawMimeKey: null,
				rawSize: 0,
				processingStatus: 'stored',
				classification: 'accepted',
				classificationReason: null,
				providerMessageId: null,
				deliveryStatus: null,
				deliveryStatusAt: null,
				error: null,
				receivedAt: null,
				sentAt: null,
				createdAt: now,
				updatedAt: now,
			}
			storedAttachments = await storeOutboundAttachments({
				blobs: input.env.EMAIL_BLOBS,
				userId: input.userId,
				messageId: message.id,
				attachments,
				now,
			})
			const graph = await mailbox.upsertMessageGraph({
				ownerId: input.userId,
				thread,
				message,
				attachments: storedAttachments,
			})
			if (!graph.accepted) {
				throw new Error('Outbound Mailbox graph rejected the message.')
			}
		} catch (error) {
			await refundDailyEntitlement({
				env: input.env,
				userId: input.userId,
				resource: 'email_sends_per_day',
				now: entitlementNow,
			}).catch((refundError: unknown) => {
				console.warn(
					'email-outbound-send-entitlement-refund-failed',
					refundError,
				)
			})
			await Promise.all(
				storedAttachments
					.filter((attachment) => attachment.storageKey != null)
					.map((attachment) =>
						input.env.EMAIL_BLOBS.delete(attachment.storageKey!).catch(
							(deleteError: unknown) => {
								console.warn(
									'email-outbound-attachment-blob-cleanup-failed',
									attachment.storageKey,
									deleteError,
								)
							},
						),
					),
			)
			throw error
		}
		recordEmailReportingEvent(input.env, {
			userId: input.userId,
			eventType: 'email_send',
		})
		await mailbox.upsertDeliveryEvent({
			ownerId: input.userId,
			event: outboundDeliveryEvent({
				messageId: message.id,
				inboxId,
				eventType: 'send_requested',
				providerMessageId: null,
				detail: { to, from, subject, attachmentCount: attachments.length },
				now,
			}),
		})

		const messageContentBytes = outboundEmailContentBytes(
			text,
			html,
			attachmentBytesTotal,
		)
		const sendStartedAtMs = Date.now()
		let sendOutcome: 'success' | 'error' = 'success'
		try {
			let acceptedProviderMessageId: string | null
			try {
				const providerResult = await sendViaCloudflareEmailProvider({
					env: input.env,
					from,
					to,
					subject,
					text,
					html,
					replyTo: input.replyTo
						? (normalizeEmailAddress(input.replyTo) ?? undefined)
						: undefined,
					headers: providerHeaders,
					attachments,
				})
				acceptedProviderMessageId = providerResult.messageId
			} catch (error) {
				// Provider did not accept the send. Safe to mark failed / clear id.
				sendOutcome = 'error'
				const messageText = getErrorMessage(error)
				const failedAt = new Date().toISOString()
				const failedEvent = outboundDeliveryEvent({
					messageId: message.id,
					inboxId,
					eventType: 'failed',
					providerMessageId: null,
					detail: { error: messageText },
					now: failedAt,
				})
				await retryMailboxTerminal(() =>
					mailbox.commitOutboundTerminal({
						ownerId: input.userId,
						messageId: message.id,
						processingStatus: 'failed',
						providerMessageId: null,
						error: messageText,
						sentAt: null,
						event: failedEvent,
					}),
				)
				return {
					message: await requireStoredEmailMessage({
						env: input.env,
						userId: input.userId,
						messageId: message.id,
					}),
					providerMessageId: null,
					status: 'failed',
					error: messageText,
				}
			}

			// Provider accepted — never re-enter the provider call. Persist the
			// owner Mailbox terminal first.
			const sentAt = new Date().toISOString()
			const sentEvent = outboundDeliveryEvent({
				messageId: message.id,
				inboxId,
				eventType: 'sent',
				providerMessageId: acceptedProviderMessageId,
				detail: {
					providerMessageId: acceptedProviderMessageId,
				},
				now: sentAt,
			})
			try {
				await retryMailboxTerminal(() =>
					mailbox.commitOutboundTerminal({
						ownerId: input.userId,
						messageId: message.id,
						processingStatus: 'sent',
						providerMessageId: acceptedProviderMessageId,
						error: null,
						sentAt,
						event: sentEvent,
						...(acceptedProviderMessageId
							? {
									providerIndexRepair: {
										provider: emailOutboundProviderCloudflare,
										providerMessageId: acceptedProviderMessageId,
										messageId: message.id,
										inboxId,
										createdAt: sentAt,
									},
								}
							: {}),
					}),
				)
			} catch (error) {
				console.warn('email-outbound-terminal-persistence-failed', {
					messageId: message.id,
					providerMessageId: acceptedProviderMessageId,
					error,
				})
				throw new OutboundEmailPersistenceError({
					messageId: message.id,
					providerMessageId: acceptedProviderMessageId,
					cause: error,
				})
			}
			// The operational reverse index is independently idempotent. A failed
			// index write must not turn provider acceptance into a resend signal;
			// the Mailbox alarm retries its durable pending repair.
			if (acceptedProviderMessageId) {
				await runD1WithRetry(() =>
					upsertOutboundProviderIndexRow({
						db: input.env.APP_DB,
						providerMessageId: acceptedProviderMessageId,
						userId: input.userId,
						messageId: message.id,
						inboxId,
						now: sentAt,
					}),
				)
					.then(async () => {
						await mailbox.completeOutboundProviderIndexRepair({
							ownerId: input.userId,
							provider: emailOutboundProviderCloudflare,
							providerMessageId: acceptedProviderMessageId,
						})
					})
					.catch((error: unknown) => {
						console.warn('email-outbound-provider-index-persistence-failed', {
							messageId: message.id,
							providerMessageId: acceptedProviderMessageId,
							error,
						})
					})
			}

			return {
				message: await requireStoredEmailMessage({
					env: input.env,
					userId: input.userId,
					messageId: message.id,
				}),
				providerMessageId: acceptedProviderMessageId,
				status: 'sent',
				error: null,
			}
		} finally {
			if (input.userId) {
				await recordUsage(input.env, {
					userId: input.userId,
					eventType: 'email_send',
					entityId: message.id,
					bytes: messageContentBytes,
					durationMs: Date.now() - sendStartedAtMs,
					outcome: sendOutcome,
					...usageAttributionFieldsFromRequest(input.request),
				})
			}
		}
	}
	return input.userId
		? await withAccountWriteLease({
				db: input.env.APP_DB,
				stableUserId: input.userId,
				env: input.env,
				write,
			})
		: await write()
}
