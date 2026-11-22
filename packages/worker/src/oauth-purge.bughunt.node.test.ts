import { expect, test } from 'vitest'
import {
	OAuthPurgeCoordinator,
	oauthPurgeContinuationStorageKey,
} from './oauth-purge.ts'
import { createMemoryKvNamespace } from './test-support/memory-kv.ts'

test('bughunt: one grant with a malformed JSON value wedges the OAuth purge forever', async () => {
	const { kv, store } = createMemoryKvNamespace({
		// One corrupt record: kv.get(key, { type: 'json' }) throws SyntaxError.
		'grant:user:a': '{not json',
		// An expired grant that should be purged, with its token.
		'grant:user:b': JSON.stringify({ clientId: 'client', expiresAt: 1 }),
		'client:client': JSON.stringify({ clientId: 'client' }),
		'token:user:b:t1': JSON.stringify({ userId: 'user', grantId: 'b' }),
	})
	const stored = new Map<string, unknown>()
	const storage = {
		async get(key: string) {
			return structuredClone(stored.get(key))
		},
		async put(key: string, value: unknown) {
			stored.set(key, structuredClone(value))
		},
	}
	const coordinator = new OAuthPurgeCoordinator(
		{ storage } as unknown as DurableObjectState,
		{ OAUTH_KV: kv } as unknown as Env,
	)
	const scheduledAt = Date.parse('2026-11-20T18:05:00.000Z')
	const outcomes: Array<string> = []
	for (let run = 0; run < 6; run++) {
		try {
			const result = await coordinator.run({ scheduledAt })
			outcomes.push(`ok:${result.phase}`)
		} catch (error) {
			outcomes.push(`error:${(error as Error).name}`)
		}
	}
	// Expected: the bad record is skipped (or counted) and the expired grant
	// and its token are purged within a few runs, alternating phases.
	expect({
		outcomes,
		continuationSaved: stored.has(oauthPurgeContinuationStorageKey),
		expiredGrantStillPresent: store.has('grant:user:b'),
		tokenStillPresent: store.has('token:user:b:t1'),
	}).toEqual({
		outcomes: expect.arrayContaining(['ok:tokens']),
		continuationSaved: true,
		expiredGrantStillPresent: false,
		tokenStillPresent: false,
	})
})
