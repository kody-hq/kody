import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { runWithRequestPermissions } from '#worker/authorization/authorize.ts'
import { accessGrantCapability } from '#mcp/capabilities/access/access-grants.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import * as mcpExecutor from '#mcp/executor.ts'
import { runModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import * as moduleGraph from '#worker/package-runtime/module-graph.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	resolveSavedPackageImport,
	SavedPackageNotFoundError,
} from './package-import-resolution.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

vi.mock('#worker/package-runtime/module-graph.ts', async () => {
	const actual = await vi.importActual<typeof moduleGraph>(
		'#worker/package-runtime/module-graph.ts',
	)
	return {
		...actual,
		buildKodyModuleBundle: vi.fn(async () => ({
			mainModule: 'entry.js',
			modules: {
				'entry.js':
					'export default async function main() { return { pong: true } }',
			},
			dependencies: [],
		})),
		hydrateKodyRuntimeModules: vi.fn(async (input: { modules: unknown }) => ({
			modules: input.modules,
			dynamicDependencyPackageIds: [],
		})),
	}
})

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	return db
}

function ownerCaller(input: { userId: string; username: string }) {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		user: {
			userId: personIdFromStored(input.userId),
			email: `${input.username}@example.com`,
			displayName: input.username,
			username: input.username,
		},
	})
}

function granteeInOwnerOrg(input: {
	granteeUserId: string
	granteeUsername: string
	ownerOrgId: string
	ownerSlug: string
}) {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		user: {
			userId: personIdFromStored(input.granteeUserId),
			email: `${input.granteeUsername}@example.com`,
			displayName: input.granteeUsername,
			username: input.granteeUsername,
		},
		orgBinding: {
			org: {
				id: ownerIdFromStored(input.ownerOrgId),
				slug: input.ownerSlug,
			},
			role: null,
		},
	})
}

test('Use grant: grantee bound to owner org resolves and execute looks up that org', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = await createDb()
	const ownerId = testStableUserIdFromEmail('alice-use-grant@example.com')
	const granteeId = testStableUserIdFromEmail('carol-use-grant@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'rh-alice',
	})
	await provisionPersonalOrg(db, {
		stableUserId: granteeId,
		username: 'rh-carol',
	})

	const packageId = crypto.randomUUID()
	const packageName = '@rh-alice/rehearsal-notes'
	await insertSavedPackage(db, {
		id: packageId,
		user_id: ownerIdFromStored(ownerId),
		name: packageName,
		kody_id: 'rehearsal-notes',
		description: 'rehearsal notes',
		tags_json: '[]',
		search_text: null,
		source_id: `source-${packageId}`,
		has_app: 0,
		has_skills: 0,
		hidden: 0,
		is_private: 1,
	})

	const granted = await accessGrantCapability.handler(
		{
			resource_type: 'package',
			resource_id: packageId,
			subject_type: 'user',
			subject_id: granteeId,
			preset: 'use',
		},
		{
			env: { APP_DB: db, AUDIT_DB: createAuditTestDb() } as Env,
			callerContext: ownerCaller({
				userId: ownerId,
				username: 'rh-alice',
			}),
		},
	)
	expect(granted.grant.permissions).toEqual(['package:execute', 'package:read'])

	const carolInAlice = granteeInOwnerOrg({
		granteeUserId: granteeId,
		granteeUsername: 'rh-carol',
		ownerOrgId: ownerId,
		ownerSlug: 'rh-alice',
	})
	expect(carolInAlice.request?.org.id).toBe(ownerId)
	expect(carolInAlice.user?.userId).toBe(granteeId)

	const env = { APP_DB: db, AUDIT_DB: createAuditTestDb() } as Env
	const resolved = await runWithRequestPermissions(
		{ env, request: carolInAlice.request! },
		() =>
			resolveSavedPackageImport({
				db,
				userId: carolInAlice.request!.org.id,
				specifier: `kody:${packageName}/ping`,
			}),
	)
	expect(resolved?.row.id).toBe(packageId)

	await expect(
		runWithRequestPermissions({ env, request: carolInAlice.request! }, () =>
			resolveSavedPackageImport({
				db,
				userId: granteeId,
				specifier: `kody:${packageName}/ping`,
			}),
		),
	).resolves.toBeNull()
	expect(new SavedPackageNotFoundError(packageName).message).toContain(
		'communityFork it into this org',
	)

	vi.spyOn(mcpExecutor, 'createExecuteExecutor').mockImplementation(
		() =>
			({
				async execute() {
					return { result: { pong: true }, logs: [] }
				},
			}) as never,
	)
	vi.mocked(moduleGraph.buildKodyModuleBundle).mockClear()
	await runModuleWithRegistry(
		env,
		carolInAlice,
		`import ping from "kody:${packageName}/ping"
export default async function main() { return await ping() }`,
	)
	expect(moduleGraph.buildKodyModuleBundle).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerId }),
	)
	expect(moduleGraph.buildKodyModuleBundle).not.toHaveBeenCalledWith(
		expect.objectContaining({ userId: granteeId }),
	)
})

test('Read grant: grantee can read the source but cannot import or run it', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = await createDb()
	const ownerId = testStableUserIdFromEmail('alice-read-grant@example.com')
	const granteeId = testStableUserIdFromEmail('carol-read-grant@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'rd-alice',
	})
	await provisionPersonalOrg(db, {
		stableUserId: granteeId,
		username: 'rd-carol',
	})
	const packageId = crypto.randomUUID()
	const packageName = '@rd-alice/rehearsal-notes'
	await insertSavedPackage(db, {
		id: packageId,
		user_id: ownerIdFromStored(ownerId),
		name: packageName,
		kody_id: 'rehearsal-notes',
		description: 'rehearsal notes',
		tags_json: '[]',
		search_text: null,
		source_id: `source-${packageId}`,
		has_app: 1,
		has_skills: 0,
		hidden: 0,
		is_private: 1,
	})
	const env = { APP_DB: db, AUDIT_DB: createAuditTestDb() } as Env
	const granted = await accessGrantCapability.handler(
		{
			resource_type: 'package',
			resource_id: packageId,
			subject_type: 'user',
			subject_id: granteeId,
			preset: 'read',
		},
		{
			env,
			callerContext: ownerCaller({ userId: ownerId, username: 'rd-alice' }),
		},
	)
	expect(granted.grant.permissions).toEqual(['package:read'])
	const carolInAlice = granteeInOwnerOrg({
		granteeUserId: granteeId,
		granteeUsername: 'rd-carol',
		ownerOrgId: ownerId,
		ownerSlug: 'rd-alice',
	})
	const {
		loadSavedPackageViewerAccess,
		savedPackageViewerAllows,
		savedPackageViewerMayRunApp,
	} = await import('#worker/app/package-viewer-access.ts')
	const viewerAccess = await loadSavedPackageViewerAccess({
		env,
		viewer: { userId: granteeId, username: 'rd-carol' } as Parameters<
			typeof loadSavedPackageViewerAccess
		>[0]['viewer'],
		ownerId,
	})
	const target = { ownerId, packageId }
	const permissions = {
		read: savedPackageViewerAllows(viewerAccess, 'package:read', target),
		execute: savedPackageViewerAllows(viewerAccess, 'package:execute', target),
		app: savedPackageViewerMayRunApp(viewerAccess, { ownerId }),
	}
	expect(permissions).toEqual({ read: true, execute: false, app: false })
	await expect(
		runWithRequestPermissions({ env, request: carolInAlice.request! }, () =>
			resolveSavedPackageImport({
				db,
				userId: carolInAlice.request!.org.id,
				specifier: `kody:${packageName}/ping`,
			}),
		),
	).rejects.toThrow(/Missing package:execute/)
})
