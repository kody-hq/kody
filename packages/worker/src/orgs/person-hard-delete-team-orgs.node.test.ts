vi.unmock('#worker/audit-log.ts')

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createSuccessfulDeletionEnv } from '#worker/test-support/account-deletion.ts'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import type * as RunRecords from '#worker/run-records/service.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

vi.mock('#worker/jobs/manager-client.ts', () => ({
	purgeJobManagerForUser: vi.fn(async () => ({
		ok: true as const,
		userId: ownerIdFromStored('mock'),
		purged: true,
	})),
	syncJobManagerAlarm: vi.fn(async () => ({
		ok: true as const,
		userId: ownerIdFromStored('mock'),
		nextRunAt: null,
	})),
}))
vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		purgeUserJobsData: vi.fn(async () => undefined),
		softDeleteJobsForUser: vi.fn(async () => undefined),
		listJobStorageIdsForUser: vi.fn(async () => [] as Array<string>),
	}),
	jobsService: () => ({
		listJobIdsForUser: async () => [] as Array<string>,
		listJobStorageIdsForUser: async () => [] as Array<string>,
		purgeUser: async (input: { userId: string }) => ({
			ok: true as const,
			userId: input.userId,
			purged: true,
		}),
	}),
}))
vi.mock('#worker/jobs/inspect.ts', () => ({ listJobs: async () => [] }))
vi.mock('#worker/run-records/service.ts', async (importOriginal) => ({
	...(await importOriginal<typeof RunRecords>()),
	runLogRpc: () => ({
		countRunHistory: async () => 0,
		exportRunHistoryPage: async () => ({ runs: [], nextAfterId: null }),
		importRunHistory: async () => ({ imported: 0 }),
	}),
}))
vi.mock('#worker/org-transfer/apply.ts', () => ({
	runOrgResourceTransfer: async () => ({
		outcome: 'applied',
		refusals: [],
		leftovers: {},
	}),
}))
vi.mock('#worker/org-transfer/effects.ts', () => ({
	defaultOrgTransferEffects: () => ({}),
}))
vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserDeletedEvent: vi.fn(),
	scheduleGuestClaimedEvent: vi.fn(),
}))

const { pruneUnverifiedAccounts } =
	await import('#worker/account/unverified-account-purge.ts')
const { pruneExpiredGuestAccounts } =
	await import('#worker/guest/guest-account-purge.ts')
const { GuestClaimError, mergeGuestIntoAccount } =
	await import('#worker/guest/guest-claim.ts')
const { createGuestAccount, guestFullAccessMs, guestHoldMs } =
	await import('#worker/guest/guest-accounts.ts')
const { deleteUserAccount } = await import('#app/account-deletion.ts')
const { PersonHardDeleteWouldOrphanTeamOrgError } =
	await import('./soft-delete.ts')
const { cleanupMemberlessTeamOrgs } = await import('./memberless-team-orgs.ts')

const now = new Date('2026-11-20T12:00:00.000Z')
const old = '2026-11-01T00:00:00.000Z'
const baseUrl = 'https://kody.test'

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	applyAllMigrations(
		sqlite,
		new URL('../../../jobs-worker/migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	const auditSqlite = new DatabaseSync(':memory:')
	for (const file of ['0001-audit-events.sql', '0002-org-audit-events.sql']) {
		auditSqlite.exec(
			readFileSync(
				new URL(`../../audit-migrations/${file}`, import.meta.url),
				'utf8',
			),
		)
	}
	const kvStore = new Map<string, string>()
	const env = {
		...createSuccessfulDeletionEnv(db),
		BUNDLE_ARTIFACTS_KV: {
			get: async (key: string) => kvStore.get(key) ?? null,
			put: async (key: string, value: string) => void kvStore.set(key, value),
			delete: async (key: string) => void kvStore.delete(key),
			list: async () => ({
				keys: [...kvStore.keys()].map((name) => ({ name })),
				list_complete: true as const,
				cursor: undefined,
			}),
		},
		AUDIT_DB: createD1FromSqlite(auditSqlite),
		SECRET_STORE_KEY: 'guest-test-secret-store-key-32-characters-ok',
	} as unknown as Env
	let orgCount = 0

	/** A person with a personal org. Unverified unless `verified` is set. */
	function person(username: string, input: { verified?: boolean } = {}) {
		const email = `${username}@example.com`
		const stableUserId = testStableUserIdFromEmail(email)
		const inserted = sqlite
			.prepare(
				`INSERT INTO users (
					username, email, password_hash, stable_user_id, personal_org_id,
					email_verified_at, created_at
				) VALUES (?, ?, 'hash', ?, ?, ?, ?)`,
			)
			.run(
				username,
				email,
				stableUserId,
				stableUserId,
				input.verified ? old : null,
				old,
			)
		org(stableUserId, username, stableUserId)
		member(stableUserId, stableUserId, 'owner')
		return {
			id: Number(inserted.lastInsertRowid),
			stableUserId,
			email,
			username,
		}
	}

	function org(id: string, slug: string, createdBy: string) {
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, created_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(id, slug, createdBy, old, old)
		sqlite
			.prepare(
				`INSERT INTO handles (handle, org_id, created_at) VALUES (?, ?, ?)`,
			)
			.run(slug, id, old)
	}

	function member(orgId: string, userId: string, role: 'owner' | 'member') {
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(orgId, userId, role, old)
	}

	/** A team org with one package, owned by `ownerId`. */
	function teamOrg(
		ownerId: string,
		others: Array<[string, 'owner' | 'member']> = [],
	) {
		orgCount += 1
		const id = `team-org-${orgCount}`
		org(id, `team-${orgCount}`, ownerId)
		member(id, ownerId, 'owner')
		for (const [userId, role] of others) member(id, userId, role)
		sqlite
			.prepare(
				`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
				 VALUES (?, ?, ?, ?, 'desc', ?)`,
			)
			.run(`pkg-${id}`, id, `@team-${orgCount}/tool`, 'tool', `src-${id}`)
		return id
	}

	function count(sql: string, ...params: Array<string>) {
		return Number((sqlite.prepare(sql).get(...params) as { n: number }).n)
	}

	return {
		sqlite,
		db,
		env,
		person,
		teamOrg,
		async guest() {
			const created = await createGuestAccount({
				env,
				requestIp: '203.0.113.7',
				clientName: 'Test Agent',
				now: new Date(old),
			})
			if (!created.ok) throw new Error('guest was not created')
			return created
		},
		guestPurgeTime: new Date(
			new Date(old).getTime() + guestFullAccessMs + guestHoldMs,
		),
		/** Live or tombstoned: any row at all for this org. */
		orgState(orgId: string) {
			return {
				orgRows: count(`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`, orgId),
				packages: count(
					`SELECT COUNT(*) AS n FROM saved_packages WHERE user_id = ?`,
					orgId,
				),
				liveMembers: count(
					`SELECT COUNT(*) AS n FROM org_memberships
					 WHERE org_id = ? AND deleted_at IS NULL`,
					orgId,
				),
				handles: count(
					`SELECT COUNT(*) AS n FROM handles WHERE org_id = ?`,
					orgId,
				),
			}
		},
		personExists(stableUserId: string) {
			return (
				count(
					`SELECT COUNT(*) AS n FROM users WHERE stable_user_id = ?`,
					stableUserId,
				) === 1
			)
		},
		membershipCount(userId: string) {
			return count(
				`SELECT COUNT(*) AS n FROM org_memberships WHERE user_id = ?`,
				userId,
			)
		},
		auditReasons(action: string) {
			return (
				auditSqlite
					.prepare(`SELECT reason FROM audit_events WHERE action = ?`)
					.all(action) as Array<{ reason: string | null }>
			).map((row) => row.reason)
		},
		memberlessLiveTeamOrgs() {
			return count(
				`SELECT COUNT(*) AS n FROM orgs o
				 WHERE o.deleted_at IS NULL
				   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.personal_org_id = o.id)
				   AND NOT EXISTS (
				     SELECT 1 FROM org_memberships m
				     WHERE m.org_id = o.id AND m.deleted_at IS NULL
				   )`,
			)
		},
	}
}

const gone = { orgRows: 0, packages: 0, liveMembers: 0, handles: 0 }

type Harness = ReturnType<typeof createHarness>

/**
 * Each hard-delete path, as "delete this person". `seed` returns the person
 * the path deletes; `run` reports whether that person was deleted.
 */
const paths: Array<{
	name: string
	seed: (h: Harness) => Promise<{ stableUserId: string }>
	run: (h: Harness, person: { stableUserId: string }) => Promise<void>
	skippedAudit: string
}> = [
	{
		name: 'unverified-account purge',
		seed: async (h) => h.person('stale'),
		run: async (h) => {
			await pruneUnverifiedAccounts({ env: h.env, now })
		},
		skippedAudit: 'unverified_account_purge_skipped',
	},
	{
		name: 'guest purge',
		seed: async (h) => ({ stableUserId: (await h.guest()).personId }),
		run: async (h) => {
			await pruneExpiredGuestAccounts({ env: h.env, now: h.guestPurgeTime })
		},
		skippedAudit: 'guest_account_purge_skipped',
	},
	{
		name: 'guest purge retry of a fenced deletion',
		seed: async (h) => {
			const guest = await h.guest()
			h.sqlite
				.prepare(`UPDATE users SET deleting_at = ? WHERE stable_user_id = ?`)
				.run(old, guest.personId)
			return { stableUserId: guest.personId }
		},
		run: async (h) => {
			await pruneExpiredGuestAccounts({ env: h.env, now: h.guestPurgeTime })
		},
		skippedAudit: 'guest_account_purge_skipped',
	},
	{
		name: 'guest claim into an existing account',
		seed: async (h) => ({ stableUserId: (await h.guest()).personId }),
		run: async (h, person) => {
			const { readGuestAccountByPerson } =
				await import('#worker/guest/guest-accounts.ts')
			const guest = await readGuestAccountByPerson(h.db, person.stableUserId)
			if (!guest) throw new Error('guest row missing')
			const target = h.person('claimer', { verified: true })
			// No email binding here; the merge notice is best-effort.
			consoleWarn.mockImplementation(() => {})
			await mergeGuestIntoAccount({
				env: h.env,
				guest,
				target: {
					dbUserId: target.id,
					personId: target.stableUserId,
					personalOrgId: target.stableUserId,
					username: target.username,
					email: target.email,
				},
				baseUrl,
			}).catch((error: unknown) => {
				if (!(error instanceof GuestClaimError)) throw error
			})
		},
		skippedAudit: 'guest_account_claim_blocked',
	},
]

for (const path of paths) {
	test(`${path.name}: a sole-member team org and its packages are purged with the person`, async () => {
		const h = createHarness()
		const person = await path.seed(h)
		const orgId = h.teamOrg(person.stableUserId)

		await path.run(h, person)

		expect(h.personExists(person.stableUserId)).toBe(false)
		expect(h.orgState(orgId)).toEqual(gone)
		expect(h.orgState(person.stableUserId)).toEqual(gone)
		expect(h.memberlessLiveTeamOrgs()).toBe(0)
	})

	test(`${path.name}: the only Owner of a team org with other members is not deleted`, async () => {
		// The guest lane reports a guest it could not delete as a failure.
		consoleError.mockImplementation(() => {})
		const h = createHarness()
		const person = await path.seed(h)
		const teammate = h.person('teammate', { verified: true })
		const orgId = h.teamOrg(person.stableUserId, [
			[teammate.stableUserId, 'member'],
		])

		await path.run(h, person)

		expect(h.personExists(person.stableUserId)).toBe(true)
		expect(h.orgState(orgId)).toEqual({
			orgRows: 1,
			packages: 1,
			liveMembers: 2,
			handles: 1,
		})
		expect(h.auditReasons(path.skippedAudit)).toEqual([
			expect.stringContaining('sole_owner_with_other_members'),
		])
	})

	test(`${path.name}: a shared team org with another Owner stays and only the membership goes`, async () => {
		const h = createHarness()
		const person = await path.seed(h)
		const coOwner = h.person('co-owner', { verified: true })
		const orgId = h.teamOrg(coOwner.stableUserId, [
			[person.stableUserId, 'owner'],
		])

		await path.run(h, person)

		expect(h.personExists(person.stableUserId)).toBe(false)
		expect(h.membershipCount(person.stableUserId)).toBe(0)
		expect(h.orgState(orgId)).toEqual({
			orgRows: 1,
			packages: 1,
			liveMembers: 1,
			handles: 1,
		})
	})
}

test('deleteUserAccount refuses a person whose sole-member team org was not settled first', async () => {
	const h = createHarness()
	const person = h.person('direct')
	const orgId = h.teamOrg(person.stableUserId)

	await expect(
		deleteUserAccount({
			env: h.env,
			dbUserId: person.id,
			mcpUserId: ownerIdFromStored(person.stableUserId),
			personUserId: person.stableUserId,
		}),
	).rejects.toBeInstanceOf(PersonHardDeleteWouldOrphanTeamOrgError)
	expect(h.personExists(person.stableUserId)).toBe(true)
	expect(h.orgState(orgId).liveMembers).toBe(1)
})

test('memberless team org cleanup lists by default and purges only when asked', async () => {
	const h = createHarness()
	const owner = h.person('owner', { verified: true })
	const kept = h.teamOrg(owner.stableUserId)
	const orphan = h.teamOrg('deleted-user')
	h.sqlite.prepare(`DELETE FROM org_memberships WHERE org_id = ?`).run(orphan)
	// Creator-less platform org with no members: never matched.
	h.sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, created_by_user_id, created_at, updated_at)
			 VALUES ('platform-org', 'platform', NULL, ?, ?)`,
		)
		.run(old, old)
	// A soft-deleted person's personal org keeps purging with the person.
	const leaving = h.person('leaving', { verified: true })
	h.sqlite
		.prepare(`UPDATE users SET deleted_at = ? WHERE stable_user_id = ?`)
		.run(old, leaving.stableUserId)
	h.sqlite
		.prepare(`UPDATE org_memberships SET deleted_at = ? WHERE user_id = ?`)
		.run(old, leaving.stableUserId)

	const listed = {
		orgId: orphan,
		slug: 'team-2',
		createdAt: old,
		creatorDeleted: true,
		packageCount: 1,
	}
	expect(await cleanupMemberlessTeamOrgs({ env: h.env })).toEqual({
		dryRun: true,
		total: 1,
		orgs: [listed],
		purgedOrgIds: [],
		failures: [],
	})
	expect(h.orgState(orphan).orgRows).toBe(1)

	expect(
		await cleanupMemberlessTeamOrgs({
			env: h.env,
			dryRun: false,
			actorUserId: owner.stableUserId,
		}),
	).toEqual({
		dryRun: false,
		total: 1,
		orgs: [listed],
		purgedOrgIds: [orphan],
		failures: [],
	})
	expect(h.orgState(orphan)).toEqual(gone)
	expect(h.orgState(kept).orgRows).toBe(1)
	expect(h.orgState('platform-org').orgRows).toBe(1)
	expect(h.orgState(leaving.stableUserId).orgRows).toBe(1)
	expect((await cleanupMemberlessTeamOrgs({ env: h.env })).total).toBe(0)
})
