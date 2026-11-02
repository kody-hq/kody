import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as publishedRuntimeArtifacts from '#worker/package-runtime/published-runtime-artifacts.ts'
import type * as artifactFile from '#worker/repo/artifact-file.ts'
import type * as artifacts from '#worker/repo/artifacts.ts'
import { accessGrantCapability } from '#mcp/capabilities/access/access-grants.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { resolveGitHttpTargetAccess } from '#worker/repo/git-http-target.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { CommunityActionError } from './errors.ts'
import { insertCommunityFork } from './repo.ts'
import {
	findExistingPrivatePackageFork,
	forkPrivatePackage,
	loadReadablePrivateForkSource,
	preparePrivatePackageFork,
	privatePackageForkNotFoundMessage,
} from './service.ts'

// Production storage stand-ins: HEAD, the publish-time KV snapshot, and the
// Artifacts git tree. The local snapshot API stays off, as in production.
const storage = vi.hoisted(() => ({
	head: 'commit-1' as string | null,
	publishedFiles: new Map<string, Record<string, string>>(),
	treeFiles: new Map<string, Record<string, string>>(),
	treeReads: [] as Array<string>,
}))

vi.mock('#worker/repo/artifacts.ts', async (importOriginal) => ({
	...(await importOriginal<typeof artifacts>()),
	resolveArtifactSourceHead: async () => ({
		branch: 'main',
		commit: storage.head,
	}),
}))

vi.mock(
	'#worker/package-runtime/published-runtime-artifacts.ts',
	async (importOriginal) => ({
		...(await importOriginal<typeof publishedRuntimeArtifacts>()),
		readPublishedSourceSnapshot: async (input: {
			publishedCommit: string | null
		}) => {
			const files = storage.publishedFiles.get(input.publishedCommit ?? '')
			return files ? { files } : null
		},
	}),
)

vi.mock('#worker/repo/artifact-file.ts', async (importOriginal) => ({
	...(await importOriginal<typeof artifactFile>()),
	readArtifactTreeAtCommit: async (input: { commit: string }) => {
		storage.treeReads.push(input.commit)
		return storage.treeFiles.get(input.commit) ?? null
	},
}))

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

async function seed() {
	silenceIncidentalRuntimeWarnings()
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	const env = { APP_DB: db, AUDIT_DB: createAuditTestDb() } as Env
	const people = {
		owner: testStableUserIdFromEmail('pf-owner@example.com'),
		reader: testStableUserIdFromEmail('pf-reader@example.com'),
		stranger: testStableUserIdFromEmail('pf-stranger@example.com'),
	}
	for (const [name, id] of Object.entries(people)) {
		await provisionPersonalOrg(db, {
			stableUserId: id,
			username: `pf-${name}`,
		})
	}
	const packageId = crypto.randomUUID()
	await insertSavedPackage(db, {
		id: packageId,
		user_id: ownerIdFromStored(people.owner),
		name: '@pf-owner/notes',
		kody_id: 'notes',
		description: 'notes',
		tags_json: '[]',
		search_text: null,
		source_id: `source-${packageId}`,
		has_app: 1,
		has_skills: 0,
		hidden: 0,
		is_private: 1,
	})
	await db
		.prepare(
			`INSERT INTO entity_sources (id, user_id, entity_kind, entity_id, repo_id,
			 published_commit, created_at, updated_at)
			 VALUES (?, ?, 'package', ?, ?, 'commit-1', ?, ?)`,
		)
		.bind(
			`source-${packageId}`,
			ownerIdFromStored(people.owner),
			packageId,
			`repo-${packageId}`,
			'2026-01-01T00:00:00.000Z',
			'2026-01-01T00:00:00.000Z',
		)
		.run()
	await accessGrantCapability.handler(
		{
			resource_type: 'package',
			resource_id: packageId,
			subject_type: 'user',
			subject_id: people.reader,
			preset: 'read',
		},
		{
			env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				user: {
					userId: personIdFromStored(people.owner),
					email: 'pf-owner@example.com',
					displayName: 'pf-owner',
					username: 'pf-owner',
				},
			}),
		},
	)
	const viewer = (name: keyof typeof people) => ({
		userId: personIdFromStored(people[name]),
		username: `pf-${name}`,
	})
	const sourcePackage = { ownerId: ownerIdFromStored(people.owner), packageId }
	return { db, env, people, packageId, sourcePackage, viewer }
}

test('a Read grantee and the owner may read the private source; a stranger may not', async () => {
	const { env, sourcePackage, viewer } = await seed()
	expect(
		(
			await loadReadablePrivateForkSource({
				env,
				reader: viewer('reader'),
				sourcePackage,
			})
		)?.id,
	).toBe(sourcePackage.packageId)
	expect(
		(
			await loadReadablePrivateForkSource({
				env,
				reader: viewer('owner'),
				sourcePackage,
			})
		)?.id,
	).toBe(sourcePackage.packageId)
	expect(
		await loadReadablePrivateForkSource({
			env,
			reader: viewer('stranger'),
			sourcePackage,
		}),
	).toBeNull()
})

test('a stranger cannot fork and learns nothing, even when forks exist', async () => {
	const { db, env, people, packageId, sourcePackage, viewer } = await seed()
	await insertCommunityFork(db, {
		id: 'fork-private-1',
		listing_id: null,
		upstream_owner_id: ownerIdFromStored(people.owner),
		upstream_package_id: packageId,
		forker_user_id: ownerIdFromStored(people.stranger),
		origin_commit: 'commit-1',
		forked_package_id: 'forked-package-1',
		forked_source_id: 'forked-source-1',
		target_kody_id: 'notes',
		listing_name: '@pf-owner/notes',
		listing_kody_id: 'notes',
		claim_key: `package:${packageId}`,
	})
	await expect(
		forkPrivatePackage({
			env,
			baseUrl: 'https://heykody.dev',
			userId: ownerIdFromStored(people.stranger),
			expectedPackageScope: 'pf-stranger',
			sourcePackage,
			reader: viewer('stranger'),
			actor: 'human',
		}),
	).rejects.toThrow(privatePackageForkNotFoundMessage)
	await expect(
		forkPrivatePackage({
			env,
			baseUrl: 'https://heykody.dev',
			userId: ownerIdFromStored(people.stranger),
			expectedPackageScope: 'pf-stranger',
			sourcePackage: { ...sourcePackage, packageId: crypto.randomUUID() },
			reader: viewer('stranger'),
			actor: 'human',
		}),
	).rejects.toThrow(privatePackageForkNotFoundMessage)
})

test('a private fork record tracks its upstream package and is found again', async () => {
	const { db, env, people, packageId, sourcePackage } = await seed()
	await insertCommunityFork(db, {
		id: 'fork-private-2',
		listing_id: null,
		upstream_owner_id: ownerIdFromStored(people.owner),
		upstream_package_id: packageId,
		forker_user_id: ownerIdFromStored(people.reader),
		origin_commit: 'commit-1',
		forked_package_id: 'forked-package-2',
		forked_source_id: 'forked-source-2',
		target_kody_id: 'notes',
		listing_name: '@pf-owner/notes',
		listing_kody_id: 'notes',
		claim_key: `package:${packageId}`,
	})
	const existing = await findExistingPrivatePackageFork({
		env,
		userId: ownerIdFromStored(people.reader),
		sourcePackage,
	})
	expect(existing).toMatchObject({
		id: 'fork-private-2',
		listingId: null,
		upstreamOwnerId: ownerIdFromStored(people.owner),
		upstreamPackageId: packageId,
		forkerUserId: ownerIdFromStored(people.reader),
	})
	await expect(
		db
			.prepare(
				`INSERT INTO community_forks (id, listing_id, forker_user_id, origin_commit,
				 forked_package_id, forked_source_id, target_kody_id, listing_name,
				 listing_kody_id, created_at)
				 VALUES ('bad', NULL, 'x', 'c', 'p', 's', 'k', 'n', 'k', '2026-01-01')`,
			)
			.run(),
	).rejects.toThrow()
})

test('a Read grantee can clone the private package; a stranger cannot see it', async () => {
	const { env, viewer } = await seed()
	const clone = (name: 'reader' | 'stranger') =>
		resolveGitHttpTargetAccess({
			env,
			viewer: viewer(name),
			ownerHandle: 'pf-owner',
			repoName: 'notes',
			scopes: null,
			needWrite: false,
		})
	expect(await clone('reader')).not.toBeNull()
	expect(await clone('stranger')).toBeNull()
})

test('a Read grantee forks the default-branch HEAD with the snapshot API off', async () => {
	const { env, people, sourcePackage, viewer } = await seed()
	expect(env.CLOUDFLARE_API_SOURCE_SNAPSHOTS).toBeUndefined()
	const packageJson = (version: string) =>
		JSON.stringify({
			name: '@pf-owner/notes',
			version,
			kody: { id: 'notes', description: 'Notes' },
		})
	const prepare = () =>
		preparePrivatePackageFork({
			env,
			baseUrl: 'https://heykody.dev',
			userId: ownerIdFromStored(people.reader),
			expectedPackageScope: 'pf-reader',
			sourcePackage,
			reader: viewer('reader'),
			actor: 'human',
		})
	storage.publishedFiles.set('commit-1', {
		'package.json': packageJson('1.0.0'),
	})
	storage.treeReads.length = 0

	// HEAD is the published commit: the publish snapshot, no git read.
	storage.head = 'commit-1'
	const atPublished = await prepare()
	expect(atPublished.originCommit).toBe('commit-1')
	expect(atPublished.files['package.json']).toContain('1.0.0')
	expect(storage.treeReads).toEqual([])

	// A push landed after publish: HEAD's files come from the git tree.
	storage.head = 'commit-2'
	storage.treeFiles.set('commit-2', { 'package.json': packageJson('2.0.0') })
	const ahead = await prepare()
	expect(ahead.originCommit).toBe('commit-2')
	expect(ahead.files['package.json']).toContain('2.0.0')
	expect(storage.treeReads).toEqual(['commit-2'])

	storage.head = 'commit-3'
	const missing = await prepare().catch((error: unknown) => error)
	expect(missing).toBeInstanceOf(CommunityActionError)
	expect((missing as Error).message).toMatch(
		/no files to fork at commit commit-/,
	)
})
