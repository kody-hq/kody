import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { describeDeadLetterBody } from './metadata.ts'
import {
	claimDeadLetterMessageForReplay,
	parkDeadLetterMessage,
	releaseDeadLetterReplayClaim,
} from './store.ts'

test('replay claims preserve parked, stale, boundary, null and missing-row semantics', async () => {
	using sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		readFileSync(
			new URL(
				'../../migrations/0205-dead-letter-messages.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	const db = createD1FromSqlite(sqlite)
	const key = { deadLetterQueue: 'queue-dlq', messageId: 'message' }
	const claim = (nowMs: number) =>
		claimDeadLetterMessageForReplay(db, { ...key, nowMs, staleClaimMs: 100 })
	expect(await claim(1000)).toBe(false)
	await parkDeadLetterMessage(db, {
		...key,
		sourceQueue: 'queue',
		...describeDeadLetterBody({}),
		attempts: 1,
		enqueuedAtMs: 0,
		parkedAtMs: 0,
	})
	expect(await claim(1000)).toBe(true)
	expect(await claim(1100)).toBe(false)
	expect(await claim(1101)).toBe(true)
	sqlite.prepare(`UPDATE dead_letter_messages SET claimed_at_ms = NULL`).run()
	expect(await claim(9999)).toBe(false)
	await releaseDeadLetterReplayClaim(db, key)
	await releaseDeadLetterReplayClaim(db, key)
	expect(
		sqlite
			.prepare(`SELECT status, claimed_at_ms FROM dead_letter_messages`)
			.get(),
	).toMatchObject({ status: 'parked', claimed_at_ms: null })
	expect(await claim(10000)).toBe(true)
})
