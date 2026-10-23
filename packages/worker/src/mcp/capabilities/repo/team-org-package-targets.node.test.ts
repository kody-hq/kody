import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { listPackagesCapability } from '#mcp/capabilities/packages/list-packages.ts'
import { getGitRemoteCapability } from '#mcp/capabilities/packages/get-git-remote.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { planLimits } from '#universal/plans.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import {
	addOrgMember,
	createOrg,
	upsertGrant,
} from '#worker/orgs/access-writes.ts'
import { mismatchedPackageScopeMessage } from '#worker/package-registry/package-name.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { insertEntitySource } from '#worker/repo/entity-sources.ts'
import { insertRepoSession } from '#worker/repo/repo-sessions.ts'
import { insertUserRepo } from '#worker/repo/user-repos.ts'
import { type RepoSessionInfoResult } from '#worker/repo/types.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { repoListCapability } from './repo-list.ts'
import { repoOpenSessionCapability } from './repo-open-session.ts'
import { repoListSessionsCapability } from './repo-list-sessions.ts'
import { repoReadFileCapability } from './repo-read-file.ts'

const repoSessionDo = vi.hoisted(() => ({
	openSession: vi.fn(),
	readFile: vi.fn(),
}))

// The repo session Durable Object is the only fake: it records the session in
// the real catalog the way the object does, keyed by the session owner.
vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: () => ({
		openSession: (input: {
			sessionId: string
			sourceId: string
			userId: OwnerId
		}): Promise<RepoSessionInfoResult> => repoSessionDo.openSession(input),
		readFile: (input: { sessionId: string; userId: OwnerId; path: string }) =>
			repoSessionDo.readFile(input),
	}),
}))

const migrationsDirectory = new URL('../../../../migrations/', import.meta.url)

function sessionInfo(input: {
	sessionId: string
	sourceId: string
}): RepoSessionInfoResult {
	return {
		id: input.sessionId,
		source_id: input.sourceId,
		source_root: '/',
		base_commit: 'commit-1',
		session_branch: `session/${input.sessionId}`,
		source_branch: 'main',
		conversation_id: null,
		last_checkpoint_commit: null,
		last_check_run_id: null,
		last_check_tree_hash: null,
		expires_at: null,
		created_at: '2026-10-11T00:00:00.000Z',
		updated_at: '2026-10-11T00:00:00.000Z',
		published_commit: 'commit-1',
		manifest_path: 'package.json',
		entity_type: 'package',
	}
}

async function insertPackage(
	db: D1Database,
	input: {
		ownerId: string
		scope: string
		leaf: string
		withSource?: boolean
	},
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
	if (input.withSource !== false) {
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
	}
	return { packageId, sourceId }
}

async function insertPlainRepo(
	db: D1Database,
	input: { ownerId: string; name: string },
) {
	const repoId = crypto.randomUUID()
	const sourceId = crypto.randomUUID()
	const now = '2026-10-11T00:00:00.000Z'
	await insertUserRepo(db, {
		id: repoId,
		user_id: ownerIdFromStored(input.ownerId),
		name: input.name,
		description: null,
		created_at: now,
		updated_at: now,
	})
	await insertEntitySource(db, {
		id: sourceId,
		user_id: ownerIdFromStored(input.ownerId),
		entity_kind: 'repo',
		entity_id: repoId,
		repo_id: `repo-${repoId}`,
		published_commit: null,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: now,
		updated_at: now,
	})
	return { repoId, sourceId }
}

/**
 * Kent has `@kentcdodds/github` in his personal org and owns the `@rocket-co` team
 * org, which also has a `github` package.
 */
async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	const kentEmail = 'kent@example.com'
	const kentId = testStableUserIdFromEmail(kentEmail)
	sqlite
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id)
			 VALUES (1, 'kentcdodds', ?, 'hash', ?)`,
		)
		.run(kentEmail, kentId)
	await provisionPersonalOrgForSqliteUser(sqlite, {
		stableUserId: kentId,
		username: 'kentcdodds',
	})
	const audit = createTestOrgAuditWriter({ actorUserId: kentId })
	const teamOrg = await createOrg({
		db,
		env: {} as Env,
		slug: 'rocket-co',
		createdByUserId: kentId,
		audit,
	})
	const teamOrgId = ownerIdFromStored(teamOrg.id as string)
	const personal = await insertPackage(db, {
		ownerId: kentId,
		scope: 'kentcdodds',
		leaf: 'github',
	})
	const team = await insertPackage(db, {
		ownerId: teamOrgId,
		scope: 'rocket-co',
		leaf: 'github',
	})
	const indexEnv = createInMemoryRepoSessionIndexEnv(db)
	const env = {
		APP_DB: db,
		REPO_SESSION_INDEX: indexEnv.REPO_SESSION_INDEX,
	} as unknown as Env
	repoSessionDo.openSession.mockImplementation(
		async (input: { sessionId: string; sourceId: string; userId: OwnerId }) => {
			await insertRepoSession(env, {
				id: input.sessionId,
				user_id: input.userId,
				source_id: input.sourceId,
				source_repo_id: `repo-${input.sourceId}`,
				session_branch: `session/${input.sessionId}`,
				source_branch: 'main',
				base_commit: 'commit-1',
				source_root: '/',
				conversation_id: null,
				status: 'active',
				expires_at: null,
				last_checkpoint_at: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				created_at: '2026-10-11T00:00:00.000Z',
				updated_at: '2026-10-11T00:00:00.000Z',
			})
			return sessionInfo(input)
		},
	)

	function context(input: {
		personId: string
		username: string
		email: string
		org: { id: string; slug: string; role: OrgRole }
	}) {
		return {
			env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				user: {
					userId: personIdFromStored(input.personId),
					email: input.email,
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

	const boundToTeam = context({
		personId: kentId,
		username: 'kentcdodds',
		email: kentEmail,
		org: { id: teamOrgId, slug: 'rocket-co', role: 'owner' },
	})
	return {
		db,
		env,
		indexEnv,
		audit,
		kentId,
		teamOrgId,
		personal,
		team,
		boundToTeam,
		context,
	}
}

async function callerError(promise: Promise<unknown>) {
	const error = await promise.then(
		() => null,
		(thrown: unknown) => thrown,
	)
	expect(error).toBeInstanceOf(McpCallerError)
	return (error as Error).message
}

test('repoOpenSession resolves every package target form in the bound team org', async () => {
	const { boundToTeam, team, teamOrgId } = await setup()

	for (const args of [
		{ target: { kind: 'package', kody_id: '@rocket-co/github' } },
		{ target: { kind: 'package', package_id: team.packageId } },
		{ source_id: team.sourceId },
		{ target: { kind: 'package', kody_id: 'github' } },
	]) {
		const opened = await repoOpenSessionCapability.handler(args, boundToTeam)
		expect(opened.resolved_target).toMatchObject({
			kind: 'package',
			source_id: team.sourceId,
			package_id: team.packageId,
		})
		expect(repoSessionDo.openSession).toHaveBeenLastCalledWith(
			expect.objectContaining({
				sourceId: team.sourceId,
				userId: teamOrgId,
			}),
		)
	}
	expect(repoSessionDo.openSession).toHaveBeenCalledTimes(4)
})

test('repoOpenSession never resolves a package from another org than the bound one', async () => {
	const { boundToTeam, personal } = await setup()

	expect(
		await callerError(
			repoOpenSessionCapability.handler(
				{ target: { kind: 'package', kody_id: '@kentcdodds/github' } },
				boundToTeam,
			),
		),
	).toBe(
		mismatchedPackageScopeMessage({
			value: '@kentcdodds/github',
			requestedScope: 'kentcdodds',
			ownerScope: 'rocket-co',
		}),
	)
	expect(
		await callerError(
			repoOpenSessionCapability.handler(
				{ source_id: personal.sourceId },
				boundToTeam,
			),
		),
	).toBe('Repo source was not found for this user.')
	expect(repoSessionDo.openSession).not.toHaveBeenCalled()
})

test('a missing package points at packageList, which lists the bound org package ids', async () => {
	const { boundToTeam, personal, team } = await setup()

	expect(
		await callerError(
			repoOpenSessionCapability.handler(
				{ target: { kind: 'package', package_id: personal.packageId } },
				boundToTeam,
			),
		),
	).toContain('was not found in @rocket-co')
	expect(
		await callerError(
			getGitRemoteCapability.handler(
				{ package_id: personal.packageId, scope: 'read' },
				boundToTeam,
			),
		),
	).toContain('was not found in @rocket-co')

	const listed = await listPackagesCapability.handler({}, boundToTeam)
	expect(listed.packages.map((pkg) => pkg.package_id)).toEqual([team.packageId])
})

test('a package whose source record is missing reports a data-integrity failure, not an org binding', async () => {
	const { db, boundToTeam, teamOrgId } = await setup()
	await insertPackage(db, {
		ownerId: teamOrgId,
		scope: 'rocket-co',
		leaf: 'orphaned',
		withSource: false,
	})
	expect(
		await callerError(
			getGitRemoteCapability.handler(
				{ kody_id: 'orphaned', scope: 'read' },
				boundToTeam,
			),
		),
	).toContain('is missing its repo source record')
	expect(
		await callerError(
			repoOpenSessionCapability.handler(
				{ target: { kind: 'package', kody_id: '@rocket-co/orphaned' } },
				boundToTeam,
			),
		),
	).toContain('is missing its repo source record')
})

test('repoOpenSession counts active sessions against the bound org', async () => {
	const { boundToTeam, indexEnv, kentId, team, teamOrgId } = await setup()
	const limit = planLimits.free.maxRepoSessions
	const seed = (ownerId: string) => {
		const rows = new Map(
			Array.from({ length: limit }, (_, index) => {
				const id = `seeded-${ownerId.slice(0, 6)}-${String(index)}`
				return [
					id,
					{
						id,
						user_id: ownerIdFromStored(ownerId),
						source_id: `source-${String(index)}`,
						source_repo_id: `repo-${String(index)}`,
						session_branch: `session/${id}`,
						source_branch: 'main',
						base_commit: 'commit-1',
						source_root: '/',
						conversation_id: null,
						status: 'active' as const,
						expires_at: null,
						last_checkpoint_at: null,
						last_checkpoint_commit: null,
						last_check_run_id: null,
						last_check_tree_hash: null,
						created_at: '2026-10-11T00:00:00.000Z',
						updated_at: '2026-10-11T00:00:00.000Z',
					},
				]
			}),
		)
		indexEnv.indexes.set(ownerId, rows)
	}

	seed(kentId)
	await repoOpenSessionCapability.handler(
		{ source_id: team.sourceId },
		boundToTeam,
	)

	seed(teamOrgId)
	const denied = await repoOpenSessionCapability
		.handler({ source_id: team.sourceId }, boundToTeam)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)
	expect(isEntitlementLimitError(denied)).toBe(true)
})

test('plain repos list and open in the bound team org', async () => {
	const { db, boundToTeam, kentId, teamOrgId } = await setup()
	await insertPlainRepo(db, { ownerId: kentId, name: 'notes' })
	const teamRepo = await insertPlainRepo(db, {
		ownerId: teamOrgId,
		name: 'notes',
	})

	const listed = await repoListCapability.handler({}, boundToTeam)
	expect(listed.repos.map((repo) => repo.repo_id)).toEqual([teamRepo.repoId])

	const opened = await repoOpenSessionCapability.handler(
		{ target: { kind: 'repo', name: 'notes' } },
		boundToTeam,
	)
	expect(opened.resolved_target).toEqual(
		expect.objectContaining({
			kind: 'repo',
			source_id: teamRepo.sourceId,
			repo_id: teamRepo.repoId,
		}),
	)
	expect(repoSessionDo.openSession).toHaveBeenLastCalledWith(
		expect.objectContaining({
			sourceId: teamRepo.sourceId,
			userId: teamOrgId,
		}),
	)
})

test('team-org repo sessions are readable only by members who may read the package', async () => {
	const { db, audit, kentId, teamOrgId, team, boundToTeam, context } =
		await setup()
	const other = await insertPackage(db, {
		ownerId: teamOrgId,
		scope: 'rocket-co',
		leaf: 'billing',
	})
	const memberEmail = 'member@example.com'
	const memberId = testStableUserIdFromEmail(memberEmail)
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
		resourceId: team.packageId,
		subject: { type: 'user', id: memberId },
		preset: 'use',
		permissions: null,
		createdByUserId: kentId,
		audit,
	})
	const executeOnly = await insertPackage(db, {
		ownerId: teamOrgId,
		scope: 'rocket-co',
		leaf: 'runner',
	})
	await upsertGrant({
		db,
		orgId: teamOrgId,
		resourceType: 'package',
		resourceId: executeOnly.packageId,
		subject: { type: 'user', id: memberId },
		preset: null,
		permissions: ['package:execute'],
		createdByUserId: kentId,
		audit,
	})
	const member = context({
		personId: memberId,
		username: 'member',
		email: memberEmail,
		org: { id: teamOrgId, slug: 'rocket-co', role: 'member' },
	})
	const githubSession = await repoOpenSessionCapability.handler(
		{ source_id: team.sourceId },
		boundToTeam,
	)
	const billingSession = await repoOpenSessionCapability.handler(
		{ source_id: other.sourceId },
		boundToTeam,
	)
	const executeOnlySession = await repoOpenSessionCapability.handler(
		{ source_id: executeOnly.sourceId },
		boundToTeam,
	)
	repoSessionDo.readFile.mockImplementation(
		async (input: { path: string }) => ({
			path: input.path,
			content: 'export {}\n',
		}),
	)

	await repoReadFileCapability.handler(
		{ session_id: githubSession.id, path: 'index.ts' },
		member,
	)
	expect(repoSessionDo.readFile).toHaveBeenLastCalledWith(
		expect.objectContaining({ userId: teamOrgId }),
	)

	const denied = await repoReadFileCapability
		.handler({ session_id: billingSession.id, path: 'index.ts' }, member)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)
	expect(denied).toBeInstanceOf(AuthorizationError)
	expect(repoSessionDo.readFile).toHaveBeenCalledTimes(1)

	const listedByMember = await repoListSessionsCapability.handler({}, member)
	expect(listedByMember.sessions.map((session) => session.id)).toEqual([
		githubSession.id,
	])
	const listedByOwner = await repoListSessionsCapability.handler(
		{},
		boundToTeam,
	)
	expect(listedByOwner.sessions.map((session) => session.id).sort()).toEqual(
		[githubSession.id, billingSession.id, executeOnlySession.id].sort(),
	)
})
