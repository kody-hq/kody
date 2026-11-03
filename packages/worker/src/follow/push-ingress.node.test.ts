import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import type { CloudflareArtifactsRepoEvent } from '#worker/repo/artifacts-events.ts'
import type { EntitySourceRow } from '#worker/repo/types.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { recordFollowDefaultBranchPush } from './push-ingress.ts'
import {
	ensureFollowTables,
	getFollowPushPending,
	insertFollow,
	upsertFollowPushPending,
} from './repo.ts'
import type { FollowPushCommit } from './types.ts'

function commit(id: string): FollowPushCommit {
	return {
		id,
		message: id,
		message_truncated: false,
		timestamp: '2026-10-15T00:00:00.000Z',
		author: { name: 'Dev', email: 'dev@example.com' },
		committer: { name: 'Dev', email: 'dev@example.com' },
		parents: [],
	}
}

function pushedEvent(
	at: string,
): Extract<CloudflareArtifactsRepoEvent, { type: 'cf.artifacts.repo.pushed' }> {
	return {
		type: 'cf.artifacts.repo.pushed',
		source: {
			type: 'artifacts',
			namespace: 'ns',
			repoName: 'notes',
		},
		payload: {
			ref: 'refs/heads/main',
			before: 'after-1',
			after: 'after-2',
			commits: [
				{
					id: 'c2',
					message: 'c2',
					messageTruncated: false,
					timestamp: at,
					author: { name: 'Dev', email: 'dev@example.com' },
					committer: { name: 'Dev', email: 'dev@example.com' },
					parents: ['after-1'],
				},
			],
			totalCommitsCount: 1,
			commitsTruncated: false,
		},
		metadata: {
			accountId: 'acct',
			eventSubscriptionId: 'sub',
			eventSchemaVersion: 1,
			eventTimestamp: at,
		},
	}
}

/**
 * The first compare-and-swap sees a concurrent writer bump `revision`
 * after this attempt has already read the row.
 */
function missFirstPendingCas(db: D1Database): D1Database {
	// Contended writes are a conditional UPDATE; fresh windows an INSERT.
	const pendingWrite = /(?:INSERT INTO|UPDATE)\s+follow_push_pending/
	let armed = true
	const originalPrepare = db.prepare.bind(db)
	return new Proxy(db, {
		get(target, prop, receiver) {
			if (prop !== 'prepare') return Reflect.get(target, prop, receiver)
			return (sql: string) => {
				const statement = originalPrepare(sql)
				if (!armed || !pendingWrite.test(sql)) return statement
				const originalBind = statement.bind.bind(statement)
				return new Proxy(statement, {
					get(stmtTarget, stmtProp, stmtReceiver) {
						if (stmtProp !== 'bind') {
							return Reflect.get(stmtTarget, stmtProp, stmtReceiver)
						}
						return (...params: Array<unknown>) => {
							const bound = originalBind(...(params as []))
							const originalRun = bound.run.bind(bound)
							return new Proxy(bound, {
								get(boundTarget, boundProp, boundReceiver) {
									if (boundProp !== 'run') {
										return Reflect.get(boundTarget, boundProp, boundReceiver)
									}
									return async () => {
										if (armed) {
											armed = false
											// Bump revision only: same event time leaves updated_at
											// unchanged, which is the CAS hole this revision fixes.
											await originalPrepare(
												`UPDATE follow_push_pending
												 SET revision = revision + 1,
												 	after_commit = ?, commits_json = ?,
												 	total_commits_count = ?
												 WHERE target_kind = 'package' AND target_id = ?`,
											)
												.bind(
													'after-race',
													JSON.stringify([commit('c-race')]),
													1,
													'pkg-1',
												)
												.run()
										}
										return await originalRun()
									}
								},
							})
						}
					},
				})
			}
		},
	}) as D1Database
}

test('a compare-and-swap miss re-reads and keeps the concurrent commits', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureFollowTables(db)
	await insertFollow(db, {
		id: 'follow-1',
		followerOrgId: 'org-follower',
		creatorUserId: 'person-1',
		targetKind: 'package',
		targetOwnerId: 'org-owner',
		targetId: 'pkg-1',
		targetName: '@ada/notes',
		createdAt: '2026-10-15T00:00:00.000Z',
	})
	await upsertFollowPushPending(
		db,
		{
			targetKind: 'package',
			targetId: 'pkg-1',
			windowStartedAt: '2026-10-15T00:00:00.000Z',
			beforeCommit: 'before-1',
			afterCommit: 'after-1',
			ref: 'refs/heads/main',
			commits: [commit('c1')],
			totalCommitsCount: 1,
			updatedAt: '2026-10-15T00:00:00.000Z',
			revision: 0,
			generation: '',
		},
		null,
	)
	await recordFollowDefaultBranchPush({
		env: { APP_DB: missFirstPendingCas(db) } as Env,
		source: {
			entity_kind: 'package',
			entity_id: 'pkg-1',
		} as EntitySourceRow,
		event: pushedEvent('2026-10-15T00:01:00.000Z'),
		now: new Date('2026-10-15T00:01:00.000Z'),
	})
	const pending = await getFollowPushPending(db, {
		targetKind: 'package',
		targetId: 'pkg-1',
	})
	expect(pending?.beforeCommit).toBe('before-1')
	expect(pending?.afterCommit).toBe('after-2')
	expect(pending?.commits.map((entry) => entry.id)).toEqual(['c-race', 'c2'])
	expect(pending?.totalCommitsCount).toBe(2)
})

test('same event timestamp contention still keeps both pushes', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureFollowTables(db)
	await insertFollow(db, {
		id: 'follow-1',
		followerOrgId: 'org-follower',
		creatorUserId: 'person-1',
		targetKind: 'package',
		targetOwnerId: 'org-owner',
		targetId: 'pkg-1',
		targetName: '@ada/notes',
		createdAt: '2026-10-15T00:00:00.000Z',
	})
	const at = '2026-10-15T00:00:00.000Z'
	await upsertFollowPushPending(
		db,
		{
			targetKind: 'package',
			targetId: 'pkg-1',
			windowStartedAt: at,
			beforeCommit: 'before-1',
			afterCommit: 'after-1',
			ref: 'refs/heads/main',
			commits: [commit('c1')],
			totalCommitsCount: 1,
			updatedAt: at,
			revision: 0,
			generation: '',
		},
		null,
	)
	await recordFollowDefaultBranchPush({
		env: { APP_DB: missFirstPendingCas(db) } as Env,
		source: {
			entity_kind: 'package',
			entity_id: 'pkg-1',
		} as EntitySourceRow,
		// Same timestamp as the seeded window tip: updated_at alone would not CAS.
		event: pushedEvent(at),
		now: new Date('2026-10-15T00:01:00.000Z'),
	})
	const pending = await getFollowPushPending(db, {
		targetKind: 'package',
		targetId: 'pkg-1',
	})
	expect(pending?.updatedAt).toBe(at)
	expect(pending?.commits.map((entry) => entry.id)).toEqual(['c-race', 'c2'])
	expect(pending?.totalCommitsCount).toBe(2)
	expect(pending?.revision).toBeGreaterThan(0)
})
