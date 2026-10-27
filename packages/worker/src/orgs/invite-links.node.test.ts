import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { withAccessEpochWriteGuard } from '#worker/test-support/access-epoch-write-guard.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

const mocks = vi.hoisted(() => ({
	syncSeatsAfterMembershipChange: vi.fn(),
}))

vi.mock('#worker/orgs/seat-sync-after-membership.ts', () => ({
	syncSeatsAfterMembershipChange: (...args: Array<unknown>) =>
		mocks.syncSeatsAfterMembershipChange(...args),
}))

const {
	createOrgInviteLink,
	generateInviteLinkToken,
	getInviteLinkByTokenHash,
	hashInviteLinkToken,
	listActiveOrgInviteLinks,
	revokeOrgInviteLink,
} = await import('./invite-links.ts')
const { inviteLinkAlreadySatisfied, redeemOrgInviteLink } =
	await import('./invite-link-redeem.ts')

const owner = { id: 1, personId: 'a'.repeat(64) }
const joiner = { id: 2, personId: 'b'.repeat(64) }

let sqlite: DatabaseSync
let db: D1Database
/** Unguarded facade for personal-org provisioning (new org rows). */
let rawDb: D1Database
let auditDb: D1Database
let orgId = ''

async function seed() {
	sqlite = new DatabaseSync(':memory:')
	rawDb = createD1FromSqlite(sqlite)
	db = rawDb
	auditDb = createAuditTestDb()
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({
		db,
		columns: ['email_verified_at', 'avatar_key'],
	})
	const now = '2026-01-01T00:00:00.000Z'
	for (const [username, person, email] of [
		['ada', owner, 'ada@example.com'],
		['bob', joiner, 'bob@partner.org'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO users (
					id, username, email, password_hash, stable_user_id,
					display_name, email_verified_at
				 ) VALUES (?, ?, ?, 'x', ?, ?, ?)`,
			)
			.run(person.id, username, email, person.personId, username, now)
		await provisionPersonalOrg(db, {
			stableUserId: person.personId,
			username,
			createdAt: now,
		})
	}
	// Personal orgs are provisioned statement by statement (new org rows); from
	// here on every access-table write must bump access_epoch in its batch.
	db = withAccessEpochWriteGuard(db)
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: owner.personId,
			audit: createTestOrgAuditWriter({ db: auditDb }),
			slug: 'agency-co',
			displayName: 'Agency Co',
		},
	)
	if (!created.ok) throw new Error(created.error)
	orgId = (await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'agency-co'`)
		.first<{ id: string }>())!.id
}

async function createLink(
	options: {
		role?: 'member' | 'billing'
		domains?: Array<string>
		maxUses?: number | null
		expiresAt?: string
	} = {},
) {
	const token = generateInviteLinkToken()
	const tokenHash = await hashInviteLinkToken(token)
	const created = await createOrgInviteLink({
		db,
		orgId,
		target: { kind: 'membership', role: options.role ?? 'member' },
		createdByUserId: owner.personId,
		tokenHash,
		allowedEmailDomains: options.domains,
		maxUses: options.maxUses,
		expiresAt: options.expiresAt,
		audit: createTestOrgAuditWriter({
			db: auditDb,
			actorUserId: owner.personId,
		}),
	})
	return { token, tokenHash, ...created }
}

beforeEach(async () => {
	mocks.syncSeatsAfterMembershipChange.mockClear()
	await seed()
})

test('create stores only the token hash and lists the active link', async () => {
	const { token, tokenHash, id } = await createLink()
	const stored = await getInviteLinkByTokenHash(db, tokenHash)
	expect(stored).toMatchObject({
		id,
		orgId,
		tokenHash,
		target: { kind: 'membership', role: 'member' },
		status: 'active',
		maxUses: null,
		useCount: 0,
	})
	expect(JSON.stringify(stored)).not.toContain(token)
	const listed = await listActiveOrgInviteLinks(db, orgId)
	expect(listed).toHaveLength(1)
	expect(listed[0]).toMatchObject({
		id,
		target: { kind: 'membership', role: 'member' },
		useCount: 0,
		createdByUsername: 'ada',
	})
})

test('personal orgs cannot create invite links', async () => {
	await expect(
		createOrgInviteLink({
			db,
			orgId: owner.personId,
			target: { kind: 'membership', role: 'member' },
			createdByUserId: owner.personId,
			tokenHash: await hashInviteLinkToken('personal-token'),
			audit: createTestOrgAuditWriter({ db: auditDb }),
		}),
	).rejects.toThrow(/personal organization/)
})

test('join adds the member, syncs seats, and audits the link', async () => {
	const { tokenHash } = await createLink()
	const link = (await getInviteLinkByTokenHash(db, tokenHash))!
	const result = await redeemOrgInviteLink({
		db,
		env: { APP_DB: db } as Env,
		link,
		user: {
			userId: joiner.personId,
			email: 'bob@partner.org',
			emailVerified: true,
		},
		audit: createTestOrgAuditWriter({
			db: auditDb,
			appDb: db,
			actorUserId: joiner.personId,
		}),
	})
	expect(result).toEqual({
		ok: true,
		alreadyMember: false,
		role: 'member',
		target: { kind: 'membership', role: 'member' },
		orgId,
	})
	expect(mocks.syncSeatsAfterMembershipChange).toHaveBeenCalledWith(
		expect.objectContaining({ orgId }),
	)
	const membership = await db
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(orgId, joiner.personId)
		.first<{ role: string }>()
	expect(membership?.role).toBe('member')
	const refreshed = await getInviteLinkByTokenHash(db, tokenHash)
	expect(refreshed?.useCount).toBe(1)
	const events = await auditDb
		.prepare(
			`SELECT action FROM org_audit_events
			 WHERE org_id = ? AND action IN ('member.added', 'invite_link.joined')
			 ORDER BY action ASC`,
		)
		.bind(orgId)
		.all<{ action: string }>()
	expect(events.results?.map((row) => row.action)).toEqual([
		'invite_link.joined',
		'member.added',
	])
	const joined = await auditDb
		.prepare(
			`SELECT details_json FROM org_audit_events
			 WHERE org_id = ? AND action = 'invite_link.joined'`,
		)
		.bind(orgId)
		.first<{ details_json: string }>()
	expect(JSON.parse(joined?.details_json ?? '{}')).toMatchObject({
		role: 'member',
		linkId: link.id,
	})
})

test('domain limits require a matching verified email', async () => {
	const { tokenHash } = await createLink({ domains: ['agency.com'] })
	const link = (await getInviteLinkByTokenHash(db, tokenHash))!

	expect(
		await redeemOrgInviteLink({
			db,
			env: { APP_DB: db } as Env,
			link,
			user: {
				userId: joiner.personId,
				email: 'bob@partner.org',
				emailVerified: true,
			},
			audit: createTestOrgAuditWriter({ db: auditDb }),
		}),
	).toMatchObject({ ok: false, reason: 'domain' })

	expect(
		await redeemOrgInviteLink({
			db,
			env: { APP_DB: db } as Env,
			link,
			user: {
				userId: joiner.personId,
				email: 'bob@agency.com',
				emailVerified: false,
			},
			audit: createTestOrgAuditWriter({ db: auditDb }),
		}),
	).toMatchObject({ ok: false, reason: 'unverified_email' })

	expect(
		await redeemOrgInviteLink({
			db,
			env: { APP_DB: db } as Env,
			link,
			user: {
				userId: joiner.personId,
				email: 'bob@agency.com',
				emailVerified: true,
			},
			audit: createTestOrgAuditWriter({ db: auditDb }),
		}),
	).toMatchObject({ ok: true })
})

test('max uses blocks further joins after the limit', async () => {
	const { tokenHash } = await createLink({ maxUses: 1 })
	const link = (await getInviteLinkByTokenHash(db, tokenHash))!
	expect(
		await redeemOrgInviteLink({
			db,
			env: { APP_DB: db } as Env,
			link,
			user: {
				userId: joiner.personId,
				email: 'bob@partner.org',
				emailVerified: true,
			},
			audit: createTestOrgAuditWriter({ db: auditDb }),
		}),
	).toMatchObject({ ok: true })

	const third = { id: 3, personId: 'c'.repeat(64) }
	sqlite
		.prepare(
			`INSERT INTO users (
				id, username, email, password_hash, stable_user_id, email_verified_at
			 ) VALUES (?, 'cara', 'cara@partner.org', 'x', ?, ?)`,
		)
		.run(third.id, third.personId, '2026-01-01T00:00:00.000Z')
	await provisionPersonalOrg(rawDb, {
		stableUserId: third.personId,
		username: 'cara',
		createdAt: '2026-01-01T00:00:00.000Z',
	})
	const refreshed = (await getInviteLinkByTokenHash(db, tokenHash))!
	expect(
		await redeemOrgInviteLink({
			db,
			env: { APP_DB: db } as Env,
			link: refreshed,
			user: {
				userId: third.personId,
				email: 'cara@partner.org',
				emailVerified: true,
			},
			audit: createTestOrgAuditWriter({ db: auditDb }),
		}),
	).toMatchObject({ ok: false, reason: 'exhausted' })
	expect(await listActiveOrgInviteLinks(db, orgId)).toHaveLength(0)
})

test('expired and revoked links cannot be redeemed', async () => {
	await expect(
		createOrgInviteLink({
			db,
			orgId,
			target: { kind: 'membership', role: 'member' },
			createdByUserId: owner.personId,
			tokenHash: await hashInviteLinkToken('past-expiry'),
			expiresAt: '2020-01-01T00:00:00.000Z',
			audit: createTestOrgAuditWriter({ db: auditDb }),
		}),
	).rejects.toThrow(/Expiry must be in the future/)

	const expired = await createLink()
	sqlite
		.prepare(`UPDATE org_invite_links SET expires_at = ? WHERE id = ?`)
		.run('2020-01-01T00:00:00.000Z', expired.id)
	const expiredLink = (await getInviteLinkByTokenHash(db, expired.tokenHash))!
	expect(
		await redeemOrgInviteLink({
			db,
			env: { APP_DB: db } as Env,
			link: expiredLink,
			user: {
				userId: joiner.personId,
				email: 'bob@partner.org',
				emailVerified: true,
			},
			audit: createTestOrgAuditWriter({ db: auditDb }),
		}),
	).toMatchObject({ ok: false, reason: 'expired' })

	const live = await createLink()
	await revokeOrgInviteLink({
		db,
		orgId,
		linkId: live.id,
		audit: createTestOrgAuditWriter({ db: auditDb }),
	})
	const revoked = (await getInviteLinkByTokenHash(db, live.tokenHash))!
	expect(revoked.status).toBe('revoked')
	expect(
		await redeemOrgInviteLink({
			db,
			env: { APP_DB: db } as Env,
			link: revoked,
			user: {
				userId: joiner.personId,
				email: 'bob@partner.org',
				emailVerified: true,
			},
			audit: createTestOrgAuditWriter({ db: auditDb }),
		}),
	).toMatchObject({ ok: false, reason: 'revoked' })
})

test('label and last used show on list after a join', async () => {
	const token = generateInviteLinkToken()
	const tokenHash = await hashInviteLinkToken(token)
	const created = await createOrgInviteLink({
		db,
		orgId,
		target: { kind: 'membership', role: 'member' },
		createdByUserId: owner.personId,
		tokenHash,
		label: 'Engineering onboarding',
		audit: createTestOrgAuditWriter({
			db: auditDb,
			actorUserId: owner.personId,
		}),
	})
	expect(created.label).toBe('Engineering onboarding')
	const before = await listActiveOrgInviteLinks(db, orgId)
	expect(before[0]).toMatchObject({
		id: created.id,
		label: 'Engineering onboarding',
		lastUsedAt: null,
		useCount: 0,
	})
	const link = (await getInviteLinkByTokenHash(db, tokenHash))!
	expect(
		await redeemOrgInviteLink({
			db,
			env: { APP_DB: db } as Env,
			link,
			user: {
				userId: joiner.personId,
				email: 'bob@partner.org',
				emailVerified: true,
			},
			audit: createTestOrgAuditWriter({
				db: auditDb,
				appDb: db,
				actorUserId: joiner.personId,
			}),
		}),
	).toMatchObject({ ok: true, alreadyMember: false })
	const after = await listActiveOrgInviteLinks(db, orgId)
	expect(after[0]).toMatchObject({
		id: created.id,
		label: 'Engineering onboarding',
		useCount: 1,
	})
	expect(after[0]?.lastUsedAt).toEqual(expect.any(String))
})

test('existing members rejoin without burning uses, and removed members can rejoin', async () => {
	const { tokenHash } = await createLink({ maxUses: 2 })
	const link = (await getInviteLinkByTokenHash(db, tokenHash))!
	const audit = () =>
		createTestOrgAuditWriter({
			db: auditDb,
			appDb: db,
			actorUserId: joiner.personId,
		})
	expect(
		await redeemOrgInviteLink({
			db,
			env: { APP_DB: db } as Env,
			link,
			user: {
				userId: joiner.personId,
				email: 'bob@partner.org',
				emailVerified: true,
			},
			audit: audit(),
		}),
	).toMatchObject({ ok: true, alreadyMember: false })
	expect((await getInviteLinkByTokenHash(db, tokenHash))?.useCount).toBe(1)

	expect(
		await redeemOrgInviteLink({
			db,
			env: { APP_DB: db } as Env,
			link: (await getInviteLinkByTokenHash(db, tokenHash))!,
			user: {
				userId: joiner.personId,
				email: 'bob@partner.org',
				emailVerified: true,
			},
			audit: audit(),
		}),
	).toMatchObject({ ok: true, alreadyMember: true })
	expect((await getInviteLinkByTokenHash(db, tokenHash))?.useCount).toBe(1)

	sqlite
		.prepare(
			`UPDATE org_memberships
			 SET deleted_at = ?
			 WHERE org_id = ? AND user_id = ?`,
		)
		.run('2026-02-02T00:00:00.000Z', orgId, joiner.personId)

	expect(
		await redeemOrgInviteLink({
			db,
			env: { APP_DB: db } as Env,
			link: (await getInviteLinkByTokenHash(db, tokenHash))!,
			user: {
				userId: joiner.personId,
				email: 'bob@partner.org',
				emailVerified: true,
			},
			audit: audit(),
		}),
	).toMatchObject({ ok: true, alreadyMember: false })
	const membership = await db
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(orgId, joiner.personId)
		.first<{ role: string }>()
	expect(membership?.role).toBe('member')
	// Prior redemption is reused; removing someone does not spend another use.
	expect((await getInviteLinkByTokenHash(db, tokenHash))?.useCount).toBe(1)
})

test('a team write failure after membership still finishes teams on retry', async () => {
	const now = '2026-01-01T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO teams (id, org_id, slug, name, created_at, updated_at)
			 VALUES ('team-eng', ?, 'engineering', 'Engineering', ?, ?)`,
		)
		.run(orgId, now, now)
	const token = generateInviteLinkToken()
	const tokenHash = await hashInviteLinkToken(token)
	await createOrgInviteLink({
		db,
		orgId,
		target: { kind: 'membership', role: 'member' },
		createdByUserId: owner.personId,
		tokenHash,
		teamIds: ['team-eng'],
		audit: createTestOrgAuditWriter({
			db: auditDb,
			actorUserId: owner.personId,
		}),
	})
	sqlite.exec(
		`CREATE TRIGGER fail_team_members BEFORE INSERT ON team_members
		 BEGIN SELECT RAISE(ABORT, 'team write failed'); END`,
	)
	const link = (await getInviteLinkByTokenHash(db, tokenHash))!
	const audit = () =>
		createTestOrgAuditWriter({
			db: auditDb,
			appDb: db,
			actorUserId: joiner.personId,
		})
	await expect(
		redeemOrgInviteLink({
			db,
			env: { APP_DB: db } as Env,
			link,
			user: {
				userId: joiner.personId,
				email: 'bob@partner.org',
				emailVerified: true,
			},
			audit: audit(),
		}),
	).rejects.toThrow(/team write failed/)
	const membership = await db
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(orgId, joiner.personId)
		.first<{ role: string }>()
	expect(membership?.role).toBe('member')
	// Claim stays while membership exists so retries can finish team writes.
	expect((await getInviteLinkByTokenHash(db, tokenHash))?.useCount).toBe(1)
	expect(
		await db
			.prepare(
				`SELECT 1 AS ok FROM team_members
				 WHERE team_id = 'team-eng' AND user_id = ? AND deleted_at IS NULL`,
			)
			.bind(joiner.personId)
			.first<{ ok: number }>(),
	).toBeNull()

	sqlite.exec(`DROP TRIGGER fail_team_members`)
	mocks.syncSeatsAfterMembershipChange.mockClear()
	expect(
		await inviteLinkAlreadySatisfied(
			db,
			(await getInviteLinkByTokenHash(db, tokenHash))!,
			joiner.personId,
		),
	).toBe(false)
	expect(
		await redeemOrgInviteLink({
			db,
			env: { APP_DB: db } as Env,
			link: (await getInviteLinkByTokenHash(db, tokenHash))!,
			user: {
				userId: joiner.personId,
				email: 'bob@partner.org',
				emailVerified: true,
			},
			audit: audit(),
		}),
	).toMatchObject({ ok: true, alreadyMember: true })
	expect(
		await db
			.prepare(
				`SELECT 1 AS ok FROM team_members
				 WHERE team_id = 'team-eng' AND user_id = ? AND deleted_at IS NULL`,
			)
			.bind(joiner.personId)
			.first<{ ok: number }>(),
	).toMatchObject({ ok: 1 })
	expect(mocks.syncSeatsAfterMembershipChange).toHaveBeenCalled()
	expect((await getInviteLinkByTokenHash(db, tokenHash))?.useCount).toBe(1)
	expect(
		await inviteLinkAlreadySatisfied(
			db,
			(await getInviteLinkByTokenHash(db, tokenHash))!,
			joiner.personId,
		),
	).toBe(true)
})
