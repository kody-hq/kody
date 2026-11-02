import {
	loadPostalMime,
	type PostalMimeAddress as PostalAddress,
	type PostalMimeAttachment as PostalAttachment,
} from '#worker/postal-mime-load.ts'
import {
	normalizeAddrSpec,
	normalizeEmailAddress,
	normalizeHeaderMailbox,
	parseHeaderAddressList,
	parseHeaderEmailAddressList,
} from './address.ts'
import {
	maxKeptInboundRawBytes,
	maxSurvivableInboundRawBytes,
	prepareInboundRawMime,
	type PreparedInboundRawMime,
} from './skinny-inbound-mime.ts'
import { selectTrustedCloudflareAuthResults } from './auth-verdict.ts'
import {
	type EmailAttachmentMetadata,
	type EmailMailbox,
	type ParsedInboundEmail,
} from './types.ts'

/**
 * Maximum raw MIME persisted after inbound reduction. Same bound as
 * paid/max `email_message_bytes`. Larger mail is accepted up to
 * `maxSurvivableInboundRawBytes` and reduced to this size.
 */
export const maxRawMimeBytes = maxKeptInboundRawBytes
export { maxKeptInboundRawBytes, maxSurvivableInboundRawBytes }

export class InboundRawMimeTooLargeError extends Error {
	override name = 'InboundRawMimeTooLargeError'
	readonly rawSize: number
	readonly maxRawSize: number
	constructor(rawSize: number, maxRawSize: number) {
		super(
			`Inbound email raw MIME is too large (${rawSize} bytes, max ${maxRawSize}).`,
		)
		this.rawSize = rawSize
		this.maxRawSize = maxRawSize
	}
}

function flattenPostalAddresses(
	addresses: PostalAddress | Array<PostalAddress> | undefined,
): Array<EmailMailbox> {
	const input = Array.isArray(addresses)
		? addresses
		: addresses
			? [addresses]
			: []
	const out: Array<EmailMailbox> = []
	for (const address of input) {
		if ('group' in address && Array.isArray(address.group)) {
			for (const groupAddress of address.group) {
				const normalized = normalizeAddrSpec(groupAddress.address)
				if (normalized) {
					out.push({ name: groupAddress.name || null, address: normalized })
				}
			}
			continue
		}
		if (!address.address) continue
		const normalized = normalizeAddrSpec(address.address)
		if (normalized)
			out.push({ name: address.name || null, address: normalized })
	}
	return out
}

function normalizeReferences(value: string | undefined) {
	if (!value) return []
	return value
		.split(/\s+/)
		.map((entry) => entry.trim())
		.filter(Boolean)
}

function headersToRecord(
	parsedHeaders: Array<{ name: string; value: string }>,
) {
	const record: Record<string, Array<string>> = {}
	for (const header of parsedHeaders) {
		const key = header.name.toLowerCase()
		record[key] = [...(record[key] ?? []), header.value]
	}
	return record
}

function getHeader(headers: Headers, name: string) {
	return headers.get(name)?.trim() || null
}

function getPostalHeader(
	headers: Array<{ key: string; value: string }>,
	name: string,
) {
	const normalized = name.toLowerCase()
	return (
		headers.find((header) => header.key.toLowerCase() === normalized)?.value ??
		null
	)
}

function attachmentSize(attachment: PostalAttachment) {
	const content = attachment.content
	if (typeof content === 'string') {
		return new TextEncoder().encode(content).byteLength
	}
	return content.byteLength
}

function toAttachmentMetadata(
	attachments: Array<PostalAttachment>,
): Array<EmailAttachmentMetadata> {
	return attachments.map((attachment) => ({
		filename: attachment.filename,
		contentType: attachment.mimeType,
		contentId: attachment.contentId ?? null,
		disposition: attachment.disposition,
		size: attachmentSize(attachment),
	}))
}

function dedupeMailboxes(addresses: Array<EmailMailbox>) {
	const seen = new Set<string>()
	const out: Array<EmailMailbox> = []
	for (const mailbox of addresses) {
		if (seen.has(mailbox.address)) continue
		seen.add(mailbox.address)
		out.push(mailbox)
	}
	return out
}

export async function parseForwardableEmailMessage(
	message: ForwardableEmailMessage,
	options: { maxRawSize?: number; maxKeptBytes?: number } = {},
): Promise<ParsedInboundEmail> {
	const prepared = await readAndPrepareForwardableEmailRawMime(message, {
		maxSurvivableBytes: options.maxRawSize,
		maxKeptBytes: options.maxKeptBytes,
	})
	return mergePreparedInboundParse(
		await parseForwardableEmailRawMime(message, prepared.rawMime),
		prepared,
	)
}

export async function readAndPrepareForwardableEmailRawMime(
	message: ForwardableEmailMessage,
	options: { maxKeptBytes?: number; maxSurvivableBytes?: number } = {},
): Promise<PreparedInboundRawMime> {
	const maxSurvivableBytes =
		options.maxSurvivableBytes ?? maxSurvivableInboundRawBytes
	const maxKeptBytes = options.maxKeptBytes ?? maxKeptInboundRawBytes
	if (message.rawSize > maxSurvivableBytes) {
		throw new InboundRawMimeTooLargeError(message.rawSize, maxSurvivableBytes)
	}
	const bytes = new Uint8Array(await new Response(message.raw).arrayBuffer())
	if (bytes.byteLength > maxSurvivableBytes) {
		throw new InboundRawMimeTooLargeError(bytes.byteLength, maxSurvivableBytes)
	}
	return await prepareInboundRawMime(bytes, { maxKeptBytes })
}

export async function readForwardableEmailRawMime(
	message: ForwardableEmailMessage,
) {
	const prepared = await readAndPrepareForwardableEmailRawMime(message)
	return prepared.rawMime
}

export function mergePreparedInboundParse(
	parsed: ParsedInboundEmail,
	prepared: PreparedInboundRawMime,
): ParsedInboundEmail {
	return {
		...parsed,
		rawSize: prepared.reduced ? prepared.keptRawSize : parsed.rawSize,
		attachments: [...parsed.attachments, ...prepared.omittedAttachments],
	}
}

export async function parseForwardableEmailRawMime(
	message: ForwardableEmailMessage,
	rawMime: string,
): Promise<ParsedInboundEmail> {
	const PostalMime = await loadPostalMime()
	const parsed = await PostalMime.parse(rawMime, {
		attachmentEncoding: 'arraybuffer',
	})
	const parsedHeaders = parsed.headers.map((header) => ({
		name: header.originalKey || header.key,
		value: header.value,
	}))
	// The From address decides who the message runs as, so it is never read
	// out of a larger, malformed value (e.g. a quoted local part holding `@`)
	// or picked from a From header that names several mailboxes. postal-mime
	// keeps only the first mailbox of a From list, so the raw header is
	// counted too.
	const postalFrom = parsed.from
		? 'group' in parsed.from && Array.isArray(parsed.from.group)
			? parsed.from.group
			: [parsed.from]
		: []
	const rawHeaderFrom = getHeader(message.headers, 'From')
	const headerFromAddress =
		postalFrom.length > 1 ||
		parseHeaderEmailAddressList(rawHeaderFrom).length > 1
			? null
			: postalFrom.length === 1
				? normalizeAddrSpec(postalFrom[0]?.address)
				: rawHeaderFrom
					? normalizeHeaderMailbox(rawHeaderFrom)
					: null
	const fromAddress = headerFromAddress ?? normalizeAddrSpec(message.from)
	const normalizedEnvelopeTo = normalizeEmailAddress(message.to)
	const toAddresses = dedupeMailboxes([
		...(normalizedEnvelopeTo
			? [{ name: null, address: normalizedEnvelopeTo }]
			: []),
		...flattenPostalAddresses(parsed.to),
		...parseHeaderAddressList(getHeader(message.headers, 'To')),
	])
	const ccAddresses = dedupeMailboxes(flattenPostalAddresses(parsed.cc))
	const bccAddresses = dedupeMailboxes(flattenPostalAddresses(parsed.bcc))
	const replyToAddresses = dedupeMailboxes(
		flattenPostalAddresses(parsed.replyTo),
	)
	const subject = parsed.subject ?? getHeader(message.headers, 'Subject')
	const messageIdHeader =
		parsed.messageId ?? getPostalHeader(parsed.headers, 'message-id')
	const inReplyToHeader =
		parsed.inReplyTo ?? getPostalHeader(parsed.headers, 'in-reply-to')
	return {
		envelopeFrom: normalizeAddrSpec(message.from) ?? message.from,
		envelopeTo: normalizeEmailAddress(message.to) ?? message.to,
		headerFrom: fromAddress,
		to: toAddresses,
		cc: ccAddresses,
		bcc: bccAddresses,
		replyTo: replyToAddresses,
		subject,
		messageId: messageIdHeader ?? null,
		inReplyTo: inReplyToHeader ?? null,
		references: normalizeReferences(parsed.references),
		headers: headersToRecord(parsedHeaders),
		// Only Cloudflare-stamped AR/ARC on the Email Worker message headers.
		// Never trust sender-forged Authentication-Results in raw MIME alone.
		authResults: selectTrustedCloudflareAuthResults(message.headers),
		textBody: parsed.text || null,
		htmlBody:
			typeof parsed.html === 'string' && parsed.html ? parsed.html : null,
		rawMime,
		rawSize: message.rawSize,
		attachments: toAttachmentMetadata(parsed.attachments),
	}
}
