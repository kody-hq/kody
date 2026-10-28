import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { storageExportCapability } from '#mcp/capabilities/storage/storage-export.ts'
import { webhookDeliveryListCapability } from '#mcp/capabilities/webhooks/webhook-delivery-list.ts'
import { webhookListCapability } from '#mcp/capabilities/webhooks/webhook-list.ts'
import { webhookSyntheticDispatchCapability } from '#mcp/capabilities/webhooks/webhook-synthetic-dispatch.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { createConnectionProfile } from '#worker/connection-profiles/repo.ts'
import {
	addOrgMember,
	createOrg,
	createTeam,
	addTeamMember,
	upsertGrant,
} from '#worker/orgs/access-writes.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { insertEntitySource } from '#worker/repo/entity-sources.ts'
import { buildPackageStorageId } from '#worker/storage-ids.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { getGitRemoteCapability } from './get-git-remote.ts'
import { listPackageSubscriptionsCapability } from './list-package-subscriptions.ts'
import { packageSubscriptionDispatchCapability } from './package-subscription-dispatch.ts'

// Artifacts and the manifest loader are the only fakes: they stand in for the
// git backing store, not for any access decision. The stub package writer is
// faked too because it pushes the stub files to Artifacts.
const stubWriter = vi.hoisted(() => ({
	create:
		vi.fn<
			(input: {
				owner: { ownerUserId: string; ownerScope: string }
				kodyId: string
			}) => Promise<unknown>
		>(),
}))

vi.mock('./create-stub-package.ts', () => ({
	createStubSavedPackage: (input: {
		owner: { ownerUserId: string; ownerScope: string }
		kodyId: string
	}) => stubWriter.create(input),
}))

vi.mock('#worker/repo/source-safety-policy.ts', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		assertRestorablePackageSourceSnapshot: async () => undefined,
		assertPublishedPackageSourceRepoHead: async (input: {
			source: { id: string }
		}) => ({
			sourceId: input.source.id,
			publishedCommit: 'commit-1',
			commit: 'commit-1',
			defaultBranch: 'main',
			remote: `https://artifacts.example.com/${input.source.id}.git`,
			repo: {},
			accessToken: {
				plaintext: 'token-secret?expires=1',
				expiresAt: '2026-10-11T01:00:00.000Z',
			},
		}),
	}
})

vi.mock('#worker/package-registry/source.ts', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		loadPackageManifestBySourceId: async () => ({
			manifest: {
				name: '@owner/pkg',
				exports: { '.': './src/index.ts' },
				kody: {
					id: 'pkg',
					description: 'pkg',
					subscriptions: { 'repo.pushed': { handler: './on-push' } },
					webhooks: [{ name: 'hook', export: './hook', responseMode: 'ack' }],
				},
			},
		}),
	}
})

const migrationsDirectory = new URL('../../../../migrations/', import.meta.url)

async function insertPackage(
	db: D1Database,
	input: { ownerId: string; scope: string; leaf: string },
) {
	const packageId = crypto.randomUUID()
	const sourceId = crypto.randomUUID()
	const now = '2026-10-11T00:00:00.000Z'
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
	return packageId
}

function context(
	env: Env,
	input: {
		personId: string
		username: string
		org: { id: string; slug: string; role: OrgRole }
		profile?: string
	},
) {
	return {
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			executionOrigin: 'interactive',
			connectionProfileName: input.profile ?? null,
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

async function setup() {
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
	return { db, env, kentId, memberId }
}

/**
 * `@rocket-co` owns packages A and B. The teammate is a member with a `use`
 * grant on A only.
 */
async function teamMemberWithGrantOnA() {
	const { db, env, kentId, memberId } = await setup()
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

/**
 * Kent owns A and B in his personal org and connects with a profile that
 * lists read and execute on A only.
 */
async function profileWithReadOnA() {
	const { db, env, kentId } = await setup()
	const a = await insertPackage(db, {
		ownerId: kentId,
		scope: 'kentcdodds',
		leaf: 'alpha',
	})
	const b = await insertPackage(db, {
		ownerId: kentId,
		scope: 'kentcdodds',
		leaf: 'bravo',
	})
	await createConnectionProfile({
		db,
		userId: kentId,
		name: 'work',
		grants: [
			{ resourceType: 'package', resourceId: a, actions: ['read', 'execute'] },
		],
	})
	return {
		a,
		b,
		ctx: context(env, {
			personId: kentId,
			username: 'kentcdodds',
			org: { id: kentId, slug: 'kentcdodds', role: 'owner' },
			profile: 'work',
		}),
	}
}

async function rejection(promise: Promise<unknown>) {
	return await promise.then(
		() => null,
		(thrown: unknown) => thrown,
	)
}

for (const [label, arrange] of [
	['an org member', teamMemberWithGrantOnA],
	['a connection profile', profileWithReadOnA],
] as const) {
	test(`${label} with read on package A gets a read remote for A and none for B`, async () => {
		const { a, b, ctx } = await arrange()

		const remoteA = await getGitRemoteCapability.handler(
			{ package_id: a, scope: 'read' },
			ctx,
		)
		expect(remoteA).toMatchObject({ package_id: a, scope: 'read' })

		expect(
			await rejection(
				getGitRemoteCapability.handler({ package_id: b, scope: 'read' }, ctx),
			),
		).toBeInstanceOf(AuthorizationError)
		expect(
			await rejection(
				getGitRemoteCapability.handler({ package_id: b, scope: 'write' }, ctx),
			),
		).toBeInstanceOf(AuthorizationError)
	})

	test(`${label} with access to package A cannot reach package B through other package capabilities`, async () => {
		const { a, b, ctx } = await arrange()

		const subscriptions = await listPackageSubscriptionsCapability.handler(
			{},
			ctx,
		)
		expect(
			subscriptions.subscriptions.map((entry) => entry.package_id),
		).toEqual([a])
		const webhooks = await webhookListCapability.handler({}, ctx)
		expect(webhooks.webhooks.map((entry) => entry.package_id)).toEqual([a])

		for (const call of [
			() =>
				packageSubscriptionDispatchCapability.handler(
					{ package_id: b, topic: 'repo.pushed', params: {} },
					ctx,
				),
			() =>
				webhookDeliveryListCapability.handler(
					{ packageId: b, webhookName: 'hook' },
					ctx,
				),
			() =>
				webhookSyntheticDispatchCapability.handler(
					{ packageId: b, webhookName: 'hook', params: {} },
					ctx,
				),
			() =>
				storageExportCapability.handler(
					{ storage_id: buildPackageStorageId(b) },
					ctx,
				),
		]) {
			expect(await rejection(call())).toBeInstanceOf(AuthorizationError)
		}
	})
}

/**
 * `@rocket-co` owns package alpha. The teammate is a member of team
 * `maintainers`, whose org grant holds `package:create` when `canCreate`, and
 * who has a `use` grant (read, no write) on alpha.
 */
async function maintainerInRocketCo({ canCreate }: { canCreate: boolean }) {
	const { db, env, kentId, memberId } = await setup()
	const audit = createTestOrgAuditWriter({ actorUserId: kentId })
	const teamOrg = await createOrg({
		db,
		env: {} as Env,
		slug: 'rocket-co',
		createdByUserId: kentId,
		audit,
	})
	const teamOrgId = teamOrg.id as string
	const alpha = await insertPackage(db, {
		ownerId: teamOrgId,
		scope: 'rocket-co',
		leaf: 'alpha',
	})
	await addOrgMember({
		db,
		orgId: teamOrgId,
		userId: memberId,
		role: 'member',
		invitedByUserId: kentId,
		audit,
	})
	const team = await createTeam({
		db,
		orgId: teamOrgId,
		slug: 'maintainers',
		name: 'Maintainers',
		createdByUserId: kentId,
		audit,
	})
	await addTeamMember({
		db,
		orgId: teamOrgId,
		teamId: team.id,
		userId: memberId,
		addedByUserId: kentId,
		audit,
	})
	if (canCreate) {
		await upsertGrant({
			db,
			orgId: teamOrgId,
			resourceType: 'org',
			resourceId: teamOrgId,
			subject: { type: 'team', id: team.id },
			preset: null,
			permissions: ['package:create'],
			createdByUserId: kentId,
			audit,
		})
	}
	await upsertGrant({
		db,
		orgId: teamOrgId,
		resourceType: 'package',
		resourceId: alpha,
		subject: { type: 'team', id: team.id },
		preset: 'use',
		permissions: null,
		createdByUserId: kentId,
		audit,
	})
	stubWriter.create.mockReset()
	stubWriter.create.mockImplementation(async (input) => {
		await insertPackage(db, {
			ownerId: input.owner.ownerUserId,
			scope: input.owner.ownerScope,
			leaf: input.kodyId,
		})
	})
	return {
		alpha,
		ctx: context(env, {
			personId: memberId,
			username: 'teammate',
			org: { id: teamOrgId, slug: 'rocket-co', role: 'member' },
		}),
	}
}

test('a member whose team holds org package:create creates a package and gets a write remote for it', async () => {
	const { ctx } = await maintainerInRocketCo({ canCreate: true })

	const remote = await getGitRemoteCapability.handler(
		{ name: '@rocket-co/fresh', create: true, scope: 'write' },
		ctx,
	)
	expect(remote).toMatchObject({ created: true, scope: 'write' })
	expect(stubWriter.create).toHaveBeenCalledTimes(1)

	const defaulted = await maintainerInRocketCo({ canCreate: true })
	await expect(
		getGitRemoteCapability.handler(
			{ name: '@rocket-co/other', create: true },
			defaulted.ctx,
		),
	).resolves.toMatchObject({ created: true, scope: 'write' })
})

test('a member without package:create is refused and no package is created', async () => {
	const { ctx } = await maintainerInRocketCo({ canCreate: false })

	const error = await rejection(
		getGitRemoteCapability.handler(
			{ name: '@rocket-co/fresh', create: true, scope: 'write' },
			ctx,
		),
	)
	expect(error).toBeInstanceOf(AuthorizationError)
	expect(error).toMatchObject({ permission: 'package:create' })
	expect(stubWriter.create).not.toHaveBeenCalled()
})

test('org package:create does not grant write on an existing package', async () => {
	const { alpha, ctx } = await maintainerInRocketCo({ canCreate: true })

	for (const args of [
		{ package_id: alpha, scope: 'write' as const },
		{ name: '@rocket-co/alpha', create: true, scope: 'write' as const },
	]) {
		const error = await rejection(getGitRemoteCapability.handler(args, ctx))
		expect(error).toBeInstanceOf(AuthorizationError)
		expect(error).toMatchObject({ permission: 'package:write' })
	}
	expect(stubWriter.create).not.toHaveBeenCalled()
	await expect(
		getGitRemoteCapability.handler(
			{ name: '@rocket-co/alpha', create: true },
			ctx,
		),
	).resolves.toMatchObject({ created: false, scope: 'read' })
})
