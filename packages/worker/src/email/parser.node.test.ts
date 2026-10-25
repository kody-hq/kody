import { expect, test } from 'vitest'
import {
	InboundRawMimeTooLargeError,
	maxSurvivableInboundRawBytes,
	parseForwardableEmailMessage,
	readForwardableEmailRawMime,
} from './parser.ts'

function createMessage(
	raw: string,
	to = 'support@example.com',
): ForwardableEmailMessage {
	const headers = new Headers()
	for (const line of raw.split(/\r?\n/)) {
		if (!line) break
		const separator = line.indexOf(':')
		if (separator > 0) {
			headers.append(line.slice(0, separator), line.slice(separator + 1).trim())
		}
	}
	return {
		from: 'sender@example.com',
		to,
		headers,
		raw: new Response(raw).body!,
		rawSize: new TextEncoder().encode(raw).byteLength,
		setReject() {},
		async forward() {
			return { messageId: 'forwarded' }
		},
		async reply() {
			return { messageId: 'reply' }
		},
	} satisfies ForwardableEmailMessage
}

test('direct raw MIME reads reject only unsurvivable messages', async () => {
	const accepted = createMessage('Subject: At ceiling\r\n\r\nBody')
	Object.defineProperty(accepted, 'rawSize', {
		value: maxSurvivableInboundRawBytes,
	})
	await expect(readForwardableEmailRawMime(accepted)).resolves.toContain(
		'At ceiling',
	)

	const message = createMessage('Subject: Too large\r\n\r\nBody')
	Object.defineProperty(message, 'rawSize', {
		value: maxSurvivableInboundRawBytes + 1,
	})
	await expect(readForwardableEmailRawMime(message)).rejects.toBeInstanceOf(
		InboundRawMimeTooLargeError,
	)
	await expect(
		parseForwardableEmailMessage(createMessage('Subject: Oversized\n\nbody'), {
			maxRawSize: 5,
		}),
	).rejects.toBeInstanceOf(InboundRawMimeTooLargeError)
})

test('parseForwardableEmailMessage extracts content and attachments', async () => {
	const raw = [
		'From: Sender <sender@example.com>',
		'To: Support <support@example.com>',
		'Subject: Hello',
		'Message-ID: <message@example.com>',
		'Content-Type: multipart/mixed; boundary="b"',
		'',
		'--b',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'Plain body',
		'--b',
		'Content-Type: text/plain; name="note.txt"',
		'Content-Disposition: attachment; filename="note.txt"',
		'',
		'Attachment body',
		'--b--',
		'',
	].join('\r\n')

	const parsed = await parseForwardableEmailMessage(createMessage(raw))

	expect(parsed).toMatchObject({
		envelopeFrom: 'sender@example.com',
		envelopeTo: 'support@example.com',
		headerFrom: 'sender@example.com',
		subject: 'Hello',
		messageId: '<message@example.com>',
		textBody: expect.stringContaining('Plain body'),
	})
	expect(parsed.to.map((entry) => entry.address)).toContain(
		'support@example.com',
	)
	expect(parsed.attachments).toEqual([
		expect.objectContaining({
			filename: 'note.txt',
			contentType: 'text/plain',
			disposition: 'attachment',
			size: expect.any(Number),
		}),
	])

	const oversizedPdf = 'P'.repeat(20_000)
	const oversized = [
		'From: Sender <sender@example.com>',
		'To: Support <support@example.com>',
		'Subject: Invoice',
		'Message-ID: <oversize@example.com>',
		'Content-Type: multipart/mixed; boundary="b"',
		'',
		'--b',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'Please see the invoice.',
		'--b',
		'Content-Type: application/pdf',
		'Content-Disposition: attachment; filename="invoice.pdf"',
		'',
		oversizedPdf,
		'--b--',
		'',
	].join('\r\n')
	const reduced = await parseForwardableEmailMessage(createMessage(oversized), {
		maxKeptBytes: 4_096,
	})
	expect(reduced.textBody).toContain('Please see the invoice.')
	expect(reduced.rawMime).not.toContain(oversizedPdf)
	expect(reduced.attachments).toEqual([
		expect.objectContaining({
			filename: 'invoice.pdf',
			contentType: 'application/pdf',
			storageKind: 'unavailable',
		}),
	])
})

test('parseForwardableEmailMessage keeps only Cloudflare Authentication-Results', async () => {
	const forgedOnly = [
		'From: Sender <sender@example.com>',
		'To: Support <support@example.com>',
		'Subject: Forged',
		'Authentication-Results: evil.example; spf=pass; dkim=pass; dmarc=pass',
		'Message-ID: <forged@example.com>',
		'',
		'Body',
	].join('\r\n')
	await expect(
		parseForwardableEmailMessage(createMessage(forgedOnly)),
	).resolves.toMatchObject({ authResults: null })

	// Leftmost stamp wins; a later Cloudflare-looking stamp is not trusted.
	const forgedFirst = [
		'From: Sender <sender@example.com>',
		'To: Support <support@example.com>',
		'Subject: Mixed',
		'Authentication-Results: evil.example; dmarc=pass',
		'Authentication-Results: mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail',
		'Message-ID: <mixed@example.com>',
		'',
		'Body',
	].join('\r\n')
	await expect(
		parseForwardableEmailMessage(createMessage(forgedFirst)),
	).resolves.toMatchObject({ authResults: null })

	const cloudflareFirst = [
		'From: Sender <sender@example.com>',
		'To: Support <support@example.com>',
		'Subject: Edge first',
		'Authentication-Results: mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail',
		'Authentication-Results: evil.example; dmarc=pass',
		'Message-ID: <edge@example.com>',
		'',
		'Body',
	].join('\r\n')
	await expect(
		parseForwardableEmailMessage(createMessage(cloudflareFirst)),
	).resolves.toMatchObject({
		authResults: 'mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail',
	})
})
