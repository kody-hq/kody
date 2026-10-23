import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { insertCommunityFork } from '#worker/community/repo.ts'
import {
	addOrgMember,
	createOrg,
	upsertGrant,
} from '#worker/orgs/access-writes.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { insertEntitySource } from '#worker/repo/entity-sources.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { communityForkAdoptCapability } from './adopt.ts'

const migrationsDirectory = new URL('../../../../migrations/', import.meta.url)

async function insertPackage(
	db: D1Database,
	input: {
		ownerId: string
		scope: string
		leaf: string
		communityFork?: boolean
	},
) {
	const packageId = crypto.randomUUID()
	const sourceId = crypto.randomUUID()
	const now = '2026-10-11T00:00:00.000Z'
	const communityFork = input.communityFork !== false
	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: ownerIdFromStored(input.ownerId),
			name: `@${input.scope}/${input.leaf}`,
			kody_id: input.leaf,
			description: `${input.leaf} for @${input.scope}`,
			tags_json: '[]',
			search_text: null,
			source_id: sourceId,
			has_app: 0,
			has_skills: 0,
			hidden: 0,
			is_private: 1,
		},
		null,
		{ stamp: false },
	)
	await insertEntitySource(db, {
		id: sourceId,
		user_id: ownerIdFromStored(input.ownerId),
		entity_kind: 'package',
		entity_id: packageId,
		repo_id: `package-${packageId}`,
		published_commit: 'commit-1',
		indexed_commit: 'commit-1',
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: now,
		updated_at: now,
	})
	if (communityFork) {
		await insertCommunityFork(db, {
			id: crypto.randomUUID(),
			listing_id: `listing-${input.leaf}`,
			forker_user_id: ownerIdFromStored(input.ownerId),
			origin_commit: 'commit-origin',
			forked_package_id: packageId,
			forked_source_id: sourceId,
			target_kody_id: input.leaf,
			listing_name: `@upstream/${input.leaf}`,
			listing_kody_id: input.leaf,
		})
	}
	return packageId
}

function context(
	env: Env,
	input: {
		personId: string
		username: string
		org: { id: string; slug: string; role: OrgRole }
	},
) {
	return {
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			executionOrigin: 'interactive',
			user: {
				userId: personIdFromStored(input.personId),
				email: `${input.username}@example.com`,
				displayName: input.username,
				username: input.username,
			},
			orgBinding: {
				org: { id: ownerIdFromStored(input.org.id), slug: input.org.slug },
				role: input.org.role,
			},
		}),
	}
}

async function setupTeamMemberWithUseOnA() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	const env = { APP_DB: db } as unknown as Env
	const seedPerson = async (username: string) => {
		const id = testStableUserIdFromEmail(`${username}@example.com`)
		sqlite
			.prepare(
				`INSERT INTO users (username, email, password_hash, stable_user_id)
				 VALUES (?, ?, 'hash', ?)`,
			)
			.run(username, `${username}@example.com`, id)
		await provisionPersonalOrgForSqliteUser(sqlite, {
			stableUserId: id,
			username,
		})
		return id
	}
	const kentId = await seedPerson('kentcdodds')
	const memberId = await seedPerson('teammate')
	const audit = createTestOrgAuditWriter({ actorUserId: kentId })
	const teamOrg = await createOrg({
		db,
		env: {} as Env,
		slug: 'rocket-co',
		createdByUserId: kentId,
		audit,
	})
	const teamOrgId = teamOrg.id as string
	const a = await insertPackage(db, {
		ownerId: teamOrgId,
		scope: 'rocket-co',
		leaf: 'alpha',
	})
	const b = await insertPackage(db, {
		ownerId: teamOrgId,
		scope: 'rocket-co',
		leaf: 'bravo',
	})
	await addOrgMember({
		db,
		orgId: teamOrgId,
		userId: memberId,
		role: 'member',
		invitedByUserId: kentId,
		audit,
	})
	await upsertGrant({
		db,
		orgId: teamOrgId,
		resourceType: 'package',
		resourceId: a,
		subject: { type: 'user', id: memberId },
		preset: 'use',
		permissions: null,
		createdByUserId: kentId,
		audit,
	})
	return {
		a,
		b,
		ctx: context(env, {
			personId: memberId,
			username: 'teammate',
			org: { id: teamOrgId, slug: 'rocket-co', role: 'member' },
		}),
	}
}

async function rejection(promise: Promise<unknown>) {
	return await promise.then(
		() => null,
		(thrown: unknown) => thrown,
	)
}

test('team member with Use on package A can adopt-inspect A in the bound org and not B', async () => {
	const { a, b, ctx } = await setupTeamMemberWithUseOnA()

	await expect(
		communityForkAdoptCapability.handler({ package_id: a }, ctx),
	).resolves.toMatchObject({ status: 'approval_required' })

	expect(
		await rejection(
			communityForkAdoptCapability.handler({ package_id: b }, ctx),
		),
	).toBeInstanceOf(AuthorizationError)
})

test('denied adopt probes do not leak self-authored vs forked vs kodyId', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	const env = { APP_DB: db } as unknown as Env
	const seedPerson = async (username: string) => {
		const id = testStableUserIdFromEmail(`${username}@example.com`)
		sqlite
			.prepare(
				`INSERT INTO users (username, email, password_hash, stable_user_id)
				 VALUES (?, ?, 'hash', ?)`,
			)
			.run(username, `${username}@example.com`, id)
		await provisionPersonalOrgForSqliteUser(sqlite, {
			stableUserId: id,
			username,
		})
		return id
	}
	const kentId = await seedPerson('kentcdodds')
	const memberId = await seedPerson('teammate')
	const audit = createTestOrgAuditWriter({ actorUserId: kentId })
	const teamOrg = await createOrg({
		db,
		env: {} as Env,
		slug: 'rocket-co',
		createdByUserId: kentId,
		audit,
	})
	const teamOrgId = teamOrg.id as string
	const granted = await insertPackage(db, {
		ownerId: teamOrgId,
		scope: 'rocket-co',
		leaf: 'alpha',
	})
	const forkedDenied = await insertPackage(db, {
		ownerId: teamOrgId,
		scope: 'rocket-co',
		leaf: 'secret-fork',
	})
	const selfAuthoredDenied = await insertPackage(db, {
		ownerId: teamOrgId,
		scope: 'rocket-co',
		leaf: 'secret-self',
		communityFork: false,
	})
	await addOrgMember({
		db,
		orgId: teamOrgId,
		userId: memberId,
		role: 'member',
		invitedByUserId: kentId,
		audit,
	})
	await upsertGrant({
		db,
		orgId: teamOrgId,
		resourceType: 'package',
		resourceId: granted,
		subject: { type: 'user', id: memberId },
		preset: 'use',
		permissions: null,
		createdByUserId: kentId,
		audit,
	})
	const ctx = context(env, {
		personId: memberId,
		username: 'teammate',
		org: { id: teamOrgId, slug: 'rocket-co', role: 'member' },
	})

	const forkedError = await rejection(
		communityForkAdoptCapability.handler({ package_id: forkedDenied }, ctx),
	)
	const selfError = await rejection(
		communityForkAdoptCapability.handler(
			{ package_id: selfAuthoredDenied },
			ctx,
		),
	)
	expect(forkedError).toBeInstanceOf(AuthorizationError)
	expect(selfError).toBeInstanceOf(AuthorizationError)
	expect(String(forkedError)).not.toMatch(/secret-fork|self-authored|listing/i)
	expect(String(selfError)).not.toMatch(/secret-self|self-authored|listing/i)
})
