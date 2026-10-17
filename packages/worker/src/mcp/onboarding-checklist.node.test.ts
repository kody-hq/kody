import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { buildOnboardingSearchNotice } from '#mcp/tools/search-onboarding-notice.ts'
import {
	deriveOnboardingChecklist,
	dismissOnboardingChecklist,
	loadOnboardingAccessWin,
	loadOnboardingAccessWinMemorySubject,
	readOnboardingChecklistDismissed,
} from './onboarding-checklist.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const { env: meterEnv } = createInMemoryUserMeterEnv()
	return {
		env: { APP_DB: createD1FromSqlite(sqlite), ...meterEnv } as Env,
	}
}

const userId = ownerIdFromStored('a'.repeat(64))

async function seedUser(db: D1Database, stableUserId = userId) {
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(
			`user-${stableUserId.slice(0, 8)}`,
			`${stableUserId.slice(0, 8)}@example.test`,
			'test-password-hash',
			new Date().toISOString(),
			stableUserId,
		)
		.run()
}

async function readDismissedAt(db: D1Database, stableUserId = userId) {
	const row = await db
		.prepare(
			`SELECT onboarding_checklist_dismissed_at
			 FROM users
			 WHERE stable_user_id = ?`,
		)
		.bind(stableUserId)
		.first<{ onboarding_checklist_dismissed_at: string | null }>()
	return row?.onboarding_checklist_dismissed_at ?? null
}

function noticeWith(env: Env, oauthProvider?: Record<string, unknown>) {
	return buildOnboardingSearchNotice({
		env: (oauthProvider
			? { ...env, OAUTH_PROVIDER: oauthProvider }
			: env) as Env,
		userId,
		personId: userId,
		baseUrl: 'https://kody.example',
	})
}

test('checklist derives wizard steps from grants and an access win, not integrations', async () => {
	const { env } = createEnv()
	await seedUser(env.APP_DB)

	const fresh = await deriveOnboardingChecklist({
		env,
		userId,
		personId: userId,
		emailVerified: true,
		hasMcpClient: true,
	})
	expect(fresh.complete).toBe(false)
	expect(Object.fromEntries(fresh.items.map((i) => [i.id, i.done]))).toEqual({
		'verify-email': true,
		'connect-agent': true,
		'give-access': false,
		'connect-second-agent': false,
		'install-starter': false,
	})

	const progressed = await deriveOnboardingChecklist({
		env,
		userId,
		personId: userId,
		emailVerified: true,
		hasMcpClient: true,
		hasAccessWin: true,
		hasSecondMcpClient: true,
	})
	const doneById = Object.fromEntries(
		progressed.items.map((i) => [i.id, i.done]),
	)
	expect(doneById['give-access']).toBe(true)
	expect(doneById['connect-second-agent']).toBe(true)
	expect(progressed.complete).toBe(false)

	await env.APP_DB.prepare(
		`UPDATE users SET first_search_at = ? WHERE stable_user_id = ?`,
	)
		.bind(new Date().toISOString(), userId)
		.run()
	expect(await loadOnboardingAccessWin(env, userId, userId)).toBe(true)

	// Two grants alone still ask for a second agent; the notice clears only
	// once grants resolve to two distinct client ecosystems.
	const grantCases = [
		{ label: 'one grant', items: [{ id: 'grant-1', clientId: 'client-a' }] },
		{
			label: 'two grants, same client',
			items: [
				{ id: 'grant-1', clientId: 'client-a' },
				{ id: 'grant-2', clientId: 'client-a' },
			],
		},
		{
			label: 'two unique unlabeled clients',
			items: [
				{ id: 'grant-1', clientId: 'client-a' },
				{ id: 'grant-2', clientId: 'client-b' },
			],
		},
		{
			label: 'dual Cursor contexts',
			items: [
				{
					id: 'grant-local',
					clientId: 'cursor-local-client',
					redirectUri: 'cursor://anysphere.cursor-mcp/oauth/callback',
				},
				{
					id: 'grant-cloud',
					clientId: 'cursor-cloud-client',
					redirectUri: 'https://www.cursor.com/agents/mcp/oauth/callback',
				},
			],
			lookupClient: async (clientId: string) => ({
				clientId,
				clientName: 'Cursor',
			}),
		},
		{
			label: 'two ecosystems',
			items: [
				{
					id: 'grant-cursor',
					clientId: 'cursor-client',
					redirectUri: 'http://localhost:8787/callback',
				},
				{ id: 'grant-claude', clientId: 'claude-client' },
			],
			lookupClient: async (clientId: string) => ({
				clientId,
				clientName: clientId === 'claude-client' ? 'Claude Code' : 'Cursor',
			}),
		},
	]
	const noticeResults = []
	for (const { label, items, lookupClient } of grantCases) {
		const notice = await noticeWith(env, {
			listUserGrants: async () => ({ items }),
			...(lookupClient ? { lookupClient } : {}),
		})
		noticeResults.push({
			label,
			notice:
				notice === null
					? null
					: {
							makeSomethingUseful: notice.includes('Make something useful'),
							connectSecondAgent: notice.includes('Connect a second agent'),
						},
		})
	}
	const asksForSecondAgent = {
		makeSomethingUseful: false,
		connectSecondAgent: true,
	}
	expect(noticeResults).toEqual([
		{ label: 'one grant', notice: asksForSecondAgent },
		{ label: 'two grants, same client', notice: asksForSecondAgent },
		{ label: 'two unique unlabeled clients', notice: asksForSecondAgent },
		{ label: 'dual Cursor contexts', notice: asksForSecondAgent },
		{ label: 'two ecosystems', notice: null },
	])

	expect(
		await readOnboardingChecklistDismissed({ env, personId: userId }),
	).toBe(false)
	await dismissOnboardingChecklist({ env, personId: userId })
	expect(
		await readOnboardingChecklistDismissed({ env, personId: userId }),
	).toBe(true)
	expect(await readDismissedAt(env.APP_DB)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
})

test('search onboarding notice lists remaining steps without writing dismissal and stays quiet when grants are unavailable', async () => {
	const { env } = createEnv()
	await seedUser(env.APP_DB)
	const noGrants = { listUserGrants: async () => ({ items: [] }) }

	const notice = await noticeWith(env, noGrants)
	expect(notice).toContain('3 steps left')
	expect(notice).toContain('/onboarding')
	expect(
		await readOnboardingChecklistDismissed({ env, personId: userId }),
	).toBe(false)
	expect(await readDismissedAt(env.APP_DB)).toBe(null)

	expect(
		await noticeWith(env, {
			listUserGrants: async () => {
				throw new Error('provider unavailable')
			},
		}),
	).toBe(null)
	expect(await noticeWith(env)).toBe(null)

	await dismissOnboardingChecklist({ env, personId: userId })
	expect(await noticeWith(env, noGrants)).toBe(null)
})

test('access-win memory subject is the newest active subject and fails open', async () => {
	const { env } = createEnv()
	await seedUser(env.APP_DB)
	expect(await loadOnboardingAccessWinMemorySubject(env, userId)).toBeNull()

	await env.APP_DB.prepare(
		`INSERT INTO mcp_memories (id, user_id, subject, summary)
		 VALUES (?, ?, ?, ?)`,
	)
		.bind('mem-1', userId, 'Preferred commute', 'Takes the train')
		.run()
	expect(await loadOnboardingAccessWinMemorySubject(env, userId)).toBe(
		'Preferred commute',
	)

	await env.APP_DB.prepare(
		`UPDATE mcp_memories SET status = 'deleted' WHERE id = ?`,
	)
		.bind('mem-1')
		.run()
	expect(await loadOnboardingAccessWinMemorySubject(env, userId)).toBeNull()

	const missingDb = {
		APP_DB: {
			prepare() {
				throw new Error('d1 blip')
			},
		},
	} as unknown as Env
	expect(
		await loadOnboardingAccessWinMemorySubject(missingDb, userId),
	).toBeNull()
})

test('distinct personal orgs read owner resources but person activation and dismissal', async () => {
	const { env } = createEnv()
	const orgId = ownerIdFromStored('b'.repeat(64))
	await seedUser(env.APP_DB)
	await env.APP_DB.prepare(
		'UPDATE users SET personal_org_id = ? WHERE stable_user_id = ?',
	)
		.bind(orgId, userId)
		.run()
	expect(await loadOnboardingAccessWin(env, orgId, userId)).toBe(false)
	await env.APP_DB.prepare(
		'UPDATE users SET first_search_at = ? WHERE stable_user_id = ?',
	)
		.bind(new Date().toISOString(), userId)
		.run()
	expect(await loadOnboardingAccessWin(env, orgId, userId)).toBe(true)
	await env.APP_DB.prepare(
		'UPDATE users SET first_search_at = NULL WHERE stable_user_id = ?',
	)
		.bind(userId)
		.run()
	await env.APP_DB.prepare(
		'INSERT INTO mcp_memories (id,user_id,subject,summary) VALUES (?,?,?,?)',
	)
		.bind('distinct-memory', orgId, 'Org memory', 'Owned by the separate org')
		.run()
	expect(await loadOnboardingAccessWin(env, orgId, userId)).toBe(true)
	expect(await loadOnboardingAccessWin(env, userId, userId)).toBe(false)
	await dismissOnboardingChecklist({ env, personId: userId })
	expect(
		await readOnboardingChecklistDismissed({ env, personId: userId }),
	).toBe(true)
	expect(await readOnboardingChecklistDismissed({ env, personId: orgId })).toBe(
		false,
	)
})
