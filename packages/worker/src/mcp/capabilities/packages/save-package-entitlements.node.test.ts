import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import type * as sourceSafetyPolicyModule from '#worker/repo/source-safety-policy.ts'
import type * as packageRegistryRepoModule from '#worker/package-registry/repo.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#universal/plans.ts'
import { maxRepoSourceFileBytes } from '#worker/repo/large-file-policy.ts'
import { PackagePublishLockedError } from '#worker/package-registry/package-publish-lock.ts'
import {
	RepoChecksFailedError,
	repoChecksFailedErrorName,
} from '#worker/repo/repo-checks-failed-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import {
	addOrgMember,
	addTeamMember,
	createTeam,
	upsertGrant,
} from '#worker/orgs/access-writes.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const migrationsDirectory = new URL('../../../../migrations/', import.meta.url)

const mockModule = vi.hoisted(() => ({
	ensureEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
	refreshSavedPackageProjection: vi.fn(),
	upsertSavedPackageVector: vi.fn(),
	getEntitySourceByEntity: vi.fn(),
	deleteEntitySource: vi.fn(),
	loadPriorPackageManifestContent: vi.fn(),
	insertSavedPackage: vi.fn(),
	realInsertSavedPackage: null as
		| null
		| typeof packageRegistryRepoModule.insertSavedPackage,
}))

vi.mock('#worker/repo/source-service.ts', () => ({
	ensureEntitySource: (...args: Array<unknown>) =>
		mockModule.ensureEntitySource(...args),
}))

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.syncArtifactSourceSnapshot(...args),
}))

vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: (...args: Array<unknown>) =>
		mockModule.refreshSavedPackageProjection(...args),
}))

vi.mock('#worker/package-registry/vectorize.ts', () => ({
	upsertSavedPackageVector: (...args: Array<unknown>) =>
		mockModule.upsertSavedPackageVector(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByEntity: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByEntity(...args),
	deleteEntitySource: (...args: Array<unknown>) =>
		mockModule.deleteEntitySource(...args),
}))

vi.mock('#worker/repo/source-safety-policy.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof sourceSafetyPolicyModule>()
	return {
		...actual,
		loadPriorPackageManifestContent: (...args: Array<unknown>) =>
			mockModule.loadPriorPackageManifestContent(...args),
		assertPackageSourceOverwriteAllowed: vi.fn(async () => undefined),
	}
})

vi.mock('#worker/package-registry/repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof packageRegistryRepoModule>()
	mockModule.realInsertSavedPackage = actual.insertSavedPackage
	return {
		...actual,
		insertSavedPackage: (...args: Array<unknown>) =>
			mockModule.insertSavedPackage(...args),
	}
})

vi.mock(
	'#worker/credentials/package-unmappable-credentials.ts',
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import('#worker/credentials/package-unmappable-credentials.ts')
		>()),
		loadPackageUnmappableCredentials: async () => new Map(),
	}),
)

const { savePackageCapability } = await import('./save-package.ts')

type Row = Record<string, unknown>
const now = '2026-04-18T00:00:00.000Z'

function createDatabase(
	users: Array<Row>,
	savedPackages: Array<Row>,
	{
		failInsertWithUniqueName = false,
		orgs = [],
	}: { failInsertWithUniqueName?: boolean; orgs?: Array<Row> } = {},
) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	for (const user of users) {
		sqlite
			.prepare(
				`INSERT INTO users (
					username, email, password_hash, email_verified_at, stable_user_id
				) VALUES (?, ?, 'x', ?, ?)`,
			)
			.run(
				String(user['username']),
				String(user['email']),
				now,
				String(user['stable_user_id']),
			)
		const stableUserId = String(user['stable_user_id'])
		if (!orgs.some((org) => String(org['id']) === stableUserId)) {
			sqlite
				.prepare(
					`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run(
					stableUserId,
					String(user['username']),
					String(user['plan'] ?? 'free'),
					now,
					now,
				)
		}
	}
	for (const org of orgs) {
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				String(org['id']),
				String(org['slug']),
				String(org['plan'] ?? 'free'),
				now,
				now,
			)
	}
	for (const row of savedPackages) {
		sqlite
			.prepare(
				`INSERT INTO saved_packages (
					id, user_id, name, kody_id, description, tags_json, search_text,
					source_id, has_app, hidden, is_private, locked_at, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				String(row['id']),
				String(row['user_id']),
				String(row['name']),
				String(row['kody_id']),
				String(row['description'] ?? ''),
				String(row['tags_json'] ?? '[]'),
				row['search_text'] == null ? null : String(row['search_text']),
				String(row['source_id']),
				Number(row['has_app'] ?? 0),
				Number(row['hidden'] ?? 0),
				Number(row['is_private'] ?? 1),
				row['locked_at'] == null ? null : String(row['locked_at']),
				String(row['created_at'] ?? now),
				String(row['updated_at'] ?? now),
			)
	}
	const realInsert = mockModule.realInsertSavedPackage
	if (!realInsert) {
		throw new Error('Expected real insertSavedPackage from importOriginal.')
	}
	mockModule.insertSavedPackage.mockImplementation(async (...args) => {
		if (failInsertWithUniqueName) {
			throw new Error(
				'D1_ERROR: UNIQUE constraint failed: saved_packages.user_id, saved_packages.name: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)',
			)
		}
		return await realInsert(
			...(args as Parameters<
				typeof packageRegistryRepoModule.insertSavedPackage
			>),
		)
	})
	return { db, sqlite }
}

function savedPackageRow(
	userId: string,
	id: string,
	kodyId: string,
	extra: Row = {},
) {
	return {
		id,
		user_id: userId,
		name: `@planned/${kodyId}`,
		kody_id: kodyId,
		description: 'Existing package',
		tags_json: '[]',
		search_text: null,
		source_id: `source-${id}`,
		has_app: 0,
		created_at: now,
		updated_at: now,
		...extra,
	}
}

function filledPackages(userId: string, count: number | null) {
	if (count === null) throw new Error('Expected a numeric package limit.')
	return Array.from({ length: count }, (_, index) =>
		savedPackageRow(userId, `package-${index}`, `existing-${index}`),
	)
}

function buildPackageFiles(
	kodyId: string,
	{
		username = 'planned',
		name = `@${username}/${kodyId}`,
		...manifest
	}: { username?: string; name?: string; private?: boolean } = {},
) {
	return [
		{
			path: 'package.json',
			content: JSON.stringify({
				name,
				...manifest,
				exports: { '.': './src/index.ts' },
				kody: { id: kodyId, description: `Package ${kodyId}` },
			}),
		},
		{
			path: 'src/index.ts',
			content: 'export default async function main() { return { ok: true } }\n',
		},
	]
}

function sourceRow({ entityId, userId }: { entityId: string; userId: string }) {
	return {
		id: `source-${entityId}`,
		user_id: userId,
		entity_kind: 'package',
		entity_id: entityId,
		repo_id: `repo-${entityId}`,
		published_commit: 'published-commit-1',
		indexed_commit: 'published-commit-1',
		manifest_path: 'package.json',
		source_root: '/',
		created_at: now,
		updated_at: now,
	}
}

async function setup({
	email = 'planned@example.com',
	plan = 'pro',
	username = 'planned',
	savedPackages = () => [],
	failInsertWithUniqueName = false,
	teamOrg,
	member,
}: {
	email?: string
	plan?: string
	username?: string
	savedPackages?: (userId: string) => Array<Row>
	failInsertWithUniqueName?: boolean
	teamOrg?: { id: string; slug: string; plan: string }
	/** Join `teamOrg` as a member of team `maintainers` with these grants. */
	member?: {
		orgCreate: boolean
		packageGrant?: { packageId: string; preset: 'use' | 'contribute' }
	}
} = {}) {
	for (const mock of [
		mockModule.ensureEntitySource,
		mockModule.syncArtifactSourceSnapshot,
		mockModule.refreshSavedPackageProjection,
		mockModule.upsertSavedPackageVector,
		mockModule.getEntitySourceByEntity,
		mockModule.deleteEntitySource,
		mockModule.loadPriorPackageManifestContent,
		mockModule.insertSavedPackage,
	]) {
		mock.mockReset()
	}
	mockModule.ensureEntitySource.mockImplementation(async (input) => ({
		...sourceRow(input),
		bootstrapAccess: null,
	}))
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('published-commit-1')
	mockModule.refreshSavedPackageProjection.mockImplementation(
		async ({ packageId, userId }) => ({
			record: {
				id: packageId,
				userId,
				name: '@planned/pkg',
				kodyId: 'pkg',
				description: 'Package pkg',
				tags: [],
				searchText: null,
				sourceId: `source-${packageId}`,
				hasApp: false,
				hidden: false,
				isPrivate: false,
				isInternetVisible: false,
				lockedAt: null,
				createdAt: now,
				updatedAt: now,
			},
		}),
	)
	mockModule.upsertSavedPackageVector.mockResolvedValue(undefined)
	mockModule.getEntitySourceByEntity.mockImplementation(async (input) =>
		sourceRow(input),
	)
	mockModule.deleteEntitySource.mockResolvedValue(true)
	mockModule.loadPriorPackageManifestContent.mockResolvedValue(null)

	const userId = testStableUserIdFromEmail(email)
	const ownerUserId = teamOrg ? ownerIdFromStored(teamOrg.id) : userId
	const seedRows = savedPackages(ownerUserId)
	const { db, sqlite } = createDatabase(
		[{ email, plan, username, stable_user_id: userId }],
		seedRows,
		{
			failInsertWithUniqueName,
			orgs: teamOrg
				? [{ id: teamOrg.id, slug: teamOrg.slug, plan: teamOrg.plan }]
				: [],
		},
	)
	if (member) {
		if (!teamOrg) throw new Error('A member needs a team org.')
		await joinAsMaintainer({ db, orgId: teamOrg.id, userId, ...member })
	}
	const ctx = {
		env: { APP_DB: db } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored(userId),
				email,
				displayName: 'Planned User',
			},
			orgBinding: teamOrg
				? {
						org: { id: ownerIdFromStored(teamOrg.id), slug: teamOrg.slug },
						role: member ? 'member' : 'owner',
					}
				: undefined,
		}),
	}
	const save = (args: Record<string, unknown>) =>
		savePackageCapability.handler(args, ctx)
	const latestPackage = () =>
		sqlite
			.prepare(
				`SELECT * FROM saved_packages WHERE user_id = ? ORDER BY rowid DESC LIMIT 1`,
			)
			.get(ownerUserId) as Row | null
	return { userId, ownerUserId, save, latestPackage }
}

async function joinAsMaintainer(input: {
	db: D1Database
	orgId: string
	userId: string
	orgCreate: boolean
	packageGrant?: { packageId: string; preset: 'use' | 'contribute' }
}) {
	const { db, orgId, userId } = input
	const audit = createTestOrgAuditWriter({ actorUserId: userId })
	await addOrgMember({
		db,
		orgId,
		userId,
		role: 'member',
		invitedByUserId: userId,
		audit,
	})
	const team = await createTeam({
		db,
		orgId,
		slug: 'maintainers',
		name: 'Maintainers',
		createdByUserId: userId,
		audit,
	})
	await addTeamMember({
		db,
		orgId,
		teamId: team.id,
		userId,
		addedByUserId: userId,
		audit,
	})
	const subject = { type: 'team', id: team.id } as const
	if (input.orgCreate) {
		await upsertGrant({
			db,
			orgId,
			resourceType: 'org',
			resourceId: orgId,
			subject,
			preset: null,
			permissions: ['package:create'],
			createdByUserId: userId,
			audit,
		})
	}
	if (input.packageGrant) {
		await upsertGrant({
			db,
			orgId,
			resourceType: 'package',
			resourceId: input.packageGrant.packageId,
			subject,
			preset: input.packageGrant.preset,
			permissions: null,
			createdByUserId: userId,
			audit,
		})
	}
}

const rejection = (promise: Promise<unknown>) =>
	promise.then(
		() => null,
		(thrown: unknown) => thrown,
	)

function readSyncedPackageJson() {
	const syncCall = mockModule.syncArtifactSourceSnapshot.mock.calls.at(-1)
	if (!syncCall) throw new Error('Expected syncArtifactSourceSnapshot call.')
	const files = (syncCall[0] as { files: Record<string, string> }).files
	return JSON.parse(files['package.json'] ?? '{}') as Record<string, unknown>
}

test('packageSave under a paid team org enforces the org plan, not free', async () => {
	const teamOrgId = 'c'.repeat(64)
	const freeLimit = planLimits.free.maxSavedPackages
	const { save } = await setup({
		email: 'member@example.com',
		plan: 'free',
		username: 'member',
		teamOrg: { id: teamOrgId, slug: 'acme', plan: 'max' },
		savedPackages: (ownerId) => filledPackages(ownerId, freeLimit),
	})
	// At the free ceiling under a max org: the old actor-email pairing denied
	// this create; blank entitlement email resolves the org's max plan.
	await save({
		files: buildPackageFiles('team-org-package', { username: 'acme' }),
	})
	expect(mockModule.ensureEntitySource).toHaveBeenCalled()
	expect(mockModule.refreshSavedPackageProjection).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored(teamOrgId),
			userEmail: null,
		}),
	)
})

test('packageSave allows below-limit creates and denies creates at the pro and max plan ceilings', async () => {
	const below = await setup({
		email: 'max@example.com',
		plan: 'max',
		username: 'max',
		savedPackages: (userId) =>
			filledPackages(userId, planLimits.pro.maxSavedPackages),
	})
	await below.save({
		files: buildPackageFiles('below-max-package', { username: 'max' }),
	})
	expect(mockModule.ensureEntitySource).toHaveBeenCalled()

	for (const plan of ['pro', 'max'] as const) {
		const limit = planLimits[plan].maxSavedPackages
		const { save } = await setup({
			email: `${plan}@example.com`,
			plan,
			username: plan,
			savedPackages: (userId) => filledPackages(userId, limit),
		})

		const error = await rejection(
			save({ files: buildPackageFiles('new-package', { username: plan }) }),
		)

		if (!isEntitlementLimitError(error)) {
			throw new Error(`Expected an EntitlementLimitError for ${plan}.`)
		}
		expect(error.details).toMatchObject({
			code: 'entitlement_limit_exceeded',
			resource: 'saved_packages',
			plan,
			limit,
			current: limit,
		})
		expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
	}
})

test('packageSave does not gate updates to an existing package at the limit', async () => {
	const { save } = await setup({
		savedPackages: (userId) => [
			...filledPackages(userId, planLimits.pro.maxSavedPackages),
			savedPackageRow(userId, 'package-existing', 'updatable-package'),
		],
	})

	await save({
		package_id: 'package-existing',
		confirm_destructive_overwrite: true,
		files: buildPackageFiles('updatable-package'),
	})

	expect(mockModule.ensureEntitySource).toHaveBeenCalled()
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalled()
})

test('packageSave maps id mismatch, rename name collision, and UNIQUE insert races to caller errors', async () => {
	const privateCreate = {
		confirm_destructive_overwrite: false,
		confirm_private_visibility_change: false,
	}
	const expectCallerError = async (
		promise: Promise<unknown>,
		message: string | RegExp,
	) => {
		const error = await rejection(promise)
		expect(error).toBeInstanceOf(McpCallerError)
		if (typeof message === 'string') {
			expect((error as Error).message).toContain(message)
		} else {
			expect((error as Error).message).toMatch(message)
		}
	}

	const mismatch = await setup({
		email: 'mismatch@example.com',
		username: 'collision',
		savedPackages: (userId) => [
			savedPackageRow(userId, 'existing-package-id', 'pkg', {
				name: '@collision/pkg',
				hidden: 0,
				is_private: 1,
			}),
		],
	})
	await expectCallerError(
		mismatch.save({
			...privateCreate,
			package_id: 'fabricated-package-id',
			files: buildPackageFiles('pkg', {
				name: '@collision/pkg',
				private: true,
			}),
		}),
		'fabricated-package-id',
	)
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	const sharedName = '@collision/taken'
	const rename = await setup({
		email: 'rename@example.com',
		username: 'collision',
		savedPackages: (userId) => [
			savedPackageRow(userId, 'renaming-package-id', 'renaming', {
				name: '@collision/renaming',
				hidden: 0,
				is_private: 1,
			}),
			savedPackageRow(userId, 'taken-package-id', 'taken', {
				name: sharedName,
				hidden: 0,
				is_private: 1,
			}),
		],
	})
	await expectCallerError(
		rename.save({
			...privateCreate,
			package_id: 'renaming-package-id',
			files: buildPackageFiles('taken', { name: sharedName, private: true }),
		}),
		sharedName,
	)
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	const race = await setup({
		email: 'race@example.com',
		username: 'race',
		failInsertWithUniqueName: true,
	})
	await expectCallerError(
		race.save({
			...privateCreate,
			files: buildPackageFiles('pkg', { username: 'race', private: true }),
		}),
		/A saved package named "@race\/pkg" already exists/,
	)
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalled()
	expect(mockModule.deleteEntitySource.mock.calls).toEqual([
		[
			expect.anything(),
			{ id: expect.stringMatching(/^source-/), userId: race.userId },
		],
	])
})

test('packageSave keeps new packages private unless an explicit private:false is confirmed', async () => {
	const visibilityUser = {
		email: 'visibility@example.com',
		plan: 'max',
		username: 'visibility',
	}

	// The confirmation flag alone never requests public visibility; it
	// only approves an explicit manifest state. Omission stays private.
	const omitted = await setup(visibilityUser)
	await omitted.save({
		files: buildPackageFiles('new-package', { username: 'visibility' }),
		confirm_private_visibility_change: true,
	})
	expect(readSyncedPackageJson()['private']).toBe(true)
	expect(omitted.latestPackage()?.['is_private']).toBe(1)

	// Leftover private:false stays in the manifest but not catalog visibility.
	const leftover = await setup(visibilityUser)
	await leftover.save({
		files: buildPackageFiles('new-package', {
			username: 'visibility',
			private: false,
		}),
		confirm_private_visibility_change: true,
	})
	expect(readSyncedPackageJson()['private']).toBe(false)
	expect(leftover.latestPackage()?.['is_private']).toBe(1)

	const unconfirmed = await setup(visibilityUser)
	await expect(
		unconfirmed.save({
			files: buildPackageFiles('new-package', {
				username: 'visibility',
				private: false,
			}),
		}),
	).rejects.toThrow('confirm_private_visibility_change')
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	// First save injects `"private": true`. Re-sending the same author files
	// (no `private` field) must not trip the visibility guard.
	const resave = await setup({
		...visibilityUser,
		savedPackages: (userId) => [
			savedPackageRow(userId, 'package-existing', 'new-package', {
				name: '@visibility/new-package',
				hidden: 0,
				is_private: 1,
			}),
		],
	})
	mockModule.loadPriorPackageManifestContent.mockResolvedValue(
		JSON.stringify({
			name: '@visibility/new-package',
			private: true,
			exports: { '.': './src/index.ts' },
			kody: { id: 'new-package', description: 'Package new-package' },
		}),
	)
	await resave.save({
		package_id: 'package-existing',
		confirm_destructive_overwrite: true,
		files: buildPackageFiles('new-package', { username: 'visibility' }),
	})
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalled()
	expect(readSyncedPackageJson()['private']).toBeUndefined()
})

test('packageSave maps failed publish checks to McpCallerError (live and DO RPC shapes)', async () => {
	const diagnostic =
		"src/receive.js(12,3): Argument of type 'string' is not assignable to parameter of type 'EmailMessage'."

	const live = await setup({ plan: 'max' })
	mockModule.syncArtifactSourceSnapshot.mockRejectedValueOnce(
		new RepoChecksFailedError(diagnostic),
	)
	const liveError = await rejection(
		live.save({ files: buildPackageFiles('checks-failed-live') }),
	)
	expect(liveError).toBeInstanceOf(McpCallerError)
	expect((liveError as Error).message).toContain('EmailMessage')

	const rpcFlattened = await setup({ plan: 'max' })
	mockModule.syncArtifactSourceSnapshot.mockRejectedValueOnce(
		new Error(`${repoChecksFailedErrorName}: ${diagnostic}`),
	)
	const rpcError = await rejection(
		rpcFlattened.save({ files: buildPackageFiles('checks-failed-rpc') }),
	)
	expect(rpcError).toBeInstanceOf(McpCallerError)
	expect((rpcError as Error).message).toContain('EmailMessage')

	const unrelated = await setup({ plan: 'max' })
	mockModule.syncArtifactSourceSnapshot.mockRejectedValueOnce(
		new Error('bundle artifact KV write failed'),
	)
	const platformError = await rejection(
		unrelated.save({ files: buildPackageFiles('checks-failed-platform') }),
	)
	expect(platformError).toBeInstanceOf(Error)
	expect(platformError).not.toBeInstanceOf(McpCallerError)
	expect((platformError as Error).message).toContain(
		'bundle artifact KV write failed',
	)
})

test('packageSave lock approval keeps the stored kody id during a rename', async () => {
	const { save } = await setup({
		savedPackages: (userId) => [
			savedPackageRow(userId, 'package-existing', 'current-package', {
				hidden: 0,
				is_private: 0,
				locked_at: now,
			}),
		],
	})
	mockModule.syncArtifactSourceSnapshot.mockRejectedValue(
		new PackagePublishLockedError({
			packageId: 'package-existing',
			packageName: '@planned/current-package',
			pendingCommit: 'abc1234',
			currentPublishedCommit: 'def5678',
		}),
	)

	const error = await rejection(
		save({
			package_id: 'package-existing',
			confirm_destructive_overwrite: true,
			files: buildPackageFiles('renamed-package'),
		}),
	)

	expect(error).toBeInstanceOf(Error)
	expect((error as Error).message).toContain(
		'https://example.com/@planned/current-package/approve-publish?commit=abc1234',
	)
	expect((error as Error).message).not.toContain('/renamed-package/')
})

test('packageSave rejects a file over the per-file repo size limit with hosting guidance', async () => {
	const { save } = await setup({ plan: 'max' })

	const error = await rejection(
		save({
			files: [
				...buildPackageFiles('oversized-package'),
				{
					path: 'assets/dataset.csv',
					content: 'x'.repeat(maxRepoSourceFileBytes + 1),
				},
			],
		}),
	)

	expect(error).toBeInstanceOf(Error)
	const message = (error as Error).message
	expect(message).toContain('"assets/dataset.csv"')
	expect(message).toContain('per-file limit')
	expect(message).toContain('Cloudflare R2')
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
})

test('packageSave lists placeholder references from the published files, not only the submitted ones', async () => {
	const { save } = await setup({ plan: 'max' })
	const submitted = buildPackageFiles('kept-file-package')
	const refresh =
		mockModule.refreshSavedPackageProjection.getMockImplementation()!
	mockModule.refreshSavedPackageProjection.mockImplementationOnce(
		async (input) => ({
			...(await refresh(input)),
			files: {
				...Object.fromEntries(
					submitted.map((file) => [file.path, file.content]),
				),
				'src/kept.ts': "export const h = { a: '{{secret:OLD_KEY}}' }\n",
			},
		}),
	)

	const result = await save({ files: submitted })

	expect(result.next_steps).toContain('Credential stamp publish gate')
	expect(result.next_steps).toMatch(/missing a description|OLD_KEY/)
})

const maintainersOrg = { id: 'd'.repeat(64), slug: 'kody', plan: 'max' }

test('packageSave create needs org package:create, not package:write', async () => {
	const allowed = await setup({
		email: 'member@example.com',
		username: 'member',
		teamOrg: maintainersOrg,
		member: { orgCreate: true },
	})
	await allowed.save({
		files: buildPackageFiles('fresh-package', { username: 'kody' }),
	})
	expect(mockModule.ensureEntitySource).toHaveBeenCalled()
	expect(allowed.latestPackage()).toMatchObject({ name: '@kody/fresh-package' })

	// Write on another package passes the surface but does not allow creating.
	const refused = await setup({
		email: 'member@example.com',
		username: 'member',
		teamOrg: maintainersOrg,
		savedPackages: (ownerId) => [
			savedPackageRow(ownerId, 'package-other', 'other-package'),
		],
		member: {
			orgCreate: false,
			packageGrant: { packageId: 'package-other', preset: 'contribute' },
		},
	})
	const error = await rejection(
		refused.save({
			files: buildPackageFiles('fresh-package', { username: 'kody' }),
		}),
	)
	expect(error).toBeInstanceOf(AuthorizationError)
	expect(error).toMatchObject({ permission: 'package:create' })
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
	expect(refused.latestPackage()).toMatchObject({ id: 'package-other' })
})

test('packageSave update keeps per-package write, even with org package:create', async () => {
	const existing = (ownerId: string) => [
		{
			...savedPackageRow(ownerId, 'package-existing', 'shared-package'),
			name: '@kody/shared-package',
		},
	]
	const update = {
		package_id: 'package-existing',
		confirm_destructive_overwrite: true,
		files: buildPackageFiles('shared-package', { username: 'kody' }),
	}

	const readOnly = await setup({
		email: 'member@example.com',
		username: 'member',
		teamOrg: maintainersOrg,
		savedPackages: existing,
		member: {
			orgCreate: true,
			packageGrant: { packageId: 'package-existing', preset: 'use' },
		},
	})
	const error = await rejection(readOnly.save(update))
	expect(error).toBeInstanceOf(AuthorizationError)
	expect(error).toMatchObject({ permission: 'package:write' })
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	const contributor = await setup({
		email: 'member@example.com',
		username: 'member',
		teamOrg: maintainersOrg,
		savedPackages: existing,
		member: {
			orgCreate: false,
			packageGrant: { packageId: 'package-existing', preset: 'contribute' },
		},
	})
	await contributor.save(update)
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalled()
})
