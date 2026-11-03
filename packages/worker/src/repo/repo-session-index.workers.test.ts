import { env, runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { repoSessionIndexDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { RepoSessionIndex } from './repo-session-index-do.ts'
import type { RepoSessionRow } from './types.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
function sessionRow(
	overrides: Partial<RepoSessionRow> & Pick<RepoSessionRow, 'id' | 'user_id'>,
): RepoSessionRow {
	// Keep `updated_at` and published `expires_at` in the future of "now" so
	// insertSession does not set an immediate due-cleanup alarm. See
	// unusedAbandonedSessionRetentionMs in repo-session-due.ts.
	const now = new Date().toISOString()
	return {
		source_id: 'source-1',
		source_repo_id: 'repo-1',
		session_branch: `sessions/${overrides.id}`,
		source_branch: 'main',
		base_commit: 'commit',
		source_root: '/',
		conversation_id: null,
		status: 'active',
		expires_at: null,
		last_checkpoint_at: null,
		last_checkpoint_commit: null,
		last_check_run_id: null,
		last_check_tree_hash: null,
		created_at: now,
		updated_at: now,
		...overrides,
	}
}

test('RepoSessionIndex is the catalog authority for one user', async () => {
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS repo_session_due_owners (
			user_id TEXT PRIMARY KEY NOT NULL,
			due_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	).run()
	const userId = ownerIdFromStored(`index-${crypto.randomUUID()}`)
	const stub = env.REPO_SESSION_INDEX.get(
		env.REPO_SESSION_INDEX.idFromName(
			repoSessionIndexDurableObjectName(userId),
		),
	)
	await runInDurableObject(stub, async (instance: RepoSessionIndex) => {
		expect(instance).toBeInstanceOf(RepoSessionIndex)
		await instance.insertSession({
			ownerId: userId,
			row: sessionRow({
				id: 'session-1',
				user_id: userId,
				conversation_id: 'convo-1',
			}),
		})
		await instance.insertSession({
			ownerId: userId,
			row: sessionRow({
				id: 'session-2',
				user_id: userId,
				source_id: 'source-2',
				status: 'published',
				expires_at: '2099-01-01T00:00:00.000Z',
			}),
		})
		expect(await instance.countActive({ ownerId: userId })).toBe(1)
		expect(
			await instance.hasActiveForSource({
				ownerId: userId,
				sourceId: 'source-1',
			}),
		).toBe(true)
		expect(
			(
				await instance.getActiveByConversation({
					ownerId: userId,
					conversationId: 'convo-1',
				})
			)?.id,
		).toBe('session-1')
		expect(
			(await instance.listByUser({ ownerId: userId })).map((row) => row.id),
		).toEqual(['session-2', 'session-1'])
		expect(
			await instance.deleteSession({
				ownerId: userId,
				sessionId: 'session-2',
			}),
		).toBe(true)
		expect(await instance.countActive({ ownerId: userId })).toBe(1)
		const exported = await instance.exportSessions({ ownerId: userId })
		expect(exported.rows.map((row) => row.id)).toEqual(['session-1'])
		expect(exported.total).toBe(1)
		expect(await instance.countAll({ ownerId: userId })).toBe(1)
		await instance.purge({ ownerId: userId })
		expect(await instance.listByUser({ ownerId: userId })).toEqual([])
	})
})
