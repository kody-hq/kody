import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	maxRestorableTextColumnBytes,
	utf8ByteLength,
} from '@kody-internal/shared/backup-restore-safety.ts'
import { insertSystemEmailMessage } from './system-email-graph-store.ts'
import { emailBodyTruncationNotice } from './repo.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('dedicated system email bodies remain bounded for backup restore', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const oversized = `<p>${'x'.repeat(maxRestorableTextColumnBytes + 10_000)}</p>`
	const stored = await insertSystemEmailMessage({
		db: env.APP_DB,
		message: {
			processingStatus: 'stored',
			fromAddress: 'sender@example.com',
			textBody: 'short text body',
			htmlBody: oversized,
			rawMimeKey: 'emails/system/raw.mime',
		},
	})

	expect(stored.textBody).toBe('short text body')
	expect(stored.htmlBody?.endsWith(emailBodyTruncationNotice)).toBe(true)
	expect(utf8ByteLength(stored.htmlBody ?? '')).toBeLessThanOrEqual(
		maxRestorableTextColumnBytes,
	)
})
