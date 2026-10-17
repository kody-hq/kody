import { evaluateSecondAgentStandardGift } from './second-agent-standard-gift.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { loadOnboardingData } from '#app/onboarding-data.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	reconcileSecondAgentStandardGifts,
	secondAgentGiftCursorKey,
} from './second-agent-gift-reconciliation.ts'

function fixture() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`CREATE TABLE users (stable_user_id TEXT, personal_org_id TEXT, deleted_at TEXT, deleting_at TEXT);
	CREATE TABLE orgs (id TEXT, plan TEXT DEFAULT 'free', stripe_plan TEXT,
	 second_agent_standard_gift_granted_at TEXT, second_agent_standard_gift_expires_at TEXT,
	 updated_at TEXT, deleted_at TEXT, deleting_at TEXT);`)
	const db = createD1FromSqlite(sqlite)
	const cursor = new Map<string, string>()
	const failures = new Set<string>()
	const helpers = {
		listUserGrants: vi.fn(async (userId: string) => {
			if (failures.has(userId)) throw new Error('temporary listing failure')
			return {
				items: [
					{
						id: 'cursor',
						clientId: 'cursor',
						scope: ['profile'],
						createdAt: 1,
					},
					{
						id: 'chatgpt',
						clientId: 'chatgpt',
						scope: ['profile'],
						createdAt: 2,
					},
				],
			}
		}),
		lookupClient: vi.fn(async (clientId: string) => ({
			clientId,
			clientName: clientId === 'cursor' ? 'Cursor' : 'ChatGPT',
		})),
	}
	const env = {
		APP_DB: db,
		OAUTH_PROVIDER: helpers,
		OAUTH_KV: {
			get: vi.fn(async (key: string) => cursor.get(key) ?? null),
			put: vi.fn(async (key: string, value: string) => {
				cursor.set(key, value)
			}),
		},
	} as unknown as Env
	function add(id: string) {
		sqlite
			.prepare(
				'INSERT INTO users (stable_user_id, personal_org_id) VALUES (?, ?)',
			)
			.run(id, `org-${id}`)
		sqlite.prepare('INSERT INTO orgs (id) VALUES (?)').run(`org-${id}`)
	}
	function gift(id: string) {
		return sqlite
			.prepare(
				'SELECT second_agent_standard_gift_granted_at AS granted, second_agent_standard_gift_expires_at AS expires FROM orgs WHERE id = ?',
			)
			.get(`org-${id}`)
	}
	return { sqlite, db, env, helpers, cursor, failures, add, gift }
}

const now = new Date('2026-10-15T12:00:00Z')

test('bounded sweep continues beyond a failed person, wraps, and repairs missed grants without extending gifts', async () => {
	const f = fixture()
	for (let i = 0; i < 10; i++) f.add(`person-${i}`)
	f.failures.add('person-0')
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
	try {
		expect(
			await reconcileSecondAgentStandardGifts({ env: f.env, now }),
		).toEqual({ scanned: 8, granted: 7, failed: 1 })
		expect(f.cursor.get(secondAgentGiftCursorKey)).toBe('person-7')
		expect(f.gift('person-0')?.granted).toBeNull()
		const original = f.gift('person-1')
		expect(
			await reconcileSecondAgentStandardGifts({ env: f.env, now }),
		).toEqual({ scanned: 2, granted: 2, failed: 0 })
		expect(f.cursor.get(secondAgentGiftCursorKey)).toBe('')
		f.failures.clear()
		const later = new Date(now.getTime() + 86_400_000)
		expect(
			await reconcileSecondAgentStandardGifts({ env: f.env, now: later }),
		).toEqual({ scanned: 1, granted: 1, failed: 0 })
		expect(f.gift('person-0')?.granted).toBe(later.toISOString())
		// A stale KV cursor/replayed tick cannot extend a gift already in D1.
		f.cursor.set(secondAgentGiftCursorKey, '')
		expect(
			await reconcileSecondAgentStandardGifts({ env: f.env, now: later }),
		).toEqual({ scanned: 0, granted: 0, failed: 0 })
		expect(f.gift('person-1')).toEqual(original)
	} finally {
		warning.mockRestore()
		f.sqlite.close()
	}
})

test('website onboarding reads eligible people without granting, and the sweep excludes deleted people and orgs', async () => {
	const f = fixture()
	try {
		for (const id of ['eligible', 'deleted-person', 'deleted-org']) f.add(id)
		f.sqlite
			.prepare('UPDATE users SET deleted_at = ? WHERE stable_user_id = ?')
			.run(now.toISOString(), 'deleted-person')
		f.sqlite
			.prepare('UPDATE orgs SET deleted_at = ? WHERE id = ?')
			.run(now.toISOString(), 'org-deleted-org')
		const data = await loadOnboardingData({
			env: { APP_DB: f.db, OAUTH_PROVIDER: f.helpers },
			personId: ownerIdFromStored('eligible'),
			username: 'eligible',
			emailVerified: true,
			requestUrl: 'https://kody.example/onboarding',
		})
		expect(data.hasSecondMcpClient).toBe(true)
		expect(data.secondAgentStandardGift.received).toBe(false)
		expect(f.gift('eligible')?.granted).toBeNull()
		expect(
			await reconcileSecondAgentStandardGifts({ env: f.env, now }),
		).toEqual({ scanned: 1, granted: 1, failed: 0 })
		expect(f.gift('eligible')?.granted).toBe(now.toISOString())
		expect(f.gift('deleted-person')?.granted).toBeNull()
		expect(f.gift('deleted-org')?.granted).toBeNull()
	} finally {
		f.sqlite.close()
	}
})

test('deletion starting during grant listing prevents the gift write', async () => {
	const f = fixture()
	try {
		f.add('deleting-person')
		f.add('deleting-org')
		const list = f.helpers.listUserGrants.getMockImplementation()!
		f.helpers.listUserGrants.mockImplementation(async (personId: string) => {
			if (personId === 'deleting-person') {
				f.sqlite
					.prepare('UPDATE users SET deleting_at = ? WHERE stable_user_id = ?')
					.run(now.toISOString(), personId)
			} else {
				f.sqlite
					.prepare('UPDATE orgs SET deleting_at = ? WHERE id = ?')
					.run(now.toISOString(), `org-${personId}`)
			}
			return list(personId)
		})
		expect(
			await reconcileSecondAgentStandardGifts({ env: f.env, now }),
		).toEqual({ scanned: 2, granted: 0, failed: 0 })
		expect(f.gift('deleting-person')?.granted).toBeNull()
		expect(f.gift('deleting-org')?.granted).toBeNull()
	} finally {
		f.sqlite.close()
	}
})

test('personal org remapping between evaluation and write cannot grant the old org', async () => {
	const f = fixture()
	try {
		f.add('remapped')
		f.sqlite.prepare('INSERT INTO orgs (id) VALUES (?)').run('new-org')
		const prepare = f.db.prepare.bind(f.db)
		vi.spyOn(f.db, 'prepare').mockImplementation((sql: string) => {
			if (sql.startsWith('UPDATE orgs SET second_agent_standard_gift')) {
				f.sqlite
					.prepare(
						'UPDATE users SET personal_org_id = ? WHERE stable_user_id = ?',
					)
					.run('new-org', 'remapped')
			}
			return prepare(sql)
		})
		expect(
			await evaluateSecondAgentStandardGift({
				db: f.db,
				stableUserId: 'remapped',
				ecosystemCount: 2,
				now,
			}),
		).toEqual({ outcome: 'no_user' })
		expect(f.gift('remapped')?.granted).toBeNull()
		expect(
			f.sqlite
				.prepare(
					'SELECT second_agent_standard_gift_granted_at AS granted FROM orgs WHERE id = ?',
				)
				.get('new-org')?.granted,
		).toBeNull()
	} finally {
		f.sqlite.close()
	}
})
